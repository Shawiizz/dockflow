// services/backup.ts over a recorded sshExec: every command the engine sends to a node is kept,
// and each node answers from rules. Nothing here opens a connection.

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Duplex, PassThrough } from 'stream';
import { Backup, type BackupListEntry, type BackupMetadata, restoreTypeMismatch } from '../services/backup';
import { hasPosixShell } from './helpers/local-shell';
import { BackupError, ErrorCode } from '../utils/errors';
import type { SSHKeyConnection } from '../types';
import type { BackupAccessoryConfig } from '../utils/config';
import * as output from '../utils/output';
import * as ssh from '../utils/ssh';

// ---------------------------------------------------------------------------
// Recorded nodes
// ---------------------------------------------------------------------------

type Reply = { exitCode?: number; stdout?: string; stderr?: string } | Error;
type Matcher = string | RegExp | ((command: string) => boolean);

interface NodeCall {
  host: string;
  command: string;
  via: 'exec' | 'channel' | 'stream';
  /** bytes written to a channel's stdin */
  input: string;
}

function connection(host: string): SSHKeyConnection {
  return { host, port: 22, user: 'deploy', privateKey: 'key' };
}

const MANAGER = connection('manager');
const WORKER = connection('worker');

class FakeNodes {
  readonly calls: NodeCall[] = [];
  private readonly rules: { host: string | null; match: Matcher; reply: Reply | ((command: string) => Reply) }[] = [];

  /** later rules win over earlier ones */
  on(match: Matcher, reply: Reply | ((command: string) => Reply), host: string | null = null): this {
    this.rules.push({ host, match, reply });
    return this;
  }

  commands(host?: string): string[] {
    return this.calls.filter((call) => host === undefined || call.host === host).map((call) => call.command);
  }

  reply(host: string, command: string): Reply {
    const rule = [...this.rules].reverse().find((candidate) => {
      if (candidate.host !== null && candidate.host !== host) return false;
      const { match } = candidate;
      if (typeof match === 'string') return command.includes(match);
      if (match instanceof RegExp) return match.test(command);
      return match(command);
    });
    if (!rule) return {};
    return typeof rule.reply === 'function' ? rule.reply(command) : rule.reply;
  }
}

type UnbufferedHandle = Awaited<ReturnType<typeof ssh.sshExecChannelUnbuffered>>;

let nodes: FakeNodes;
let printed: { level: 'warning' | 'info' | 'debug'; message: string }[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  printed = [];
  pauses = [];
  nodes = new FakeNodes();
  // a verification script prints OK when the archive is sound
  nodes.on(/echo OK/, { stdout: 'OK\n' });
  spies = [
    spyOn(ssh, 'sshExec').mockImplementation(async (conn, command, options) => {
      const input = options?.stdin === undefined ? undefined : String(options.stdin);
      nodes.calls.push({ host: conn.host, command, via: input === undefined ? 'exec' : 'channel', input: input ?? '' });
      const reply = nodes.reply(conn.host, command);
      if (reply instanceof Error) throw reply;
      return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    }),
    spyOn(ssh, 'sshExecChannelUnbuffered').mockImplementation(async (conn, command) => {
      const call: NodeCall = { host: conn.host, command, via: 'stream', input: '' };
      nodes.calls.push(call);
      const reply = nodes.reply(conn.host, command);
      const result = reply instanceof Error ? { exitCode: 255, stderr: reply.message } : reply;
      const isSource = /^(gunzip -c|cat) /.test(command);
      const chunks: Buffer[] = [];
      const stream = Object.assign(
        new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        }),
        { stderr: new PassThrough() },
      );
      const finishOutput = () => {
        if (result.stdout) stream.push(result.stdout);
        stream.push(null);
      };
      if (isSource) setImmediate(finishOutput);
      else {
        stream.on('finish', () => {
          call.input = Buffer.concat(chunks).toString();
          finishOutput();
        });
      }
      setImmediate(() => stream.stderr.end(result.stderr ?? ''));
      const done = new Promise<{ exitCode: number }>((resolve) => {
        stream.on('end', () => resolve({ exitCode: result.exitCode ?? 0 }));
      });
      return { stream: stream as unknown as UnbufferedHandle['stream'], done };
    }),
    spyOn(output, 'printWarning').mockImplementation((message) => {
      printed.push({ level: 'warning', message });
    }),
    spyOn(output, 'printInfo').mockImplementation((message) => {
      printed.push({ level: 'info', message });
    }),
    spyOn(output, 'printDebug').mockImplementation((message) => {
      printed.push({ level: 'debug', message });
    }),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STACK = 'shop-production-accessories';
const DIR = `/var/lib/dockflow/backups/${STACK}/db`;
const SEPARATOR = '---DOCKFLOW_META_SEP---';

const POSTGRES: BackupAccessoryConfig = { type: 'postgres' };
const VOLUME: BackupAccessoryConfig = { type: 'volume' };

let pauses: number[] = [];

