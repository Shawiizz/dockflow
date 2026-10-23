/**
 * Deploy history route, read from the metrics the manager records for the stack.
 */

import { jsonResponse, errorResponse } from '../server';
import { sshExecWithFallback } from '../../utils/ssh-fallback';
import { printDebug } from '../../utils/output';
import { getManagerConnection, getAllNodeConnections, resolveEnvironment, parseIntParam } from './_helpers';
import { parseJsonlLines } from '../../services/metrics';
import type { DeploymentMetric } from '../../services/metrics';
import { DOCKFLOW_METRICS_DIR } from '../../constants';
import type { DeployHistoryEntry, DeployHistoryResponse } from '../types';

export async function handleDeployRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/deploy/history' && method === 'GET') {
    return getDeployHistory(url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * Deploy history from `deployments.json` in the stack's metrics directory on the manager:
 * one JSON metric per line.
 */
async function getDeployHistory(url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  const limit = parseIntParam(url.searchParams.get('limit'), 50, 1, 1000);

  const env = resolveEnvironment(envFilter);
  if (!env) {
    return jsonResponse({ deployments: [], total: 0 } satisfies DeployHistoryResponse);
  }

  const conn = await getManagerConnection(env);
  if (!conn) {
    return errorResponse(`No manager connection available for environment "${env}"`, 503);
  }

  if (!conn.stackName) {
    return errorResponse('Project name not found in config — cannot resolve metrics path', 500);
  }

  const metricsPath = `${DOCKFLOW_METRICS_DIR}/${conn.stackName}/deployments.json`;

  try {
    // read a margin over the limit (malformed lines are skipped when parsing); any node can
    // answer, the history is replicated between them
    const cmd = `tail -n ${limit * 2} "${metricsPath}" 2>/dev/null || echo ""`;
    const nodeConnections = getAllNodeConnections(env);
    const connections = nodeConnections.length > 0 ? nodeConnections : [conn];
    const result = await sshExecWithFallback(connections, cmd);

    const metrics = parseJsonlLines<Partial<DeploymentMetric>>(result.stdout);
    if (metrics.length === 0) {
      return jsonResponse({ deployments: [], total: 0 } satisfies DeployHistoryResponse);
    }

    const entries: DeployHistoryEntry[] = metrics.map((metric) => ({
      id: metric.id || `${Date.now()}`,
      environment: metric.environment || env,
      target: metric.accessories_deployed ? 'all' : 'app',
      version: metric.version || 'unknown',
      status: mapMetricStatus(metric.status),
      startedAt: metric.timestamp || new Date().toISOString(),
      duration: metric.duration_ms ? Math.round(metric.duration_ms / 1000) : undefined,
      error: metric.error || undefined,
      user: metric.performer || undefined,
    }));

    entries.sort((a, b) => {
      const dateA = new Date(a.startedAt || 0).getTime();
      const dateB = new Date(b.startedAt || 0).getTime();
      return dateB - dateA;
    });

    const limited = entries.slice(0, limit);

    return jsonResponse({
      deployments: limited,
      total: limited.length,
    } satisfies DeployHistoryResponse);
  } catch (error) {
    printDebug('[deploy/history] Failed to fetch deploy history', { error: error instanceof Error ? error.message : String(error) });
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch deploy history',
      500,
    );
  }
}

/** Metric status as the deploy UI shows it: a rollback counts as failed, an unknown status as pending. */
export function mapMetricStatus(status: string | undefined): 'success' | 'failed' | 'pending' | 'running' {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'rolled_back':
      return 'failed';
    default:
      return 'pending';
  }
}
