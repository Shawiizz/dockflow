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
import { createLock } from '../../services';
import { loadConfig } from '../../utils/config';
import { type ApiNode, getApiNodes, getManagerConnection, onEveryNode, resolveEnvironment } from './_helpers';
import type { SSHExecResult, SSHKeyConnection } from '../../types';
import type {
  PruneRequest,
  PruneNodeResult,
  NodeDiskUsage,
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

const PRUNE_TARGETS = ['containers', 'images', 'volumes', 'networks'] as const;
type PruneTarget = (typeof PRUNE_TARGETS)[number];

export function unknownPruneTargets(targets: unknown[]): string[] {
  return targets.filter((target) => !PRUNE_TARGETS.includes(target as PruneTarget)).map(String);
}

export function pruneCommand(target: PruneTarget, all: boolean): string {
  switch (target) {
    case 'containers':
      return 'docker container prune -f';
    case 'images':
      return all ? 'docker image prune -f -a' : 'docker image prune -f';
    case 'volumes':
      return 'docker volume prune -f';
    case 'networks':
      return 'docker network prune -f';
  }
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Bytes of a size as docker prints it (decimal units: "1.234GB", "12.3kB"), null when it is not one. */
export function parseDockerSize(text: string): number | null {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([kKMGTP]?B)$/);
  if (!match) return null;
  return Number(match[1]) * 1000 ** SIZE_UNITS.indexOf(match[2].toUpperCase());
}

/** The sum of docker sizes, written the way docker writes them; null when one cannot be read. */
export function sumDockerSizes(sizes: string[]): string | null {
  if (sizes.length === 0) return null;
  let total = 0;
  for (const size of sizes) {
    const bytes = parseDockerSize(size);
    if (bytes === null) return null;
    total += bytes;
  }
  const unit = total > 0 ? Math.min(Math.floor(Math.log10(total) / 3), SIZE_UNITS.length - 1) : 0;
  const unitName = unit === 1 ? 'kB' : SIZE_UNITS[unit];
  return `${Number((total / 1000 ** unit).toPrecision(4))}${unitName}`;
}

export type NodeExec = (connection: SSHKeyConnection, command: string) => Promise<SSHExecResult>;

/**
 * Prune each target on every node, one target at a time. A target succeeds when it did on every
 * node; the failing nodes are named in its error and the space freed is summed over the others.
 */
export async function pruneNodes(
  nodes: ApiNode[],
  targets: PruneTarget[],
  all: boolean,
  exec: NodeExec = sshExec,
): Promise<PruneResult[]> {
  const results: PruneResult[] = [];

  for (const target of targets) {
    const command = pruneCommand(target, all);
    const outcomes = await onEveryNode(nodes, async ({ connection }) => {
      const result = await exec(connection, command);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Prune command failed');
      return result.stdout.match(/Total reclaimed space:\s*(.+)/i)?.[1].trim() ?? '0B';
    });

    const perNode: PruneNodeResult[] = outcomes.map((outcome) =>
      outcome.ok
        ? { node: outcome.node.name, success: true, reclaimed: outcome.value }
        : { node: outcome.node.name, success: false, error: outcome.error },
    );
    const failed = perNode.filter((entry) => !entry.success);
    const reclaimed = sumDockerSizes(perNode.flatMap((entry) => (entry.reclaimed ? [entry.reclaimed] : [])));

    results.push({
      target,
      success: failed.length === 0,
      ...(reclaimed ? { reclaimed } : {}),
      ...(failed.length > 0 ? { error: failed.map((entry) => `${entry.node}: ${entry.error}`).join('; ') } : {}),
      nodes: perNode,
    });
  }

  return results;
}

/**
 * Prune Docker resources on every node of the environment
 */
async function pruneResources(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const nodes = getApiNodes(env);
  if (nodes.length === 0) return errorResponse('No server with credentials found', 404);

  let body: PruneRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body: expected { targets: string[], all?: boolean }', 400);
  }

  if (!body.targets || !Array.isArray(body.targets) || body.targets.length === 0) {
    return errorResponse('Missing required field: targets (array of: containers, images, volumes, networks)', 400);
  }

  const unknown = unknownPruneTargets(body.targets);
  if (unknown.length > 0) {
    return errorResponse(`Unknown prune target: ${unknown.join(', ')} (expected: ${PRUNE_TARGETS.join(', ')})`, 400);
  }

  const results = await pruneNodes(nodes, body.targets, body.all === true);
  return jsonResponse({ results } satisfies PruneResponse);
}

// ─── Disk usage implementation ──────────────────────────────────────────────

/** `docker system df` of each node: the plain text for one node, a block per node for several. */
export function formatDiskUsage(nodes: NodeDiskUsage[]): string {
  if (nodes.length === 1 && nodes[0].raw !== undefined) return nodes[0].raw;
  return nodes
    .map((node) => `${node.node} (${node.role}):\n${node.raw ?? `unreachable: ${node.error ?? 'no answer'}`}`)
    .join('\n\n');
}

/**
 * Get Docker disk usage of every node via `docker system df`
 */
async function getDiskUsage(url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const apiNodes = getApiNodes(env);
  if (apiNodes.length === 0) return errorResponse('No server with credentials found', 404);

  const outcomes = await onEveryNode(apiNodes, async ({ connection }) => {
    const result = await sshExec(connection, 'docker system df');
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Failed to get disk usage');
    return result.stdout.trim();
  });

  if (outcomes.every((outcome) => !outcome.ok)) {
    const first = outcomes[0];
    return errorResponse(first.ok ? 'Failed to get disk usage' : first.error, 500);
  }

  const nodes: NodeDiskUsage[] = outcomes.map((outcome) =>
    outcome.ok
      ? { node: outcome.node.name, role: outcome.node.role, raw: outcome.value }
      : { node: outcome.node.name, role: outcome.node.role, error: outcome.error },
  );
  return jsonResponse({ raw: formatDiskUsage(nodes), nodes } satisfies DiskUsageResponse);
}

// ─── Lock implementations (using Lock service) ─────────────────────────────

/**
 * Get the current lock status for an environment
 */
async function getLockStatus(env: string): Promise<Response> {
  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const staleThreshold = loadConfig({ silent: true })?.lock?.stale_threshold_minutes;
    const lockService = createLock(conn, conn.stackName, staleThreshold);
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
    const lockService = createLock(conn, conn.stackName, staleThreshold);
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
    const lockService = createLock(conn, conn.stackName, staleThreshold);
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
