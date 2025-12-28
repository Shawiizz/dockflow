/**
 * Metrics Service
 * 
 * Collects and stores deployment metrics on the remote manager.
 * All data is stored in /var/lib/dockflow/metrics/<stack>/
 */

import { sshExec } from '../utils/ssh';
import { DOCKFLOW_METRICS_DIR } from '../constants';
import type { SSHKeyConnection } from '../types';

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
 * Record a deployment metric on the remote server
 */
export async function recordDeploymentMetric(
  connection: SSHKeyConnection,
  stackName: string,
  metric: Omit<DeploymentMetric, 'id' | 'timestamp'>
): Promise<void> {
  const metricsPath = getMetricsPath(stackName);
  const metricsDir = `${DOCKFLOW_METRICS_DIR}/${stackName}`;
  
  const entry: DeploymentMetric = {
    id: generateDeploymentId(),
    timestamp: new Date().toISOString(),
    ...metric,
  };

  // Create directory and append metric as JSON line (JSONL format for easy appending)
  const entryJson = JSON.stringify(entry);
  const escapedJson = entryJson.replace(/'/g, "'\"'\"'");
  
  await sshExec(connection, `
    mkdir -p "${metricsDir}"
    echo '${escapedJson}' >> "${metricsPath}"
  `);
}

/**
 * Fetch deployment metrics from the remote server
 */
export async function fetchDeploymentMetrics(
  connection: SSHKeyConnection,
  stackName: string,
  limit?: number
): Promise<DeploymentMetric[]> {
  const metricsPath = getMetricsPath(stackName);
  
  const cmd = limit 
    ? `tail -n ${limit} "${metricsPath}" 2>/dev/null || echo ""`
    : `cat "${metricsPath}" 2>/dev/null || echo ""`;
  
  const result = await sshExec(connection, cmd);
  
  if (!result.stdout.trim()) {
    return [];
  }
  
  const metrics: DeploymentMetric[] = [];
  const lines = result.stdout.trim().split('\n');
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      metrics.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  
  return metrics;
}

/**
 * Calculate metrics summary from deployment data
 */
export function calculateMetricsSummary(metrics: DeploymentMetric[]): MetricsSummary {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  
  const successful = metrics.filter(m => m.status === 'success').length;
  const failed = metrics.filter(m => m.status === 'failed').length;
  const rolledBack = metrics.filter(m => m.status === 'rolled_back').length;
  
  const successfulMetrics = metrics.filter(m => m.status === 'success');
  const avgDuration = successfulMetrics.length > 0
    ? successfulMetrics.reduce((acc, m) => acc + m.duration_ms, 0) / successfulMetrics.length
    : 0;
  
  // Count deployments by time period
  const deploymentsLast24h = metrics.filter(m => 
    now - new Date(m.timestamp).getTime() < day
  ).length;
  
  const deploymentsLast7d = metrics.filter(m => 
    now - new Date(m.timestamp).getTime() < 7 * day
  ).length;
  
  const deploymentsLast30d = metrics.filter(m => 
    now - new Date(m.timestamp).getTime() < 30 * day
  ).length;
  
  // Count versions
  const versionCounts = new Map<string, number>();
  for (const m of metrics) {
    versionCounts.set(m.version, (versionCounts.get(m.version) || 0) + 1);
  }
  const mostDeployedVersions = Array.from(versionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([version, count]) => ({ version, count }));
  
  // Sort by timestamp descending to get the last deployment
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
 * Clear old metrics (keep last N entries)
 */
export async function pruneMetrics(
  connection: SSHKeyConnection,
  stackName: string,
  keepLast: number = 1000
): Promise<number> {
  const metricsPath = getMetricsPath(stackName);
  
  // Count current entries
  const countResult = await sshExec(connection, `wc -l < "${metricsPath}" 2>/dev/null || echo "0"`);
  const currentCount = parseInt(countResult.stdout.trim(), 10);
  
  if (currentCount <= keepLast) {
    return 0;
  }
  
  const toRemove = currentCount - keepLast;
  
  // Keep only the last N entries
  await sshExec(connection, `
    tail -n ${keepLast} "${metricsPath}" > "${metricsPath}.tmp"
    mv "${metricsPath}.tmp" "${metricsPath}"
  `);
  
  return toRemove;
}
