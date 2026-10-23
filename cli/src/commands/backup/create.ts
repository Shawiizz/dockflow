import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { printIntro, printOutro, printInfo, printBlank, printDim, printJSON, createSpinner } from '../../utils/output';
import { BackupError, CLIError, ValidationError, withErrorHandler } from '../../utils/errors';
import { createBackup } from '../../services/backup';
import { requireBackupConfig, resolveBackupStack, getBackupServiceNames, getBackupNodes } from './utils';
import { DOCKFLOW_BACKUPS_DIR } from '../../constants';

export function registerBackupCreateCommand(program: Command): void {
  program
    .command('create <env> [service]')
    .description('Create a backup of a service or accessory database')
    .option('-j, --json', 'Output backup metadata in JSON format')
    .option('-s, --server <name>', 'Target manager (defaults to the first manager)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { json?: boolean; server?: string }
    ) => {
      if (!service) {
        const available = getBackupServiceNames();
        const suggestion = available.length > 0
          ? `Available services: ${available.join(', ')}`
          : 'Add backup config in .dockflow/config.yml under backup.services or backup.accessories';
        throw new ValidationError(`Missing required argument: service`, suggestion);
      }

      const json = options.json === true;

      if (!json) {
        printIntro(`Backup - ${service} (${env})`);
        printBlank();
      }

      const { connection } = await resolveEnv(env, options.server);
      const { backupConfig, compression, source } = requireBackupConfig(service);
      const stackName = resolveBackupStack(env, source);
      const backupService = createBackup(connection, stackName, getBackupNodes(env));

      const spinner = json ? null : createSpinner();
      spinner?.start('Creating backup...');
      const result = await backupService.backup(service, backupConfig, compression);

      if (!result.success) {
        spinner?.fail('Backup failed');
        throw result.error instanceof CLIError ? result.error : new BackupError(result.error.message);
      }

      if (json) {
        printJSON(result.data);
        return;
      }

      spinner!.succeed('Backup created');
      printBlank();
      printInfo(`Backup ID: ${result.data.id}`);
      printInfo(`Size: ${result.data.size}`);
      printInfo(`Duration: ${(result.data.durationMs / 1000).toFixed(1)}s`);
      printDim(`Path: ${DOCKFLOW_BACKUPS_DIR}/${stackName}/${service}/${result.data.id}.*`);
      printOutro('Backup complete');
    })));
}
