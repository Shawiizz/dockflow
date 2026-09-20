/**
 * Resources & Locks API Routes (design-06 8.2)
 *
 * POST   /api/resources/prune   - Prune images (and, on Swarm, containers/networks)
 * GET    /api/resources/disk    - Get disk usage on every node
 * GET    /api/locks/:env        - Get lock status for an environment
 * POST   /api/locks/:env        - Acquire a deploy lock
 * DELETE /api/locks/:env        - Release a deploy lock
 */

import { planPrune, type PrunePlan, type PruneTarget } from '../../commands/shared/day2';
import { parseBytes } from '../../services/orchestrator/kubernetes/model/units';
import type { ClusterNodeRef, Orchestrator } from '../../services/orchestrator/interfaces';
import { UnsupportedOperationError } from '../../utils/errors';
import { formatBytes } from '../../utils/output';
import { apiErrorResponse, errorResponse, jsonResponse, withOrchestrator } from './_helpers';
import type { DiskUsageResponse, LockActionResponse, LockInfo, PruneRequest, PruneResponse, PruneResult } from '../types';

const VALID_PRUNE_TARGETS: readonly PruneTarget[] = ['images', 'containers', 'volumes', 'networks'];

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
    return getLockStatus(env, url);
  }

  // POST /api/locks/:env
  if (method === 'POST') {
    return acquireLock(env, url, req);
  }

  // DELETE /api/locks/:env
  if (method === 'DELETE') {
    return releaseLock(env, url);
  }

  return errorResponse('Method not allowed', 405);
}

/** `?env=` is how every other route names the target environment; locks carry it in the path instead. */
function withEnvParam(url: URL, env: string): URL {
  const next = new URL(url);
  next.searchParams.set('env', env);
  return next;
}

// ─── Prune implementation ───────────────────────────────────────────────────

/** the sum of every node's figure, `null` as soon as one node reported none (K63d) */
function sumReclaimed(perNode: readonly { reclaimed: string | null }[]): string | null {
  let total = 0;
  for (const { reclaimed } of perNode) {
    if (reclaimed === null) return null;
    const bytes = parseBytes(reclaimed);
    if (bytes === null) return null;
    total += bytes;
  }
  return formatBytes(total);
}

async function pruneOneTarget(
  target: Exclude<PruneTarget, 'volumes'>,
  orchestrator: Orchestrator,
  nodes: ClusterNodeRef[],
  all: boolean,
): Promise<PruneResult> {
  try {
    if (target === 'images') {
      // k3s reports no size for a dangling-only sweep (containerd keeps none); skip the call entirely.
      if (orchestrator.kind === 'k3s' && !all) return { target, success: true, reclaimed: null };
      const perNode = await orchestrator.images.prune(nodes, { all });
      return { target, success: true, reclaimed: sumReclaimed(perNode) };
    }
    const perNode = await orchestrator.images.pruneRuntime(nodes, target);
    return { target, success: true, reclaimed: sumReclaimed(perNode) };
  } catch (error) {
    return { target, success: false, reclaimed: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Prune resources on every node of the environment. `volumes` is refused unconditionally, on both
 * orchestrators, before any orchestrator work: the WebUI never deletes a volume (U-API-05, R-S4-01)
 * — `dockflow volumes rm` and the CLI's own `prune --volumes` are the only ways to do that.
 */
async function pruneResources(req: Request): Promise<Response> {
  const url = new URL(req.url);

  let body: PruneRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body: expected { targets: string[], all?: boolean }', 400);
  }

  if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.some((target) => !VALID_PRUNE_TARGETS.includes(target))) {
    return errorResponse('Missing required field: targets (array of: containers, images, volumes, networks)', 400);
  }

  if (body.targets.includes('volumes')) {
    return apiErrorResponse(
      new UnsupportedOperationError(
        'POST /api/resources/prune does not prune volumes',
        'Remove named volumes with `dockflow volumes rm <env> <name>`, or run `dockflow prune <env> --volumes` from the CLI on Swarm.',
      ),
    );
  }

  return withOrchestrator(url, async (ctx) => {
    // planPrune throws UnsupportedOperationError for a target the orchestrator refuses (k3s
    // containers/networks); that error is caught by withOrchestrator and answered as 501.
    const plan: PrunePlan = planPrune(
      { images: body.targets.includes('images'), containers: body.targets.includes('containers'), networks: body.targets.includes('networks') },
      ctx.orchestrator.capabilities,
    );

    const nodes = [...ctx.orchestrator.target.managers, ...ctx.orchestrator.target.workers];
    const results = await Promise.all(
      plan.targets
        .filter((target): target is Exclude<PruneTarget, 'volumes'> => target !== 'volumes')
        .map((target) => pruneOneTarget(target, ctx.orchestrator, nodes, body.all ?? false)),
    );
    return jsonResponse({ results } satisfies PruneResponse);
  });
}

// ─── Disk usage implementation ──────────────────────────────────────────────

/**
 * Disk usage on every node, from the same read `list images` uses (K63d): the authoritative figure
 * on k3s, where `docker system df` has no equivalent.
 */
async function getDiskUsage(url: URL): Promise<Response> {
  return withOrchestrator(url, async (ctx) => {
    const nodes = [...ctx.orchestrator.target.managers, ...ctx.orchestrator.target.workers];
    const perNode = await ctx.orchestrator.images.list(nodes, { all: false });
    const raw = perNode.map((entry) => `${entry.node}:\n${entry.diskUsage ?? '-'}`).join('\n\n');
    return jsonResponse({ raw } satisfies DiskUsageResponse);
  });
}

// ─── Lock implementations ───────────────────────────────────────────────────

/**
 * Get the current lock status for an environment
 */
async function getLockStatus(env: string, url: URL): Promise<Response> {
  return withOrchestrator(withEnvParam(url, env), async (ctx) => {
    const lock = ctx.orchestrator.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
    const result = await lock.status();
    if (!result.success) throw result.error;

    if (!result.data.locked) return jsonResponse({ locked: false } satisfies LockInfo);

    const { data, durationMinutes, isStale } = result.data;
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
  });
}

/**
 * Acquire a deploy lock
 */
async function acquireLock(env: string, url: URL, req: Request): Promise<Response> {
  let body: { message?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body is optional
  }

  return withOrchestrator(withEnvParam(url, env), async (ctx) => {
    const lock = ctx.orchestrator.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
    const result = await lock.acquire({ message: body.message || 'Locked via WebUI' });

    if (!result.success) {
      return jsonResponse({ success: false, message: result.error.message } satisfies LockActionResponse, 409);
    }

    return jsonResponse({ success: true, message: `Lock acquired for ${ctx.stackName}` } satisfies LockActionResponse);
  });
}

/**
 * Release a deploy lock
 */
async function releaseLock(env: string, url: URL): Promise<Response> {
  return withOrchestrator(withEnvParam(url, env), async (ctx) => {
    const lock = ctx.orchestrator.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
    const result = await lock.release();

    return jsonResponse({
      success: result.success,
      message: result.success ? `Lock released for ${ctx.stackName}` : result.error.message,
    } satisfies LockActionResponse);
  });
}
