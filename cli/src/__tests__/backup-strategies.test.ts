import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as strategies from '../services/backup-strategies';
import {
  backupEpochMs,
  backupOrder,
  backupScopeName,
  buildBackupDir,
  buildCapturePipeline,
  buildDataFilePath,
  buildDiscardScript,
  buildDumpScript,
  buildExtractScript,
  buildRestoreScript,
  buildSwapScript,
  buildVerifyScript,
  credentialPrelude,
  DB_TYPES,
  type DatabaseType,
  DUMP_TRAILER,
  findBackupMatch,
  integrityOf,
  isExcluded,
  newestBackupFirst,
  parseContainerMounts,
  parseRestoreRefusal,
  previousDirName,
  RESTORE_REFUSAL_MARKER,
  restoreDirName,
  sanitizePathName,
  selectBackupsToPrune,
  stripRefusalMarker,
} from '../services/backup-strategies';
import type { BackupAccessoryConfig } from '../utils/config';
import { ConfigError } from '../utils/errors';

// ---------------------------------------------------------------------------
// Golden in-container scripts (design-06 4.2), written out independently of the module
// ---------------------------------------------------------------------------

const PG_PRELUDE = 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; ';
const MYSQL_PRELUDE =
  'if [ -n "${MYSQL_USER:-}" ] && [ -n "${MYSQL_PASSWORD:-}" ]; then DF_USER="$MYSQL_USER"; export MYSQL_PWD="$MYSQL_PASSWORD"; else DF_USER=root; export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}"; fi; ';
const MONGO_ARGS =
  'set -- --archive; if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then set -- "$@" --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin; fi; if [ -n "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then set -- "$@" --password="$MONGO_INITDB_ROOT_PASSWORD"; fi; if [ -n "${MONGO_INITDB_DATABASE:-}" ]; then set -- "$@" --db="$MONGO_INITDB_DATABASE"; fi; ';
const TRAILER = " && printf '%s\\n' '-- DOCKFLOW_DUMP_END'";
const REDIS_DUMP =
  'BEFORE=$(redis-cli LASTSAVE) && OUT=$(redis-cli BGSAVE) && echo "$OUT" | grep -qE "Background saving (started|scheduled)|already in progress" || { echo "BGSAVE failed: $OUT" >&2; exit 1; } && for i in $(seq 1 30); do AFTER=$(redis-cli LASTSAVE); [ "$AFTER" != "$BEFORE" ] && break; sleep 1; done && cat /data/dump.rdb';
const REDIS_RESTORE =
  'if [ "$(redis-cli CONFIG GET appendonly 2>/dev/null | tail -n 1)" = "yes" ]; then echo "DOCKFLOW_REFUSED: redis-appendonly" >&2; cat > /dev/null; exit 3; fi; ' +
  'cat > /data/dump.rdb.tmp; if ! [ -s /data/dump.rdb.tmp ]; then rm -f /data/dump.rdb.tmp; echo "restore: received an empty backup stream" >&2; exit 1; fi; mv /data/dump.rdb.tmp /data/dump.rdb && redis-cli SHUTDOWN NOSAVE || true';

const cfg = (config: BackupAccessoryConfig): BackupAccessoryConfig => config;

