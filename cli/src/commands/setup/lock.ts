/**
 * The setup lock: two `dockflow setup` runs on one server would both install packages, rewrite the
 * deploy user's sudoers file and restart Docker. The run on the server takes a lock file, so a run
 * started by hand and one started over SSH exclude each other.
 *
 * - acquire: the lock file appears through `link` of a complete temporary file, which fails when
 *   the file exists, so two runs never both create it and nobody reads a half-written lock.
 * - stale: a holder whose process is gone, or whose pid now belongs to another process (its start
 *   time in /proc differs), left the lock behind. It is replaced only when it still holds the stale
 *   content that was read, under a short-lived guard directory, so of two runs that saw the same
 *   stale lock exactly one wins and the loser never removes the winner's lock.
 * - release: only a lock that still holds this run's content is removed; the lock also goes when
 *   the process exits, whatever the reason.
 */

import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { CLIError, ErrorCode } from '../../utils/errors';
import { printWarning } from '../../utils/output';

export const SETUP_LOCK_PATH = '/run/lock/dockflow-setup.lock';

/** a takeover guard older than this was left by a killed process (the guarded step takes milliseconds) */
const GUARD_ABANDONED_MS = 60_000;
const RETRY_DELAY_MS = 50;
const MAX_ATTEMPTS = 200;

interface Holder {
  pid: number;
  /** start time of the process in /proc, which tells a reused pid from the process that took the lock */
  start: string | null;
  startedAt: string;
}

export interface SetupLock {
  release(): void;
}

/** Field 22 of /proc/<pid>/stat, or null when the process does not exist. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // the command name may hold spaces and parentheses: the fields start after its last one
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function parseHolder(content: string): Holder | null {
  try {
    const data: unknown = JSON.parse(content);
    if (typeof data !== 'object' || data === null) return null;
    const { pid, start, startedAt } = data as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, start: typeof start === 'string' ? start : null, startedAt: typeof startedAt === 'string' ? startedAt : '' };
  } catch {
    return null;
  }
}

function isRunning(holder: Holder): boolean {
  const start = processStart(holder.pid);
  return start !== null && (holder.start === null || holder.start === start);
}

function readLock(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/** Replaces the stale lock `stale` with the file at `tmp`, unless another run already did. */
function takeOver(path: string, stale: string, tmp: string): boolean {
  const guard = `${path}.guard`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
    const age = Date.now() - (statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age > GUARD_ABANDONED_MS) rmSync(guard, { recursive: true, force: true });
    return false;
  }
  try {
    if (readLock(path) !== stale) return false;
    renameSync(tmp, path);
    return true;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

function heldBy(holder: Holder, path: string): CLIError {
  const since = holder.startedAt ? ` since ${holder.startedAt}` : '';
  return new CLIError(
    `Another dockflow setup is already running on this server (pid ${holder.pid}${since})`,
    ErrorCode.COMMAND_FAILED,
    `Wait for it to finish, then run setup again. If no setup is running, remove ${path}.`,
  );
}

function handleFor(path: string, content: string): SetupLock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      if (readLock(path) === content) unlinkSync(path);
    } catch {
      // the lock is gone or unreadable: nothing of ours is left to remove
    }
  };
  process.on('exit', release);
  return { release };
}

/** Takes the setup lock, or fails naming the setup that holds it. */
export async function acquireSetupLock(path: string = SETUP_LOCK_PATH): Promise<SetupLock> {
  mkdirSync(dirname(path), { recursive: true });
  const holder: Holder = { pid: process.pid, start: processStart(process.pid), startedAt: new Date().toISOString() };
  const content = JSON.stringify(holder);
  const tmp = `${path}.${process.pid}.tmp`;

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      writeFileSync(tmp, content, { flag: 'w' });
      try {
        linkSync(tmp, path);
        return handleFor(path, content);
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
      }

      const current = readLock(path);
      if (current !== null) {
        const held = parseHolder(current);
        if (held !== null && isRunning(held)) throw heldBy(held, path);
        if (takeOver(path, current, tmp)) {
          printWarning(
            held ? `A previous dockflow setup (pid ${held.pid}) ended without releasing its lock; taking it over` : 'The setup lock was unreadable; taking it over',
          );
          return handleFor(path, content);
        }
      }
      await Bun.sleep(RETRY_DELAY_MS);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  throw new CLIError(`Could not take the setup lock ${path}`, ErrorCode.COMMAND_FAILED, 'Run setup again.');
}
