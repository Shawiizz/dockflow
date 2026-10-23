/**
 * The `<id>.meta.json` file beside a backup's data: reading it back from a node (rejecting
 * what cannot describe a backup safely) and writing it.
 */

import type { SSHKeyConnection } from '../../types';
import type { BackupDbType } from '../../utils/config';
import { printDebug } from '../../utils/output';
import { sh, sshExec } from '../../utils/ssh';
import { ARCHIVE_INTEGRITIES } from '../backup-strategies';
import { SAFE_NAME, type BackupMetadata } from './types';

const COMPRESSIONS: ReadonlySet<string> = new Set(['gzip', 'none']);

function isBackupType(value: unknown): value is BackupDbType {
  return typeof value === 'string' && ['postgres', 'mysql', 'mongodb', 'redis', 'raw', 'volume'].includes(value);
}

/** Metadata read back from a node, or null when it cannot describe a backup safely. */
export function parseMetadata(text: string): BackupMetadata | null {
  let meta: Partial<BackupMetadata> | null;
  try {
    meta = JSON.parse(text) as Partial<BackupMetadata> | null;
  } catch (e) {
    printDebug(`Skipping malformed backup metadata: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (
    typeof meta !== 'object' || meta === null ||
    typeof meta.id !== 'string' || !SAFE_NAME.test(meta.id) ||
    typeof meta.service !== 'string' || !SAFE_NAME.test(meta.service) ||
    !isBackupType(meta.dbType) ||
    typeof meta.compression !== 'string' || !COMPRESSIONS.has(meta.compression)
  ) {
    printDebug('Skipping backup metadata without a usable id, service, type or compression');
    return null;
  }
  if (!meta.nodeHost || !meta.nodePort) {
    printDebug(`Skipping backup ${meta.id}: metadata has no node information`);
    return null;
  }
  if (meta.integrity !== undefined && !ARCHIVE_INTEGRITIES.includes(meta.integrity)) delete meta.integrity;
  return meta as BackupMetadata;
}

/** Writes `<id>.meta.json` (mode 0600) beside the data; null on success */
export async function writeMetadata(nodeConn: SSHKeyConnection, backupDir: string, metadata: BackupMetadata): Promise<Error | null> {
  const metaPath = `${backupDir}/${metadata.id}.meta.json`;
  const result = await sshExec(nodeConn, sh`umask 077 && cat > ${metaPath}`, { stdin: JSON.stringify(metadata, null, 2) });
  if (result.exitCode !== 0) {
    return new Error(`Cannot write the metadata of backup ${metadata.id}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
  return null;
}
