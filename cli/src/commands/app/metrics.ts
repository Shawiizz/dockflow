import type { Command } from 'commander';
import {
  printSection,
  printSuccess,
  printWarning,
  printDebug,
  printSeparator,
  printTableRow,
  printDim,
  printBlank,
  printJSON,
  printRaw,
  colors,
  formatRelativeTime
} from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { withErrorHandler } from '../../utils/errors';
import { nodesOf, onEveryNode, readFromFirstNode } from './nodes';
import {
  Metrics,
  calculateMetricsSummary,
  type DeploymentMetric,
  type MetricsSummary
} from '../../services/metrics';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function displaySummary(summary: MetricsSummary, stackName: string): void {
  printBlank();
  printSection(`Deployment Metrics: ${stackName}`);
  printBlank();

  printSection('Overview:');
  printSeparator();
  printTableRow('Total Deployments:', String(summary.total_deployments));
  printTableRow('Success Rate:', colors.success(summary.success_rate.toFixed(1) + '%'));
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

function displayHistory(metrics: DeploymentMetric[]): void {
  if (metrics.length === 0) {
    printDim('No deployment history found');
    return;
  }

  printBlank();
  printRaw(
    colors.dim('TIMESTAMP'.padEnd(22)) +
    colors.dim('VERSION'.padEnd(18)) +
    colors.dim('STATUS'.padEnd(14)) +
    colors.dim('DURATION'.padEnd(12)) +
    colors.dim('PERFORMER')
  );
  printSeparator(80);

  const sorted = [...metrics].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  for (const m of sorted) {
    const time = new Date(m.timestamp).toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    printRaw(
      colors.dim(time.padEnd(22)) +
      colors.info(m.version.padEnd(18)) +
      getStatusBadge(m.status).padEnd(24) +
      formatDuration(m.duration_ms).padEnd(12) +
      m.performer
    );
  }
}

export function registerMetricsCommand(program: Command): void {
  const metrics = program
    .command('metrics <env>')
    .description('Show deployment metrics and statistics')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('--history', 'Show deployment history')
    .option('-n, --lines <number>', 'Number of history entries to show', '20')
    .option('-j, --json', 'Output as JSON')
    .option('--prune', 'Remove old metrics (keep last 1000)')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: {
      server?: string;
      history?: boolean;
      lines?: string;
      json?: boolean;
      prune?: boolean;
    }) => {
      const { stackName, connection, serverName } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName, prune: options.prune, history: options.history });

      // every node keeps a copy of the metrics: read the first that has them, prune them all
      const nodes = options.server ? [{ name: serverName, connection }] : nodesOf(env, { name: serverName, connection });

      if (options.prune) {
        const pruned = await onEveryNode(nodes, (node) => new Metrics(node.connection).prune(stackName, 1000));
        for (const { node, value: removed } of pruned) {
          if (removed > 0) printSuccess(`${node.name}: removed ${removed} old metric entries`);
          else printDim(`${node.name}: no metrics to prune`);
        }
        return;
      }

      const limit = options.history ? parseInt(options.lines || '20', 10) : 1000;
      const found = await readFromFirstNode(nodes, (node) => new Metrics(node.connection).fetch(stackName, limit), (data) => data.length === 0);
      const metricsData = found?.value ?? [];

      if (metricsData.length === 0) {
        printBlank();
        printWarning(`No metrics found for ${stackName}`);
        printDim('Metrics are recorded after each deployment.');
        return;
      }

      if (options.json) {
        if (options.history) {
          printJSON(metricsData);
        } else {
          const summary = calculateMetricsSummary(metricsData);
          printJSON(summary);
        }
        return;
      }

      if (options.history) {
        printBlank();
        printSection(`Deployment History: ${stackName}`);
        displayHistory(metricsData);
        printBlank();
        printDim(`Showing last ${metricsData.length} deployments`);
        return;
      }

      const summary = calculateMetricsSummary(metricsData);
      displaySummary(summary, stackName);
    })));
}
