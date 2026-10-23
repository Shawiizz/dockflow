import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { isDevVersion } from '../commands/setup/forward';
import { DOCKFLOW_VERSION } from '../constants';
import type { ConnectionInfo, SSHExecResult } from '../types';

type Responder = (command: string) => Partial<SSHExecResult> | undefined;

let scripted = false;
let respond: Responder = () => undefined;
let interactiveExit = 0;
const executed: string[] = [];
const interactive: string[] = [];
const channels: { command: string; stdin: string }[] = [];
let channelExit = 0;
let presented: string | undefined;

const answer = (partial: Partial<SSHExecResult> | undefined): SSHExecResult => ({ stdout: '', stderr: '', exitCode: 0, ...partial });

const realSsh = await import('../utils/ssh');

const fakeChannel = (entry: { stdin: string }): Awaited<ReturnType<typeof realSsh.sshExecChannel>> =>
  ({
    stream: { end: (data: string) => void (entry.stdin += data) },
    done: Promise.resolve({ exitCode: channelExit, stdout: '', stderr: channelExit === 0 ? '' : 'cat: Permission denied' }),
  }) as unknown as Awaited<ReturnType<typeof realSsh.sshExecChannel>>;
const unmockedSsh = { ...realSsh };
const sshSpies = [
  spyOn(realSsh, 'presentedHostKey').mockImplementation(((...args: Parameters<typeof unmockedSsh.presentedHostKey>) => (scripted ? presented : unmockedSsh.presentedHostKey(...args))) as never),
  spyOn(realSsh, 'sshExec').mockImplementation((async (...args: Parameters<typeof unmockedSsh.sshExec>) => {
    if (!scripted) return unmockedSsh.sshExec(...args);
    executed.push(args[1]);
    return answer(respond(args[1]));
  }) as never),
  spyOn(realSsh, 'sshExecChannel').mockImplementation((async (...args: Parameters<typeof unmockedSsh.sshExecChannel>) => {
    if (!scripted) return unmockedSsh.sshExecChannel(...args);
    const entry = { command: args[1], stdin: '' };
    channels.push(entry);
    return fakeChannel(entry);
  }) as never),
  spyOn(realSsh, 'executeInteractiveSSH').mockImplementation((async (...args: Parameters<typeof unmockedSsh.executeInteractiveSSH>) => {
    if (!scripted) return unmockedSsh.executeInteractiveSSH(...args);
    interactive.push(args[1]);
    return interactiveExit;
  }) as never),
];
afterAll(() => {
  for (const spy of sshSpies) spy.mockRestore();
});

const { cleanupTempDir, connectionFailureMessage, detectRemoteArch, makeTempDir, runRemoteSetup, writePasswordFile } = await import('../commands/setup/remote');

const CONN: ConnectionInfo = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key' };
const DIR = '/tmp/dockflow-setup.AbC123xy';

beforeEach(() => {
  scripted = true;
  respond = () => undefined;
  interactiveExit = 0;
  executed.length = 0;
  interactive.length = 0;
  channels.length = 0;
  channelExit = 0;
  presented = undefined;
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
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('Could not download the Dockflow binary on server.example.com: curl: (22) 404');
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

  it('pins the host key seen on the first connection into the setup it runs', async () => {
    respond = serverAnswers;
    presented = 'SHA256:' + 'a'.repeat(43);
    await runRemoteSetup(OPTS);
    expect(interactive).toEqual([`sudo '${DIR}/dockflow' setup --host 'server.example.com' --host-key 'SHA256:${'a'.repeat(43)}'`]);
  });

  it('forwards the host key it was given instead of the one it saw', async () => {
    respond = serverAnswers;
    presented = 'SHA256:' + 'a'.repeat(43);
    await runRemoteSetup({ ...OPTS, hostKey: 'SHA256:' + 'b'.repeat(43) });
    expect(interactive[0]).toEndWith(`--host-key 'SHA256:${'b'.repeat(43)}'`);
  });

  it('forwards no host key when the connection presented none', async () => {
    respond = serverAnswers;
    await runRemoteSetup(OPTS);
    expect(interactive[0]).not.toContain('--host-key');
  });

  it('runs the binary directly as root', async () => {
    respond = serverAnswers;
    await runRemoteSetup({ ...OPTS, user: 'root' });
    expect(interactive[0].startsWith(`'${DIR}/dockflow' setup`)).toBe(true);
  });
});

