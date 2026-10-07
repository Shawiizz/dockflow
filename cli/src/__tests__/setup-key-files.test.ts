import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSSHKey, keygenArgs } from '../commands/setup/key-files';

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
