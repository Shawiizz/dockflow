/**
 * Lock — the deployment lock of a stack: one JSON file per stack on the manager.
 *
 * - acquire: the lock file appears through `ln` of a complete temporary file, which fails when the
 *   file exists, so two deploys never both create it and nobody reads a half-written lock.
 * - stale takeover: a compare-and-swap. Under a short-lived guard directory the file is replaced
 *   only when it still holds the stale content that was read, so of two deploys that both saw the
 *   same stale lock exactly one wins, and the loser never removes the winner's lock.
 * - release by the holder: the same compare under the guard, so a deploy whose lock was taken over
 *   leaves the new holder's lock in place.
 *
 * Used by both CLI lock commands and API lock routes.
 */

import { randomBytes } from 'crypto';
import type { SSHExecResult, SSHKeyConnection } from '../types';
import { shellQuote } from '../utils/ssh';
import { sshShell, type RemoteShell } from '../utils/remote-shell';
import { ok, err, type Result } from '../types';
import { DOCKFLOW_LOCKS_DIR } from '../constants';
import { LOCK_STALE_THRESHOLD_MINUTES } from '../constants';
import { getPerformer } from '../utils/config';
import { printDebug, printWarning } from '../utils/output';
import { CLIError, ErrorCode } from '../utils/errors';

/**
 * Lock information stored in the lock file
 */
export interface LockData {
  performer: string;
  started_at: string;
  timestamp: number;
  version: string;
  stack: string;
  message?: string;
}

/**
 * Lock status with computed fields
 */
export interface LockStatus {
  locked: boolean;
  data?: LockData;
  durationMinutes?: number;
  isStale?: boolean;
}


export interface LockOptions {
  staleThresholdMinutes?: number;
  /** replaces DOCKFLOW_LOCKS_DIR */
  locksDir?: string;
  /** epoch milliseconds */
  now?: () => number;
  /** `LockData.performer`; defaults to `user@host` of this machine */
  performer?: string;
}

const ACQUIRED = 'ACQUIRED';
const TAKEN = 'TAKEN';
const STALE_TAKEN = 'Lock was stale but another deploy acquired it first';
/** a takeover guard older than this was left by a killed process (the guarded step takes milliseconds) */
const ABANDONED_GUARD_MINUTES = 1;

interface LockRead {
  status: LockStatus;
  /** file content as read (trailing newlines dropped), the expected value of a stale takeover */
  content: string | null;
}

/** Another deploy holds the lock: the one failure a CI retry loop should wait on. */
export class LockHeldError extends CLIError {
  constructor(message: string) {
    super(message, ErrorCode.DEPLOY_LOCKED);
    this.name = 'LockHeldError';
  }
}

/** Anything thrown while talking to the server: it did not answer, which is not a held lock. */
function toError(error: unknown): CLIError {
  return CLIError.from(error, ErrorCode.CONNECTION_FAILED);
}


/** A stale takeover is worth saying: the holder's deploy most likely died without releasing it. */
export function staleTakeoverMessage(holder: LockData | null, minutes: number | null): string {
  if (holder === null) return 'Lock could not be read and is treated as stale; taking it over';
  const age = minutes === null || !Number.isFinite(minutes) ? '' : ` (${minutes} min old)`;
  return `Lock of ${holder.performer}${age} is stale; taking it over`;
}

/**
 * Lock — manages deployment locks for a single stack on a remote server.
 */
export class Lock {
  private readonly locksDir: string;
  private readonly lockFile: string;
  private readonly staleThresholdMinutes: number;
  private readonly now: () => number;
  /** the content this instance wrote, while it holds the lock */
  private held: string | null = null;

