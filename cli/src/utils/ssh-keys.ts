/** Normalizes, checks and reads the public half of SSH private keys. */

import { existsSync, readFileSync } from 'fs';
import { utils } from 'ssh2';
import { CLIError, ErrorCode } from './errors';

/** Turns a key as CI secrets and env files hold it (literal `\n`, CRLF) into LF lines ending in a newline. */
export function normalizePrivateKey(privateKey: string): string {
  let normalized = privateKey
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // SSH rejects a key without the final newline
  if (!normalized.endsWith('\n')) {
    normalized += '\n';
  }

  return normalized;
}

/** A shape check only (PEM header and footer); the key itself is not parsed. */
export function isValidPrivateKey(key: string): boolean {
  const normalized = normalizePrivateKey(key);
  return normalized.includes('-----BEGIN') && normalized.includes('PRIVATE KEY-----');
}

/** The `authorized_keys` line of a private key file: its `.pub` when there is one, otherwise derived from the key. */
export function publicKeyOf(privateKeyPath: string): string {
  const pubPath = `${privateKeyPath}.pub`;
  if (existsSync(pubPath)) return readFileSync(pubPath, 'utf-8').trim();

  const parsed = utils.parseKey(readFileSync(privateKeyPath));
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) {
    throw new CLIError(
      `Cannot read the public key of ${privateKeyPath}: ${key instanceof Error ? key.message : 'no key found'}`,
      ErrorCode.SSH_KEY_NOT_FOUND,
      `Put its public key next to it as ${pubPath} (ssh-keygen -y -f ${privateKeyPath} > ${pubPath}).`,
    );
  }
  return `${key.type} ${key.getPublicSSH().toString('base64')}`;
}
