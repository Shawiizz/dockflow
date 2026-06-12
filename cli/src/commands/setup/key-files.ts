/**
 * SSH key FILE management for setup (generation, authorized_keys, listing).
 * Key *string* normalization/validation lives in utils/ssh-keys.ts.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { printWarning } from '../../utils/output';
import type { SSHKeyResult } from './types';

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

    // Use -q for quiet mode and -N '' for empty passphrase
    // With shell: true, we need to properly escape the empty string
    const result = spawnSync('ssh-keygen', [
      '-q',
      '-t', 'ed25519',
      '-f', keyPath,
      '-N', "''",
      '-C', comment
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    if (result.status === 0) {
      fs.chmodSync(keyPath, 0o600);
      return { success: true };
    }

    return { 
      success: false, 
      error: result.stderr || result.stdout || `Exit code: ${result.status}` 
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Add public key to authorized_keys
 */
export function addToAuthorizedKeys(pubKeyPath: string, user?: string): boolean {
  const homeDir = user ? `/home/${user}` : os.homedir();
  const authKeysPath = path.join(homeDir, '.ssh', 'authorized_keys');
  const sshDir = path.dirname(authKeysPath);

  if (!fs.existsSync(pubKeyPath)) {
    return false;
  }
  const pubKey = fs.readFileSync(pubKeyPath, 'utf-8').trim();

  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(authKeysPath)) {
    const existing = fs.readFileSync(authKeysPath, 'utf-8');
    if (existing.includes(pubKey)) {
      return true;
    }
  }

  fs.appendFileSync(authKeysPath, `${pubKey}\n`, { mode: 0o600 });
  return true;
}

/**
 * Authorize a public key for a specific user: appends it to the user's
 * authorized_keys and fixes ownership/permissions (the setup runs as root,
 * so files it creates under the user's home must be chowned back).
 */
export function authorizeKeyForUser(pubKeyPath: string, username: string): boolean {
  const added = addToAuthorizedKeys(pubKeyPath, username === 'root' ? undefined : username);
  if (!added) return false;

  if (username !== 'root') {
    const sshDir = `/home/${username}/.ssh`;
    const chown = spawnSync('chown', ['-R', `${username}:${username}`, sshDir], { encoding: 'utf-8', stdio: 'pipe' });
    if (chown.status !== 0) {
      printWarning(`Could not chown ${sshDir} to ${username}: ${chown.stderr.trim()}`);
      return false;
    }
    spawnSync('chmod', ['700', sshDir], { encoding: 'utf-8', stdio: 'pipe' });
    spawnSync('chmod', ['600', `${sshDir}/authorized_keys`], { encoding: 'utf-8', stdio: 'pipe' });
  }
  return true;
}

/**
 * List available SSH keys for a user
 */
export function listSSHKeys(username?: string): string[] {
  let sshDir: string;
  
  if (username && username !== 'root') {
    sshDir = `/home/${username}/.ssh`;
  } else {
    sshDir = path.join(os.homedir(), '.ssh');
  }
  
  if (!fs.existsSync(sshDir)) {
    return [];
  }

  const files = fs.readdirSync(sshDir);
  const keys: string[] = [];

  for (const file of files) {
    const filePath = path.join(sshDir, file);
    if (!file.endsWith('.pub') && !file.includes('known_hosts') && !file.includes('config') && !file.includes('authorized_keys')) {
      try {
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
