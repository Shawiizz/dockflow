/**
 * Backup Create Command
 * Create a backup of a service or accessory database
 */

import type { Command } from 'commander';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { printIntro, printOutro, printInfo, printBlank, printDim, createSpinner } from '../../utils/output';
import { BackupError, ValidationError, withErrorHandler } from '../../utils/errors';
import { createBackupService } from '../../services/backup-service';
import { requireBackupConfig, resolveBackupStack, getBackupServiceNames } from './utils';
import { getAllNodeConnections } from '../../utils/servers';
import { DOCKFLOW_BACKUPS_DIR } from '../../constants';

export function registerBackupCreateCommand(program: Command): void {
  program
    .command('create <env> [service]')
    .description('Create a backup of a service or accessory database')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { server?: string }
    ) => {
      if (!service) {
        const available = getBackupServiceNames();
        const suggestion = available.length > 0
          ? `Available services: ${available.join(', ')}`
          : 'Add backup config in .dockflow/config.yml under backup.services or backup.accessories';
        throw new ValidationError(`Missing required argument: service`, suggestion);
      }

      printIntro(`Backup - ${service} (${env})`);
      printBlank();

      const { connection } = validateEnv(env, options.server);
      const { backupConfig, compression, source } = requireBackupConfig(service);
      const stackName = resolveBackupStack(env, source);
      const backupService = createBackupService(connection, stackName, getAllNodeConnections(env));

      const spinner = createSpinner();
      spinner.start('Creating backup...');
      const result = await backupService.backup(service, backupConfig, compression);

      if (!result.success) {
        spinner.fail('Backup failed');
        throw new BackupError(result.error.message);
      }

      spinner.succeed('Backup created');
      printBlank();
      printInfo(`Backup ID: ${result.data.id}`);
      printInfo(`Size: ${result.data.size}`);
      printInfo(`Duration: ${(result.data.durationMs / 1000).toFixed(1)}s`);
      printDim(`Path: ${DOCKFLOW_BACKUPS_DIR}/${stackName}/${service}/${result.data.id}.*`);
      printOutro('Backup complete');
    })));
}