describe('runRemoteSetup before the binary is delivered fails instead of returning', () => {
  const OPTS = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key' };

  it('needs a way to authenticate', async () => {
    await expect(runRemoteSetup({ host: 'h', port: 22, user: 'root' })).rejects.toThrow('No authentication method provided');
    expect(executed).toEqual([]);
  });

  it('reports a refused or failing connection with the advice for it', async () => {
    respond = () => {
      throw new Error('connect ECONNREFUSED 203.0.113.7:22');
    };
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('Connection refused on server.example.com:22. Is SSH running on that port?');
    respond = (command) => (command === 'echo ok' ? { exitCode: 1 } : undefined);
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('Connected but command execution failed');
    expect(executed.some((command) => command.startsWith('mktemp'))).toBe(false);
  });
});

describe('connectionFailureMessage', () => {
  const target = { host: 'h.example.com', port: 2222 };

  it('explains each kind of failure', () => {
    expect(connectionFailureMessage('getaddrinfo ENOTFOUND h.example.com', target)).toContain('not found');
    expect(connectionFailureMessage('Timed out while waiting for handshake', target)).toContain('timed out');
    expect(connectionFailureMessage('All configured authentication methods failed', { ...target, privateKey: 'k' })).toContain('SSH key');
    expect(connectionFailureMessage('All configured authentication methods failed', target)).toContain('username and password');
    expect(connectionFailureMessage('weird', target)).toBe('SSH error: weird');
  });
});

describe('the password of the deploy user created by remote setup', () => {
  const PASSWORD = `it's "a" $(id) p@ss`;
  const OPTS = {
    host: 'server.example.com',
    port: 22,
    user: 'deploy',
    privateKey: 'test-key',
    deployPassword: PASSWORD,
    forwardFlags: ["--user 'dockflow'", '--generate-key'],
  };
  const serverAnswers: Responder = (command) => {
    if (command === 'echo ok') return { stdout: 'ok\n' };
    if (command === 'uname -m') return { stdout: 'x86_64\n' };
    if (command.startsWith('mktemp')) return { stdout: `${DIR}\n` };
    if (command.endsWith('--version')) return { stdout: `${DOCKFLOW_VERSION}\n` };
    return undefined;
  };

  it('travels on the stdin of a channel into a file of the private directory, never in a command', async () => {
    respond = serverAnswers;
    await runRemoteSetup(OPTS);
    expect(channels).toEqual([{ command: `umask 077 && cat > '${DIR}/deploy-password'`, stdin: PASSWORD }]);
    expect(interactive).toEqual([`sudo '${DIR}/dockflow' setup --user 'dockflow' --generate-key --password-file '${DIR}/deploy-password'`]);
    for (const command of [...executed, ...interactive, ...channels.map((channel) => channel.command)]) {
      expect(command).not.toContain('p@ss');
    }
  });

  it('is not sent when no deploy user is created', async () => {
    respond = serverAnswers;
    await runRemoteSetup({ ...OPTS, deployPassword: undefined });
    expect(channels).toEqual([]);
    expect(interactive[0]).not.toContain('password-file');
  });

  it('stops, and removes the directory, when the file cannot be written', async () => {
    respond = serverAnswers;
    channelExit = 1;
    await expect(runRemoteSetup(OPTS)).rejects.toThrow('Could not write the password file on server.example.com: cat: Permission denied');
    expect(interactive).toEqual([]);
    expect(executed.at(-1)).toBe(`rm -rf -- '${DIR}'`);
  });

  it.skipIf(process.platform === 'win32' || Bun.which('bash') === null)('is written by that command exactly, readable by its owner only', async () => {
    const { mkdtempSync, readFileSync, statSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'dockflow-pw-'));
    try {
      const file = join(dir, "we ird'name");
      await writePasswordFile(CONN, file, PASSWORD);
      const proc = Bun.spawn(['bash', '-c', channels[0].command], { stdin: Buffer.from(PASSWORD), stdout: 'pipe', stderr: 'pipe' });
      expect(await proc.exited).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(PASSWORD);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
