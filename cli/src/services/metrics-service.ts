/**
 * Metrics Service
 *
 * Collects and stores deployment metrics on the remote manager.
 * All data is stored in /var/lib/dockflow/metrics/<stack>/
 */

import { sshExec, sshExecChannel } from '../utils/ssh';
import { DOCKFLOW_METRICS_DIR } from '../constants';
import type { SSHKeyConnection } from '../types';
import { printDebug } from '../utils/output';

/**
 * Deployment metrics entry
 */
export interface DeploymentMetric {
  id: string;
  timestamp: string;
  version: string;
  environment: string;
  branch: string;
  status: 'success' | 'failed' | 'rolled_back';
  duration_ms: number;
  performer: string;
  services?: string[];
  error?: string;
  rollback_from?: string;
  build_skipped: boolean;
  accessories_deployed: boolean;
  node_count: number;
}

/**
 * Aggregated metrics summary
 */
export interface MetricsSummary {
  total_deployments: number;
  successful: number;
  failed: number;
  rolled_back: number;
  success_rate: number;
  avg_duration_ms: number;
  last_deployment?: DeploymentMetric;
  deployments_last_24h: number;
  deployments_last_7d: number;
  deployments_last_30d: number;
  most_deployed_versions: Array<{ version: string; count: number }>;
}

/**
 * Generate a unique ID for a deployment
 */
function generateDeploymentId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Get the metrics file path for a stack
 */
function getMetricsPath(stackName: string): string {
  return `${DOCKFLOW_METRICS_DIR}/${stackName}/deployments.json`;
}

/**
 * Parse JSONL (JSON Lines) output into typed objects.
 * Skips empty and malformed lines.
 */
export function parseJsonlLines<T = unknown>(raw: string): T[] {
  if (!raw.trim()) return [];

  const results: T[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch (parseErr) {
      printDebug(`Skipping malformed metrics line: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }
  }
  return results;
}

/**
 * Calculate metrics summary from deployment data.
 * Pure function — no SSH.
 */
export function calculateMetricsSummary(metrics: DeploymentMetric[]): MetricsSummary {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const successful = metrics.filter(m => m.status === 'success').length;
  const failed = metrics.filter(m => m.status === 'failed').length;
  const rolledBack = metrics.filter(m => m.status === 'rolled_back').length;

  const successfulMetrics = metrics.filter(m => m.status === 'success');
  const avgDuration = successfulMetrics.length > 0
    ? successfulMetrics.reduce((acc, m) => acc + Number(m.duration_ms), 0) / successfulMetrics.length
    : 0;

  const deploymentsLast24h = metrics.filter(m =>
    now - new Date(m.timestamp).getTime() < day
  ).length;

  const deploymentsLast7d = metrics.filter(m =>
    now - new Date(m.timestamp).getTime() < 7 * day
  ).length;

  const deploymentsLast30d = metrics.filter(m =>
    now - new Date(m.timestamp).getTime() < 30 * day
  ).length;

  const versionCounts = new Map<string, number>();
  for (const m of metrics) {
    versionCounts.set(m.version, (versionCounts.get(m.version) || 0) + 1);
  }
  const mostDeployedVersions = Array.from(versionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([version, count]) => ({ version, count }));

  const sortedMetrics = [...metrics].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return {
    total_deployments: metrics.length,
    successful,
    failed,
    rolled_back: rolledBack,
    success_rate: metrics.length > 0 ? (successful / metrics.length) * 100 : 0,
    avg_duration_ms: Math.round(avgDuration),
    last_deployment: sortedMetrics[0],
    deployments_last_24h: deploymentsLast24h,
    deployments_last_7d: deploymentsLast7d,
    deployments_last_30d: deploymentsLast30d,
    most_deployed_versions: mostDeployedVersions,
  };
}

/**
 * Unified metrics service — read and write deployment metrics via SSH.
 */
export class MetricsService {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Record a deployment metric and return the raw JSON line
   * (useful for history-sync replication to other nodes).
   */
  async writeDeployment(params: {
    stackName: string;
    version: string;
    env: string;
    branch: string;
    status: 'success' | 'failed' | 'rolled_back';
    durationMs: number;
    performer: string;
    services?: string[];
    error?: string;
    rollbackFrom?: string;
    buildSkipped: boolean;
    accessoriesDeployed: boolean;
    nodeCount: number;
  }): Promise<string> {
    const entry: DeploymentMetric = {
      id: generateDeploymentId(),
      timestamp: new Date().toISOString(),
      version: params.version,
      environment: params.env,
      branch: params.branch,
      status: params.status,
      duration_ms: params.durationMs,
      performer: params.performer,
      services: params.services,
      error: params.error,
      rollback_from: params.rollbackFrom,
      build_skipped: params.buildSkipped,
      accessories_deployed: params.accessoriesDeployed,
      node_count: params.nodeCount,
    };

    const metricsDir = `${DOCKFLOW_METRICS_DIR}/${params.stackName}`;
    const metricsPath = getMetricsPath(params.stackName);
    const entryJson = JSON.stringify(entry);

    await sshExec(this.connection, `mkdir -p "${metricsDir}"`);
    const { stream, done } = await sshExecChannel(this.connection, `cat >> "${metricsPath}"`);
    stream.end(entryJson + '\n');
    await done;

    return entryJson;
  }

  /**
   * Fetch deployment metrics from the remote server.
   */
  async fetch(stackName: string, limit?: number): Promise<DeploymentMetric[]> {
    const metricsPath = getMetricsPath(stackName);

    const cmd = limit
      ? `tail -n ${limit} "${metricsPath}" 2>/dev/null || echo ""`
      : `cat "${metricsPath}" 2>/dev/null || echo ""`;

    const result = await sshExec(this.connection, cmd);
    return parseJsonlLines<DeploymentMetric>(result.stdout);
  }

  /**
   * Clear old metrics, keeping only the last N entries.
   * Returns the number of entries removed.
   */
  async prune(stackName: string, keepLast: number = 1000): Promise<number> {
    const metricsPath = getMetricsPath(stackName);

    const countResult = await sshExec(this.connection, `wc -l < "${metricsPath}" 2>/dev/null || echo "0"`);
    const currentCount = parseInt(countResult.stdout.trim(), 10);

    if (currentCount <= keepLast) {
      return 0;
    }

    const toRemove = currentCount - keepLast;

    await sshExec(this.connection,
      `tail -n ${keepLast} "${metricsPath}" > "${metricsPath}.tmp" && mv "${metricsPath}.tmp" "${metricsPath}"`,
    );

    return toRemove;
  }
}
