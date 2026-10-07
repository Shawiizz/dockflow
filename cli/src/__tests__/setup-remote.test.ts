import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { isDevVersion } from '../commands/setup/forward';
import { DOCKFLOW_VERSION } from '../constants';
import type { ConnectionInfo, SSHExecResult } from '../types';

type Responder = (command: string) => Partial<SSHExecResult> | undefined;

let scripted = false;
let respond: Responder = () => undefined;
let interactiveExit = 0;
const executed: string[] = [];
const interactive: string[] = [];

const answer = (partial: Partial<SSHExecResult> | undefined): SSHExecResult => ({ stdout: '', stderr: '', exitCode: 0, ...partial });

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (...args: Parameters<typeof realSsh.sshExec>) => {
    if (!scripted) return realSsh.sshExec(...args);
    executed.push(args[1]);
    return answer(respond(args[1]));
  },
  executeInteractiveSSH: async (...args: Parameters<typeof realSsh.executeInteractiveSSH>) => {
    if (!scripted) return realSsh.executeInteractiveSSH(...args);
    interactive.push(args[1]);
    return interactiveExit;
  },
}));

const { cleanupTempDir, detectRemoteArch, makeTempDir, runRemoteSetup } = await import('../commands/setup/remote');

const CONN: ConnectionInfo = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key' };
const DIR = '/tmp/dockflow-setup.AbC123xy';

beforeEach(() => {
  scripted = true;
  respond = () => undefined;
  interactiveExit = 0;
  executed.length = 0;
  interactive.length = 0;
});

describe('detectRemoteArch', () => {
  it('maps the supported machines', async () => {
    respond = () => ({ stdout: 'aarch64\n' });
    expect(await detectRemoteArch(CONN)).toBe('arm64');
    respond = () => ({ stdout: 'x86_64\n' });
    expect(await detectRemoteArch(CONN)).toBe('x64');
  });

  it('refuses any other machine, naming it and the host', async () => {
    respond = () => ({ stdout: 'armv7l\n' });
    const error = await detectRemoteArch(CONN).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ConnectionError', message: 'Unsupported architecture armv7l on server.example.com' });
    expect((error as { suggestion: string }).suggestion).toContain('amd64');
  });

  it('refuses when uname fails', async () => {
    respond = () => ({ exitCode: 127, stderr: 'uname: not found' });
    await expect(detectRemoteArch(CONN)).rejects.toThrow('Unsupported architecture unknown');
  });
});

describe('makeTempDir and cleanupTempDir', () => {
  it('returns the directory mktemp printed', async () => {
    respond = () => ({ stdout: `${DIR}\n` });
    expect(await makeTempDir(CONN)).toBe(DIR);
    expect(executed).toEqual(['mktemp -d "${TMPDIR:-/tmp}/dockflow-setup.XXXXXXXX"']);
  });

  it('fails with mktemp\'s own message instead of falling back to a shared path', async () => {
    respond = () => ({ exitCode: 1, stderr: 'mktemp: failed to create directory via template: Permission denied\n' });
    const error = await makeTempDir(CONN).catch((e: unknown) => e);
    expect((error as Error).message).toContain('Could not create a temporary directory on server.example.com');
    expect((error as Error).message).toContain('Permission denied');
  });

  it('fails on an answer that is not one absolute path', async () => {
    respond = () => ({ stdout: '' });
    await expect(makeTempDir(CONN)).rejects.toThrow('Could not create a temporary directory');
  });

  it('removes the directory with a quoted rm -rf, and never throws', async () => {
    await cleanupTempDir(CONN, "/tmp/we ird'dir");
    expect(executed).toEqual(["rm -rf -- '/tmp/we ird'\\''dir'"]);
    respond = () => {
      throw new Error('connection lost');
    };
    await expect(cleanupTempDir(CONN, DIR)).resolves.toBeUndefined();
  });
});

describe('runRemoteSetup in release mode', () => {
  const OPTS = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key', forwardFlags: ["--host 'server.example.com'"] };

  const serverAnswers: Responder = (command) => {
    if (command === 'echo ok') return { stdout: 'ok\n' };
    if (command === 'uname -m') return { stdout: 'x86_64\n' };
    if (command.startsWith('mktemp')) return { stdout: `${DIR}\n` };
    if (command.endsWith('--version')) return { stdout: `${DOCKFLOW_VERSION}\n` };
    return undefined;
  };

  it('downloads into the private directory, runs the binary from it and removes the directory', async () => {
    respond = serverAnswers;
    await runRemoteSetup(OPTS);
    const download = executed.find((command) => command.includes('curl'));
    expect(download).toContain(`f='${DIR}/dockflow'`);
    expect(executed).toContain(`'${DIR}/dockflow' --version`);
    expect(interactive).toEqual([`sudo '${DIR}/dockflow' setup --host 'server.example.com'`]);
    expect(executed.at(-1)).toBe(`rm -rf -- '${DIR}'`);
    expect(executed.join('\n')).not.toContain('/tmp/dockflow ');
  });

  it('removes the directory when setup fails on the server, and reports the exit code', async () => {
    respond = serverAnswers;
    interactiveExit = 3;
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('Setup failed on server.example.com (exit code 3)');
    expect(executed.at(-1)).toBe(`rm -rf -- '${DIR}'`);
  });

  it('removes the directory when the download fails', async () => {
    respond = (command) => (command.includes('curl') ? { exitCode: 22, stderr: 'curl: (22) 404' } : serverAnswers(command));
    await runRemoteSetup(OPTS);
    expect(interactive).toEqual([]);
    expect(executed.at(-1)).toBe(`rm -rf -- '${DIR}'`);
  });

  // a development CLI downloads the latest release, so there is no version to compare with
  it.skipIf(isDevVersion(DOCKFLOW_VERSION))('removes the directory and runs nothing when the binary reports another version', async () => {
    respond = (command) => (command.endsWith('--version') ? { stdout: '0.1.0\n' } : serverAnswers(command));
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('prints 0.1.0');
    expect(interactive).toEqual([]);
    expect(executed.at(-1)).toBe(`rm -rf -- '${DIR}'`);
  });

  it('refuses an unsupported server before creating anything on it', async () => {
    respond = (command) => (command === 'uname -m' ? { stdout: 'riscv64\n' } : serverAnswers(command));
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('Unsupported architecture riscv64');
    expect(executed.some((command) => command.startsWith('mktemp'))).toBe(false);
  });

  it('runs the binary directly as root', async () => {
    respond = serverAnswers;
    await runRemoteSetup({ ...OPTS, user: 'root' });
    expect(interactive[0].startsWith(`'${DIR}/dockflow' setup`)).toBe(true);
  });
});