describe('buildDumpScript', () => {
  it('postgres: credentials and database from the container environment, database defaulting to the user', () => {
    expect(buildDumpScript(cfg({ type: 'postgres' }), 'gzip')).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
  });

  it('postgres: dump_options inserted verbatim before the database', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_options: '--no-owner --clean' }), 'gzip')).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists --no-owner --clean "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
  });

  it('postgres, compression none: no exec, and the trailer written only after pg_dump succeeded', () => {
    expect(buildDumpScript(cfg({ type: 'postgres' }), 'none')).toBe(
      `export PGPASSWORD="\${POSTGRES_PASSWORD:-}"; pg_dump -U "\${POSTGRES_USER:-postgres}" --clean --if-exists "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"${TRAILER}`,
    );
  });

  it('postgres, compression none with a custom format: no trailer (it would corrupt the archive)', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_options: '-Fc' }), 'none')).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists -Fc "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
  });

  it('mysql: user and password paired from the environment, every database when none is named', () => {
    expect(buildDumpScript(cfg({ type: 'mysql' }), 'gzip')).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; exec mysqldump -u"$DF_USER" "$@"`,
    );
    expect(buildDumpScript(cfg({ type: 'mysql', dump_options: '--single-transaction' }), 'gzip')).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; exec mysqldump -u"$DF_USER" --single-transaction "$@"`,
    );
  });

  it('mysql, compression none: trailer', () => {
    expect(buildDumpScript(cfg({ type: 'mysql' }), 'none')).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; mysqldump -u"$DF_USER" "$@"${TRAILER}`,
    );
  });

  it('mongodb: arguments built in the container, options after them, never a trailer', () => {
    expect(buildDumpScript(cfg({ type: 'mongodb' }), 'gzip')).toBe(`${MONGO_ARGS}exec mongodump "$@"`);
    expect(buildDumpScript(cfg({ type: 'mongodb', dump_options: '--oplog' }), 'none')).toBe(`${MONGO_ARGS}exec mongodump "$@" --oplog`);
  });

  it('redis: today BGSAVE/LASTSAVE script, options ignored', () => {
    expect(buildDumpScript(cfg({ type: 'redis' }), 'gzip')).toBe(REDIS_DUMP);
    expect(buildDumpScript(cfg({ type: 'redis', dump_options: '--x' }), 'none')).toBe(REDIS_DUMP);
  });

  it('raw: dump_command verbatim; a missing command is a ConfigError', () => {
    expect(buildDumpScript(cfg({ type: 'raw', dump_command: 'cat /srv/data.bin', restore_command: 'x' }), 'none')).toBe('cat /srv/data.bin');
    expect(() => buildDumpScript(cfg({ type: 'raw' }), 'gzip')).toThrow(ConfigError);
  });

  it('custom dump_command: the credential prelude is prepended for postgres and mysql only', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_command: 'pg_dumpall -U app' }), 'gzip')).toBe(`${PG_PRELUDE}pg_dumpall -U app`);
    expect(buildDumpScript(cfg({ type: 'mysql', dump_command: 'mysqldump -u"$DF_USER" shop' }), 'gzip')).toBe(
      `${MYSQL_PRELUDE}mysqldump -u"$DF_USER" shop`,
    );
    expect(buildDumpScript(cfg({ type: 'mongodb', dump_command: 'mongodump --archive' }), 'gzip')).toBe('mongodump --archive');
    expect(buildDumpScript(cfg({ type: 'redis', dump_command: 'cat /data/dump.rdb' }), 'gzip')).toBe('cat /data/dump.rdb');
  });

  it('custom dump_command never gets a trailer, even for postgres without compression', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_command: 'pg_dump -U app shop' }), 'none')).toBe(`${PG_PRELUDE}pg_dump -U app shop`);
  });

  it('volume has no dump script', () => {
    expect(() => buildDumpScript(cfg({ type: 'volume' }), 'gzip')).toThrow(ConfigError);
  });
});

describe('buildRestoreScript', () => {
  it('postgres', () => {
    expect(buildRestoreScript(cfg({ type: 'postgres' }))).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec psql -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
    expect(buildRestoreScript(cfg({ type: 'postgres', restore_options: '-v ON_ERROR_STOP=1' }))).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec psql -U "${POSTGRES_USER:-postgres}" -v ON_ERROR_STOP=1 "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
  });

  it('mysql: no positional argument without a database', () => {
    expect(buildRestoreScript(cfg({ type: 'mysql' }))).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set --; fi; exec mysql -u"$DF_USER" "$@"`,
    );
    expect(buildRestoreScript(cfg({ type: 'mysql', restore_options: '--force' }))).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set --; fi; exec mysql -u"$DF_USER" --force "$@"`,
    );
  });

  it('mongodb', () => {
    expect(buildRestoreScript(cfg({ type: 'mongodb' }))).toBe(`${MONGO_ARGS}exec mongorestore "$@" --drop`);
    expect(buildRestoreScript(cfg({ type: 'mongodb', restore_options: '--gzip' }))).toBe(`${MONGO_ARGS}exec mongorestore "$@" --drop --gzip`);
  });

  it('redis: appendonly refusal first, then the staged RDB', () => {
    expect(buildRestoreScript(cfg({ type: 'redis' }))).toBe(REDIS_RESTORE);
  });

  it('raw and custom commands', () => {
    expect(buildRestoreScript(cfg({ type: 'raw', dump_command: 'x', restore_command: 'cat > /srv/data.bin' }))).toBe('cat > /srv/data.bin');
    expect(() => buildRestoreScript(cfg({ type: 'raw', dump_command: 'x' }))).toThrow(ConfigError);
    expect(buildRestoreScript(cfg({ type: 'postgres', restore_command: 'psql -U app shop' }))).toBe(`${PG_PRELUDE}psql -U app shop`);
    expect(buildRestoreScript(cfg({ type: 'mysql', restore_command: 'mysql shop' }))).toBe(`${MYSQL_PRELUDE}mysql shop`);
    expect(buildRestoreScript(cfg({ type: 'mongodb', restore_command: 'mongorestore --archive' }))).toBe('mongorestore --archive');
    expect(buildRestoreScript(cfg({ type: 'redis', restore_command: 'cat > /data/dump.rdb' }))).toBe('cat > /data/dump.rdb');
  });
});

describe('credentialPrelude', () => {
  it('postgres and mysql export the password variable, mongodb and redis need nothing', () => {
    expect(credentialPrelude('postgres')).toBe(PG_PRELUDE);
    expect(credentialPrelude('mysql')).toBe(MYSQL_PRELUDE);
    expect(credentialPrelude('mongodb')).toBe('');
    expect(credentialPrelude('redis')).toBe('');
  });
});

describe('no credential values', () => {
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  it('script builders take only the backup configuration (type-level)', () => {
    const dump: Same<Parameters<typeof buildDumpScript>, [BackupAccessoryConfig, 'gzip' | 'none']> = true;
    const restore: Same<Parameters<typeof buildRestoreScript>, [BackupAccessoryConfig]> = true;
    const prelude: Same<Parameters<typeof credentialPrelude>, [DatabaseType]> = true;
    const integrity: Same<Parameters<typeof integrityOf>, [BackupAccessoryConfig, 'gzip' | 'none']> = true;
    expect([dump, restore, prelude, integrity]).toEqual([true, true, true, true]);
  });

  it('the module no longer reads container environments or builds -e flags', () => {
    const exported = Object.keys(strategies);
    for (const removed of ['DB_STRATEGIES', 'parseContainerEnv', 'buildExecEnvFlags', 'buildArchiveCheckCommand']) {
      expect(exported).not.toContain(removed);
    }
  });
});

describe('DB_TYPES', () => {
  it('extensions and the restart after a redis restore', () => {
    expect(DB_TYPES).toEqual({
      postgres: { fileExtension: 'sql', requiresServiceRestart: false },
      mysql: { fileExtension: 'sql', requiresServiceRestart: false },
      mongodb: { fileExtension: 'archive', requiresServiceRestart: false },
      redis: { fileExtension: 'rdb', requiresServiceRestart: true },
      raw: { fileExtension: 'bin', requiresServiceRestart: false },
    });
  });
});

// ---------------------------------------------------------------------------
// Refusal marker, scope
// ---------------------------------------------------------------------------

describe('parseRestoreRefusal', () => {
  it('recognises the redis appendonly marker line', () => {
    expect(RESTORE_REFUSAL_MARKER).toBe('DOCKFLOW_REFUSED: ');
    expect(parseRestoreRefusal('DOCKFLOW_REFUSED: redis-appendonly\n')).toBe('redis-appendonly');
    expect(parseRestoreRefusal('warning: x\r\nDOCKFLOW_REFUSED: redis-appendonly\r\n')).toBe('redis-appendonly');
    expect(parseRestoreRefusal('  DOCKFLOW_REFUSED: redis-appendonly  ')).toBe('redis-appendonly');
  });

  it('ignores other text and unknown ids', () => {
    expect(parseRestoreRefusal('')).toBeNull();
    expect(parseRestoreRefusal('ERROR: relation "x" does not exist')).toBeNull();
    expect(parseRestoreRefusal('DOCKFLOW_REFUSED: something-else')).toBeNull();
    expect(parseRestoreRefusal('echo DOCKFLOW_REFUSED: redis-appendonly')).toBeNull();
  });

  it('stripRefusalMarker removes the marker lines only', () => {
    expect(stripRefusalMarker('DOCKFLOW_REFUSED: redis-appendonly\nreal error\n')).toBe('real error\n');
    expect(stripRefusalMarker('plain')).toBe('plain');
  });
});

describe('backupScopeName', () => {
  it('app keeps the stack name, accessories get the -accessories suffix', () => {
    expect(backupScopeName({ project: 'shop', env: 'production', role: 'app' }, 'shop-production')).toBe('shop-production');
    expect(backupScopeName({ project: 'shop', env: 'production', role: 'accessory' }, 'shop-production')).toBe(
      'shop-production-accessories',
    );
  });
});

// ---------------------------------------------------------------------------
// Integrity (K23)
// ---------------------------------------------------------------------------

describe('integrityOf', () => {
  const rows: [BackupAccessoryConfig, 'gzip' | 'none', strategies.ArchiveIntegrity][] = [
    [{ type: 'volume' }, 'gzip', 'tar'],
    [{ type: 'volume' }, 'none', 'tar'],
    [{ type: 'postgres' }, 'gzip', 'gzip'],
    [{ type: 'mysql' }, 'gzip', 'gzip'],
    [{ type: 'postgres' }, 'none', 'trailer'],
    [{ type: 'mysql' }, 'none', 'trailer'],
    [{ type: 'postgres', dump_options: '-Fc' }, 'none', 'opaque'],
    [{ type: 'postgres', dump_options: '--format=custom' }, 'none', 'opaque'],
    [{ type: 'postgres', dump_options: '--format directory -j 4' }, 'none', 'opaque'],
    [{ type: 'postgres', dump_options: '-F t' }, 'none', 'opaque'],
    [{ type: 'postgres', dump_options: '-xFc' }, 'none', 'opaque'],
    [{ type: 'postgres', dump_options: '--form=c' }, 'none', 'opaque'],
    [{ type: 'postgres', dump_options: '-Fp' }, 'none', 'trailer'],
    [{ type: 'postgres', dump_options: '--format=plain --no-owner' }, 'none', 'trailer'],
    [{ type: 'postgres', dump_options: '-Fc -Fp' }, 'none', 'trailer'],
    [{ type: 'postgres', dump_options: '-n Fc' }, 'none', 'trailer'],
    [{ type: 'postgres', dump_options: '--no-owner' }, 'none', 'trailer'],
    [{ type: 'postgres', dump_options: '-Fc' }, 'gzip', 'gzip'],
    [{ type: 'postgres', dump_command: 'pg_dump -U app shop' }, 'none', 'opaque'],
    [{ type: 'mysql', dump_command: 'mysqldump shop' }, 'none', 'opaque'],
    [{ type: 'redis' }, 'none', 'opaque'],
    [{ type: 'mongodb' }, 'none', 'opaque'],
    [{ type: 'raw', dump_command: 'x', restore_command: 'y' }, 'none', 'opaque'],
    [{ type: 'redis' }, 'gzip', 'gzip'],
    [{ type: 'mongodb' }, 'gzip', 'gzip'],
    [{ type: 'raw', dump_command: 'x', restore_command: 'y' }, 'gzip', 'gzip'],
  ];

  for (const [config, compression, expected] of rows) {
    it(`${config.type} ${config.dump_options ?? config.dump_command ?? ''} ${compression} -> ${expected}`, () => {
      expect(integrityOf(config, compression)).toBe(expected);
    });
  }

  it('the dump script ends with the trailer exactly when the result is trailer', () => {
    for (const [config, compression, expected] of rows) {
      if (config.type === 'volume') continue;
      const script = buildDumpScript(config, compression);
      expect(script.endsWith(`&& printf '%s\\n' '${DUMP_TRAILER}'`)).toBe(expected === 'trailer');
    }
  });
});

describe('buildVerifyScript', () => {
  const head = ["f='/b/x'", `[ -s "$f" ] || { echo 'the file is missing or empty'; exit 1; }`];
  const tarChecks = (listing: string): string[] => [
    `t=$(mktemp) || { echo 'cannot create a temporary file'; exit 1; }`,
    listing,
    'z=$(cat "$t.z" 2>/dev/null); r=$(cat "$t" 2>/dev/null); rm -f "$t" "$t.z"',
    `[ "\${r:-255}" -eq 0 ] || { echo "tar cannot read the archive (exit \${r:-255})"; exit 1; }`,
    `[ "\${z:-0}" -eq 0 ] || { echo 'the gzip stream is corrupt or truncated'; exit 1; }`,
    `[ "$n" -ge 1 ] || { echo 'the archive has no entries'; exit 1; }`,
  ];

  it('tar, gzip: full listing, gunzip and tar exit statuses, entry count', () => {
    expect(buildVerifyScript('/b/x', 'gzip', 'tar')).toBe(
      [...head, ...tarChecks('n=$({ { gunzip -c "$f"; echo "$?" > "$t.z"; } | tar tf -; echo "$?" > "$t"; } | wc -l)'), 'echo OK'].join('\n'),
    );
  });

  it('tar, none: plus the end-of-archive blocks', () => {
    expect(buildVerifyScript('/b/x', 'none', 'tar')).toBe(
      [
        ...head,
        ...tarChecks('n=$({ tar tf - < "$f"; echo "$?" > "$t"; } | wc -l)'),
        `[ "$(tail -c 1024 "$f" | tr -d '\\000' | wc -c)" -eq 0 ] || { echo 'the archive has no end-of-archive marker (truncated)'; exit 1; }`,
        'echo OK',
      ].join('\n'),
    );
  });

  it('gzip: CRC over the whole file and at least one byte of payload', () => {
    expect(buildVerifyScript('/b/x', 'gzip', 'gzip')).toBe(
      [
        ...head,
        `gunzip -t "$f" || { echo 'the gzip stream is corrupt or truncated'; exit 1; }`,
        `[ "$(gunzip -c "$f" 2>/dev/null | head -c 1 | wc -c)" -eq 1 ] || { echo 'the backup is empty'; exit 1; }`,
        'echo OK',
      ].join('\n'),
    );
  });

  it('trailer: the last line is the marker', () => {
    expect(buildVerifyScript('/b/x', 'none', 'trailer')).toBe(
      [...head, `[ "$(tail -n 1 "$f")" = '-- DOCKFLOW_DUMP_END' ] || { echo 'the dump has no integrity marker'; exit 1; }`, 'echo OK'].join(
        '\n',
      ),
    );
  });

  it('opaque: existence and non-empty only', () => {
    expect(buildVerifyScript('/b/x', 'none', 'opaque')).toBe([...head, 'echo OK'].join('\n'));
  });

  it('the path is shell-quoted', () => {
    expect(buildVerifyScript("/b/it's.gz", 'gzip', 'gzip').split('\n')[0]).toBe("f='/b/it'\\''s.gz'");
  });
});

// ---------------------------------------------------------------------------
// Host pipeline and volume restore scripts
// ---------------------------------------------------------------------------

describe('buildCapturePipeline', () => {
  it('gzip: exit status of the producer captured without pipefail', () => {
    expect(buildCapturePipeline("docker exec 'c1' sh -c 'x'", '/var/lib/dockflow/backups/s/db/1.sql.gz', true)).toBe(
      "umask 077 && mkdir -p '/var/lib/dockflow/backups/s/db' && { docker exec 'c1' sh -c 'x'; echo \"$?\" > '/var/lib/dockflow/backups/s/db/1.sql.gz.rc'; } | gzip -c > '/var/lib/dockflow/backups/s/db/1.sql.gz'; " +
        "rc=$(cat '/var/lib/dockflow/backups/s/db/1.sql.gz.rc' 2>/dev/null); rm -f '/var/lib/dockflow/backups/s/db/1.sql.gz.rc'; exit \"${rc:-255}\"",
    );
  });

  it('none: plain redirection', () => {
    expect(buildCapturePipeline("docker exec 'c1' sh -c 'x'", '/var/lib/dockflow/backups/s/db/1.sql', false)).toBe(
      "umask 077 && mkdir -p '/var/lib/dockflow/backups/s/db' && docker exec 'c1' sh -c 'x' > '/var/lib/dockflow/backups/s/db/1.sql'",
    );
  });
});

describe('volume restore scripts', () => {
  it('extract beside the data', () => {
    expect(buildExtractScript('/dockflow/v0', 'ab12cd34')).toBe(
      ["set -e; d='/dockflow/v0'; new=\"$d/.dockflow-restore-ab12cd34\"", 'rm -rf "$new"; mkdir "$new"', 'tar xf - -C "$new"'].join('\n'),
    );
  });

  it('swap moves the old contents aside, then the new ones in', () => {
    expect(buildSwapScript('/dockflow/v0', 'ab12cd34')).toBe(
      [
        "set -e; d='/dockflow/v0'; new=\"$d/.dockflow-restore-ab12cd34\"; old=\"$d/.dockflow-old-ab12cd34\"",
        'rm -rf "$old"; mkdir "$old"',
        'for e in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; case "$e" in "$new"|"$old") continue;; esac; mv "$e" "$old/"; done',
        'for e in "$new"/* "$new"/.[!.]* "$new"/..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; mv "$e" "$d/"; done',
        'rmdir "$new"; rm -rf "$old"',
      ].join('\n'),
    );
  });

  it('discard removes the extraction directory only', () => {
    expect(buildDiscardScript('/dockflow/v0', 'ab12cd34')).toBe("d='/dockflow/v0'; rm -rf \"$d/.dockflow-restore-ab12cd34\"");
  });

  it('never wipes the mount root', () => {
    for (const script of [buildExtractScript('/dockflow/v0', 'ab12cd34'), buildSwapScript('/dockflow/v0', 'ab12cd34')]) {
      expect(script).not.toContain('find');
      expect(script).not.toMatch(/rm -rf "\$d"\/?\*|rm -rf "\$d"(\s|$)|-delete/);
    }
  });

  it('directory names; an id that is not lowercase hex-like is refused', () => {
    expect(restoreDirName('ab12cd34')).toBe('.dockflow-restore-ab12cd34');
    expect(previousDirName('ab12cd34')).toBe('.dockflow-old-ab12cd34');
    expect(() => buildExtractScript('/dockflow/v0', '../x')).toThrow();
    expect(() => restoreDirName('$(id)')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mounts, paths, selection (today's cases kept)
// ---------------------------------------------------------------------------

describe('parseContainerMounts', () => {
  const mounts = JSON.stringify([
    { Type: 'volume', Name: 'demo_data', Source: '/var/lib/docker/volumes/demo_data/_data', Destination: '/var/lib/postgresql/data' },
    { Type: 'bind', Source: '/host/config', Destination: '/etc/config', RW: true },
    { Type: 'bind', Source: '/host/readonly', Destination: '/etc/ro', RW: false },
  ]);

  it('volume names are shortened by stripping the stack prefix', () => {
    const infos = parseContainerMounts(mounts, 'demo');
    const vol = infos.find((i) => i.mountType === 'volume');
    expect(vol?.name).toBe('data');
    expect(vol?.source).toBe('demo_data');
  });

  it('read-only bind mounts are skipped, read-write kept with sanitized names', () => {
    const binds = parseContainerMounts(mounts, 'demo').filter((i) => i.mountType === 'bind');
    expect(binds).toHaveLength(1);
    expect(binds[0].name).toBe('etc-config');
    expect(binds[0].source).toBe('/host/config');
  });

  it('includeBindMounts=false keeps only volumes', () => {
    expect(parseContainerMounts(mounts, 'demo', undefined, false).every((i) => i.mountType === 'volume')).toBe(true);
  });

  it('exclude patterns support * globs and match name, source or destination', () => {
    expect(parseContainerMounts(mounts, 'demo', ['data']).find((i) => i.name === 'data')).toBeUndefined();
    expect(parseContainerMounts(mounts, 'demo', ['/etc/*']).find((i) => i.mountType === 'bind')).toBeUndefined();
    expect(parseContainerMounts(mounts, 'demo', ['nomatch'])).toHaveLength(2);
  });

  it('empty output -> empty list, malformed JSON throws', () => {
    expect(parseContainerMounts('', 'demo')).toEqual([]);
    expect(() => parseContainerMounts('{broken', 'demo')).toThrow();
  });
});

describe('isExcluded', () => {
  it('globs match any candidate; regex characters are literal', () => {
    expect(isExcluded(['cache*'], ['cache-tmp', '/x'])).toBe(true);
    expect(isExcluded(['*.log'], ['applog'])).toBe(false);
    expect(isExcluded(['a.b'], ['axb'])).toBe(false);
    expect(isExcluded([], ['anything'])).toBe(false);
  });
});

describe('sanitizePathName', () => {
  it('strips leading slashes and converts separators', () => {
    expect(sanitizePathName('/var/lib/data')).toBe('var-lib-data');
  });

  it('root path falls back to "root"', () => {
    expect(sanitizePathName('/')).toBe('root');
  });
});

describe('buildDataFilePath', () => {
  it('uses the type file extension', () => {
    expect(buildDataFilePath('/b', 'id1', 'postgres', 'none')).toBe('/b/id1.sql');
    expect(buildDataFilePath('/b', 'id1', 'redis', 'none')).toBe('/b/id1.rdb');
    expect(buildDataFilePath('/b', 'id1', 'mongodb', 'none')).toBe('/b/id1.archive');
  });

  it('gzip adds .gz suffix', () => {
    expect(buildDataFilePath('/b', 'id1', 'postgres', 'gzip')).toBe('/b/id1.sql.gz');
  });

  it('volume backups are tar files with the volume name', () => {
    expect(buildDataFilePath('/b', 'id1', 'volume', 'gzip', 'data')).toBe('/b/id1.data.tar.gz');
  });

  it('raw backups use .bin', () => {
    expect(buildDataFilePath('/b', 'id1', 'raw', 'none')).toBe('/b/id1.bin');
  });
});

describe('buildBackupDir', () => {
  it('nests stack then service under the backups dir', () => {
    expect(buildBackupDir('demo', 'db')).toBe('/var/lib/dockflow/backups/demo/db');
  });
});

describe('selectBackupsToPrune', () => {
  const entries = [
    { id: 'c', timestamp: '2026-03-01T00:00:00Z' },
    { id: 'a', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'b', timestamp: '2026-02-01T00:00:00Z' },
  ];

  it('keeps the N most recent, returns the rest oldest-last', () => {
    expect(selectBackupsToPrune(entries, 1).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('sorts defensively even if input is unsorted', () => {
    expect(selectBackupsToPrune(entries, 2).map((e) => e.id)).toEqual(['a']);
  });

  it('nothing to prune when count within retention', () => {
    expect(selectBackupsToPrune(entries, 3)).toEqual([]);
    expect(selectBackupsToPrune([], 1)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...entries];
    selectBackupsToPrune(entries, 1);
    expect(entries).toEqual(copy);
  });
});

describe('backup order', () => {
  const t = (iso: string): number => Date.parse(iso);

  it('epochMs orders a backup; metadata written before it is ordered by its timestamp', () => {
    expect(backupOrder({ timestamp: '2026-01-01T00:00:00.000Z', epochMs: 5 })).toBe(5);
    expect(backupOrder({ timestamp: '2026-01-01T00:00:00.000Z' })).toBe(t('2026-01-01T00:00:00.000Z'));
    const mixed = [
      { id: 'legacy', timestamp: '2026-02-01T00:00:00.000Z' },
      { id: 'late', timestamp: '2026-01-15T00:00:00.000Z', epochMs: t('2026-03-01T00:00:00.000Z') },
      { id: 'first', timestamp: '2026-01-01T00:00:00.000Z', epochMs: t('2026-01-01T00:00:00.000Z') },
    ];
    expect([...mixed].sort(newestBackupFirst).map((e) => e.id)).toEqual(['late', 'legacy', 'first']);
    expect(selectBackupsToPrune(mixed, 2).map((e) => e.id)).toEqual(['first']);
  });

  it('a new backup comes after every stored one, even one taken by a machine whose clock was ahead', () => {
    const now = new Date('2026-05-01T10:00:00.000Z');
    expect(backupEpochMs(now, [])).toBe(now.getTime());
    expect(backupEpochMs(now, [{ timestamp: '2026-04-01T00:00:00.000Z' }])).toBe(now.getTime());
    expect(backupEpochMs(now, [{ timestamp: '2026-04-01T00:00:00.000Z' }, { timestamp: '2026-05-01T11:00:00.000Z' }])).toBe(t('2026-05-01T11:00:00.000Z') + 1);
    expect(backupEpochMs(now, [{ timestamp: '2026-04-01T00:00:00.000Z', epochMs: now.getTime() + 60_000 }])).toBe(now.getTime() + 60_001);
  });
});

describe('findBackupMatch', () => {
  const entries = [{ id: '20260301-120000-ff00' }, { id: '20260201-120000-aa11' }];

  it('no id or latest -> newest (first entry)', () => {
    expect(findBackupMatch(entries)?.id).toBe('20260301-120000-ff00');
    expect(findBackupMatch(entries, 'latest')?.id).toBe('20260301-120000-ff00');
  });

  it('exact id match', () => {
    expect(findBackupMatch(entries, '20260201-120000-aa11')?.id).toBe('20260201-120000-aa11');
  });

  it('prefix match', () => {
    expect(findBackupMatch(entries, '202602')?.id).toBe('20260201-120000-aa11');
  });

  it('no match or empty list -> null', () => {
    expect(findBackupMatch(entries, 'zzz')).toBeNull();
    expect(findBackupMatch([], 'a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Execution against a real POSIX sh, tar and gzip (Linux, macOS, and Windows with Git's sh)
// ---------------------------------------------------------------------------

const SH = Bun.which('sh');
const work = mkdtempSync(join(tmpdir(), 'dockflow-backup-strategies-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** the path as the POSIX shell sees it (Git's sh on Windows wants /c/...) */
function shPath(path: string): string {
  return process.platform === 'win32' ? `/${path[0].toLowerCase()}${path.slice(2).replace(/\\/g, '/')}` : path;
}

interface ShResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runSh(
  script: string,
  options: { env?: Record<string, string>; stdin?: Uint8Array | string; binDir?: string; cwd?: string; tmpDir?: string } = {},
): ShResult {
  const systemPath = process.platform === 'win32' ? '/usr/bin:/bin' : (process.env.PATH ?? '/usr/bin:/bin');
  const path = options.binDir ? `${shPath(options.binDir)}:${systemPath}` : systemPath;
  const tmpDir = options.tmpDir ?? join(work, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const stdin = typeof options.stdin === 'string' ? new TextEncoder().encode(options.stdin) : options.stdin;
  const proc = Bun.spawnSync([SH ?? 'sh', '-c', script], {
    cwd: options.cwd ?? work,
    env: { PATH: path, TMPDIR: shPath(tmpDir), ...options.env },
    stdin: stdin ?? 'ignore',
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function freshDir(name: string): string {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** shims that print how they were called: name, one line per argument, the password variables */
function shimDir(): string {
  const dir = freshDir('bin');
  const shim = [
    '#!/bin/sh',
    `printf 'cmd=%s\\n' "\${0##*/}"`,
    `for a in "$@"; do printf 'arg=%s\\n' "$a"; done`,
    `printf 'PGPASSWORD=%s\\n' "\${PGPASSWORD-<unset>}"`,
    `printf 'MYSQL_PWD=%s\\n' "\${MYSQL_PWD-<unset>}"`,
    '',
  ].join('\n');
  for (const name of ['pg_dump', 'psql', 'mysqldump', 'mysql', 'mongodump', 'mongorestore']) {
    writeFileSync(join(dir, name), shim);
    chmodSync(join(dir, name), 0o755);
  }
  const redis = [
    '#!/bin/sh',
    `if [ "$1 $2" = "CONFIG GET" ]; then printf 'appendonly\\n%s\\n' "$APPENDONLY"; exit 0; fi`,
    `printf '%s\\n' "$*" >> "$REDIS_LOG"`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'redis-cli'), redis);
  chmodSync(join(dir, 'redis-cli'), 0o755);
  return dir;
}

function call(stdout: string): { cmd: string; args: string[]; env: Record<string, string> } {
  const lines = stdout.split('\n').filter((line) => line !== '');
  const cmd = lines.find((line) => line.startsWith('cmd='))?.slice(4) ?? '';
  const args = lines.filter((line) => line.startsWith('arg=')).map((line) => line.slice(4));
  const env: Record<string, string> = {};
  for (const line of lines) {
    const match = /^(PGPASSWORD|MYSQL_PWD)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return { cmd, args, env };
}

describe.if(SH !== null)('in-container scripts, executed', () => {
  let bin = '';
  beforeAll(() => {
    bin = shimDir();
  });
  const run = (script: string, env: Record<string, string>) => {
    const result = runSh(script, { binDir: bin, env });
    expect(result.exitCode).toBe(0);
    return call(result.stdout);
  };

  it('postgres: the database falls back to POSTGRES_USER when POSTGRES_DB is unset', () => {
    const dump = buildDumpScript(cfg({ type: 'postgres' }), 'gzip');
    expect(run(dump, { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pg-secret' })).toEqual({
      cmd: 'pg_dump',
      args: ['-U', 'app', '--clean', '--if-exists', 'app'],
      env: { PGPASSWORD: 'pg-secret', MYSQL_PWD: '<unset>' },
    });
    expect(run(dump, { POSTGRES_USER: 'app', POSTGRES_DB: 'shop' }).args).toEqual(['-U', 'app', '--clean', '--if-exists', 'shop']);
    expect(run(dump, {})).toEqual({ cmd: 'pg_dump', args: ['-U', 'postgres', '--clean', '--if-exists', 'postgres'], env: { PGPASSWORD: '', MYSQL_PWD: '<unset>' } });
    expect(run(buildRestoreScript(cfg({ type: 'postgres' })), { POSTGRES_DB: 'shop' })).toMatchObject({ cmd: 'psql', args: ['-U', 'postgres', 'shop'] });
  });

  it('postgres, compression none: the trailer follows a successful dump only', () => {
    const script = buildDumpScript(cfg({ type: 'postgres' }), 'none');
    const ok = runSh(script, { binDir: bin, env: { POSTGRES_USER: 'app' } });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trimEnd().split('\n').at(-1)).toBe(DUMP_TRAILER);

    const failing = freshDir('bin-failing');
    writeFileSync(join(failing, 'pg_dump'), '#!/bin/sh\necho partial\nexit 1\n');
    chmodSync(join(failing, 'pg_dump'), 0o755);
    const failed = runSh(script, { binDir: failing });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).not.toContain(DUMP_TRAILER);
  });

  it('mysql: MYSQL_USER is used only with MYSQL_PASSWORD, otherwise root with the root password', () => {
    const dump = buildDumpScript(cfg({ type: 'mysql' }), 'gzip');
    expect(run(dump, { MYSQL_USER: 'app', MYSQL_PASSWORD: 'app-secret', MYSQL_ROOT_PASSWORD: 'root-secret' })).toEqual({
      cmd: 'mysqldump',
      args: ['-uapp', '--all-databases'],
      env: { PGPASSWORD: '<unset>', MYSQL_PWD: 'app-secret' },
    });
    expect(run(dump, { MYSQL_USER: 'app', MYSQL_ROOT_PASSWORD: 'root-secret' })).toMatchObject({
      args: ['-uroot', '--all-databases'],
      env: { MYSQL_PWD: 'root-secret' },
    });
    expect(run(dump, { MYSQL_DATABASE: 'shop' }).args).toEqual(['-uroot', 'shop']);

    const restore = buildRestoreScript(cfg({ type: 'mysql' }));
    expect(run(restore, {})).toMatchObject({ cmd: 'mysql', args: ['-uroot'] });
    expect(run(restore, { MYSQL_DATABASE: 'shop' }).args).toEqual(['-uroot', 'shop']);
  });

  it('mongodb: credentials and database when set; a password with $, space and quotes arrives intact', () => {
    const password = `p$ss w'rd"x`;
    expect(
      run(buildDumpScript(cfg({ type: 'mongodb' }), 'gzip'), {
        MONGO_INITDB_ROOT_USERNAME: 'root',
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_INITDB_DATABASE: 'shop',
      }),
    ).toMatchObject({
      cmd: 'mongodump',
      args: ['--archive', '--username=root', '--authenticationDatabase=admin', `--password=${password}`, '--db=shop'],
    });
    expect(run(buildRestoreScript(cfg({ type: 'mongodb' })), {})).toMatchObject({ cmd: 'mongorestore', args: ['--archive', '--drop'] });
  });

  it('redis restore with appendonly yes: exit 3, the marker on stderr, stdin drained', () => {
    const dir = freshDir('redis-refused');
    writeFileSync(join(dir, 'restore.sh'), buildRestoreScript(cfg({ type: 'redis' })).replaceAll('/data/', `${shPath(dir)}/`));
    const result = runSh('( sh ./restore.sh ); echo "rc=$?"; echo "rest=$(wc -c)"', {
      binDir: bin,
      cwd: dir,
      env: { APPENDONLY: 'yes', REDIS_LOG: shPath(join(dir, 'redis.log')) },
      stdin: 'x'.repeat(4096),
    });
    expect(result.stdout).toContain('rc=3');
    expect(result.stdout).toMatch(/rest=\s*0\b/);
    expect(parseRestoreRefusal(result.stderr)).toBe('redis-appendonly');
    expect(readdirSync(dir)).toEqual(['restore.sh']);
  });

  it('redis restore with appendonly no: the RDB is staged, installed, and Redis shut down without saving', () => {
    const dir = freshDir('redis-restored');
    const log = join(dir, 'redis.log');
    const script = buildRestoreScript(cfg({ type: 'redis' })).replaceAll('/data/', `${shPath(dir)}/`);
    const result = runSh(script, { binDir: bin, env: { APPENDONLY: 'no', REDIS_LOG: shPath(log) }, stdin: 'REDIS0011-payload' });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'dump.rdb'), 'utf8')).toBe('REDIS0011-payload');
    expect(readFileSync(log, 'utf8')).toBe('SHUTDOWN NOSAVE\n');

    const empty = runSh(script, { binDir: bin, env: { APPENDONLY: 'no', REDIS_LOG: shPath(log) }, stdin: '' });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('restore: received an empty backup stream');
  });
});

