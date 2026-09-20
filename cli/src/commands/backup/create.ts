/**
 * `dockflow backup create <env> <service>` (design-06 3.20, 4.1): a snapshot of a database dump or
 * a set of volumes, verified end to end on the node holding it before it is considered complete.
 */

import type { Command } from 'commander';
import { createBackup } from '../../services/backup';
import { DOCKFLOW_BACKUPS_DIR } from '../../constants';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { createSpinner, printBlank, printDim, printInfo, printIntro, printJSON, printOutro } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, resolveService } from '../shared/day2';
import { getBackupServiceNames, nounForSource, refForSource, requireBackupConfig } from './utils';

export interface BackupCreateOptions {
  json?: boolean;
  server?: string;
}

function requireServiceArg(service: string | undefined): asserts service is string {
  if (service) return;
  const available = getBackupServiceNames();
  throw new ValidationError(
    'Missing required argument: service',
    available.length > 0
      ? `Available services: ${available.join(', ')}.`
      : 'Add backup config in `.dockflow/config.yml` under `backup.services` or `backup.accessories`.',
  );
}

export async function runBackupCreate(env: string, service: string | undefined, options: BackupCreateOptions): Promise<void> {
  requireServiceArg(service);
  const { backupConfig, compression, source } = requireBackupConfig(service, env, 'dockflow backup create');

  if (!options.json) {
    printIntro(`Backup - ${service} (${env})`);
    printBlank();
  }

  const ctx = await openDay2(env, { server: options.server });
  const ref = refForSource(ctx, source);
  const { service: svc } = await resolveService(ctx, ref, service, { allowHelm: false, noun: nounForSource(source) });

  const spinner = options.json ? null : createSpinner();
  spinner?.start('Creating backup...');
  const result = await createBackup(ctx.orchestrator, ref).backup(svc.name, backupConfig, compression);

  if (!result.success) {
    spinner?.fail('Backup failed');
    throw result.error;
  }

  if (options.json) {
    printJSON(result.data);
    return;
  }

  spinner?.succeed('Backup created');
  printBlank();
  printInfo(`Backup ID: ${result.data.id}`);
  printInfo(`Size: ${result.data.size}`);
  printInfo(`Duration: ${(result.data.durationMs / 1000).toFixed(1)}s`);
  printDim(`Path: ${DOCKFLOW_BACKUPS_DIR}/${result.data.stackName}/${svc.name}/${result.data.id}.*`);
  printOutro('Backup complete');
}

export function registerBackupCreateCommand(program: Command): void {
  program
    .command('create <env> [service]')
    .description('Create a backup of a service or accessory database')
    .option('-j, --json', 'Output backup metadata in JSON format')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withErrorHandler(withResolvedEnv(runBackupCreate)));
}
