/**
 * SSH key FILE management for setup (generation, authorized_keys, listing).
 * Key *string* normalization/validation lives in utils/ssh-keys.ts.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SSHKeyResult } from './types';
import { run, type CommandRunner } from './provision';
import { authorizeKey, requireUser } from './user';

/** ssh-keygen's arguments: an ed25519 key with an empty passphrase, the comment as a plain argument. */
export function keygenArgs(keyPath: string, comment: string): string[] {
  return ['-q', '-t', 'ed25519', '-f', keyPath, '-N', '', '-C', comment];
}

/**
 * Generate new SSH key pair
 */
export function generateSSHKey(keyPath: string, comment: string = 'dockflow'): SSHKeyResult {
  const dir = path.dirname(keyPath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
    }
    if (fs.existsSync(`${keyPath}.pub`)) {
      fs.unlinkSync(`${keyPath}.pub`);
    }

    const result = spawnSync('ssh-keygen', keygenArgs(keyPath, comment), {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
      fs.chmodSync(keyPath, 0o600);
      return { success: true };
    }

    return { 
      success: false, 
      error: result.stderr || result.stdout || result.error?.message || `Exit code: ${result.status}`
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Authorize a public key for a user, in the home the system reports for it. Returns false when the
 * public key file does not exist; a home that cannot be written safely throws.
 */
export function authorizeKeyForUser(pubKeyPath: string, username: string, runCommand: CommandRunner = run): boolean {
  if (!fs.existsSync(pubKeyPath)) return false;
  authorizeKey(requireUser(username, runCommand), fs.readFileSync(pubKeyPath, 'utf-8'));
  return true;
}

/**
 * List available SSH keys for a user
 */
export function listSSHKeys(username?: string, runCommand: CommandRunner = run): string[] {
  const sshDir = path.join(username ? requireUser(username, runCommand).home : os.homedir(), '.ssh');

  if (!fs.existsSync(sshDir)) {
    return [];
  }

  const files = fs.readdirSync(sshDir);
  const keys: string[] = [];

  for (const file of files) {
    const filePath = path.join(sshDir, file);
    if (!file.endsWith('.pub') && !file.includes('known_hosts') && !file.includes('config') && !file.includes('authorized_keys')) {
      try {
        // a link in the user's directory could point root's read at any file
        if (!fs.lstatSync(filePath).isFile()) continue;
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('PRIVATE KEY')) {
          keys.push(filePath);
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return keys;
}
