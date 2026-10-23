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
 * - keep-alive: the holder rewrites `renewed_at` with the same compare, so a deploy that runs longer
 *   than the stale threshold is not taken for a dead one.
 *
 * Used by both CLI lock commands and API lock routes.
 */

import { randomBytes } from 'crypto';
import type { SSHExecResult, SSHKeyConnection } from '../types';
import { raw, sh } from '../utils/ssh';
import { sshShell, type RemoteShell } from '../utils/remote-shell';
import { ok, err, type Result } from '../types';
import { DOCKFLOW_LOCKS_DIR } from '../constants';
import { LOCK_STALE_THRESHOLD_MINUTES } from '../constants';
import { getPerformer } from '../utils/config';
import { printDebug, printWarning } from '../utils/output';
import { CLIError, ConnectionError, ErrorCode } from '../utils/errors';
import { sshExec } from '../utils/ssh';
import { getFullConnectionInfo, getManagersForEnvironment } from '../utils/servers';

/** The content of the lock file. */
export interface LockData {
  performer: string;
  started_at: string;
  timestamp: number;
  version: string;
  stack: string;
  message?: string;
  renewed_at?: string;
}

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
const BUSY = 'BUSY';
// the words the lock scripts print and assign to `r`: constants of this file, so they go in as syntax
const R_ACQUIRED = raw(ACQUIRED);
const R_TAKEN = raw(TAKEN);
const R_BUSY = raw(BUSY);
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

