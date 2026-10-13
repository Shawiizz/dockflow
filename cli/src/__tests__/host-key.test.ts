import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type AddressInfo } from 'net';
import { Server, utils } from 'ssh2';
import {
  fingerprintOfPublicKey,
  hostKeyCheck,
  hostKeyFingerprint,
  isHostKeyFingerprint,
  localHostKey,
} from '../utils/host-key';
import { closeAllConnections, presentedHostKey, sshExecStream } from '../utils/ssh';
import { ConnectionError, ErrorCode } from '../utils/errors';

const dir = mkdtempSync(join(tmpdir(), 'dockflow-hostkey-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function blobOf(publicLine: string): Buffer {
  return Buffer.from(publicLine.trim().split(/\s+/)[1], 'base64');
}

describe('hostKeyFingerprint', () => {
  const pair = utils.generateKeyPairSync('ed25519');

  it('has the form isHostKeyFingerprint accepts', () => {
    const fingerprint = hostKeyFingerprint(blobOf(pair.public));
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(isHostKeyFingerprint(fingerprint)).toBe(true);
  });

  it('is the SHA-256 of the key blob in unpadded base64', () => {
    const blob = Buffer.from('known key blob');
    expect(hostKeyFingerprint(blob)).toBe('SHA256:rGwDNZfuW5f0pMhvnIyJaCOifSbFoMNmcWdjJm1uwyY');
  });

  it('reads a .pub line, comment or not', () => {
    const line = pair.public.trim();
    const expected = hostKeyFingerprint(blobOf(line));
    expect(fingerprintOfPublicKey(line)).toBe(expected);
    expect(fingerprintOfPublicKey(`${line} root@server\n`)).toBe(expected);
    expect(fingerprintOfPublicKey('ssh-ed25519')).toBeNull();
    expect(fingerprintOfPublicKey('')).toBeNull();
  });

  it('matches what ssh-keygen -lf prints', () => {
    const keygen = Bun.which('ssh-keygen');
    if (!keygen) return;
    const keys = {
      ed25519: utils.generateKeyPairSync('ed25519'),
      ecdsa: utils.generateKeyPairSync('ecdsa', { bits: 256 }),
      rsa: utils.generateKeyPairSync('rsa', { bits: 2048 }),
    };
    for (const [type, key] of Object.entries(keys)) {
      const path = join(dir, `keygen-${type}.pub`);
      writeFileSync(path, key.public);
      const printed = Bun.spawnSync([keygen, '-lf', path]).stdout.toString();
      expect(printed.split(' ')[1]).toBe(fingerprintOfPublicKey(key.public)!);
    }
  });
});

describe('isHostKeyFingerprint', () => {
  it('refuses anything else', () => {
    for (const value of ['', 'SHA256:short', 'MD5:aa:bb', 'SHA256:' + 'A'.repeat(44), 'SHA256:' + 'A'.repeat(43) + '=', 42, undefined]) {
      expect(isHostKeyFingerprint(value)).toBe(false);
    }
  });
});

describe('hostKeyCheck', () => {
  const key = Buffer.from('presented key');
  const fingerprint = hostKeyFingerprint(key);
  const other = hostKeyFingerprint(Buffer.from('another key'));

  it('accepts the pinned key', () => {
    const check = hostKeyCheck({ host: 'node-1', hostKey: fingerprint });
    expect(check.verify(key)).toBe(true);
    expect(check.presented()).toBe(fingerprint);
    expect(check.failure()).toBeUndefined();
  });

  it('refuses another key, naming the server and both fingerprints', () => {
    const check = hostKeyCheck({ host: 'node-1', hostKey: other });
    expect(check.verify(key)).toBe(false);

    const failure = check.failure();
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure!.code).toBe(ErrorCode.HOST_KEY_CHANGED);
    expect(failure!.message).toContain('node-1');
    expect(failure!.message).toContain(`expected ${other}`);
    expect(failure!.message).toContain(`presented ${fingerprint}`);
    expect(failure!.message).toContain('reinstalled');
    expect(failure!.message).toContain('impersonating');
    expect(failure!.suggestion).toContain('dockflow setup connection');
  });

  it('accepts any key when nothing is pinned, and still reports the one it saw', () => {
    const check = hostKeyCheck({ host: 'node-1' });
    expect(check.verify(key)).toBe(true);
    expect(check.presented()).toBe(fingerprint);
    expect(check.failure()).toBeUndefined();
  });
});

