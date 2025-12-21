/**
 * List commands - List project resources
 */

import type { Command } from 'commander';
import { registerListEnvCommand } from './env';

/**
 * Register all list commands
 */
export function registerListCommands(program: Command): void {
  const listCmd = program
    .command('list')
    .description('List project resources');

  registerListEnvCommand(listCmd);
}
