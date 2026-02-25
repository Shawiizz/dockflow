/**
 * Lock release command - Release a deployment lock
 */

import type { Command } from 'commander';
import ora from 'ora';
import { printInfo, colors } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createLockService } from '../../services';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockReleaseCommand(parent: Command): void {
  parent
    .command('release <env>')
    .description('Release a deployment lock')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--force', 'Force release without confirmation')
    .action(withErrorHandler(async (env: string, options: { server?: string; force?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      const lockService = createLockService(connection, stackName);
      const spinner = ora();

      // Check if lock exists
      spinner.start('Checking lock status...');
      const current = await lockService.status();

      if (!current.success) {
        spinner.fail('Failed to check lock status');
        throw new CLIError(current.error.message, ErrorCode.COMMAND_FAILED);
      }

      if (!current.data.locked) {
        spinner.info(`No lock found for ${stackName}`);
        return;
      }

      // Show lock info before releasing
      spinner.stop();
      if (current.data.data) {
        printInfo('Current lock:');
        console.log(colors.dim(`  Holder:  ${current.data.data.performer}`));
        console.log(colors.dim(`  Started: ${current.data.data.started_at}`));
        console.log(colors.dim(`  Version: ${current.data.data.version}`));
        if (current.data.data.message) {
          console.log(colors.dim(`  Message: ${current.data.data.message}`));
        }
        console.log('');
      }

      // Release lock
      spinner.start('Releasing lock...');
      const result = await lockService.release();

      if (!result.success) {
        spinner.fail('Failed to release lock');
        throw new CLIError(result.error.message, ErrorCode.COMMAND_FAILED);
      }

      spinner.succeed(`Lock released for ${stackName}`);
      console.log(colors.dim('  Deployments to this environment are now allowed.'));
    }));
}
