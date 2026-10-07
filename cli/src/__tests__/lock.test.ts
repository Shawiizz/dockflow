import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DOCKFLOW_LOCKS_DIR } from '../constants';
import { Lock, type LockData, type LockOptions, type LockShell } from '../services/lock';
import { ErrorCode } from '../utils/errors';
import type { Result, SSHExecResult } from '../types';

const STACK = 'shop-production';
const T0 = Date.parse('2026-09-19T10:00:00.000Z');
const MINUTE = 60_000;
const STALE_TAKEN = 'Lock was stale but another deploy acquired it first';

/** The lock targets Linux managers: its commands run in a real shell, POSIX hosts only. */
const hasPosixShell = process.platform !== 'win32' && ['sh', 'find'].every((tool) => Bun.which(tool) !== null);

interface Call {
  command: string;
  stdin: string | undefined;
}

/** Runs the lock's commands with `sh -c`; `hold` pauses one command to interleave two deploys. */
class LocalShell implements LockShell {
  readonly root = mkdtempSync(join(tmpdir(), 'dockflow-lock-'));
  private readonly holds: { matches: (command: string) => boolean; arrive: () => void; open: Promise<void> }[] = [];

  hold(matches: (command: string) => boolean): { reached: Promise<void>; release: () => void } {
    let arrive = () => {};
    let release = () => {};
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.push({ matches, arrive, open });
    return { reached, release };
  }