  constructor(
    private readonly shell: RemoteShell,
    private readonly stackName: string,
    private readonly options: LockOptions = {},
  ) {
    this.locksDir = (options.locksDir ?? DOCKFLOW_LOCKS_DIR).replace(/\/+$/, '');
    this.lockFile = `${this.locksDir}/${stackName}.lock`;
    this.staleThresholdMinutes = options.staleThresholdMinutes ?? LOCK_STALE_THRESHOLD_MINUTES;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<Result<LockStatus, CLIError>> {
    try {
      return ok((await this.read()).status);
    } catch (error) {
      return err(toError(error));
    }
  }

  async acquire(options?: { message?: string; force?: boolean; version?: string }): Promise<Result<LockData, CLIError>> {
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

      const acquired = (): Result<LockData, CLIError> => {
        this.held = content;
        return ok(lockData);
      };

      if (options?.force) {
        const forced = await this.shell.run(this.forceCommand(), content);
        return forced.exitCode === 0 ? acquired() : err(this.writeFailed(forced));
      }

      const created = await this.tryCreate(content);
      if (created instanceof Error) return err(created);
      if (created) return acquired();

      let current = await this.read();
      if (!current.status.locked) {
        // released between the create attempt and the read: one more attempt before blaming permissions
        const retried = await this.tryCreate(content);
        if (retried instanceof Error) return err(retried);
        if (retried) return acquired();
        current = await this.read();
        if (!current.status.locked) return err(this.cannotCreate());
      }

      if (current.status.isStale) {
        const takeover = await this.shell.run(this.takeoverCommand(current.content ?? ''), content);
        if (takeover.stdout.trim() !== ACQUIRED) return err(new LockHeldError(STALE_TAKEN));
        printWarning(staleTakeoverMessage(current.status.data ?? null, current.status.durationMinutes ?? null));
        return acquired();
      }

      return err(
        new LockHeldError(
          current.status.data
            ? `Already locked by ${current.status.data.performer} (${current.status.durationMinutes} min ago)`
            : 'Lock file exists but could not be parsed',
        ),
      );
    } catch (error) {
      return err(toError(error));
    }
  }

  /** The holder removes only its own lock; any other instance (`dockflow lock release`) removes whatever is there. */
  async release(): Promise<Result<void, CLIError>> {
    try {
      const file = shellQuote(this.lockFile);
      const command = this.held === null
        ? `rm -f ${file}; test -f ${file} && echo EXISTS || echo REMOVED`
        : this.ownReleaseCommand(this.held);
      const outcome = (await this.shell.run(command)).stdout.trim();
      if (outcome === 'EXISTS') {
        return err(new CLIError('Lock file could not be removed. Check permissions on the server.', ErrorCode.COMMAND_FAILED));
      }
      this.held = null;
      if (outcome === TAKEN) printWarning('Another deploy took the lock over in the meantime; it is left in place');
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

  private cannotCreate(): CLIError {
    return new CLIError(`Cannot create lock file at ${this.lockFile}. Check directory permissions on the server.`, ErrorCode.COMMAND_FAILED);
  }

  /** The locks directory appears on a server's first deploy: the exit code of the write is the only sign it failed. */
  private writeFailed(result: SSHExecResult): CLIError {
    const cause = result.stderr.trim();
    return new CLIError(`Cannot write the lock file in ${this.locksDir}${cause ? `: ${cause}` : ''}`, ErrorCode.COMMAND_FAILED);
  }

  /** `ln` refuses an existing target: the create-if-absent step, with the content already complete. */
  private async tryCreate(content: string): Promise<boolean | CLIError> {
    const tmp = shellQuote(this.tempFile());
    const result = await this.shell.run(
      [
        `mkdir -p ${shellQuote(this.locksDir)} && cat > ${tmp} || { rm -f ${tmp}; exit 1; }`,
        `ln ${tmp} ${shellQuote(this.lockFile)} 2>/dev/null && r=${ACQUIRED} || r=LOCKED`,
        `rm -f ${tmp}`,
        'echo "$r"',
      ].join('\n'),
      content,
    );
    if (result.exitCode !== 0) return this.writeFailed(result);
    return result.stdout.trim() === ACQUIRED;
  }

  private forceCommand(): string {
    const tmp = shellQuote(this.tempFile());
    return `mkdir -p ${shellQuote(this.locksDir)} && cat > ${tmp} && mv -f ${tmp} ${shellQuote(this.lockFile)} || { rm -f ${tmp}; exit 1; }`;
  }

  /**
   * Replaces the lock only if it still holds `expected`. A lock that disappeared in the meantime
   * is created instead.
   */
  private ownReleaseCommand(own: string): string {
    const file = shellQuote(this.lockFile);
    const guard = shellQuote(`${this.lockFile}.takeover`);
    return [
      `r=${TAKEN}`,
      `find ${guard} -prune -type d -mmin +${ABANDONED_GUARD_MINUTES} -exec rmdir {} + 2>/dev/null`,
      `if [ ! -e ${file} ]; then r=REMOVED`,
      `elif mkdir ${guard} 2>/dev/null; then`,
      `  if [ "$(cat ${file} 2>/dev/null)" = ${shellQuote(own)} ]; then`,
      `    rm -f ${file}; if [ -e ${file} ]; then r=EXISTS; else r=REMOVED; fi`,
      '  fi',
      `  rmdir ${guard}`,
      'fi',
      'echo "$r"',
    ].join('\n');
  }

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

/**
 * Factory function to create a Lock instance
 */
export function createLock(
  connection: SSHKeyConnection,
  stackName: string,
  staleThresholdMinutes?: number,
): Lock {
  return new Lock(sshShell(connection), stackName, { staleThresholdMinutes });
}
