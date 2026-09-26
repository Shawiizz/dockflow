import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { withLock } from '../commands/shared/lock';
import type { LockData, LockStore } from '../services/orchestrator/interfaces';
import { err, ok } from '../types/result';
import { DeployError, ErrorCode, InterruptedError, OrchestratorUnavailableError } from '../utils/errors';
import { dispatchInterrupt, onInterrupt } from '../utils/interrupt';
import * as output from '../utils/output';

const LOCK_DATA: LockData = { performer: 'me', started_at: '2026-09-26T00:00:00.000Z', timestamp: 0, version: 'manual-lock', stack: 'shop-production', message: 'm' };

class FakeLock implements LockStore {
  readonly events: string[] = [];
  constructor(
    private readonly held: string | null = null,
    private readonly unanswered: Error | null = null,
  ) {}
  async status() {
    return ok({ locked: this.held !== null });
  }
  async acquire(options?: { message?: string; version?: string }) {
    this.events.push(`acquire ${options?.message}${options?.version ? ` ${options.version}` : ''}`);
    if (this.unanswered) return err(this.unanswered);
    return this.held === null ? ok(LOCK_DATA) : err(new Error(`Already locked by ${this.held} (0 min ago)`));
  }
  async release() {
    this.events.push('release');
    return ok(undefined);
  }
}

const exits: number[] = [];
const exit = (code: number): void => {
  exits.push(code);
};

afterEach(() => {
  exits.length = 0;
  // a test that registered and never dispatched must not leave its handler to the next one
  dispatchInterrupt(0, () => {});
  exits.length = 0;
});

describe('dispatchInterrupt', () => {
  it('exits with the signal code when no command registered a cleanup', () => {
    dispatchInterrupt(130, exit);
    expect(exits).toEqual([130]);
  });

  it('runs the registered handlers instead of exiting, once: a second signal exits at once', () => {
    const ran: string[] = [];
    onInterrupt(() => ran.push('a'));
    onInterrupt(() => ran.push('b'));

    dispatchInterrupt(130, exit);
    expect(ran).toEqual(['a', 'b']);
    expect(exits).toEqual([]);

    dispatchInterrupt(130, exit);
    expect(ran).toEqual(['a', 'b']);
    expect(exits).toEqual([130]);
  });

  it('an unregistered handler no longer runs', () => {
    const ran: string[] = [];
    const stop = onInterrupt(() => ran.push('a'));
    stop();

    dispatchInterrupt(143, exit);
    expect(ran).toEqual([]);
    expect(exits).toEqual([143]);
  });
});

describe('withLock', () => {
  it('acquires, runs the action with a live signal, then releases', async () => {
    const lock = new FakeLock();
    const result = await withLock(lock, { message: 'Stop', version: '1.2.3' }, async (signal) => {
      lock.events.push(`action aborted=${signal.aborted}`);
      return 42;
    });
    expect(result).toBe(42);
    expect(lock.events).toEqual(['acquire Stop 1.2.3', 'action aborted=false', 'release']);
  });

  it('a held lock is DEPLOY_LOCKED with the hint, and the action never runs', async () => {
    const lock = new FakeLock('someone');
    let ran = false;
    const failure = withLock(lock, { message: 'Stop', lockedHint: 'Wait for it.' }, async () => {
      ran = true;
    });
    await expect(failure).rejects.toMatchObject({ code: ErrorCode.DEPLOY_LOCKED, message: 'Already locked by someone (0 min ago)', suggestion: 'Wait for it.' });
    expect(ran).toBe(false);
    expect(lock.events).toEqual(['acquire Stop']);
  });

  it('a cluster that does not answer keeps its own error, not DEPLOY_LOCKED', async () => {
    const unreachable = new OrchestratorUnavailableError('The Kubernetes API is not answering on server_1', 'Check the k3s service.');
    const failure = withLock(new FakeLock(null, unreachable), { message: 'Stop', lockedHint: 'Wait for it.' }, async () => {});
    await expect(failure).rejects.toBe(unreachable);
  });

  it('Ctrl+C aborts the signal; the failure it causes exits INTERRUPTED with its own text, after the release', async () => {
    const lock = new FakeLock();
    const warn = spyOn(output, 'printWarning').mockImplementation(() => {});
    try {
      const failure = withLock(lock, { message: 'Remove accessories' }, async (signal) => {
        dispatchInterrupt(130, exit);
        if (signal.aborted) throw new DeployError('Stopped before the volumes', ErrorCode.DEPLOY_FAILED, 'Run it again.');
      });
      await expect(failure).rejects.toMatchObject({ code: ErrorCode.INTERRUPTED, message: 'Stopped before the volumes', suggestion: 'Run it again.' });
      expect(exits).toEqual([]);
      expect(lock.events).toEqual(['acquire Remove accessories', 'release']);
      expect(warn.mock.calls[0]?.[0]).toMatch(/^Interrupted: finishing the current step, then releasing the lock/);
    } finally {
      warn.mockRestore();
    }
  });

  it('an InterruptedError passes through unchanged', async () => {
    const lock = new FakeLock();
    const warn = spyOn(output, 'printWarning').mockImplementation(() => {});
    try {
      const interrupted = new InterruptedError('Removal interrupted before any volume was deleted', 'Run the command again to delete them.');
      const failure = withLock(lock, { message: 'Stop' }, async () => {
        dispatchInterrupt(130, exit);
        throw interrupted;
      });
      await expect(failure).rejects.toBe(interrupted);
    } finally {
      warn.mockRestore();
    }
  });

  it('an action that ignores the signal completes, and the lock is released after it', async () => {
    const lock = new FakeLock();
    const warn = spyOn(output, 'printWarning').mockImplementation(() => {});
    try {
      const result = await withLock(lock, { message: 'Restore db' }, async () => {
        dispatchInterrupt(130, exit);
        lock.events.push('restore finished');
        return 'done';
      });
      expect(result).toBe('done');
      expect(lock.events).toEqual(['acquire Restore db', 'restore finished', 'release']);
    } finally {
      warn.mockRestore();
    }
  });

  it('a failure without an interrupt keeps its own code, and the handler is gone afterwards', async () => {
    const lock = new FakeLock();
    await expect(
      withLock(lock, { message: 'Stop' }, async () => {
        throw new DeployError('boom', ErrorCode.DEPLOY_FAILED);
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DEPLOY_FAILED });
    dispatchInterrupt(130, exit);
    expect(exits).toEqual([130]);
  });
});
