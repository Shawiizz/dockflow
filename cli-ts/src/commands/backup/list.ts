/**
 * Backup List Command
 * List available backups for services and accessories
 */

import type { Command } from 'commander';
import { validateEnv } from '../../utils/validation';
import { printIntro, printInfo, printBlank, printJSON, printRaw, printDim, colors, formatRelativeTime } from '../../utils/output';
import { withErrorHandler, BackupError } from '../../utils/errors';
import { createBackupService, type BackupListEntry } from '../../services/backup-service';
import { requireBackupConfig, resolveBackupStack, listFromAllStacks } from './utils';

export function registerBackupListCommand(program: Command): void {
  program
    .command('list <env> [service]')
    .alias('ls')
    .description('List available backups')
    .option('-j, --json', 'Output in JSON format')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string,
      service: string | undefined,
      options: { json?: boolean; server?: string }
    ) => {
      const { connection } = validateEnv(env, options.server);

      let entries: BackupListEntry[];

      if (service) {
        // Specific service — resolve which stack it belongs to
        const { source } = requireBackupConfig(service);
        const stackName = resolveBackupStack(env, source);
        const backupService = createBackupService(connection, stackName);
        const result = await backupService.list(service);
        if (!result.success) throw new BackupError(result.error.message);
        entries = result.data;
      } else {
        entries = await listFromAllStacks(connection, env);
      }

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
      const header = `${'SERVICE'.padEnd(20)} ${'ID'.padEnd(17)} ${'DATE'.padEnd(20)} ${'SIZE'.padEnd(10)} AGE`;
      printDim(header);
      printDim('─'.repeat(header.length));

      for (const entry of entries) {
        const date = new Date(entry.timestamp).toLocaleString();
        const age = formatRelativeTime(entry.timestamp);
        printRaw(
          `${colors.info(entry.service.padEnd(20))} ${entry.id.padEnd(17)} ${date.padEnd(20)} ${entry.size.padEnd(10)} ${colors.dim(age)}`
        );
      }

      printBlank();
      printInfo(`${entries.length} backup(s) found`);
    }));
}
