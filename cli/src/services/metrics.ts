/**
 * Metrics — stores deployment metrics on the remote manager, one JSON line per deploy under
 * the metrics dir of the stack.
 */

import { sh, sshExec } from '../utils/ssh';
import { DOCKFLOW_METRICS_DIR } from '../constants';
import type { SSHKeyConnection } from '../types';
import { printDebug } from '../utils/output';

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

function generateDeploymentId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

function getMetricsPath(stackName: string): string {
  return `${DOCKFLOW_METRICS_DIR}/${stackName}/deployments.json`;
}

/** Parses JSON Lines into objects, skipping empty and malformed lines. */
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

/** Pure: no SSH. The average duration counts successful deployments only. */
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

export class Metrics {
  constructor(private readonly connection: SSHKeyConnection) {}

  /** Appends the metric and returns its JSON line, which history-sync replicates to the other nodes. Throws when the write fails. */
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

    await sshExec(this.connection, sh`mkdir -p ${metricsDir}`);
    const writeResult = await sshExec(this.connection, sh`cat >> ${metricsPath}`, { stdin: `${entryJson}\n` });
    if (writeResult.exitCode !== 0) {
      // Throw so the caller's best-effort net surfaces a warning instead of
      // silently losing the deployment history entry.
      throw new Error(`Failed to write metrics entry: ${writeResult.stderr.trim() || `exit ${writeResult.exitCode}`}`);
    }

    return entryJson;
  }

  async fetch(stackName: string, limit?: number): Promise<DeploymentMetric[]> {
    const metricsPath = getMetricsPath(stackName);

    const cmd = limit
      ? sh`tail -n ${limit} ${metricsPath} 2>/dev/null || echo ""`
      : sh`cat ${metricsPath} 2>/dev/null || echo ""`;

    const result = await sshExec(this.connection, cmd);
    return parseJsonlLines<DeploymentMetric>(result.stdout);
  }

  /** Keeps the last `keepLast` entries and returns how many were removed. */
  async prune(stackName: string, keepLast: number = 1000): Promise<number> {
    const metricsPath = getMetricsPath(stackName);

    const countResult = await sshExec(this.connection, sh`wc -l < ${metricsPath} 2>/dev/null || echo "0"`);
    const currentCount = parseInt(countResult.stdout.trim(), 10);

    if (currentCount <= keepLast) {
      return 0;
    }

    const toRemove = currentCount - keepLast;
    const tmpPath = `${metricsPath}.tmp`;

    await sshExec(this.connection,
      sh`tail -n ${keepLast} ${metricsPath} > ${tmpPath} && mv ${tmpPath} ${metricsPath}`,
    );

    return toRemove;
  }
}
