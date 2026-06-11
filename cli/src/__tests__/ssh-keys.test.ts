import { describe, expect, it } from 'bun:test';
import { normalizePrivateKey, isValidPrivateKey } from '../utils/ssh-keys';

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
