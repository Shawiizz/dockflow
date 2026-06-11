/**
 * Backup strategies — pure logic behind backup/restore operations.
 *
 * Database dump/restore command builders, container env/mount parsing,
 * file path construction and prune selection. No SSH — everything here
 * is unit-testable (see __tests__/backup-strategies.test.ts).
 */

import type { BackupDbType } from '../utils/config';
import { shellEscape } from '../utils/ssh';
import { DOCKFLOW_BACKUPS_DIR } from '../constants';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ContainerCredentials {
  user?: string;
  password?: string;
  database?: string;
}

export interface MountInfo {
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

export interface DbStrategy {
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

export const DB_STRATEGIES: Record<Exclude<BackupDbType, 'raw' | 'volume'>, DbStrategy> = {
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
      return 'BEFORE=$(redis-cli LASTSAVE) && OUT=$(redis-cli BGSAVE) && echo "$OUT" | grep -q "Background saving started" || { echo "BGSAVE failed: $OUT" >&2; exit 1; } && for i in $(seq 1 30); do AFTER=$(redis-cli LASTSAVE); [ "$AFTER" != "$BEFORE" ] && break; sleep 1; done && cat /data/dump.rdb';
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

// ─── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Build docker exec env flags from a key-value map.
 * SAFETY: Keys are NOT shell-escaped — callers must only pass hardcoded keys
 * (e.g. PGPASSWORD, MYSQL_PWD) via DbStrategy.buildExecEnv(). Never pass user input as keys.
 */
export function buildExecEnvFlags(env: Record<string, string>): string {
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
export function sanitizePathName(mountPath: string): string {
  return mountPath.replace(/^\/+/, '').replace(/\//g, '-') || 'root';
}

/**
 * Parse `docker inspect --format '{{json .Config.Env}}'` output into credentials
 * using a strategy's env mapping. Throws on malformed JSON (caller decides how
 * to report). Empty output yields empty credentials.
 */
export function parseContainerEnv(
  stdout: string,
  envMapping: Record<string, keyof ContainerCredentials>,
): ContainerCredentials {
  const creds: ContainerCredentials = {};
  if (!stdout.trim()) return creds;

  const envVars: string[] = JSON.parse(stdout.trim());
  for (const envVar of envVars) {
    const eqIndex = envVar.indexOf('=');
    if (eqIndex === -1) continue;
    const key = envVar.substring(0, eqIndex);
    const value = envVar.substring(eqIndex + 1);
    const credKey = envMapping[key];
    if (credKey && value) {
      creds[credKey] = value;
    }
  }

  return creds;
}

/** Strip the stack name prefix from a Docker volume name for cleaner filenames */
function shortVolumeName(volumeName: string, stackName: string): string {
  const prefix = `${stackName}_`;
  return volumeName.startsWith(prefix) ? volumeName.slice(prefix.length) : volumeName;
}

/**
 * Parse `docker inspect --format '{{json .Mounts}}'` output into named volumes
 * and read-write bind mounts, applying exclude patterns (glob-style `*`).
 * Throws on malformed JSON. Empty output yields an empty list.
 */
export function parseContainerMounts(
  stdout: string,
  stackName: string,
  excludePatterns?: string[],
  includeBindMounts: boolean = true,
): MountInfo[] {
  if (!stdout.trim()) return [];

  const mounts: Array<{
    Type: string;
    Name?: string;
    Source: string;
    Destination: string;
    RW?: boolean;
  }> = JSON.parse(stdout.trim());

  let infos: MountInfo[] = [];

  for (const m of mounts) {
    if (m.Type === 'volume' && m.Name) {
      infos.push({
        mountType: 'volume',
        name: shortVolumeName(m.Name, stackName),
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
}

/** Derive the data file path for a backup from its metadata */
export function buildDataFilePath(
  backupDir: string,
  id: string,
  dbType: BackupDbType,
  compression: 'gzip' | 'none',
  volumeName?: string,
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

/** Backup directory for a service within a stack */
export function buildBackupDir(stackName: string, service: string): string {
  return `${DOCKFLOW_BACKUPS_DIR}/${stackName}/${service}`;
}

/**
 * Select which backups to delete given a retention count.
 * Sorts newest-first defensively, keeps the first `retentionCount`.
 */
export function selectBackupsToPrune<T extends { timestamp: string }>(
  entries: T[],
  retentionCount: number,
): T[] {
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (sorted.length <= retentionCount) return [];
  return sorted.slice(retentionCount);
}

/**
 * Resolve a backup entry by exact ID, ID prefix, or "latest" (undefined).
 * Entries are expected newest-first.
 */
export function findBackupMatch<T extends { id: string }>(
  entries: T[],
  idOrLatest?: string,
): T | null {
  if (entries.length === 0) return null;
  if (!idOrLatest) return entries[0];
  return entries.find(e => e.id === idOrLatest || e.id.startsWith(idOrLatest)) ?? null;
}
