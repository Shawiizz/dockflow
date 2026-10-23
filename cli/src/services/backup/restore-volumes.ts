/**
 * Restoring a `type: volume` backup: volumes and bind mounts are restored all or none, by
 * extracting every archive beside the current contents and swapping them in by renames.
 */

import type { ClusterNode, SSHKeyConnection } from '../../types';
import { ok, err, type Result } from '../../types';
import { createHash } from 'crypto';
import { BackupError, ErrorCode } from '../../utils/errors';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printDebug } from '../../utils/output';
import {
  RESTORE_MOUNT_DIR,
  buildBackupDir,
  buildDataFilePath,
  buildDiscardScript,
  buildExtractScript,
  buildSwapScript,
  previousDirName,
} from '../backup-strategies';
import { parseMetadata } from './metadata';
import { checkArchive } from './verify';
import { SAFE_NAME, type BackupVolumeRecord } from './types';

interface RestorePlan {
  record: BackupVolumeRecord;
  /** Docker volume name or host path mounted into the helper container */
  source: string;
  file: string;
}

/** Stable per backup, so a retry cleans the directories an interrupted restore left. */
function restoreId(backupDir: string, backupId: string): string {
  return createHash('sha256').update(`${backupDir}/${backupId}`).digest('hex').slice(0, 8);
}

/**
 * Restore volumes and bind mounts from a backup, all of them or none: every archive is verified
 * and every target resolved first, then each archive is extracted beside the current contents,
 * and only when all extractions succeeded are the contents swapped by renames. A bad archive
 * or a full disk leaves every volume as it was. The service keeps running.
 */