  async run(command: string, stdin?: string): Promise<SSHExecResult> {
    const index = this.holds.findIndex((hold) => hold.matches(command));
    if (index >= 0) {
      const [hold] = this.holds.splice(index, 1);
      hold.arrive();
      await hold.open;
    }
    const child = Bun.spawn(['sh', '-c', command], {
      cwd: this.root,
      stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
}

type Reply = Partial<SSHExecResult> | undefined;
type LockCommand = 'read' | 'create' | 'takeover' | 'force' | 'release';

function lockCommand(command: string): LockCommand {
  if (command.startsWith('cat ')) return 'read';
  if (command.includes('.takeover')) return 'takeover';
  if (command.startsWith('rm -f ')) return 'release';
  if (command.includes('\nln ')) return 'create';
  return 'force';
}

/** Answers each kind of lock command, for the server failures no temporary directory can produce. */
function scriptedLock(replies: Partial<Record<LockCommand, Reply>>): { calls: Call[]; lock: Lock } {
  const calls: Call[] = [];
  const shell: LockShell = {
    async run(command, stdin) {
      calls.push({ command, stdin });
      const answer = replies[lockCommand(command)] ?? {};
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode ?? 0 };
    },
  };
  return { calls, lock: new Lock(shell, STACK, { now: () => T0, performer: 'bob@ci' }) };
}

function lockData(performer: string, startedAt: number, message = 'Deploy 1.0.0'): LockData {
  return {
    performer,
    started_at: new Date(startedAt).toISOString(),
    timestamp: Math.floor(startedAt / 1000),
    version: '1.0.0',
    stack: STACK,
    message,
  };
}

function errorOf<T>(result: Result<T, Error>): string {
  if (result.success) throw new Error('expected a failed result');
  return result.error.message;
}

function dataOf<T>(result: Result<T, Error>): T {
  if (!result.success) throw result.error;
  return result.data;
}

describe('Lock on a real shell', () => {
  let shell: LocalShell;
  let clock: number;
  const locksDir = (): string => join(shell.root, 'locks');
  const lockFile = (): string => join(locksDir(), `${STACK}.lock`);
  const locks = (performer: string, options: LockOptions = {}): Lock =>
    new Lock(shell, STACK, { locksDir: locksDir(), now: () => clock, performer, ...options });

  beforeEach(() => {
    shell = new LocalShell();
    clock = T0;
  });

  afterEach(() => {
    rmSync(shell.root, { recursive: true, force: true });
  });

  test.if(hasPosixShell)('acquire on a free lock writes it; status reports its age', async () => {
    const lock = locks('alice@ci');
    expect(dataOf(await lock.status())).toEqual({ locked: false });

    const data = dataOf(await lock.acquire({ message: 'Deploy 1.0.0', version: '1.0.0' }));
    expect(data).toEqual(lockData('alice@ci', T0));
    expect(readFileSync(lockFile(), 'utf8')).toBe(JSON.stringify(data, null, 2));
    expect(readdirSync(locksDir())).toEqual([`${STACK}.lock`]);

    clock = T0 + 12 * MINUTE;
    expect(dataOf(await locks('bob@ci').status())).toEqual({ locked: true, data, durationMinutes: 12, isStale: false });
    clock = T0 + 31 * MINUTE;
    expect(dataOf(await lock.status())).toMatchObject({ durationMinutes: 31, isStale: true });
  });

  test.if(hasPosixShell)('a second acquire fails while the lock is held, and leaves it intact', async () => {
    const held = dataOf(await locks('alice@ci').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' }));
    clock = T0 + 5 * MINUTE;

    expect(errorOf(await locks('bob@ci').acquire())).toBe('Already locked by alice@ci (5 min ago)');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(held);
    expect(readdirSync(locksDir())).toEqual([`${STACK}.lock`]);
  });

  test.if(hasPosixShell)('two concurrent acquires on a free lock: exactly one wins', async () => {
    const results = await Promise.all([locks('alice@ci').acquire(), locks('bob@ci').acquire()]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(readdirSync(locksDir())).toEqual([`${STACK}.lock`]);
  });

  test.if(hasPosixShell)('a stale lock is taken over, including an unreadable one', async () => {
    await locks('alice@ci').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' });
    clock = T0 + 31 * MINUTE;

    const data = dataOf(await locks('bob@ci').acquire({ message: 'Deploy 1.1.0' }));
    expect(data.performer).toBe('bob@ci');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(data);

    writeFileSync(lockFile(), '{half a lock');
    expect(dataOf(await locks('carol@ci').status())).toEqual({ locked: true, isStale: true });
    expect(dataOf(await locks('carol@ci').acquire()).performer).toBe('carol@ci');
    expect(readdirSync(locksDir())).toEqual([`${STACK}.lock`]);
  });

  test.if(hasPosixShell)('force replaces a live lock, or creates a missing one', async () => {
    await locks('alice@ci').acquire();
    const data = dataOf(await locks('bob@ci').acquire({ force: true, message: 'Hotfix' }));
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(data);

    rmSync(locksDir(), { recursive: true });
    expect(dataOf(await locks('carol@ci').acquire({ force: true })).performer).toBe('carol@ci');
    expect(readdirSync(locksDir())).toEqual([`${STACK}.lock`]);
  });

  test.if(hasPosixShell)('release twice is ok and removes the lock file', async () => {
    const lock = locks('alice@ci');
    await lock.acquire();
    expect(dataOf(await lock.release())).toBeUndefined();
    expect(existsSync(lockFile())).toBe(false);
    expect(dataOf(await lock.release())).toBeUndefined();
    expect(dataOf(await lock.acquire()).performer).toBe('alice@ci');
  });

  for (const [late, early] of [
    ['bob@ci', 'carol@ci'],
    ['carol@ci', 'bob@ci'],
  ] as const) {
    test.if(hasPosixShell)(`two deploys taking over the same stale lock, ${late} last: one wins, the loser deletes nothing`, async () => {
      await locks('alice@ci').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' });
      clock = T0 + 45 * MINUTE;

      // `late` has read the stale lock and is about to swap it when `early` takes it over
      const held = shell.hold((command) => command.includes('.takeover'));
      const lateResult = locks(late).acquire({ message: 'late' });
      await held.reached;
      const earlyData = dataOf(await locks(early).acquire({ message: 'early' }));
      held.release();

      expect(errorOf(await lateResult)).toBe(STALE_TAKEN);
      expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(earlyData);
      expect(readdirSync(locksDir())).toEqual([`${STACK}.lock`]);
    });
  }

  test.if(hasPosixShell)('a lock released between the read and the takeover is simply created', async () => {
    await locks('alice@ci').acquire();
    clock = T0 + 45 * MINUTE;
    const held = shell.hold((command) => command.includes('.takeover'));
    const pending = locks('bob@ci').acquire();
    await held.reached;
    dataOf(await locks('alice@ci').release());
    held.release();

    expect(dataOf(await pending).performer).toBe('bob@ci');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).performer).toBe('bob@ci');
  });

  test.if(hasPosixShell)('a takeover guard left by a killed process expires', async () => {
    await locks('alice@ci').acquire();
    clock = T0 + 45 * MINUTE;
    const guard = `${lockFile()}.takeover`;
    mkdirSync(guard);
    expect(errorOf(await locks('bob@ci').acquire())).toBe(STALE_TAKEN);

    const old = new Date(Date.now() - 5 * MINUTE);
    utimesSync(guard, old, old);
    expect(dataOf(await locks('bob@ci').acquire()).performer).toBe('bob@ci');
    expect(existsSync(guard)).toBe(false);
  });
});

describe('Lock when the server refuses', () => {
  const file = `${DOCKFLOW_LOCKS_DIR}/${STACK}.lock`;
  const denied = `mkdir: cannot create directory '${DOCKFLOW_LOCKS_DIR}': Permission denied`;

  test('a held lock names its holder', async () => {
    const alice = JSON.stringify(lockData('alice@ci', T0 - 5 * MINUTE), null, 2);
    const { lock } = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: alice } });
    expect(errorOf(await lock.acquire())).toBe('Already locked by alice@ci (5 min ago)');
  });

