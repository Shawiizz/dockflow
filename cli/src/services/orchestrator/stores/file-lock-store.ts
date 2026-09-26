/**
 * Swarm deployment lock: one JSON file per stack under `<root>/locks` on the control-plane manager.
 * Commands and the API see only `LockStore`; the Kubernetes bundle uses LeaseLockStore, with the
 * same messages.
 *
 * - acquire: the lock file appears through `ln` of a complete temporary file, which fails when the
 *   file exists, so two deploys never both create it and nobody reads a half-written lock.
 * - stale takeover: a compare-and-swap. Under a short-lived guard directory the file is replaced
 *   only when it still holds the stale content that was read, so of two deploys that both saw the
 *   same stale lock exactly one wins, and the loser never removes the winner's lock.
 */

import { randomBytes } from 'crypto';
import { LOCK_STALE_THRESHOLD_MINUTES } from '../../../constants';
import { err, ok, type Result } from '../../../types/result';
import { getPerformer } from '../../../utils/config';
import { printDebug, printWarning } from '../../../utils/output';
import { shellQuote } from '../../../utils/ssh';
import type { LockData, LockStatus, LockStore } from '../interfaces';
import { staleTakeoverMessage } from '../lock-messages';
import { assertStoreName, DOCKFLOW_STATE_ROOT, type StoreShell } from './file-release-store';

const ACQUIRED = 'ACQUIRED';
const STALE_TAKEN = 'Lock was stale but another deploy acquired it first';
/** a takeover guard older than this was left by a killed process (the guarded step takes milliseconds) */
const ABANDONED_GUARD_MINUTES = 1;

export interface FileLockStoreOptions {
  /** replaces `/var/lib/dockflow` */
  root?: string;
  staleThresholdMinutes?: number;
  /** lock file name without `.lock`; defaults to the stack name (a shared lock passes its own) */
  name?: string;
  /** epoch milliseconds */
  now?: () => number;
  /** `LockData.performer`; defaults to `user@host` of this machine */
  performer?: string;
}

