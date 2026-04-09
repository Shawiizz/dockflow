/**
 * Resources & Locks API Routes
 *
 * POST   /api/resources/prune   - Prune Docker resources (containers, images, volumes, networks)
 * GET    /api/resources/disk    - Get Docker disk usage
 * GET    /api/locks/:env        - Get lock status for an environment
 * POST   /api/locks/:env        - Acquire a deploy lock
 * DELETE /api/locks/:env        - Release a deploy lock
 */

import { jsonResponse, errorResponse } from '../server';
import { sshExec } from '../../utils/ssh';
import { createLockService } from '../../services';
import { loadConfig } from '../../utils/config';
import { getManagerConnection, resolveEnvironment } from './_helpers';
import type {
  PruneRequest,
  PruneResult,
  PruneResponse,
  DiskUsageResponse,
  LockInfo,
  LockActionResponse,
} from '../types';

// ─── Resources handler ──────────────────────────────────────────────────────

/**
 * Handle /api/resources/* routes
 */
export async function handleResourcesRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // POST /api/resources/prune
  if (pathname === '/api/resources/prune' && method === 'POST') {
    return pruneResources(req);
  }

  // GET /api/resources/disk
  if (pathname === '/api/resources/disk' && method === 'GET') {
    return getDiskUsage(url);
  }

  return errorResponse('Endpoint not found', 404);
}

// ─── Locks handler ──────────────────────────────────────────────────────────

/**
 * Handle /api/locks/* routes
 */
export async function handleLocksRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // Match /api/locks/:env
  const lockMatch = pathname.match(/^\/api\/locks\/([^/]+)$/);
  if (!lockMatch) {
    return errorResponse('Endpoint not found', 404);
  }

  const env = decodeURIComponent(lockMatch[1]);

  // GET /api/locks/:env
  if (method === 'GET') {
    return getLockStatus(env);
  }

  // POST /api/locks/:env
  if (method === 'POST') {
    return acquireLock(env, req);
  }

  // DELETE /api/locks/:env
  if (method === 'DELETE') {
    return releaseLock(env);
  }

  return errorResponse('Method not allowed', 405);
}

// ─── Prune implementation ───────────────────────────────────────────────────

/**
 * Prune Docker resources on the remote server
 */
async function pruneResources(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  let body: PruneRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body: expected { targets: string[], all?: boolean }', 400);
  }

  if (!body.targets || !Array.isArray(body.targets) || body.targets.length === 0) {
    return errorResponse('Missing required field: targets (array of: containers, images, volumes, networks)', 400);
  }

  const pruneCommands: Record<string, string> = {
    containers: 'docker container prune -f',
    images: body.all ? 'docker image prune -f -a' : 'docker image prune -f',
    volumes: 'docker volume prune -f',
    networks: 'docker network prune -f',
  };

  const results: PruneResult[] = [];

  for (const target of body.targets) {
    const command = pruneCommands[target];
    if (!command) {
      results.push({ target, success: false, error: `Unknown prune target: ${target}` });
      continue;
    }

    try {
      const result = await sshExec(conn, command);

      if (result.exitCode !== 0) {
        results.push({
          target,
          success: false,
          error: result.stderr.trim() || 'Prune command failed',
        });
        continue;
      }

      // Parse reclaimed space from output (e.g. "Total reclaimed space: 1.234GB")
      const reclaimedMatch = result.stdout.match(/Total reclaimed space:\s*(.+)/i);
      results.push({
        target,
        success: true,
        reclaimed: reclaimedMatch ? reclaimedMatch[1].trim() : '0B',
      });
    } catch (error) {
      results.push({
        target,
        success: false,
        error: error instanceof Error ? error.message : 'SSH execution failed',
      });
    }
  }

  return jsonResponse({ results } satisfies PruneResponse);
}

// ─── Disk usage implementation ──────────────────────────────────────────────

/**
 * Get Docker disk usage via `docker system df`
 */
async function getDiskUsage(url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const result = await sshExec(conn, 'docker system df');

    if (result.exitCode !== 0) {
      return errorResponse(result.stderr.trim() || 'Failed to get disk usage', 500);
    }

    return jsonResponse({ raw: result.stdout.trim() } satisfies DiskUsageResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to get disk usage', 500);
  }
}

// ─── Lock implementations (using LockService) ──────────────────────────────

/**
 * Get the current lock status for an environment
 */
async function getLockStatus(env: string): Promise<Response> {
  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const staleThreshold = loadConfig({ silent: true })?.lock?.stale_threshold_minutes;
    const lockService = createLockService(conn, conn.stackName, staleThreshold);
    const result = await lockService.status();

    if (!result.success) {
      return errorResponse(result.error.message, 500);
    }

    const { locked, data, durationMinutes, isStale } = result.data;

    if (!locked) {
      return jsonResponse({ locked: false } satisfies LockInfo);
    }

    return jsonResponse({
      locked: true,
      performer: data?.performer,
      startedAt: data?.started_at,
      version: data?.version,
      message: data?.message,
      stack: data?.stack,
      isStale,
      durationMinutes,
    } satisfies LockInfo);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to read lock status', 500);
  }
}

/**
 * Acquire a deploy lock
 */
async function acquireLock(env: string, req: Request): Promise<Response> {
  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  let body: { message?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body is optional
  }

  try {
    const staleThreshold = loadConfig({ silent: true })?.lock?.stale_threshold_minutes;
    const lockService = createLockService(conn, conn.stackName, staleThreshold);
    const result = await lockService.acquire({ message: body.message || 'Locked via WebUI' });

    if (!result.success) {
      return jsonResponse(
        { success: false, message: result.error.message } satisfies LockActionResponse,
        409,
      );
    }

    return jsonResponse({
      success: true,
      message: `Lock acquired for ${conn.stackName}`,
    } satisfies LockActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to acquire lock', 500);
  }
}

/**
 * Release a deploy lock
 */
async function releaseLock(env: string): Promise<Response> {
  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const staleThreshold = loadConfig({ silent: true })?.lock?.stale_threshold_minutes;
    const lockService = createLockService(conn, conn.stackName, staleThreshold);
    const result = await lockService.release();

    return jsonResponse({
      success: result.success,
      message: result.success
        ? `Lock released for ${conn.stackName}`
        : result.error.message,
    } satisfies LockActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to release lock', 500);
  }
}
