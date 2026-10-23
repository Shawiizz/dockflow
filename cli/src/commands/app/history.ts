import type { Command } from 'commander';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printSection, printNote, printDebug, colors, printBlank, printWarning, printDim, printJSON, printRaw } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { nodesOf, readFromFirstNode } from './nodes';
import { DockerError, withErrorHandler } from '../../utils/errors';
import { DOCKFLOW_AUDIT_DIR } from '../../constants';

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

export function registerHistoryCommand(program: Command): void {
  program
    .command('history <env>')
    .alias('audit')
    .description('Show deployment history')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-n, --lines <number>', 'Number of lines to show', '20')
    .option('--all', 'Show all entries')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { server?: string; lines?: string; all?: boolean; json?: boolean }) => {
      const { stackName, connection, serverName } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName, lines: options.lines, json: options.json });

      const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
      const lines = options.all ? 1000 : parseInt(options.lines || '20', 10);

      // every node keeps a copy: a manager down does not hide the history
      const nodes = options.server ? [{ name: serverName, connection }] : nodesOf(env, { name: serverName, connection });

      try {
        const found = await readFromFirstNode(
          nodes,
          async (node) => (await sshExec(node.connection, `tail -n ${lines} ${shellQuote(auditFile)} 2>/dev/null`)).stdout.trim(),
          (output) => output === '',
        );
        const output = found?.value ?? '';

        if (!output) {
          printBlank();
          printWarning(`No audit log found for ${stackName}`);
          printDim('Audit logs are created after the first deployment.');
          return;
        }

        const entries = output
          .split('\n')
          .map(parseAuditLine)
          .filter((e): e is AuditEntry => e !== null)
          .reverse(); // Most recent first

        if (options.json) {
          printJSON(entries);
          return;
        }

        printBlank();
        printSection(`Audit Log: ${stackName}`);
        printBlank();

        if (entries.length === 0) {
          printDim('No audit entries found');
          return;
        }

        printRaw(
          colors.dim('TIMESTAMP'.padEnd(26)) +
          colors.dim('ACTION'.padEnd(12)) +
          colors.dim('VERSION'.padEnd(22)) +
          colors.dim('PERFORMER')
        );
        printDim('─'.repeat(80));

        entries.forEach(entry => {
          printRaw(formatAuditEntry(entry));
        });

        printBlank();
        printDim(`Showing ${entries.length} most recent entries`);
        if (!options.all) {
          printNote('Use --all to show complete history');
        }
      } catch (error) {
        throw new DockerError(`Failed to fetch audit log: ${error}`);
      }
    })));
}
