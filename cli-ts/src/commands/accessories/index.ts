/**
 * Accessories commands - Manage stateful services (databases, caches, etc.)
 * These have a separate lifecycle from the main application
 * 
 * Deployment is handled via: dockflow deploy <env> --accessories
 * These commands are for management operations (logs, exec, restart, etc.)
 */

import type { Command } from 'commander';
import { registerAccessoriesLogsCommand } from './logs';
import { registerAccessoriesExecCommand } from './exec';
import { registerAccessoriesRestartCommand } from './restart';
import { registerAccessoriesStopCommand } from './stop';
import { registerAccessoriesListCommand } from './list';
import { registerAccessoriesRemoveCommand } from './remove';

/**
 * Register all accessories commands under 'dockflow accessories <cmd>'
 */
export function registerAccessoriesCommands(program: Command): void {
  const accessories = program
    .command('accessories')
    .alias('acc')
    .description('Manage stateful services (databases, caches, etc.)\n\nDeploy with: dockflow deploy <env> --accessories');

  registerAccessoriesListCommand(accessories);
  registerAccessoriesLogsCommand(accessories);
  registerAccessoriesExecCommand(accessories);
  registerAccessoriesRestartCommand(accessories);
  registerAccessoriesStopCommand(accessories);
  registerAccessoriesRemoveCommand(accessories);
}

