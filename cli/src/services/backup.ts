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

import type { ClusterNode, SSHKeyConnection } from '../types';
import type { BackupDbType, BackupAccessoryConfig } from '../utils/config';
import { ok, err, type Result } from '../types';
import { BackupError, ErrorCode, ValidationError } from '../utils/errors';
import { sshExec, sshExecChannel, shellQuote } from '../utils/ssh';
import { formatBytes, printDebug, printInfo, printWarning } from '../utils/output';
import { findSwarmContainer } from './orchestrator/swarm/swarm-utils';
import { SwarmStackBackend } from './orchestrator/swarm/swarm-stack';
import { BACKUP_ORPHAN_GRACE_H, DOCKFLOW_BACKUPS_DIR } from '../constants';
import {
  DB_TYPES,
  ARCHIVE_INTEGRITIES,
  buildDumpScript,
  buildRestoreScript,
  buildVerifyScript,
  integrityOf,
  recordedIntegrity,
  parseContainerMounts,
  parseRestoreRefusal,
  stripRefusalMarker,
  buildCapturePipeline,
  buildDataFilePath,
  buildBackupDir,
  backupEpochMs,
  newestBackupFirst,
  selectBackupsToPrune,
  findBackupMatch,
} from './backup-strategies';
import type { ArchiveIntegrity, MountInfo } from './backup-strategies';

// ─── Types ────────────────────────────────────────────────────────────────

export interface BackupBaseEntry {
  id: string;
  service: string;
  dbType: BackupDbType;
  timestamp: string;
  /** What orders the backups (backupEpochMs); absent in metadata written before it, the timestamp orders those */
  epochMs?: number;
  size: string;
  sizeBytes: number;
  compression: 'gzip' | 'none';
  /** The check the backup got when it was taken; absent in metadata written before it existed */
  integrity?: ArchiveIntegrity;
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
  /** Name of the server the backup was listed on */
  node: string;
}

export interface BackupListing {
  /** newest first */
  entries: BackupListEntry[];
  /** servers with SSH credentials that did not answer; backups stored there are not listed */
  unreachable: ClusterNode[];
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
  if (meta.integrity !== undefined && !ARCHIVE_INTEGRITIES.includes(meta.integrity)) delete meta.integrity;
  return meta as BackupMetadata;
}

// ─── Backup ───────────────────────────────────────────────────────────────

export interface PruneReport {
  /** backups removed by retention (data files and metadata) */
  removed: number;
  /** data files left by interrupted backups: no metadata, older than BACKUP_ORPHAN_GRACE_H */
  orphanFiles: number;
  bytesFreed: number;
}

export interface RestoreOptions {
  /** restore a dump whose integrity marker is missing after checking it by other means */
  forceUnverified: boolean;
}

export interface BackupOptions {
  /** the pause before forcing a service update after a restore stopped its server */
  sleep?: (ms: number) => Promise<void>;
}

const RESTART_PAUSE_MS = 3000;

export class Backup {
  private readonly orchestrator: SwarmStackBackend;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The manager first, then every other server with SSH credentials */
  private readonly nodes: ClusterNode[];

  constructor(
    /** Manager connection — used for Swarm operations (service restart) */
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string,
    /** Every server with SSH credentials — used to find containers and the backups on any node */
    nodes: ClusterNode[] = [],
    options: BackupOptions = {}
  ) {
    this.orchestrator = new SwarmStackBackend(connection);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const same = (a: SSHKeyConnection, b: SSHKeyConnection) => a.host === b.host && a.port === b.port;
    const manager = nodes.find(node => same(node.connection, connection)) ?? { name: connection.host, connection };
    this.nodes = [manager, ...nodes.filter(node => !same(node.connection, connection))];
  }

  private findContainer(service: string) {
    return findSwarmContainer(this.stackName, service, this.connection, this.nodes.map(node => node.connection));
  }

  /** Every node, or the one `--node` names */
  private nodesFor(name: string | undefined): ClusterNode[] {
    if (name === undefined) return this.nodes;
    const node = this.nodes.find(candidate => candidate.name === name);
    if (!node) {
      throw new ValidationError(
        `Server ${name} is not a server of this environment with SSH credentials`,
        `Pass one of: ${this.nodes.map(candidate => candidate.name).join(', ')}.`,
      );
    }
    return [node];
  }

