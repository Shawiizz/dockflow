/**
 * `dockflow lock release <env>` (design-06 3.18): release the deploy lock over
 * `orchestrator.lock(stackName)`. When this process never held it, the store's own unconditional
 * release is the documented behaviour of a manual release (core 6.7). Texts unchanged from today.
 */

import type { Command } from 'commander';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';
import { createSpinner, printBlank, printDim, printInfo, printNote } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface LockReleaseOptions {
  server?: string;
  force?: boolean;
}

export async function runLockRelease(env: string, options: LockReleaseOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const lock = ctx.lock();
  const spinner = createSpinner();

  spinner.start('Checking lock status...');
  const current = await lock.status();
  if (!current.success) {
    spinner.fail('Failed to check lock status');
    throw new CLIError(current.error.message, ErrorCode.COMMAND_FAILED);
  }

  if (!current.data.locked) {
    spinner.info(`No lock found for ${ctx.stackName}`);
    return;
  }

  spinner.stop();
  if (current.data.data) {
    printInfo('Current lock:');
    printDim(`  Holder:  ${current.data.data.performer}`);
    printDim(`  Started: ${current.data.data.started_at}`);
    printDim(`  Version: ${current.data.data.version}`);
    if (current.data.data.message) printDim(`  Message: ${current.data.data.message}`);
    printBlank();
  }

  spinner.start('Releasing lock...');
  const result = await lock.release();
  if (!result.success) {
    spinner.fail('Failed to release lock');
    throw new CLIError(result.error.message, ErrorCode.COMMAND_FAILED);
  }

  spinner.succeed(`Lock released for ${ctx.stackName}`);
  printNote('Deployments to this environment are now allowed.');
}

export function registerLockReleaseCommand(parent: Command): void {
  parent
    .command('release <env>')
    .description('Release a deployment lock')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--force', 'Force release without confirmation')
    .action(withErrorHandler(withResolvedEnv(runLockRelease)));
}