  test('a write that failed is reported with its cause, not as a held lock', async () => {
    const { calls, lock } = scriptedLock({ create: { stderr: `${denied}\n`, exitCode: 1 } });
    expect(errorOf(await lock.acquire())).toBe(`Cannot write the lock file in ${DOCKFLOW_LOCKS_DIR}: ${denied}`);
    expect(calls.map((call) => lockCommand(call.command))).toEqual(['create']);
  });

  test('a lock that cannot be linked although none exists blames the directory permissions', async () => {
    const { calls, lock } = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: 'NO_LOCK\n' } });
    expect(errorOf(await lock.acquire())).toBe(`Cannot create lock file at ${file}. Check directory permissions on the server.`);
    expect(calls.map((call) => lockCommand(call.command))).toEqual(['create', 'read', 'create', 'read']);
  });

  test('a stale takeover swaps only the content that was read', async () => {
    const stale = JSON.stringify(lockData('alice@ci', T0 - 45 * MINUTE), null, 2);
    const lost = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: stale }, takeover: { stdout: 'LOCKED\n' } });
    expect(errorOf(await lost.lock.acquire())).toBe(STALE_TAKEN);
    const takeover = lost.calls.find((call) => lockCommand(call.command) === 'takeover');
    expect(takeover?.command).toContain(`= '${stale}' ]`);
    expect(JSON.parse(takeover?.stdin ?? '').performer).toBe('bob@ci');

    const won = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: stale }, takeover: { stdout: 'ACQUIRED\n' } });
    expect(dataOf(await won.lock.acquire()).performer).toBe('bob@ci');
  });

  test('a forced lock whose file could not be written fails with the cause', async () => {
    const { lock } = scriptedLock({ force: { stderr: 'No space left on device\n', exitCode: 1 } });
    expect(errorOf(await lock.acquire({ force: true }))).toBe(`Cannot write the lock file in ${DOCKFLOW_LOCKS_DIR}: No space left on device`);
  });

  test('a lock file that survives rm is reported', async () => {
    const { calls, lock } = scriptedLock({ release: { stdout: 'EXISTS\n' } });
    expect(errorOf(await lock.release())).toBe('Lock file could not be removed. Check permissions on the server.');
    expect(calls[0]?.command).toBe(`rm -f '${file}'; test -f '${file}' && echo EXISTS || echo REMOVED`);
  });

  test('unparseable content reads as a stale lock', async () => {
    const { lock } = scriptedLock({ read: { stdout: 'not json' } });
    expect(dataOf(await lock.status())).toEqual({ locked: true, isStale: true });
  });

  test('only another holder is DEPLOY_LOCKED: a server that fails is not a lock to wait for', async () => {
    const alice = JSON.stringify(lockData('alice@ci', T0 - 5 * MINUTE), null, 2);
    const held = await scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: alice } }).lock.acquire();
    expect(held.success ? null : held.error.code).toBe(ErrorCode.DEPLOY_LOCKED);

    const denied = await scriptedLock({ create: { stderr: 'Permission denied\n', exitCode: 1 } }).lock.acquire();
    expect(denied.success ? null : denied.error.code).toBe(ErrorCode.COMMAND_FAILED);

    const down = await new Lock({ run: () => Promise.reject(new Error('connect ETIMEDOUT')) }, STACK).acquire();
    expect(down.success ? null : down.error.code).toBe(ErrorCode.CONNECTION_FAILED);
  });

  test('transport failures become failed results', async () => {
    const broken = new Lock({ run: () => Promise.reject(new Error('connection reset')) }, STACK, { performer: 'bob@ci' });
    expect(errorOf(await broken.status())).toBe('connection reset');
    expect(errorOf(await broken.acquire())).toBe('connection reset');
    expect(errorOf(await broken.release())).toBe('connection reset');
  });
});
