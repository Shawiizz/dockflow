/**
 * `dockflow lock status <env>` (design-06 3.18): show the deploy lock's current holder, message,
 * age and staleness over `orchestrator.lock(stackName)`. Texts unchanged from today.
 */

import type { Command } from 'commander';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';
import { colors, printBlank, printDim, printInfo, printRaw, printSuccess, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface LockStatusOptions {
  server?: string;
}

export async function runLockStatus(env: string, options: LockStatusOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const lock = ctx.lock();

  const result = await lock.status();
  if (!result.success) {
    throw new CLIError(`Failed to check lock status: ${result.error.message}`, ErrorCode.COMMAND_FAILED);
  }

  const { locked, data, durationMinutes, isStale } = result.data;

  if (!locked) {
    printSuccess(`No active lock for ${ctx.stackName}`);
    printDim('  Deployments are allowed.');
    return;
  }

  printBlank();
  if (isStale) {
    printWarning(`Lock is STALE (${durationMinutes} minutes old)`);
  } else {
    printInfo('Deployment is LOCKED');
  }

  printBlank();
  if (data) {
    printRaw(colors.bold('  Lock Details:'));
    printDim(`    Stack:     ${data.stack}`);
    printDim(`    Holder:    ${data.performer}`);
    printDim(`    Started:   ${data.started_at}`);
    printDim(`    Version:   ${data.version}`);
    printDim(`    Duration:  ${durationMinutes} minutes`);
    printBlank();
  }

  if (isStale) {
    printWarning('  This lock appears stale and will be auto-released on next deploy.');
    printWarning(`  Or run: dockflow lock release ${env}`);
  } else {
    printDim('  A deployment is in progress. Wait for it to complete.');
    printDim(`  To force release: dockflow lock release ${env} --force`);
  }
}

export function registerLockStatusCommand(parent: Command): void {
  parent
    .command('status <env>')
    .description('Show deployment lock status')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .action(withErrorHandler(withResolvedEnv(runLockStatus)));
}
