/**
 * Deploy API Routes
 *
 * GET /api/deploy/history - Get deployment history from remote manager
 */

import { jsonResponse, errorResponse } from '../server';
import { sshExec } from '../../utils/ssh';
import { printDebug } from '../../utils/output';
import { getManagerConnection, resolveEnvironment } from './_helpers';
import { DOCKFLOW_METRICS_DIR } from '../../constants';
import type { DeployHistoryEntry, DeployHistoryResponse } from '../types';

/**
 * Handle /api/deploy/* routes
 */
export async function handleDeployRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/deploy/history
  if (pathname === '/api/deploy/history' && method === 'GET') {
    return getDeployHistory(url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * Read deploy history from the remote manager's metrics database.
 *
 * Dockflow records deployment metrics in JSONL format at:
 *   /var/lib/dockflow/metrics/<stackName>/deployments.json
 *
 * Each line is a JSON object with fields like:
 *   id, timestamp, version, environment, status, duration_ms, performer, etc.
 */
async function getDeployHistory(url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);

  const env = resolveEnvironment(envFilter);
  if (!env) {
    return jsonResponse({ deployments: [], total: 0 } satisfies DeployHistoryResponse);
  }

  const conn = getManagerConnection(env);
  if (!conn) {
    return errorResponse(`No manager connection available for environment "${env}"`, 503);
  }

  if (!conn.stackName) {
    return errorResponse('Project name not found in config — cannot resolve metrics path', 500);
  }

  // Stack name on remote is "<project_name>-<environment>" (see ansible/deploy.yml)
  const fullStackName = `${conn.stackName}-${env}`;
  const metricsPath = `${DOCKFLOW_METRICS_DIR}/${fullStackName}/deployments.json`;

  try {
    // Read the last N*2 lines to account for potential filtering
    const cmd = `tail -n ${limit * 2} "${metricsPath}" 2>/dev/null || echo ""`;
    const result = await sshExec(conn, cmd);

    if (!result.stdout.trim()) {
      return jsonResponse({ deployments: [], total: 0 } satisfies DeployHistoryResponse);
    }

    const entries: DeployHistoryEntry[] = [];
    const lines = result.stdout.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const metric = JSON.parse(line);
        entries.push({
          id: metric.id || `${Date.now()}`,
          environment: metric.environment || env,
          target: metric.accessories_deployed ? 'all' : 'app',
          version: metric.version || 'unknown',
          status: mapMetricStatus(metric.status),
          startedAt: metric.timestamp || new Date().toISOString(),
          duration: metric.duration_ms ? Math.round(metric.duration_ms / 1000) : undefined,
          error: metric.error || undefined,
          user: metric.performer || undefined,
        });
      } catch {
        // Skip malformed lines
      }
    }

    // Sort by most recent first
    entries.sort((a, b) => {
      const dateA = new Date(a.startedAt || 0).getTime();
      const dateB = new Date(b.startedAt || 0).getTime();
      return dateB - dateA;
    });

    // Limit results
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

/**
 * Map metric status to deploy UI status
 */
function mapMetricStatus(status: string): 'success' | 'failed' | 'pending' | 'running' {
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
