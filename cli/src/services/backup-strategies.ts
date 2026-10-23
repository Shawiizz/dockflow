/**
 * Backup strategies — pure logic behind backup/restore operations.
 *
 * In-container dump/restore scripts, the host-side capture pipeline, container mount parsing,
 * file path construction and prune selection. No SSH — everything here is unit-testable
 * (see __tests__/backup-strategies.test.ts).
 */

import { posix } from 'path';
import type { BackupAccessoryConfig, BackupDbType } from '../utils/config';
import { ConfigError, ValidationError } from '../utils/errors';
import { raw, sh, type ShellCommand } from '../utils/ssh';
import { DOCKFLOW_BACKUPS_DIR } from '../constants';

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

/**
 * The end-to-end check a backup can get on the node holding it:
 * `tar` lists the whole archive, `gzip` reads the whole stream (CRC) and needs one byte of payload,
 * `trailer` is a plain-text dump that ends with a marker line written only after the dump
 * succeeded, `opaque` has nothing to check beyond its existence and a non-zero size.
 */
export type ArchiveIntegrity = 'tar' | 'gzip' | 'trailer' | 'opaque';

export const ARCHIVE_INTEGRITIES: readonly ArchiveIntegrity[] = ['tar', 'gzip', 'trailer', 'opaque'];

export const DB_TYPES: Record<Exclude<BackupDbType, 'volume'>, { fileExtension: string; requiresServiceRestart: boolean }> = {
  postgres: { fileExtension: 'sql', requiresServiceRestart: false },
  mysql: { fileExtension: 'sql', requiresServiceRestart: false },
  mongodb: { fileExtension: 'archive', requiresServiceRestart: false },
  // the restore ends with SHUTDOWN NOSAVE so the staged dump.rdb is loaded on the next start
  redis: { fileExtension: 'rdb', requiresServiceRestart: true },
  raw: { fileExtension: 'bin', requiresServiceRestart: false },
};

/** Last line of a plain-text postgres/mysql dump taken with `compression: none`; an SQL comment on restore. */
export const DUMP_TRAILER = '-- DOCKFLOW_DUMP_END';

/** Written by the in-container restore script on stderr, read back by `backup/restore.ts`. */
export const RESTORE_REFUSAL_MARKER = 'DOCKFLOW_REFUSED: ';

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

// With appendonly Redis loads the AOF at startup and ignores a restored RDB. stdin is drained so
// the host side of the pipe never fails with a broken pipe instead of this refusal.
const REDIS_APPENDONLY_GUARD =
  'if [ "$(redis-cli CONFIG GET appendonly 2>/dev/null | tail -n 1)" = "yes" ]; then echo "DOCKFLOW_REFUSED: redis-appendonly" >&2; cat > /dev/null; exit 3; fi; ';

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

function isPlainPgDump(dumpOptions: string | undefined): boolean {
  const last = scanPgDumpOptions(dumpOptions).formats.at(-1);
  return last === undefined || last === 'p' || last === 'plain';
}

/** Which check a new backup of this configuration gets. */
export function integrityOf(config: BackupAccessoryConfig, compression: 'gzip' | 'none'): ArchiveIntegrity {
  if (config.type === 'volume') return 'tar';
  if (compression === 'gzip') return 'gzip';
  if (customCommand(config.dump_command) !== null) return 'opaque';
  if (config.type === 'mysql') return 'trailer';
  if (config.type === 'postgres' && isPlainPgDump(config.dump_options)) return 'trailer';
  return 'opaque';
}

/** The check of a backup whose metadata does not record one: all it ever got was its compression. */
export function recordedIntegrity(
  dbType: BackupDbType,
  compression: 'gzip' | 'none',
  recorded?: ArchiveIntegrity,
): ArchiveIntegrity {
  if (recorded !== undefined) return recorded;
  if (dbType === 'volume') return 'tar';
  return compression === 'gzip' ? 'gzip' : 'opaque';
}

/**
 * The dump script run by `sh -c` in the service container; stdout is the backup.
 *
 * It is the container's own program, passed to `docker exec` as one quoted value, and its text is
 * written here, `${...}` expansions included, for the container's shell to expand. The only
 * configured text in it is shell on purpose: `dump_options` (flags such as `--exclude-table='a b'`)
 * and `dump_command`, which the container's shell reads as the user wrote them.
 */
