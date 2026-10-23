/**
 * Management commands for the accessories stack, whose lifecycle is separate from the app's.
 * Deploying goes through `dockflow deploy <env> --accessories`.
 */

import type { Command } from 'commander';
import { registerAccessoriesDeployCommand } from './deploy';
import { registerAccessoriesLogsCommand } from './logs';
import { registerAccessoriesExecCommand } from './exec';
import { registerAccessoriesRestartCommand } from './restart';
import { registerAccessoriesStopCommand } from './stop';
import { registerAccessoriesListCommand } from './list';
import { registerAccessoriesRemoveCommand } from './remove';

export function registerAccessoriesCommands(program: Command): void {
  const accessories = program
    .command('accessories')
    .alias('acc')
    .description('Manage stateful services (databases, caches, etc.)')
    .helpGroup('Resources');

  registerAccessoriesDeployCommand(accessories);
  registerAccessoriesListCommand(accessories);
  registerAccessoriesLogsCommand(accessories);
  registerAccessoriesExecCommand(accessories);
  registerAccessoriesRestartCommand(accessories);
  registerAccessoriesStopCommand(accessories);
  registerAccessoriesRemoveCommand(accessories);
}

