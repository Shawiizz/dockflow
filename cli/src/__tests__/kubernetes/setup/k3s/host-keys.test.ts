import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { once } from 'events';
import { type AddressInfo, connect, createServer, type Server as NetServer, type Socket } from 'net';
import { Server, type ServerChannel, utils } from 'ssh2';
import type { ConnectionInfo } from '../../../../types';
import type * as SshModule from '../../../../utils/ssh';

// release.test.ts replaces sshExec and sshExecChannel process-wide with mock.module, which bun:test
// never undoes; the query suffix loads utils/ssh as a separate, unmocked module instance.
const UNMOCKED_SSH = '../../../../utils/ssh.ts?unmocked';
const {
  closeAllConnections,
  SSH_SIGNALLED_EXIT_CODE,
  SSHExitStatusError,
  sshExec,
  sshExecChannel,
  sshExecChannelUnbuffered,
} = (await import(UNMOCKED_SSH)) as typeof SshModule;

// The SSH layer is exercised against an in-process ssh2 server on the loopback interface, so the
// real client code paths (pool, exec, channel) run without a remote host. Traffic goes through a
// TCP relay whose sockets are destroyed to simulate a dropped connection.

type ExecScript = (channel: ServerChannel) => void;

const scripts = new Map<string, ExecScript>();
const execCount = new Map<string, number>();
const relayed = new Set<Socket>();
let server: Server;
let relay: NetServer;
let conn: ConnectionInfo;

function dropConnections(): void {
  for (const socket of relayed) socket.destroy();
}

function script(command: string, run: ExecScript): string {
  scripts.set(command, run);
  return command;
}

const exitWith = (code: number, stdout = '', stderr = ''): ExecScript => (channel) => {
  if (stdout) channel.write(stdout);
  if (stderr) channel.stderr.write(stderr);
  channel.exit(code);
  channel.end();
};

const killedBy = (signal: string): ExecScript => (channel) => {
  channel.write('partial');
  channel.exit(signal);
  channel.end();
};

const closedWithoutStatus: ExecScript = (channel) => {
  channel.write('partial');
  channel.close();
};

const connectionDropped: ExecScript = (channel) => {
  channel.write('partial');
  setTimeout(dropConnections, 20);
};

/** Bun's expect().rejects can stall on a promise that socket events settle later */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function listen(target: Server | NetServer): Promise<number> {
  return new Promise<number>((resolve) => {
    target.listen(0, '127.0.0.1', () => resolve((target.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          execCount.set(info.command, (execCount.get(info.command) ?? 0) + 1);
          const channel = acceptExec();
          const run = scripts.get(info.command) ?? exitWith(127, '', `unknown command ${info.command}\n`);
          run(channel);
        });
      });
    });
  });
  const sshPort = await listen(server);

  relay = createServer((downstream) => {
    const upstream = connect(sshPort, '127.0.0.1');
    for (const socket of [downstream, upstream]) {
      relayed.add(socket);
      socket.on('close', () => relayed.delete(socket));
      socket.on('error', () => {});
    }
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  const port = await listen(relay);
  conn = { host: '127.0.0.1', port, user: 'deploy', password: 'test-only-password' };
});

afterEach(() => {
  closeAllConnections();
  scripts.clear();
  execCount.clear();
});

afterAll(async () => {
  dropConnections();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('utils/ssh exit status: sshExec', () => {
  it('passes a numeric exit status through with the collected output', async () => {
    const command = script('status-3', exitWith(3, 'out', 'err'));
    const result = await sshExec(conn, command, { requireExitStatus: true });
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3, binaryOutput: undefined });
  });

  it('keeps exit code 0 for a channel closed without a status when not asked otherwise', async () => {
    const command = script('cut', closedWithoutStatus);
    const result = await sshExec(conn, command);
    expect(result).toEqual({ stdout: 'partial', stderr: '', exitCode: 0, binaryOutput: undefined });
  });

  it('rejects a channel closed without a status under requireExitStatus', async () => {
    const command = script('cut', closedWithoutStatus);
    const error = await rejectionOf(sshExec(conn, command, { requireExitStatus: true }));
    expect(error).toBeInstanceOf(SSHExitStatusError);
  });

  it('rejects a connection lost mid-command without sending the command again', async () => {
    const command = script('dropped', connectionDropped);
    const error = await rejectionOf(sshExec(conn, command, { requireExitStatus: true }));
    expect(error).toBeInstanceOf(SSHExitStatusError);
    expect(execCount.get(command)).toBe(1);
  });

  it('reports a signal as 255 under requireExitStatus and as 0 otherwise', async () => {
    const command = script('killed', killedBy('KILL'));
    const strict = await sshExec(conn, command, { requireExitStatus: true });
    expect(strict.exitCode).toBe(SSH_SIGNALLED_EXIT_CODE);
    expect(strict.stdout).toBe('partial');
    const lenient = await sshExec(conn, command);
    expect(lenient.exitCode).toBe(0);
  });
});

describe('utils/ssh exit status: channels', () => {
  it('sshExecChannel keeps collecting output and reading a missing status as 0', async () => {
    const command = script('cut', closedWithoutStatus);
    const { done } = await sshExecChannel(conn, command);
    expect(await done).toEqual({ exitCode: 0, stdout: 'partial', stderr: '' });
  });

  it('sshExecChannelUnbuffered attaches no output listener and streams stdin to stdout', async () => {
    const command = script('echo', (channel) => {
      channel.on('data', (chunk: Buffer) => channel.write(chunk));
      channel.on('end', () => {
        channel.exit(0);
        channel.end();
      });
    });
    const { stream, done } = await sshExecChannelUnbuffered(conn, command);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.stderr.listenerCount('data')).toBe(0);

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = once(stream, 'end');
    stream.end('hello over the channel');
    expect(await done).toEqual({ exitCode: 0 });
    await ended;
    expect(Buffer.concat(chunks).toString()).toBe('hello over the channel');
  });

  it('sshExecChannelUnbuffered passes a numeric exit status through', async () => {
    const command = script('status-7', exitWith(7, 'out', 'err'));
    const { stream, done } = await sshExecChannelUnbuffered(conn, command);
    stream.resume();
    stream.stderr.resume();
    expect(await done).toEqual({ exitCode: 7 });
  });

  it('sshExecChannelUnbuffered reports a signal as 255', async () => {
    const command = script('killed', killedBy('TERM'));
    const { stream, done } = await sshExecChannelUnbuffered(conn, command);
    stream.resume();
    expect(await done).toEqual({ exitCode: SSH_SIGNALLED_EXIT_CODE });
  });

  it('sshExecChannelUnbuffered rejects a channel closed without a status', async () => {
    const command = script('cut', closedWithoutStatus);
    const { stream, done } = await sshExecChannelUnbuffered(conn, command);
    stream.resume();
    expect(await rejectionOf(done)).toBeInstanceOf(SSHExitStatusError);
  });

  it('sshExecChannelUnbuffered rejects a connection lost mid-stream', async () => {
    const command = script('dropped', connectionDropped);
    const { stream, done } = await sshExecChannelUnbuffered(conn, command);
    stream.resume();
    expect(await rejectionOf(done)).toBeInstanceOf(SSHExitStatusError);
  });
});
