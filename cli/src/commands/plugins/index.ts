import type { Command } from 'commander';
import { registerPluginsListCommand } from './list';

export function registerPluginsCommands(program: Command): void {
  const pluginsCmd = program
    .command('plugins')
    .description('Discover built-in and project plugins')
    .helpGroup('Inspect');

  registerPluginsListCommand(pluginsCmd);
}
