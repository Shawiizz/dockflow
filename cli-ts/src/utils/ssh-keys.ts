/**
 * SSH Key Management utilities
 * 
 * Handles private key normalization, temporary key file creation,
 * and SSH argument building for secure connections.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { DEFAULT_SSH_PORT } from '../constants';
import type { SSHKeyConnection, Result } from '../types';
import { ok, err } from '../types';

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

/**
 * Create a temporary SSH key file
 * Returns the path to the created file
 */
export function createTempKeyFile(privateKey: string): Result<string, Error> {
  try {
    const tempDir = os.tmpdir();
    const keyFile = path.join(tempDir, `dockflow_key_${Date.now()}_${Math.random().toString(36).slice(2)}`);

    const normalizedKey = normalizePrivateKey(privateKey);

    // Write key with proper permissions (read/write for owner only)
    fs.writeFileSync(keyFile, normalizedKey, { mode: 0o600 });

    // On Windows, mode 0o600 doesn't set NTFS ACLs.
    // OpenSSH on Windows refuses keys with overly permissive ACLs.
    // Use icacls to restrict access to the current user only.
    if (process.platform === 'win32') {
      spawnSync('icacls', [keyFile, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], {
        stdio: 'ignore',
        shell: false,
      });
    }

    return ok(keyFile);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Clean up temporary key file
 */
export function cleanupKeyFile(keyFile: string): void {
  try {
    if (fs.existsSync(keyFile)) {
      fs.unlinkSync(keyFile);
    }
  } catch {
    // Ignore cleanup errors silently
  }
}

/**
 * Build SSH command arguments for a connection
 */
export function buildSSHArgs(
  conn: SSHKeyConnection,
  keyFile: string,
  options: {
    strictHostKeyChecking?: boolean;
    timeout?: number;
    batchMode?: boolean;
    allocateTTY?: boolean;
  } = {}
): string[] {
  const {
    strictHostKeyChecking = false,
    timeout = 10,
    batchMode = true,
    allocateTTY = false,
  } = options;

  const args = [
    '-i', keyFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', `StrictHostKeyChecking=${strictHostKeyChecking ? 'yes' : 'no'}`,
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', `BatchMode=${batchMode ? 'yes' : 'no'}`,
    '-o', `ConnectTimeout=${timeout}`,
    '-p', (conn.port || DEFAULT_SSH_PORT).toString(),
  ];

  if (allocateTTY) {
    args.push('-t');
  }

  args.push(`${conn.user}@${conn.host}`);

  return args;
}

/**
 * Get the SSH command name based on platform
 */
export function getSSHCommand(): string {
  // On Windows, we can use OpenSSH that comes with Windows 10+
  // or Git Bash's ssh
  return 'ssh';
}

/**
 * Key file guard for automatic cleanup
 * Usage: using(keyFile, (file) => { ... })
 */
export async function withKeyFile<T>(
  privateKey: string,
  operation: (keyFile: string) => Promise<T>
): Promise<Result<T, Error>> {
  const keyFileResult = createTempKeyFile(privateKey);
  
  if (!keyFileResult.success) {
    return keyFileResult;
  }
  
  const keyFile = keyFileResult.data;
  
  try {
    const result = await operation(keyFile);
    return ok(result);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  } finally {
    cleanupKeyFile(keyFile);
  }
}
