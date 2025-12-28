/**
 * Audit command - Show deployment audit log
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printSection, printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { DockerError, withErrorHandler } from '../../utils/errors';

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
    'DEPLOYED': chalk.green,
    'ROLLBACK': chalk.yellow,
    'FAILED': chalk.red,
    'LOCKED': chalk.blue,
    'UNLOCKED': chalk.blue,
  };
  
  const colorFn = actionColors[entry.action] || chalk.white;
  const actionPadded = entry.action.padEnd(10);
  
  return `${chalk.gray(entry.timestamp)} ${colorFn(actionPadded)} ${chalk.cyan(entry.version.padEnd(20))} ${chalk.white(entry.performer)}${entry.message ? chalk.gray(' - ' + entry.message) : ''}`;
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit <env>')
    .description('Show deployment audit log')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-n, --lines <number>', 'Number of lines to show', '20')
    .option('--all', 'Show all entries')
    .option('--json', 'Output as JSON')
    .action(withErrorHandler(async (env: string, options: { server?: string; lines?: string; all?: boolean; json?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, lines: options.lines, json: options.json });
      
      const auditFile = `/var/lib/dockflow/audit/${stackName}.log`;
      const lines = options.all ? 1000 : parseInt(options.lines || '20', 10);

      try {
        // Check if audit file exists and get content
        const result = await sshExec(
          connection,
          `cat "${auditFile}" 2>/dev/null | tail -n ${lines} || echo "NO_AUDIT_FILE"`
        );

        const output = result.stdout.trim();

        if (output === 'NO_AUDIT_FILE' || !output) {
          console.log('');
          console.log(chalk.yellow(`No audit log found for ${stackName}`));
          console.log(chalk.gray('Audit logs are created after the first deployment.'));
          return;
        }

        const entries = output
          .split('\n')
          .map(parseAuditLine)
          .filter((e): e is AuditEntry => e !== null)
          .reverse(); // Most recent first

        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        console.log('');
        printSection(`Audit Log: ${stackName}`);
        console.log('');
        
        if (entries.length === 0) {
          console.log(chalk.gray('No audit entries found'));
          return;
        }

        // Header
        console.log(
          chalk.gray('TIMESTAMP'.padEnd(26)) +
          chalk.gray('ACTION'.padEnd(12)) +
          chalk.gray('VERSION'.padEnd(22)) +
          chalk.gray('PERFORMER')
        );
        console.log(chalk.gray('─'.repeat(80)));

        // Entries
        entries.forEach(entry => {
          console.log(formatAuditEntry(entry));
        });

        console.log('');
        console.log(chalk.gray(`Showing ${entries.length} most recent entries`));
        if (!options.all) {
          console.log(chalk.gray(`Use --all to show complete history`));
        }
      } catch (error) {
        throw new DockerError(`Failed to fetch audit log: ${error}`);
      }
    }));
}