export function buildDumpScript(config: BackupAccessoryConfig, compression: 'gzip' | 'none'): string {
  const type = config.type;
  if (type === 'volume') throw new ConfigError('Backup type volume has no dump script');
  if (type === 'raw') return rawCommand(config, 'dump_command');
  const custom = customCommand(config.dump_command);
  if (custom !== null) return credentialPrelude(type) + custom;

  const opts = options(config.dump_options);
  // the trailer follows a dump that succeeded, so the dump cannot be exec'd
  const trailer = integrityOf(config, compression) === 'trailer';
  const exec = trailer ? '' : 'exec ';
  const end = trailer ? sh` && printf '%s\\n' ${DUMP_TRAILER}` : '';
  switch (type) {
    case 'postgres': {
      // --clean: a restore replaces what the dump holds instead of adding its rows to the live ones;
      // pg_dump refuses it together with --data-only, which has no objects to drop anyway
      const clean = scanPgDumpOptions(config.dump_options).dataOnly ? '' : ' --clean --if-exists';
      return `${PG_PRELUDE}${exec}pg_dump ${PG_USER}${clean}${opts} ${PG_DATABASE}${end}`;
    }
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

/** The restore script run by `sh -c` in the service container; the backup arrives on stdin. Same rules as the dump script for `restore_options` and `restore_command`. */
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

/**
 * Runs `producer` on a node and writes its stdout to `remotePath` (mode 0600, directory created),
 * exiting with the PRODUCER's status, or gzip's when the producer succeeded: without pipefail a gzip
 * pipeline reports gzip's alone, and a dump that dies midway becomes a CRC-valid truncated archive.
 */
export function buildCapturePipeline(producer: ShellCommand, remotePath: string, gzip: boolean): ShellCommand {
  const dir = posix.dirname(remotePath);
  // `producer` is a command the caller built with `sh`
  if (!gzip) return sh`umask 077 && mkdir -p ${dir} && ${raw(producer)} > ${remotePath}`;
  const rc = `${remotePath}.rc`;
  return sh`umask 077 && mkdir -p ${dir} && { ${raw(producer)}; echo "$?" > ${rc}; } | gzip -c > ${remotePath}; z=$?; rc=$(cat ${rc} 2>/dev/null); rm -f ${rc}; [ "\${rc:-255}" -eq 0 ] || exit "\${rc:-255}"; exit "$z"`;
}

/** Mount point of the volume inside the helper container of a volume restore */
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

/** Phase 1 of a volume restore: extract stdin beside the data; nothing of the current contents is touched. */
export function buildExtractScript(mountDir: string, id8: string): string {
  return [
    sh`set -e; d=${mountDir}; new="$d"/${restoreDirName(id8)}`,
    'rm -rf "$new"; mkdir "$new"',
    'tar xf - -C "$new"',
  ].join('\n');
}

/**
 * Phase 2, run only after every extraction succeeded: renames within one filesystem, no data
 * copied. The previous contents are kept in the old directory until the new ones are in place.
 */
export function buildSwapScript(mountDir: string, id8: string): string {
  return [
    sh`set -e; d=${mountDir}; new="$d"/${restoreDirName(id8)}; old="$d"/${previousDirName(id8)}`,
    'rm -rf "$old"; mkdir "$old"',
    'for e in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; case "$e" in "$new"|"$old") continue;; esac; mv "$e" "$old/"; done',
    'for e in "$new"/* "$new"/.[!.]* "$new"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; mv "$e" "$d/"; done',
    'rmdir "$new"; rm -rf "$old"',
  ].join('\n');
}

/** Removes what a failed extraction left beside the data. */
export function buildDiscardScript(mountDir: string, id8: string): string {
  return sh`d=${mountDir}; rm -rf "$d"/${restoreDirName(id8)}`;
}

export function sanitizePathName(mountPath: string): string {
  return mountPath.replace(/^\/+/, '').replace(/\//g, '-') || 'root';
}

/**
 * Checks an archive on the node holding it, before anything is destroyed. Prints `OK` and exits 0
 * when sound; otherwise prints one line naming the problem and exits 1. POSIX sh without
 * pipefail, so exit statuses inside pipelines are captured through a temporary file. `opaque`
 * runs only the existence and non-empty check.
 */
export function buildVerifyScript(remotePath: string, compression: 'gzip' | 'none', integrity: ArchiveIntegrity): ShellCommand {
  const lines = [sh`f=${remotePath}`, sh`[ -s "$f" ] || { echo 'the file is missing or empty'; exit 1; }`];
  switch (integrity) {
    case 'tar':
      lines.push(
        sh`t=$(mktemp) || { echo 'cannot create a temporary file'; exit 1; }`,
        compression === 'gzip'
          ? sh`n=$({ { gunzip -c "$f"; echo "$?" > "$t.z"; } | tar tf -; echo "$?" > "$t"; } | wc -l)`
          : sh`n=$({ tar tf - < "$f"; echo "$?" > "$t"; } | wc -l)`,
        sh`z=$(cat "$t.z" 2>/dev/null); r=$(cat "$t" 2>/dev/null); rm -f "$t" "$t.z"`,
        // tar first: a tar failure also kills gunzip with SIGPIPE
        sh`[ "\${r:-255}" -eq 0 ] || { echo "tar cannot read the archive (exit \${r:-255})"; exit 1; }`,
        sh`[ "\${z:-0}" -eq 0 ] || { echo 'the gzip stream is corrupt or truncated'; exit 1; }`,
        sh`[ "$n" -ge 1 ] || { echo 'the archive has no entries'; exit 1; }`,
      );
      // an uncompressed archive cut exactly at an entry boundary lists cleanly; the two zero
      // end-of-archive blocks GNU and busybox tar both write are what is missing then
      if (compression === 'none') {
        lines.push(
          sh`[ "$(tail -c 1024 "$f" | tr -d '\\000' | wc -c)" -eq 0 ] || { echo 'the archive has no end-of-archive marker (truncated)'; exit 1; }`,
        );
      }
      break;
    case 'gzip':
      lines.push(
        sh`gunzip -t "$f" || { echo 'the gzip stream is corrupt or truncated'; exit 1; }`,
        sh`[ "$(gunzip -c "$f" 2>/dev/null | head -c 1 | wc -c)" -eq 1 ] || { echo 'the backup is empty'; exit 1; }`,
      );
      break;
    case 'trailer':
      lines.push(sh`[ "$(tail -n 1 "$f")" = ${DUMP_TRAILER} ] || { echo 'the dump has no integrity marker'; exit 1; }`);
      break;
    case 'opaque':
      break;
  }
  lines.push(sh`echo OK`);
  return sh`${raw(lines.join('\n'))}`;
}

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

export function buildBackupDir(stackName: string, service: string): string {
  return `${DOCKFLOW_BACKUPS_DIR}/${stackName}/${service}`;
}

interface OrderedBackup {
  timestamp: string;
  epochMs?: number;
}

/** The order of a backup: its `epochMs`, or its timestamp in metadata written before `epochMs` existed. */
export function backupOrder(entry: OrderedBackup): number {
  return entry.epochMs ?? (Date.parse(entry.timestamp) || 0);
}

/** Newest first: listings, `latest` and retention. */
export function newestBackupFirst(a: OrderedBackup, b: OrderedBackup): number {
  return backupOrder(b) - backupOrder(a);
}

/**
 * The `epochMs` of a new backup: when it is taken, but after every stored backup of its service,
 * which a machine whose clock was ahead of this one may have taken.
 */
export function backupEpochMs(now: Date, stored: readonly OrderedBackup[]): number {
  return stored.reduce((epoch, entry) => Math.max(epoch, backupOrder(entry) + 1), now.getTime());
}

/** The `--keep` option: a whole number of backups, zero included; anything else would delete by accident. */
export function parseRetention(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ValidationError(`--keep must be a non-negative integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

/** The backups beyond the newest `retentionCount`; sorts first, so the order of `entries` does not matter. */
export function selectBackupsToPrune<T extends OrderedBackup>(entries: T[], retentionCount: number): T[] {
  const sorted = [...entries].sort(newestBackupFirst);
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
