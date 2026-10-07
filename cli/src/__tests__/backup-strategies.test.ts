import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasPosixShell } from './helpers/local-shell';
import {
  DB_TYPES,
  buildArchiveCheckCommand,
  buildBackupDir,
  buildCapturePipeline,
  buildDataFilePath,
  buildDumpScript,
  buildRestoreScript,
  credentialPrelude,
  findBackupMatch,
  parseContainerMounts,
  sanitizePathName,
  selectBackupsToPrune,
} from '../services/backup-strategies';
import type { BackupAccessoryConfig } from '../utils/config';
import { ConfigError } from '../utils/errors';

// ---------------------------------------------------------------------------
// Golden in-container scripts, written out independently of the module
// ---------------------------------------------------------------------------

const PG_PRELUDE = 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; ';
const MYSQL_PRELUDE =
  'if [ -n "${MYSQL_USER:-}" ] && [ -n "${MYSQL_PASSWORD:-}" ]; then DF_USER="$MYSQL_USER"; export MYSQL_PWD="$MYSQL_PASSWORD"; else DF_USER=root; export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}"; fi; ';
const MONGO_ARGS =
  'set -- --archive; if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then set -- "$@" --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin; fi; if [ -n "${MONGO_INITDB_ROOT_PASSWORD:-}" ]; then set -- "$@" --password="$MONGO_INITDB_ROOT_PASSWORD"; fi; if [ -n "${MONGO_INITDB_DATABASE:-}" ]; then set -- "$@" --db="$MONGO_INITDB_DATABASE"; fi; ';
const REDIS_DUMP =
  'BEFORE=$(redis-cli LASTSAVE) && OUT=$(redis-cli BGSAVE) && echo "$OUT" | grep -qE "Background saving (started|scheduled)|already in progress" || { echo "BGSAVE failed: $OUT" >&2; exit 1; } && for i in $(seq 1 30); do AFTER=$(redis-cli LASTSAVE); [ "$AFTER" != "$BEFORE" ] && break; sleep 1; done && cat /data/dump.rdb';
const REDIS_RESTORE =
  'cat > /data/dump.rdb.tmp; if ! [ -s /data/dump.rdb.tmp ]; then rm -f /data/dump.rdb.tmp; echo "restore: received an empty backup stream" >&2; exit 1; fi; mv /data/dump.rdb.tmp /data/dump.rdb && redis-cli SHUTDOWN NOSAVE || true';

const cfg = (config: BackupAccessoryConfig): BackupAccessoryConfig => config;