function backupEngine(): Backup {
  return new Backup(MANAGER, STACK, [{ name: 'server_1', connection: MANAGER }, { name: 'agent_1', connection: WORKER }], {
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
}

/** the container of `db` runs on the worker */
function containerOnWorker(): void {
  nodes.on('docker ps', { stdout: 'c1\n' }, 'worker');
  nodes.on('docker ps', { stdout: '' }, 'manager');
  nodes.on('{{json .Config.Env}}', {
    stdout: JSON.stringify(['POSTGRES_USER=app', 'POSTGRES_PASSWORD=pw', 'POSTGRES_DB=shop']),
  });
  nodes.on('stat -c %s', { stdout: '2048\n' });
}

function metadata(fields: Partial<BackupMetadata> & { id: string }): BackupMetadata {
  return {
    service: 'db',
    dbType: 'postgres',
    timestamp: '2026-05-01T10:00:00.000Z',
    size: '2 KB',
    sizeBytes: 2048,
    compression: 'gzip',
    durationMs: 100,
    stackName: STACK,
    nodeHost: 'worker',
    nodePort: 22,
    ...fields,
  };
}

function listing(...metas: unknown[]): { stdout: string } {
  return { stdout: metas.map((meta) => `${SEPARATOR}\n${JSON.stringify(meta)}\n`).join('') };
}

function failure<T>(result: { success: boolean; data?: T; error?: Error }): Error {
  if (result.success || !result.error) throw new Error('expected a failed result');
  return result.error;
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

describe('Backup.backup', () => {
  it('captures the dump with the producer status and umask 077, then writes 0600 metadata on the same node', async () => {
    containerOnWorker();
    const result = await backupEngine().backup('db', POSTGRES, 'gzip');
    expect(result.success).toBe(true);

    const capture = nodes.calls.find((call) => call.command.includes('docker exec'));
    expect(capture?.host).toBe('worker');
    expect(capture?.command.startsWith(`umask 077 && mkdir -p '${DIR}' && { docker exec `)).toBe(true);
    expect(capture?.command).toContain('echo "$?" >');
    expect(capture?.command).toContain('| gzip -c >');
    expect(nodes.commands()).not.toContain(`mkdir -p '${DIR}'`);

    const meta = nodes.calls.find((call) => call.via === 'channel');
    expect(meta?.host).toBe('worker');
    expect(meta?.command).toMatch(/^umask 077 && cat > '.*\.meta\.json'$/);
    const written = JSON.parse(meta?.input ?? '') as BackupMetadata;
    expect(written).toMatchObject({ service: 'db', dbType: 'postgres', nodeHost: 'worker', compression: 'gzip' });
  });

  it('compression none is a plain redirection under the same umask', async () => {
    containerOnWorker();
    await backupEngine().backup('db', POSTGRES, 'none');
    const capture = nodes.calls.find((call) => call.command.includes('docker exec'));
    expect(capture?.command).toMatch(/^umask 077 && mkdir -p .* && docker exec .* > '.*\.sql'$/);
  });

  it('a dump whose producer failed is removed and reported with its stderr', async () => {
    containerOnWorker();
    nodes.on('docker exec', { exitCode: 3, stderr: 'pg_dump: connection refused' });
    const error = failure(await backupEngine().backup('db', POSTGRES, 'gzip'));
    expect(error.message).toBe('Backup failed: pg_dump: connection refused');
    expect(nodes.commands('worker').some((command) => command.startsWith('rm -f ') && command.includes('.sql.gz'))).toBe(true);
    expect(nodes.calls.some((call) => call.via === 'channel')).toBe(false);
  });

  it('a metadata write that fails removes the data file and fails the backup', async () => {
    containerOnWorker();
    nodes.on('cat > ', { exitCode: 1, stderr: 'No space left on device' });
    const error = failure(await backupEngine().backup('db', POSTGRES, 'gzip'));
    expect(error.message).toMatch(/^Cannot write the metadata of backup \d{8}-\d{6}-[0-9a-f]{4}: No space left on device$/);
    expect(nodes.commands('worker').some((command) => command.startsWith('rm -f ') && command.includes('.sql.gz'))).toBe(true);
  });

  it('volume backup: one capture pipeline per volume, 0600 metadata naming every volume', async () => {
    nodes.on('docker ps', { stdout: 'c1\n' }, 'worker');
    nodes.on('{{json .Mounts}}', {
      stdout: JSON.stringify([
        { Type: 'volume', Name: `${STACK}_data`, Source: '/x', Destination: '/data' },
        { Type: 'bind', Source: '/srv/uploads', Destination: '/uploads', RW: true },
      ]),
    });
    nodes.on('stat -c %s', { stdout: '10\n' });
    const result = await backupEngine().backup('db', VOLUME, 'gzip');
    expect(result.success).toBe(true);

    const captures = nodes.calls.filter((call) => call.command.startsWith('umask 077 && mkdir -p'));
    expect(captures).toHaveLength(2);
    expect(captures[0].command).toContain(`docker run --rm -v '${STACK}_data':/backup-source:ro alpine tar cf - -C /backup-source .`);
    expect(captures[1].command).toContain("tar cf - -C '/srv/uploads' .");
    for (const capture of captures) expect(capture.command).toContain('echo "$?" >');

    const meta = nodes.calls.find((call) => call.via === 'channel');
    expect(meta?.command).toMatch(/^umask 077 && cat > /);
    expect((JSON.parse(meta?.input ?? '') as BackupMetadata).volumes?.map((volume) => volume.name)).toEqual(['data', 'uploads']);
  });

  it('volume backup: a failed metadata write removes every archive', async () => {
    nodes.on('docker ps', { stdout: 'c1\n' }, 'worker');
    nodes.on('{{json .Mounts}}', {
      stdout: JSON.stringify([
        { Type: 'volume', Name: `${STACK}_data`, Source: '/x', Destination: '/data' },
        { Type: 'bind', Source: '/srv/uploads', Destination: '/uploads', RW: true },
      ]),
    });
    nodes.on('cat > ', { exitCode: 1, stderr: 'read-only file system' });
    const error = failure(await backupEngine().backup('db', VOLUME, 'gzip'));
    expect(error.message).toContain('read-only file system');
    const removal = nodes.commands('worker').find((command) => command.startsWith('rm -f '));
    expect(removal).toContain('.data.tar.gz');
    expect(removal).toContain('.uploads.tar.gz');
  });
});

// ---------------------------------------------------------------------------
// list: unusable metadata never becomes a path
// ---------------------------------------------------------------------------

describe('Backup.list metadata', () => {
  it('skips metadata whose id, service, type or compression cannot be trusted', async () => {
    nodes.on(
      '*.meta.json',
      listing(
        metadata({ id: '20260501-100000-aaaa' }),
        metadata({ id: '../../etc/passwd' }),
        metadata({ id: '20260501-100001-bbbb', service: '../other' }),
        metadata({ id: '20260501-100002-cccc', dbType: 'weird' as BackupMetadata['dbType'] }),
        metadata({ id: '20260501-100003-dddd', compression: 'zstd' as BackupMetadata['compression'] }),
        metadata({ id: '-rf' }),
        { id: 42 },
        null,
      ),
    );
    const listed = await backupEngine().list('db');
    expect(listed.success && listed.data.entries.map((entry) => entry.id)).toEqual(['20260501-100000-aaaa']);
  });
});

describe('Backup.backup credentials', () => {
  it('never reads the container environment or puts a credential on the host command line', async () => {
    containerOnWorker();
    await backupEngine().backup('db', POSTGRES, 'gzip');
    for (const command of nodes.commands()) {
      expect(command).not.toContain('{{json .Config.Env}}');
      expect(command).not.toContain('PGPASSWORD=pw');
      expect(command).not.toMatch(/ -e [A-Z_]+=/);
    }
    const capture = nodes.calls.find((call) => call.command.includes('docker exec'));
    expect(capture?.command).toContain('"${POSTGRES_PASSWORD:-}"');
  });

  it('a raw service without a dump command is a configuration error, and nothing runs on a node', async () => {
    containerOnWorker();
    const error = failure(await backupEngine().backup('db', { type: 'raw' }, 'gzip'));
    expect(error.message).toBe('Backup type raw needs dump_command');
    expect(nodes.commands('worker').some((command) => command.includes('docker exec'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const POSTGRES_BACKUP = '20260501-100000-aaaa';

function backupOnWorker(fields: Partial<BackupMetadata> = {}): void {
  nodes.on('*.meta.json', listing(metadata({ id: POSTGRES_BACKUP, ...fields })), 'worker');
}

describe('Backup.restore', () => {
  it('streams the verified file into the container with the in-container script, nothing secret on the host', async () => {
    containerOnWorker();
    backupOnWorker();
    const result = await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    expect(result.success).toBe(true);

    const restore = nodes.calls.find((call) => call.command.includes('docker exec -i'));
    expect(restore?.host).toBe('worker');
    expect(restore?.command).toBe(
      `gunzip -c '${DIR}/${POSTGRES_BACKUP}.sql.gz' | docker exec -i 'c1' sh -c 'export PGPASSWORD="\${POSTGRES_PASSWORD:-}"; exec psql -U "\${POSTGRES_USER:-postgres}" "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"'`,
    );
    expect(nodes.commands().some((command) => command.includes('{{json .Config.Env}}'))).toBe(false);
  });

  it('a failing restore reports the stderr of the database', async () => {
    containerOnWorker();
    backupOnWorker();
    nodes.on('docker exec -i', { exitCode: 3, stderr: 'psql: FATAL: password authentication failed' });
    expect(failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES)).message).toBe(
      'Restore failed: psql: FATAL: password authentication failed',
    );
  });

  it('a failing restore without stderr still says it failed', async () => {
    containerOnWorker();
    backupOnWorker();
    nodes.on('docker exec -i', { exitCode: 2 });
    expect(failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES)).message).toBe('Restore failed: exit code 2');
  });
});

describe('Backup.restore of redis', () => {
  const REDIS: BackupAccessoryConfig = { type: 'redis' };

  function redisBackup(): void {
    containerOnWorker();
    nodes.on('*.meta.json', listing(metadata({ id: POSTGRES_BACKUP, dbType: 'redis' })), 'worker');
  }

  it('an appendonly redis is refused with advice, before the service is touched', async () => {
    redisBackup();
    nodes.on('docker exec -i', { exitCode: 3, stderr: 'DOCKFLOW_REFUSED: redis-appendonly\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, REDIS));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(
      'Redis in service db has appendonly enabled; a restored dump.rdb would be ignored at startup, so nothing was changed',
    );
    expect((error as BackupError).suggestion).toBe('Back up and restore this service with `type: volume`.');
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);
    expect(pauses).toEqual([]);
    expect(nodes.commands().some((command) => command.includes('docker service update'))).toBe(false);
  });

  it('the expected kill of redis (non-zero exit, empty stderr) is a success followed by a service update', async () => {
    redisBackup();
    nodes.on('docker exec -i', { exitCode: 137 });
    expect((await backupEngine().restore('db', POSTGRES_BACKUP, REDIS)).success).toBe(true);
    expect(pauses).toEqual([3000]);
    expect(nodes.commands('manager')).toContain(`timeout 300 docker service update --force '${STACK}_db'`);
  });

  it('any other failure reports its detail without the marker line, and does not restart', async () => {
    redisBackup();
    nodes.on('docker exec -i', { exitCode: 1, stderr: 'restore: received an empty backup stream\n' });
    expect(failure(await backupEngine().restore('db', POSTGRES_BACKUP, REDIS)).message).toBe(
      'Restore failed: restore: received an empty backup stream',
    );
    expect(pauses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

describe('Backup.backup verifies what it wrote', () => {
  it('a gzip dump is checked with the gzip class and recorded as such', async () => {
    containerOnWorker();
    await backupEngine().backup('db', POSTGRES, 'gzip');
    const check = nodes.calls.find((call) => call.command.endsWith('\necho OK'));
    expect(check?.host).toBe('worker');
    expect(check?.command).toContain('gunzip -t "$f"');
    expect(JSON.parse(nodes.calls.find((call) => call.via === 'channel')?.input ?? '').integrity).toBe('gzip');
  });

  it('a plain postgres dump carries the trailer, is checked by it and recorded as such', async () => {
    containerOnWorker();
    await backupEngine().backup('db', POSTGRES, 'none');
    expect(nodes.calls.find((call) => call.command.includes('docker exec'))?.command).toContain('DOCKFLOW_DUMP_END');
    expect(nodes.calls.find((call) => call.command.endsWith('\necho OK'))?.command).toContain("tail -n 1");
    expect(JSON.parse(nodes.calls.find((call) => call.via === 'channel')?.input ?? '').integrity).toBe('trailer');
  });

  it('a dump that fails its check is removed and reported, and no metadata is written', async () => {
    containerOnWorker();
    nodes.on('echo OK', { exitCode: 1, stdout: 'the dump has no integrity marker\n' });
    const error = failure(await backupEngine().backup('db', POSTGRES, 'none'));
    expect(error.message).toBe('Backup verification failed: the dump has no integrity marker');
    expect(nodes.commands('worker').some((command) => command.startsWith('rm -f ') && command.includes('.sql'))).toBe(true);
    expect(nodes.calls.some((call) => call.via === 'channel')).toBe(false);
  });

  it('a verification that exits without a line to show still says what happened', async () => {
    containerOnWorker();
    nodes.on('echo OK', { exitCode: 255, stderr: 'mktemp: failed to create file\n' });
    expect(failure(await backupEngine().backup('db', POSTGRES, 'gzip')).message).toBe(
      'Backup verification failed: the verification exited with code 255 (mktemp: failed to create file)',
    );
  });

  it('a backup nothing can check is created with a warning and recorded as opaque', async () => {
    containerOnWorker();
    const result = await backupEngine().backup('db', { type: 'redis' }, 'none');
    expect(result.success).toBe(true);
    expect(printed.filter((line) => line.level === 'warning').map((line) => line.message)).toEqual([
      expect.stringContaining('cannot be verified before a restore'),
    ]);
    expect(JSON.parse(nodes.calls.find((call) => call.via === 'channel')?.input ?? '').integrity).toBe('opaque');
  });

  it('volume archives are listed end to end', async () => {
    nodes.on('docker ps', { stdout: 'c1\n' }, 'worker');
    nodes.on('{{json .Mounts}}', {
      stdout: JSON.stringify([{ Type: 'volume', Name: `${STACK}_data`, Source: '/x', Destination: '/data' }]),
    });
    await backupEngine().backup('db', VOLUME, 'gzip');
    expect(nodes.calls.find((call) => call.command.endsWith('\necho OK'))?.command).toContain('tar tf -');
    expect(JSON.parse(nodes.calls.find((call) => call.via === 'channel')?.input ?? '').integrity).toBe('tar');
  });
});

describe('Backup.restore verifies before anything is destroyed', () => {
  const dockerExec = (command: string): boolean => command.includes('docker exec -i');
  const checks = (): NodeCall[] => nodes.calls.filter((call) => call.command.endsWith('\necho OK'));

  it('the check runs on the node holding the file, before the container is touched', async () => {
    containerOnWorker();
    backupOnWorker({ integrity: 'gzip' });
    await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    const order = nodes.calls.map((call) => (call.command.endsWith('\necho OK') ? 'check' : dockerExec(call.command) ? 'restore' : ''));
    expect(order.indexOf('check')).toBeGreaterThan(-1);
    expect(order.indexOf('check')).toBeLessThan(order.indexOf('restore'));
    expect(checks()[0].host).toBe('worker');
    expect(checks()[0].command).toContain(`f='${DIR}/${POSTGRES_BACKUP}.sql.gz'`);
  });

  it('a failing check means the container is never touched', async () => {
    containerOnWorker();
    backupOnWorker({ integrity: 'gzip' });
    nodes.on('echo OK', { exitCode: 1, stdout: 'the gzip stream is corrupt or truncated\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES));
    expect(error.message).toBe(`Backup ${POSTGRES_BACKUP} cannot be restored: the gzip stream is corrupt or truncated`);
    expect(nodes.commands().some(dockerExec)).toBe(false);
  });

  it('a dump that lost its marker is refused with the way out; --force-unverified checks the basics and warns', async () => {
    containerOnWorker();
    backupOnWorker({ integrity: 'trailer', compression: 'none' });
    nodes.on('tail -n 1', { exitCode: 1, stdout: 'the dump has no integrity marker\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES));
    expect(error.message).toBe(`Backup ${POSTGRES_BACKUP} cannot be restored: the dump has no integrity marker`);
    expect((error as BackupError).suggestion).toContain('--force-unverified');
    expect(nodes.commands().some(dockerExec)).toBe(false);

    nodes.calls.length = 0;
    const forced = await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES, undefined, { forceUnverified: true });
    expect(forced.success).toBe(true);
    expect(checks()[0].command).not.toContain('tail -n 1');
    expect(nodes.commands().some(dockerExec)).toBe(true);
    expect(printed.filter((line) => line.level === 'warning').map((line) => line.message)).toEqual([
      `Restoring ${POSTGRES_BACKUP} without checking its integrity marker`,
    ]);
  });

  it('--force-unverified never relaxes the gzip check', async () => {
    containerOnWorker();
    backupOnWorker({ integrity: 'gzip' });
    nodes.on('echo OK', { exitCode: 1, stdout: 'the gzip stream is corrupt or truncated\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES, undefined, { forceUnverified: true }));
    expect(error.message).toContain('corrupt or truncated');
    expect(nodes.commands().some(dockerExec)).toBe(false);
  });

  it('a backup taken before integrity was recorded is restored as it always was: gzip is checked, the rest is not refused', async () => {
    containerOnWorker();
    backupOnWorker({ compression: 'gzip' });
    await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    expect(checks()[0].command).toContain('gunzip -t "$f"');

    nodes.calls.length = 0;
    backupOnWorker({ compression: 'none' });
    const plain = await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    expect(plain.success).toBe(true);
    expect(checks()[0].command).toBe(`f='${DIR}/${POSTGRES_BACKUP}.sql'\n[ -s "$f" ] || { echo 'the file is missing or empty'; exit 1; }\necho OK`);
    expect(printed.filter((line) => line.level === 'warning')).toEqual([]);
  });

  it('volume restore verifies every archive before any volume is written', async () => {
    const volumes = [
      { name: 'data', sizeBytes: 1, mountType: 'volume' as const, sourcePath: `${STACK}_data` },
      { name: 'uploads', sizeBytes: 1, mountType: 'bind' as const, sourcePath: '/srv/uploads' },
    ];
    const meta = metadata({ id: POSTGRES_BACKUP, dbType: 'volume', volumes });
    nodes.on('*.meta.json', listing(meta));
    nodes.on(`cat '${DIR}/${POSTGRES_BACKUP}.meta.json'`, { stdout: JSON.stringify(meta) });
    nodes.on(`${POSTGRES_BACKUP}.uploads.tar.gz`, { exitCode: 1, stdout: 'the gzip stream is corrupt or truncated\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, VOLUME));
    expect(error.message).toContain('uploads');
    expect(error.message).toContain('corrupt or truncated');
    expect(nodes.commands().some((command) => command.includes('alpine') || command.includes('tar xf'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list, resolveBackup, ordering
// ---------------------------------------------------------------------------

describe('Backup.list and resolveBackup', () => {
  const OLD = '20260401-100000-aaaa';
  const NEW = '20260501-100000-bbbb';

  /** the manager holds one backup, the worker the other */
  function backupsOnBothNodes(): void {
    nodes.on('*.meta.json', listing(metadata({ id: OLD, nodeHost: 'manager', timestamp: '2026-04-01T10:00:00.000Z' })), 'manager');
    nodes.on('*.meta.json', listing(metadata({ id: NEW, nodeHost: 'worker', timestamp: '2026-05-01T10:00:00.000Z' })), 'worker');
  }

  it('lists the backups of every node, newest first, each with the server it was found on', async () => {
    backupsOnBothNodes();
    const listed = await backupEngine().list('db');
    expect(listed.success && listed.data.unreachable).toEqual([]);
    expect(listed.success && listed.data.entries.map((entry) => [entry.id, entry.node])).toEqual([
      [NEW, 'agent_1'],
      [OLD, 'server_1'],
    ]);
  });

  it('reports the node that did not answer instead of failing', async () => {
    backupsOnBothNodes();
    nodes.on('*.meta.json', new Error('Timed out while waiting for handshake'), 'worker');
    const listed = await backupEngine().list('db');
    expect(listed.success && listed.data.entries.map((entry) => entry.id)).toEqual([OLD]);
    expect(listed.success && listed.data.unreachable.map((node) => node.name)).toEqual(['agent_1']);
  });

  it('orders by when the backups were taken, not by what the clock of the machine that took them said', async () => {
    nodes.on(
      '*.meta.json',
      listing(
        metadata({ id: 'skewed', timestamp: '2026-09-01T00:00:00.000Z', epochMs: Date.parse('2026-03-01T00:00:00.000Z') }),
        metadata({ id: 'recent', timestamp: '2026-04-01T00:00:00.000Z', epochMs: Date.parse('2026-04-01T00:00:00.000Z') }),
        metadata({ id: 'legacy', timestamp: '2026-03-15T00:00:00.000Z' }),
      ),
      'manager',
    );
    const listed = await backupEngine().list('db');
    expect(listed.success && listed.data.entries.map((entry) => entry.id)).toEqual(['recent', 'legacy', 'skewed']);
  });

  it('--node narrows the search to that server; an unknown name lists the valid ones', async () => {
    backupsOnBothNodes();
    const only = await backupEngine().list('db', { node: 'agent_1' });
    expect(only.success && only.data.entries.map((entry) => entry.id)).toEqual([NEW]);
    expect(nodes.commands('manager').some((command) => command.includes('*.meta.json'))).toBe(false);

    const unknown = failure(await backupEngine().list('db', { node: 'nope' }));
    expect(unknown.message).toBe('Server nope is not a server of this environment with SSH credentials');
    expect((unknown as BackupError).suggestion).toBe('Pass one of: server_1, agent_1.');
  });

  it('latest, implicit or explicit, is refused while a node that may hold a newer backup did not answer', async () => {
    backupsOnBothNodes();
    nodes.on('*.meta.json', new Error('Timed out'), 'worker');
    for (const id of [undefined, 'latest']) {
      const error = failure(await backupEngine().resolveBackup('db', id));
      expect(error.message).toBe('The newest backup of db cannot be determined: agent_1 did not answer');
      expect((error as BackupError).suggestion).toBe('Name the backup explicitly with `--from <id>`, or bring agent_1 back and retry.');
      expect((error as BackupError).code).toBe(ErrorCode.BACKUP_NOT_FOUND);
    }
  });

  it('an explicit id on a reachable node resolves although another node did not answer', async () => {
    backupsOnBothNodes();
    nodes.on('*.meta.json', new Error('Timed out'), 'worker');
    const resolved = await backupEngine().resolveBackup('db', '202604');
    expect(resolved.success && resolved.data.id).toBe(OLD);
  });

  it('a backup that is not listed names the nodes that did not answer', async () => {
    backupsOnBothNodes();
    nodes.on('*.meta.json', new Error('Timed out'), 'worker');
    const error = failure(await backupEngine().resolveBackup('db', '2027'));
    expect(error.message).toBe('No backup matching "2027" found for service db');
    expect((error as BackupError).suggestion).toBe('Bring agent_1 back and retry; backups stored there are not listed.');
  });

  it('with every node answering, latest is the newest across nodes; the exact id wins over a prefix', async () => {
    backupsOnBothNodes();
    const latest = await backupEngine().resolveBackup('db');
    expect(latest.success && latest.data.id).toBe(NEW);
    const exact = await backupEngine().resolveBackup('db', OLD);
    expect(exact.success && exact.data.id).toBe(OLD);
  });

  it('restoring the entry resolveBackup found asks no node for the listing again', async () => {
    containerOnWorker();
    nodes.on('*.meta.json', listing(metadata({ id: OLD, integrity: 'gzip' })), 'worker');
    const engine = backupEngine();
    const resolved = await engine.resolveBackup('db', OLD);
    if (!resolved.success) throw resolved.error;
    const listings = () => nodes.commands().filter((command) => command.includes('*.meta.json')).length;
    const before = listings();
    expect(before).toBeGreaterThan(0);

    expect((await engine.restore('db', resolved.data, POSTGRES)).success).toBe(true);
    expect(listings()).toBe(before);

    expect((await engine.restore('db', OLD, POSTGRES)).success).toBe(true);
    expect(listings()).toBeGreaterThan(before);
  });

  it('restoring a bare id that no node lists says so, and names the nodes that did not answer', async () => {
    nodes.on('*.meta.json', new Error('Timed out'), 'worker');
    const error = failure(await backupEngine().restore('db', OLD, POSTGRES));
    expect(error.message).toBe(`Backup ${OLD} not found`);
    expect((error as BackupError).suggestion).toBe('Bring agent_1 back and retry; backups stored there are not listed.');
  });
});

describe('Backup.backup order', () => {
  it('a new backup sorts after every stored one, also one taken by a machine whose clock was ahead', async () => {
    containerOnWorker();
    const ahead = Date.now() + 3_600_000;
    nodes.on(
      '*.meta.json',
      listing(metadata({ id: '20260101-100000-aaaa', timestamp: new Date(ahead).toISOString(), epochMs: ahead })),
      'manager',
    );
    const result = await backupEngine().backup('db', POSTGRES, 'gzip');
    if (!result.success) throw result.error;
    expect(result.data.epochMs).toBe(ahead + 1);
    expect(JSON.parse(nodes.calls.find((call) => call.via === 'channel')?.input ?? '').epochMs).toBe(ahead + 1);
  });

  it('a node that does not answer does not fail the backup', async () => {
    containerOnWorker();
    nodes.on('*.meta.json', new Error('Timed out'), 'manager');
    const result = await backupEngine().backup('db', POSTGRES, 'gzip');
    expect(result.success).toBe(true);
    expect(result.success && result.data.epochMs).toBeGreaterThan(0);
  });
});

describe('Backup without a container', () => {
  it('a service with no running container is a typed error for a backup and for a restore', async () => {
    nodes.on('docker ps', { stdout: '' });
    nodes.on('*.meta.json', listing(metadata({ id: POSTGRES_BACKUP })), 'worker');
    const backup = failure(await backupEngine().backup('db', POSTGRES, 'gzip'));
    expect(backup).toBeInstanceOf(BackupError);
    expect(backup.message).toBe('No running container found for service db');
    expect((backup as BackupError).code).toBe(ErrorCode.CONTAINER_NOT_FOUND);

    const restore = failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES));
    expect((restore as BackupError).code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe('Backup.prune', () => {
  const ORPHANS = '-mmin +1440';

  function entry(fields: Partial<BackupListEntry> & { id: string }): BackupListEntry {
    return { ...metadata({ id: fields.id }), filePath: '', node: 'server_1', ...fields };
  }

  it('removes the backups past retention on the node they were listed on, and counts what it freed', async () => {
    nodes.on(
      '*.meta.json',
      listing(
        metadata({ id: '20260103-000000-cccc', timestamp: '2026-01-03T00:00:00.000Z', sizeBytes: 300, nodeHost: 'manager' }),
        metadata({ id: '20260101-000000-aaaa', timestamp: '2026-01-01T00:00:00.000Z', sizeBytes: 100, nodeHost: 'manager' }),
      ),
      'manager',
    );
    nodes.on('*.meta.json', listing(metadata({ id: '20260102-000000-bbbb', timestamp: '2026-01-02T00:00:00.000Z', sizeBytes: 200 })), 'worker');
    nodes.on(ORPHANS, { stdout: `4096\t${DIR}/20251201-000000-dead.sql.gz\n` }, 'worker');

    const result = await backupEngine().prune('db', 1);
    expect(result.success && result.data).toEqual({ removed: 2, orphanFiles: 1, bytesFreed: 100 + 200 + 4096 });
    expect(nodes.commands('manager')).toContain(`rm -f -- '${DIR}/20260101-000000-aaaa.'*`);
    expect(nodes.commands('worker')).toContain(`rm -f -- '${DIR}/20260102-000000-bbbb.'*`);
    expect(nodes.commands().filter((command) => command.startsWith('rm -f'))).toHaveLength(2);
    expect(printed).toContainEqual({ level: 'info', message: 'Removed 1 orphaned backup file(s) (4.0 KB) left by interrupted backups' });
  });

  it('retention counts the backups as they were taken: the newest are kept whatever the timestamps say', async () => {
    const result = await backupEngine().prune('db', 1, {
      prefetched: [
        entry({ id: 'skewed', timestamp: '2026-12-01T00:00:00.000Z', epochMs: Date.parse('2026-01-01T00:00:00.000Z') }),
        entry({ id: 'newest', timestamp: '2026-02-01T00:00:00.000Z', epochMs: Date.parse('2026-02-01T00:00:00.000Z') }),
      ],
    });
    expect(result.success && result.data.removed).toBe(1);
    expect(nodes.commands('manager')).toEqual(expect.arrayContaining([`rm -f -- '${DIR}/skewed.'*`]));
  });

  it('prefetched entries skip the listing; --node narrows the orphan sweep', async () => {
    const result = await backupEngine().prune('db', 5, { node: 'agent_1', prefetched: [] });
    expect(result.success && result.data).toEqual({ removed: 0, orphanFiles: 0, bytesFreed: 0 });
    expect(nodes.calls.map((call) => call.host)).toEqual(['worker']);
    expect(nodes.commands()[0]).toContain(ORPHANS);
    expect(printed.filter((line) => line.level === 'info')).toEqual([]);
  });

  it('an unknown --node is a validation error naming the servers', async () => {
    expect(failure(await backupEngine().prune('db', 5, { node: 'nope' })).message).toContain('Server nope is not a server');
  });

  it('a backup whose name could escape the backup directory prunes nothing', async () => {
    const error = failure(
      await backupEngine().prune('db', 0, {
        prefetched: [entry({ id: '20260101-000000-aaaa' }), entry({ id: '../../etc', timestamp: '2025-01-01T00:00:00.000Z' })],
      }),
    );
    expect(error.message).toBe('Backup "../../etc" of "db" has an unusable name; nothing was pruned');
    expect(nodes.commands().filter((command) => command.startsWith('rm'))).toEqual([]);
  });

  it('a removal that fails is an error naming the node, not a count', async () => {
    nodes.on('rm -f', { exitCode: 1, stderr: 'rm: cannot remove: Permission denied\n' });
    const error = failure(await backupEngine().prune('db', 0, { prefetched: [entry({ id: '20260101-000000-aaaa' })] }));
    expect(error.message).toBe('Cannot remove backups on server_1: rm: cannot remove: Permission denied');
  });

  it('a backup stored on a server that is not one of the environment is an error, not the manager', async () => {
    const error = failure(
      await backupEngine().prune('db', 0, {
        prefetched: [entry({ id: '20260101-000000-aaaa', node: 'gone', nodeHost: 'old-host' })],
      }),
    );
    expect(error.message).toContain('is stored on old-host:22, which is not a server of this environment');
    expect(nodes.commands().filter((command) => command.startsWith('rm'))).toEqual([]);
  });

  describe.if(hasPosixShell)('orphan sweep executed by a real sh', () => {
    const root = mkdtempSync(join(tmpdir(), 'dockflow-backup-engine-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('an orphan older than 24 h is removed, a younger one and files with metadata are kept', async () => {
      const dir = join(root, STACK, 'db');
      mkdirSync(dir, { recursive: true });
      const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3600_000);
      const files: [string, number, number][] = [
        ['20250101-000000-aaaa.sql.gz', 1000, 25],
        ['20250101-000000-bbbb.sql.gz', 2000, 1],
        ['20250101-000000-cccc.sql.gz', 3000, 48],
        ['20250101-000000-cccc.meta.json', 10, 48],
        ['20250101-000000-dddd.data.tar.gz', 500, 30],
        ['20250101-000000-dddd.data.tar.gz.rc', 2, 30],
      ];
      for (const [name, size, age] of files) {
        writeFileSync(join(dir, name), 'x'.repeat(size));
        utimesSync(join(dir, name), hoursAgo(age), hoursAgo(age));
      }

      nodes.on(ORPHANS, (command) => {
        const proc = Bun.spawnSync(['sh', '-c', command.replaceAll('/var/lib/dockflow/backups', root)]);
        return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
      });

      const engine = new Backup(MANAGER, STACK, []);
      const result = await engine.prune('db', 10);
      expect(result.success && result.data).toEqual({ removed: 0, orphanFiles: 3, bytesFreed: 1000 + 500 + 2 });
      expect(readdirSync(dir).sort()).toEqual([
        '20250101-000000-bbbb.sql.gz',
        '20250101-000000-cccc.meta.json',
        '20250101-000000-cccc.sql.gz',
      ]);
    });

    it('the removal pattern takes every file of the backup and nothing of another', async () => {
      const dir = join(root, STACK, 'other');
      mkdirSync(dir, { recursive: true });
      for (const name of [
        '20250202-000000-aaaa.data.tar.gz',
        '20250202-000000-aaaa.uploads.tar.gz',
        '20250202-000000-aaaa.meta.json',
        '20250202-000000-aaaa.sql.gz.rc',
        '20250202-000000-aaab.meta.json',
      ]) {
        writeFileSync(join(dir, name), 'x');
      }
      nodes.on('rm -f', (command) => {
        const proc = Bun.spawnSync(['sh', '-c', command.replaceAll('/var/lib/dockflow/backups', root)]);
        return { exitCode: proc.exitCode ?? 1, stdout: '', stderr: proc.stderr.toString() };
      });
      const result = await new Backup(MANAGER, STACK, []).prune('other', 0, {
        prefetched: [entry({ id: '20250202-000000-aaaa', service: 'other', dbType: 'volume', node: 'manager', nodeHost: 'manager' })],
      });
      expect(result.success).toBe(true);
      expect(readdirSync(dir)).toEqual(['20250202-000000-aaab.meta.json']);
    });
  });
});

// ---------------------------------------------------------------------------
// restore when the container is not on the node holding the backup
// ---------------------------------------------------------------------------

describe('Backup.restore relay', () => {
  /** the backup is on the worker, the container now runs on the manager */
  function containerMoved(): void {
    nodes.on('docker ps', { stdout: 'c9\n' }, 'manager');
    nodes.on('docker ps', { stdout: '' }, 'worker');
    backupOnWorker({ integrity: 'gzip' });
  }

  it('streams the file from the node holding it into the container on its node, without buffering it here', async () => {
    containerMoved();
    nodes.on((command) => command.startsWith('gunzip -c'), { stdout: 'DUMP-BYTES' });
    const result = await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    expect(result.success).toBe(true);

    const source = nodes.calls.find((call) => call.via === 'stream' && call.command.startsWith('gunzip -c'));
    const sink = nodes.calls.find((call) => call.via === 'stream' && call.command.includes('docker exec -i'));
    expect(source?.host).toBe('worker');
    expect(source?.command).toBe(`gunzip -c '${DIR}/${POSTGRES_BACKUP}.sql.gz'`);
    expect(sink?.host).toBe('manager');
    expect(sink?.command).toContain("docker exec -i 'c9' sh -c");
    expect(sink?.input).toBe('DUMP-BYTES');
    expect(nodes.calls.some((call) => call.via === 'exec' && call.command.includes('docker exec -i'))).toBe(false);
  });

  it('the file is verified on the node holding it, not on the container node', async () => {
    containerMoved();
    await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    const check = nodes.calls.find((call) => call.command.endsWith('\necho OK'));
    expect(check?.host).toBe('worker');
  });

  it('an uncompressed file is read with cat', async () => {
    containerMoved();
    backupOnWorker({ compression: 'none' });
    await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES);
    expect(nodes.calls.some((call) => call.via === 'stream' && call.command === `cat '${DIR}/${POSTGRES_BACKUP}.sql'`)).toBe(true);
  });

  it('the stderr and exit status of the restore are those of the container side', async () => {
    containerMoved();
    nodes.on('docker exec -i', { exitCode: 3, stderr: 'psql: FATAL: password authentication failed\n' });
    expect(failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES)).message).toBe(
      'Restore failed: psql: FATAL: password authentication failed',
    );
  });

  it('a redis appendonly refusal is recognised through the relay too', async () => {
    containerMoved();
    nodes.on('*.meta.json', listing(metadata({ id: POSTGRES_BACKUP, dbType: 'redis' })), 'worker');
    nodes.on('docker exec -i', { exitCode: 3, stderr: 'DOCKFLOW_REFUSED: redis-appendonly\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, { type: 'redis' }));
    expect(error.message).toContain('has appendonly enabled');
    expect(pauses).toEqual([]);
  });

  it('a file that cannot be read is reported as such, not as a restore that succeeded', async () => {
    containerMoved();
    nodes.on((command) => command.startsWith('gunzip -c'), { exitCode: 1, stderr: 'gzip: stdin: unexpected end of file\n' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES));
    expect(error.message).toBe(`Cannot read backup file ${DIR}/${POSTGRES_BACKUP}.sql.gz on agent_1: gzip: stdin: unexpected end of file`);
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);
  });
});

// ---------------------------------------------------------------------------
// volume restore
// ---------------------------------------------------------------------------

describe('Backup.restore of volumes', () => {
  const VOLUMES = [
    { name: 'data', sizeBytes: 1, mountType: 'volume' as const, sourcePath: `${STACK}_data` },
    { name: 'uploads', sizeBytes: 1, mountType: 'bind' as const, sourcePath: '/srv/uploads' },
  ];
  const helper = (command: string): boolean => command.includes('docker run --rm');

  function volumeBackup(volumes = VOLUMES): void {
    const meta = metadata({ id: POSTGRES_BACKUP, dbType: 'volume', integrity: 'tar', volumes });
    nodes.on('*.meta.json', listing(meta), 'worker');
    nodes.on(`cat '${DIR}/${POSTGRES_BACKUP}.meta.json'`, { stdout: JSON.stringify(meta) });
    nodes.on('docker volume ls', { stdout: `other\n${STACK}_data\n` });
    nodes.on('test -d', { exitCode: 0 });
  }

  const restore = (): ReturnType<Backup['restore']> => backupEngine().restore('db', POSTGRES_BACKUP, VOLUME);

  it('verifies, then extracts every archive beside the data, and swaps only after all of them', async () => {
    volumeBackup();
    expect((await restore()).success).toBe(true);

    const kinds = nodes.commands('worker').flatMap((command) => {
      if (command.includes('.dockflow-restore-') && command.includes('tar xf - -C')) return ['extract'];
      if (command.includes('.dockflow-old-')) return ['swap'];
      if (command.endsWith('\necho OK')) return ['verify'];
      return [];
    });
    expect(kinds).toEqual(['verify', 'verify', 'extract', 'extract', 'swap', 'swap']);
    expect(nodes.commands().some((command) => /find .*-delete|rm -rf \/backup-target|\/backup-target/.test(command))).toBe(false);
  });

  it('feeds each archive to a root helper container: the volume by name, the bind mount by path', async () => {
    volumeBackup();
    await restore();
    const extracts = nodes.commands('worker').filter((command) => command.includes('tar xf - -C'));
    expect(extracts[0]).toMatch(new RegExp(`^gunzip -c '${DIR}/${POSTGRES_BACKUP}.data.tar.gz' \\| docker run --rm -i -v '${STACK}_data':/dockflow/v0 alpine sh -c `));
    expect(extracts[1]).toMatch(new RegExp(`^gunzip -c '${DIR}/${POSTGRES_BACKUP}.uploads.tar.gz' \\| docker run --rm -i -v '/srv/uploads':/dockflow/v0 alpine sh -c `));
  });

  it('an uncompressed archive is read with cat', async () => {
    volumeBackup();
    nodes.on('*.meta.json', listing(metadata({ id: POSTGRES_BACKUP, dbType: 'volume', compression: 'none', integrity: 'tar', volumes: VOLUMES })), 'worker');
    await backupEngine().restore('db', POSTGRES_BACKUP, VOLUME);
    expect(nodes.commands('worker').some((command) => command.startsWith(`cat '${DIR}/${POSTGRES_BACKUP}.data.tar' | docker run`))).toBe(true);
  });

  it('an extraction that fails on the second volume swaps nothing, cleans both, and says nothing changed', async () => {
    volumeBackup();
    nodes.on((command) => command.includes('/srv/uploads') && command.includes('tar xf - -C'), { exitCode: 2, stderr: 'tar: invalid magic\n' });
    const error = failure(await restore());
    expect(error.message).toBe('Restore of db failed while extracting bind uploads: tar: invalid magic; nothing was changed');
    expect(nodes.commands().some((command) => command.includes('.dockflow-old-'))).toBe(false);
    const discards = nodes.commands('worker').filter((command) => helper(command) && !command.includes('tar xf') && command.includes('rm -rf "$d"/') && command.includes('.dockflow-restore-'));
    expect(discards).toHaveLength(2);
  });

  it('a full disk during extraction names the node and keeps the data', async () => {
    volumeBackup();
    nodes.on((command) => command.includes('tar xf - -C'), { exitCode: 1, stderr: 'tar: x: Cannot write: No space left on device\n' });
    const error = failure(await restore());
    expect(error.message).toBe('Restore of db needs room for a second copy of volume data on agent_1; nothing was changed');
    expect((error as BackupError).suggestion).toContain('Free disk space on agent_1');
    expect(nodes.commands().some((command) => command.includes('.dockflow-old-'))).toBe(false);
  });

  it('a swap that fails names where the previous contents are', async () => {
    volumeBackup();
    nodes.on((command) => command.includes('.dockflow-old-') && command.includes("'/srv/uploads'"), { exitCode: 1, stderr: 'mv: cannot move\n' });
    const error = failure(await restore());
    expect(error.message).toMatch(/^Restore of db failed while swapping bind uploads: mv: cannot move; the previous contents are in uploads\/\.dockflow-old-[0-9a-f]{8}$/);
  });

  it('a volume that no longer exists is refused before anything runs, instead of being created empty', async () => {
    volumeBackup();
    nodes.on('docker volume ls', { stdout: 'other\n' });
    const error = failure(await restore());
    expect(error.message).toBe(`Volume ${STACK}_data of service db does not exist on agent_1; nothing was restored`);
    expect(nodes.commands().some(helper)).toBe(false);
  });

  it('a volume is found under its recorded name, then the stack-prefixed one, then the short one, labelled or not', async () => {
    volumeBackup();
    nodes.on('docker volume ls', { stdout: `${STACK}_data\n` });
    expect((await restore()).success).toBe(true);

    nodes.calls.length = 0;
    volumeBackup([{ ...VOLUMES[0], sourcePath: 'renamed' }, VOLUMES[1]]);
    nodes.on('docker volume ls', { stdout: `${STACK}_data\n` });
    expect((await restore()).success).toBe(true);
    expect(nodes.commands('worker').some((command) => command.includes(`-v '${STACK}_data':/dockflow/v0`))).toBe(true);

    nodes.calls.length = 0;
    nodes.on('docker volume ls', { stdout: 'data\n' });
    expect((await restore()).success).toBe(true);
    expect(nodes.commands('worker').some((command) => command.includes("-v 'data':/dockflow/v0"))).toBe(true);
  });

  it('a bind mount whose directory is gone is refused before anything runs', async () => {
    volumeBackup();
    nodes.on('test -d', { exitCode: 1 });
    const error = failure(await restore());
    expect(error.message).toBe('Bind mount /srv/uploads does not exist on agent_1; nothing was restored');
    expect(nodes.commands().some(helper)).toBe(false);
  });

  it('metadata that is missing the mount information is refused', async () => {
    volumeBackup([{ name: 'data', sizeBytes: 1, mountType: 'bind', sourcePath: '' }]);
    const error = failure(await restore());
    expect(error.message).toBe(`Backup metadata for ${POSTGRES_BACKUP} is missing mount information for "data"; refusing to restore`);
    volumeBackup([{ name: '../x', sizeBytes: 1, mountType: 'volume', sourcePath: 'v' }]);
    expect(failure(await restore()).message).toContain('missing mount information');
  });
});

describe('Backup.restore refusals', () => {
  it('a backup of another type than the configured one is refused before any node is touched', async () => {
    containerOnWorker();
    backupOnWorker({ dbType: 'mysql' });
    const error = failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(`Backup ${POSTGRES_BACKUP} is a mysql backup, but db is configured with type postgres`);
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);
    expect(nodes.commands().some((command) => command.includes('docker exec') || command.endsWith('\necho OK'))).toBe(false);
  });

  it('a volume backup is not streamed into a database, nor a dump into volumes', async () => {
    backupOnWorker({ dbType: 'volume' });
    expect(failure(await backupEngine().restore('db', POSTGRES_BACKUP, POSTGRES)).message).toContain('is a volume backup');
    backupOnWorker({ dbType: 'postgres' });
    expect(failure(await backupEngine().restore('db', POSTGRES_BACKUP, VOLUME)).message).toContain('is a postgres backup');
  });

  it('restoreTypeMismatch tells a match from a mismatch', () => {
    expect(restoreTypeMismatch({ id: 'x', dbType: 'redis' }, 'cache', { type: 'redis' })).toBeNull();
    expect(restoreTypeMismatch({ id: 'x', dbType: 'redis' }, 'cache', { type: 'raw' })?.message).toBe(
      'Backup x is a redis backup, but cache is configured with type raw',
    );
  });

  it('a backup recorded on a server that is not one of the environment is an error, not the manager', async () => {
    containerOnWorker();
    nodes.on('*.meta.json', listing(metadata({ id: POSTGRES_BACKUP })), 'worker');
    const listed = await backupEngine().list('db');
    if (!listed.success) throw listed.error;
    const stray = { ...listed.data.entries[0], node: 'gone', nodeHost: 'old-host' };
    const error = failure(await backupEngine().restore('db', stray, POSTGRES));
    expect(error.message).toBe(`Backup ${POSTGRES_BACKUP} is stored on old-host:22, which is not a server of this environment with SSH credentials`);
    expect((error as BackupError).code).toBe(ErrorCode.BACKUP_NOT_FOUND);
    expect(nodes.commands().some((command) => command.includes('docker exec'))).toBe(false);
  });
});

describe('Backup.replicaRefusal', () => {
  const HINT = 'Scale it to 1.';
  const inspect = (stdout: string, exitCode = 0) => nodes.on('docker service inspect', { stdout, exitCode });

  it('refuses a service that runs several replicas, naming the count and carrying the hint', async () => {
    inspect('2\n');
    const error = await backupEngine().replicaRefusal('db', HINT);
    expect(error).toBeInstanceOf(BackupError);
    expect(error?.message).toBe('db runs 2 replicas; a restore writes into one of them only');
    expect(error?.code).toBe(ErrorCode.RESTORE_FAILED);
    expect(error?.suggestion).toBe(HINT);
    expect(nodes.commands('manager')).toContain(
      `docker service inspect '${STACK}_db' --format '{{if .Spec.Mode.Global}}global{{else if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{end}}'`,
    );
  });

  it('lets a single replica through', async () => {
    inspect('1\n');
    expect(await backupEngine().replicaRefusal('db', HINT)).toBeNull();
  });

  it('lets a service scaled to zero through', async () => {
    inspect('0\n');
    expect(await backupEngine().replicaRefusal('db', HINT)).toBeNull();
  });

  it('refuses a global service on a multi-server environment, but not on a single server', async () => {
    inspect('global\n');
    expect((await backupEngine().replicaRefusal('db', HINT))?.message).toBe(
      'db runs on each of the 2 servers; a restore writes into one of them only',
    );
    const single = new Backup(MANAGER, STACK, [{ name: 'server_1', connection: MANAGER }]);
    expect(await single.replicaRefusal('db', HINT)).toBeNull();
  });

  it('does not refuse when the manager does not say what the service runs', async () => {
    inspect('', 1);
    expect(await backupEngine().replicaRefusal('db', HINT)).toBeNull();
    inspect('\n');
    expect(await backupEngine().replicaRefusal('db', HINT)).toBeNull();
  });
});
