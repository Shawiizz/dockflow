/**
 * Backup Restore Command
 * Restore a service or accessory database from a backup
 */

import type { Command } from 'commander';
import ora from 'ora';
import { validateEnv } from '../../utils/validation';
import { dangerousConfirmPrompt } from '../../utils/prompts';
import { printHeader, printSuccess, printInfo, printWarning, printBlank, printRaw, colors } from '../../utils/output';
import { BackupError, ErrorCode, withErrorHandler } from '../../utils/errors';
import { createBackupService } from '../../services/backup-service';
import { requireBackupConfig, resolveBackupStack } from './utils';

export function registerBackupRestoreCommand(program: Command): void {
  program
    .command('restore <env> <service>')
    .description('Restore a service or accessory database from a backup')
    .option('--from <id>', 'Backup ID or date prefix (default: latest)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string,
      service: string,
      options: { from?: string; yes?: boolean; server?: string }
    ) => {
      printHeader(`Restore - ${service} (${env})`);
      printBlank();

      const { connection } = validateEnv(env, options.server);
      const { backupConfig, source } = requireBackupConfig(service);
      const stackName = resolveBackupStack(env, source);
      const backupService = createBackupService(connection, stackName);

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
      const spinner = ora('Restoring backup...').start();
      const result = await backupService.restore(service, backup.id, backupConfig, backup.compression);

      if (!result.success) {
        spinner.fail('Restore failed');
        throw new BackupError(result.error.message, { code: ErrorCode.RESTORE_FAILED });
      }

      spinner.succeed('Restore completed');
      printBlank();
      printSuccess(backup.dbType === 'volume'
        ? `Volumes for ${service} restored from backup ${backup.id}`
        : `Database ${service} restored from backup ${backup.id}`);
    }));
}
