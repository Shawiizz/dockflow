/**
 * The deploy lock around a command that changes the stack (design-06 2.8): acquire, run, release in
 * `finally`. The first Ctrl+C aborts the signal handed to the action, which stops at its next safe
 * point instead of dying mid-change; the lock is released and a failure caused by the stop exits
 * INTERRUPTED (130). A second Ctrl+C exits at once and leaves the lock for `dockflow lock release`.
 */

import type { LockStore } from '../../services/orchestrator/interfaces';
import { CLIError, DeployError, ErrorCode } from '../../utils/errors';
import { onInterrupt } from '../../utils/interrupt';
import { printWarning } from '../../utils/output';

export interface WithLockOptions {
  message: string;
  version?: string;
  /** the DEPLOY_LOCKED suggestion when another holder has the lock */
  lockedHint?: string;
}

export async function withLock<T>(lock: LockStore, options: WithLockOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const acquired = await lock.acquire(options.version !== undefined ? { message: options.message, version: options.version } : { message: options.message });
  if (!acquired.success) throw new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED, options.lockedHint);

  const interrupt = new AbortController();
  const stopHandling = onInterrupt(() => {
    printWarning('Interrupted: finishing the current step, then releasing the lock (Ctrl+C again exits now and keeps the lock)');
    interrupt.abort();
  });
  try {
    return await action(interrupt.signal);
  } catch (error) {
    if (!interrupt.signal.aborted || (error instanceof CLIError && error.code === ErrorCode.INTERRUPTED)) throw error;
    const stopped = CLIError.from(error);
    throw new CLIError(stopped.message, ErrorCode.INTERRUPTED, stopped.suggestion, stopped.cause);
  } finally {
    stopHandling();
    await lock.release();
  }
}