  /** The node holding a backup: the one it was listed on, else the host its metadata recorded */
  private nodeOf(entry: { node?: string; nodeHost: string; nodePort: number; id: string }): ClusterNode {
    const node = this.nodes.find(candidate => candidate.name === entry.node)
      ?? this.nodes.find(candidate => candidate.connection.host === entry.nodeHost && candidate.connection.port === entry.nodePort);
    if (!node) {
      throw new BackupError(
        `Backup ${entry.id} is stored on ${entry.nodeHost}:${entry.nodePort}, which is not a server of this environment with SSH credentials`,
        { code: ErrorCode.BACKUP_NOT_FOUND },
      );
    }
    return node;
  }

  /** The backups of a service on the nodes that answer, which a new backup must sort after */
  private async storedBackups(service: string): Promise<BackupListEntry[]> {
    try {
      const listed = await this.list(service);
      return listed.success ? listed.data.entries : [];
    } catch (e) {
      printDebug(`Stored backups of ${service} could not be listed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
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
   * Verify a backup on the node holding it: null when sound, else the line naming the problem.
   * Remote pipelines exit with the last command's status, so a failed dump or tar can still
   * leave a valid-looking file; the check depends on what the backup can be checked with.
   */
  private async checkArchive(
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
      return err(new BackupError(`No running container found for service ${service}`, { code: ErrorCode.CONTAINER_NOT_FOUND }));
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
      dumpScript = buildDumpScript(config, compression);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    const filePath = this.getDataFilePath(backupDir, backupId, dbType, compression);

    const startTime = Date.now();
    const stored = this.storedBackups(service);

    const dockerExec = `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(dumpScript)}`;
    const result = await sshExec(nodeConn, buildCapturePipeline(dockerExec, filePath, compression === 'gzip'));
    if (result.exitCode !== 0) {
      await sshExec(nodeConn, `rm -f ${shellQuote(filePath)}`);
      return err(new Error(`Backup failed: ${result.stderr}`));
    }

    const integrity = integrityOf(config, compression);
    const archiveIssue = await this.checkArchive(nodeConn, filePath, compression, integrity);
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
      stackName: this.stackName,
      nodeHost: nodeConn.host,
      nodePort: nodeConn.port,
    };

    const writeError = await this.writeMetadata(nodeConn, backupDir, metadata);
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
    const stored = this.storedBackups(service);

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
      const archiveIssue = await this.checkArchive(nodeConn, filePath, compression, 'tar');
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
      const archiveIssue = await this.checkArchive(nodeConn, filePath, compression, 'tar');
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
   * List available backups, newest first.
   * Queries every node in parallel; a node that does not answer is reported in `unreachable`,
   * never skipped silently.
   */
  async list(service?: string, options: { node?: string } = {}): Promise<Result<BackupListing, Error>> {
    let nodes: ClusterNode[];
    try {
      nodes = this.nodesFor(options.node);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    const SEP = '---DOCKFLOW_META_SEP---';
    const baseDir = service
      ? this.getBackupDir(service)
      : `${DOCKFLOW_BACKUPS_DIR}/${this.stackName}`;
    const findCmd = `find ${shellQuote(baseDir)} -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${SEP}'; cat "$f"; done`;

    const answers = await Promise.all(nodes.map(async (node) => {
      try {
        return { node, stdout: (await sshExec(node.connection, findCmd)).stdout };
      } catch (e) {
        printDebug(`Backups on ${node.name} could not be listed: ${e instanceof Error ? e.message : String(e)}`);
        return { node, stdout: null };
      }
    }));

    const entries: BackupListEntry[] = [];
    const unreachable: ClusterNode[] = [];
    const seenIds = new Set<string>();

    for (const { node, stdout } of answers) {
      if (stdout === null) {
        unreachable.push(node);
        continue;
      }
      for (const chunk of stdout.split(SEP)) {
        if (!chunk.trim()) continue;
        const meta = parseMetadata(chunk.trim());
        if (!meta) continue;

        // Deduplicate: same backup ID may appear on multiple nodes if replicated
        if (seenIds.has(meta.id)) continue;
        seenIds.add(meta.id);

        const dir = this.getBackupDir(meta.service);
        const volumeName = meta.dbType === 'volume' && meta.volumes?.length
          ? meta.volumes[0].name
          : undefined;

        entries.push({
          id: meta.id,
          service: meta.service,
          dbType: meta.dbType,
          timestamp: meta.timestamp,
          epochMs: typeof meta.epochMs === 'number' ? meta.epochMs : undefined,
          size: meta.size,
          sizeBytes: meta.sizeBytes,
          compression: meta.compression,
          integrity: meta.integrity,
          filePath: this.getDataFilePath(dir, meta.id, meta.dbType, meta.compression, volumeName),
          nodeHost: meta.nodeHost,
          nodePort: meta.nodePort,
          node: node.name,
        });
      }
    }

    entries.sort(newestBackupFirst);

    return ok({ entries, unreachable });
  }

  /**
   * Restore from a backup.
   * `backup` is an id to look up on every node, or the entry resolveBackup already found, which
   * spares a second round of listings (and the wait for a node that does not answer).
   * Connects to the node holding the backup.
   */
  async restore(
    service: string,
    backup: string | BackupListEntry,
    config: BackupAccessoryConfig,
    compression?: 'gzip' | 'none',
    options: RestoreOptions = { forceUnverified: false },
  ): Promise<Result<void, Error>> {
    const dbType = config.type;

    let entry: BackupListEntry;
    let nodeConn: SSHKeyConnection;
    try {
      entry = typeof backup === 'string' ? await this.listedEntry(service, backup) : backup;
      nodeConn = this.nodeOf(entry).connection;
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
    const backupId = entry.id;
    const backupDir = this.getBackupDir(service);

    // Determine compression from argument or metadata
    const backupCompression = compression ?? entry.compression;

    // Volume restore uses a different flow (docker run instead of docker exec)
    if (dbType === 'volume') {
      return this.restoreVolumes(service, backupId, backupCompression, nodeConn);
    }

    const found = await this.findContainer(service);
    if (!found) {
      return err(new BackupError(`No running container found for service ${service}`, { code: ErrorCode.CONTAINER_NOT_FOUND }));
    }
    const { containerId } = found;

    const dataFile = this.getDataFilePath(backupDir, backupId, dbType, backupCompression);

    // Refuse to stream an empty/corrupt backup into the database — for
    // postgres/mysql an empty stream would be a silent no-op "success",
    // and file-overwriting restores (redis) would destroy the live data.
    const verdict = await this.verifyBeforeRestore(nodeConn, dataFile, backupCompression, recordedIntegrity(dbType, backupCompression, entry.integrity), backupId, options);
    if (verdict) return err(verdict);

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

    if (parseRestoreRefusal(result.stderr) === 'redis-appendonly') {
      return err(new BackupError(
        `Redis in service ${service} has appendonly enabled; a restored dump.rdb would be ignored at startup, so nothing was changed`,
        {
          code: ErrorCode.RESTORE_FAILED,
          suggestion: 'Back up and restore this service with `type: volume`.',
        },
      ));
    }

    // For strategies that kill the container as part of restore (e.g. Redis SHUTDOWN NOSAVE),
    // a non-zero exit from docker exec is expected — the process died mid-exec.
    // Only treat it as an error if there's actual stderr output.
    const restoreKillsContainer = DB_TYPES[dbType].requiresServiceRestart;
    const detail = stripRefusalMarker(result.stderr).trim();
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
   * The verification a restore runs before anything changes. A backup that carries an integrity
   * marker and has lost it was truncated; --force-unverified restores it anyway, with a warning.
   * A backup of a kind that cannot be checked is restored after the basic check, as it always was.
   */
  private async verifyBeforeRestore(
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
    const issue = await this.checkArchive(conn, filePath, compression, check);
    if (issue === null) return null;
    return new BackupError(`Backup ${backupId} cannot be restored: ${issue}`, {
      code: ErrorCode.RESTORE_FAILED,
      suggestion: check === 'trailer'
        ? 'The dump looks truncated. If you have checked it yourself, run the restore again with `--force-unverified`.'
        : undefined,
    });
  }

  /** The listed entry of a backup id; one that is not listed names the nodes that did not answer */
  private async listedEntry(service: string, backupId: string): Promise<BackupListEntry> {
    const listed = await this.list(service);
    if (!listed.success) throw listed.error;
    const entry = listed.data.entries.find(candidate => candidate.id === backupId);
    if (entry) return entry;
    const names = listed.data.unreachable.map(node => node.name).join(', ');
    throw new BackupError(`Backup ${backupId} not found`, {
      code: ErrorCode.BACKUP_NOT_FOUND,
      suggestion: names ? `Bring ${names} back and retry; backups stored there are not listed.` : undefined,
    });
  }

  /**
   * Keep the `retentionCount` newest backups, and remove data files left without metadata by
   * interrupted backups once they are older than BACKUP_ORPHAN_GRACE_H (a backup being written
   * has no metadata yet). Files are removed on the node they were listed on.
   * `prefetched` entries spare the listing.
   */
  async prune(
    service: string | undefined,
    retentionCount: number,
    options: { node?: string; prefetched?: BackupListEntry[] } = {},
  ): Promise<Result<PruneReport, Error>> {
    try {
      const nodes = this.nodesFor(options.node);
      let entries = options.prefetched;
      if (!entries) {
        const listed = await this.list(service, { node: options.node });
        if (!listed.success) return err(listed.error);
        entries = listed.data.entries;
      }

      const toRemove = selectBackupsToPrune(entries, retentionCount);
      const byNode = new Map<string, { node: ClusterNode; patterns: string[] }>();
      let bytesFreed = 0;
      for (const entry of toRemove) {
        if (!SAFE_NAME.test(entry.id) || !SAFE_NAME.test(entry.service)) {
          throw new BackupError(`Backup ${JSON.stringify(entry.id)} of ${JSON.stringify(entry.service)} has an unusable name; nothing was pruned`);
        }
        const node = this.nodeOf(entry);
        const key = `${node.connection.host}:${node.connection.port}`;
        const group = byNode.get(key) ?? { node, patterns: [] };
        // `<id>.` then a glob: the data files, the metadata and any rc file of that backup only
        group.patterns.push(`${shellQuote(`${this.getBackupDir(entry.service)}/${entry.id}.`)}*`);
        byNode.set(key, group);
        bytesFreed += entry.sizeBytes;
      }
      for (const { node, patterns } of byNode.values()) {
        const result = await sshExec(node.connection, `rm -f -- ${patterns.join(' ')}`);
        if (result.exitCode !== 0) {
          throw new BackupError(`Cannot remove backups on ${node.name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
        }
      }

      const orphans = await this.pruneOrphans(service, nodes);
      bytesFreed += orphans.bytes;
      if (orphans.files > 0) {
        printInfo(`Removed ${orphans.files} orphaned backup file(s) (${formatBytes(orphans.bytes)}) left by interrupted backups`);
      }
      return ok({ removed: toRemove.length, orphanFiles: orphans.files, bytesFreed });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async pruneOrphans(service: string | undefined, nodes: ClusterNode[]): Promise<{ files: number; bytes: number }> {
    const base = service ? this.getBackupDir(service) : `${DOCKFLOW_BACKUPS_DIR}/${this.stackName}`;
    // backup ids start with the date, so only files named after one are candidates
    const command =
      `find ${shellQuote(base)} -type f -name '[0-9]*' ! -name '*.meta.json' -mmin +${BACKUP_ORPHAN_GRACE_H * 60} 2>/dev/null | ` +
      `while IFS= read -r f; do b=\${f##*/}; [ -e "\${f%/*}/\${b%%.*}.meta.json" ] && continue; ` +
      `s=$(stat -c %s "$f" 2>/dev/null || echo 0); rm -f -- "$f" && printf '%s\\t%s\\n' "$s" "$f"; done`;

    let files = 0;
    let bytes = 0;
    for (const node of nodes) {
      let stdout: string;
      try {
        stdout = (await sshExec(node.connection, command)).stdout;
      } catch (e) {
        printDebug(`Orphaned backup files on ${node.name} were not checked: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const line of stdout.split(/\r?\n/)) {
        const [size, path] = line.split('\t');
        if (!path) continue;
        files++;
        bytes += Number.parseInt(size, 10) || 0;
        printDebug(`Removed orphaned backup file ${path} on ${node.name}`);
      }
    }
    return { files, bytes };
  }

  /**
   * Resolve a backup by ID prefix or "latest" (undefined). The newest backup cannot be known
   * while a node that may hold a newer one did not answer, so "latest" is refused then.
   */
  async resolveBackup(
    service: string,
    idOrLatest?: string
  ): Promise<Result<BackupListEntry, Error>> {
    const listResult = await this.list(service);
    if (!listResult.success) return err(listResult.error);

    const { entries, unreachable } = listResult.data;
    const names = unreachable.map(node => node.name).join(', ');
    const latest = !idOrLatest || idOrLatest === 'latest';

    if (latest && unreachable.length > 0) {
      return err(new BackupError(`The newest backup of ${service} cannot be determined: ${names} did not answer`, {
        code: ErrorCode.BACKUP_NOT_FOUND,
        suggestion: `Name the backup explicitly with \`--from <id>\`, or bring ${names} back and retry.`,
      }));
    }

    const match = findBackupMatch(entries, latest ? undefined : idOrLatest);
    if (match) return ok(match);

    return err(new BackupError(
      entries.length === 0
        ? `No backups found for service ${service}`
        : `No backup matching "${idOrLatest}" found for service ${service}`,
      {
        code: ErrorCode.BACKUP_NOT_FOUND,
        suggestion: unreachable.length > 0 ? `Bring ${names} back and retry; backups stored there are not listed.` : undefined,
      },
    ));
  }
}

/**
 * Factory function
 */
export function createBackup(
  connection: SSHKeyConnection,
  stackName: string,
  nodes: ClusterNode[] = []
): Backup {
  return new Backup(connection, stackName, nodes);
}