describe('localHostKey', () => {
  it('prefers ed25519, then ecdsa, then rsa, as ssh2 negotiates them', () => {
    const ssh = join(dir, 'etc-ssh');
    Bun.spawnSync(['mkdir', '-p', ssh]);
    const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 });
    const ecdsa = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    const ed = utils.generateKeyPairSync('ed25519');

    expect(localHostKey(ssh)).toBeNull();
    writeFileSync(join(ssh, 'ssh_host_rsa_key.pub'), rsa.public);
    expect(localHostKey(ssh)).toBe(fingerprintOfPublicKey(rsa.public)!);
    writeFileSync(join(ssh, 'ssh_host_ecdsa_key.pub'), ecdsa.public);
    expect(localHostKey(ssh)).toBe(fingerprintOfPublicKey(ecdsa.public)!);
    writeFileSync(join(ssh, 'ssh_host_ed25519_key.pub'), ed.public);
    expect(localHostKey(ssh)).toBe(fingerprintOfPublicKey(ed.public)!);
  });

  it('is null for a directory with no readable key', () => {
    expect(localHostKey(join(dir, 'missing'))).toBeNull();
  });
});

describe('an SSH connection', () => {
  const hostPair = utils.generateKeyPairSync('ed25519');
  const clientPair = utils.generateKeyPairSync('ed25519');
  const servers: Server[] = [];
  let connections = 0;

  afterEach(() => {
    closeAllConnections();
    for (const server of servers.splice(0)) server.close();
    connections = 0;
  });

  async function startServer(): Promise<number> {
    const server = new Server({ hostKeys: [hostPair.private] }, (client) => {
      connections++;
      client.on('error', () => {});
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('session', (accept) => {
          accept().on('exec', (acceptExec) => {
            const channel = acceptExec();
            channel.write('hello\n');
            channel.exit(0);
            channel.end();
          });
        });
      });
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  }

  const hostKey = fingerprintOfPublicKey(hostPair.public)!;
  const connection = (port: number, pinned?: string) => ({
    host: '127.0.0.1',
    port,
    user: 'deploy',
    privateKey: clientPair.private,
    ...(pinned ? { hostKey: pinned } : {}),
  });

  // sshExecStream: other test files replace sshExec for the whole run
  async function run(conn: ReturnType<typeof connection>): Promise<{ output: string; exitCode: number }> {
    let output = '';
    const { exitCode } = await sshExecStream(conn, 'echo hello', { onStdout: (data) => void (output += data) });
    return { output, exitCode };
  }

  it('runs when the server presents the pinned key', async () => {
    const port = await startServer();
    const { output, exitCode } = await run(connection(port, hostKey));
    expect(output.trim()).toBe('hello');
    expect(exitCode).toBe(0);
    expect(presentedHostKey(connection(port))).toBe(hostKey);
  });

  it('runs without a pin, whatever key the server presents', async () => {
    const port = await startServer();
    const { output, exitCode } = await run(connection(port));
    expect(output.trim()).toBe('hello');
    expect(exitCode).toBe(0);
  });

  it('is refused when the server presents another key, once, with the explanation', async () => {
    const port = await startServer();
    const other = hostKeyFingerprint(Buffer.from('a different server'));

    const failure = await run(connection(port, other)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectionError);
    const error = failure as ConnectionError;
    expect(error.code).toBe(ErrorCode.HOST_KEY_CHANGED);
    expect(error.message).toContain('127.0.0.1');
    expect(error.message).toContain(`expected ${other}`);
    expect(error.message).toContain(`presented ${hostKey}`);
    expect(connections).toBe(1);
  });
});
