/**
 * Backup Service
 *
 * Manages backup and restore operations for accessory databases and Docker volumes.
 * Uses SSH + docker exec to run dump/restore commands inside containers,
 * and docker run with temporary Alpine containers for volume backups.
 */

import type { SSHKeyConnection } from '../types';
import type { BackupDbType, BackupAccessoryConfig } from '../utils/config';
import { ok, err, type Result } from '../types';
import { sshExec, shellEscape } from '../utils/ssh';
import { formatBytes, printDebug } from '../utils/output';
import { createStackService } from './stack-service';
import { DOCKFLOW_BACKUPS_DIR } from '../constants';

// ─── Types ────────────────────────────────────────────────────────────────

export interface BackupBaseEntry {
  id: string;
  service: string;
  dbType: BackupDbType;
  timestamp: string;
  size: string;
  sizeBytes: number;
  compression: 'gzip' | 'none';
}

export interface BackupMetadata extends BackupBaseEntry {
  durationMs: number;
  stackName: string;
}

export interface BackupListEntry extends BackupBaseEntry {
  filePath: string;
}

interface ContainerCredentials {
  user?: string;
  password?: string;
  database?: string;
}

interface MountInfo {
  /** 'volume' for named Docker volumes, 'bind' for host-mounted paths */
  mountType: 'volume' | 'bind';
  /** Short name used in backup filenames */
  name: string;
  /** Container mount destination */
  destination: string;
  /** For volumes: the Docker volume name. For binds: the host source path. */
  source: string;
}

// ─── Database Strategies ──────────────────────────────────────────────────

interface DbStrategy {
  envMapping: Record<string, keyof ContainerCredentials>;
  buildDumpCommand(creds: ContainerCredentials, options?: string): string;
  buildRestoreCommand(creds: ContainerCredentials, options?: string): string;
  /** Env vars to inject via `docker exec -e` (e.g. for password passing) */
  buildExecEnv(creds: ContainerCredentials): Record<string, string>;
  fileExtension: string;
}

