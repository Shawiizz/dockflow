/**
 * Backup strategies: the pure half of backup and restore, shared by both orchestrators.
 *
 * In-container dump/restore scripts (credentials are read by the container's own shell from its
 * own environment, never by Dockflow), the archive verification script run on the node holding a
 * file, the host-side capture pipeline, the extract-beside-then-swap scripts of a volume restore,
 * mount parsing, paths and prune selection. Nothing here opens a connection.
 */

import { posix } from 'path';
import { DOCKFLOW_BACKUPS_DIR } from '../constants';
import type { BackupAccessoryConfig, BackupDbType } from '../utils/config';
import { ConfigError } from '../utils/errors';
import { shellQuote } from '../utils/ssh';
import type { StackRef } from './orchestrator/interfaces';

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

/** which end-to-end check a backup can get before a restore replaces anything (design-06 4.1) */
export type ArchiveIntegrity = 'tar' | 'gzip' | 'trailer' | 'opaque';

// ─── Types of backup ──────────────────────────────────────────────────────

export const DB_TYPES: Record<Exclude<BackupDbType, 'volume'>, { fileExtension: string; requiresServiceRestart: boolean }> = {
  postgres: { fileExtension: 'sql', requiresServiceRestart: false },
  mysql: { fileExtension: 'sql', requiresServiceRestart: false },
  mongodb: { fileExtension: 'archive', requiresServiceRestart: false },
  // the restore ends with SHUTDOWN NOSAVE so the staged dump.rdb is loaded on the next start
  redis: { fileExtension: 'rdb', requiresServiceRestart: true },
  raw: { fileExtension: 'bin', requiresServiceRestart: false },
};

/** Written by the in-container restore script on stderr, parsed by `services/backup.ts` for both orchestrators. */
export const RESTORE_REFUSAL_MARKER = 'DOCKFLOW_REFUSED: ';
/** Last line of a plain-text postgres/mysql dump taken with `compression: none`; an SQL comment on restore. */
export const DUMP_TRAILER = '-- DOCKFLOW_DUMP_END';

// ─── In-container scripts ─────────────────────────────────────────────────

const PG_PRELUDE = 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; ';
const PG_USER = '-U "${POSTGRES_USER:-postgres}"';
const PG_DATABASE = '"${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';

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

// With appendonly Redis loads the AOF at startup and ignores the restored RDB. stdin is drained so
// the host side of the pipe never fails with a broken pipe instead of this refusal.
const REDIS_APPENDONLY_GUARD =
  'if [ "$(redis-cli CONFIG GET appendonly 2>/dev/null | tail -n 1)" = "yes" ]; then echo "DOCKFLOW_REFUSED: redis-appendonly" >&2; cat > /dev/null; exit 3; fi; ';

// Stage the RDB and refuse an empty stream (an empty dump.rdb leaves Redis crash-looping), then
// SHUTDOWN NOSAVE so Redis does not overwrite the file with its in-memory data on the way down.
const REDIS_RESTORE =
  'cat > /data/dump.rdb.tmp; if ! [ -s /data/dump.rdb.tmp ]; then rm -f /data/dump.rdb.tmp; echo "restore: received an empty backup stream" >&2; exit 1; fi; mv /data/dump.rdb.tmp /data/dump.rdb && redis-cli SHUTDOWN NOSAVE || true';

const TRAILER_SUFFIX = ` && printf '%s\\n' '${DUMP_TRAILER}'`;

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

