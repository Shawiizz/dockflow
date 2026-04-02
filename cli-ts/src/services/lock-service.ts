/**
 * Lock Service
 *
 * Manages deployment locks on remote servers via SSH.
 * Used by both CLI lock commands and API lock routes.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, shellEscape } from '../utils/ssh';
import { ok, err, type Result } from '../types';
import { DOCKFLOW_LOCKS_DIR } from '../constants';
import { LOCK_STALE_THRESHOLD_MINUTES } from '../constants';
import { getPerformer } from '../utils/config';

/**
 * Lock information stored in the lock file
 */
export interface LockData {
  performer: string;
  started_at: string;
  timestamp: number;
  version: string;
  stack: string;
  message?: string;
}

/**
 * Lock status with computed fields
 */
export interface LockStatus {
  locked: boolean;
  data?: LockData;
  durationMinutes?: number;
  isStale?: boolean;
}

/**
 * Lock Service - manages deployment locks for a stack
 */
export class LockService {
  private readonly lockFile: string;
  private readonly staleThresholdMinutes: number;

  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string,
    staleThresholdMinutes?: number,
  ) {
    this.lockFile = `${DOCKFLOW_LOCKS_DIR}/${stackName}.lock`;
    this.staleThresholdMinutes = staleThresholdMinutes ?? LOCK_STALE_THRESHOLD_MINUTES;
  }

  /**
   * Read the current lock status
   */
  async status(): Promise<Result<LockStatus, Error>> {
    try {
      const result = await sshExec(this.connection, `cat "${this.lockFile}" 2>/dev/null || echo "NO_LOCK"`);
      const output = result.stdout.trim();

      if (output === 'NO_LOCK' || !output) {
        return ok({ locked: false });
      }

      try {
        const data = JSON.parse(output) as LockData;
        const startedAt = new Date(data.started_at);
        const durationMinutes = Math.floor((Date.now() - startedAt.getTime()) / 60000);
        const isStale = durationMinutes > this.staleThresholdMinutes;

        return ok({ locked: true, data, durationMinutes, isStale });
      } catch {
        return ok({ locked: true, isStale: true });
      }
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Acquire a deployment lock atomically.
   *
   * Uses bash `set -C` (noclobber) so the redirect `>` fails if the file
   * already exists, preventing TOCTOU races between concurrent deploys.
   * Stale or forced locks are removed first, then re-acquired atomically.
   */
  async acquire(options?: { message?: string; force?: boolean; version?: string }): Promise<Result<LockData, Error>> {
    try {
      const now = new Date();
      const lockData: LockData = {
        performer: getPerformer(),
        started_at: now.toISOString(),
        timestamp: Math.floor(now.getTime() / 1000),
        version: options?.version || 'manual-lock',
        stack: this.stackName,
        message: options?.message || 'Manual lock via CLI',
      };

      const lockContent = JSON.stringify(lockData, null, 2);
      const eLockContent = shellEscape(lockContent);

      if (options?.force) {
        // Force: remove existing lock, then write
        await sshExec(
          this.connection,
          `mkdir -p "${DOCKFLOW_LOCKS_DIR}" && rm -f "${this.lockFile}" && printf '%s' '${eLockContent}' > "${this.lockFile}"`,
        );
        return ok(lockData);
      }

      // Atomic acquire: noclobber makes `>` fail if file already exists
      const result = await sshExec(
        this.connection,
        `mkdir -p "${DOCKFLOW_LOCKS_DIR}" && (set -C; printf '%s' '${eLockContent}' > "${this.lockFile}") 2>/dev/null && echo "ACQUIRED" || echo "LOCKED"`,
      );

      if (result.stdout.trim() === 'ACQUIRED') {
        return ok(lockData);
      }

      // File exists — check if stale
      const current = await this.status();
      if (current.success && current.data.locked && current.data.isStale) {
        // Stale: remove and retry atomically
        await sshExec(this.connection, `rm -f "${this.lockFile}"`);
        const retryResult = await sshExec(
          this.connection,
          `(set -C; printf '%s' '${eLockContent}' > "${this.lockFile}") 2>/dev/null && echo "ACQUIRED" || echo "LOCKED"`,
        );
        if (retryResult.stdout.trim() === 'ACQUIRED') {
          return ok(lockData);
        }
        // Another deploy won the race after we removed stale lock
        return err(new Error('Lock was stale but another deploy acquired it first'));
      }

      // Active lock held by someone else
      return err(new Error(
        current.success && current.data.data
          ? `Already locked by ${current.data.data.performer} (${current.data.durationMinutes} min ago)`
          : 'Lock file exists but could not be parsed'
      ));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Release a deployment lock
   */
  async release(): Promise<Result<void, Error>> {
    try {
      const verifyResult = await sshExec(
        this.connection,
        `rm -f "${this.lockFile}" && (test -f "${this.lockFile}" && echo "EXISTS" || echo "REMOVED")`,
      );
      if (verifyResult.stdout.trim() === 'EXISTS') {
        return err(new Error('Lock file could not be removed. Check permissions on the server.'));
      }

      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Factory function to create a LockService
 */
export function createLockService(
  connection: SSHKeyConnection,
  stackName: string,
  staleThresholdMinutes?: number,
): LockService {
  return new LockService(connection, stackName, staleThresholdMinutes);
}
