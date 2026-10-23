/** `dockflow backup prune`: removes old backups, keeping only the last N. */

import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { confirmPrompt } from '../../utils/prompts';
import { loadConfig } from '../../utils/config';
import { printIntro, printOutro, printInfo, printWarning, printBlank, printRaw, colors, createSpinner, formatBytes } from '../../utils/output';
import { BackupError, CLIError, withErrorHandler } from '../../utils/errors';
import { createBackup } from '../../services/backup';
import { parseRetention } from '../../services/backup-strategies';
import { requireBackupConfig, resolveBackupStack, listGroupedFromAllStacks, getBackupNodes, warnUnreachableNodes, type StackGroupedEntries } from './utils';

export function registerBackupPruneCommand(program: Command): void {
  program
    .command('prune <env> [service]')
    .description('Remove old backups (keeps the latest N per service)')
    .option('--keep <n>', 'Number of backups to keep per service (default: config retention_count or 10)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--node <name>', 'Only the backups stored on this server')
    .option('-s, --server <name>', 'Target manager (defaults to the first manager)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { keep?: string; yes?: boolean; server?: string; node?: string }
    ) => {
      printIntro(`Prune Backups (${env})`);
      printBlank();

      const { connection } = await resolveEnv(env, options.server);

      const retentionCount = parseRetention(options.keep, loadConfig()?.backup?.retention_count ?? 10);

      const stackData: StackGroupedEntries[] = [];

      if (service) {
        const { source } = requireBackupConfig(service);
        const stackName = resolveBackupStack(env, source);
        const backupService = createBackup(connection, stackName, getBackupNodes(env));
        const result = await backupService.list(service, { node: options.node });
        if (!result.success) throw result.error;
        warnUnreachableNodes(result.data.unreachable, 'backups stored there are not pruned');
        stackData.push({ backupService, byService: { [service]: result.data.entries } });
      } else {
        const grouped = await listGroupedFromAllStacks(connection, env, options.node);
        warnUnreachableNodes(grouped.unreachable, 'backups stored there are not pruned');
        stackData.push(...grouped.stacks);
      }

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

      if (!options.yes) {
        const confirmed = await confirmPrompt({
          message: 'Proceed with pruning?',
          initialValue: false,
        });

        if (!confirmed) {
          printInfo('Cancelled');
          return;
        }
      }

      const spinner = createSpinner();
      spinner.start('Pruning backups...');
      let removed = 0;
      let bytesFreed = 0;

      // per stack and per service, so entries of different stacks never mix
      for (const { backupService, byService } of stackData) {
        for (const [svc, entries] of Object.entries(byService)) {
          if (entries.length <= retentionCount) continue;
          const result = await backupService.prune(svc, retentionCount, { node: options.node, prefetched: entries });
          if (!result.success) {
            spinner.fail('Prune failed');
            throw result.error instanceof CLIError ? result.error : new BackupError(result.error.message);
          }
          removed += result.data.removed;
          bytesFreed += result.data.bytesFreed;
        }
      }

      spinner.succeed(`Pruned ${removed} backup(s)${bytesFreed > 0 ? ` (${formatBytes(bytesFreed)} freed)` : ''}`);
      printBlank();
      printOutro('Prune completed');
    })));
}