interface LockRead {
  status: LockStatus;
  /** file content as read (trailing newlines dropped), the expected value of a stale takeover */
  content: string | null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class FileLockStore implements LockStore {
  private readonly locksDir: string;
  private readonly lockFile: string;
  private readonly staleThresholdMinutes: number;
  private readonly now: () => number;

  constructor(
    private readonly shell: StoreShell,
    private readonly stackName: string,
    private readonly options: FileLockStoreOptions = {},
  ) {
    const name = options.name ?? stackName;
    assertStoreName(name, 'lock');
    this.locksDir = `${(options.root ?? DOCKFLOW_STATE_ROOT).replace(/\/+$/, '')}/locks`;
    this.lockFile = `${this.locksDir}/${name}.lock`;
    this.staleThresholdMinutes = options.staleThresholdMinutes ?? LOCK_STALE_THRESHOLD_MINUTES;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<Result<LockStatus, Error>> {
    try {
      return ok((await this.read()).status);
    } catch (error) {
      return err(toError(error));
    }
  }

  async acquire(options?: { message?: string; force?: boolean; version?: string }): Promise<Result<LockData, Error>> {
    try {
      const now = new Date(this.now());
      const lockData: LockData = {
        performer: this.options.performer ?? getPerformer(),
        started_at: now.toISOString(),
        timestamp: Math.floor(now.getTime() / 1000),
        version: options?.version || 'manual-lock',
        stack: this.stackName,
        message: options?.message || 'Manual lock via CLI',
      };
      const content = JSON.stringify(lockData, null, 2);

      if (options?.force) {
        const forced = await this.shell.run(this.forceCommand(), content);
        return forced.stdout.trim() === ACQUIRED ? ok(lockData) : err(this.cannotCreate());
      }

      if (await this.tryCreate(content)) return ok(lockData);

      let current = await this.read();
      if (!current.status.locked) {
        // released between the create attempt and the read: one more attempt before blaming permissions
        if (await this.tryCreate(content)) return ok(lockData);
        current = await this.read();
        if (!current.status.locked) return err(this.cannotCreate());
      }

      if (current.status.isStale) {
        const takeover = await this.shell.run(this.takeoverCommand(current.content ?? ''), content);
        if (takeover.stdout.trim() !== ACQUIRED) return err(new Error(STALE_TAKEN));
        printWarning(staleTakeoverMessage(current.status.data ?? null, current.status.durationMinutes ?? null));
        return ok(lockData);
      }

      return err(
        new Error(
          current.status.data
            ? `Already locked by ${current.status.data.performer} (${current.status.durationMinutes} min ago)`
            : 'Lock file exists but could not be parsed',
        ),
      );
    } catch (error) {
      return err(toError(error));
    }
  }

  async release(): Promise<Result<void, Error>> {
    try {
      const file = shellQuote(this.lockFile);
      const result = await this.shell.run(`rm -f ${file}; test -f ${file} && echo EXISTS || echo REMOVED`);
      if (result.stdout.trim() === 'EXISTS') {
        return err(new Error('Lock file could not be removed. Check permissions on the server.'));
      }
      return ok(undefined);
    } catch (error) {
      return err(toError(error));
    }
  }

  private async read(): Promise<LockRead> {
    const result = await this.shell.run(`cat ${shellQuote(this.lockFile)} 2>/dev/null || echo NO_LOCK`);
    const output = result.stdout.trim();
    if (output === 'NO_LOCK' || !output) return { status: { locked: false }, content: null };

    const content = result.stdout.replace(/\n+$/, '');
    try {
      const data = JSON.parse(output) as LockData;
      const durationMinutes = Math.floor((this.now() - new Date(data.started_at).getTime()) / 60000);
      const isStale = durationMinutes > this.staleThresholdMinutes;
      return { status: { locked: true, data, durationMinutes, isStale }, content };
    } catch (parseErr) {
      printDebug(`Lock metadata parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      return { status: { locked: true, isStale: true }, content };
    }
  }

  private tempFile(): string {
    return `${this.lockFile}.tmp.${randomBytes(4).toString('hex')}`;
  }

  private cannotCreate(): Error {
    return new Error(`Cannot create lock file at ${this.lockFile}. Check directory permissions on the server.`);
  }

  /** `ln` refuses an existing target: the create-if-absent step, with the content already complete */
  private async tryCreate(content: string): Promise<boolean> {
    const dir = shellQuote(this.locksDir);
    const file = shellQuote(this.lockFile);
    const tmp = shellQuote(this.tempFile());
    const result = await this.shell.run(
      `mkdir -p ${dir} && cat > ${tmp} && ln ${tmp} ${file} 2>/dev/null && echo ${ACQUIRED} || echo LOCKED; rm -f ${tmp}`,
      content,
    );
    return result.stdout.trim() === ACQUIRED;
  }

  private forceCommand(): string {
    const dir = shellQuote(this.locksDir);
    const tmp = shellQuote(this.tempFile());
    return `mkdir -p ${dir} && cat > ${tmp} && mv -f ${tmp} ${shellQuote(this.lockFile)} && echo ${ACQUIRED} || echo FAILED; rm -f ${tmp}`;
  }

  /**
   * Replaces the lock only if it still holds `expected`. A lock that disappeared in the meantime
   * is created instead (one retry, like the Lease store).
   */
  private takeoverCommand(expected: string): string {
    const file = shellQuote(this.lockFile);
    const guard = shellQuote(`${this.lockFile}.takeover`);
    const tmp = shellQuote(this.tempFile());
    return [
      'r=LOCKED',
      `if cat > ${tmp}; then`,
      `  find ${guard} -prune -type d -mmin +${ABANDONED_GUARD_MINUTES} -exec rmdir {} + 2>/dev/null`,
      `  if mkdir ${guard} 2>/dev/null; then`,
      `    if [ ! -e ${file} ]; then ln ${tmp} ${file} 2>/dev/null && r=${ACQUIRED}`,
      `    elif [ "$(cat ${file} 2>/dev/null)" = ${shellQuote(expected)} ]; then mv -f ${tmp} ${file} && r=${ACQUIRED}`,
      '    fi',
      `    rmdir ${guard}`,
      '  fi',
      'fi',
      `rm -f ${tmp}`,
      'echo "$r"',
    ].join('\n');
  }
}
