/**
 * Backup Service
 *
 * Manages backup and restore operations for accessory databases and Docker volumes.
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
  /** Host of the node where this backup is stored */
  nodeHost: string;
  /** SSH port of the node where this backup is stored */
  nodePort: number;
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
  /** When true, the restore command kills the container process (e.g. Redis SHUTDOWN NOSAVE)
   *  and requires an explicit Swarm service restart to guarantee the container comes back. */
  requiresServiceRestart?: boolean;
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
      // Trigger BGSAVE and wait for it to complete by polling LASTSAVE.
      // The BGSAVE/LASTSAVE output is redirected to /dev/null — only the raw RDB bytes are emitted.
      return 'BEFORE=$(redis-cli LASTSAVE) && redis-cli BGSAVE > /dev/null && for i in $(seq 1 30); do AFTER=$(redis-cli LASTSAVE); [ "$AFTER" != "$BEFORE" ] && break; sleep 1; done && cat /data/dump.rdb';
    },
    buildRestoreCommand() {
      // Write the RDB file, then SHUTDOWN NOSAVE so Redis doesn't overwrite it
      // with in-memory data during shutdown. The service restart is handled
      // explicitly by the restore() method via `docker service update --force`.
      return 'cat > /data/dump.rdb && redis-cli SHUTDOWN NOSAVE || true';
    },
    buildExecEnv() {
      return {};
    },
    fileExtension: 'rdb',
    requiresServiceRestart: true,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function generateBackupId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`;
}

/**
 * Build docker exec env flags from a key-value map.
 * SAFETY: Keys are NOT shell-escaped — callers must only pass hardcoded keys
 * (e.g. PGPASSWORD, MYSQL_PWD) via DbStrategy.buildExecEnv(). Never pass user input as keys.
 */
function buildExecEnvFlags(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        throw new Error(`Invalid env key: ${k}`);
      }
      return `-e ${k}='${shellEscape(v)}'`;
    })
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
    /** Manager connection — used for Swarm operations (service restart) */
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string,
    /** All node connections — used to find containers and run backup/restore on any node */
    private readonly allConnections: SSHKeyConnection[] = []
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
   * Resolve the node connection for a backup entry by matching nodeHost/nodePort.
   * Falls back to the manager connection if no match found (backwards compat with
   * old backups that don't have nodeHost/nodePort in metadata).
   */
  private resolveNodeConnection(entry: { nodeHost?: string; nodePort?: number }): SSHKeyConnection {
    if (!entry.nodeHost) return this.connection;
    const all = [this.connection, ...this.allConnections];
    return all.find(c => c.host === entry.nodeHost && c.port === (entry.nodePort ?? 22))
      ?? this.connection;
  }

  /**
   * Read environment variables from a running container
   */
  private async getContainerCredentials(
    containerId: string,
    dbType: BackupDbType,
    nodeConn: SSHKeyConnection
  ): Promise<ContainerCredentials> {
    if (dbType === 'raw' || dbType === 'volume') return {};

    const strategy = DB_STRATEGIES[dbType];
    const result = await sshExec(
      nodeConn,
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
   * Create a backup of an accessory service.
   * The backup file is written on the node where the container runs.
   */
  async backup(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none' = 'gzip'
  ): Promise<Result<BackupMetadata, Error>> {
    const found = await this.stackService.findContainerForService(service, this.allConnections);
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

    // Get credentials and create backup directory in parallel (independent SSH calls)
    const [creds, mkdirResult] = await Promise.all([
      this.getContainerCredentials(containerId, dbType, nodeConn),
      sshExec(nodeConn, `mkdir -p '${shellEscape(backupDir)}'`),
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

    const result = await sshExec(nodeConn, fullCommand);
    if (result.exitCode !== 0) {
      await sshExec(nodeConn, `rm -f '${shellEscape(filePath)}'`);
      return err(new Error(`Backup failed: ${result.stderr}`));
    }

    const durationMs = Date.now() - startTime;

    // Get file size
    const metaPath = `${backupDir}/${backupId}.meta.json`;
    const sizeCmd = `SIZE=$(stat -c %s '${shellEscape(filePath)}' 2>/dev/null || echo 0) && echo $SIZE`;
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

    await sshExec(
      nodeConn,
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
    nodeConn: SSHKeyConnection,
    excludePatterns?: string[],
    includeBindMounts: boolean = true
  ): Promise<MountInfo[]> {
    const result = await sshExec(
      nodeConn,
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

    const mkdirResult = await sshExec(nodeConn, `mkdir -p '${shellEscape(backupDir)}'`);
    if (mkdirResult.exitCode !== 0) {
      return err(new Error(`Failed to create backup directory: ${mkdirResult.stderr}`));
    }

    const startTime = Date.now();

    // Build all file paths upfront for reliable cleanup
    const filePaths = mounts.map(m => this.getDataFilePath(backupDir, backupId, 'volume', compression, m.name));

    // Backup all volumes in parallel (independent SSH calls, all on nodeConn)
    const backupResults = await Promise.all(mounts.map(async (mount, i) => {
      const filePath = filePaths[i];

      // Named volumes: tar via temporary alpine container
      // Bind mounts: tar the host path directly
      const tarCmd = mount.mountType === 'volume'
        ? `docker run --rm -v '${shellEscape(mount.source)}':/backup-source:ro alpine tar cf - -C /backup-source .`
        : `tar cf - -C '${shellEscape(mount.source)}' .`;

      const fullCommand = compression === 'gzip'
        ? `${tarCmd} | gzip > '${shellEscape(filePath)}'`
        : `${tarCmd} > '${shellEscape(filePath)}'`;

      const result = await sshExec(nodeConn, fullCommand);
      if (result.exitCode !== 0) {
        return { ok: false as const, mount, error: result.stderr };
      }

      const sizeCmd = `stat -c %s '${shellEscape(filePath)}' 2>/dev/null || echo 0`;
      const sizeResult = await sshExec(nodeConn, sizeCmd);
      const sizeBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;
      return { ok: true as const, mount, sizeBytes };
    }));

    // Check for failures — clean up all files for this backup ID on any error
    const failed = backupResults.find(r => !r.ok);
    if (failed) {
      const cleanupPaths = filePaths.map(f => `'${shellEscape(f)}'`).join(' ');
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

    // Extended metadata includes per-volume/bind details
    const extendedMeta = { ...metadata, volumes: volumeEntries };
    const metaPath = `${backupDir}/${backupId}.meta.json`;
    await sshExec(
      nodeConn,
      `cat > '${shellEscape(metaPath)}' << 'DOCKFLOW_EOF'\n${JSON.stringify(extendedMeta, null, 2)}\nDOCKFLOW_EOF`
    );

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
    const metaResult = await sshExec(nodeConn, `cat '${shellEscape(metaPath)}' 2>/dev/null`);
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
      nodeConn,
      `docker volume ls --filter "label=com.docker.stack.namespace=${this.stackName}" --format "{{.Name}}"`
    );
    const existingVolumes = volListResult.stdout.trim().split('\n').filter(Boolean);

    const restoreTasks: { entry: typeof volumeEntries[number]; fullCommand: string }[] = [];

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

      restoreTasks.push({ entry, fullCommand });
    }

    const restoreResults = await Promise.allSettled(
      restoreTasks.map(({ fullCommand }) => sshExec(nodeConn, fullCommand)),
    );

    for (let i = 0; i < restoreResults.length; i++) {
      const r = restoreResults[i];
      const { entry } = restoreTasks[i];
      const mountType = entry.mountType || 'volume';
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
      const findCmd = `find '${shellEscape(baseDir)}' -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${SEP}'; cat "$f"; done`;
      const result = await sshExec(conn, findCmd);
      return result.stdout;
    }));

    const entries: BackupListEntry[] = [];
    const seenIds = new Set<string>();

    for (const stdout of perNodeResults) {
      if (!stdout.trim()) continue;
      const chunks = stdout.split(SEP).filter(c => c.trim());

      for (const chunk of chunks) {
        try {
          const meta = JSON.parse(chunk.trim()) as BackupMetadata & { volumes?: { name: string }[] };

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
            nodeHost: meta.nodeHost ?? this.connection.host,
            nodePort: meta.nodePort ?? this.connection.port,
          });
        } catch {
          // Skip malformed metadata
        }
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

    const found = await this.stackService.findContainerForService(service, this.allConnections);
    if (!found) {
      return err(new Error(`No running container found for service ${service}`));
    }
    const { containerId, connection: containerConn } = found;

    const dataFile = this.getDataFilePath(backupDir, backupId, dbType, backupCompression);

    // Get credentials from the container's node
    const creds = await this.getContainerCredentials(containerId, dbType, containerConn);

    // Build restore command
    let restoreCommand: string;
    if (dbType === 'raw') {
      restoreCommand = config.restore_command!;
    } else {
      restoreCommand = config.restore_command || DB_STRATEGIES[dbType].buildRestoreCommand(creds, config.restore_options);
    }

    // Build exec env flags
    const execEnvFlags = dbType !== 'raw'
      ? buildExecEnvFlags(DB_STRATEGIES[dbType].buildExecEnv(creds))
      : '';
    const envPart = execEnvFlags ? `${execEnvFlags} ` : '';

    // Backup file and container are on the same node — backups are created
    // via docker exec on the container's node, so the file is always local.
    const dockerExec = `docker exec -i ${envPart}'${shellEscape(containerId)}' sh -c '${shellEscape(restoreCommand)}'`;
    const fullCommand = backupCompression === 'gzip'
      ? `gunzip -c '${shellEscape(dataFile)}' | ${dockerExec}`
      : `cat '${shellEscape(dataFile)}' | ${dockerExec}`;

    const strategy = dbType !== 'raw' ? DB_STRATEGIES[dbType] : null;
    const result = await sshExec(nodeConn, fullCommand);

    // For strategies that kill the container as part of restore (e.g. Redis SHUTDOWN NOSAVE),
    // a non-zero exit from docker exec is expected — the process died mid-exec.
    // Only treat it as an error if there's actual stderr output.
    const restoreKillsContainer = strategy?.requiresServiceRestart ?? false;
    if (result.exitCode !== 0 && (!restoreKillsContainer || result.stderr.trim())) {
      return err(new Error(`Restore failed: ${result.stderr}`));
    }

    // If the restore killed the container (e.g. Redis SHUTDOWN NOSAVE):
    // Swarm's restart_policy brings it back automatically in most cases.
    // We also force a service update as a safety net for setups where the restart
    // policy is disabled or exhausted — non-fatal if it fails.
    if (strategy?.requiresServiceRestart) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const restartResult = await this.stackService.restart(service);
      if (!restartResult.success) {
        printDebug(`Service update after restore failed (non-fatal): ${restartResult.message}`);
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

    // Group by node to batch rm calls per node
    const byNode = new Map<string, { conn: SSHKeyConnection; paths: string[] }>();
    for (const entry of toRemove) {
      const nodeConn = this.resolveNodeConnection(entry);
      const key = `${nodeConn.host}:${nodeConn.port}`;
      if (!byNode.has(key)) byNode.set(key, { conn: nodeConn, paths: [] });
      const node = byNode.get(key)!;
      const backupDir = this.getBackupDir(entry.service);
      if (entry.dbType === 'volume') {
        node.paths.push(`'${shellEscape(backupDir)}'/${entry.id}.*.tar*`);
      } else {
        node.paths.push(`'${shellEscape(entry.filePath)}'`);
      }
      node.paths.push(`'${shellEscape(backupDir)}/${entry.id}.meta.json'`);
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
  stackName: string,
  allConnections: SSHKeyConnection[] = []
): BackupService {
  return new BackupService(connection, stackName, allConnections);
}
