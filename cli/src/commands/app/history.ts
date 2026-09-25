/**
 * `dockflow history <env>` (design-06 3.19): deployment history / audit log, read with the same
 * manager-then-worker fallback as `metrics` (R-S4-04) instead of the first manager only, so a
 * single down node never hides history under failover (D20).
 */

import type { Command } from 'commander';
import { fetchAuditWithFallback } from '../../services/audit';
import { printSection, printNote, printDebug, colors, printBlank, printWarning, printDim, printJSON, printRaw } from '../../utils/output';
import { withErrorHandler } from '../../utils/errors';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

interface AuditEntry {
  timestamp: string;
  action: string;
  version: string;
  performer: string;
  message: string;
}

function parseAuditLine(line: string): AuditEntry | null {
  const parts = line.split(' | ');
  if (parts.length < 4) return null;

  return {
    timestamp: parts[0]?.trim() || '',
    action: parts[1]?.trim() || '',
    version: parts[2]?.trim() || '',
    performer: parts[3]?.trim() || '',
    message: parts[4]?.trim() || ''
  };
}

function formatAuditEntry(entry: AuditEntry): string {
  const actionColors: Record<string, (s: string) => string> = {
    'DEPLOYED': colors.success,
    'ROLLBACK': colors.warning,
    'FAILED': colors.error,
    'LOCKED': colors.info,
    'UNLOCKED': colors.info,
  };

  const colorFn = actionColors[entry.action] || colors.bold;
  const actionPadded = entry.action.padEnd(10);

  return `${colors.dim(entry.timestamp)} ${colorFn(actionPadded)} ${colors.info(entry.version.padEnd(20))} ${entry.performer}${entry.message ? colors.dim(' - ' + entry.message) : ''}`;
}

export interface HistoryCommandOptions {
  server?: string;
  lines?: string;
  all?: boolean;
  json?: boolean;
}

export async function runHistory(env: string, options: HistoryCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const lines = options.all ? 1000 : parseInt(options.lines || '20', 10);
  printDebug('Connection validated', { stackName: ctx.stackName, lines, json: options.json });

  const nodes = [...ctx.orchestrator.target.managers, ...ctx.orchestrator.target.workers];
  const { raw, node } = await fetchAuditWithFallback(nodes, ctx.stackName, lines);

  if (!raw) {
    printBlank();
    printWarning(`No audit log found for ${ctx.stackName}`);
    printDim('Audit logs are created after the first deployment.');
    return;
  }

  // R-S4-04: name the manager the data came from whenever it is not the first one
  const firstManager = nodes[0];
  if (node && firstManager && node.name !== firstManager.name) {
    printDim(`Read from ${node.name}`);
  }

  const entries = raw
    .trim()
    .split('\n')
    .map(parseAuditLine)
    .filter((e): e is AuditEntry => e !== null)
    .reverse(); // Most recent first

  if (options.json) {
    printJSON(entries);
    return;
  }

  printBlank();
  printSection(`Audit Log: ${ctx.stackName}`);
  printBlank();

  if (entries.length === 0) {
    printDim('No audit entries found');
    return;
  }

  // Header
  printRaw(
    colors.dim('TIMESTAMP'.padEnd(26)) +
    colors.dim('ACTION'.padEnd(12)) +
    colors.dim('VERSION'.padEnd(22)) +
    colors.dim('PERFORMER')
  );
  printDim('─'.repeat(80));

  // Entries
  entries.forEach(entry => {
    printRaw(formatAuditEntry(entry));
  });

  printBlank();
  printDim(`Showing ${entries.length} most recent entries`);
  if (!options.all) {
    printNote('Use --all to show complete history');
  }
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history <env>')
    .alias('audit')
    .description('Show deployment history')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-n, --lines <number>', 'Number of lines to show', '20')
    .option('--all', 'Show all entries')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(withResolvedEnv(runHistory)));
}
