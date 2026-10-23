/** Deploy locks: they prevent concurrent deployments to the same environment. */

import type { Command } from 'commander';
import { registerLockAcquireCommand } from './acquire';
import { registerLockReleaseCommand } from './release';
import { registerLockStatusCommand } from './status';

export function registerLockCommands(program: Command): void {
  const lock = program
    .command('lock')
    .description('Manage deployment locks')
    .helpGroup('Resources');

  registerLockAcquireCommand(lock);
  registerLockReleaseCommand(lock);
  registerLockStatusCommand(lock);
}
