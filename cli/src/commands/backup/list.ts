/**
 * `dockflow backup list <env> [service]` (design-06 3.20): backups on every node with SSH
 * credentials, or the one `--node` names. Files only: no control-plane probe.
 */

import type { Command } from 'commander';
import { createBackup, type BackupListEntry } from '../../services/backup';
import type { ClusterNodeRef } from '../../services/orchestrator/interfaces';
import { withErrorHandler } from '../../utils/errors';
import { colors, formatRelativeTime, printBlank, printDim, printInfo, printIntro, printJSON, printRaw, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, type Day2Context } from '../shared/day2';
import { configuredSources, refForSource, requireBackupSource } from './utils';

export interface BackupListOptions {
  json?: boolean;
  node?: string;
  server?: string;
}

async function collect(
  ctx: Day2Context,
  service: string | undefined,
  node: string | undefined,
): Promise<{ entries: BackupListEntry[]; unreachable: ClusterNodeRef[] }> {
  const sources = service ? [requireBackupSource(service).source] : configuredSources();
  const entries: BackupListEntry[] = [];
  const unreachable = new Map<string, ClusterNodeRef>();
  for (const source of sources) {
    const result = await createBackup(ctx.orchestrator, refForSource(ctx, source)).list(service, { node });
    if (!result.success) throw result.error;
    entries.push(...result.data.entries);
    for (const candidate of result.data.unreachable) unreachable.set(`${candidate.connection.host}:${candidate.connection.port}`, candidate);
  }
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return { entries, unreachable: [...unreachable.values()] };
}

export async function runBackupList(env: string, service: string | undefined, options: BackupListOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server, failover: false });
  const { entries, unreachable } = await collect(ctx, service, options.node);

  if (options.json) {
    printJSON({ entries, unreachable: unreachable.map((node) => node.name) });
    return;
  }

  if (unreachable.length > 0) {
    printWarning(`${unreachable.length} node(s) did not answer (${unreachable.map((node) => node.name).join(', ')}); backups stored there are not listed`);
  }

  printIntro(`Backups - ${service || 'all'} (${env})`);
  printBlank();

  if (entries.length === 0) {
    printInfo('No backups found');
    return;
  }

  const header = `${'SERVICE'.padEnd(20)} ${'ID'.padEnd(17)} ${'DATE'.padEnd(20)} ${'SIZE'.padEnd(10)} ${'NODE'.padEnd(12)} AGE`;
  printDim(header);
  printDim('-'.repeat(header.length));

  for (const entry of entries) {
    const date = new Date(entry.timestamp).toLocaleString();
    const age = formatRelativeTime(entry.timestamp);
    printRaw(
      `${colors.info(entry.service.padEnd(20))} ${entry.id.padEnd(17)} ${date.padEnd(20)} ${entry.size.padEnd(10)} ${entry.node.padEnd(12)} ${colors.dim(age)}`,
    );
  }

  printBlank();
  printInfo(`${entries.length} backup(s) found`);
}

export function registerBackupListCommand(program: Command): void {
  program
    .command('list <env> [service]')
    .alias('ls')
    .description('List available backups')
    .option('-j, --json', 'Output in JSON format')
    .option('--node <name>', 'Limit to backup files on this server (manager or worker)')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withErrorHandler(withResolvedEnv(runBackupList)));
}
