/**
 * `dockflow lock acquire <env>` (design-06 3.18): manually take the deploy lock over
 * `orchestrator.lock(stackName)` (design-03 14.2 on both orchestrators). Texts unchanged from today.
 */

import type { Command } from 'commander';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';
import { createSpinner, printBlank, printDim, printNote, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface LockAcquireOptions {
  server?: string;
  message?: string;
  force?: boolean;
}

export async function runLockAcquire(env: string, options: LockAcquireOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const lock = ctx.lock();
  const spinner = createSpinner();

  if (!options.force) {
    spinner.start('Checking for existing lock...');
    const current = await lock.status();
    if (!current.success) {
      spinner.fail('Failed to check lock status');
      throw new CLIError(current.error.message, ErrorCode.COMMAND_FAILED);
    }

    if (current.data.locked) {
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

  spinner.start('Acquiring lock...');
  const result = await lock.acquire({ message: options.message, force: options.force });
  if (!result.success) {
    spinner.fail('Failed to acquire lock');
    throw new CLIError(result.error.message, ErrorCode.COMMAND_FAILED);
  }

  spinner.succeed(`Lock acquired for ${ctx.stackName}`);
  const noteLines = ['Deployments to this environment are now blocked.', `Release with: dockflow lock release ${env}`];
  if (options.message) noteLines.push(`Reason: ${options.message}`);
  printNote(noteLines.join('\n'));
}

export function registerLockAcquireCommand(parent: Command): void {
  parent
    .command('acquire <env>')
    .description('Acquire a deployment lock (prevents other deployments)')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-m, --message <message>', 'Lock message/reason')
    .option('--force', 'Force acquire even if already locked')
    .action(withErrorHandler(withResolvedEnv(runLockAcquire)));
}
