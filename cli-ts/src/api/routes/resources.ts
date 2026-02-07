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

// ─── Lock implementations ───────────────────────────────────────────────────

const LOCK_DIR = '/var/lib/dockflow/locks';
const STALE_THRESHOLD_MINUTES = 30;

/**
 * Get the lock file path for a given stack name
 */
function getLockFilePath(stackName: string): string {
  return `${LOCK_DIR}/${stackName}.lock`;
}

/**
 * Get the current lock status for an environment
 */
async function getLockStatus(env: string): Promise<Response> {
  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  const lockFile = getLockFilePath(conn.stackName);

  try {
    const result = await sshExec(conn, `cat ${lockFile} 2>/dev/null || echo "NO_LOCK"`);
    const output = result.stdout.trim();

    if (output === 'NO_LOCK' || !output) {
      return jsonResponse({
        locked: false,
      } satisfies LockInfo);
    }

    // Parse the JSON lock file
    try {
      const lockData = JSON.parse(output);
      const startedAt = lockData.started_at || lockData.startedAt;
      const startedTime = startedAt ? new Date(startedAt).getTime() : 0;
      const durationMinutes = startedTime ? Math.round((Date.now() - startedTime) / 60000) : 0;
      const isStale = durationMinutes > STALE_THRESHOLD_MINUTES;

      return jsonResponse({
        locked: true,
        performer: lockData.performer,
        startedAt,
        version: lockData.version,
        message: lockData.message,
        stack: lockData.stack,
        isStale,
        durationMinutes,
      } satisfies LockInfo);
    } catch {
      // Lock file exists but is not valid JSON
      return jsonResponse({
        locked: true,
        message: 'Lock file exists but could not be parsed',
        isStale: true,
      } satisfies LockInfo);
    }
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

  const lockFile = getLockFilePath(conn.stackName);
  const hostname = require('os').hostname();

  const lockContent = {
    performer: `webui@${hostname}`,
    started_at: new Date().toISOString(),
    timestamp: Math.floor(Date.now() / 1000),
    version: 'manual',
    stack: conn.stackName,
    message: body.message || 'Locked via WebUI',
  };

  const lockJson = JSON.stringify(lockContent);

  try {
    // First check if already locked
    const checkResult = await sshExec(conn, `cat ${lockFile} 2>/dev/null || echo "NO_LOCK"`);
    const checkOutput = checkResult.stdout.trim();

    if (checkOutput !== 'NO_LOCK' && checkOutput) {
      try {
        const existingLock = JSON.parse(checkOutput);
        const startedAt = existingLock.started_at || existingLock.startedAt;
        const startedTime = startedAt ? new Date(startedAt).getTime() : 0;
        const durationMinutes = startedTime ? Math.round((Date.now() - startedTime) / 60000) : 0;

        // Only block if the existing lock is not stale
        if (durationMinutes <= STALE_THRESHOLD_MINUTES) {
          return jsonResponse(
            {
              success: false,
              message: `Already locked by ${existingLock.performer} (${durationMinutes} min ago)`,
            } satisfies LockActionResponse,
            409,
          );
        }
      } catch {
        // Corrupt lock file, allow overwrite
      }
    }

    // Write the lock file
    const writeCmd = `mkdir -p ${LOCK_DIR} && cat > ${lockFile} << 'DOCKFLOW_EOF'\n${lockJson}\nDOCKFLOW_EOF`;
    const writeResult = await sshExec(conn, writeCmd);

    if (writeResult.exitCode !== 0) {
      return jsonResponse(
        {
          success: false,
          message: writeResult.stderr.trim() || 'Failed to create lock file',
        } satisfies LockActionResponse,
        500,
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

  const lockFile = getLockFilePath(conn.stackName);

  try {
    // Remove the lock file
    await sshExec(conn, `rm -f ${lockFile}`);

    // Verify removal
    const verifyResult = await sshExec(conn, `test -f ${lockFile} && echo "EXISTS" || echo "REMOVED"`);
    const removed = verifyResult.stdout.trim() === 'REMOVED';

    return jsonResponse({
      success: removed,
      message: removed
        ? `Lock released for ${conn.stackName}`
        : 'Lock file could not be removed',
    } satisfies LockActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to release lock', 500);
  }
}
