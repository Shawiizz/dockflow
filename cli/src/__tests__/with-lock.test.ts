import { describe, expect, it, spyOn } from 'bun:test';
import { stopIfInterrupted, withDeployLock } from '../commands/with-lock';
import type { Lock } from '../services/lock';
import { CLIError, ErrorCode } from '../utils/errors';
import { dispatchInterrupt } from '../utils/interrupt';
import * as output from '../utils/output';

function fakeLock(acquire: 'ok' | CLIError = 'ok') {
  const events: string[] = [];
  const lock = {
    acquire: async () => {
      events.push('acquire');
      return acquire === 'ok' ? { success: true as const, data: {} } : { success: false as const, error: acquire };
    },
    release: async () => {
      events.push('release');
      return { success: true as const, data: undefined };
    },
  } as unknown as Lock;
  return { lock, events };
}

spyOn(output, 'printWarning').mockImplementation(() => {});

describe('withDeployLock', () => {
  it('runs the action while the lock is held, then releases it', async () => {
    const { lock, events } = fakeLock();
    await withDeployLock(lock, 'Stop', async () => {
      events.push('action');
    });
    expect(events).toEqual(['acquire', 'action', 'release']);
  });

  it('releases the lock when the action fails, and keeps its error', async () => {
    const { lock, events } = fakeLock();
    const boom = new CLIError('boom', ErrorCode.DEPLOY_FAILED);
    await expect(withDeployLock(lock, 'Stop', async () => { throw boom; })).rejects.toBe(boom);
    expect(events).toEqual(['acquire', 'release']);
  });

  it('runs nothing when another deploy holds the lock', async () => {
    const held = new CLIError('Already locked by ci (2 min ago)', ErrorCode.DEPLOY_LOCKED);
    const { lock, events } = fakeLock(held);
    await expect(withDeployLock(lock, 'Stop', async () => { events.push('action'); })).rejects.toBe(held);
    expect(events).toEqual(['acquire']);
  });

  it('a Ctrl+C stops the action at its next safe point, releases the lock and exits INTERRUPTED', async () => {
    const { lock, events } = fakeLock();
    const failure = await withDeployLock(lock, 'Remove accessories', async (signal) => {
      dispatchInterrupt(130, () => events.push('exit'));
      stopIfInterrupted(signal, 'deleting the volumes');
      events.push('volumes deleted');
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure.code).toBe(ErrorCode.INTERRUPTED);
    expect(events).toEqual(['acquire', 'release']);
  });
});
