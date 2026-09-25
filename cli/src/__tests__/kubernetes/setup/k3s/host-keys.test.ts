import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'events';
import { type AddressInfo, connect, createServer, type Server as NetServer, type Socket } from 'net';
import { Server, type ServerChannel, utils } from 'ssh2';
import type { ConnectionInfo } from '../../../../types';
import type * as SshModule from '../../../../utils/ssh';
import { HostKeyStore, sshFingerprint, type HostKeyDecision } from '../../../../commands/setup/k3s/host-keys';
import type { K3sNodeSpec } from '../../../../commands/setup/k3s/plan';

// No test in this suite mocks a module (the architecture forbids it, README.md "one harness"); the
// query suffix still loads utils/ssh as its own module instance, isolating this file's pool/exit-
// status assertions (which call the real `closeAllConnections()`) from every other file's pooled
// clients, since `utils/ssh.ts`'s pool is process-wide module state.
const UNMOCKED_SSH = '../../../../utils/ssh.ts?unmocked';
const {
  closeAllConnections,
  SSH_SIGNALLED_EXIT_CODE,
  SSHExitStatusError,
  sshExec,
  sshExecChannel,
  sshExecChannelDedicated,
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

describe('sshExecChannelDedicated (design-05 3.5): never the pool', () => {
  it('opens its own connection per call, independent of sshExec’s pool and of each other', async () => {
    const first = script('dedicated-1', closedWithoutStatus);
    const handleA = await sshExecChannelDedicated(conn, first);
    expect(await handleA.done).toEqual({ exitCode: 0, stdout: 'partial', stderr: '' });

    // closing every pooled client (as withErrorHandler does after a command) must not touch a
    // dedicated channel: it was never registered with the pool in the first place.
    closeAllConnections();
    handleA.close();

    const second = script('dedicated-2', closedWithoutStatus);
    const handleB = await sshExecChannelDedicated(conn, second);
    expect(await handleB.done).toEqual({ exitCode: 0, stdout: 'partial', stderr: '' });
    handleB.close();
  });

  it('closing one dedicated channel does not affect a concurrently open one on the same connection', async () => {
    const first = script('dedicated-concurrent-1', (channel) => {
      channel.write('alive');
      // left open until the test closes it
    });
    const second = script('dedicated-concurrent-2', closedWithoutStatus);
    const handleA = await sshExecChannelDedicated(conn, first);
    const handleB = await sshExecChannelDedicated(conn, second);
    expect(await handleB.done).toEqual({ exitCode: 0, stdout: 'partial', stderr: '' });
    handleB.close();
    // handleA's own connection is untouched by handleB's close()
    handleA.stream.end();
    handleA.close();
  });
});

// ---------------------------------------------------------------------------
// HostKeyStore (design-05 3.5, K60): the setup transport's host-key verifier and pin store.
// Exercised directly (no SSH server needed): `verifierFor` returns the exact `(key, callback)`
// function form ssh2's `hostVerifier` option calls, offered here with real ssh-keygen-generated
// host key blobs so `sshFingerprint` is checked against real `ssh-keygen -lf` output (HK7).
// ---------------------------------------------------------------------------

// `ssh-keygen -t <type> -N "" -f <file>`, base64 body of the resulting .pub, and the fingerprint
// `ssh-keygen -lf <file>.pub` printed (SHA256, this repository's own generation, HK7).
const ED25519_PUB_B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIPRcylrE6A2C73bhBiOyOjS6dE1nPOAPfhdMWIpbtzAF';
const ED25519_FINGERPRINT = 'SHA256:Ldb7KXMtd57Q+bjn9lpVRV4n8uuQKR9m/aoX4AqIgh4';
const ECDSA_PUB_B64 =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBJv9crWRro5HTDISKs4DaMiostuKL9dZOXdHBjo/6mKKdbOSmCuStEyWjhKKVkk3d71SIDouUyqzt8GhACLSkaE=';
const ECDSA_FINGERPRINT = 'SHA256:PT0vXUS7orNdLN8Q24oRkxmoPAZlns1idwjIMYSkLLA';
const RSA_PUB_B64 =
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQDHJUUA6Meo2gZaIGodAy5g0COGLNESR3EsvO3tW9hb05omUO1YmCIvtwf+e0ucNnxNR/eOViuQ+flb3QZ45YdT5AJwGL6EGGVOVOjoEBPbPHrjjGRhUawRFH/Rl2f9uCZ73yd+PkWiXiHI1elEta2D116fsF0oBemj2Oi5MbLFMNOOaFu8Wo/U/wSsYjGd7yl4WMdIR7kBCYNINDkeuaDY8OzZt9Hnl/+SNq7OZ223fhHMoMBTXATqia7++G4+IdBM+tEr25Qtkwk+PDhY/xja45TM5dSW5bYe/eMSaiL/lWDdkZgIlYiIPxfvkNDonvRA0m3/I10jmLi44xCEjz6p';
const RSA_FINGERPRINT = 'SHA256:BgdOktlx5ag2rI93I8Hds3NuGU+lDvEBBsjD0Zg+XVE';

const HK_ENV = 'production';

function hkNode(key: string, host = '10.0.0.10'): K3sNodeSpec {
  return { key, nodeName: key, role: 'server', ssh: { host, port: 22 }, deployUser: 'dockflow', deployPublicKey: null, privateHost: null, hostName: null, hostIp: host, nodeLabels: {} };
}

function verify(store: HostKeyStore, node: K3sNodeSpec, key: Buffer, onDecision: (d: HostKeyDecision) => void = () => {}): Promise<boolean> {
  const verifier = store.verifierFor(node, onDecision);
  return new Promise<boolean>((resolve) => {
    const outcome = verifier(key, resolve);
    if (outcome !== undefined) resolve(outcome as unknown as boolean);
  });
}

describe('HostKeyStore (design-05 3.5, K60)', () => {
  let dirs: string[] = [];
  function tmpProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dockflow-hostkeys-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    const previous = process.env[`${HK_ENV.toUpperCase()}_SRV-1_HOST_KEY`];
    if (previous !== undefined) delete process.env[`${HK_ENV.toUpperCase()}_SRV-1_HOST_KEY`];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('HK1 pin matches -> connect, outcome matched, no file write', async () => {
    const dir = tmpProjectDir();
    mkdirSync(join(dir, '.dockflow'), { recursive: true });
    const knownHosts = join(dir, '.dockflow', 'known_hosts');
    writeFileSync(knownHosts, `srv-1 10.0.0.10 22 ssh-ed25519 ${ED25519_PUB_B64}\n`, { mode: 0o600 });

    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false });
    const decisions: HostKeyDecision[] = [];
    const accepted = await verify(store, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'), (d) => decisions.push(d));

    expect(accepted).toBe(true);
    expect(decisions).toEqual([{ key: 'srv-1', fingerprint: ED25519_FINGERPRINT, outcome: 'matched' }]);
    store.persistRecorded();
    expect(readFileSync(knownHosts, 'utf8')).toBe(`srv-1 10.0.0.10 22 ssh-ed25519 ${ED25519_PUB_B64}\n`);
  });

  it('HK2 pin differs -> ConnectionError-shaped refusal naming both fingerprints; no verify(true)', async () => {
    const dir = tmpProjectDir();
    mkdirSync(join(dir, '.dockflow'), { recursive: true });
    writeFileSync(join(dir, '.dockflow', 'known_hosts'), `srv-1 10.0.0.10 22 ecdsa-sha2-nistp256 ${ECDSA_PUB_B64}\n`, { mode: 0o600 });

    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false });
    const accepted = await verify(store, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'));

    expect(accepted).toBe(false);
    const error = store.takeError();
    expect(error?.message).toBe('The SSH host key of srv-1 (10.0.0.10:22) changed');
    expect(error?.suggestion).toContain(ECDSA_FINGERPRINT);
    expect(error?.suggestion).toContain(ED25519_FINGERPRINT);
  });

  it('HK3 no pin, non-TTY, key auth -> recorded once, warned, persisted 0600 sorted by key; a second run matches silently', async () => {
    const dir = tmpProjectDir();
    const warnings: string[] = [];
    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false, onWarning: (m) => warnings.push(m) });

    expect(store.refusalFor(hkNode('srv-1'), { usesPassword: false })).toBeNull();
    const decisionsA: HostKeyDecision[] = [];
    const decisionsB: HostKeyDecision[] = [];
    const acceptedB = await verify(store, hkNode('srv-2'), Buffer.from(ECDSA_PUB_B64, 'base64'), (d) => decisionsB.push(d));
    const acceptedA = await verify(store, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'), (d) => decisionsA.push(d));

    expect(acceptedA).toBe(true);
    expect(acceptedB).toBe(true);
    expect(decisionsA[0].outcome).toBe('recorded');
    expect(decisionsB[0].outcome).toBe('recorded');
    expect(warnings.filter((w) => w.includes('first contact'))).toHaveLength(2);

    store.persistRecorded();
    const knownHosts = join(dir, '.dockflow', 'known_hosts');
    expect(readFileSync(knownHosts, 'utf8')).toBe(`srv-1 10.0.0.10 22 ssh-ed25519 ${ED25519_PUB_B64}\nsrv-2 10.0.0.10 22 ecdsa-sha2-nistp256 ${ECDSA_PUB_B64}\n`);
    // Windows NTFS does not track POSIX permission bits the way writeFileSync's `mode` implies
    if (process.platform !== 'win32') expect(statSync(knownHosts).mode & 0o777).toBe(0o600);

    // a fresh store over the same project dir now matches without recording or warning again
    const secondRun = new HostKeyStore(dir, HK_ENV, {
      insecureHostKey: false,
      requireHostKey: false,
      interactive: false,
      onWarning: (m) => {
        throw new Error(`unexpected warning on a matching second run: ${m}`);
      },
    });
    const decisions2: HostKeyDecision[] = [];
    const accepted2 = await verify(secondRun, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'), (d) => decisions2.push(d));
    expect(accepted2).toBe(true);
    expect(decisions2[0].outcome).toBe('matched');
  });

  it('HK3b a later connection of the same run matches the first-contact key silently', async () => {
    const dir = tmpProjectDir();
    const warnings: string[] = [];
    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false, onWarning: (m) => warnings.push(m) });
    const decisions: HostKeyDecision[] = [];

    for (let connection = 0; connection < 3; connection++) {
      expect(await verify(store, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'), (d) => decisions.push(d))).toBe(true);
    }

    expect(warnings.filter((w) => w.includes('first contact'))).toHaveLength(1);
    expect(decisions).toEqual([{ key: 'srv-1', fingerprint: ED25519_FINGERPRINT, outcome: 'recorded' }]);
  });

  it('HK3c a different key later in the same run is refused, naming both fingerprints', async () => {
    const dir = tmpProjectDir();
    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false });

    expect(await verify(store, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'))).toBe(true);
    expect(await verify(store, hkNode('srv-1'), Buffer.from(ECDSA_PUB_B64, 'base64'))).toBe(false);

    const error = store.takeError();
    expect(error?.message).toBe('The SSH host key of srv-1 (10.0.0.10:22) changed during this run');
    expect(error?.suggestion).toContain(ED25519_FINGERPRINT);
    expect(error?.suggestion).toContain(ECDSA_FINGERPRINT);
  });

  it('HK4 no pin, non-TTY, --password -> refused before any key is offered (2.1)', () => {
    const dir = tmpProjectDir();
    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false });
    const refusal = store.refusalFor(hkNode('srv-1'), { usesPassword: true });
    expect(refusal).not.toBeNull();
    expect(refusal?.message).toContain('srv-1');
    expect(refusal?.suggestion).toContain('--insecure-host-key');
  });

  it('HK5 --require-host-key without a pin refuses; --insecure-host-key skips verification with a warning, no file write', async () => {
    const dir = tmpProjectDir();
    const strict = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: true, interactive: false });
    expect(strict.refusalFor(hkNode('srv-1'), { usesPassword: false })?.message).toBe('srv-1 has no recorded SSH host key');

    const warnings: string[] = [];
    const insecure = new HostKeyStore(dir, HK_ENV, { insecureHostKey: true, requireHostKey: false, interactive: false, onWarning: (m) => warnings.push(m) });
    // --insecure-host-key bypasses even the password-on-unverified-host rule
    expect(insecure.refusalFor(hkNode('srv-1'), { usesPassword: true })).toBeNull();
    const decisions: HostKeyDecision[] = [];
    const accepted = await verify(insecure, hkNode('srv-1'), Buffer.from(ED25519_PUB_B64, 'base64'), (d) => decisions.push(d));
    expect(accepted).toBe(true);
    expect(decisions[0].outcome).toBe('skipped');
    expect(warnings).toEqual(['Host key verification is disabled for srv-1']);
    insecure.persistRecorded();
    expect(existsSync(join(dir, '.dockflow', 'known_hosts'))).toBe(false);
  });

  it('HK6 <ENV>_<KEY>_HOST_KEY takes precedence over a conflicting file entry', () => {
    const dir = tmpProjectDir();
    mkdirSync(join(dir, '.dockflow'), { recursive: true });
    writeFileSync(join(dir, '.dockflow', 'known_hosts'), `srv-1 10.0.0.10 22 ecdsa-sha2-nistp256 ${ECDSA_PUB_B64}\n`, { mode: 0o600 });
    process.env[`${HK_ENV.toUpperCase()}_SRV-1_HOST_KEY`] = `ssh-ed25519 ${ED25519_PUB_B64}`;

    const store = new HostKeyStore(dir, HK_ENV, { insecureHostKey: false, requireHostKey: false, interactive: false });
    const pin = store.lookup(hkNode('srv-1'));
    expect(pin?.type).toBe('ssh-ed25519');
    expect(pin?.base64).toBe(ED25519_PUB_B64);
    expect(store.fileConflictsWithEnv(hkNode('srv-1'))).toBe(true);
  });

  it('HK7 sshFingerprint matches ssh-keygen -lf for ed25519, ecdsa and rsa host keys', () => {
    expect(sshFingerprint(Buffer.from(ED25519_PUB_B64, 'base64'))).toBe(ED25519_FINGERPRINT);
    expect(sshFingerprint(Buffer.from(ECDSA_PUB_B64, 'base64'))).toBe(ECDSA_FINGERPRINT);
    expect(sshFingerprint(Buffer.from(RSA_PUB_B64, 'base64'))).toBe(RSA_FINGERPRINT);
  });
});
