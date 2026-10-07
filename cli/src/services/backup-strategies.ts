/**
 * Backup strategies — pure logic behind backup/restore operations.
 *
 * In-container dump/restore scripts, the host-side capture pipeline, container mount parsing,
 * file path construction and prune selection. No SSH — everything here is unit-testable
 * (see __tests__/backup-strategies.test.ts).
 */

import { posix } from 'path';
import type { BackupAccessoryConfig, BackupDbType } from '../utils/config';
import { ConfigError } from '../utils/errors';
import { shellQuote } from '../utils/ssh';
import { DOCKFLOW_BACKUPS_DIR } from '../constants';

// ─── Types ────────────────────────────────────────────────────────────────

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

export type DatabaseType = Exclude<BackupDbType, 'volume' | 'raw'>;

// ─── Types of backup ──────────────────────────────────────────────────────

export const DB_TYPES: Record<Exclude<BackupDbType, 'volume'>, { fileExtension: string; requiresServiceRestart: boolean }> = {
  postgres: { fileExtension: 'sql', requiresServiceRestart: false },
  mysql: { fileExtension: 'sql', requiresServiceRestart: false },
  mongodb: { fileExtension: 'archive', requiresServiceRestart: false },
  // the restore ends with SHUTDOWN NOSAVE so the staged dump.rdb is loaded on the next start
  redis: { fileExtension: 'rdb', requiresServiceRestart: true },
  raw: { fileExtension: 'bin', requiresServiceRestart: false },
};

// ─── In-container scripts ─────────────────────────────────────────────────
//
// The container's own shell reads its credentials from its own environment, so no secret appears
// on the host command line, and a password with `$`, spaces or quotes arrives intact.

const PG_PRELUDE = 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; ';
const PG_USER = '-U "${POSTGRES_USER:-postgres}"';
// the image creates a database named after the user when POSTGRES_DB is unset
const PG_DATABASE = '"${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';

// MYSQL_USER only goes with MYSQL_PASSWORD; otherwise root and its own password
const MYSQL_PRELUDE =
  'if [ -n "${MYSQL_USER:-}" ] && [ -n "${MYSQL_PASSWORD:-}" ]; then DF_USER="$MYSQL_USER"; export MYSQL_PWD="$MYSQL_PASSWORD"; ' +
  'else DF_USER=root; export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}"; fi; ';

const MONGO_ARGS =
  'set -- --archive; ' +
  'if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then set -- "$@" --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin; fi; ' +
  'if [ -n "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then set -- "$@" --password="$MONGO_INITDB_ROOT_PASSWORD"; fi; ' +
  'if [ -n "${MONGO_INITDB_DATABASE:-}" ]; then set -- "$@" --db="$MONGO_INITDB_DATABASE"; fi; ';

// BGSAVE, then wait for LASTSAVE to move: only the raw RDB bytes reach stdout. A save already in
// flight is fine too, it started after the data was written.
const REDIS_DUMP =
  'BEFORE=$(redis-cli LASTSAVE) && OUT=$(redis-cli BGSAVE) && echo "$OUT" | grep -qE "Background saving (started|scheduled)|already in progress" || { echo "BGSAVE failed: $OUT" >&2; exit 1; } && for i in $(seq 1 30); do AFTER=$(redis-cli LASTSAVE); [ "$AFTER" != "$BEFORE" ] && break; sleep 1; done && cat /data/dump.rdb';

// Stage the RDB and refuse an empty stream (an empty dump.rdb leaves Redis crash-looping), then
// SHUTDOWN NOSAVE so Redis does not overwrite the file with its in-memory data on the way down.
const REDIS_RESTORE =
  'cat > /data/dump.rdb.tmp; if ! [ -s /data/dump.rdb.tmp ]; then rm -f /data/dump.rdb.tmp; echo "restore: received an empty backup stream" >&2; exit 1; fi; mv /data/dump.rdb.tmp /data/dump.rdb && redis-cli SHUTDOWN NOSAVE || true';

/** Custom commands keep the credential exports `docker exec -e PGPASSWORD/MYSQL_PWD` used to provide. */
export function credentialPrelude(type: DatabaseType): string {
  switch (type) {
    case 'postgres':
      return PG_PRELUDE;
    case 'mysql':
      return MYSQL_PRELUDE;
    case 'mongodb':
    case 'redis':
      return '';
  }
}

function customCommand(command: string | undefined): string | null {
  return command !== undefined && command.trim() !== '' ? command : null;
}

function options(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? '' : ` ${trimmed}`;
}

function rawCommand(config: BackupAccessoryConfig, key: 'dump_command' | 'restore_command'): string {
  const command = customCommand(config[key]);
  if (command === null) {
    throw new ConfigError(`Backup type raw needs ${key}`, `Set backup.*.<service>.${key} in .dockflow/config.yml.`);
  }
  return command;
}

// pg_dump short options that take an argument: in a cluster such as `-xFc` the rest of the token
// belongs to the first of them.
const PG_SHORT_WITH_ARGUMENT = new Set(['d', 'E', 'e', 'f', 'F', 'h', 'j', 'n', 'N', 'p', 'S', 't', 'T', 'U', 'Z']);

function unquote(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, '').toLowerCase();
}

