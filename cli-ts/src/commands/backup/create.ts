/**
 * Backup Create Command
 * Create a backup of a service or accessory database
 */

import type { Command } from 'commander';
import ora from 'ora';
import { validateEnv } from '../../utils/validation';
import { printHeader, printSuccess, printInfo, printBlank, printDim } from '../../utils/output';
import { BackupError, withErrorHandler } from '../../utils/errors';
import { createBackupService } from '../../services/backup-service';
import { requireBackupConfig, resolveBackupStack } from './utils';
import { DOCKFLOW_BACKUPS_DIR } from '../../constants';

export function registerBackupCreateCommand(program: Command): void {
  program
    .command('create <env> <service>')
    .description('Create a backup of a service or accessory database')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string,
      service: string,
      options: { server?: string }
    ) => {
      printHeader(`Backup - ${service} (${env})`);
      printBlank();

      const { connection } = validateEnv(env, options.server);
      const { backupConfig, compression, source } = requireBackupConfig(service);
      const stackName = resolveBackupStack(env, source);
      const backupService = createBackupService(connection, stackName);

      const spinner = ora('Creating backup...').start();
      const result = await backupService.backup(service, backupConfig, compression);

      if (!result.success) {
        spinner.fail('Backup failed');
        throw new BackupError(result.error.message);
      }

      spinner.succeed('Backup created');
      printBlank();
      printSuccess(`Backup ID: ${result.data.id}`);
      printInfo(`Size: ${result.data.size}`);
      printInfo(`Duration: ${(result.data.durationMs / 1000).toFixed(1)}s`);
      printDim(`Path: ${DOCKFLOW_BACKUPS_DIR}/${stackName}/${service}/${result.data.id}.*`);
    }));
}
