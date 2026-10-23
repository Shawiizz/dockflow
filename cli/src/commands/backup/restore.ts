/**
 * Backup Restore Command
 * Restore a service or accessory database from a backup
 */

import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { getStackName, loadConfig } from '../../utils/config';
import { createEnvLock } from '../../services/lock';
import { withDeployLock } from '../with-lock';
import { dangerousConfirmPrompt } from '../../utils/prompts';
import { printIntro, printOutro, printInfo, printWarning, printBlank, printRaw, colors, createSpinner } from '../../utils/output';
import { BackupError, CLIError, ErrorCode, ValidationError, withErrorHandler } from '../../utils/errors';
import { createBackup, restoreTypeMismatch } from '../../services/backup';
import { requireBackupConfig, resolveBackupStack, getBackupServiceNames, getBackupNodes, scaleToOneHint } from './utils';

export function registerBackupRestoreCommand(program: Command): void {
  program
    .command('restore <env> [service]')
    .description('Restore a service or accessory database from a backup')
    .option('--from <id>', 'Backup ID or date prefix (default: latest)')
    .option('--force-unverified', 'Restore a dump whose integrity marker is missing, after checking it yourself')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first manager)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { from?: string; yes?: boolean; server?: string; forceUnverified?: boolean }
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

      const { connection } = await resolveEnv(env, options.server);
      const { backupConfig, source } = requireBackupConfig(service);
      const stackName = resolveBackupStack(env, source);
      const backupService = createBackup(connection, stackName, getBackupNodes(env));

      // Resolve which backup to restore
      const resolveResult = await backupService.resolveBackup(service, options.from);
      if (!resolveResult.success) {
        throw resolveResult.error instanceof CLIError
          ? resolveResult.error
          : new BackupError(resolveResult.error.message, { code: ErrorCode.BACKUP_NOT_FOUND });
      }

      const backup = resolveResult.data;
      const mismatch = restoreTypeMismatch(backup, service, backupConfig);
      if (mismatch) throw mismatch;
      const replicated = await backupService.replicaRefusal(service, scaleToOneHint(env, service, source));
      if (replicated) throw replicated;

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
      // a deploy must not replace the service while its data is being restored
      const lock = await createEnvLock(env, getStackName(env) ?? stackName, loadConfig()?.lock?.stale_threshold_minutes);
      const result = await withDeployLock(lock, `Restore ${service}`, () => {
        spinner.start('Restoring backup...');
        return backupService.restore(service, backup, backupConfig, backup.compression, {
          forceUnverified: options.forceUnverified === true,
        });
      });

      if (!result.success) {
        spinner.fail('Restore failed');
        throw result.error instanceof CLIError
          ? result.error
          : new BackupError(result.error.message, { code: ErrorCode.RESTORE_FAILED });
      }

      spinner.succeed('Restore completed');
      printBlank();
      printOutro(backup.dbType === 'volume'
        ? `Volumes for ${service} restored from backup ${backup.id}`
        : `Database ${service} restored from backup ${backup.id}`);
    })));
}