/** deterministic, poorly compressible bytes, so a truncation lands inside real data */
function noise(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = 32 + (state >>> 24) % 90;
  }
  return bytes;
}

describe.if(SH !== null)('buildVerifyScript, executed', () => {
  let dir = '';
  let tmp = '';
  beforeAll(() => {
    dir = freshDir('archives');
    tmp = freshDir('verify-tmp');
    const src = join(dir, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'a.bin'), noise(6000, 1));
    writeFileSync(join(src, 'sub', 'b.txt'), 'hello');
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(5000));
    writeFileSync(join(dir, 'garbage.tar'), noise(3000, 7));
    writeFileSync(join(dir, 'zero.tar'), '');
    const made = runSh(
      'tar cf good.tar -C src . && gzip -c good.tar > good.tar.gz && tar cf empty.tar -C empty . && gzip -c empty.tar > empty.tar.gz && tar cf one.tar big.bin',
      { cwd: dir },
    );
    if (made.exitCode !== 0) throw new Error(`could not build the test archives: ${made.stderr}`);
  });

  const verify = (name: string, compression: 'gzip' | 'none', integrity: strategies.ArchiveIntegrity): ShResult => {
    const result = runSh(buildVerifyScript(shPath(join(dir, name)), compression, integrity), { tmpDir: tmp });
    // one line on stdout, whatever the outcome, and no temporary file left behind
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(readdirSync(tmp)).toEqual([]);
    return result;
  };
  const truncated = (from: string, to: string, length: number): void => {
    writeFileSync(join(dir, to), readFileSync(join(dir, from)).subarray(0, length));
  };

  it('a sound tar and tar.gz pass', () => {
    expect(verify('good.tar', 'none', 'tar')).toMatchObject({ exitCode: 0, stdout: 'OK\n' });
    expect(verify('good.tar.gz', 'gzip', 'tar')).toMatchObject({ exitCode: 0, stdout: 'OK\n' });
  });

  it('an archive of an empty directory passes (one ./ entry)', () => {
    expect(verify('empty.tar', 'none', 'tar').exitCode).toBe(0);
    expect(verify('empty.tar.gz', 'gzip', 'tar').exitCode).toBe(0);
  });

  it('a tar.gz truncated anywhere fails', () => {
    const size = statSync(join(dir, 'good.tar.gz')).size;
    for (const length of [10, Math.floor(size / 3), Math.floor(size / 2), size - 8, size - 1]) {
      truncated('good.tar.gz', 'cut.tar.gz', length);
      const result = verify('cut.tar.gz', 'gzip', 'tar');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/^(tar cannot read the archive \(exit \d+\)|the gzip stream is corrupt or truncated)\n$/);
    }
  });

  it('an uncompressed tar truncated mid-entry fails on tar tf', () => {
    truncated('one.tar', 'mid.tar', 512 + 2000);
    expect(verify('mid.tar', 'none', 'tar')).toMatchObject({ exitCode: 1, stdout: expect.stringMatching(/^tar cannot read the archive/) });
  });

  it('an uncompressed tar cut exactly at an entry boundary fails on the end-of-archive check', () => {
    // header + 5000 bytes padded to 10 blocks: tar tf lists it cleanly
    truncated('one.tar', 'edge.tar', 512 + 5120);
    expect(verify('edge.tar', 'none', 'tar')).toEqual({
      exitCode: 1,
      stdout: 'the archive has no end-of-archive marker (truncated)\n',
      stderr: '',
    });
  });

  it('garbage bytes, an empty file and a missing file fail', () => {
    expect(verify('garbage.tar', 'none', 'tar').exitCode).toBe(1);
    writeFileSync(join(dir, 'garbage.tar.gz'), noise(3000, 9));
    expect(verify('garbage.tar.gz', 'gzip', 'tar').exitCode).toBe(1);
    expect(verify('zero.tar', 'none', 'tar').stdout).toBe('the file is missing or empty\n');
    expect(verify('missing.tar', 'none', 'tar').stdout).toBe('the file is missing or empty\n');
  });

  it('gzip dumps: sound passes, truncated fails, an empty payload fails', () => {
    writeFileSync(join(dir, 'dump.sql'), noise(4000, 3));
    writeFileSync(join(dir, 'nothing'), '');
    expect(runSh('gzip -c dump.sql > dump.sql.gz && gzip -c nothing > nothing.gz', { cwd: dir }).exitCode).toBe(0);
    expect(verify('dump.sql.gz', 'gzip', 'gzip')).toMatchObject({ exitCode: 0, stdout: 'OK\n' });
    truncated('dump.sql.gz', 'cut.sql.gz', statSync(join(dir, 'dump.sql.gz')).size - 4);
    expect(verify('cut.sql.gz', 'gzip', 'gzip').stdout).toBe('the gzip stream is corrupt or truncated\n');
    expect(verify('nothing.gz', 'gzip', 'gzip').stdout).toBe('the backup is empty\n');
  });

  it('a trailer dump passes with its last line and fails without it', () => {
    writeFileSync(join(dir, 'with.sql'), `CREATE TABLE t (id int);\n${DUMP_TRAILER}\n`);
    writeFileSync(join(dir, 'without.sql'), 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n');
    expect(verify('with.sql', 'none', 'trailer')).toMatchObject({ exitCode: 0, stdout: 'OK\n' });
    expect(verify('without.sql', 'none', 'trailer')).toMatchObject({ exitCode: 1, stdout: 'the dump has no integrity marker\n' });
  });

  it('opaque: only existence and size', () => {
    expect(verify('garbage.tar', 'none', 'opaque')).toMatchObject({ exitCode: 0, stdout: 'OK\n' });
    expect(verify('zero.tar', 'none', 'opaque').exitCode).toBe(1);
  });
});