/** The dump script run by `sh -c` in the service container; stdout is the backup. */
export function buildDumpScript(config: BackupAccessoryConfig, compression: 'gzip' | 'none'): string {
  const type = config.type;
  if (type === 'volume') throw new ConfigError('Backup type volume has no dump script');
  if (type === 'raw') return rawCommand(config, 'dump_command');
  const custom = customCommand(config.dump_command);
  if (custom !== null) return credentialPrelude(type) + custom;

  const trailer = integrityOf(config, compression) === 'trailer';
  const exec = trailer ? '' : 'exec ';
  const end = trailer ? TRAILER_SUFFIX : '';
  const opts = options(config.dump_options);
  switch (type) {
    case 'postgres':
      // --clean: a restore replaces what the dump holds instead of adding its rows to the live ones
      return `${PG_PRELUDE}${exec}pg_dump ${PG_USER} --clean --if-exists${opts} ${PG_DATABASE}${end}`;
    case 'mysql':
      return (
        `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; ` +
        `${exec}mysqldump -u"$DF_USER"${opts} "$@"${end}`
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
      return REDIS_APPENDONLY_GUARD + REDIS_RESTORE;
  }
}

/** The refusal id the restore script announced on stderr, if any. */
export function parseRestoreRefusal(stderr: string): 'redis-appendonly' | null {
  for (const line of stderr.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith(RESTORE_REFUSAL_MARKER) && text.slice(RESTORE_REFUSAL_MARKER.length).trim() === 'redis-appendonly') {
      return 'redis-appendonly';
    }
  }
  return null;
}

/** stderr without the internal marker lines, for messages shown to the user */
export function stripRefusalMarker(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !line.includes(RESTORE_REFUSAL_MARKER.trim()))
    .join('\n');
}

// ─── Integrity ────────────────────────────────────────────────────────────

// pg_dump short options that take an argument: in a cluster such as `-xFc` the rest of the token
// belongs to the first of them.
const PG_SHORT_WITH_ARGUMENT = new Set(['d', 'E', 'e', 'f', 'F', 'h', 'j', 'n', 'N', 'p', 'S', 't', 'T', 'U', 'Z']);

function unquote(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, '').toLowerCase();
}

/** Every output format `dump_options` selects, in order (getopt: the last one wins). */
function pgDumpFormats(dumpOptions: string | undefined): string[] {
  const tokens = (dumpOptions ?? '').trim().split(/\s+/).filter((token) => token !== '');
  const formats: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') break;
    if (token.startsWith('--')) {
      const [name, value] = token.slice(2).split(/=(.*)/s, 2);
      // getopt_long accepts any unambiguous prefix of --format
      if (name.length >= 2 && 'format'.startsWith(name)) formats.push(value ?? tokens[++i] ?? '');
      continue;
    }
    if (!token.startsWith('-')) continue;
    for (let c = 1; c < token.length; c++) {
      const flag = token[c];
      if (!PG_SHORT_WITH_ARGUMENT.has(flag)) continue;
      const rest = token.slice(c + 1);
      const value = rest !== '' ? rest : (tokens[++i] ?? '');
      if (flag === 'F') formats.push(value);
      break;
    }
  }
  return formats.map(unquote);
}

function isPlainPgDump(dumpOptions: string | undefined): boolean {
  const formats = pgDumpFormats(dumpOptions);
  const last = formats.at(-1);
  return last === undefined || last === 'p' || last === 'plain';
}

/** Which check a backup of this configuration can get (design-06 4.1 table). */
export function integrityOf(config: BackupAccessoryConfig, compression: 'gzip' | 'none'): ArchiveIntegrity {
  if (config.type === 'volume') return 'tar';
  if (compression === 'gzip') return 'gzip';
  if (customCommand(config.dump_command) !== null) return 'opaque';
  if (config.type === 'mysql') return 'trailer';
  if (config.type === 'postgres' && isPlainPgDump(config.dump_options)) return 'trailer';
  return 'opaque';
}

/**
 * Checks an archive on the node holding it, before anything is destroyed. Prints `OK` and exits 0
 * when sound; otherwise prints one line naming the problem and exits 1. POSIX sh without
 * pipefail, so exit statuses inside pipelines are captured through a temporary file. `opaque`
 * runs only the existence and non-empty check.
 */
