import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { utils } from 'ssh2';
import { normalizePrivateKey, isValidPrivateKey, publicKeyOf } from '../utils/ssh-keys';

describe('normalizePrivateKey', () => {
  it('converts escaped \\n sequences to real newlines', () => {
    expect(normalizePrivateKey('a\\nb')).toBe('a\nb\n');
  });

  it('normalizes Windows CRLF line endings', () => {
    expect(normalizePrivateKey('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('normalizes old Mac CR line endings', () => {
    expect(normalizePrivateKey('a\rb')).toBe('a\nb\n');
  });

  it('appends trailing newline when missing', () => {
    expect(normalizePrivateKey('key')).toBe('key\n');
  });

  it('keeps existing trailing newline (no doubling)', () => {
    expect(normalizePrivateKey('key\n')).toBe('key\n');
  });
});

describe('isValidPrivateKey', () => {
  it('accepts OpenSSH PEM format', () => {
    expect(isValidPrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----')).toBe(true);
  });

  it('accepts RSA PEM format', () => {
    expect(isValidPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----')).toBe(true);
  });

  it('accepts keys with escaped newlines (validated after normalization)', () => {
    expect(isValidPrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\\nx\\n-----END OPENSSH PRIVATE KEY-----')).toBe(true);
  });

  it('rejects public keys and arbitrary strings', () => {
    expect(isValidPrivateKey('ssh-ed25519 AAAA... user@host')).toBe(false);
    expect(isValidPrivateKey('not a key')).toBe(false);
    expect(isValidPrivateKey('')).toBe(false);
  });
});

describe('publicKeyOf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dockflow-keys-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the .pub next to the key', () => {
    writeFileSync(join(dir, 'with-pub'), 'not read');
    writeFileSync(join(dir, 'with-pub.pub'), 'ssh-ed25519 AAAAfrom-file deploy@ci\n');
    expect(publicKeyOf(join(dir, 'with-pub'))).toBe('ssh-ed25519 AAAAfrom-file deploy@ci');
  });

  it('derives the public key from the private key when there is no .pub', () => {
    const pair = utils.generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'alone'), pair.private);
    expect(publicKeyOf(join(dir, 'alone'))).toBe(pair.public.trim().split(' ').slice(0, 2).join(' '));
  });

  it('says how to provide the public key when the file is no key', () => {
    writeFileSync(join(dir, 'garbage'), 'hello');
    expect(() => publicKeyOf(join(dir, 'garbage'))).toThrow(/Cannot read the public key/);
  });
});
