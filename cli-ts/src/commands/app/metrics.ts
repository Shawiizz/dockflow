/**
 * Metrics command - Show deployment metrics and statistics
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { printSection, printSuccess, printWarning, printDebug } from '../../utils/output';
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
  console.log(chalk.cyan.bold('Overview:'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.bold('Total Deployments:')}    ${summary.total_deployments}`);
  console.log(`  ${chalk.bold('Success Rate:')}         ${chalk.green(summary.success_rate.toFixed(1) + '%')}`);
  console.log(`  ${chalk.bold('Avg Duration:')}         ${formatDuration(summary.avg_duration_ms)}`);
  console.log('');
  
  // Status breakdown
  console.log(chalk.cyan.bold('Status Breakdown:'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.green('✓ Successful:')}         ${summary.successful}`);
  console.log(`  ${chalk.red('✗ Failed:')}             ${summary.failed}`);
  console.log(`  ${chalk.yellow('↩ Rolled Back:')}        ${summary.rolled_back}`);
  console.log('');
  
  // Activity
  console.log(chalk.cyan.bold('Deployment Activity:'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.bold('Last 24 hours:')}        ${summary.deployments_last_24h}`);
  console.log(`  ${chalk.bold('Last 7 days:')}          ${summary.deployments_last_7d}`);
  console.log(`  ${chalk.bold('Last 30 days:')}         ${summary.deployments_last_30d}`);
  console.log('');
  
  // Most deployed versions
  if (summary.most_deployed_versions.length > 0) {
    console.log(chalk.cyan.bold('Top Versions:'));
    console.log(chalk.gray('─'.repeat(50)));
    summary.most_deployed_versions.forEach(({ version, count }, idx) => {
      console.log(`  ${idx + 1}. ${version} (${count} deployments)`);
    });
    console.log('');
  }
  
  // Last deployment
  if (summary.last_deployment) {
    const last = summary.last_deployment;
    console.log(chalk.cyan.bold('Last Deployment:'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log(`  ${chalk.bold('Version:')}              ${last.version}`);
    console.log(`  ${chalk.bold('Status:')}               ${getStatusBadge(last.status)}`);
    console.log(`  ${chalk.bold('Duration:')}             ${formatDuration(last.duration_ms)}`);
    console.log(`  ${chalk.bold('When:')}                 ${formatRelativeTime(last.timestamp)}`);
    console.log(`  ${chalk.bold('Performer:')}            ${last.performer}`);
  }
}

/**
 * Get colored status badge
 */
function getStatusBadge(status: string): string {
  switch (status) {
    case 'success':
      return chalk.green('✓ Success');
    case 'failed':
      return chalk.red('✗ Failed');
    case 'rolled_back':
      return chalk.yellow('↩ Rolled Back');
    default:
      return status;
  }
}

/**
 * Display deployment history
 */
function displayHistory(metrics: DeploymentMetric[]): void {
  if (metrics.length === 0) {
    console.log(chalk.gray('No deployment history found'));
    return;
  }
  
  console.log('');
  console.log(
    chalk.gray('TIMESTAMP'.padEnd(22)) +
    chalk.gray('VERSION'.padEnd(18)) +
    chalk.gray('STATUS'.padEnd(14)) +
    chalk.gray('DURATION'.padEnd(12)) +
    chalk.gray('PERFORMER')
  );
  console.log(chalk.gray('─'.repeat(80)));
  
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
      chalk.gray(time.padEnd(22)) +
      chalk.cyan(m.version.padEnd(18)) +
      getStatusBadge(m.status).padEnd(24) +
      chalk.white(formatDuration(m.duration_ms).padEnd(12)) +
      chalk.white(m.performer)
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
          console.log(chalk.gray('No metrics to prune'));
        }
        return;
      }
      
      const limit = options.history ? parseInt(options.lines || '20', 10) : 1000;
      const metricsData = await fetchDeploymentMetrics(connection, stackName, limit);
      
      if (metricsData.length === 0) {
        console.log('');
        printWarning(`No metrics found for ${stackName}`);
        console.log(chalk.gray('Metrics are recorded after each deployment.'));
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
        console.log(chalk.gray(`Showing last ${metricsData.length} deployments`));
        return;
      }
      
      // Summary mode (default)
      const summary = calculateMetricsSummary(metricsData);
      displaySummary(summary, stackName);
    }));
}