export function buildVerifyScript(remotePath: string, compression: 'gzip' | 'none', integrity: ArchiveIntegrity): string {
  const lines = [`f=${shellQuote(remotePath)}`, `[ -s "$f" ] || { echo 'the file is missing or empty'; exit 1; }`];
  switch (integrity) {
    case 'tar':
      lines.push(
        `t=$(mktemp) || { echo 'cannot create a temporary file'; exit 1; }`,
        compression === 'gzip'
          ? 'n=$({ { gunzip -c "$f"; echo "$?" > "$t.z"; } | tar tf -; echo "$?" > "$t"; } | wc -l)'
          : 'n=$({ tar tf - < "$f"; echo "$?" > "$t"; } | wc -l)',
        'z=$(cat "$t.z" 2>/dev/null); r=$(cat "$t" 2>/dev/null); rm -f "$t" "$t.z"',
        // tar first: a tar failure also kills gunzip with SIGPIPE
        `[ "\${r:-255}" -eq 0 ] || { echo "tar cannot read the archive (exit \${r:-255})"; exit 1; }`,
        `[ "\${z:-0}" -eq 0 ] || { echo 'the gzip stream is corrupt or truncated'; exit 1; }`,
        `[ "$n" -ge 1 ] || { echo 'the archive has no entries'; exit 1; }`,
      );
      // an uncompressed archive cut exactly at an entry boundary lists cleanly; the two zero
      // end-of-archive blocks GNU and busybox tar both write are what is missing then
      if (compression === 'none') {
        lines.push(
          `[ "$(tail -c 1024 "$f" | tr -d '\\000' | wc -c)" -eq 0 ] || { echo 'the archive has no end-of-archive marker (truncated)'; exit 1; }`,
        );
      }
      break;
    case 'gzip':
      lines.push(
        `gunzip -t "$f" || { echo 'the gzip stream is corrupt or truncated'; exit 1; }`,
        `[ "$(gunzip -c "$f" 2>/dev/null | head -c 1 | wc -c)" -eq 1 ] || { echo 'the backup is empty'; exit 1; }`,
      );
      break;
    case 'trailer':
      lines.push(`[ "$(tail -n 1 "$f")" = '${DUMP_TRAILER}' ] || { echo 'the dump has no integrity marker'; exit 1; }`);
      break;
    case 'opaque':
      break;
  }
  lines.push('echo OK');
  return lines.join('\n');
}

// ─── Host-side pipelines and volume restore scripts ───────────────────────

/**
 * Runs `producer` on a node and writes its stdout to `remotePath` (0600, directory created),
 * exiting with the PRODUCER's status: without pipefail a gzip pipeline would report gzip's.
 */
export function buildCapturePipeline(producer: string, remotePath: string, gzip: boolean): string {
  const dir = shellQuote(posix.dirname(remotePath));
  const file = shellQuote(remotePath);
  if (!gzip) return `umask 077 && mkdir -p ${dir} && ${producer} > ${file}`;
  const rc = shellQuote(`${remotePath}.rc`);
  return (
    `umask 077 && mkdir -p ${dir} && { ${producer}; echo "$?" > ${rc}; } | gzip -c > ${file}; ` +
    `rc=$(cat ${rc} 2>/dev/null); rm -f ${rc}; exit "\${rc:-255}"`
  );
}

/** Mount point of the volume inside the Swarm restore container */
export const RESTORE_MOUNT_DIR = '/dockflow/v0';

function checkId8(id8: string): string {
  if (!/^[0-9a-z]{1,16}$/.test(id8)) throw new Error(`Invalid restore id ${JSON.stringify(id8)}`);
  return id8;
}

/** Directory the archive is extracted into, inside the volume beside its current contents */
export function restoreDirName(id8: string): string {
  return `.dockflow-restore-${checkId8(id8)}`;
}

/** Directory the previous contents are moved into during the swap */
export function previousDirName(id8: string): string {
  return `.dockflow-old-${checkId8(id8)}`;
}

/** Phase 6a: extract stdin beside the data; nothing of the current contents is touched. */
export function buildExtractScript(mountDir: string, id8: string): string {
  return [
    `set -e; d=${shellQuote(mountDir)}; new="$d/${restoreDirName(id8)}"`,
    'rm -rf "$new"; mkdir "$new"',
    'tar xf - -C "$new"',
  ].join('\n');
}

