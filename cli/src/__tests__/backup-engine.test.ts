// services/backup.ts over a recorded sshExec: every command the engine sends to a node is kept,
// and each node answers from rules. Nothing here opens a connection.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Writable } from 'stream';
import { Backup, type BackupMetadata } from '../services/backup';
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
  via: 'exec' | 'channel';
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

type ChannelHandle = Awaited<ReturnType<typeof ssh.sshExecChannel>>;

let nodes: FakeNodes;
let printed: { level: 'warning' | 'info' | 'debug'; message: string }[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  printed = [];
  nodes = new FakeNodes();
  // a verification script prints OK when the archive is sound
  nodes.on(/echo OK/, { stdout: 'OK\n' });
  spies = [
    spyOn(ssh, 'sshExec').mockImplementation(async (conn, command) => {
      nodes.calls.push({ host: conn.host, command, via: 'exec', input: '' });
      const reply = nodes.reply(conn.host, command);
      if (reply instanceof Error) throw reply;
      return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    }),
    spyOn(ssh, 'sshExecChannel').mockImplementation(async (conn, command) => {
      const call: NodeCall = { host: conn.host, command, via: 'channel', input: '' };
      nodes.calls.push(call);
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const done = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
        stream.on('finish', () => {
          call.input = Buffer.concat(chunks).toString();
          const reply = nodes.reply(conn.host, command);
          const result = reply instanceof Error ? { exitCode: 255, stderr: reply.message } : reply;
          resolve({ exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
        });
      });
      return { stream: stream as unknown as ChannelHandle['stream'], done };
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

function backupEngine(): Backup {
  return new Backup(MANAGER, STACK, [MANAGER, WORKER]);
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
    expect(listed.success && listed.data.map((entry) => entry.id)).toEqual(['20260501-100000-aaaa']);
  });
});