describe.if(SH !== null)('capture pipeline and volume restore scripts, executed', () => {
  it('the gzip pipeline exits with the producer status and writes its output', () => {
    const dir = freshDir('capture');
    const file = join(dir, 'out', '1.sql.gz');
    const result = runSh(buildCapturePipeline("sh -c 'printf payload; exit 3'", shPath(file), true));
    expect(result.exitCode).toBe(3);
    expect(runSh(`gunzip -c '${shPath(file)}'`).stdout).toBe('payload');
    expect(readdirSync(join(dir, 'out'))).toEqual(['1.sql.gz']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const plain = join(dir, 'out', '2.sql');
    expect(runSh(buildCapturePipeline("sh -c 'printf plain; exit 0'", shPath(plain), false)).exitCode).toBe(0);
    expect(readFileSync(plain, 'utf8')).toBe('plain');
  });

  const listTree = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        out.push(`${prefix}${name}`);
        if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      }
    };
    walk(root, '');
    return out;
  };

  const setup = (): { volume: string; archive: Uint8Array } => {
    const volume = freshDir('volume');
    writeFileSync(join(volume, 'old.txt'), 'old');
    writeFileSync(join(volume, '.hidden-old'), 'h');
    writeFileSync(join(volume, '..odd'), 'o');
    mkdirSync(join(volume, 'sub'));
    writeFileSync(join(volume, 'sub', 'x'), 'x');
    const source = freshDir('volume-source');
    writeFileSync(join(source, 'new.txt'), 'new');
    writeFileSync(join(source, '.hidden-new'), 'n');
    mkdirSync(join(source, 'sub2'));
    writeFileSync(join(source, 'sub2', 'y'), 'y');
    const tar = Bun.spawnSync([SH ?? 'sh', '-c', `tar cf - -C '${shPath(source)}' .`], {
      env: { PATH: process.platform === 'win32' ? '/usr/bin:/bin' : (process.env.PATH ?? '') },
    });
    return { volume, archive: tar.stdout };
  };

  it('extract beside, then swap: the volume holds exactly the archive', () => {
    const { volume, archive } = setup();
    const extract = runSh(buildExtractScript(shPath(volume), 'ab12cd34'), { stdin: archive });
    expect(extract.exitCode).toBe(0);
    expect(listTree(volume)).toEqual([
      '..odd',
      '.dockflow-restore-ab12cd34',
      '.dockflow-restore-ab12cd34/.hidden-new',
      '.dockflow-restore-ab12cd34/new.txt',
      '.dockflow-restore-ab12cd34/sub2',
      '.dockflow-restore-ab12cd34/sub2/y',
      '.hidden-old',
      'old.txt',
      'sub',
      'sub/x',
    ]);

    expect(runSh(buildSwapScript(shPath(volume), 'ab12cd34')).exitCode).toBe(0);
    expect(listTree(volume)).toEqual(['.hidden-new', 'new.txt', 'sub2', 'sub2/y']);
    expect(readFileSync(join(volume, 'new.txt'), 'utf8')).toBe('new');
  });

  it('a failed extraction leaves the data untouched, and discard removes what it left', () => {
    const { volume } = setup();
    const extract = runSh(buildExtractScript(shPath(volume), 'ab12cd34'), { stdin: noise(2048, 5) });
    expect(extract.exitCode).not.toBe(0);
    expect(listTree(volume)).toContain('old.txt');
    expect(readFileSync(join(volume, 'sub', 'x'), 'utf8')).toBe('x');

    expect(runSh(buildDiscardScript(shPath(volume), 'ab12cd34')).exitCode).toBe(0);
    expect(listTree(volume)).toEqual(['..odd', '.hidden-old', 'old.txt', 'sub', 'sub/x']);
  });
});
