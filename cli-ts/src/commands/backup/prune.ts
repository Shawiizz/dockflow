/**
 * Backup Prune Command
 * Remove old backups keeping only the last N
 */

import type { Command } from 'commander';
import ora from 'ora';
import inquirer from 'inquirer';
import { validateEnv } from '../../utils/validation';
import { loadConfig } from '../../utils/config';
import { printHeader, printSuccess, printInfo, printWarning, printBlank, printRaw, colors } from '../../utils/output';
import { BackupError, withErrorHandler } from '../../utils/errors';
import { createBackupService, type BackupListEntry } from '../../services/backup-service';
import { requireBackupConfig, resolveBackupStack, getAllBackupStacks } from './utils';

export function registerBackupPruneCommand(program: Command): void {
  program
    .command('prune <env> [service]')
    .description('Remove old backups (keeps the latest N per service)')
    .option('--keep <n>', 'Number of backups to keep per service (overrides config)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string,
      service: string | undefined,
      options: { keep?: string; yes?: boolean; server?: string }
    ) => {
      printHeader(`Prune Backups (${env})`);
      printBlank();

      const { connection } = validateEnv(env, options.server);

      const config = loadConfig();
      const retentionCount = options.keep
        ? parseInt(options.keep, 10)
        : config?.backup?.retention_count ?? 10;

      // Collect entries per stack, grouped by service
      const stackData: { backupService: ReturnType<typeof createBackupService>; byService: Record<string, BackupListEntry[]> }[] = [];

      if (service) {
        // Specific service — resolve which stack it belongs to
        const { source } = requireBackupConfig(service);
        const stackName = resolveBackupStack(env, source);
        const backupService = createBackupService(connection, stackName);
        const result = await backupService.list(service);
        if (!result.success) throw new BackupError(result.error.message);
        stackData.push({ backupService, byService: { [service]: result.data } });
      } else {
        // No service specified — list from all configured stacks, grouped per stack
        const stacks = getAllBackupStacks(env);
        for (const { stackName } of stacks) {
          const backupService = createBackupService(connection, stackName);
          const result = await backupService.list();
          if (!result.success) continue;

          const byService: Record<string, BackupListEntry[]> = {};
          for (const entry of result.data) {
            (byService[entry.service] ??= []).push(entry);
          }
          stackData.push({ backupService, byService });
        }
      }

      // Count what needs pruning across all stacks
      let totalToPrune = 0;
      const pruneSummary: { service: string; total: number; toRemove: number }[] = [];

      for (const { byService } of stackData) {
        for (const [svc, entries] of Object.entries(byService)) {
          if (entries.length > retentionCount) {
            const toRemove = entries.length - retentionCount;
            totalToPrune += toRemove;
            pruneSummary.push({ service: svc, total: entries.length, toRemove });
          }
        }
      }

      if (totalToPrune === 0) {
        printInfo(`Nothing to prune (keeping ${retentionCount} per service)`);
        return;
      }

      printWarning(`Will remove ${totalToPrune} backup(s), keeping ${retentionCount} per service:`);
      for (const { service: svc, total, toRemove } of pruneSummary) {
        printRaw(`  ${colors.info(svc)}: ${total} total, removing ${toRemove}`);
      }
      printBlank();

      // Confirmation
      if (!options.yes) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Proceed with pruning?',
            default: false,
          },
        ]);

        if (!confirm) {
          printInfo('Cancelled');
          return;
        }
      }

      const spinner = ora('Pruning backups...').start();
      let totalPruned = 0;

      // Prune per-stack, per-service (avoids cross-stack entry mixing)
      for (const { backupService, byService } of stackData) {
        for (const [svc, entries] of Object.entries(byService)) {
          if (entries.length <= retentionCount) continue;
          const result = await backupService.prune(svc, retentionCount, entries);
          if (result.success) {
            totalPruned += result.data;
          }
        }
      }

      spinner.succeed(`Pruned ${totalPruned} backup(s)`);
      printBlank();
      printSuccess('Prune completed');
    }));
}
