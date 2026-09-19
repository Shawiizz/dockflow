// The seam of every host operation the k3s node step performs as root on its node (design-05 4.0,
// 22.1): processes by argv (never a shell, except the documented `sh <install.sh>`), files, users.
// The real runner reuses provision.ts's `run`; tests use FakeHostRunner.

import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from 'fs';
import { basename, dirname } from 'path';
import { CLIError, ErrorCode } from '../../../utils/errors';
import { run } from '../provision';

export interface HostRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** the command was killed by its timeout */
  timedOut: boolean;
}

export interface HostRunOptions {
  input?: string | Uint8Array;
  /** added to HOST_CHILD_ENV; the caller's own environment never reaches the child */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface HostFileInfo {
  type: 'file' | 'directory' | 'symlink' | 'other';
  /** permission bits only (0o7777) */
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeMs: number;
}

export interface HostWriteOptions {
  mode: number;
  uid?: number;
  gid?: number;
}

export interface HostUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface HostRunner {
  run(argv: readonly string[], options?: HostRunOptions): Promise<HostRunResult>;
  /** null when the file does not exist */
  readFile(path: string): Promise<Buffer | null>;
  /** creates or truncates, then applies mode (and owner when given) whatever the umask */
  writeFile(path: string, data: string | Uint8Array, options: HostWriteOptions): Promise<void>;
  /** O_CREAT|O_EXCL, written and fsynced; false when the path already exists */
  createExclusive(path: string, data: string | Uint8Array, mode: number): Promise<boolean>;
  /** lstat: a symlink is reported as a symlink; null when absent */
  stat(path: string): Promise<HostFileInfo | null>;
  readLink(path: string): Promise<string | null>;
  /** creates missing parents; mode and owner apply to `path` itself */
  mkdir(path: string, options: HostWriteOptions): Promise<void>;
  /** entry names, null when the directory does not exist */
  readDir(path: string): Promise<string[] | null>;
  rename(from: string, to: string): Promise<void>;
  /** a missing path is not an error */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  lookupUser(name: string): Promise<HostUser | null>;
  effectiveUid(): number;
  /** `uname -m` */
  machine(): Promise<string>;
  pid(): number;
}

/** The whole environment of every child (4.0): no K3S_*, no proxy variable ever reaches install.sh. */
export const HOST_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
});

/** Exit code the runners report when the binary does not exist (as a shell would). */
export const COMMAND_NOT_FOUND_EXIT = 127;

/**
 * A host operation of the node step that failed. `logTail` holds redacted output lines the result
 * line carries (NodeStepResult.error.logTail).
 */
export class SetupStepError extends CLIError {
  constructor(
    message: string,
    suggestion: string,
    public readonly logTail: string[] = [],
  ) {
    super(message, ErrorCode.COMMAND_FAILED, suggestion);
    this.name = 'SetupStepError';
  }
}

export function firstLineOf(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

/** last `count` non-empty lines */
export function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function fileType(stats: Stats): HostFileInfo['type'] {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/** `getent passwd` line: name:x:uid:gid:gecos:home:shell */
export function parsePasswdLine(line: string): HostUser | null {
  const fields = line.trim().split(':');
  if (fields.length < 7) return null;
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { name: fields[0], uid, gid, home: fields[5], shell: fields[6] };
}

// Root writes into directories the deploy user owns (~/.ssh, the Helm home): a symlink planted there
// must never redirect a write, chmod or chown to a file of root's choosing. Platforms without
// O_NOFOLLOW (Windows, where only the tests run) take the plain flag.
const WRITE_FLAGS: number | string =
  constants.O_NOFOLLOW === undefined ? 'w' : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

function refuseSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw Object.assign(new Error(`Refusing to follow the symbolic link ${path}`), { code: 'ELOOP' });
  }
}

function applyOwner(path: string, options: HostWriteOptions): void {
  refuseSymlink(path);
  chmodSync(path, options.mode);
  if (options.uid !== undefined || options.gid !== undefined) chownSync(path, options.uid ?? -1, options.gid ?? -1);
}

