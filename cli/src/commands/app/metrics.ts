/**
 * `dockflow metrics <env>` (design-06 3.19): deployment metrics and history, read with the same
 * manager-then-worker fallback as `history`/`audit` (R-S4-04, K78) instead of the first manager
 * only, so a single down node never hides history under failover (D20). `--prune` runs on every
 * reachable node.
 */

import type { Command } from 'commander';
import {
  calculateMetricsSummary,
  type DeploymentMetric,
  fetchMetricsWithFallback,
  type MetricsSummary,
  pruneMetricsOnAllNodes,
} from '../../services/metrics';
import { withErrorHandler } from '../../utils/errors';
import {
  colors,
  formatRelativeTime,
  printBlank,
  printDebug,
  printDim,
  printJSON,
  printRaw,
  printSection,
  printSeparator,
  printSuccess,
  printTableRow,
  printWarning,
} from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

const METRICS_PRUNE_KEEP_LAST = 1000;

export interface MetricsCommandOptions {
  server?: string;
  history?: boolean;
  lines?: string;
  json?: boolean;
  prune?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function getStatusBadge(status: string): string {
  switch (status) {
    case 'success':
      return colors.success('✓ Success');
    case 'failed':
      return colors.error('✗ Failed');
    case 'rolled_back':
      return colors.warning('↩ Rolled Back');
    default:
      return status;
  }
}

function displaySummary(summary: MetricsSummary, stackName: string): void {
  printBlank();
  printSection(`Deployment Metrics: ${stackName}`);
  printBlank();

  printSection('Overview:');
  printSeparator();
  printTableRow('Total Deployments:', String(summary.total_deployments));
  printTableRow('Success Rate:', colors.success(`${summary.success_rate.toFixed(1)}%`));
  printTableRow('Avg Duration:', formatDuration(summary.avg_duration_ms));
  printBlank();

  printSection('Status Breakdown:');
  printSeparator();
  printRaw(`  ${colors.success('✓ Successful:')}         ${summary.successful}`);
  printRaw(`  ${colors.error('✗ Failed:')}             ${summary.failed}`);
  printRaw(`  ${colors.warning('↩ Rolled Back:')}        ${summary.rolled_back}`);
  printBlank();

  printSection('Deployment Activity:');
  printSeparator();
  printTableRow('Last 24 hours:', String(summary.deployments_last_24h));
  printTableRow('Last 7 days:', String(summary.deployments_last_7d));
  printTableRow('Last 30 days:', String(summary.deployments_last_30d));
  printBlank();

  if (summary.most_deployed_versions.length > 0) {
    printSection('Top Versions:');
    printSeparator();
    summary.most_deployed_versions.forEach(({ version, count }, idx) => {
      printRaw(`  ${idx + 1}. ${version} (${count} deployments)`);
    });
    printBlank();
  }

  if (summary.last_deployment) {
    const last = summary.last_deployment;
    printSection('Last Deployment:');
    printSeparator();
    printTableRow('Version:', last.version);
    printTableRow('Status:', getStatusBadge(last.status));
    printTableRow('Duration:', formatDuration(last.duration_ms));
    printTableRow('When:', formatRelativeTime(last.timestamp));
    printTableRow('Performer:', last.performer);
  }
}

function displayHistory(metrics: DeploymentMetric[]): void {
  if (metrics.length === 0) {
    printDim('No deployment history found');
    return;
  }

  printBlank();
  printRaw(
    colors.dim('TIMESTAMP'.padEnd(22)) + colors.dim('VERSION'.padEnd(18)) + colors.dim('STATUS'.padEnd(14)) + colors.dim('DURATION'.padEnd(12)) + colors.dim('PERFORMER'),
  );
  printSeparator(80);

  const sorted = [...metrics].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  for (const m of sorted) {
    const time = new Date(m.timestamp).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    printRaw(colors.dim(time.padEnd(22)) + colors.info(m.version.padEnd(18)) + getStatusBadge(m.status).padEnd(24) + formatDuration(m.duration_ms).padEnd(12) + m.performer);
  }
}

export async function runMetrics(env: string, options: MetricsCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  printDebug('Connection validated', { stackName: ctx.stackName, prune: options.prune, history: options.history });

  const nodes = [...ctx.orchestrator.target.managers, ...ctx.orchestrator.target.workers];

  if (options.prune) {
    const outcomes = await pruneMetricsOnAllNodes(nodes, ctx.stackName, METRICS_PRUNE_KEEP_LAST);
    for (const outcome of outcomes) {
      if (outcome.error) printWarning(`Could not prune metrics on ${outcome.node}: ${outcome.error}`);
    }
    const removed = outcomes.reduce((sum, outcome) => sum + outcome.removed, 0);
    if (removed > 0) {
      printSuccess(`Removed ${removed} old metric entries`);
    } else {
      printDim('No metrics to prune');
    }
    return;
  }

  const limit = options.history ? parseInt(options.lines || '20', 10) : METRICS_PRUNE_KEEP_LAST;
  const { metrics: metricsData, node } = await fetchMetricsWithFallback(nodes, ctx.stackName, limit);

  // R-S4-04: name the manager the data came from whenever it is not the first one
  const firstManager = nodes[0];
  if (node && firstManager && node.name !== firstManager.name) {
    printDim(`Read from ${node.name}`);
  }

  if (metricsData.length === 0) {
    printBlank();
    printWarning(`No metrics found for ${ctx.stackName}`);
    printDim('Metrics are recorded after each deployment.');
    return;
  }

  if (options.json) {
    printJSON(options.history ? metricsData : calculateMetricsSummary(metricsData));
    return;
  }

  if (options.history) {
    printBlank();
    printSection(`Deployment History: ${ctx.stackName}`);
    displayHistory(metricsData);
    printBlank();
    printDim(`Showing last ${metricsData.length} deployments`);
    return;
  }

  displaySummary(calculateMetricsSummary(metricsData), ctx.stackName);
}

export function registerMetricsCommand(program: Command): void {
  program
    .command('metrics <env>')
    .description('Show deployment metrics and statistics')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--history', 'Show deployment history')
    .option('-n, --lines <number>', 'Number of history entries to show', '20')
    .option('-j, --json', 'Output as JSON')
    .option('--prune', 'Remove old metrics (keep last 1000)')
    .action(withErrorHandler(withResolvedEnv(runMetrics)));
}
