/**
 * Backup and restore of a stack's services, over the orchestrator's BackupBackend.
 *
 * Orchestrator-neutral: the backend runs dumps, restores and volume archives its own way (docker
 * exec on Swarm, kubectl exec and helper pods on Kubernetes). This module owns what both share:
 * the backup directory and its metadata files, the end-to-end verification of every archive on
 * the node holding it (right after a backup, and before a restore touches anything), the restore
 * refusals, and listing and pruning across every node with SSH credentials.
 *
 * Backups live on the node that wrote them (Swarm: the container's node; k3s: the control plane
 * the command ran on); `nodeHost`/`nodePort` in the metadata say which.
 */

import { BACKUP_ORPHAN_GRACE_H, DOCKFLOW_BACKUPS_DIR } from '../constants';
import { err, ok, type Result } from '../types/result';
import type { BackupAccessoryConfig, BackupDbType } from '../utils/config';
import { BackupError, ErrorCode, UnsupportedOperationError, ValidationError } from '../utils/errors';
import { formatBytes, printDebug, printInfo, printWarning } from '../utils/output';
import { shellQuote, sshExec, sshExecChannel } from '../utils/ssh';
import {
  type ArchiveIntegrity,
  backupScopeName,
  buildBackupDir,
  buildDataFilePath,
  buildDumpScript,
  buildRestoreScript,
  buildVerifyScript,
  DB_TYPES,
  findBackupMatch,
  integrityOf,
  parseRestoreRefusal,
  selectBackupsToPrune,
  stripRefusalMarker,
} from './backup-strategies';
import type {
  BackupBackend,
  BackupFile,
  BackupVolume,
  ClusterNodeRef,
  Orchestrator,
  OrchestratorKind,
  ServiceInfo,
  StackRef,
  StackRole,
} from './orchestrator/interfaces';

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
  /** Docker volume name, PVC name or host path */
  sourcePath: string;
  /** absent in metadata written before the rewrite */
  mountPath?: string;
  /** servers.yml key of the node holding the volume; absent in metadata written before the rewrite */
  node?: string | null;
}

/** `<id>.meta.json`, mode 0600 (design-06 4.5) */
export interface BackupMetadata extends BackupBaseEntry {
  durationMs: number;
  /** backup directory name of the role: `<project>-<env>` or `<project>-<env>-accessories` */
  stackName: string;
  /** absent in metadata written before the rewrite */
  orchestrator?: OrchestratorKind;
  role?: StackRole;
  volumes?: BackupVolumeRecord[];
}

export interface BackupListEntry extends BackupBaseEntry {
  filePath: string;
  /** servers.yml key of the node the backup was listed on */
  node: string;
}

export interface BackupListing {
  /** newest first */
  entries: BackupListEntry[];
  /** nodes with SSH credentials that did not answer; backups stored there are not listed */
  unreachable: ClusterNodeRef[];
}

export interface PruneReport {
  /** backups removed by retention (metadata and data files) */
  removed: number;
  /** data files whose metadata was missing, older than the grace period */
  orphanFiles: number;
  bytesFreed: number;
}

export interface RestoreOptions {
  /** skips the trailer check and the refusal of backups without integrity data */
  forceUnverified: boolean;
}

// ─── Refusals ─────────────────────────────────────────────────────────────

/**
 * R-23: a restore writes one replica (the instance a dump streams into, or the ordinal-0 claim),
 * so bringing the other replicas back would leave members that disagree about the dataset.
 */
export function assertSingleReplica(svc: ServiceInfo, env: string): void {
  const replicas = svc.replicas.desired;
  if (replicas <= 1) return;
  const suggestion =
    svc.role === 'accessory'
      ? `Set \`deploy.replicas: 1\` for ${svc.name} in accessories.yml and run \`dockflow deploy ${env} --accessories\` first, restore, then set it back.`
      : `Scale it to 1 first with \`dockflow scale ${env} ${svc.name} 1\`, restore, then scale it back.`;
  throw new UnsupportedOperationError(
    `Service ${svc.name} runs ${replicas} replicas; dockflow backup restore writes one replica only`,
    suggestion,
  );
}

