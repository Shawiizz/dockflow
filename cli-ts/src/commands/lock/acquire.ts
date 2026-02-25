/**
 * Lock acquire command - Manually acquire a deployment lock
 */

import type { Command } from 'commander';
import ora from 'ora';
import { printWarning, printDim, printBlank } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createLockService } from '../../services';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockAcquireCommand(parent: Command): void {
  parent
    .command('acquire <env>')
    .description('Acquire a deployment lock (prevents other deployments)')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-m, --message <message>', 'Lock message/reason')
    .option('--force', 'Force acquire even if already locked')
    .action(withErrorHandler(async (env: string, options: { server?: string; message?: string; force?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      const lockService = createLockService(connection, stackName);
      const spinner = ora();

      // Check for existing lock (show info if blocked)
      if (!options.force) {
        spinner.start('Checking for existing lock...');
        const current = await lockService.status();

        if (current.success && current.data.locked) {
          spinner.stop();
          printWarning('Deployment is already locked');
          if (current.data.data) {
            printDim(`  Holder:  ${current.data.data.performer}`);
            printDim(`  Started: ${current.data.data.started_at}`);
            printDim(`  Version: ${current.data.data.version}`);
            printBlank();
          }
          throw new CLIError('Use --force to override the existing lock.', ErrorCode.DEPLOY_LOCKED);
        }
        spinner.stop();
      }

      // Acquire lock
      spinner.start('Acquiring lock...');
      const result = await lockService.acquire({
        message: options.message,
        force: options.force,
      });

      if (!result.success) {
        spinner.fail('Failed to acquire lock');
        throw new CLIError(result.error.message, ErrorCode.COMMAND_FAILED);
      }

      spinner.succeed(`Lock acquired for ${stackName}`);
      printBlank();
      printDim('  Deployments to this environment are now blocked.');
      printDim('  Release with: dockflow lock release ' + env);

      if (options.message) {
        printDim(`  Reason: ${options.message}`);
      }
    }));
}
