/**
 * Lock status command - Show current lock status
 */

import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printInfo, printSuccess, printWarning, colors } from '../../utils/output';
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
          console.log(colors.dim('  Deployments are allowed.'));
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
          console.log(colors.bold('  Lock Details:'));
          console.log(colors.dim(`    Stack:     ${lockInfo.stack}`));
          console.log(colors.dim(`    Holder:    ${lockInfo.performer}`));
          console.log(colors.dim(`    Started:   ${lockInfo.started_at}`));
          console.log(colors.dim(`    Version:   ${lockInfo.version}`));
          console.log(colors.dim(`    Duration:  ${diffMinutes} minutes`));
          console.log('');

          if (isStale) {
            console.log(colors.warning('  This lock appears stale and will be auto-released on next deploy.'));
            console.log(colors.warning('  Or run: dockflow lock release ' + env));
          } else {
            console.log(colors.dim('  A deployment is in progress. Wait for it to complete.'));
            console.log(colors.dim('  To force release: dockflow lock release ' + env + ' --force'));
          }
        } catch {
          printWarning('Lock file exists but could not be parsed');
          console.log(colors.dim(`  File: ${lockFile}`));
        }
      } catch (error) {
        throw new CLIError(`Failed to check lock status: ${error}`, ErrorCode.COMMAND_FAILED);
      }
    }));
}