/** R-17 */
function redisAppendOnlyRefusal(service: string): BackupError {
  return new BackupError(
    `Redis in service ${service} has appendonly enabled; a restored dump.rdb would be ignored at startup, so nothing was changed`,
    { code: ErrorCode.RESTORE_FAILED, suggestion: 'Back up and restore this service with `type: volume`.' },
  );
}

const UNVERIFIED_SUGGESTION =
  'Check the file yourself and re-run with `--force-unverified`, or take a new backup with `compression: gzip`.';

// ─── Helpers ──────────────────────────────────────────────────────────────

const META_SEPARATOR = '---DOCKFLOW_META_SEP---';
/** ids and service names become path components of remote rm commands */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMPRESSIONS: ReadonlySet<string> = new Set(['gzip', 'none']);

function generateBackupId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

function nodeKey(node: ClusterNodeRef): string {
  return `${node.connection.host}:${node.connection.port}`;
}

function isBackupType(value: unknown): value is BackupDbType {
  return typeof value === 'string' && (value === 'volume' || Object.hasOwn(DB_TYPES, value));
}

/** metadata read back from a node, or null when it cannot describe a backup safely */
function parseMetadata(text: string): BackupMetadata | null {
  let meta: Partial<BackupMetadata>;
  try {
    meta = JSON.parse(text) as Partial<BackupMetadata>;
  } catch (error) {
    printDebug(`Skipping malformed backup metadata: ${asError(error).message}`);
    return null;
  }
  if (
    typeof meta !== 'object' ||
    meta === null ||
    typeof meta.id !== 'string' ||
    !SAFE_NAME.test(meta.id) ||
    typeof meta.service !== 'string' ||
    !SAFE_NAME.test(meta.service) ||
    !isBackupType(meta.dbType) ||
    typeof meta.compression !== 'string' ||
    !COMPRESSIONS.has(meta.compression)
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

export class Backup {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly ref: StackRef,
  ) {}

  private get backups(): BackupBackend {
    return this.orchestrator.backups;
  }

  private get env(): string {
    return this.orchestrator.target.env;
  }

  private get scope(): string {
    return backupScopeName(this.ref, this.orchestrator.target.stackName);
  }

  private backupDir(service: string): string {
    return buildBackupDir(this.scope, service);
  }

  // ─── Nodes ──────────────────────────────────────────────────────────────

  /** managers then workers with SSH credentials, deduplicated by host:port */
  private nodes(): ClusterNodeRef[] {
    const seen = new Set<string>();
    return [...this.orchestrator.target.managers, ...this.orchestrator.target.workers].filter((node) => {
      const key = nodeKey(node);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** every node, or the one `--node` names */
  private nodesFor(name: string | undefined): ClusterNodeRef[] {
    const nodes = this.nodes();
    if (name === undefined) return nodes;
    const node = nodes.find((candidate) => candidate.name === name);
    if (!node) {
      throw new ValidationError(
        `Server ${name} is not a server of ${this.env} with SSH credentials`,
        `Pass one of: ${nodes.map((candidate) => candidate.name).join(', ')}.`,
      );
    }
    return [node];
  }

  /** the node holding a backup, from the host and port its metadata recorded */
  private nodeOf(entry: BackupBaseEntry): ClusterNodeRef {
    const node = this.nodes().find(
      (candidate) => candidate.connection.host === entry.nodeHost && candidate.connection.port === entry.nodePort,
    );
    if (!node) {
      throw new BackupError(
        `Backup ${entry.id} is stored on ${entry.nodeHost}:${entry.nodePort}, which is not a server of ${this.env} with SSH credentials`,
        { code: ErrorCode.BACKUP_NOT_FOUND },
      );
    }
    return node;
  }

  // ─── Files on nodes ─────────────────────────────────────────────────────

  /** null when the archive is sound, else the one line naming the problem */
  private async checkArchive(
    node: ClusterNodeRef,
    remotePath: string,
    compression: 'gzip' | 'none',
    integrity: ArchiveIntegrity,
  ): Promise<string | null> {
    const result = await sshExec(node.connection, buildVerifyScript(remotePath, compression, integrity), {
      requireExitStatus: true,
    });
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (result.exitCode === 0 && lines.at(-1) === 'OK') return null;
    const reason = lines.find((line) => line !== 'OK');
    if (reason !== undefined) return reason;
    const detail = firstLine(result.stderr);
    return `the verification on ${node.name} exited with code ${result.exitCode}${detail ? ` (${detail})` : ''}`;
  }

  private async removeFiles(files: BackupFile[]): Promise<void> {
    const byNode = new Map<string, { node: ClusterNodeRef; paths: string[] }>();
    for (const file of files) {
      const group = byNode.get(nodeKey(file.node)) ?? { node: file.node, paths: [] };
      group.paths.push(shellQuote(file.remotePath));
      byNode.set(nodeKey(file.node), group);
    }
    await Promise.all(
      [...byNode.values()].map(async ({ node, paths }) => {
        try {
          await sshExec(node.connection, `rm -f -- ${paths.join(' ')}`);
        } catch (error) {
          printDebug(`Could not remove ${paths.join(' ')} on ${node.name}: ${asError(error).message}`);
        }
      }),
    );
  }

  private async fileSize(file: BackupFile): Promise<number> {
    const result = await sshExec(file.node.connection, `stat -c %s ${shellQuote(file.remotePath)} 2>/dev/null || echo 0`);
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  private async writeMetadata(node: ClusterNodeRef, dir: string, metadata: BackupMetadata): Promise<void> {
    const path = `${dir}/${metadata.id}.meta.json`;
    const { stream, done } = await sshExecChannel(node.connection, `umask 077 && cat > ${shellQuote(path)}`);
    stream.end(JSON.stringify(metadata, null, 2));
    const result = await done;
    if (result.exitCode !== 0) {
      throw new BackupError(`Cannot write the metadata of backup ${metadata.id} on ${node.name}: ${firstLine(result.stderr)}`);
    }
  }

  private async readMetadata(node: ClusterNodeRef, dir: string, id: string): Promise<BackupMetadata> {
    const result = await sshExec(node.connection, `cat ${shellQuote(`${dir}/${id}.meta.json`)} 2>/dev/null`);
    if (!result.stdout.trim()) throw new BackupError(`Backup ${id} not found`, { code: ErrorCode.BACKUP_NOT_FOUND });
    const meta = parseMetadata(result.stdout.trim());
    if (!meta) throw new BackupError(`Invalid backup metadata for ${id}`, { code: ErrorCode.RESTORE_FAILED });
    return meta;
  }

  private metadata(
    id: string,
    service: string,
    dbType: BackupDbType,
    compression: 'gzip' | 'none',
    node: ClusterNodeRef,
    sizeBytes: number,
    durationMs: number,
  ): BackupMetadata {
    return {
      id,
      service,
      dbType,
      timestamp: new Date().toISOString(),
      size: formatBytes(sizeBytes),
      sizeBytes,
      compression,
      durationMs,
      stackName: this.scope,
      nodeHost: node.connection.host,
      nodePort: node.connection.port,
      orchestrator: this.orchestrator.kind,
      role: this.ref.role,
    };
  }

  // ─── Backup ─────────────────────────────────────────────────────────────

  /**
   * Create a backup of a service. The dump or archives are verified on the node holding them with
   * the same check a restore runs, and removed when that fails.
   */
  async backup(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none' = 'gzip',
  ): Promise<Result<BackupMetadata, Error>> {
    try {
      return ok(
        config.type === 'volume'
          ? await this.backupVolumes(service, config, compression)
          : await this.backupDatabase(service, config, compression),
      );
    } catch (error) {
      return err(asError(error));
    }
  }

  private async backupDatabase(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none',
  ): Promise<BackupMetadata> {
    const script = buildDumpScript(config, compression);
    const integrity = integrityOf(config, compression);
    const id = generateBackupId();
    const dir = this.backupDir(service);
    const started = Date.now();

    const file = await this.backups.dump(this.ref, { service }, script, buildDataFilePath(dir, id, config.type, compression), {
      gzip: compression === 'gzip',
    });
    const issue = await this.checkArchive(file.node, file.remotePath, compression, integrity);
    if (issue !== null) {
      await this.removeFiles([file]);
      throw new BackupError(`Backup verification failed: ${issue}`);
    }

    const durationMs = Date.now() - started;
    const sizeBytes = await this.fileSize(file);
    const metadata = this.metadata(id, service, config.type, compression, file.node, sizeBytes, durationMs);
    try {
      await this.writeMetadata(file.node, dir, metadata);
    } catch (error) {
      await this.removeFiles([file]);
      throw error;
    }

    if (integrity === 'opaque') {
      printWarning(
        `Backup ${id} of ${service} cannot be verified before a restore because it is not compressed; set compression: gzip for this service`,
      );
    }
    return metadata;
  }

  private async backupVolumes(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none',
  ): Promise<BackupMetadata> {
    const volumes = await this.backups.volumes(this.ref, service, {
      includeBindMounts: config.include_bind_mounts !== false,
      exclude: config.exclude_volumes ?? [],
    });
    if (volumes.length === 0) throw new BackupError(`No volumes or bind mounts found for service ${service}`);

    const id = generateBackupId();
    const dir = this.backupDir(service);
    const started = Date.now();

    const files = await this.backups.archiveVolumes(this.ref, service, volumes, `${dir}/${id}`, {
      gzip: compression === 'gzip',
    });
    if (files.length !== volumes.length) {
      await this.removeFiles(files);
      throw new BackupError(`Backup of ${service} returned ${files.length} archive(s) for ${volumes.length} volume(s)`);
    }

    for (const [index, file] of files.entries()) {
      const issue = await this.checkArchive(file.node, file.remotePath, compression, 'tar');
      if (issue !== null) {
        await this.removeFiles(files);
        throw new BackupError(`Backup failed for ${volumes[index].kind} ${volumes[index].source}: ${issue}`);
      }
    }

    const durationMs = Date.now() - started;
    const sizes = await Promise.all(files.map((file) => this.fileSize(file)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const metadata: BackupMetadata = {
      ...this.metadata(id, service, 'volume', compression, files[0].node, total, durationMs),
      volumes: volumes.map((volume, index) => ({
        name: volume.name,
        sizeBytes: sizes[index],
        mountType: volume.kind,
        sourcePath: volume.source,
        mountPath: volume.mountPath,
        node: volume.node,
      })),
    };
    try {
      await this.writeMetadata(files[0].node, dir, metadata);
    } catch (error) {
      await this.removeFiles(files);
      throw error;
    }
    return metadata;
  }

  // ─── List ───────────────────────────────────────────────────────────────

  /**
   * Backups of one service (or the whole role) on every node with credentials, newest first.
   * A node that does not answer is reported in `unreachable`, never skipped silently.
   */
  async list(service?: string, options: { node?: string } = {}): Promise<Result<BackupListing, Error>> {
    try {
      const nodes = this.nodesFor(options.node);
      const base = service ? this.backupDir(service) : `${DOCKFLOW_BACKUPS_DIR}/${this.scope}`;
      const command = `find ${shellQuote(base)} -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${META_SEPARATOR}'; cat "$f"; done`;

      const answers = await Promise.all(
        nodes.map(async (node) => {
          try {
            return { node, stdout: (await sshExec(node.connection, command)).stdout };
          } catch (error) {
            printDebug(`Backups on ${node.name} could not be listed: ${asError(error).message}`);
            return { node, stdout: null };
          }
        }),
      );

      const entries: BackupListEntry[] = [];
      const seen = new Set<string>();
      const unreachable: ClusterNodeRef[] = [];
      for (const { node, stdout } of answers) {
        if (stdout === null) {
          unreachable.push(node);
          continue;
        }
        for (const chunk of stdout.split(META_SEPARATOR)) {
          if (!chunk.trim()) continue;
          const meta = parseMetadata(chunk.trim());
          // the same backup may appear on several nodes when copied by hand
          if (!meta || seen.has(meta.id)) continue;
          seen.add(meta.id);
          const volumeName = meta.dbType === 'volume' ? meta.volumes?.[0]?.name : undefined;
          entries.push({
            id: meta.id,
            service: meta.service,
            dbType: meta.dbType,
            timestamp: meta.timestamp,
            size: meta.size,
            sizeBytes: meta.sizeBytes,
            compression: meta.compression,
            filePath: buildDataFilePath(this.backupDir(meta.service), meta.id, meta.dbType, meta.compression, volumeName),
            nodeHost: meta.nodeHost,
            nodePort: meta.nodePort,
            node: node.name,
          });
        }
      }

      entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return ok({ entries, unreachable });
    } catch (error) {
      return err(asError(error));
    }
  }

  /**
   * A backup by id, id prefix or `latest` (undefined). The newest backup cannot be known while a
   * node that may hold a newer one did not answer, so `latest` is refused then.
   */
  async resolveBackup(service: string, idOrLatest?: string): Promise<Result<BackupListEntry, Error>> {
    const listed = await this.list(service);
    if (!listed.success) return listed;
    const { entries, unreachable } = listed.data;
    const names = unreachable.map((node) => node.name).join(', ');
    const latest = !idOrLatest || idOrLatest === 'latest';

    if (latest && unreachable.length > 0) {
      return err(
        new BackupError(`The newest backup of ${service} cannot be determined: ${names} did not answer`, {
          code: ErrorCode.BACKUP_NOT_FOUND,
          suggestion: `Name the backup explicitly with \`--from <id>\`, or bring ${names} back and retry.`,
        }),
      );
    }

    const match = findBackupMatch(entries, latest ? undefined : idOrLatest);
    if (match) return ok(match);
    const suggestion = unreachable.length > 0 ? `Bring ${names} back and retry; backups stored there are not listed.` : undefined;
    return err(
      new BackupError(
        entries.length === 0
          ? `No backups found for service ${service}`
          : `No backup matching "${idOrLatest}" found for service ${service}`,
        { code: ErrorCode.BACKUP_NOT_FOUND, suggestion },
      ),
    );
  }

  // ─── Restore ────────────────────────────────────────────────────────────

  /**
   * Restore a backup into the running service. Refuses a service with more than one desired
   * replica (R-23) before anything is read, and verifies the archive end to end on the node
   * holding it before the backend is called.
   */
  async restore(
    service: string,
    backupId: string,
    config: BackupAccessoryConfig,
    compression?: 'gzip' | 'none',
    options: RestoreOptions = { forceUnverified: false },
  ): Promise<Result<void, Error>> {
    try {
      const svc = (await this.orchestrator.stack.getServices(this.ref)).find((candidate) => candidate.name === service);
      if (svc) assertSingleReplica(svc, this.env);

      const listed = await this.list(service);
      if (!listed.success) return listed;
      const entry = listed.data.entries.find((candidate) => candidate.id === backupId);
      if (!entry) {
        const names = listed.data.unreachable.map((node) => node.name).join(', ');
        throw new BackupError(`Backup ${backupId} not found`, {
          code: ErrorCode.BACKUP_NOT_FOUND,
          suggestion: names ? `Bring ${names} back and retry; backups stored there are not listed.` : undefined,
        });
      }
      if (entry.dbType !== config.type) {
        throw new BackupError(
          `Backup ${entry.id} is a ${entry.dbType} backup, but ${service} is configured with type ${config.type}`,
          { code: ErrorCode.RESTORE_FAILED },
        );
      }

      const node = this.nodeOf(entry);
      const effective = compression ?? entry.compression;
      if (config.type === 'volume') {
        await this.restoreVolumes(service, entry, effective, node);
      } else {
        await this.restoreDatabase(service, entry, config, effective, node, options);
      }
      return ok(undefined);
    } catch (error) {
      return err(asError(error));
    }
  }

  /** the verification a restore runs before anything changes; `--force-unverified` only relaxes trailer and opaque */
  private async verifyBeforeRestore(
    file: BackupFile,
    compression: 'gzip' | 'none',
    integrity: ArchiveIntegrity,
    id: string,
    service: string,
    options: RestoreOptions,
  ): Promise<void> {
    let check = integrity;
    if (integrity === 'trailer' || integrity === 'opaque') {
      if (options.forceUnverified) {
        check = 'opaque';
        printWarning(`Restoring ${id} without verifying it`);
      } else if (integrity === 'opaque') {
        throw new BackupError(
          `Backup ${id} has no integrity data and cannot be verified before it replaces ${service}'s data`,
          { code: ErrorCode.RESTORE_FAILED, suggestion: UNVERIFIED_SUGGESTION },
        );
      }
    }
    const issue = await this.checkArchive(file.node, file.remotePath, compression, check);
    if (issue !== null) {
      throw new BackupError(`Backup ${id} cannot be restored: ${issue}`, {
        code: ErrorCode.RESTORE_FAILED,
        suggestion: check === 'trailer' ? UNVERIFIED_SUGGESTION : undefined,
      });
    }
  }

  private async restoreDatabase(
    service: string,
    entry: BackupListEntry,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none',
    node: ClusterNodeRef,
    options: RestoreOptions,
  ): Promise<void> {
    const type = config.type;
    if (type === 'volume') return;
    const file: BackupFile = { node, remotePath: buildDataFilePath(this.backupDir(service), entry.id, type, compression) };
    await this.verifyBeforeRestore(file, compression, integrityOf(config, compression), entry.id, service, options);

    const { exitCode, stderr } = await this.backups.restore(this.ref, { service }, buildRestoreScript(config), file, {
      gunzip: compression === 'gzip',
    });
    if (parseRestoreRefusal(stderr) === 'redis-appendonly') throw redisAppendOnlyRefusal(service);

    // a restore that stops the server itself (redis SHUTDOWN NOSAVE) ends exec with a non-zero
    // status and nothing on stderr: that is the expected outcome, not a failure
    const killsServer = DB_TYPES[type].requiresServiceRestart;
    const detail = stripRefusalMarker(stderr).trim();
    if (exitCode !== 0 && !(killsServer && detail === '')) {
      throw new BackupError(`Restore failed: ${detail || `exit code ${exitCode}`}`, { code: ErrorCode.RESTORE_FAILED });
    }
    if (killsServer) await this.backups.restartAfterRestore(this.ref, service);
  }

  private async restoreVolumes(
    service: string,
    entry: BackupListEntry,
    compression: 'gzip' | 'none',
    node: ClusterNodeRef,
  ): Promise<void> {
    const dir = this.backupDir(service);
    const meta = await this.readMetadata(node, dir, entry.id);
    const records = meta.volumes ?? [];
    if (records.length === 0) {
      throw new BackupError(`No volume information in backup metadata for ${entry.id}`, { code: ErrorCode.RESTORE_FAILED });
    }
    for (const record of records) {
      if (
        typeof record.name !== 'string' ||
        !SAFE_NAME.test(record.name) ||
        (record.mountType !== 'volume' && record.mountType !== 'bind') ||
        (record.mountType === 'bind' && !record.sourcePath)
      ) {
        throw new BackupError(
          `Backup metadata for ${entry.id} is missing mount information for "${String(record.name)}"; refusing to restore`,
          { code: ErrorCode.RESTORE_FAILED },
        );
      }
    }

    const archives = records.map((record) => ({
      volume: {
        name: record.name,
        kind: record.mountType,
        source: record.sourcePath ?? '',
        mountPath: record.mountPath ?? '',
        node: record.node ?? null,
      } satisfies BackupVolume,
      file: { node, remotePath: buildDataFilePath(dir, entry.id, 'volume', compression, record.name) } satisfies BackupFile,
    }));

    // every archive, before anything is changed
    for (const { volume, file } of archives) {
      const issue = await this.checkArchive(file.node, file.remotePath, compression, 'tar');
      if (issue !== null) {
        throw new BackupError(`Backup ${entry.id} cannot be restored: ${issue} (${volume.kind} ${volume.name})`, {
          code: ErrorCode.RESTORE_FAILED,
        });
      }
    }

    await this.backups.restoreVolumes(this.ref, service, archives);
  }

  // ─── Prune ──────────────────────────────────────────────────────────────

  /**
   * Keep the `retentionCount` newest backups, and remove data files left without metadata by
   * interrupted backups once they are older than BACKUP_ORPHAN_GRACE_H (a backup being written
   * has no metadata yet). Files are removed on the node they were listed on.
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
        if (!listed.success) return listed;
        entries = listed.data.entries;
      }

      const toRemove = selectBackupsToPrune(entries, retentionCount);
      const byNode = new Map<string, { node: ClusterNodeRef; patterns: string[] }>();
      let bytesFreed = 0;
      for (const entry of toRemove) {
        if (!SAFE_NAME.test(entry.id) || !SAFE_NAME.test(entry.service)) {
          throw new BackupError(`Backup ${JSON.stringify(entry.id)} of ${JSON.stringify(entry.service)} has an unusable name; nothing was pruned`);
        }
        const node = this.nodes().find((candidate) => candidate.name === entry.node) ?? this.nodeOf(entry);
        const group = byNode.get(nodeKey(node)) ?? { node, patterns: [] };
        // `<id>.` then a glob: the data file(s), the metadata and any rc file of that backup only
        group.patterns.push(`${shellQuote(`${this.backupDir(entry.service)}/${entry.id}.`)}*`);
        byNode.set(nodeKey(node), group);
        bytesFreed += entry.sizeBytes;
      }
      for (const { node, patterns } of byNode.values()) {
        const result = await sshExec(node.connection, `rm -f -- ${patterns.join(' ')}`);
        if (result.exitCode !== 0) {
          throw new BackupError(`Cannot remove backups on ${node.name}: ${firstLine(result.stderr)}`);
        }
      }

      const orphans = await this.pruneOrphans(service, nodes);
      bytesFreed += orphans.bytes;
      if (orphans.files > 0) {
        printInfo(`Removed ${orphans.files} orphaned backup file(s) (${formatBytes(orphans.bytes)}) left by interrupted backups`);
      }
      return ok({ removed: toRemove.length, orphanFiles: orphans.files, bytesFreed });
    } catch (error) {
      return err(asError(error));
    }
  }

  private async pruneOrphans(service: string | undefined, nodes: ClusterNodeRef[]): Promise<{ files: number; bytes: number }> {
    const base = service ? this.backupDir(service) : `${DOCKFLOW_BACKUPS_DIR}/${this.scope}`;
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
      } catch (error) {
        printDebug(`Orphaned backup files on ${node.name} were not checked: ${asError(error).message}`);
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
}

/** The backup engine of one role of the stack the orchestrator targets. */
export function createBackup(orchestrator: Orchestrator, ref: StackRef): Backup {
  return new Backup(orchestrator, ref);
}
