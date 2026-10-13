/**
 * Lock status command - Show current lock status
 */

import type { Command } from 'commander';
import { printInfo, printSuccess, printWarning, printDim, printBlank, printRaw, colors } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { createEnvLock } from '../../services/lock';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockStatusCommand(parent: Command): void {
  parent
    .command('status <env>')
    .description('Show deployment lock status')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { server?: string }) => {
      const { stackName, connection, config } = await resolveEnv(env, options.server);
      const lockService = await createEnvLock(env, stackName, config.lock?.stale_threshold_minutes);

      const result = await lockService.status();

      if (!result.success) {
        throw new CLIError(`Failed to check lock status: ${result.error.message}`, ErrorCode.COMMAND_FAILED);
      }

      const { locked, data, durationMinutes, isStale } = result.data;

      if (!locked) {
        printSuccess(`No active lock for ${stackName}`);
        printDim('  Deployments are allowed.');
        return;
      }

      printBlank();
      if (isStale) {
        printWarning(`Lock is STALE (${durationMinutes} minutes old)`);
      } else {
        printInfo(`Deployment is LOCKED`);
      }

      printBlank();
      if (data) {
        // the details are the command's output, on stdout with their header (`lock status <env> | grep Holder`)
        printRaw(colors.bold('  Lock Details:'));
        printRaw(colors.dim(`    Stack:     ${data.stack}`));
        printRaw(colors.dim(`    Holder:    ${data.performer}`));
        printRaw(colors.dim(`    Started:   ${data.started_at}`));
        printRaw(colors.dim(`    Version:   ${data.version}`));
        printRaw(colors.dim(`    Duration:  ${durationMinutes} minutes`));
        printBlank();
      }

      if (isStale) {
        printWarning('  This lock appears stale and will be auto-released on next deploy.');
        printWarning('  Or run: dockflow lock release ' + env);
      } else {
        printDim('  A deployment is in progress. Wait for it to complete.');
        printDim('  To force release: dockflow lock release ' + env + ' --force');
      }
    })));
}
