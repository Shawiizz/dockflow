/**
 * Backup List Command
 * List available backups for services and accessories
 */

import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { printIntro, printInfo, printBlank, printJSON, printRaw, printDim, colors, formatRelativeTime } from '../../utils/output';
import { withErrorHandler } from '../../utils/errors';
import { createBackup, type BackupListEntry } from '../../services/backup';
import { requireBackupConfig, resolveBackupStack, listFromAllStacks, getBackupNodes, warnUnreachableNodes } from './utils';

export function registerBackupListCommand(program: Command): void {
  program
    .command('list <env> [service]')
    .alias('ls')
    .description('List available backups')
    .option('-j, --json', 'Output in JSON format')
    .option('--node <name>', 'Only the backups stored on this server')
    .option('-s, --server <name>', 'Target manager (defaults to the first manager)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { json?: boolean; server?: string; node?: string }
    ) => {
      const { connection } = await resolveEnv(env, options.server);

      let entries: BackupListEntry[];
      let unreachable;

      if (service) {
        // Specific service — resolve which stack it belongs to
        const { source } = requireBackupConfig(service);
        const stackName = resolveBackupStack(env, source);
        const backupService = createBackup(connection, stackName, getBackupNodes(env));
        const result = await backupService.list(service, { node: options.node });
        if (!result.success) throw result.error;
        ({ entries, unreachable } = result.data);
      } else {
        ({ entries, unreachable } = await listFromAllStacks(connection, env, options.node));
      }

      warnUnreachableNodes(unreachable, 'backups stored there are not listed');

      if (options.json) {
        printJSON(entries);
        return;
      }

      printIntro(`Backups - ${service || 'all'} (${env})`);
      printBlank();

      if (entries.length === 0) {
        printInfo('No backups found');
        return;
      }

      // Table header
      const header = `${'SERVICE'.padEnd(20)} ${'ID'.padEnd(17)} ${'DATE'.padEnd(20)} ${'SIZE'.padEnd(10)} ${'NODE'.padEnd(12)} AGE`;
      printDim(header);
      printDim('─'.repeat(header.length));

      for (const entry of entries) {
        const date = new Date(entry.timestamp).toLocaleString();
        const age = formatRelativeTime(entry.timestamp);
        printRaw(
          `${colors.info(entry.service.padEnd(20))} ${entry.id.padEnd(17)} ${date.padEnd(20)} ${entry.size.padEnd(10)} ${entry.node.padEnd(12)} ${colors.dim(age)}`
        );
      }

      printBlank();
      printInfo(`${entries.length} backup(s) found`);
    })));
}
