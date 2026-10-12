/**
 * SSH Key utilities
 *
 * Handles private key normalization and validation.
 */

import { existsSync, readFileSync } from 'fs';
import { utils } from 'ssh2';
import { CLIError, ErrorCode } from './errors';

/**
 * Normalize SSH private key format.
 * Handles escaped newlines and different line ending formats.
 */
export function normalizePrivateKey(privateKey: string): string {
  let normalized = privateKey
    .replace(/\\n/g, '\n')       // Handle escaped newlines
    .replace(/\r\n/g, '\n')      // Normalize Windows line endings
    .replace(/\r/g, '\n');       // Handle old Mac line endings

  // Ensure the key ends with a newline (required by SSH)
  if (!normalized.endsWith('\n')) {
    normalized += '\n';
  }

  return normalized;
}

/**
 * Validate SSH private key format
 */
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
