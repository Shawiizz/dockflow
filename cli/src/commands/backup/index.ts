/**
 * Backup command group
 * Backup and restore accessory databases
 */

import type { Command } from 'commander';
import { registerBackupCreateCommand } from './create';
import { registerBackupListCommand } from './list';
import { registerBackupRestoreCommand } from './restore';
import { registerBackupPruneCommand } from './prune';

export function registerBackupCommands(program: Command): void {
  const backup = program
    .command('backup')
    .alias('bak')
    .description('Backup and restore accessory databases');

  registerBackupCreateCommand(backup);
  registerBackupListCommand(backup);
  registerBackupRestoreCommand(backup);
  registerBackupPruneCommand(backup);
}
