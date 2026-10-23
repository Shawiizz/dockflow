/**
 * Taking a backup on the node where the container runs: the database dump pipeline, the
 * volume and bind-mount archives, and the metadata recorded for each.
 */

import type { SSHKeyConnection } from '../../types';
import type { BackupAccessoryConfig } from '../../utils/config';
import { ok, err, type Result } from '../../types';
import { shellQuote, sshExec } from '../../utils/ssh';
import { formatBytes, printDebug, printWarning } from '../../utils/output';
import {
  buildBackupDir,
  buildCapturePipeline,
  buildDataFilePath,
  buildDumpScript,
  backupEpochMs,
  integrityOf,
  parseContainerMounts,
} from '../backup-strategies';
import type { MountInfo } from '../backup-strategies';
import { writeMetadata } from './metadata';
import { checkArchive } from './verify';
import type { BackupListEntry, BackupMetadata } from './types';

function generateBackupId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`;
}

/**
 * Dump a database service into a file on the node where its container runs.
 * `storedBackups` lists the backups already there, which the new one must sort after.
 */
export async function backupDatabase(
  stackName: string,
  service: string,
  containerId: string,
  nodeConn: SSHKeyConnection,
  config: BackupAccessoryConfig,
  compression: 'gzip' | 'none',
  storedBackups: () => Promise<BackupListEntry[]>,
): Promise<Result<BackupMetadata, Error>> {
  const dbType = config.type;
  const backupId = generateBackupId();
  const backupDir = buildBackupDir(stackName, service);

  let dumpScript: string;
  try {
    dumpScript = buildDumpScript(config, compression);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const filePath = buildDataFilePath(backupDir, backupId, dbType, compression);

  const startTime = Date.now();
  const stored = storedBackups();

  const dockerExec = `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(dumpScript)}`;
  const result = await sshExec(nodeConn, buildCapturePipeline(dockerExec, filePath, compression === 'gzip'));
  if (result.exitCode !== 0) {
    await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
    return err(new Error(`Backup failed: ${result.stderr}`));
  }

  const integrity = integrityOf(config, compression);
  const archiveIssue = await checkArchive(nodeConn, filePath, compression, integrity);
  if (archiveIssue) {
    await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
    return err(new Error(
      `Backup verification failed: ${archiveIssue}${result.stderr.trim() ? ` (dump stderr: ${result.stderr.trim()})` : ''}`,
    ));
  }

  const durationMs = Date.now() - startTime;

  const sizeCmd = `SIZE=$(stat -c %s ${shellQuote(filePath)} 2>/dev/null || echo 0) && echo $SIZE`;
  const sizeResult = await sshExec(nodeConn, sizeCmd);
  const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;

  const now = new Date();
  const metadata: BackupMetadata = {
    id: backupId,
    service,
    dbType,
    timestamp: now.toISOString(),
    epochMs: backupEpochMs(now, await stored),
    size: formatBytes(sizeBytes),
    sizeBytes,
    compression,
    integrity,
    durationMs,
    stackName,
    nodeHost: nodeConn.host,
    nodePort: nodeConn.port,
  };

  const writeError = await writeMetadata(nodeConn, backupDir, metadata);
  if (writeError) {
    await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
    return err(writeError);
  }

  if (integrity === 'opaque') {
    printWarning(
      `Backup ${backupId} of ${service} cannot be verified before a restore: nothing in it tells a complete dump from a truncated one. ` +
      'Set compression: gzip for this service to have it checked.',
    );
  }

  return ok(metadata);
}

/** Discover named Docker volumes and read-write bind mounts on a container */
async function getContainerMounts(
  stackName: string,
  containerId: string,
  nodeConn: SSHKeyConnection,
  excludePatterns?: string[],
  includeBindMounts: boolean = true
): Promise<MountInfo[]> {
  const result = await sshExec(
    nodeConn,
    `docker inspect --format '{{json .Mounts}}' ${shellQuote(containerId)}`
  );

  try {
    return parseContainerMounts(result.stdout, stackName, excludePatterns, includeBindMounts);
  } catch (e) {
    printDebug(`Failed to parse container mounts for ${containerId}: ${e}`);
    return [];
  }
}

export async function backupVolumes(
  stackName: string,
  service: string,
  containerId: string,
  nodeConn: SSHKeyConnection,
  config: BackupAccessoryConfig,
  compression: 'gzip' | 'none',
  storedBackups: () => Promise<BackupListEntry[]>,
): Promise<Result<BackupMetadata, Error>> {
  const mounts = await getContainerMounts(stackName, containerId, nodeConn, config.exclude_volumes, config.include_bind_mounts !== false);
  if (mounts.length === 0) {
    return err(new Error(`No volumes or bind mounts found for service ${service}`));
  }

  const backupId = generateBackupId();
  const backupDir = buildBackupDir(stackName, service);

  const startTime = Date.now();
  const stored = storedBackups();

  // known upfront so every file can be removed if any archive fails
  const filePaths = mounts.map(m => buildDataFilePath(backupDir, backupId, 'volume', compression, m.name));

  // the archives are independent, so they run in parallel
  const backupResults = await Promise.all(mounts.map(async (mount, i) => {
    const filePath = filePaths[i];

    // a named volume is archived from a temporary alpine container, a bind mount from its host path
    const tarCmd = mount.mountType === 'volume'
      ? `docker run --rm -v ${shellQuote(mount.source)}:/backup-source:ro alpine tar cf - -C /backup-source .`
      : `tar cf - -C ${shellQuote(mount.source)} .`;

    const result = await sshExec(nodeConn, buildCapturePipeline(tarCmd, filePath, compression === 'gzip'));
    if (result.exitCode !== 0) {
      return { ok: false as const, mount, error: result.stderr };
    }

    // same pipeline pitfall as db dumps: a failed tar still exits through gzip with status 0;
    // a legitimate tar is never empty (it has trailer blocks)
    const archiveIssue = await checkArchive(nodeConn, filePath, compression, 'tar');
    if (archiveIssue) {
      return { ok: false as const, mount, error: `${archiveIssue}${result.stderr.trim() ? ` (${result.stderr.trim()})` : ''}` };
    }

    const sizeCmd = `stat -c %s ${shellQuote(filePath)} 2>/dev/null || echo 0`;
    const sizeResult = await sshExec(nodeConn, sizeCmd);
    const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;
    return { ok: true as const, mount, sizeBytes };
  }));

  // one failure removes every file of this backup id
  const failed = backupResults.find(r => !r.ok);
  if (failed) {
    const cleanupPaths = filePaths.map(f => shellQuote(f)).join(' ');
    await sshExec(nodeConn, `rm -f ${cleanupPaths}`);
    return err(new Error(`Backup failed for ${failed.mount.mountType} ${failed.mount.source}: ${failed.error}`));
  }

  let totalSizeBytes = 0;
  const volumeEntries: { name: string; sizeBytes: number; mountType: 'volume' | 'bind'; sourcePath: string }[] = [];
  for (const r of backupResults) {
    if (r.ok) {
      totalSizeBytes += r.sizeBytes;
      volumeEntries.push({ name: r.mount.name, sizeBytes: r.sizeBytes, mountType: r.mount.mountType, sourcePath: r.mount.source });
    }
  }

  const durationMs = Date.now() - startTime;

  const now = new Date();
  const metadata: BackupMetadata = {
    id: backupId,
    service,
    dbType: 'volume',
    timestamp: now.toISOString(),
    epochMs: backupEpochMs(now, await stored),
    size: formatBytes(totalSizeBytes),
    sizeBytes: totalSizeBytes,
    compression,
    integrity: 'tar',
    durationMs,
    stackName,
    nodeHost: nodeConn.host,
    nodePort: nodeConn.port,
  };

  const writeError = await writeMetadata(nodeConn, backupDir, { ...metadata, volumes: volumeEntries });
  if (writeError) {
    await sshExec(nodeConn, `rm -f ${filePaths.map(f => shellQuote(f)).join(' ')}`);
    return err(writeError);
  }

  return ok(metadata);
}
