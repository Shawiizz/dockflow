import type { Command } from 'commander';
import { registerListEnvCommand } from './env';
import { registerListServicesCommand } from './services';
import { registerListImagesCommand } from './images';

export function registerListCommands(program: Command): void {
  const listCmd = program
    .command('list')
    .description('List project resources')
    .helpGroup('Inspect');

  registerListEnvCommand(listCmd);
  registerListServicesCommand(listCmd);
  registerListImagesCommand(listCmd);
}
