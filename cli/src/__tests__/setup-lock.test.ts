import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireSetupLock, processStart } from '../commands/setup/lock';
import type { CLIError } from '../utils/errors';

// The lock lives in /proc terms and is contended by separate processes: these tests need Linux.
const linux = process.platform === 'linux';

const LOCK_MODULE = join(import.meta.dir, '..', 'commands', 'setup', 'lock.ts');

describe.skipIf(!linux)('the setup lock', () => {
  let dir = '';
  let lockPath = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-setup-lock-'));
    lockPath = join(dir, 'setup.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A pid that no process has any more */
  async function deadPid(): Promise<number> {
    const child = Bun.spawn(['true']);
    await child.exited;
    return child.pid;
  }

  const holderFile = (holder: object) => writeFileSync(lockPath, JSON.stringify(holder));

  /** Runs `body` in its own process, after taking the lock; prints what happened on one line */
  function child(body: string, name = 'child') {
    const script = join(dir, `${name}.ts`);
    writeFileSync(
      script,
      `import { acquireSetupLock } from ${JSON.stringify(LOCK_MODULE)};
const lockPath = ${JSON.stringify(lockPath)};
${body}`,
    );
    return Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  }

  const outputOf = async (proc: ReturnType<typeof child>) => (await new Response(proc.stdout).text()).trim();

  const contender = (holdMs: number, name: string) =>
    child(
      `try {
  const lock = await acquireSetupLock(lockPath);
  console.log('ACQUIRED');
  await Bun.sleep(${holdMs});
  lock.release();
} catch (error) {
  console.log('REFUSED ' + (error as Error).message);
}`,
      name,
    );

  it('refuses a second setup while the first runs, naming it', async () => {
    const lock = await acquireSetupLock(lockPath);
    const error = (await acquireSetupLock(lockPath).catch((e: unknown) => e)) as CLIError;
    expect(error.message).toContain(`Another dockflow setup is already running on this server (pid ${process.pid}`);
    expect(error.suggestion).toContain(lockPath);
    lock.release();
  });

  it('can be taken again once released, and releasing twice is harmless', async () => {
    const first = await acquireSetupLock(lockPath);
    first.release();
    first.release();
    expect(existsSync(lockPath)).toBe(false);
    const second = await acquireSetupLock(lockPath);
    second.release();
  });

  it('does not remove a lock another run took over', async () => {
    const first = await acquireSetupLock(lockPath);
    const other = { pid: process.pid, start: processStart(process.pid), startedAt: 'another run' };
    holderFile(other);
    first.release();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(other);
  });

  it('leaves nothing but the lock behind', async () => {
    const lock = await acquireSetupLock(lockPath);
    expect(readdirSync(dir)).toEqual(['setup.lock']);
    lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('takes over the lock of a process that is gone', async () => {
    holderFile({ pid: await deadPid(), start: '12345', startedAt: 'earlier' });
    const lock = await acquireSetupLock(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    expect(readdirSync(dir)).toEqual(['setup.lock']);
    lock.release();
  });

  it('takes over a lock whose pid now belongs to another process', async () => {
    holderFile({ pid: process.pid, start: 'not-the-start-time', startedAt: 'earlier' });
    const lock = await acquireSetupLock(lockPath);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock that cannot be read', async () => {
    writeFileSync(lockPath, 'half a');
    const lock = await acquireSetupLock(lockPath);
    lock.release();
  });

  it('reads the start time of a real process', async () => {
    const sleeper = Bun.spawn(['sleep', '5']);
    try {
      expect(processStart(sleeper.pid)).toMatch(/^\d+$/);
      expect(processStart(sleeper.pid)).toBe(processStart(sleeper.pid));
    } finally {
      sleeper.kill();
      await sleeper.exited;
    }
    expect(processStart(sleeper.pid)).toBeNull();
  });

  it('lets exactly one of several simultaneous runs through, and tells the others why', async () => {
    const runs = Array.from({ length: 8 }, (_, i) => contender(1500, `run${i}`));
    const outputs = await Promise.all(runs.map(outputOf));
    expect(outputs.filter((line) => line === 'ACQUIRED')).toHaveLength(1);
    const refused = outputs.filter((line) => line.startsWith('REFUSED'));
    expect(refused).toHaveLength(7);
    for (const line of refused) expect(line).toContain('Another dockflow setup is already running on this server');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('lets exactly one of several simultaneous runs take over the same stale lock', async () => {
    holderFile({ pid: await deadPid(), start: '12345', startedAt: 'earlier' });
    const runs = Array.from({ length: 8 }, (_, i) => contender(1500, `stale${i}`));
    const outputs = await Promise.all(runs.map(outputOf));
    expect(outputs.filter((line) => line === 'ACQUIRED')).toHaveLength(1);
    expect(outputs.filter((line) => line.startsWith('REFUSED'))).toHaveLength(7);
    expect(readdirSync(dir).filter((name) => name.startsWith('setup.lock'))).toEqual([]);
  });

  it('is released when the process ends without releasing it', async () => {
    const proc = child(`await acquireSetupLock(lockPath);\nconsole.log('HELD');`, 'exits');
    expect(await outputOf(proc)).toBe('HELD');
    await proc.exited;
    expect(existsSync(lockPath)).toBe(false);
  });

  it('is taken over after the process holding it was killed', async () => {
    const proc = child(`await acquireSetupLock(lockPath);\nconsole.log('HELD');\nawait Bun.sleep(60000);`, 'killed');
    const reader = proc.stdout.getReader();
    await reader.read();
    expect(existsSync(lockPath)).toBe(true);

    expect(await acquireSetupLock(lockPath).catch((e: unknown) => (e as Error).message)).toContain(`pid ${proc.pid}`);

    proc.kill('SIGKILL');
    await proc.exited;
    expect(existsSync(lockPath)).toBe(true);
    const lock = await acquireSetupLock(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    lock.release();
  });
});
