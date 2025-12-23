/**
 * Lock status command - Show current lock status
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printInfo, printSuccess, printWarning } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockStatusCommand(parent: Command): void {
  parent
    .command('status <env>')
    .description('Show deployment lock status')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .action(withErrorHandler(async (env: string, options: { server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      
      const lockFile = `/var/lib/dockflow/locks/${stackName}.lock`;

      try {
        // Check if lock file exists
        const checkResult = await sshExec(connection, `cat "${lockFile}" 2>/dev/null || echo "NO_LOCK"`);
        const output = checkResult.stdout.trim();

        if (output === 'NO_LOCK') {
          printSuccess(`No active lock for ${stackName}`);
          console.log(chalk.gray('  Deployments are allowed.'));
          return;
        }

        // Parse lock info
        try {
          const lockInfo = JSON.parse(output);
          const lockedAt = new Date(lockInfo.started_at);
          const now = new Date();
          const diffMinutes = Math.floor((now.getTime() - lockedAt.getTime()) / 60000);
          
          // Check if stale (> 30 minutes)
          const isStale = diffMinutes > 30;

          console.log('');
          if (isStale) {
            printWarning(`Lock is STALE (${diffMinutes} minutes old)`);
          } else {
            printInfo(`Deployment is LOCKED`);
          }
          
          console.log('');
          console.log(chalk.white('  Lock Details:'));
          console.log(chalk.gray(`    Stack:     ${lockInfo.stack}`));
          console.log(chalk.gray(`    Holder:    ${lockInfo.performer}`));
          console.log(chalk.gray(`    Started:   ${lockInfo.started_at}`));
          console.log(chalk.gray(`    Version:   ${lockInfo.version}`));
          console.log(chalk.gray(`    Duration:  ${diffMinutes} minutes`));
          console.log('');

          if (isStale) {
            console.log(chalk.yellow('  This lock appears stale and will be auto-released on next deploy.'));
            console.log(chalk.yellow('  Or run: dockflow lock release ' + env));
          } else {
            console.log(chalk.gray('  A deployment is in progress. Wait for it to complete.'));
            console.log(chalk.gray('  To force release: dockflow lock release ' + env + ' --force'));
          }
        } catch {
          printWarning('Lock file exists but could not be parsed');
          console.log(chalk.gray(`  File: ${lockFile}`));
        }
      } catch (error) {
        throw new CLIError(`Failed to check lock status: ${error}`, ErrorCode.COMMAND_FAILED);
      }
    }));
}
