/**
 * Lock status command - Show current lock status
 */

import type { Command } from 'commander';
import { printInfo, printSuccess, printWarning, colors } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createLockService } from '../../services';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockStatusCommand(parent: Command): void {
  parent
    .command('status <env>')
    .description('Show deployment lock status')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .action(withErrorHandler(async (env: string, options: { server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      const lockService = createLockService(connection, stackName);

      const result = await lockService.status();

      if (!result.success) {
        throw new CLIError(`Failed to check lock status: ${result.error.message}`, ErrorCode.COMMAND_FAILED);
      }

      const { locked, data, durationMinutes, isStale } = result.data;

      if (!locked) {
        printSuccess(`No active lock for ${stackName}`);
        console.log(colors.dim('  Deployments are allowed.'));
        return;
      }

      console.log('');
      if (isStale) {
        printWarning(`Lock is STALE (${durationMinutes} minutes old)`);
      } else {
        printInfo(`Deployment is LOCKED`);
      }

      console.log('');
      if (data) {
        console.log(colors.bold('  Lock Details:'));
        console.log(colors.dim(`    Stack:     ${data.stack}`));
        console.log(colors.dim(`    Holder:    ${data.performer}`));
        console.log(colors.dim(`    Started:   ${data.started_at}`));
        console.log(colors.dim(`    Version:   ${data.version}`));
        console.log(colors.dim(`    Duration:  ${durationMinutes} minutes`));
        console.log('');
      }

      if (isStale) {
        console.log(colors.warning('  This lock appears stale and will be auto-released on next deploy.'));
        console.log(colors.warning('  Or run: dockflow lock release ' + env));
      } else {
        console.log(colors.dim('  A deployment is in progress. Wait for it to complete.'));
        console.log(colors.dim('  To force release: dockflow lock release ' + env + ' --force'));
      }
    }));
}
