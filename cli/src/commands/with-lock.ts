/**
 * The deploy lock around a command that changes the stack: acquire, run, release in `finally`.
 * The first Ctrl+C aborts the signal handed to the action, which stops at its next safe point
 * instead of dying mid-change; the lock is released and a failure caused by the stop exits
 * INTERRUPTED. A second Ctrl+C exits at once and leaves the lock for `dockflow lock release`.
 */

import type { Lock } from '../services/lock';
import { CLIError, ErrorCode } from '../utils/errors';
import { onInterrupt } from '../utils/interrupt';
import { printWarning } from '../utils/output';

export async function withDeployLock<T>(lock: Lock, message: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const acquired = await lock.acquire({ message });
  if (!acquired.success) throw acquired.error;

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
    const released = await lock.release();
    if (!released.success) printWarning(`Lock release failed: ${released.error.message}`);
  }
}

/** For a step that must not start once Ctrl+C was pressed. */
export function stopIfInterrupted(signal: AbortSignal, what: string): void {
  if (signal.aborted) throw new CLIError(`Interrupted before ${what}`, ErrorCode.INTERRUPTED);
}
