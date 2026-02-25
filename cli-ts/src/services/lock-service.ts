/**
 * Lock Service
 *
 * Manages deployment locks on remote servers via SSH.
 * Used by both CLI lock commands and API lock routes.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { ok, err, type Result } from '../types';
import { DOCKFLOW_LOCKS_DIR } from '../constants';
import { LOCK_STALE_THRESHOLD_MINUTES } from '../constants';

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

  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string
  ) {
    this.lockFile = `${DOCKFLOW_LOCKS_DIR}/${stackName}.lock`;
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
        const isStale = durationMinutes > LOCK_STALE_THRESHOLD_MINUTES;

        return ok({ locked: true, data, durationMinutes, isStale });
      } catch {
        return ok({ locked: true, isStale: true });
      }
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Acquire a deployment lock
   */
  async acquire(options?: { message?: string; force?: boolean }): Promise<Result<LockData, Error>> {
    try {
      // Check for existing lock
      if (!options?.force) {
        const current = await this.status();
        if (current.success && current.data.locked) {
          return err(new Error(
            current.data.data
              ? `Already locked by ${current.data.data.performer} (${current.data.durationMinutes} min ago)`
              : 'Lock file exists but could not be parsed'
          ));
        }
      }

      const now = new Date();
      const lockData: LockData = {
        performer: `${process.env.USER || 'cli'}@${process.env.HOSTNAME || 'local'}`,
        started_at: now.toISOString(),
        timestamp: Math.floor(now.getTime() / 1000),
        version: 'manual-lock',
        stack: this.stackName,
        message: options?.message || 'Manual lock via CLI',
      };

      const lockContent = JSON.stringify(lockData, null, 2);
      await sshExec(
        this.connection,
        `mkdir -p "${DOCKFLOW_LOCKS_DIR}" && cat > "${this.lockFile}" << 'EOF'\n${lockContent}\nEOF`
      );

      return ok(lockData);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Release a deployment lock
   */
  async release(): Promise<Result<void, Error>> {
    try {
      await sshExec(this.connection, `rm -f "${this.lockFile}"`);

      // Verify removal
      const verifyResult = await sshExec(this.connection, `test -f "${this.lockFile}" && echo "EXISTS" || echo "REMOVED"`);
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
  stackName: string
): LockService {
  return new LockService(connection, stackName);
}
