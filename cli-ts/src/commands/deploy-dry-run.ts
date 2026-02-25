/**
 * Dry-run display for deploy command
 * Shows what would be deployed without executing
 */

import { colors } from '../utils/output';
import type { ResolvedServer, ResolvedDeployment } from '../types';

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

  console.log(colors.warning('═'.repeat(60)));
  console.log(colors.warning(colors.bold('  DRY-RUN MODE - No changes will be made')));
  console.log(colors.warning('═'.repeat(60)));
  console.log('');

  // Deployment Summary
  console.log(colors.info(colors.bold('Deployment Summary:')));
  console.log(colors.dim('─'.repeat(40)));
  console.log(`  ${colors.bold('Environment:')}     ${env}`);
  console.log(`  ${colors.bold('Version:')}         ${deployVersion}`);
  console.log(`  ${colors.bold('Branch:')}          ${branchName}`);
  console.log(`  ${colors.bold('Project Root:')}    ${projectRoot}`);
  console.log(`  ${colors.bold('Docker Image:')}    ${dockerImage}`);
  console.log('');

  // Target Servers
  console.log(colors.info(colors.bold('Target Servers:')));
  console.log(colors.dim('─'.repeat(40)));
  console.log(`  ${colors.bold('Manager:')}         ${manager.name} (${manager.host}:${manager.port})`);
  console.log(`  ${colors.bold('User:')}            ${manager.user}`);
  if (workers.length > 0) {
    console.log(`  ${colors.bold('Workers:')}`);
    workers.forEach(w => {
      console.log(`                    - ${w.name} (${w.host}:${w.port})`);
    });
  } else {
    console.log(`  ${colors.bold('Workers:')}         none (single-node cluster)`);
  }
  console.log('');

  // Deployment Options
  console.log(colors.info(colors.bold('Deployment Options:')));
  console.log(colors.dim('─'.repeat(40)));
  console.log(`  ${colors.bold('Deploy App:')}      ${deployApp}`);
  console.log(`  ${colors.bold('Accessories:')}     ${skipAccessories ? 'skipped' : (forceAccessories ? 'forced' : 'auto-detect')}`);
  console.log(`  ${colors.bold('Skip Build:')}      ${skipBuild || false}`);
  console.log(`  ${colors.bold('Force Deploy:')}    ${force || false}`);
  if (services) {
    console.log(`  ${colors.bold('Services:')}        ${services}`);
  }
  console.log('');

  // Environment Variables
  console.log(colors.info(colors.bold('Environment Variables:')));
  console.log(colors.dim('─'.repeat(40)));
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
    console.log(colors.info(colors.bold('Deploy Script (debug):')));
    console.log(colors.dim('─'.repeat(40)));
    // Show script without sensitive data
    const sanitizedScript = deployScript
      .replace(/export SSH_PRIVATE_KEY='[^']*'/g, "export SSH_PRIVATE_KEY='********'")
      .replace(/"privateKey":"[^"]*"/g, '"privateKey":"********"');
    console.log(colors.dim(sanitizedScript));
    console.log('');
  }

  // Footer
  console.log(colors.warning('═'.repeat(60)));
  console.log(colors.warning('  To execute this deployment, remove the --dry-run flag'));
  console.log(colors.warning('═'.repeat(60)));
}
