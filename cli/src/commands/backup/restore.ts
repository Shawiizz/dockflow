/**
 * `dockflow backup restore <env> <service>` (design-06 3.20, 4.1): restores a database or a set of
 * volumes from a backup. Writes exactly one replica (R-23, checked before the confirmation) and
 * takes the deploy lock for the duration of the restore (2.8).
 */

import type { Command } from 'commander';
import { assertSingleReplica, createBackup } from '../../services/backup';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { colors, createSpinner, printBlank, printInfo, printIntro, printOutro, printRaw, printWarning } from '../../utils/output';
import { dangerousConfirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, resolveService } from '../shared/day2';
import { withLock } from '../shared/lock';
import { getBackupServiceNames, nounForSource, refForSource, requireBackupConfig } from './utils';

export interface BackupRestoreOptions {
  from?: string;
  forceUnverified?: boolean;
  yes?: boolean;
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

export async function runBackupRestore(env: string, service: string | undefined, options: BackupRestoreOptions): Promise<void> {
  requireServiceArg(service);
  const { backupConfig, source } = requireBackupConfig(service, env, 'dockflow backup restore');

  printIntro(`Restore - ${service} (${env})`);
  printBlank();

  const ctx = await openDay2(env, { server: options.server });
  const ref = refForSource(ctx, source);
  const { service: svc } = await resolveService(ctx, ref, service, { allowHelm: false, noun: nounForSource(source) });
  assertSingleReplica(svc, env);

  const engine = createBackup(ctx.orchestrator, ref);
  const resolved = await engine.resolveBackup(svc.name, options.from);
  if (!resolved.success) throw resolved.error;
  const backup = resolved.data;

  printWarning('You are about to restore from this backup:');
  printRaw(`  ${colors.info('ID:')}       ${backup.id}`);
  printRaw(`  ${colors.info('Date:')}     ${new Date(backup.timestamp).toLocaleString()}`);
  printRaw(`  ${colors.info('Size:')}     ${backup.size}`);
  printRaw(`  ${colors.info('Type:')}     ${backup.dbType}`);
  printBlank();
  printWarning(
    backup.dbType === 'volume' ? 'This will OVERWRITE the contents of the volumes!' : 'This will OVERWRITE current data in the running database!',
  );
  printBlank();

  if (!options.yes) {
    const confirmed = await dangerousConfirmPrompt({ message: `Type '${env}' to confirm restore:`, expectedText: env });
    if (!confirmed) {
      printInfo('Cancelled - text did not match');
      return;
    }
  }

  printBlank();
  // a restore stopped halfway would leave the data half-written, so Ctrl+C lets it finish
  await withLock(ctx.lock(), { message: `Restore ${svc.name}` }, async () => {
    const spinner = createSpinner();
    spinner.start('Restoring backup...');
    const result = await engine.restore(svc.name, backup.id, backupConfig, backup.compression, {
      forceUnverified: Boolean(options.forceUnverified),
    });
    if (!result.success) {
      spinner.fail('Restore failed');
      throw result.error;
    }
    spinner.succeed('Restore completed');
  });

  printBlank();
  printOutro(
    backup.dbType === 'volume' ? `Volumes for ${service} restored from backup ${backup.id}` : `Database ${service} restored from backup ${backup.id}`,
  );
}

export function registerBackupRestoreCommand(program: Command): void {
  program
    .command('restore <env> [service]')
    .description('Restore a service or accessory database from a backup')
    .option('--from <id>', 'Backup ID or date prefix (default: latest)')
    .option('--force-unverified', 'Skip archive verification (unverifiable backups only)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withErrorHandler(withResolvedEnv(runBackupRestore)));
}
