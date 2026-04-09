/**
 * Lock commands - Manage deployment locks
 * Prevents concurrent deployments to the same environment
 */

import type { Command } from 'commander';
import { registerLockAcquireCommand } from './acquire';
import { registerLockReleaseCommand } from './release';
import { registerLockStatusCommand } from './status';

/**
 * Register all lock commands under 'dockflow lock <cmd>'
 */
export function registerLockCommands(program: Command): void {
  const lock = program
    .command('lock')
    .description('Manage deployment locks');

  registerLockAcquireCommand(lock);
  registerLockReleaseCommand(lock);
  registerLockStatusCommand(lock);
}
