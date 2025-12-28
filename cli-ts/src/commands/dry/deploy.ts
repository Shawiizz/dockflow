/**
 * Dry-run display for deploy command
 * Shows what would be deployed without executing
 */

import chalk from 'chalk';
import type { ResolvedServer, ResolvedDeployment } from '../../types';

interface DeployDryRunOptions {
  env: string;
  deployVersion: string;
  branchName: string;
  projectRoot: string;
  dockerImage: string;
  manager: ResolvedServer;
  workers: ResolvedServer[];
  deployApp: boolean;
  forceAccessories: boolean;
  skipAccessories: boolean;
  skipBuild?: boolean;
  force?: boolean;
  services?: string;
  debug?: boolean;
  deployScript?: string;
}

/**
 * Display dry-run summary for deploy command
 */
export function displayDeployDryRun(options: DeployDryRunOptions): void {
  const {
    env,
    deployVersion,
    branchName,
    projectRoot,
    dockerImage,
    manager,
    workers,
    deployApp,
    forceAccessories,
    skipAccessories,
    skipBuild,
    force,
    services,
    debug,
    deployScript,
  } = options;

  console.log(chalk.yellow('═'.repeat(60)));
  console.log(chalk.yellow.bold('  DRY-RUN MODE - No changes will be made'));
  console.log(chalk.yellow('═'.repeat(60)));
  console.log('');

  // Deployment Summary
  console.log(chalk.cyan.bold('Deployment Summary:'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  ${chalk.bold('Environment:')}     ${env}`);
  console.log(`  ${chalk.bold('Version:')}         ${deployVersion}`);
  console.log(`  ${chalk.bold('Branch:')}          ${branchName}`);
  console.log(`  ${chalk.bold('Project Root:')}    ${projectRoot}`);
  console.log(`  ${chalk.bold('Docker Image:')}    ${dockerImage}`);
  console.log('');

  // Target Servers
  console.log(chalk.cyan.bold('Target Servers:'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  ${chalk.bold('Manager:')}         ${manager.name} (${manager.host}:${manager.port})`);
  console.log(`  ${chalk.bold('User:')}            ${manager.user}`);
  if (workers.length > 0) {
    console.log(`  ${chalk.bold('Workers:')}`);
    workers.forEach(w => {
      console.log(`                    - ${w.name} (${w.host}:${w.port})`);
    });
  } else {
    console.log(`  ${chalk.bold('Workers:')}         none (single-node cluster)`);
  }
  console.log('');

  // Deployment Options
  console.log(chalk.cyan.bold('Deployment Options:'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  ${chalk.bold('Deploy App:')}      ${deployApp}`);
  console.log(`  ${chalk.bold('Accessories:')}     ${skipAccessories ? 'skipped' : (forceAccessories ? 'forced' : 'auto-detect')}`);
  console.log(`  ${chalk.bold('Skip Build:')}      ${skipBuild || false}`);
  console.log(`  ${chalk.bold('Force Deploy:')}    ${force || false}`);
  if (services) {
    console.log(`  ${chalk.bold('Services:')}        ${services}`);
  }
  console.log('');

  // Environment Variables
  console.log(chalk.cyan.bold('Environment Variables:'));
  console.log(chalk.gray('─'.repeat(40)));
  const envVars = Object.entries(manager.env);
  if (envVars.length > 0) {
    envVars.forEach(([key, value]) => {
      // Mask sensitive values
      const displayValue = key.toLowerCase().includes('password') ||
        key.toLowerCase().includes('secret') ||
        key.toLowerCase().includes('key')
        ? '********'
        : value;
      console.log(`  ${key}=${displayValue}`);
    });
  } else {
    console.log('  (none)');
  }
  console.log('');

  // Deploy Script (debug mode only)
  if (debug && deployScript) {
    console.log(chalk.cyan.bold('Deploy Script (debug):'));
    console.log(chalk.gray('─'.repeat(40)));
    // Show script without sensitive data
    const sanitizedScript = deployScript
      .replace(/export SSH_PRIVATE_KEY='[^']*'/g, "export SSH_PRIVATE_KEY='********'")
      .replace(/"privateKey":"[^"]*"/g, '"privateKey":"********"');
    console.log(chalk.dim(sanitizedScript));
    console.log('');
  }

  // Footer
  console.log(chalk.yellow('═'.repeat(60)));
  console.log(chalk.yellow('  To execute this deployment, remove the --dry-run flag'));
  console.log(chalk.yellow('═'.repeat(60)));
}
