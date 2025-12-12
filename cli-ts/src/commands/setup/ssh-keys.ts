/**
 * SSH Key management utilities
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

    const result = spawnSync('ssh-keygen', [
      '-t', 'ed25519',
      '-f', keyPath,
      '-N', '',
      '-C', comment
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.status === 0) {
      fs.chmodSync(keyPath, 0o600);
      return { success: true };
    }

    return { 
      success: false, 
      error: result.stderr || result.stdout || `Exit code: ${result.status}` 
    };
  } catch (err: any) {
    return { success: false, error: err.message };
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
