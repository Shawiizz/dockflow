/**
 * Backup Restore Command
 * Restore a service or accessory database from a backup
 */

import type { Command } from 'commander';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { dangerousConfirmPrompt } from '../../utils/prompts';
import { printIntro, printOutro, printInfo, printWarning, printBlank, printRaw, colors, createSpinner } from '../../utils/output';
import { BackupError, ErrorCode, ValidationError, withErrorHandler } from '../../utils/errors';
import { createBackup } from '../../services/backup';
import { requireBackupConfig, resolveBackupStack, getBackupServiceNames } from './utils';
import { getAllNodeConnections } from '../../utils/servers';

export function registerBackupRestoreCommand(program: Command): void {
  program
    .command('restore <env> [service]')
    .description('Restore a service or accessory database from a backup')
    .option('--from <id>', 'Backup ID or date prefix (default: latest)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { from?: string; yes?: boolean; server?: string }
    ) => {
      if (!service) {
        const available = getBackupServiceNames();
        const suggestion = available.length > 0
          ? `Available services: ${available.join(', ')}`
          : 'Add backup config in .dockflow/config.yml under backup.services or backup.accessories';
        throw new ValidationError(`Missing required argument: service`, suggestion);
      }

      printIntro(`Restore - ${service} (${env})`);
      printBlank();

      const { connection } = validateEnv(env, options.server);
      const { backupConfig, source } = requireBackupConfig(service);
      const stackName = resolveBackupStack(env, source);
      const backupService = createBackup(connection, stackName, getAllNodeConnections(env));

      // Resolve which backup to restore
      const resolveResult = await backupService.resolveBackup(service, options.from);
      if (!resolveResult.success) {
        throw new BackupError(resolveResult.error.message, { code: ErrorCode.BACKUP_NOT_FOUND });
      }

      const backup = resolveResult.data;

      // Show backup details
      printWarning('You are about to restore from this backup:');
      printRaw(`  ${colors.info('ID:')}       ${backup.id}`);
      printRaw(`  ${colors.info('Date:')}     ${new Date(backup.timestamp).toLocaleString()}`);
      printRaw(`  ${colors.info('Size:')}     ${backup.size}`);
      printRaw(`  ${colors.info('Type:')}     ${backup.dbType}`);
      printBlank();
      printWarning(backup.dbType === 'volume'
        ? 'This will OVERWRITE the contents of the Docker volumes!'
        : 'This will OVERWRITE current data in the running database!');
      printBlank();

      // Confirmation
      if (!options.yes) {
        const confirmed = await dangerousConfirmPrompt({
          message: `Type '${env}' to confirm restore:`,
          expectedText: env,
        });

        if (!confirmed) {
          printInfo('Cancelled - text did not match');
          return;
        }
      }

      printBlank();
      const spinner = createSpinner();
      spinner.start('Restoring backup...');
      const result = await backupService.restore(service, backup.id, backupConfig, backup.compression);

      if (!result.success) {
        spinner.fail('Restore failed');
        throw new BackupError(result.error.message, { code: ErrorCode.RESTORE_FAILED });
      }

      spinner.succeed('Restore completed');
      printBlank();
      printOutro(backup.dbType === 'volume'
        ? `Volumes for ${service} restored from backup ${backup.id}`
        : `Database ${service} restored from backup ${backup.id}`);
    })));
}
