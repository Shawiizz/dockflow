/**
 * Metrics API Routes (design-06 8.2, 3.9)
 *
 * GET /api/metrics/stats  - Real-time container resource usage (CPU, memory, network, block I/O)
 * GET /api/metrics/audit  - Deploy audit log for the current stack
 */

import { getStackName } from '../../utils/config';
import { formatBytes } from '../../utils/output';
import { sshExecWithFallback } from '../../utils/ssh-fallback';
import { shellQuote } from '../../utils/ssh';
import { errorResponse, getAllNodeConnections, jsonResponse, parseIntParam, resolveEnvironment, withOrchestrator } from './_helpers';
import type { ContainerStats } from '../../services/orchestrator/interfaces';
import { DOCKFLOW_AUDIT_DIR } from '../../constants';
import type { AuditEntry, AuditResponse, ContainerStatsEntry, ContainerStatsResponse } from '../types';

/**
 * Handle /api/metrics/* routes
 */
export async function handleMetricsRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/metrics/stats
  if (pathname === '/api/metrics/stats' && method === 'GET') {
    return getContainerStats(url);
  }

  // GET /api/metrics/audit
  if (pathname === '/api/metrics/audit' && method === 'GET') {
    return getAuditLog(url);
  }

  return errorResponse('Endpoint not found', 404);
}

// ─── Container stats ────────────────────────────────────────────────────────

function toStatsEntry(stats: ContainerStats): ContainerStatsEntry {
  const cpuPercent = stats.cpuMilli === null ? '-' : `${(stats.cpuMilli / 10).toFixed(2)}%`;
  const memUsage =
    stats.memoryBytes === null
      ? '-'
      : `${formatBytes(stats.memoryBytes)} / ${stats.memoryLimitBytes !== null ? formatBytes(stats.memoryLimitBytes) : '-'}`;
  const memPercent =
    stats.memoryBytes === null || stats.memoryLimitBytes === null || stats.memoryLimitBytes === 0
      ? '-'
      : `${((stats.memoryBytes / stats.memoryLimitBytes) * 100).toFixed(2)}%`;

  return {
    name: stats.instance,
    service: stats.service,
    node: stats.node ?? undefined,
    role: stats.role,
    cpuPercent,
    memUsage,
    memPercent,
    netIO: stats.netIO ?? '-',
    blockIO: stats.blockIO ?? '-',
  };
}

/**
 * Container stats for both roles, one bundle: on k3s the two `containers.stats` calls share the
 * per-namespace metrics read (3.9's memo), so no container appears twice (K63a). A metrics-server
 * unavailable on k3s surfaces as `OrchestratorUnavailableError` -> 503 through `withOrchestrator`.
 */
async function getContainerStats(url: URL): Promise<Response> {
  return withOrchestrator(url, async (ctx) => {
    const [appStats, accessoryStats] = await Promise.all([
      ctx.orchestrator.containers.stats(ctx.appRef),
      ctx.orchestrator.containers.stats(ctx.accessoryRef),
    ]);
    const containers = [...appStats, ...accessoryStats].map(toStatsEntry);
    return jsonResponse({ containers, timestamp: new Date().toISOString() } satisfies ContainerStatsResponse);
  });
}

// ─── Audit log ──────────────────────────────────────────────────────────────

/**
 * `timestamp | action | version | performer | message`, the format the `history` command writes
 * (`app/history.ts`, unchanged by this rewrite; its own parser stays private to that file).
 */
function parseAuditLine(line: string): AuditEntry | null {
  const parts = line.split(' | ').map((part) => part.trim());
  if (parts.length < 4 || !parts[0]) return null;
  return {
    timestamp: parts[0],
    action: parts[1] ?? '',
    version: parts[2] ?? '',
    performer: parts[3] ?? '',
    message: parts[4] || undefined,
  };
}

/**
 * Read the deploy audit log, replicated across nodes. `stackName` is `<project>-<env>`, not the
 * bare project name the pre-rewrite route used (the `getManagerConnection` bug `_helpers.ts` notes).
 */
async function getAuditLog(url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const stackName = getStackName(env);
  if (!stackName) return errorResponse('Project name not found in config — cannot resolve audit path', 500);

  const connections = getAllNodeConnections(env);
  if (connections.length === 0) return errorResponse(`No SSH credentials available for environment "${env}"`, 503);

  const lines = parseIntParam(url.searchParams.get('lines'), 100, 1, 10000);
  const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;

  try {
    const command = `tail -n ${lines} ${shellQuote(auditFile)} 2>/dev/null || echo ""`;
    const result = await sshExecWithFallback(connections, command);
    const output = result.stdout.trim();

    if (!output) return jsonResponse({ entries: [], total: 0 } satisfies AuditResponse);

    const entries: AuditEntry[] = output
      .split('\n')
      .map(parseAuditLine)
      .filter((entry): entry is AuditEntry => entry !== null);

    return jsonResponse({ entries, total: entries.length } satisfies AuditResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to read audit log', 500);
  }
}