describe('buildDumpScript', () => {
  it('postgres: credentials and database from the container environment, database defaulting to the user', () => {
    expect(buildDumpScript(cfg({ type: 'postgres' }))).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
  });

  it('postgres: dump_options inserted verbatim before the database', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_options: '--no-owner --clean' }))).toBe(
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists --no-owner --clean "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    );
  });

  it('postgres: --data-only (which pg_dump refuses together with --clean) drops the default', () => {
    for (const dump_options of ['--data-only', '-a', '-a --no-owner', '--no-owner --data-only', '-ax']) {
      expect(buildDumpScript(cfg({ type: 'postgres', dump_options }))).toBe(
        `export PGPASSWORD="\${POSTGRES_PASSWORD:-}"; exec pg_dump -U "\${POSTGRES_USER:-postgres}" ${dump_options} "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"`,
      );
    }
  });

  it('postgres: an option that merely contains an a keeps the default', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_options: '-n abc --inserts' }))).toContain('--clean --if-exists');
    expect(buildDumpScript(cfg({ type: 'postgres', dump_options: '--attribute-inserts' }))).toContain('--clean --if-exists');
  });

  it('mysql: user and password paired from the environment, every database when none is named', () => {
    expect(buildDumpScript(cfg({ type: 'mysql' }))).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; exec mysqldump -u"$DF_USER" "$@"`,
    );
    expect(buildDumpScript(cfg({ type: 'mysql', dump_options: '--single-transaction' }))).toBe(
      `${MYSQL_PRELUDE}if [ -n "\${MYSQL_DATABASE:-}" ]; then set -- "$MYSQL_DATABASE"; else set -- --all-databases; fi; exec mysqldump -u"$DF_USER" --single-transaction "$@"`,
    );
  });

  it('mongodb: arguments built in the container, options after them', () => {
    expect(buildDumpScript(cfg({ type: 'mongodb' }))).toBe(`${MONGO_ARGS}exec mongodump "$@"`);
    expect(buildDumpScript(cfg({ type: 'mongodb', dump_options: '--oplog' }))).toBe(`${MONGO_ARGS}exec mongodump "$@" --oplog`);
  });

  it('redis: BGSAVE, wait for LASTSAVE, emit the RDB; options are ignored', () => {
    expect(buildDumpScript(cfg({ type: 'redis' }))).toBe(REDIS_DUMP);
    expect(buildDumpScript(cfg({ type: 'redis', dump_options: '--x' }))).toBe(REDIS_DUMP);
  });

  it('raw: dump_command verbatim; a missing command is a ConfigError', () => {
    expect(buildDumpScript(cfg({ type: 'raw', dump_command: 'cat /srv/data.bin', restore_command: 'x' }))).toBe('cat /srv/data.bin');
    expect(() => buildDumpScript(cfg({ type: 'raw' }))).toThrow(ConfigError);
  });

  it('custom dump_command: the credential prelude is prepended for postgres and mysql only', () => {
    expect(buildDumpScript(cfg({ type: 'postgres', dump_command: 'pg_dumpall -U app' }))).toBe(`${PG_PRELUDE}pg_dumpall -U app`);
    expect(buildDumpScript(cfg({ type: 'mysql', dump_command: 'mysqldump -u"$DF_USER" shop' }))).toBe(
      `${MYSQL_PRELUDE}mysqldump -u"$DF_USER" shop`,
    );
    expect(buildDumpScript(cfg({ type: 'mongodb', dump_command: 'mongodump --archive' }))).toBe('mongodump --archive');
    expect(buildDumpScript(cfg({ type: 'redis', dump_command: 'cat /data/dump.rdb' }))).toBe('cat /data/dump.rdb');
  });

  it('volume has no dump script', () => {
    expect(() => buildDumpScript(cfg({ type: 'volume' }))).toThrow(ConfigError);
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

  it('mongodb: --drop before the options', () => {
    expect(buildRestoreScript(cfg({ type: 'mongodb' }))).toBe(`${MONGO_ARGS}exec mongorestore "$@" --drop`);
    expect(buildRestoreScript(cfg({ type: 'mongodb', restore_options: '--gzip' }))).toBe(`${MONGO_ARGS}exec mongorestore "$@" --drop --gzip`);
  });

  it('redis: the staged RDB, then a shutdown without save', () => {
    expect(buildRestoreScript(cfg({ type: 'redis' }))).toBe(REDIS_RESTORE);
  });

  it('raw and custom commands', () => {
    expect(buildRestoreScript(cfg({ type: 'raw', dump_command: 'x', restore_command: 'cat > /srv/data.bin' }))).toBe('cat > /srv/data.bin');
    expect(() => buildRestoreScript(cfg({ type: 'raw', dump_command: 'x' }))).toThrow(ConfigError);
    expect(buildRestoreScript(cfg({ type: 'postgres', restore_command: 'psql -U app shop' }))).toBe(`${PG_PRELUDE}psql -U app shop`);
    expect(buildRestoreScript(cfg({ type: 'mysql', restore_command: 'mysql shop' }))).toBe(`${MYSQL_PRELUDE}mysql shop`);
    expect(buildRestoreScript(cfg({ type: 'mongodb', restore_command: 'mongorestore --archive' }))).toBe('mongorestore --archive');
    expect(buildRestoreScript(cfg({ type: 'redis', restore_command: 'cat > /data/dump.rdb' }))).toBe('cat > /data/dump.rdb');
    expect(() => buildRestoreScript(cfg({ type: 'volume' }))).toThrow(ConfigError);
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

describe('no credential values on the host', () => {
  it('no script mentions a password value: they only name the container variables', () => {
    for (const type of ['postgres', 'mysql', 'mongodb', 'redis'] as const) {
      expect(buildDumpScript(cfg({ type }))).not.toMatch(/s3cret/);
      expect(buildRestoreScript(cfg({ type }))).not.toMatch(/s3cret/);
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
// Mounts, archive check, paths, selection
// ---------------------------------------------------------------------------

describe('parseContainerMounts', () => {
  const mounts = JSON.stringify([
    { Type: 'volume', Name: 'demo_data', Source: '/var/lib/docker/volumes/demo_data/_data', Destination: '/var/lib/postgresql/data' },
    { Type: 'bind', Source: '/host/config', Destination: '/etc/config', RW: true },
    { Type: 'bind', Source: '/host/readonly', Destination: '/etc/ro', RW: false },
  ]);

  it('volume names are shortened by stripping the stack prefix', () => {
    const infos = parseContainerMounts(mounts, 'demo');
    const vol = infos.find(i => i.mountType === 'volume')!;
    expect(vol.name).toBe('data');
    expect(vol.source).toBe('demo_data'); // source keeps the full Docker volume name
  });

  it('read-only bind mounts are skipped, read-write kept with sanitized names', () => {
    const infos = parseContainerMounts(mounts, 'demo');
    const binds = infos.filter(i => i.mountType === 'bind');
    expect(binds).toHaveLength(1);
    expect(binds[0].name).toBe('etc-config');
    expect(binds[0].source).toBe('/host/config');
  });

  it('includeBindMounts=false keeps only volumes', () => {
    const infos = parseContainerMounts(mounts, 'demo', undefined, false);
    expect(infos.every(i => i.mountType === 'volume')).toBe(true);
  });

  it('exclude patterns support * globs and match name, source or destination', () => {
    expect(parseContainerMounts(mounts, 'demo', ['data']).find(i => i.name === 'data')).toBeUndefined();
    expect(parseContainerMounts(mounts, 'demo', ['/etc/*']).find(i => i.mountType === 'bind')).toBeUndefined();
    expect(parseContainerMounts(mounts, 'demo', ['nomatch'])).toHaveLength(2);
  });

  it('empty output → empty list, malformed JSON throws', () => {
    expect(parseContainerMounts('', 'demo')).toEqual([]);
    expect(() => parseContainerMounts('{broken', 'demo')).toThrow();
  });
});

describe('buildArchiveCheckCommand', () => {
  it('gzip archives get a CRC integrity test plus a non-empty check', () => {
    const cmd = buildArchiveCheckCommand('/b/x.sql.gz', 'gzip');
    expect(cmd).toContain("gunzip -t '/b/x.sql.gz'");      // truncation/corruption
    expect(cmd).toContain("gunzip -c '/b/x.sql.gz'");      // emptiness
    expect(cmd).toContain('echo CORRUPT');
    expect(cmd).toContain('echo EMPTY');
    expect(cmd).toContain('echo OK');
  });

  it('uncompressed files only get existence and non-empty checks', () => {
    const cmd = buildArchiveCheckCommand('/b/x.sql', 'none');
    expect(cmd).toContain("[ ! -f '/b/x.sql' ]");
    expect(cmd).toContain("head -c 1 '/b/x.sql'");
    expect(cmd).not.toContain('gunzip');
  });

  it('paths with single quotes are escaped', () => {
    expect(buildArchiveCheckCommand("/b/it's.gz", 'gzip')).toContain("'/b/it'\\''s.gz'");
  });

  it('the three verdicts are mutually exclusive shell branches', () => {
    const cmd = buildArchiveCheckCommand('/b/x.gz', 'gzip');
    expect(cmd.match(/echo (OK|EMPTY|CORRUPT)/g)).toHaveLength(3);
    expect(cmd).toContain('if ');
    expect(cmd).toContain('elif ');
    expect(cmd).toContain('else ');
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('buildDataFilePath', () => {
  it('uses the strategy file extension', () => {
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

// ---------------------------------------------------------------------------
// Prune / resolve selection
// ---------------------------------------------------------------------------

describe('selectBackupsToPrune', () => {
  const entries = [
    { id: 'c', timestamp: '2026-03-01T00:00:00Z' },
    { id: 'a', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'b', timestamp: '2026-02-01T00:00:00Z' },
  ];

  it('keeps the N most recent, returns the rest oldest-last', () => {
    const toRemove = selectBackupsToPrune(entries, 1);
    expect(toRemove.map(e => e.id)).toEqual(['b', 'a']);
  });

  it('sorts defensively even if input is unsorted', () => {
    expect(selectBackupsToPrune(entries, 2).map(e => e.id)).toEqual(['a']);
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

describe('findBackupMatch', () => {
  const entries = [
    { id: '20260301-120000-ff00' },
    { id: '20260201-120000-aa11' },
  ];

  it('no id → newest (first entry)', () => {
    expect(findBackupMatch(entries)!.id).toBe('20260301-120000-ff00');
  });

  it('exact id match', () => {
    expect(findBackupMatch(entries, '20260201-120000-aa11')!.id).toBe('20260201-120000-aa11');
  });

  it('prefix match', () => {
    expect(findBackupMatch(entries, '202602')!.id).toBe('20260201-120000-aa11');
  });

  it('no match or empty list → null', () => {
    expect(findBackupMatch(entries, 'zzz')).toBeNull();
    expect(findBackupMatch([], 'a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Execution against a real POSIX sh (skipped where there is none: run in WSL)
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'dockflow-backup-strategies-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runSh(
  script: string,
  options: { env?: Record<string, string>; stdin?: string; binDir?: string; cwd?: string } = {},
): { exitCode: number; stdout: string; stderr: string } {
  const systemPath = process.env.PATH ?? '/usr/bin:/bin';
  const proc = Bun.spawnSync([Bun.which('sh') ?? 'sh', '-c', script], {
    cwd: options.cwd ?? work,
    env: { PATH: options.binDir ? `${options.binDir}:${systemPath}` : systemPath, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function freshDir(name: string): string {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('buildCapturePipeline', () => {
  it('gzip: the producer status is returned and the output still written', () => {
    expect(buildCapturePipeline("docker exec 'c1' sh -c 'x'", '/b/s/db/1.sql.gz', true)).toBe(
      "umask 077 && mkdir -p '/b/s/db' && { docker exec 'c1' sh -c 'x'; echo \"$?\" > '/b/s/db/1.sql.gz.rc'; } | gzip -c > '/b/s/db/1.sql.gz'; z=$?; " +
        "rc=$(cat '/b/s/db/1.sql.gz.rc' 2>/dev/null); rm -f '/b/s/db/1.sql.gz.rc'; [ \"${rc:-255}\" -eq 0 ] || exit \"${rc:-255}\"; exit \"$z\"",
    );
  });

  it('none: a plain redirection', () => {
    expect(buildCapturePipeline("docker exec 'c1' sh -c 'x'", '/b/s/db/1.sql', false)).toBe(
      "umask 077 && mkdir -p '/b/s/db' && docker exec 'c1' sh -c 'x' > '/b/s/db/1.sql'",
    );
  });

  it('paths are shell-quoted', () => {
    expect(buildCapturePipeline('true', "/b/it's/1.gz", true)).toContain("mkdir -p '/b/it'\\''s'");
  });

  describe.if(hasPosixShell)('executed', () => {
    it('a producer that fails midway fails the pipeline, and the partial output is on disk for the caller to remove', () => {
      const file = join(freshDir('capture-fail'), 'out', '1.sql.gz');
      const result = runSh(buildCapturePipeline("sh -c 'printf partial; exit 3'", file, true));
      expect(result.exitCode).toBe(3);
      expect(runSh(`gunzip -c '${file}'`).stdout).toBe('partial');
      expect(readdirSync(join(file, '..'))).toEqual(['1.sql.gz']);
    });

    it('a producer that succeeds gives 0, and the rc file is gone', () => {
      const file = join(freshDir('capture-ok'), 'out', '1.sql.gz');
      expect(runSh(buildCapturePipeline("sh -c 'printf payload'", file, true)).exitCode).toBe(0);
      expect(runSh(`gunzip -c '${file}'`).stdout).toBe('payload');
      expect(readdirSync(join(file, '..'))).toEqual(['1.sql.gz']);
    });

    it('a failing gzip fails the pipeline too', () => {
      const dir = freshDir('capture-gzip');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'gzip'), ['#!/bin/sh', 'cat > /dev/null', 'exit 7', ''].join('\n'));
      chmodSync(join(bin, 'gzip'), 0o755);
      const result = runSh(`PATH='${bin}':$PATH; ${buildCapturePipeline("sh -c 'printf x'", join(dir, 'out', '1.gz'), true)}`);
      expect(result.exitCode).toBe(7);
    });

    it('a producer that dies of a signal is not mistaken for success', () => {
      const file = join(freshDir('capture-kill'), 'out', '1.gz');
      expect(runSh(buildCapturePipeline("sh -c 'printf x; kill -9 $$'", file, true)).exitCode).toBe(137);
    });

    it('files are 0600 and new directories 0700; none has no rc file', () => {
      const dir = freshDir('capture-mode');
      const gz = join(dir, 'new', 'sub', '1.gz');
      const plain = join(dir, 'new', 'sub', '2.sql');
      expect(runSh(buildCapturePipeline("sh -c 'printf x'", gz, true)).exitCode).toBe(0);
      expect(runSh(buildCapturePipeline("sh -c 'printf plain; exit 0'", plain, false)).exitCode).toBe(0);
      expect(statSync(gz).mode & 0o777).toBe(0o600);
      expect(statSync(plain).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'new', 'sub')).mode & 0o777).toBe(0o700);
      expect(readFileSync(plain, 'utf8')).toBe('plain');
      expect(readdirSync(join(dir, 'new', 'sub')).sort()).toEqual(['1.gz', '2.sql']);
    });

    it('a producer failing with none still fails', () => {
      expect(runSh(buildCapturePipeline("sh -c 'exit 5'", join(freshDir('capture-none'), '1.sql'), false)).exitCode).toBe(5);
    });
  });
});

describe.if(hasPosixShell)('in-container scripts, executed', () => {
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
    const dump = buildDumpScript(cfg({ type: 'postgres' }));
    expect(run(dump, { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pg-secret' })).toEqual({
      cmd: 'pg_dump',
      args: ['-U', 'app', '--clean', '--if-exists', 'app'],
      env: { PGPASSWORD: 'pg-secret', MYSQL_PWD: '<unset>' },
    });
    expect(run(dump, { POSTGRES_USER: 'app', POSTGRES_DB: 'shop' }).args).toEqual(['-U', 'app', '--clean', '--if-exists', 'shop']);
    expect(run(dump, {})).toEqual({
      cmd: 'pg_dump',
      args: ['-U', 'postgres', '--clean', '--if-exists', 'postgres'],
      env: { PGPASSWORD: '', MYSQL_PWD: '<unset>' },
    });
    expect(run(buildRestoreScript(cfg({ type: 'postgres' })), { POSTGRES_DB: 'shop' })).toMatchObject({
      cmd: 'psql',
      args: ['-U', 'postgres', 'shop'],
    });
  });

  it('postgres: a password with $, space and quotes reaches pg_dump intact', () => {
    const password = `p$ss w'rd"x`;
    expect(run(buildDumpScript(cfg({ type: 'postgres' })), { POSTGRES_PASSWORD: password }).env.PGPASSWORD).toBe(password);
  });

  it('mysql: MYSQL_USER is used only with MYSQL_PASSWORD, otherwise root with the root password', () => {
    const dump = buildDumpScript(cfg({ type: 'mysql' }));
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
      run(buildDumpScript(cfg({ type: 'mongodb' })), {
        MONGO_INITDB_ROOT_USERNAME: 'root',
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_INITDB_DATABASE: 'shop',
      }),
    ).toMatchObject({
      cmd: 'mongodump',
      args: ['--archive', '--username=root', '--authenticationDatabase=admin', `--password=${password}`, '--db=shop'],
    });
    expect(run(buildRestoreScript(cfg({ type: 'mongodb' })), {})).toMatchObject({
      cmd: 'mongorestore',
      args: ['--archive', '--drop'],
    });
    expect(run(buildRestoreScript(cfg({ type: 'mongodb', restore_options: '--gzip' })), {}).args).toEqual(['--archive', '--drop', '--gzip']);
  });

  it('redis restore: the RDB is staged, installed, and Redis shut down without saving', () => {
    const dir = freshDir('redis-restored');
    const log = join(dir, 'redis.log');
    const script = buildRestoreScript(cfg({ type: 'redis' })).replaceAll('/data/', `${dir}/`);
    const result = runSh(script, { binDir: bin, env: { REDIS_LOG: log }, stdin: 'REDIS0011-payload' });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'dump.rdb'), 'utf8')).toBe('REDIS0011-payload');
    expect(readFileSync(log, 'utf8')).toBe('SHUTDOWN NOSAVE\n');

    const empty = runSh(script, { binDir: bin, env: { REDIS_LOG: log }, stdin: '' });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('restore: received an empty backup stream');
  });
});
