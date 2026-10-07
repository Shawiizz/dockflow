import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { authorizeKeyForUser, generateSSHKey, keygenArgs, listSSHKeys } from '../commands/setup/key-files';
import type { RunResult } from '../commands/setup/provision';

describe('keygenArgs', () => {
  it('passes the empty passphrase and the comment as plain arguments', () => {
    expect(keygenArgs('/root/.ssh/deploy_key', "dockflow-x'; id #")).toEqual([
      '-q', '-t', 'ed25519', '-f', '/root/.ssh/deploy_key', '-N', '', '-C', "dockflow-x'; id #",
    ]);
  });
});

describe.skipIf(Bun.which('ssh-keygen') === null)('generateSSHKey', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-keygen-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('makes a key without a passphrase whose comment is taken literally', () => {
    const keyPath = join(dir, 'we ird', 'deploy_key');
    const comment = `dockflow $(touch ${join(dir, 'pwned')}) \`id\` ; & "x"`;
    expect(generateSSHKey(keyPath, comment)).toEqual({ success: true });
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(readFileSync(`${keyPath}.pub`, 'utf8').trim().endsWith(comment)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    const derived = Bun.spawnSync(['ssh-keygen', '-y', '-f', keyPath], { stdin: 'ignore' });
    expect(derived.exitCode).toBe(0);
    expect(derived.stdout.toString().startsWith('ssh-ed25519 ')).toBe(true);
  });

  it('replaces an existing key', () => {
    const keyPath = join(dir, 'deploy_key');
    generateSSHKey(keyPath, 'first');
    generateSSHKey(keyPath, 'second');
    expect(readFileSync(`${keyPath}.pub`, 'utf8').trim().endsWith('second')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('keys in the home of a user', () => {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeDeployKeyBlobForTestsOnly0123456789ab dockflow-deploy';
  let dir = '';
  const calls: string[][] = [];

  /** `getent passwd` that puts every user's home under `dir`, in a directory not named after the user */
  const getent = (argv: readonly string[]): RunResult => {
    calls.push([...argv]);
    if (argv[2] === 'ghost') return { ok: false, exitCode: 2, stdout: '', stderr: '', timedOut: false };
    return { ok: true, exitCode: 0, stdout: `${argv[2]}:x:${uid}:${gid}::${join(dir, 'srv', argv[2])}:/bin/bash\n`, stderr: '', timedOut: false };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-keys-'));
    calls.length = 0;
    mkdirSync(join(dir, 'srv', 'ops'), { recursive: true });
    writeFileSync(join(dir, 'key.pub'), `${KEY}\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('authorizeKeyForUser', () => {
    it('authorizes the key in the home the system reports, not /home/<name>', () => {
      expect(authorizeKeyForUser(join(dir, 'key.pub'), 'ops', getent)).toBe(true);
      expect(authorizeKeyForUser(join(dir, 'key.pub'), 'ops', getent)).toBe(true);
      const keys = join(dir, 'srv', 'ops', '.ssh', 'authorized_keys');
      expect(readFileSync(keys, 'utf8')).toBe(`${KEY}\n`);
      expect(statSync(keys).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'srv', 'ops', '.ssh')).mode & 0o777).toBe(0o700);
      expect(calls[0]).toEqual(['getent', 'passwd', 'ops']);
    });

    it('does not follow a link planted in the home', () => {
      mkdirSync(join(dir, 'elsewhere'));
      symlinkSync(join(dir, 'elsewhere'), join(dir, 'srv', 'ops', '.ssh'));
      expect(() => authorizeKeyForUser(join(dir, 'key.pub'), 'ops', getent)).toThrow('Refusing to touch');
      expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
    });

    it('is false for a missing public key and fails for an unknown user', () => {
      expect(authorizeKeyForUser(join(dir, 'missing.pub'), 'ops', getent)).toBe(false);
      expect(() => authorizeKeyForUser(join(dir, 'key.pub'), 'ghost', getent)).toThrow('User ghost does not exist');
    });
  });

  describe('listSSHKeys', () => {
    it('lists the private keys of the real home, skipping links and public files', () => {
      const ssh = join(dir, 'srv', 'ops', '.ssh');
      mkdirSync(ssh, { recursive: true });
      writeFileSync(join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
      writeFileSync(join(ssh, 'id_ed25519.pub'), KEY);
      writeFileSync(join(ssh, 'authorized_keys'), KEY);
      writeFileSync(join(dir, 'foreign'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
      symlinkSync(join(dir, 'foreign'), join(ssh, 'planted'));
      expect(listSSHKeys('ops', getent)).toEqual([join(ssh, 'id_ed25519')]);
    });

    it('is empty for a home without .ssh and fails for an unknown user', () => {
      expect(listSSHKeys('ops', getent)).toEqual([]);
      expect(() => listSSHKeys('ghost', getent)).toThrow('does not exist');
    });
  });
});
