/**
 * Backup — manages backup and restore operations for accessory databases
 * and Docker volumes.
 *
 * Uses SSH + docker exec to run dump/restore commands inside containers,
 * and docker run with temporary Alpine containers for volume backups.
 *
 * Design: backups are stored on the node where the service runs, not necessarily
 * the manager. nodeHost/nodePort are stored in metadata so future operations
 * (restore, prune, list) can connect to the correct node directly.
 */

import type { SSHKeyConnection } from '../types';
import type { BackupDbType, BackupAccessoryConfig } from '../utils/config';
import { ok, err, type Result } from '../types';
import { sshExec, sshExecChannel, shellQuote } from '../utils/ssh';
import { formatBytes, printDebug } from '../utils/output';
import { findSwarmContainer } from './orchestrator/swarm/swarm-utils';
import { SwarmStackBackend } from './orchestrator/swarm/swarm-stack';
import { DOCKFLOW_BACKUPS_DIR } from '../constants';
import {
  DB_TYPES,
  buildArchiveCheckCommand,
  buildDumpScript,
  buildRestoreScript,
  parseContainerMounts,
  buildCapturePipeline,
  buildDataFilePath,
  buildBackupDir,
  selectBackupsToPrune,
  findBackupMatch,
} from './backup-strategies';
import type { MountInfo } from './backup-strategies';

// ─── Types ────────────────────────────────────────────────────────────────

export interface BackupBaseEntry {
  id: string;
  service: string;
  dbType: BackupDbType;
  timestamp: string;
  size: string;
  sizeBytes: number;
  compression: 'gzip' | 'none';
  /** Host of the node where this backup is stored */
  nodeHost: string;
  /** SSH port of the node where this backup is stored */
  nodePort: number;
}

/** One archive of a `type: volume` backup */
export interface BackupVolumeRecord {
  name: string;
  sizeBytes: number;
  mountType: 'volume' | 'bind';
  /** Docker volume name or host path */
  sourcePath: string;
}

export interface BackupMetadata extends BackupBaseEntry {
  durationMs: number;
  stackName: string;
  volumes?: BackupVolumeRecord[];
}

