import { describe, expect, it } from 'bun:test';
import {
  DB_STRATEGIES,
  buildExecEnvFlags,
  buildEmptyCheckCommand,
  sanitizePathName,
  parseContainerEnv,
  parseContainerMounts,
  buildDataFilePath,
  buildBackupDir,
  selectBackupsToPrune,
  findBackupMatch,
} from '../services/backup-strategies';

// ---------------------------------------------------------------------------
// Dump / restore command builders
// ---------------------------------------------------------------------------

describe('DB_STRATEGIES.postgres', () => {
  it('dump defaults to postgres user and database', () => {
    expect(DB_STRATEGIES.postgres.buildDumpCommand({})).toBe('pg_dump -U postgres postgres');
  });

  it('dump uses credentials and options', () => {
    expect(DB_STRATEGIES.postgres.buildDumpCommand(
      { user: 'app', database: 'appdb' },
      '--no-owner',
    )).toBe('pg_dump -U app --no-owner appdb');
  });

  it('restore mirrors dump structure with psql', () => {
    expect(DB_STRATEGIES.postgres.buildRestoreCommand({ user: 'app', database: 'appdb' }))
      .toBe('psql -U app appdb');
  });

  it('password is passed via PGPASSWORD env, not the command line', () => {
    expect(DB_STRATEGIES.postgres.buildExecEnv({ password: 's3cret' })).toEqual({ PGPASSWORD: 's3cret' });
    expect(DB_STRATEGIES.postgres.buildExecEnv({})).toEqual({});
    expect(DB_STRATEGIES.postgres.buildDumpCommand({ password: 's3cret' })).not.toContain('s3cret');
  });
});

describe('DB_STRATEGIES.mysql', () => {
  it('dump defaults to root and --all-databases', () => {
    expect(DB_STRATEGIES.mysql.buildDumpCommand({})).toBe('mysqldump -uroot --all-databases');
  });

  it('restore omits database when not set', () => {
    expect(DB_STRATEGIES.mysql.buildRestoreCommand({})).toBe('mysql -uroot');
    expect(DB_STRATEGIES.mysql.buildRestoreCommand({ database: 'db' })).toBe('mysql -uroot db');
  });

  it('password via MYSQL_PWD env', () => {
    expect(DB_STRATEGIES.mysql.buildExecEnv({ password: 'pw' })).toEqual({ MYSQL_PWD: 'pw' });
  });
});

describe('DB_STRATEGIES.mongodb', () => {
  it('anonymous dump is a plain archive', () => {
    expect(DB_STRATEGIES.mongodb.buildDumpCommand({})).toBe('mongodump --archive');
  });

  it('authenticated dump includes username, admin auth db and password', () => {
    const cmd = DB_STRATEGIES.mongodb.buildDumpCommand({ user: 'root', password: 'pw', database: 'db' });
    expect(cmd).toBe('mongodump --archive --username="root" --authenticationDatabase=admin --password="pw" --db="db"');
  });

  it('no env vars (mongo passes credentials on the command line)', () => {
    expect(DB_STRATEGIES.mongodb.buildExecEnv({})).toEqual({});
  });
});

describe('DB_STRATEGIES.redis', () => {
  it('dump triggers BGSAVE, waits for completion, then emits the RDB file', () => {
    const cmd = DB_STRATEGIES.redis.buildDumpCommand({});
    expect(cmd).toContain('BGSAVE');
    expect(cmd).toContain('LASTSAVE');
    expect(cmd).toContain('cat /data/dump.rdb');
  });

  it('dump tolerates a background save already in flight', () => {
    const cmd = DB_STRATEGIES.redis.buildDumpCommand({});
    expect(cmd).toContain('Background saving (started|scheduled)');
    expect(cmd).toContain('already in progress');
  });

  it('restore stages to a temp file and refuses an empty stream', () => {
    const cmd = DB_STRATEGIES.redis.buildRestoreCommand({});
    expect(cmd).toContain('cat > /data/dump.rdb.tmp');
    expect(cmd).toContain('[ -s /data/dump.rdb.tmp ]');
    expect(cmd).toContain('exit 1');
    expect(cmd).toContain('mv /data/dump.rdb.tmp /data/dump.rdb');
    expect(cmd).toContain('SHUTDOWN NOSAVE');
    // The empty-stream failure must reach stderr so restore() detects it
    expect(cmd).toContain('>&2');
  });

  it('redis requires a service restart after restore', () => {
    expect(DB_STRATEGIES.redis.requiresServiceRestart).toBe(true);
    expect(DB_STRATEGIES.postgres.requiresServiceRestart).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Exec env flags
// ---------------------------------------------------------------------------

describe('buildExecEnvFlags', () => {
  it('builds -e flags with shell-escaped values', () => {
    expect(buildExecEnvFlags({ PGPASSWORD: 'plain' })).toBe("-e PGPASSWORD='plain'");
  });

  it('escapes single quotes in values', () => {
    expect(buildExecEnvFlags({ PGPASSWORD: "it's" })).toBe("-e PGPASSWORD='it'\\''s'");
  });

  it('rejects invalid env keys (injection guard)', () => {
    expect(() => buildExecEnvFlags({ 'X; rm -rf /': 'v' })).toThrow('Invalid env key');
  });

  it('empty map yields empty string', () => {
    expect(buildExecEnvFlags({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Container env / mounts parsing
// ---------------------------------------------------------------------------

describe('parseContainerEnv', () => {
  it('maps known env vars to credentials', () => {
    const stdout = JSON.stringify(['POSTGRES_USER=app', 'POSTGRES_PASSWORD=pw', 'POSTGRES_DB=appdb', 'PATH=/usr/bin']);
    expect(parseContainerEnv(stdout, DB_STRATEGIES.postgres.envMapping)).toEqual({
      user: 'app',
      password: 'pw',
      database: 'appdb',
    });
  });

  it('empty output → empty credentials', () => {
    expect(parseContainerEnv('', DB_STRATEGIES.postgres.envMapping)).toEqual({});
    expect(parseContainerEnv('  \n', DB_STRATEGIES.postgres.envMapping)).toEqual({});
  });

  it('values containing = are kept whole', () => {
    const stdout = JSON.stringify(['POSTGRES_PASSWORD=a=b=c']);
    expect(parseContainerEnv(stdout, DB_STRATEGIES.postgres.envMapping).password).toBe('a=b=c');
  });

  it('empty values are ignored', () => {
    const stdout = JSON.stringify(['POSTGRES_USER=']);
    expect(parseContainerEnv(stdout, DB_STRATEGIES.postgres.envMapping).user).toBeUndefined();
  });

  it('malformed JSON throws (caller decides reporting)', () => {
    expect(() => parseContainerEnv('not json', DB_STRATEGIES.postgres.envMapping)).toThrow();
  });
});

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

describe('buildEmptyCheckCommand', () => {
  it('gzip archives are decompressed before the byte count', () => {
    const cmd = buildEmptyCheckCommand('/b/x.sql.gz', 'gzip');
    expect(cmd).toContain("gunzip -c '/b/x.sql.gz'");
    expect(cmd).toContain('head -c 1 | wc -c');
  });

  it('uncompressed files are read directly', () => {
    const cmd = buildEmptyCheckCommand('/b/x.sql', 'none');
    expect(cmd).toContain("head -c 1 '/b/x.sql'");
    expect(cmd).not.toContain('gunzip');
  });

  it('paths with single quotes are escaped', () => {
    expect(buildEmptyCheckCommand("/b/it's.gz", 'gzip')).toContain("'/b/it'\\''s.gz'");
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