/** What `dump_options` tells pg_dump: every output format it selects, in order, and `--data-only`. */
function scanPgDumpOptions(dumpOptions: string | undefined): { formats: string[]; dataOnly: boolean } {
  const tokens = (dumpOptions ?? '').trim().split(/\s+/).filter((token) => token !== '');
  const formats: string[] = [];
  let dataOnly = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') break;
    if (token.startsWith('--')) {
      const [name, value] = token.slice(2).split(/=(.*)/s, 2);
      if (name === 'data-only') dataOnly = true;
      // getopt_long accepts any unambiguous prefix of --format
      if (name.length >= 2 && 'format'.startsWith(name)) formats.push(value ?? tokens[++i] ?? '');
      continue;
    }
    if (!token.startsWith('-')) continue;
    for (let c = 1; c < token.length; c++) {
      const flag = token[c];
      if (flag === 'a') dataOnly = true;
      if (!PG_SHORT_WITH_ARGUMENT.has(flag)) continue;
      const rest = token.slice(c + 1);
      const value = rest !== '' ? rest : (tokens[++i] ?? '');
      if (flag === 'F') formats.push(value);
      break;
    }
  }
  return { formats: formats.map(unquote), dataOnly };
}

/** The dump script run by `sh -c` in the service container; stdout is the backup. */
export function buildDumpScript(config: BackupAccessoryConfig): string {
  const type = config.type;
  if (type === 'volume') throw new ConfigError('Backup type volume has no dump script');
  if (type === 'raw') return rawCommand(config, 'dump_command');
  const custom = customCommand(config.dump_command);
  if (custom !== null) return credentialPrelude(type) + custom;

  const opts = options(config.dump_options);
  switch (type) {
    case 'postgres': {
      // --clean: a restore replaces what the dump holds instead of adding its rows to the live ones;
      // pg_dump refuses it together with --data-only, which has no objects to drop anyway
      const clean = scanPgDumpOptions(config.dump_options).dataOnly ? '' : ' --clean --if-exists';
      return `${PG_PRELUDE}exec pg_dump ${PG_USER}${clean}${opts} ${PG_DATABASE}`;
    }
    case 'mysql':
      return (
        `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; ` +
        `exec mysqldump -u"$DF_USER"${opts} "$@"`
      );
    case 'mongodb':
      return `${MONGO_ARGS}exec mongodump "$@"${opts}`;
    case 'redis':
      return REDIS_DUMP;
  }
}

/** The restore script run by `sh -c` in the service container; the backup arrives on stdin. */
export function buildRestoreScript(config: BackupAccessoryConfig): string {
  const type = config.type;
  if (type === 'volume') throw new ConfigError('Backup type volume has no restore script');
  if (type === 'raw') return rawCommand(config, 'restore_command');
  const custom = customCommand(config.restore_command);
  if (custom !== null) return credentialPrelude(type) + custom;

  const opts = options(config.restore_options);
  switch (type) {
    case 'postgres':
      return `${PG_PRELUDE}exec psql ${PG_USER}${opts} ${PG_DATABASE}`;
    case 'mysql':
      return (
        `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set --; fi; ` +
        `exec mysql -u"$DF_USER"${opts} "$@"`
      );
    case 'mongodb':
      // --drop: each collection of the archive replaces the live one instead of being merged into it
      return `${MONGO_ARGS}exec mongorestore "$@" --drop${opts}`;
    case 'redis':
      return REDIS_RESTORE;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Runs `producer` on a node and writes its stdout to `remotePath` (mode 0600, directory created),
 * exiting with the PRODUCER's status, or gzip's when the producer succeeded: without pipefail a gzip
 * pipeline reports gzip's alone, and a dump that dies midway becomes a CRC-valid truncated archive.
 */
export function buildCapturePipeline(producer: string, remotePath: string, gzip: boolean): string {
  const dir = shellQuote(posix.dirname(remotePath));
  const file = shellQuote(remotePath);
  if (!gzip) return `umask 077 && mkdir -p ${dir} && ${producer} > ${file}`;
  const rc = shellQuote(`${remotePath}.rc`);
  return (
    `umask 077 && mkdir -p ${dir} && { ${producer}; echo "$?" > ${rc}; } | gzip -c > ${file}; z=$?; ` +
    `rc=$(cat ${rc} 2>/dev/null); rm -f ${rc}; [ "\${rc:-255}" -eq 0 ] || exit "\${rc:-255}"; exit "$z"`
  );
}

/** Convert a mount destination path to a safe filename component */
export function sanitizePathName(mountPath: string): string {
  return mountPath.replace(/^\/+/, '').replace(/\//g, '-') || 'root';
}

/**
 * Command that prints a single verdict about a backup archive:
 *   OK       — readable, integrity-checked (gzip CRC) and non-empty
 *   EMPTY    — valid but holds zero bytes of content
 *   CORRUPT  — missing, unreadable, or truncated (gzip CRC mismatch)
 *
 * Needed because remote dump/tar pipelines exit with the LAST command's
 * status (gzip/cat), so an upstream failure silently yields a valid-but-empty
 * archive — and a container dying mid-dump yields a truncated one. Every
 * backup is checked after writing and every restore source before streaming.
 * For uncompressed archives there is no integrity data, so only existence
 * and non-emptiness can be verified.
 */
export function buildArchiveCheckCommand(filePath: string, compression: 'gzip' | 'none'): string {
  const f = shellQuote(filePath);
  if (compression === 'gzip') {
    return (
      `if ! gunzip -t ${f} 2>/dev/null; then echo CORRUPT; ` +
      `elif [ "$(gunzip -c ${f} 2>/dev/null | head -c 1 | wc -c)" -eq 0 ]; then echo EMPTY; ` +
      `else echo OK; fi`
    );
  }
  return (
    `if [ ! -f ${f} ]; then echo CORRUPT; ` +
    `elif [ "$(head -c 1 ${f} 2>/dev/null | wc -c)" -eq 0 ]; then echo EMPTY; ` +
    `else echo OK; fi`
  );
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
    ext = DB_TYPES[dbType].fileExtension;
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