export interface BackupListEntry extends BackupBaseEntry {
  filePath: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Ids and service names end up in the paths of remote `rm` commands. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const COMPRESSIONS: ReadonlySet<string> = new Set(['gzip', 'none']);

function generateBackupId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`;
}

function isBackupType(value: unknown): value is BackupDbType {
  return typeof value === 'string' && ['postgres', 'mysql', 'mongodb', 'redis', 'raw', 'volume'].includes(value);
}

/** Metadata read back from a node, or null when it cannot describe a backup safely. */
function parseMetadata(text: string): BackupMetadata | null {
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
  return meta as BackupMetadata;
}

// ─── Backup ───────────────────────────────────────────────────────────────

export interface BackupOptions {
  /** the pause before forcing a service update after a restore stopped its server */
  sleep?: (ms: number) => Promise<void>;
}

const RESTART_PAUSE_MS = 3000;

export class Backup {
  private readonly orchestrator: SwarmStackBackend;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    /** Manager connection — used for Swarm operations (service restart) */
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string,
    /** All node connections — used to find containers and run backup/restore on any node */
    private readonly allConnections: SSHKeyConnection[] = [],
    options: BackupOptions = {}
  ) {
    this.orchestrator = new SwarmStackBackend(connection);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private findContainer(service: string) {
    return findSwarmContainer(this.stackName, service, this.connection, this.allConnections);
  }

  private getBackupDir(service: string): string {
    return buildBackupDir(this.stackName, service);
  }

  /** Derive the data file path from metadata */
  private getDataFilePath(
    backupDir: string,
    id: string,
    dbType: BackupDbType,
    compression: 'gzip' | 'none',
    volumeName?: string
  ): string {
    return buildDataFilePath(backupDir, id, dbType, compression, volumeName);
  }

  /**
   * Verify a backup archive: returns null when it is valid and non-empty,
   * or a human-readable problem description otherwise. Remote pipelines exit
   * with the last command's status, so a failed dump/tar can still produce a
   * valid-but-empty archive, and a container dying mid-dump a truncated one.
   */
  private async checkArchive(
    conn: SSHKeyConnection,
    filePath: string,
    compression: 'gzip' | 'none',
  ): Promise<string | null> {
    const result = await sshExec(conn, buildArchiveCheckCommand(filePath, compression));
    const verdict = result.stdout.trim();
    if (verdict === 'OK') return null;
    if (verdict === 'EMPTY') return 'the archive is empty';
    if (verdict === 'CORRUPT') return 'the archive is corrupt, truncated or missing';
    return `archive check failed (${verdict || `exit ${result.exitCode}`})`;
  }

  /**
   * Resolve the node connection for a backup entry by matching nodeHost/nodePort.
   * Falls back to the manager connection if no match found.
   */
  private resolveNodeConnection(entry: { nodeHost: string; nodePort: number }): SSHKeyConnection {
    const all = [this.connection, ...this.allConnections];
    return all.find(c => c.host === entry.nodeHost && c.port === entry.nodePort)
      ?? this.connection;
  }

  /**
   * Create a backup of an accessory service.
   * The backup file is written on the node where the container runs.
   */
  async backup(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none' = 'gzip'
  ): Promise<Result<BackupMetadata, Error>> {
    const found = await this.findContainer(service);
    if (!found) {
      return err(new Error(`No running container found for service ${service}`));
    }
    const { containerId, connection: nodeConn } = found;
    const dbType = config.type;

    // Volume backup uses a different flow (docker run instead of docker exec)
    if (dbType === 'volume') {
      return this.backupVolumes(service, containerId, nodeConn, config, compression);
    }

    const backupId = generateBackupId();
    const backupDir = this.getBackupDir(service);

    let dumpScript: string;
    try {
      dumpScript = buildDumpScript(config);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    const filePath = this.getDataFilePath(backupDir, backupId, dbType, compression);

    const startTime = Date.now();

    const dockerExec = `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(dumpScript)}`;
    const result = await sshExec(nodeConn, buildCapturePipeline(dockerExec, filePath, compression === 'gzip'));
    if (result.exitCode !== 0) {
      await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
      return err(new Error(`Backup failed: ${result.stderr}`));
    }

    const archiveIssue = await this.checkArchive(nodeConn, filePath, compression);
    if (archiveIssue) {
      await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
      return err(new Error(
        `Backup verification failed: ${archiveIssue}${result.stderr.trim() ? ` (dump stderr: ${result.stderr.trim()})` : ''}`,
      ));
    }

    const durationMs = Date.now() - startTime;

    // Get file size
    const sizeCmd = `SIZE=$(stat -c %s ${shellQuote(filePath)} 2>/dev/null || echo 0) && echo $SIZE`;
    const sizeResult = await sshExec(nodeConn, sizeCmd);
    const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;

    const metadata: BackupMetadata = {
      id: backupId,
      service,
      dbType,
      timestamp: new Date().toISOString(),
      size: formatBytes(sizeBytes),
      sizeBytes,
      compression,
      durationMs,
      stackName: this.stackName,
      nodeHost: nodeConn.host,
      nodePort: nodeConn.port,
    };

    const writeError = await this.writeMetadata(nodeConn, backupDir, metadata);
    if (writeError) {
      await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
      return err(writeError);
    }

    return ok(metadata);
  }

  /** Writes `<id>.meta.json` (mode 0600) beside the data; null on success */
  private async writeMetadata(nodeConn: SSHKeyConnection, backupDir: string, metadata: BackupMetadata): Promise<Error | null> {
    const metaPath = `${backupDir}/${metadata.id}.meta.json`;
    const { stream, done } = await sshExecChannel(nodeConn, `umask 077 && cat > ${shellQuote(metaPath)}`);
    stream.end(JSON.stringify(metadata, null, 2));
    const result = await done;
    if (result.exitCode !== 0) {
      return new Error(`Cannot write the metadata of backup ${metadata.id}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    return null;
  }

  // ─── Volume Backup ───────────────────────────────────────────────────────

  /** Discover named Docker volumes and read-write bind mounts on a container */
  private async getContainerMounts(
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
      return parseContainerMounts(result.stdout, this.stackName, excludePatterns, includeBindMounts);
    } catch (e) {
      printDebug(`Failed to parse container mounts for ${containerId}: ${e}`);
      return [];
    }
  }

  /** Backup all named volumes and bind mounts for a service container */
  private async backupVolumes(
    service: string,
    containerId: string,
    nodeConn: SSHKeyConnection,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none'
  ): Promise<Result<BackupMetadata, Error>> {
    const mounts = await this.getContainerMounts(containerId, nodeConn, config.exclude_volumes, config.include_bind_mounts !== false);
    if (mounts.length === 0) {
      return err(new Error(`No volumes or bind mounts found for service ${service}`));
    }

    const backupId = generateBackupId();
    const backupDir = this.getBackupDir(service);

    const startTime = Date.now();

    // Build all file paths upfront for reliable cleanup
    const filePaths = mounts.map(m => this.getDataFilePath(backupDir, backupId, 'volume', compression, m.name));

    // Backup all volumes in parallel (independent SSH calls, all on nodeConn)
    const backupResults = await Promise.all(mounts.map(async (mount, i) => {
      const filePath = filePaths[i];

      // Named volumes: tar via temporary alpine container
      // Bind mounts: tar the host path directly
      const tarCmd = mount.mountType === 'volume'
        ? `docker run --rm -v ${shellQuote(mount.source)}:/backup-source:ro alpine tar cf - -C /backup-source .`
        : `tar cf - -C ${shellQuote(mount.source)} .`;

      const result = await sshExec(nodeConn, buildCapturePipeline(tarCmd, filePath, compression === 'gzip'));
      if (result.exitCode !== 0) {
        return { ok: false as const, mount, error: result.stderr };
      }

      // Same pipeline pitfall as db dumps: a failed tar still exits through
      // gzip with status 0. A legitimate tar is never empty (trailer blocks).
      const archiveIssue = await this.checkArchive(nodeConn, filePath, compression);
      if (archiveIssue) {
        return { ok: false as const, mount, error: `${archiveIssue}${result.stderr.trim() ? ` (${result.stderr.trim()})` : ''}` };
      }

      const sizeCmd = `stat -c %s ${shellQuote(filePath)} 2>/dev/null || echo 0`;
      const sizeResult = await sshExec(nodeConn, sizeCmd);
      const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;
      return { ok: true as const, mount, sizeBytes };
    }));

    // Check for failures — clean up all files for this backup ID on any error
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

    const metadata: BackupMetadata = {
      id: backupId,
      service,
      dbType: 'volume',
      timestamp: new Date().toISOString(),
      size: formatBytes(totalSizeBytes),
      sizeBytes: totalSizeBytes,
      compression,
      durationMs,
      stackName: this.stackName,
      nodeHost: nodeConn.host,
      nodePort: nodeConn.port,
    };

    const writeError = await this.writeMetadata(nodeConn, backupDir, { ...metadata, volumes: volumeEntries });
    if (writeError) {
      await sshExec(nodeConn, `rm -f ${filePaths.map(f => shellQuote(f)).join(' ')}`);
      return err(writeError);
    }

    return ok(metadata);
  }

  /** Restore volumes and bind mounts from a backup */
  private async restoreVolumes(
    service: string,
    backupId: string,
    compression: 'gzip' | 'none',
    nodeConn: SSHKeyConnection
  ): Promise<Result<void, Error>> {
    const backupDir = this.getBackupDir(service);

    // Read metadata to get volume/bind mount names
    const metaPath = `${backupDir}/${backupId}.meta.json`;
    const metaResult = await sshExec(nodeConn, `cat ${shellQuote(metaPath)} 2>/dev/null`);
    if (!metaResult.stdout.trim()) {
      return err(new Error(`Backup ${backupId} not found`));
    }

    const meta = parseMetadata(metaResult.stdout.trim());
    if (!meta) {
      return err(new Error(`Invalid backup metadata for ${backupId}`));
    }

    const volumeEntries = meta.volumes ?? [];
    if (volumeEntries.length === 0) {
      return err(new Error(`No volume information in backup metadata for ${backupId}`));
    }

    // List existing Docker volumes to resolve short names for volume mounts
    const volListResult = await sshExec(
      nodeConn,
      `docker volume ls --filter "label=com.docker.stack.namespace=${this.stackName}" --format "{{.Name}}"`
    );
    const existingVolumes = volListResult.stdout.trim().split('\n').filter(Boolean);

    const restoreTasks: { entry: typeof volumeEntries[number]; fullCommand: string }[] = [];

    for (const entry of volumeEntries) {
      const filePath = this.getDataFilePath(backupDir, backupId, 'volume', compression, entry.name);
      const { mountType } = entry;

      if (!mountType || (mountType === 'bind' && !entry.sourcePath)) {
        return err(new Error(
          `Backup metadata for ${backupId} is missing mount information for "${entry.name}" — refusing to restore`,
        ));
      }

      // The restore commands wipe the target before extracting — make sure
      // the source archive is sound before destroying anything.
      const archiveIssue = await this.checkArchive(nodeConn, filePath, compression);
      if (archiveIssue) {
        return err(new Error(
          `Backup file for ${mountType} ${entry.name} cannot be restored: ${archiveIssue}`,
        ));
      }

      let restoreCmd: string;
      if (mountType === 'bind') {
        // Bind mount: clear target and extract directly on the host
        const src = shellQuote(entry.sourcePath);
        restoreCmd = `find ${src} -mindepth 1 -delete && tar xf - -C ${src}`;
      } else {
        // Named volume: extract via temporary alpine container
        const fullVolumeName = existingVolumes.find(
          v => v === entry.name || v === `${this.stackName}_${entry.name}`
        ) || `${this.stackName}_${entry.name}`;
        restoreCmd = `docker run --rm -i -v ${shellQuote(fullVolumeName)}:/backup-target alpine sh -c 'rm -rf /backup-target/* /backup-target/..?* /backup-target/.[!.]* 2>/dev/null; tar xf - -C /backup-target'`;
      }

      const fullCommand = compression === 'gzip'
        ? `gunzip -c ${shellQuote(filePath)} | ${restoreCmd}`
        : `cat ${shellQuote(filePath)} | ${restoreCmd}`;

      restoreTasks.push({ entry, fullCommand });
    }

    const restoreResults = await Promise.allSettled(
      restoreTasks.map(({ fullCommand }) => sshExec(nodeConn, fullCommand)),
    );

    for (let i = 0; i < restoreResults.length; i++) {
      const r = restoreResults[i];
      const { entry } = restoreTasks[i];
      const { mountType } = entry;
      if (r.status === 'rejected') {
        return err(new Error(`Restore failed for ${mountType} ${entry.name}: ${r.reason?.message ?? 'unknown'}`));
      }
      if (r.value.exitCode !== 0) {
        return err(new Error(`Restore failed for ${mountType} ${entry.name}: ${r.value.stderr}`));
      }
    }

    return ok(undefined);
  }

  /**
   * List available backups.
   * Queries all node connections in parallel and aggregates results.
   */
  async list(service?: string): Promise<Result<BackupListEntry[], Error>> {
    const allConns = [this.connection, ...this.allConnections.filter(
      c => !(c.host === this.connection.host && c.port === this.connection.port)
    )];

    const SEP = '---DOCKFLOW_META_SEP---';

    const perNodeResults = await Promise.all(allConns.map(async (conn) => {
      const baseDir = service
        ? this.getBackupDir(service)
        : `${DOCKFLOW_BACKUPS_DIR}/${this.stackName}`;
      const findCmd = `find ${shellQuote(baseDir)} -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${SEP}'; cat "$f"; done`;
      const result = await sshExec(conn, findCmd);
      return result.stdout;
    }));

    const entries: BackupListEntry[] = [];
    const seenIds = new Set<string>();

    for (const stdout of perNodeResults) {
      if (!stdout.trim()) continue;
      const chunks = stdout.split(SEP).filter(c => c.trim());

      for (const chunk of chunks) {
        const meta = parseMetadata(chunk.trim());
        if (!meta) continue;

        // Deduplicate: same backup ID may appear on multiple nodes if replicated
        if (seenIds.has(meta.id)) continue;
        seenIds.add(meta.id);

        const dir = this.getBackupDir(meta.service);
        const volumeName = meta.dbType === 'volume' && meta.volumes?.length
          ? meta.volumes[0].name
          : undefined;
        const dataFile = this.getDataFilePath(dir, meta.id, meta.dbType, meta.compression, volumeName);

        entries.push({
          id: meta.id,
          service: meta.service,
          dbType: meta.dbType,
          timestamp: meta.timestamp,
          size: meta.size,
          sizeBytes: meta.sizeBytes,
          compression: meta.compression,
          filePath: dataFile,
          nodeHost: meta.nodeHost,
          nodePort: meta.nodePort,
        });
      }
    }

    // Sort newest-first across all nodes
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return ok(entries);
  }

  /**
   * Restore from a backup.
   * Connects to the node where the backup was created (stored in metadata).
   */
  async restore(
    service: string,
    backupId: string,
    config: BackupAccessoryConfig,
    compression?: 'gzip' | 'none'
  ): Promise<Result<void, Error>> {
    const dbType = config.type;

    // First resolve which node has this backup
    const listResult = await this.list(service);
    if (!listResult.success) return err(listResult.error);

    const entry = listResult.data.find(e => e.id === backupId);
    if (!entry) {
      return err(new Error(`Backup ${backupId} not found`));
    }

    const nodeConn = this.resolveNodeConnection(entry);
    const backupDir = this.getBackupDir(service);

    // Determine compression from argument or metadata
    const backupCompression = compression ?? entry.compression;

    // Volume restore uses a different flow (docker run instead of docker exec)
    if (dbType === 'volume') {
      return this.restoreVolumes(service, backupId, backupCompression, nodeConn);
    }

    const found = await this.findContainer(service);
    if (!found) {
      return err(new Error(`No running container found for service ${service}`));
    }
    const { containerId } = found;

    const dataFile = this.getDataFilePath(backupDir, backupId, dbType, backupCompression);

    // Refuse to stream an empty/corrupt backup into the database — for
    // postgres/mysql an empty stream would be a silent no-op "success",
    // and file-overwriting restores (redis) would destroy the live data.
    const archiveIssue = await this.checkArchive(nodeConn, dataFile, backupCompression);
    if (archiveIssue) {
      return err(new Error(`Backup ${backupId} cannot be restored: ${archiveIssue}`));
    }

    let restoreScript: string;
    try {
      restoreScript = buildRestoreScript(config);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    // Backup file and container are on the same node — backups are created
    // via docker exec on the container's node, so the file is always local.
    const dockerExec = `docker exec -i ${shellQuote(containerId)} sh -c ${shellQuote(restoreScript)}`;
    const fullCommand = backupCompression === 'gzip'
      ? `gunzip -c ${shellQuote(dataFile)} | ${dockerExec}`
      : `cat ${shellQuote(dataFile)} | ${dockerExec}`;

    const result = await sshExec(nodeConn, fullCommand);

    // For strategies that kill the container as part of restore (e.g. Redis SHUTDOWN NOSAVE),
    // a non-zero exit from docker exec is expected — the process died mid-exec.
    // Only treat it as an error if there's actual stderr output.
    const restoreKillsContainer = DB_TYPES[dbType].requiresServiceRestart;
    const detail = result.stderr.trim();
    if (result.exitCode !== 0 && (!restoreKillsContainer || detail)) {
      return err(new Error(`Restore failed: ${detail || `exit code ${result.exitCode}`}`));
    }

    // If the restore killed the container (e.g. Redis SHUTDOWN NOSAVE):
    // Swarm's restart_policy brings it back automatically in most cases.
    // We also force a service update as a safety net for setups where the restart
    // policy is disabled or exhausted — non-fatal if it fails.
    if (restoreKillsContainer) {
      await this.sleep(RESTART_PAUSE_MS);
      try {
        await this.orchestrator.restart(this.stackName, service);
      } catch (e) {
        printDebug(`Service update after restore failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return ok(undefined);
  }

  /**
   * Prune old backups keeping only the last N (batched deletion).
   * Deletes files on the node where each backup is stored.
   * Accepts optional pre-fetched entries to avoid a redundant SSH call.
   */
  async prune(
    service: string | undefined,
    retentionCount: number,
    prefetchedEntries?: BackupListEntry[]
  ): Promise<Result<number, Error>> {
    let entries: BackupListEntry[];
    if (prefetchedEntries) {
      entries = prefetchedEntries;
    } else {
      const listResult = await this.list(service);
      if (!listResult.success) return err(listResult.error);
      entries = listResult.data;
    }

    // Defensive sort newest-first, keep the most recent retentionCount
    const toRemove = selectBackupsToPrune(entries, retentionCount);
    if (toRemove.length === 0) {
      return ok(0);
    }

    // Group by node to batch rm calls per node
    const byNode = new Map<string, { conn: SSHKeyConnection; paths: string[] }>();
    for (const entry of toRemove) {
      const nodeConn = this.resolveNodeConnection(entry);
      const key = `${nodeConn.host}:${nodeConn.port}`;
      if (!byNode.has(key)) byNode.set(key, { conn: nodeConn, paths: [] });
      const node = byNode.get(key)!;
      const backupDir = this.getBackupDir(entry.service);
      if (entry.dbType === 'volume') {
        node.paths.push(`${shellQuote(backupDir)}/${entry.id}.*.tar*`);
      } else {
        node.paths.push(shellQuote(entry.filePath));
      }
      node.paths.push(shellQuote(`${backupDir}/${entry.id}.meta.json`));
    }

    await Promise.all([...byNode.values()].map(({ conn, paths }) =>
      sshExec(conn, `rm -f ${paths.join(' ')}`)
    ));

    return ok(toRemove.length);
  }

  /**
   * Resolve a backup by ID prefix or "latest"
   */
  async resolveBackup(
    service: string,
    idOrLatest?: string
  ): Promise<Result<BackupListEntry, Error>> {
    const listResult = await this.list(service);
    if (!listResult.success) return err(listResult.error);

    const entries = listResult.data;
    if (entries.length === 0) {
      return err(new Error(`No backups found for service ${service}`));
    }

    const match = findBackupMatch(entries, idOrLatest);
    if (!match) {
      return err(new Error(`No backup matching "${idOrLatest}" found for service ${service}`));
    }

    return ok(match);
  }
}

/**
 * Factory function
 */
export function createBackup(
  connection: SSHKeyConnection,
  stackName: string,
  allConnections: SSHKeyConnection[] = []
): Backup {
  return new Backup(connection, stackName, allConnections);
}
