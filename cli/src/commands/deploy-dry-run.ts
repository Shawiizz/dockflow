/**
 * Dry-run display for deploy command
 * Shows what would be deployed without executing
 */

import { colors, printWarning, printDim, printBlank, printRaw } from '../utils/output';
import type { ResolvedServer } from '../types';

interface DeployDryRunOptions {
  env: string;
  deployVersion: string;
  branchName: string;
  projectRoot: string;
  manager: ResolvedServer;
  workers: ResolvedServer[];
  deployApp: boolean;
  forceAccessories: boolean;
  skipAccessories: boolean;
  skipBuild?: boolean;
  force?: boolean;
  services?: string;
  debug?: boolean;
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
    manager,
    workers,
    deployApp,
    forceAccessories,
    skipAccessories,
    skipBuild,
    force,
    services,
    debug,
  } = options;

  printWarning('═'.repeat(60));
  printRaw(colors.warning(colors.bold('  DRY-RUN MODE - No changes will be made')));
  printWarning('═'.repeat(60));
  printBlank();

  // Deployment Summary
  printRaw(colors.info(colors.bold('Deployment Summary:')));
  printDim('─'.repeat(40));
  printRaw(`  ${colors.bold('Environment:')}     ${env}`);
  printRaw(`  ${colors.bold('Version:')}         ${deployVersion}`);
  printRaw(`  ${colors.bold('Branch:')}          ${branchName}`);
  printRaw(`  ${colors.bold('Project Root:')}    ${projectRoot}`);
  printRaw(`  ${colors.bold('Engine:')}          TypeScript (direct SSH)`);
  printBlank();

  // Target Servers
  printRaw(colors.info(colors.bold('Target Servers:')));
  printDim('─'.repeat(40));
  printRaw(`  ${colors.bold('Manager:')}         ${manager.name} (${manager.host}:${manager.port})`);
  printRaw(`  ${colors.bold('User:')}            ${manager.user}`);
  if (workers.length > 0) {
    printRaw(`  ${colors.bold('Workers:')}`);
    workers.forEach(w => {
      printRaw(`                    - ${w.name} (${w.host}:${w.port})`);
    });
  } else {
    printRaw(`  ${colors.bold('Workers:')}         none (single-node cluster)`);
  }
  printBlank();

  // Deployment Options
  printRaw(colors.info(colors.bold('Deployment Options:')));
  printDim('─'.repeat(40));
  printRaw(`  ${colors.bold('Deploy App:')}      ${deployApp}`);
  printRaw(`  ${colors.bold('Accessories:')}     ${skipAccessories ? 'skipped' : (forceAccessories ? 'forced' : 'auto-detect')}`);
  printRaw(`  ${colors.bold('Skip Build:')}      ${skipBuild || false}`);
  printRaw(`  ${colors.bold('Force Deploy:')}    ${force || false}`);
  if (services) {
    printRaw(`  ${colors.bold('Services:')}        ${services}`);
  }
  printBlank();

  // Environment Variables
  printRaw(colors.info(colors.bold('Environment Variables:')));
  printDim('─'.repeat(40));
  const envVars = Object.entries(manager.env);
  if (envVars.length > 0) {
    envVars.forEach(([key, value]) => {
      // Mask sensitive values
      const displayValue = key.toLowerCase().includes('password') ||
        key.toLowerCase().includes('secret') ||
        key.toLowerCase().includes('key')
        ? '********'
        : value;
      printRaw(`  ${key}=${displayValue}`);
    });
  } else {
    printRaw('  (none)');
  }
  printBlank();

  // Footer
  printWarning('═'.repeat(60));
  printWarning('  To execute this deployment, remove the --dry-run flag');
  printWarning('═'.repeat(60));
}
