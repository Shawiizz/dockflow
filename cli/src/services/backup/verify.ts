/**
 * Verifying a backup archive on the node holding it: the check run after a capture and the
 * one a restore runs before anything changes.
 */

import type { SSHKeyConnection } from '../../types';
import { BackupError, ErrorCode } from '../../utils/errors';
import { printWarning } from '../../utils/output';
import { sshExec } from '../../utils/ssh';
import { buildVerifyScript } from '../backup-strategies';
import type { ArchiveIntegrity } from '../backup-strategies';
import type { RestoreOptions } from './types';

/**
 * Verify a backup on the node holding it: null when sound, else the line naming the problem.
 * Remote pipelines exit with the last command's status, so a failed dump or tar can still
 * leave a valid-looking file; the check depends on what the backup can be checked with.
 */
export async function checkArchive(
  conn: SSHKeyConnection,
  filePath: string,
  compression: 'gzip' | 'none',
  integrity: ArchiveIntegrity,
): Promise<string | null> {
  const result = await sshExec(conn, buildVerifyScript(filePath, compression, integrity));
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (result.exitCode === 0 && lines.at(-1) === 'OK') return null;
  const reason = lines.find(line => line !== 'OK');
  if (reason !== undefined) return reason;
  const detail = result.stderr.trim().split(/\r?\n/)[0];
  return `the verification exited with code ${result.exitCode}${detail ? ` (${detail})` : ''}`;
}

/**
 * The verification a restore runs before anything changes. A backup that carries an integrity
 * marker and has lost it was truncated; --force-unverified restores it anyway, with a warning.
 * A backup of a kind that cannot be checked is restored after the basic check, as it always was.
 */
export async function verifyBeforeRestore(
  conn: SSHKeyConnection,
  filePath: string,
  compression: 'gzip' | 'none',
  integrity: ArchiveIntegrity,
  backupId: string,
  options: RestoreOptions,
): Promise<Error | null> {
  let check = integrity;
  if (integrity === 'trailer' && options.forceUnverified) {
    check = 'opaque';
    printWarning(`Restoring ${backupId} without checking its integrity marker`);
  }
  const issue = await checkArchive(conn, filePath, compression, check);
  if (issue === null) return null;
  return new BackupError(`Backup ${backupId} cannot be restored: ${issue}`, {
    code: ErrorCode.RESTORE_FAILED,
    suggestion: check === 'trailer'
      ? 'The dump looks truncated. If you have checked it yourself, run the restore again with `--force-unverified`.'
      : undefined,
  });
}