export class Lock {
  private readonly locksDir: string;
  private readonly lockFile: string;
  private readonly staleThresholdMinutes: number;
  private readonly now: () => number;
  /** the content this instance wrote, while it holds the lock */
  private held: string | null = null;
  private renewal: { timer: ReturnType<typeof setInterval>; inFlight: Promise<void> | null } | null = null;

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
        const takeover = await this.shell.run(this.swapCommand(current.content ?? '', { createIfMissing: true }), content);
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
    await this.stopKeepAlive();
    try {
      const file = this.lockFile;
      const command = this.held === null
        ? sh`rm -f ${file}; test -f ${file} && echo EXISTS || echo REMOVED`
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

  /** Renews the lock every third of the stale threshold until `release`. */
  keepAlive(): void {
    if (this.held === null || this.renewal) return;
    const renewal: { timer: ReturnType<typeof setInterval>; inFlight: Promise<void> | null } = {
      timer: setInterval(() => {
        renewal.inFlight ??= this.renew().finally(() => {
          renewal.inFlight = null;
        });
      }, (this.staleThresholdMinutes * 60_000) / 3),
      inFlight: null,
    };
    renewal.timer.unref?.();
    this.renewal = renewal;
  }

  /** Marks the held lock as alive now. A lock another deploy took over is left to it, and no longer renewed. */
  async renew(): Promise<void> {
    if (this.held === null) return;
    const renewed = JSON.stringify({ ...(JSON.parse(this.held) as LockData), renewed_at: new Date(this.now()).toISOString() }, null, 2);
    try {
      const outcome = (await this.shell.run(this.swapCommand(this.held, { createIfMissing: false }), renewed)).stdout.trim();
      if (outcome === ACQUIRED) {
        this.held = renewed;
      } else if (outcome !== BUSY) {
        if (this.renewal) clearInterval(this.renewal.timer);
        printWarning('This deploy no longer holds the lock: another deploy took it over, or it was released by hand');
      }
    } catch (error) {
      printDebug(`Lock renewal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async stopKeepAlive(): Promise<void> {
    if (!this.renewal) return;
    clearInterval(this.renewal.timer);
    await this.renewal.inFlight;
    this.renewal = null;
  }

  private async read(): Promise<LockRead> {
    const result = await this.shell.run(sh`cat ${this.lockFile} 2>/dev/null || echo NO_LOCK`);
    const output = result.stdout.trim();
    if (output === 'NO_LOCK' || !output) return { status: { locked: false }, content: null };

    const content = result.stdout.replace(/\n+$/, '');
    try {
      const data = JSON.parse(output) as LockData;
      const minutesSince = (iso: string): number => Math.floor((this.now() - new Date(iso).getTime()) / 60000);
      const durationMinutes = minutesSince(data.started_at);
      const isStale = minutesSince(data.renewed_at ?? data.started_at) > this.staleThresholdMinutes;
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
    const tmp = this.tempFile();
    const result = await this.shell.run(
      [
        sh`mkdir -p ${this.locksDir} && cat > ${tmp} || { rm -f ${tmp}; exit 1; }`,
        sh`ln ${tmp} ${this.lockFile} 2>/dev/null && r=${R_ACQUIRED} || r=LOCKED`,
        sh`rm -f ${tmp}`,
        'echo "$r"',
      ].join('\n'),
      content,
    );
    if (result.exitCode !== 0) return this.writeFailed(result);
    return result.stdout.trim() === ACQUIRED;
  }

  private forceCommand(): string {
    const tmp = this.tempFile();
    return sh`mkdir -p ${this.locksDir} && cat > ${tmp} && mv -f ${tmp} ${this.lockFile} || { rm -f ${tmp}; exit 1; }`;
  }

  private ownReleaseCommand(own: string): string {
    const file = this.lockFile;
    const guard = `${this.lockFile}.takeover`;
    return [
      sh`r=${R_TAKEN}`,
      sh`find ${guard} -prune -type d -mmin +${ABANDONED_GUARD_MINUTES} -exec rmdir {} + 2>/dev/null`,
      sh`if [ ! -e ${file} ]; then r=REMOVED`,
      sh`elif mkdir ${guard} 2>/dev/null; then`,
      sh`  if [ "$(cat ${file} 2>/dev/null)" = ${own} ]; then`,
      sh`    rm -f ${file}; if [ -e ${file} ]; then r=EXISTS; else r=REMOVED; fi`,
      '  fi',
      sh`  rmdir ${guard}`,
      'fi',
      'echo "$r"',
    ].join('\n');
  }

  /**
   * Replaces the lock only if it still holds `expected`; a lock that disappeared in the meantime
   * is created only when `createIfMissing`. Prints ACQUIRED, TAKEN, or BUSY while another swap runs.
   */
  private swapCommand(expected: string, { createIfMissing }: { createIfMissing: boolean }): string {
    const file = this.lockFile;
    const guard = `${this.lockFile}.takeover`;
    const tmp = this.tempFile();
    const create = createIfMissing ? sh`ln ${tmp} ${file} 2>/dev/null && r=${R_ACQUIRED}` : ':';
    return [
      sh`r=${R_BUSY}`,
      sh`if cat > ${tmp}; then`,
      sh`  find ${guard} -prune -type d -mmin +${ABANDONED_GUARD_MINUTES} -exec rmdir {} + 2>/dev/null`,
      sh`  if mkdir ${guard} 2>/dev/null; then`,
      sh`    r=${R_TAKEN}`,
      sh`    if [ ! -e ${file} ]; then ${raw(create)}`,
      sh`    elif [ "$(cat ${file} 2>/dev/null)" = ${expected} ]; then mv -f ${tmp} ${file} && r=${R_ACQUIRED}`,
      '    fi',
      sh`    rmdir ${guard}`,
      '  fi',
      'fi',
      sh`rm -f ${tmp}`,
      'echo "$r"',
    ].join('\n');
  }
}

export function createLock(
  connection: SSHKeyConnection,
  stackName: string,
  staleThresholdMinutes?: number,
): Lock {
  return new Lock(sshShell(connection), stackName, { staleThresholdMinutes });
}

/**
 * The manager that holds an environment's locks: the first of servers.yml that answers. Commands
 * reach Swarm through whichever manager leads, but two of them must meet on one lock file.
 */
export async function lockManager(
  managers: readonly SSHKeyConnection[],
  answers: (connection: SSHKeyConnection) => Promise<boolean> = (connection) => sshExec(connection, 'true').then((r) => r.exitCode === 0, () => false),
): Promise<SSHKeyConnection> {
  if (managers.length === 1) return managers[0];
  for (const connection of managers) {
    if (await answers(connection)) return connection;
  }
  throw new ConnectionError(
    managers.length === 0 ? 'No manager with SSH credentials holds the deploy lock' : 'No manager answers: the deploy lock cannot be reached',
    `Managers tried: ${managers.map((m) => m.host).join(', ') || 'none'}`,
  );
}

/** The deploy lock of `stackName`, on the environment's lock manager. */
export async function createEnvLock(env: string, stackName: string, staleThresholdMinutes?: number): Promise<Lock> {
  const managers = getManagersForEnvironment(env)
    .map((manager) => getFullConnectionInfo(env, manager.name))
    .filter((connection): connection is SSHKeyConnection => connection !== null);
  return createLock(await lockManager(managers), stackName, staleThresholdMinutes);
}
