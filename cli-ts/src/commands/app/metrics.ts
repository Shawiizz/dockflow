/**
 * Metrics command - Show deployment metrics and statistics
 */

import type { Command } from 'commander';
import { 
  printSection, 
  printSuccess, 
  printWarning, 
  printDebug,
  printSectionTitle,
  printSeparator,
  printTableRow,
  printDim,
  colors 
} from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { withErrorHandler, DockerError } from '../../utils/errors';
import { 
  fetchDeploymentMetrics, 
  calculateMetricsSummary, 
  pruneMetrics,
  type DeploymentMetric,
  type MetricsSummary 
} from '../../services/metrics-service';

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format relative time
 */
function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Display metrics summary
 */
function displaySummary(summary: MetricsSummary, stackName: string): void {
  console.log('');
  printSection(`Deployment Metrics: ${stackName}`);
  console.log('');
  
  // Overview stats
  printSectionTitle('Overview:');
  printSeparator();
  printTableRow('Total Deployments:', String(summary.total_deployments));
  printTableRow('Success Rate:', colors.success(summary.success_rate.toFixed(1) + '%'));
  printTableRow('Avg Duration:', formatDuration(summary.avg_duration_ms));
  console.log('');
  
  // Status breakdown
  printSectionTitle('Status Breakdown:');
  printSeparator();
  console.log(`  ${colors.success('✓ Successful:')}         ${summary.successful}`);
  console.log(`  ${colors.error('✗ Failed:')}             ${summary.failed}`);
  console.log(`  ${colors.warning('↩ Rolled Back:')}        ${summary.rolled_back}`);
  console.log('');
  
  // Activity
  printSectionTitle('Deployment Activity:');
  printSeparator();
  printTableRow('Last 24 hours:', String(summary.deployments_last_24h));
  printTableRow('Last 7 days:', String(summary.deployments_last_7d));
  printTableRow('Last 30 days:', String(summary.deployments_last_30d));
  console.log('');
  
  // Most deployed versions
  if (summary.most_deployed_versions.length > 0) {
    printSectionTitle('Top Versions:');
    printSeparator();
    summary.most_deployed_versions.forEach(({ version, count }, idx) => {
      console.log(`  ${idx + 1}. ${version} (${count} deployments)`);
    });
    console.log('');
  }
  
  // Last deployment
  if (summary.last_deployment) {
    const last = summary.last_deployment;
    printSectionTitle('Last Deployment:');
    printSeparator();
    printTableRow('Version:', last.version);
    printTableRow('Status:', getStatusBadge(last.status));
    printTableRow('Duration:', formatDuration(last.duration_ms));
    printTableRow('When:', formatRelativeTime(last.timestamp));
    printTableRow('Performer:', last.performer);
  }
}

/**
 * Get colored status badge
 */
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

/**
 * Display deployment history
 */
function displayHistory(metrics: DeploymentMetric[]): void {
  if (metrics.length === 0) {
    printDim('No deployment history found');
    return;
  }
  
  console.log('');
  console.log(
    colors.dim('TIMESTAMP'.padEnd(22)) +
    colors.dim('VERSION'.padEnd(18)) +
    colors.dim('STATUS'.padEnd(14)) +
    colors.dim('DURATION'.padEnd(12)) +
    colors.dim('PERFORMER')
  );
  printSeparator(80);
  
  // Sort by timestamp descending (most recent first)
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
    
    console.log(
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
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--history', 'Show deployment history')
    .option('-n, --lines <number>', 'Number of history entries to show', '20')
    .option('--json', 'Output as JSON')
    .option('--prune', 'Remove old metrics (keep last 1000)')
    .action(withErrorHandler(async (env: string, options: { 
      server?: string; 
      history?: boolean;
      lines?: string;
      json?: boolean;
      prune?: boolean;
    }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, prune: options.prune, history: options.history });
      
      // Prune mode
      if (options.prune) {
        const removed = await pruneMetrics(connection, stackName, 1000);
        if (removed > 0) {
          printSuccess(`Removed ${removed} old metric entries`);
        } else {
          printDim('No metrics to prune');
        }
        return;
      }
      
      const limit = options.history ? parseInt(options.lines || '20', 10) : 1000;
      const metricsData = await fetchDeploymentMetrics(connection, stackName, limit);
      
      if (metricsData.length === 0) {
        console.log('');
        printWarning(`No metrics found for ${stackName}`);
        printDim('Metrics are recorded after each deployment.');
        return;
      }
      
      // JSON output
      if (options.json) {
        if (options.history) {
          console.log(JSON.stringify(metricsData, null, 2));
        } else {
          const summary = calculateMetricsSummary(metricsData);
          console.log(JSON.stringify(summary, null, 2));
        }
        return;
      }
      
      // History mode
      if (options.history) {
        console.log('');
        printSection(`Deployment History: ${stackName}`);
        displayHistory(metricsData);
        console.log('');
        printDim(`Showing last ${metricsData.length} deployments`);
        return;
      }
      
      // Summary mode (default)
      const summary = calculateMetricsSummary(metricsData);
      displaySummary(summary, stackName);
    }));
}