/** The real runner: local processes and files of the node the step runs on (as root). */
export function createLocalHostRunner(): HostRunner {
  return {
    async run(argv, options = {}) {
      const result = run(argv, {
        quiet: true,
        input: options.input,
        timeoutMs: options.timeoutMs,
        env: { ...HOST_CHILD_ENV, ...options.env },
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
    },
    async readFile(path) {
      try {
        return readFileSync(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    async writeFile(path, data, options) {
      const fd = openSync(path, WRITE_FLAGS, options.mode);
      try {
        writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
        fchmodSync(fd, options.mode);
        if (options.uid !== undefined || options.gid !== undefined) fchownSync(fd, options.uid ?? -1, options.gid ?? -1);
      } finally {
        closeSync(fd);
      }
    },
    async createExclusive(path, data, mode) {
      let fd: number;
      try {
        fd = openSync(path, 'wx', mode);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
      }
      try {
        writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
        fchmodSync(fd, mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    },
    async stat(path) {
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (stats === undefined) return null;
      return {
        type: fileType(stats),
        mode: stats.mode & 0o7777,
        uid: stats.uid,
        gid: stats.gid,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    },
    async readLink(path) {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    },
    async mkdir(path, options) {
      refuseSymlink(path);
      mkdirSync(path, { recursive: true, mode: options.mode });
      applyOwner(path, options);
    },
    async readDir(path) {
      try {
        return readdirSync(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    async rename(from, to) {
      renameSync(from, to);
    },
    async remove(path, options = {}) {
      rmSync(path, { recursive: options.recursive ?? false, force: true });
    },
    async chmod(path, mode) {
      refuseSymlink(path);
      chmodSync(path, mode);
    },
    async chown(path, uid, gid) {
      refuseSymlink(path);
      chownSync(path, uid, gid);
    },
    async lookupUser(name) {
      const result = run(['getent', 'passwd', name], { quiet: true, env: { ...HOST_CHILD_ENV } });
      if (result.exitCode !== 0) return null;
      return parsePasswdLine(result.stdout.split('\n')[0] ?? '');
    },
    effectiveUid() {
      return process.geteuid?.() ?? -1;
    },
    async machine() {
      return run(['uname', '-m'], { quiet: true, env: { ...HOST_CHILD_ENV } }).stdout.trim();
    },
    pid() {
      return process.pid;
    },
  };
}

export const localHostRunner: HostRunner = createLocalHostRunner();

/**
 * Temp file with O_EXCL in the target's directory (a name starting with `.`), owner applied, then
 * an atomic rename (design-05 6.1, 12.2, 13.2): readers never see a partial file.
 */
export async function writeFileAtomic(
  runner: HostRunner,
  path: string,
  data: string | Uint8Array,
  options: HostWriteOptions,
): Promise<void> {
  const tmp = `${dirname(path)}/.${basename(path)}.tmp`;
  if (!(await runner.createExclusive(tmp, data, options.mode))) {
    // left by an interrupted run: only this code writes that name
    await runner.remove(tmp);
    if (!(await runner.createExclusive(tmp, data, options.mode))) {
      throw new SetupStepError(`Could not create ${tmp}`, `Remove ${tmp} and run setup again.`);
    }
  }
  try {
    if (options.uid !== undefined || options.gid !== undefined) await runner.chown(tmp, options.uid ?? -1, options.gid ?? -1);
    await runner.rename(tmp, path);
  } catch (error) {
    await runner.remove(tmp);
    throw error;
  }
}

/** true when `path` holds exactly `data` with that mode and owner (no rewrite needed) */
export async function fileMatches(
  runner: HostRunner,
  path: string,
  data: string | Uint8Array,
  options: HostWriteOptions,
): Promise<boolean> {
  const info = await runner.stat(path);
  if (info === null || info.type !== 'file' || info.mode !== options.mode) return false;
  if (options.uid !== undefined && info.uid !== options.uid) return false;
  if (options.gid !== undefined && info.gid !== options.gid) return false;
  const current = await runner.readFile(path);
  const wanted = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return current !== null && current.equals(wanted);
}

/** Runs a command that must succeed; otherwise a SetupStepError naming it. */
export async function runChecked(
  runner: HostRunner,
  argv: readonly string[],
  failure: { message: (detail: string) => string; suggestion: string },
  options?: HostRunOptions,
): Promise<HostRunResult> {
  const result = await runner.run(argv, options);
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? 'timed out' : firstLineOf(result.stderr) || firstLineOf(result.stdout) || `exit ${result.exitCode}`;
    throw new SetupStepError(failure.message(detail), failure.suggestion);
  }
  return result;
}
