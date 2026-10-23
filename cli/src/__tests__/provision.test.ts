import { describe, expect, it } from 'bun:test';
import { DOCKFLOW_BASE_DIR, ensureDockflowDir, run, type RunResult } from '../commands/setup/provision';
import { CLIError } from '../utils/errors';

const bun = process.execPath;

describe('run', () => {
  it('captures output, passes stdin and reports the exit code', () => {
    const echoed = run([bun, '-e', 'process.stdin.pipe(process.stdout)'], { quiet: true, input: 'hello' });
    expect(echoed).toMatchObject({ ok: true, exitCode: 0, stdout: 'hello', timedOut: false });
    const failed = run([bun, '-e', 'process.stderr.write("boom"); process.exit(3)'], { quiet: true });
    expect(failed).toMatchObject({ ok: false, exitCode: 3, stderr: 'boom', timedOut: false });
  });

  it('reports a missing binary as 127 and a timeout as 124', () => {
    expect(run(['dockflow-no-such-command-xyz'], { quiet: true })).toMatchObject({ ok: false, exitCode: 127, timedOut: false });
    const slow = run([bun, '-e', 'setTimeout(() => {}, 10000)'], { quiet: true, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, exitCode: 124, timedOut: true });
  });

  it('lets a command print more than the 1 MiB Node allows by default', () => {
    const chatty = run([bun, '-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))'], { quiet: true });
    expect(chatty.ok).toBe(true);
    expect(chatty.stdout.length).toBe(3 * 1024 * 1024);
  });

  it('stops a command that exceeds the maxBuffer it was given', () => {
    const chatty = run([bun, '-e', 'process.stdout.write("x".repeat(100000))'], { quiet: true, maxBuffer: 1000 });
    expect(chatty.ok).toBe(false);
    expect(chatty.stderr).toContain('output larger than 1000 bytes');
  });
});

describe('ensureDockflowDir', () => {
  const result = (ok: boolean, stderr = ''): RunResult => ({ ok, exitCode: ok ? 0 : 1, stdout: '', stderr, timedOut: false });

  it('runs mkdir, chown and chmod by argv: the user name never reaches a shell', () => {
    const calls: string[][] = [];
    ensureDockflowDir("dep'loy; id", (argv) => {
      calls.push([...argv]);
      return result(true);
    });
    expect(calls).toEqual([
      ['mkdir', '-p', '--', DOCKFLOW_BASE_DIR],
      ['chown', '--', "dep'loy; id:dep'loy; id", DOCKFLOW_BASE_DIR],
      ['chmod', '--', '0750', DOCKFLOW_BASE_DIR],
    ]);
  });

  it('stops at the first failing command and reports its output', () => {
    const calls: string[] = [];
    let error: unknown;
    try {
      ensureDockflowDir('ghost', (argv) => {
        calls.push(argv[0]);
        return argv[0] === 'chown' ? result(false, "chown: invalid user: 'ghost:ghost'\n") : result(true);
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).message).toBe("Failed to prepare /var/lib/dockflow: chown: invalid user: 'ghost:ghost'");
    expect(calls).toEqual(['mkdir', 'chown']);
  });
});
