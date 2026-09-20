/**
 * `dockflow backup prune <env> [service]` (design-06 3.20): keeps the newest `retention_count`
 * backups per service, and removes orphaned data files left by interrupted backups (4.1). Files
 * only: no control-plane probe.
 */

import type { Command } from 'commander';
import { createBackup, type BackupListEntry } from '../../services/backup';
import { loadConfig } from '../../utils/config';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { colors, createSpinner, formatBytes, printBlank, printInfo, printIntro, printOutro, printRaw, printWarning } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';
import { type BackupSource, configuredSources, refForSource, requireBackupSource } from './utils';

export interface BackupPruneOptions {
  keep?: string;
  node?: string;
  yes?: boolean;
  server?: string;
}

interface SourceEntries {
  source: BackupSource;
  entries: BackupListEntry[];
}

function byService(entries: readonly BackupListEntry[]): Map<string, BackupListEntry[]> {
  const grouped = new Map<string, BackupListEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.service) ?? [];
    list.push(entry);
    grouped.set(entry.service, list);
  }
  return grouped;
}

function parseRetention(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError('--keep must be a non-negative integer');
  return n;
}

export async function runBackupPrune(env: string, service: string | undefined, options: BackupPruneOptions): Promise<void> {
  const retentionCount = parseRetention(options.keep, loadConfig()?.backup?.retention_count ?? 10);
  const sources: BackupSource[] = service ? [requireBackupSource(service).source] : configuredSources();

  printIntro(`Prune Backups (${env})`);
  printBlank();

  if (sources.length === 0) {
    printInfo('No backup configuration found');
    return;
  }

  const ctx = await openDay2(env, { server: options.server, failover: false });
  const bySource: SourceEntries[] = [];
  for (const source of sources) {
    const listed = await createBackup(ctx.orchestrator, refForSource(ctx, source)).list(service, { node: options.node });
    if (!listed.success) throw listed.error;
    bySource.push({ source, entries: listed.data.entries });
  }

  const summary: { service: string; total: number; toRemove: number }[] = [];
  for (const { entries } of bySource) {
    for (const [svc, list] of byService(entries)) {
      if (list.length > retentionCount) summary.push({ service: svc, total: list.length, toRemove: list.length - retentionCount });
    }
  }

  if (summary.length === 0) {
    printInfo(`Nothing to prune (keeping ${retentionCount} per service)`);
    return;
  }

  printWarning(`Will remove ${summary.reduce((n, s) => n + s.toRemove, 0)} backup(s), keeping ${retentionCount} per service:`);
  for (const { service: svc, total, toRemove } of summary) {
    printRaw(`  ${colors.info(svc)}: ${total} total, removing ${toRemove}`);
  }
  printBlank();

  if (!options.yes) {
    const confirmed = await confirmPrompt({ message: 'Proceed with pruning?', initialValue: false });
    if (!confirmed) {
      printInfo('Cancelled');
      return;
    }
  }

  const spinner = createSpinner();
  spinner.start('Pruning backups...');
  let removed = 0;
  let bytesFreed = 0;
  for (const { source, entries } of bySource) {
    const ref = refForSource(ctx, source);
    for (const [svc, list] of byService(entries)) {
      if (list.length <= retentionCount) continue;
      const result = await createBackup(ctx.orchestrator, ref).prune(svc, retentionCount, { node: options.node, prefetched: list });
      if (!result.success) {
        spinner.fail('Prune failed');
        throw result.error;
      }
      removed += result.data.removed;
      bytesFreed += result.data.bytesFreed;
    }
  }

  spinner.succeed(`Pruned ${removed} backup(s)${bytesFreed > 0 ? ` (${formatBytes(bytesFreed)})` : ''}`);
  printBlank();
  printOutro('Prune completed');
}

export function registerBackupPruneCommand(program: Command): void {
  program
    .command('prune <env> [service]')
    .description('Remove old backups (keeps the latest N per service)')
    .option('--keep <n>', 'Number of backups to keep per service (default: config retention_count or 10)')
    .option('--node <name>', 'Limit to backup files on this server (manager or worker)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withErrorHandler(withResolvedEnv(runBackupPrune)));
}