const DB_STRATEGIES: Record<Exclude<BackupDbType, 'raw' | 'volume'>, DbStrategy> = {
  postgres: {
    envMapping: {
      POSTGRES_USER: 'user',
      POSTGRES_PASSWORD: 'password',
      POSTGRES_DB: 'database',
    },
    buildDumpCommand(creds, options) {
      const parts = ['pg_dump', '-U', creds.user || 'postgres'];
      if (options) parts.push(options);
      parts.push(creds.database || 'postgres');
      return parts.join(' ');
    },
    buildRestoreCommand(creds, options) {
      const parts = ['psql', '-U', creds.user || 'postgres'];
      if (options) parts.push(options);
      parts.push(creds.database || 'postgres');
      return parts.join(' ');
    },
    buildExecEnv(creds): Record<string, string> {
      return creds.password ? { PGPASSWORD: creds.password } : {};
    },
    fileExtension: 'sql',
  },

  mysql: {
    envMapping: {
      MYSQL_USER: 'user',
      MYSQL_ROOT_PASSWORD: 'password',
      MYSQL_PASSWORD: 'password',
      MYSQL_DATABASE: 'database',
    },
    buildDumpCommand(creds, options) {
      const user = creds.user || 'root';
      const parts = ['mysqldump', `-u${user}`];
      if (options) parts.push(options);
      parts.push(creds.database || '--all-databases');
      return parts.join(' ');
    },
    buildRestoreCommand(creds, options) {
      const user = creds.user || 'root';
      const parts = ['mysql', `-u${user}`];
      if (options) parts.push(options);
      if (creds.database) parts.push(creds.database);
      return parts.join(' ');
    },
    buildExecEnv(creds): Record<string, string> {
      return creds.password ? { MYSQL_PWD: creds.password } : {};
    },
    fileExtension: 'sql',
  },

  // Note: MongoDB does not support password passing via env vars like PGPASSWORD/MYSQL_PWD.
  // The password is passed as a command-line argument, which is visible in the container's
  // process list. This is the standard approach for mongodump/mongorestore.
  mongodb: {
    envMapping: {
      MONGO_INITDB_ROOT_USERNAME: 'user',
      MONGO_INITDB_ROOT_PASSWORD: 'password',
      MONGO_INITDB_DATABASE: 'database',
    },
    buildDumpCommand(creds, options) {
      const parts = ['mongodump', '--archive'];
      if (creds.user) {
        parts.push(`--username="${creds.user}"`, `--authenticationDatabase=admin`);
      }
      if (creds.password) parts.push(`--password="${creds.password}"`);
      if (creds.database) parts.push(`--db="${creds.database}"`);
      if (options) parts.push(options);
      return parts.join(' ');
    },
    buildRestoreCommand(creds, options) {
      const parts = ['mongorestore', '--archive'];
      if (creds.user) {
        parts.push(`--username="${creds.user}"`, `--authenticationDatabase=admin`);
      }
      if (creds.password) parts.push(`--password="${creds.password}"`);
      if (creds.database) parts.push(`--db="${creds.database}"`);
      if (options) parts.push(options);
      return parts.join(' ');
    },
    buildExecEnv() {
      return {};
    },
    fileExtension: 'archive',
  },

  redis: {
    envMapping: {},
    buildDumpCommand() {
      // Trigger save with LASTSAVE polling instead of arbitrary sleep
      return 'BEFORE=$(redis-cli LASTSAVE) && redis-cli BGSAVE && for i in $(seq 1 30); do AFTER=$(redis-cli LASTSAVE); [ "$AFTER" != "$BEFORE" ] && break; sleep 1; done && cat /data/dump.rdb';
    },
    buildRestoreCommand() {
      // Write the RDB file first, then shut down Redis without saving (so it doesn't
      // overwrite the restored dump). Docker Swarm's restart policy will restart the
      // container, and Redis loads the new dump.rdb on boot.
      // This avoids `DEBUG RELOAD` which is often disabled in production via ACLs.
      // `|| true` prevents a non-zero exit from SHUTDOWN propagating as a restore failure.
      return 'cat > /data/dump.rdb && redis-cli SHUTDOWN NOSAVE || true';
    },
    buildExecEnv() {
      return {};
    },
    fileExtension: 'rdb',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function generateBackupId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`;
}

/** Build docker exec env flags from a key-value map */
function buildExecEnvFlags(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `-e ${k}='${shellEscape(v)}'`)
    .join(' ');
}

/** Convert a mount destination path to a safe filename component */
function sanitizePathName(mountPath: string): string {
  return mountPath.replace(/^\/+/, '').replace(/\//g, '-') || 'root';
}

// ─── Service ──────────────────────────────────────────────────────────────

export class BackupService {
  private readonly stackService;

  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string
  ) {
    this.stackService = createStackService(connection, stackName);
  }

  private getBackupDir(service: string): string {
    return `${DOCKFLOW_BACKUPS_DIR}/${this.stackName}/${service}`;
  }

  /** Derive the data file path from metadata */
  private getDataFilePath(
    backupDir: string,
    id: string,
    dbType: BackupDbType,
    compression: 'gzip' | 'none',
    volumeName?: string
  ): string {
    let ext: string;
    if (dbType === 'volume') {
      ext = 'tar';
    } else if (dbType === 'raw') {
      ext = 'bin';
    } else {
      ext = DB_STRATEGIES[dbType]?.fileExtension || 'bin';
    }
    const suffix = compression === 'gzip' ? '.gz' : '';
    const volPart = volumeName ? `.${volumeName}` : '';
    return `${backupDir}/${id}${volPart}.${ext}${suffix}`;
  }

  /**
   * Read environment variables from a running container
   */
  private async getContainerCredentials(
    containerId: string,
    dbType: BackupDbType
  ): Promise<ContainerCredentials> {
    if (dbType === 'raw' || dbType === 'volume') return {};

    const strategy = DB_STRATEGIES[dbType];
    const result = await sshExec(
      this.connection,
      `docker inspect --format '{{json .Config.Env}}' '${shellEscape(containerId)}'`
    );

    const creds: ContainerCredentials = {};
    if (!result.stdout.trim()) return creds;

    try {
      const envVars: string[] = JSON.parse(result.stdout.trim());
      for (const envVar of envVars) {
        const eqIndex = envVar.indexOf('=');
        if (eqIndex === -1) continue;
        const key = envVar.substring(0, eqIndex);
        const value = envVar.substring(eqIndex + 1);
        const credKey = strategy.envMapping[key];
        if (credKey && value) {
          creds[credKey] = value;
        }
      }
    } catch (e) {
      printDebug(`Failed to parse container env for ${containerId}: ${e}`);
    }

    return creds;
  }

  /**
   * Create a backup of an accessory service
   */
  async backup(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none' = 'gzip'
  ): Promise<Result<BackupMetadata, Error>> {
    const containerId = await this.stackService.findContainerForService(service);
    if (!containerId) {
      return err(new Error(`No running container found for service ${service}`));
    }

    const dbType = config.type;

    // Volume backup uses a different flow (docker run instead of docker exec)
    if (dbType === 'volume') {
      return this.backupVolumes(service, containerId, config, compression);
    }

    const backupId = generateBackupId();
    const backupDir = this.getBackupDir(service);

    // Get credentials and create backup directory in parallel (independent SSH calls)
    const [creds, mkdirResult] = await Promise.all([
      this.getContainerCredentials(containerId, dbType),
      sshExec(this.connection, `mkdir -p '${shellEscape(backupDir)}'`),
    ]);

    if (mkdirResult.exitCode !== 0) {
      return err(new Error(`Failed to create backup directory: ${mkdirResult.stderr}`));
    }

    // Build dump command
    let dumpCommand: string;
    if (dbType === 'raw') {
      dumpCommand = config.dump_command!;
    } else {
      const strategy = DB_STRATEGIES[dbType];
      dumpCommand = config.dump_command || strategy.buildDumpCommand(creds, config.dump_options);
    }

    const filePath = this.getDataFilePath(backupDir, backupId, dbType, compression);

    const startTime = Date.now();

    // Build exec env flags (e.g. PGPASSWORD, MYSQL_PWD)
    const execEnvFlags = dbType !== 'raw'
      ? buildExecEnvFlags(DB_STRATEGIES[dbType].buildExecEnv(creds))
      : '';
    const envPart = execEnvFlags ? `${execEnvFlags} ` : '';

    const dockerExec = `docker exec ${envPart}'${shellEscape(containerId)}' sh -c '${shellEscape(dumpCommand)}'`;
    const fullCommand = compression === 'gzip'
      ? `${dockerExec} | gzip > '${shellEscape(filePath)}'`
      : `${dockerExec} > '${shellEscape(filePath)}'`;

    const result = await sshExec(this.connection, fullCommand);
    if (result.exitCode !== 0) {
      await sshExec(this.connection, `rm -f '${shellEscape(filePath)}'`);
      return err(new Error(`Backup failed: ${result.stderr}`));
    }

    const durationMs = Date.now() - startTime;

    // Get file size
    const metaPath = `${backupDir}/${backupId}.meta.json`;
    const sizeCmd = `SIZE=$(stat -c %s '${shellEscape(filePath)}' 2>/dev/null || echo 0) && echo $SIZE`;
    const sizeResult = await sshExec(this.connection, sizeCmd);
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
    };

    await sshExec(
      this.connection,
      `cat > '${shellEscape(metaPath)}' << 'DOCKFLOW_EOF'\n${JSON.stringify(metadata, null, 2)}\nDOCKFLOW_EOF`
    );

    return ok(metadata);
  }

  // ─── Volume Backup ───────────────────────────────────────────────────────

  /** Strip the stack name prefix from a Docker volume name for cleaner filenames */
  private shortVolumeName(volumeName: string): string {
    const prefix = `${this.stackName}_`;
    return volumeName.startsWith(prefix) ? volumeName.slice(prefix.length) : volumeName;
  }

  /** Discover named Docker volumes and read-write bind mounts on a container */
  private async getContainerMounts(
    containerId: string,
    excludePatterns?: string[],
    includeBindMounts: boolean = true
  ): Promise<MountInfo[]> {
    const result = await sshExec(
      this.connection,
      `docker inspect --format '{{json .Mounts}}' '${shellEscape(containerId)}'`
    );

    if (!result.stdout.trim()) return [];

    try {
      const mounts: Array<{
        Type: string;
        Name?: string;
        Source: string;
        Destination: string;
        RW?: boolean;
      }> = JSON.parse(result.stdout.trim());

      let infos: MountInfo[] = [];

      for (const m of mounts) {
        if (m.Type === 'volume' && m.Name) {
          infos.push({
            mountType: 'volume',
            name: this.shortVolumeName(m.Name),
            destination: m.Destination,
            source: m.Name,
          });
        } else if (m.Type === 'bind' && m.RW !== false && includeBindMounts) {
          infos.push({
            mountType: 'bind',
            name: sanitizePathName(m.Destination),
            destination: m.Destination,
            source: m.Source,
          });
        }
      }

      if (excludePatterns && excludePatterns.length > 0) {
        infos = infos.filter(info => {
          return !excludePatterns.some(pattern => {
            const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
            return regex.test(info.name) || regex.test(info.source) || regex.test(info.destination);
          });
        });
      }

      return infos;
    } catch (e) {
      printDebug(`Failed to parse container mounts for ${containerId}: ${e}`);
      return [];
    }
  }

  /** Backup all named volumes and bind mounts for a service container */
  private async backupVolumes(
    service: string,
    containerId: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none'
  ): Promise<Result<BackupMetadata, Error>> {
    const mounts = await this.getContainerMounts(containerId, config.exclude_volumes, config.include_bind_mounts !== false);
    if (mounts.length === 0) {
      return err(new Error(`No volumes or bind mounts found for service ${service}`));
    }

    const backupId = generateBackupId();
    const backupDir = this.getBackupDir(service);

    const mkdirResult = await sshExec(this.connection, `mkdir -p '${shellEscape(backupDir)}'`);
    if (mkdirResult.exitCode !== 0) {
      return err(new Error(`Failed to create backup directory: ${mkdirResult.stderr}`));
    }

    const startTime = Date.now();
    let totalSizeBytes = 0;
    const volumeEntries: { name: string; sizeBytes: number; mountType: 'volume' | 'bind'; sourcePath: string }[] = [];

    for (const mount of mounts) {
      const filePath = this.getDataFilePath(backupDir, backupId, 'volume', compression, mount.name);

      // Named volumes: tar via temporary alpine container
      // Bind mounts: tar the host path directly
      const tarCmd = mount.mountType === 'volume'
        ? `docker run --rm -v '${shellEscape(mount.source)}':/backup-source:ro alpine tar cf - -C /backup-source .`
        : `tar cf - -C '${shellEscape(mount.source)}' .`;

      const fullCommand = compression === 'gzip'
        ? `${tarCmd} | gzip > '${shellEscape(filePath)}'`
        : `${tarCmd} > '${shellEscape(filePath)}'`;

      const result = await sshExec(this.connection, fullCommand);
      if (result.exitCode !== 0) {
        await sshExec(this.connection, `rm -f '${shellEscape(backupDir)}'/${backupId}.*`);
        return err(new Error(`Backup failed for ${mount.mountType} ${mount.source}: ${result.stderr}`));
      }

      const sizeCmd = `stat -c %s '${shellEscape(filePath)}' 2>/dev/null || echo 0`;
      const sizeResult = await sshExec(this.connection, sizeCmd);
      const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;
      totalSizeBytes += sizeBytes;
      volumeEntries.push({ name: mount.name, sizeBytes, mountType: mount.mountType, sourcePath: mount.source });
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
    };

    // Extended metadata includes per-volume/bind details
    const extendedMeta = { ...metadata, volumes: volumeEntries };
    const metaPath = `${backupDir}/${backupId}.meta.json`;
    await sshExec(
      this.connection,
      `cat > '${shellEscape(metaPath)}' << 'DOCKFLOW_EOF'\n${JSON.stringify(extendedMeta, null, 2)}\nDOCKFLOW_EOF`
    );

    return ok(metadata);
  }

  /** Restore volumes and bind mounts from a backup */
  private async restoreVolumes(
    service: string,
    backupId: string,
    compression: 'gzip' | 'none'
  ): Promise<Result<void, Error>> {
    const backupDir = this.getBackupDir(service);

    // Read metadata to get volume/bind mount names
    const metaPath = `${backupDir}/${backupId}.meta.json`;
    const metaResult = await sshExec(this.connection, `cat '${shellEscape(metaPath)}' 2>/dev/null`);
    if (!metaResult.stdout.trim()) {
      return err(new Error(`Backup ${backupId} not found`));
    }

    let meta: BackupMetadata & { volumes?: { name: string; sizeBytes: number; mountType?: 'volume' | 'bind'; sourcePath?: string }[] };
    try {
      meta = JSON.parse(metaResult.stdout.trim());
    } catch {
      return err(new Error(`Invalid backup metadata for ${backupId}`));
    }

    const volumeEntries = meta.volumes ?? [];
    if (volumeEntries.length === 0) {
      return err(new Error(`No volume information in backup metadata for ${backupId}`));
    }

    // List existing Docker volumes to resolve short names for volume mounts
    const volListResult = await sshExec(
      this.connection,
      `docker volume ls --filter "label=com.docker.stack.namespace=${this.stackName}" --format "{{.Name}}"`
    );
    const existingVolumes = volListResult.stdout.trim().split('\n').filter(Boolean);

    for (const entry of volumeEntries) {
      const filePath = this.getDataFilePath(backupDir, backupId, 'volume', compression, entry.name);
      const mountType = entry.mountType || 'volume'; // backwards compat with old metadata

      let restoreCmd: string;
      if (mountType === 'bind' && entry.sourcePath) {
        // Bind mount: clear target and extract directly on the host
        const src = shellEscape(entry.sourcePath);
        restoreCmd = `rm -rf '${src}'/* '${src}'/..?* '${src}'/.[!.]* 2>/dev/null; tar xf - -C '${src}'`;
      } else {
        // Named volume: extract via temporary alpine container
        const fullVolumeName = existingVolumes.find(
          v => v === entry.name || v === `${this.stackName}_${entry.name}`
        ) || `${this.stackName}_${entry.name}`;
        restoreCmd = `docker run --rm -i -v '${shellEscape(fullVolumeName)}':/backup-target alpine sh -c 'rm -rf /backup-target/* /backup-target/..?* /backup-target/.[!.]* 2>/dev/null; tar xf - -C /backup-target'`;
      }

      const fullCommand = compression === 'gzip'
        ? `gunzip -c '${shellEscape(filePath)}' | ${restoreCmd}`
        : `cat '${shellEscape(filePath)}' | ${restoreCmd}`;

      const result = await sshExec(this.connection, fullCommand);
      if (result.exitCode !== 0) {
        return err(new Error(`Restore failed for ${mountType} ${entry.name}: ${result.stderr}`));
      }
    }

    return ok(undefined);
  }

  /**
   * List available backups (single SSH call)
   */
  async list(service?: string): Promise<Result<BackupListEntry[], Error>> {
    const baseDir = service
      ? this.getBackupDir(service)
      : `${DOCKFLOW_BACKUPS_DIR}/${this.stackName}`;

    // Read all metadata files in a single SSH call using a separator
    const SEP = '---DOCKFLOW_META_SEP---';
    const findCmd = `find '${shellEscape(baseDir)}' -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${SEP}'; cat "$f"; done`;
    const result = await sshExec(this.connection, findCmd);

    if (!result.stdout.trim()) {
      return ok([]);
    }

    const entries: BackupListEntry[] = [];
    const chunks = result.stdout.split(SEP).filter(c => c.trim());

    for (const chunk of chunks) {
      try {
        const meta = JSON.parse(chunk.trim()) as BackupMetadata & { volumes?: { name: string }[] };
        const dir = this.getBackupDir(meta.service);

        // For volume backups with multiple volumes, filePath points to first volume's file
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
        });
      } catch {
        // Skip malformed metadata
      }
    }

    return ok(entries);
  }

  /**
   * Restore from a backup
   */
  async restore(
    service: string,
    backupId: string,
    config: BackupAccessoryConfig,
    compression?: 'gzip' | 'none'
  ): Promise<Result<void, Error>> {
    const dbType = config.type;
    const backupDir = this.getBackupDir(service);

    // Determine compression from argument or read from metadata
    let backupCompression = compression;
    if (!backupCompression) {
      const metaPath = `${backupDir}/${backupId}.meta.json`;
      const metaResult = await sshExec(this.connection, `cat '${shellEscape(metaPath)}' 2>/dev/null`);
      if (!metaResult.stdout.trim()) {
        return err(new Error(`Backup ${backupId} not found`));
      }
      try {
        const meta: BackupMetadata = JSON.parse(metaResult.stdout.trim());
        backupCompression = meta.compression;
      } catch {
        return err(new Error(`Invalid backup metadata for ${backupId}`));
      }
    }

    // Volume restore uses a different flow (docker run instead of docker exec)
    if (dbType === 'volume') {
      return this.restoreVolumes(service, backupId, backupCompression);
    }

    const containerId = await this.stackService.findContainerForService(service);
    if (!containerId) {
      return err(new Error(`No running container found for service ${service}`));
    }

    const dataFile = this.getDataFilePath(backupDir, backupId, dbType, backupCompression);

    // Get credentials
    const creds = await this.getContainerCredentials(containerId, dbType);

    // Build restore command
    let restoreCommand: string;
    if (dbType === 'raw') {
      restoreCommand = config.restore_command!;
    } else {
      const strategy = DB_STRATEGIES[dbType];
      restoreCommand = config.restore_command || strategy.buildRestoreCommand(creds, config.restore_options);
    }

    // Build exec env flags
    const execEnvFlags = dbType !== 'raw'
      ? buildExecEnvFlags(DB_STRATEGIES[dbType].buildExecEnv(creds))
      : '';
    const envPart = execEnvFlags ? `${execEnvFlags} ` : '';

    const dockerExec = `docker exec -i ${envPart}'${shellEscape(containerId)}' sh -c '${shellEscape(restoreCommand)}'`;
    const fullCommand = backupCompression === 'gzip'
      ? `gunzip -c '${shellEscape(dataFile)}' | ${dockerExec}`
      : `cat '${shellEscape(dataFile)}' | ${dockerExec}`;

    const result = await sshExec(this.connection, fullCommand);
    if (result.exitCode !== 0) {
      return err(new Error(`Restore failed: ${result.stderr}`));
    }

    return ok(undefined);
  }

  /**
   * Prune old backups keeping only the last N (batched deletion).
   * Accepts optional pre-fetched entries to avoid a redundant SSH call.
   */
  async prune(
    service: string | undefined,
    retentionCount: number,
    prefetchedEntries?: BackupListEntry[]
  ): Promise<Result<number, Error>> {
    let entries: BackupListEntry[];
    if (prefetchedEntries) {
      // Defensive sort: ensure newest-first regardless of caller
      entries = [...prefetchedEntries].sort((a, b) =>
        b.timestamp.localeCompare(a.timestamp)
      );
    } else {
      const listResult = await this.list(service);
      if (!listResult.success) return err(listResult.error);
      entries = listResult.data;
    }
    if (entries.length <= retentionCount) {
      return ok(0);
    }

    // Entries are already sorted newest-first; remove from retentionCount onwards
    const toRemove = entries.slice(retentionCount);

    // Batch all file paths into a single rm command
    const filesToRemove: string[] = [];
    for (const entry of toRemove) {
      const backupDir = this.getBackupDir(entry.service);
      if (entry.dbType === 'volume') {
        // Volume backups may have multiple data files per ID
        filesToRemove.push(`'${shellEscape(backupDir)}'/${entry.id}.*.tar*`);
      } else {
        filesToRemove.push(`'${shellEscape(entry.filePath)}'`);
      }
      filesToRemove.push(`'${shellEscape(backupDir)}/${entry.id}.meta.json'`);
    }

    await sshExec(this.connection, `rm -f ${filesToRemove.join(' ')}`);

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

    if (!idOrLatest) {
      return ok(entries[0]);
    }

    const match = entries.find(e => e.id === idOrLatest || e.id.startsWith(idOrLatest));
    if (!match) {
      return err(new Error(`No backup matching "${idOrLatest}" found for service ${service}`));
    }

    return ok(match);
  }
}

/**
 * Factory function
 */
export function createBackupService(
  connection: SSHKeyConnection,
  stackName: string
): BackupService {
  return new BackupService(connection, stackName);
}
