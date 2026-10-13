/**
 * SSH host key pinning: the fingerprint is written like `ssh-keygen -lf` prints it, so an
 * operator can compare it with what the server reports.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConnectionError, ErrorCode } from './errors';

const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** Order in which ssh2 prefers the server's host key types: the key a server presents when it has several. */
const HOST_KEY_FILES = [
  'ssh_host_ed25519_key.pub',
  'ssh_host_ecdsa_key.pub',
  'ssh_host_rsa_key.pub',
];

export function isHostKeyFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/** `SHA256:` and the unpadded base64 of the SHA-256 of the raw public key blob. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** The fingerprint of a line of an OpenSSH `.pub` file (`<type> <base64 key> [comment]`), or null. */
export function fingerprintOfPublicKey(line: string): string | null {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob) return null;
  const key = Buffer.from(blob, 'base64');
  return key.length > 0 ? hostKeyFingerprint(key) : null;
}

/** The fingerprint of the host key this machine's sshd presents, when it can be read. */
export function localHostKey(sshDir = '/etc/ssh'): string | null {
  for (const file of HOST_KEY_FILES) {
    const path = join(sshDir, file);
    if (!existsSync(path)) continue;
    try {
      const fingerprint = fingerprintOfPublicKey(readFileSync(path, 'utf-8'));
      if (fingerprint) return fingerprint;
    } catch {
      // unreadable: try the next key type
    }
  }
  return null;
}

export interface HostKeyCheck {
  /** For ssh2's `hostVerifier`: accepts any key when nothing is pinned. */
  verify: (key: Buffer) => boolean;
  /** Fingerprint of the key the server presented, once it did. */
  presented: () => string | undefined;
  /** What a refused connection must report, once the key was refused. */
  failure: () => ConnectionError | undefined;
}

export function hostKeyCheck(target: { host: string; hostKey?: string }): HostKeyCheck {
  let presented: string | undefined;
  let refused = false;
  return {
    verify: (key) => {
      presented = hostKeyFingerprint(key);
      refused = target.hostKey !== undefined && presented !== target.hostKey;
      return !refused;
    },
    presented: () => presented,
    failure: () => (refused && target.hostKey && presented ? hostKeyMismatch(target, presented) : undefined),
  };
}

export function hostKeyMismatch(target: { host: string; hostKey?: string }, presented: string): ConnectionError {
  return new ConnectionError(
    `The host key of ${target.host} changed: expected ${target.hostKey}, the server presented ${presented}. The server may have been reinstalled, or someone may be impersonating it.`,
    `If you did reinstall ${target.host}, run \`dockflow setup connection\` on it and replace its connection string, or remove "hostKey" from the old one. Otherwise do not connect.`,
    ErrorCode.HOST_KEY_CHANGED,
  );
}