/**
 * Phase 6b, run only after every extraction succeeded: renames within one filesystem, no data
 * copied. The previous contents are kept in the old directory until the new ones are in place.
 */
export function buildSwapScript(mountDir: string, id8: string): string {
  return [
    `set -e; d=${shellQuote(mountDir)}; new="$d/${restoreDirName(id8)}"; old="$d/${previousDirName(id8)}"`,
    'rm -rf "$old"; mkdir "$old"',
    'for e in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; case "$e" in "$new"|"$old") continue;; esac; mv "$e" "$old/"; done',
    'for e in "$new"/* "$new"/.[!.]* "$new"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; mv "$e" "$d/"; done',
    'rmdir "$new"; rm -rf "$old"',
  ].join('\n');
}

/** Removes what a failed phase 6a left beside the data. */
export function buildDiscardScript(mountDir: string, id8: string): string {
  return `d=${shellQuote(mountDir)}; rm -rf "$d/${restoreDirName(id8)}"`;
}

// ─── Mounts ───────────────────────────────────────────────────────────────

/** Convert a mount destination path to a safe filename component */
export function sanitizePathName(mountPath: string): string {
  return mountPath.replace(/^\/+/, '').replace(/\//g, '-') || 'root';
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/** `exclude_volumes` matcher: `*` globs tested against every candidate (name, source, mount path) */
export function isExcluded(patterns: readonly string[], candidates: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
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

  const infos: MountInfo[] = [];
  for (const m of mounts) {
    if (m.Type === 'volume' && m.Name) {
      infos.push({ mountType: 'volume', name: shortVolumeName(m.Name, stackName), destination: m.Destination, source: m.Name });
    } else if (m.Type === 'bind' && m.RW !== false && includeBindMounts) {
      infos.push({ mountType: 'bind', name: sanitizePathName(m.Destination), destination: m.Destination, source: m.Source });
    }
  }

  const patterns = excludePatterns ?? [];
  return infos.filter((info) => !isExcluded(patterns, [info.name, info.source, info.destination]));
}

// ─── Paths, scope and selection ───────────────────────────────────────────

/** The backup directory name of a role: one signature for the commands and the engine. */
export function backupScopeName(ref: StackRef, stackName: string): string {
  return ref.role === 'accessory' ? `${stackName}-accessories` : stackName;
}

/** Derive the data file path for a backup from its metadata */
export function buildDataFilePath(
  backupDir: string,
  id: string,
  dbType: BackupDbType,
  compression: 'gzip' | 'none',
  volumeName?: string,
): string {
  const ext = dbType === 'volume' ? 'tar' : DB_TYPES[dbType].fileExtension;
  const suffix = compression === 'gzip' ? '.gz' : '';
  const volPart = volumeName ? `.${volumeName}` : '';
  return `${backupDir}/${id}${volPart}.${ext}${suffix}`;
}

/** Backup directory for a service within a stack */
export function buildBackupDir(stackName: string, service: string): string {
  return `${DOCKFLOW_BACKUPS_DIR}/${stackName}/${service}`;
}

const byTimestampDesc = (a: { timestamp: string }, b: { timestamp: string }): number =>
  a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;

/**
 * Select which backups to delete given a retention count.
 * Sorts newest-first defensively, keeps the first `retentionCount`.
 */
export function selectBackupsToPrune<T extends { timestamp: string }>(entries: T[], retentionCount: number): T[] {
  const sorted = [...entries].sort(byTimestampDesc);
  if (sorted.length <= retentionCount) return [];
  return sorted.slice(retentionCount);
}

/**
 * Resolve a backup entry by exact ID, ID prefix, or the newest one (undefined or `latest`).
 * Entries are expected newest-first.
 */
export function findBackupMatch<T extends { id: string }>(entries: T[], idOrLatest?: string): T | null {
  if (entries.length === 0) return null;
  if (!idOrLatest || idOrLatest === 'latest') return entries[0];
  return entries.find((e) => e.id === idOrLatest) ?? entries.find((e) => e.id.startsWith(idOrLatest)) ?? null;
}