export async function restoreVolumes(
  stackName: string,
  service: string,
  backupId: string,
  compression: 'gzip' | 'none',
  node: ClusterNode
): Promise<Result<void, Error>> {
  try {
    await restoreVolumesOn(stackName, service, backupId, compression, node);
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

async function restoreVolumesOn(
  stackName: string,
  service: string,
  backupId: string,
  compression: 'gzip' | 'none',
  node: ClusterNode,
): Promise<void> {
  const nodeConn = node.connection;
  const backupDir = buildBackupDir(stackName, service);

  const metaResult = await sshExec(nodeConn, `cat ${shellQuote(`${backupDir}/${backupId}.meta.json`)} 2>/dev/null`);
  if (!metaResult.stdout.trim()) {
    throw new BackupError(`Backup ${backupId} not found`, { code: ErrorCode.BACKUP_NOT_FOUND });
  }
  const meta = parseMetadata(metaResult.stdout.trim());
  if (!meta) {
    throw new BackupError(`Invalid backup metadata for ${backupId}`, { code: ErrorCode.RESTORE_FAILED });
  }

  const records = meta.volumes ?? [];
  if (records.length === 0) {
    throw new BackupError(`No volume information in backup metadata for ${backupId}`, { code: ErrorCode.RESTORE_FAILED });
  }
  for (const record of records) {
    if (
      typeof record.name !== 'string' || !SAFE_NAME.test(record.name) ||
      (record.mountType !== 'volume' && record.mountType !== 'bind') ||
      typeof record.sourcePath !== 'string' || !record.sourcePath
    ) {
      throw new BackupError(
        `Backup metadata for ${backupId} is missing mount information for "${String(record.name)}"; refusing to restore`,
        { code: ErrorCode.RESTORE_FAILED },
      );
    }
  }

  // every archive is verified before anything is changed
  for (const record of records) {
    const filePath = buildDataFilePath(backupDir, backupId, 'volume', compression, record.name);
    const archiveIssue = await checkArchive(nodeConn, filePath, compression, 'tar');
    if (archiveIssue) {
      throw new BackupError(
        `Backup file for ${record.mountType} ${record.name} cannot be restored: ${archiveIssue}`,
        { code: ErrorCode.RESTORE_FAILED },
      );
    }
  }

  // every target is resolved before anything is written: a missing one must not be created empty by docker run -v
  const existing = await dockerVolumeNames(nodeConn);
  const plans: RestorePlan[] = [];
  for (const record of records) {
    const source = record.mountType === 'bind'
      ? await requireBindPath(nodeConn, node, record)
      : resolveVolume(stackName, existing, record, service, node);
    plans.push({ record, source, file: buildDataFilePath(backupDir, backupId, 'volume', compression, record.name) });
  }

  const id8 = restoreId(backupDir, backupId);
  const helper = (plan: RestorePlan, script: string, interactive: boolean): string =>
    `docker run --rm ${interactive ? '-i ' : ''}-v ${shellQuote(plan.source)}:${RESTORE_MOUNT_DIR} alpine sh -c ${shellQuote(script)}`;

  const extracted: RestorePlan[] = [];
  try {
    for (const plan of plans) {
      extracted.push(plan);
      const command = helper(plan, buildExtractScript(RESTORE_MOUNT_DIR, id8), true);
      const feed = compression === 'gzip' ? `gunzip -c ${shellQuote(plan.file)}` : `cat ${shellQuote(plan.file)}`;
      const result = await sshExec(nodeConn, `${feed} | ${command}`);
      if (result.exitCode !== 0) throw extractionError(service, plan, node, result);
    }
  } catch (e) {
    for (const plan of extracted) {
      try {
        const discarded = await sshExec(nodeConn, helper(plan, buildDiscardScript(RESTORE_MOUNT_DIR, id8), false));
        if (discarded.exitCode !== 0) printDebug(`Could not clean the restore directory of ${plan.record.name}: ${discarded.stderr.trim()}`);
      } catch (cleanupError) {
        printDebug(`Could not clean the restore directory of ${plan.record.name}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    throw e;
  }

  for (const plan of plans) {
    const result = await sshExec(nodeConn, helper(plan, buildSwapScript(RESTORE_MOUNT_DIR, id8), false));
    if (result.exitCode !== 0) {
      throw new BackupError(
        `Restore of ${service} failed while swapping ${plan.record.mountType} ${plan.record.name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}; the previous contents are in ${plan.record.name}/${previousDirName(id8)}`,
        {
          code: ErrorCode.RESTORE_FAILED,
          suggestion: `Retry the restore, or move the files back from that directory on ${node.name}.`,
        },
      );
    }
  }
}

async function dockerVolumeNames(conn: SSHKeyConnection): Promise<Set<string>> {
  const result = await sshExec(conn, `docker volume ls --format '{{.Name}}'`);
  return new Set(result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

/** The Docker volume an archive goes back into: the one that was backed up, never a new empty one */
function resolveVolume(stackName: string, existing: Set<string>, record: BackupVolumeRecord, service: string, node: ClusterNode): string {
  const candidates = [record.sourcePath, `${stackName}_${record.name}`, record.name];
  const match = candidates.find(candidate => existing.has(candidate));
  if (match === undefined) {
    throw new BackupError(
      `Volume ${record.sourcePath} of service ${service} does not exist on ${node.name}; nothing was restored`,
      {
        code: ErrorCode.RESTORE_FAILED,
        suggestion: 'Deploy the service so its volume exists, then run the restore again.',
      },
    );
  }
  return match;
}

async function requireBindPath(conn: SSHKeyConnection, node: ClusterNode, record: BackupVolumeRecord): Promise<string> {
  const result = await sshExec(conn, `test -d ${shellQuote(record.sourcePath)}`);
  if (result.exitCode !== 0) {
    throw new BackupError(
      `Bind mount ${record.sourcePath} does not exist on ${node.name}; nothing was restored`,
      { code: ErrorCode.RESTORE_FAILED },
    );
  }
  return record.sourcePath;
}

function extractionError(service: string, plan: RestorePlan, node: ClusterNode, result: { exitCode: number; stderr: string }): BackupError {
  if (/No space left on device/i.test(result.stderr)) {
    return new BackupError(
      `Restore of ${service} needs room for a second copy of ${plan.record.mountType} ${plan.record.name} on ${node.name}; nothing was changed`,
      {
        code: ErrorCode.RESTORE_FAILED,
        suggestion: `Free disk space on ${node.name} and run the restore again; the current contents were kept.`,
      },
    );
  }
  return new BackupError(
    `Restore of ${service} failed while extracting ${plan.record.mountType} ${plan.record.name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}; nothing was changed`,
    { code: ErrorCode.RESTORE_FAILED },
  );
}
