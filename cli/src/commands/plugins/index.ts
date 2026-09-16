/**
 * Plugins commands - Discover the plugins a project can use
 */

import type { Command } from 'commander';
import { registerPluginsListCommand } from './list';

/**
 * Register all plugins commands
 */
export function registerPluginsCommands(program: Command): void {
  const pluginsCmd = program
    .command('plugins')
    .description('Discover built-in and project plugins')
    .helpGroup('Inspect');

  registerPluginsListCommand(pluginsCmd);
}
