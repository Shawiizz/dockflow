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

      // Collect all entries across relevant stacks
      let allEntries: BackupListEntry[] = [];
      const stackServices: { stackName: string; backupService: ReturnType<typeof createBackupService> }[] = [];

      if (service) {
        // Specific service — resolve which stack it belongs to
        const { source } = requireBackupConfig(service);
        const stackName = resolveBackupStack(env, source);
        const backupService = createBackupService(connection, stackName);
        const result = await backupService.list(service);
        if (!result.success) throw new BackupError(result.error.message);
        allEntries = result.data;
        stackServices.push({ stackName, backupService });
      } else {
        // No service specified — list from all configured stacks
        const stacks = getAllBackupStacks(env);
        for (const { stackName } of stacks) {
          const backupService = createBackupService(connection, stackName);
          const result = await backupService.list();
          if (result.success) {
            allEntries.push(...result.data);
            stackServices.push({ stackName, backupService });
          }
        }
      }

      // Group pre-fetched entries by service
      const entriesPerService: Record<string, BackupListEntry[]> = {};
      for (const entry of allEntries) {
        (entriesPerService[entry.service] ??= []).push(entry);
      }

      const servicesToPrune = service
        ? [service]
        : Object.keys(entriesPerService);

      // Count per service
      const countPerService: Record<string, number> = {};
      for (const [svc, entries] of Object.entries(entriesPerService)) {
        countPerService[svc] = entries.length;
      }

      let totalToPrune = 0;
      for (const svc of servicesToPrune) {
        const count = countPerService[svc] || 0;
        if (count > retentionCount) {
          totalToPrune += count - retentionCount;
        }
      }

      if (totalToPrune === 0) {
        printInfo(`Nothing to prune (keeping ${retentionCount} per service)`);
        return;
      }

      printWarning(`Will remove ${totalToPrune} backup(s), keeping ${retentionCount} per service:`);
      for (const svc of servicesToPrune) {
        const count = countPerService[svc] || 0;
        if (count > retentionCount) {
          printRaw(`  ${colors.info(svc)}: ${count} total, removing ${count - retentionCount}`);
        }
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

      // Prune across all backup services
      for (const { backupService } of stackServices) {
        for (const svc of servicesToPrune) {
          const svcEntries = entriesPerService[svc];
          if (!svcEntries || svcEntries.length <= retentionCount) continue;

          const result = await backupService.prune(svc, retentionCount, svcEntries);
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
