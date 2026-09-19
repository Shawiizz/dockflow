// services/backup.ts over FakeOrchestrator (a Kubernetes and a Swarm bundle), and the Swarm
// BackupBackend, with node file operations answered by a recorded sshExec fake (design-06 10.2,
// 10.3). Nothing here opens a connection.

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';
import { assertSingleReplica, type BackupMetadata, createBackup } from '../services/backup';
import {
  buildCapturePipeline,
  buildDiscardScript,
  buildDumpScript,
  buildExtractScript,
  buildRestoreScript,
  buildSwapScript,
  buildVerifyScript,
} from '../services/backup-strategies';
import type { BackupFile, BackupVolume, ClusterNodeRef, ServiceInfo, StackRef } from '../services/orchestrator/interfaces';
import { SwarmBackupBackend } from '../services/orchestrator/swarm/swarm-backup';
import type { Result } from '../types/result';
import type { BackupAccessoryConfig } from '../utils/config';
import { BackupError, ErrorCode, UnsupportedOperationError, ValidationError } from '../utils/errors';
import { shortHash } from '../utils/hash';
import * as output from '../utils/output';
import * as ssh from '../utils/ssh';
import { FakeOrchestrator } from './kubernetes/fakes/fake-orchestrator';

// ---------------------------------------------------------------------------
// Recorded node shell
// ---------------------------------------------------------------------------

type Reply = { exitCode?: number; stdout?: string; stderr?: string } | Error;
type Matcher = string | RegExp | ((command: string) => boolean);

interface Rule {
  node: string | null;
  match: Matcher;
  reply: Reply | ((command: string) => Reply);
}

interface NodeCall {
  node: string;
  command: string;
  via: 'exec' | 'channel' | 'stream';
  /** bytes written to a channel's stdin */
  input: string;
}

const ALL_NODES = ['server_1', 'server_2', 'agent_1', 'agent_2'];

class FakeNodes {
  readonly calls: NodeCall[] = [];
  private readonly rules: Rule[] = [];

  constructor(private readonly names: Map<string, string>) {
    // every verification script ends by printing OK when the archive is sound
    this.on((command) => command.endsWith('\necho OK'), { stdout: 'OK\n' });
  }

  /** later rules win over earlier ones */
  on(match: Matcher, reply: Rule['reply'], node: string | null = null): this {
    this.rules.push({ node, match, reply });
    return this;
  }

  commands(node?: string): string[] {
    return this.calls.filter((call) => node === undefined || call.node === node).map((call) => call.command);
  }

  nodeOf(host: string): string {
    return this.names.get(host) ?? host;
  }

  reply(node: string, command: string): Reply {
    const rule = [...this.rules].reverse().find((candidate) => {
      if (candidate.node !== null && candidate.node !== node) return false;
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
type UnbufferedHandle = Awaited<ReturnType<typeof ssh.sshExecChannelUnbuffered>>;

let nodes: FakeNodes;
let printed: { level: 'warning' | 'info' | 'debug'; message: string }[] = [];
let spies: { mockRestore(): void }[] = [];

function installFakes(orchestrators: FakeOrchestrator[]): void {
  const names = new Map<string, string>();
  for (const orchestrator of orchestrators) {
    for (const node of [...orchestrator.target.managers, ...orchestrator.target.workers]) names.set(node.connection.host, node.name);
  }
  nodes = new FakeNodes(names);
}

beforeEach(() => {
  printed = [];
  spies = [
    spyOn(ssh, 'sshExec').mockImplementation(async (conn, command) => {
      const node = nodes.nodeOf(conn.host);
      nodes.calls.push({ node, command, via: 'exec', input: '' });
      const reply = nodes.reply(node, command);
      if (reply instanceof Error) throw reply;
      return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    }),
    spyOn(ssh, 'sshExecChannel').mockImplementation(async (conn, command) => {
      const node = nodes.nodeOf(conn.host);
      const call: NodeCall = { node, command, via: 'channel', input: '' };
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
          const reply = nodes.reply(node, command);
          const result = reply instanceof Error ? { exitCode: 255, stderr: reply.message } : reply;
          resolve({ exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
        });
      });
      return { stream: stream as unknown as ChannelHandle['stream'], done };
    }),
    spyOn(ssh, 'sshExecChannelUnbuffered').mockImplementation(async (conn, command) => {
      const node = nodes.nodeOf(conn.host);
      nodes.calls.push({ node, command, via: 'stream', input: '' });
      const reply = nodes.reply(node, command);
      const result = reply instanceof Error ? { exitCode: 255, stderr: reply.message } : reply;
      const stream = Object.assign(new PassThrough(), { stderr: new PassThrough() });
      const done = new Promise<{ exitCode: number }>((resolve) => {
        stream.on('end', () => resolve({ exitCode: result.exitCode ?? 0 }));
      });
      setImmediate(() => {
        stream.stderr.end(result.stderr ?? '');
        stream.end(result.stdout ?? '');
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

const ACCESSORY: StackRef = { project: 'shop', env: 'production', role: 'accessory' };
const APP: StackRef = { project: 'shop', env: 'production', role: 'app' };
const SCOPE = 'shop-production-accessories';
const DIR = `/var/lib/dockflow/backups/${SCOPE}/db`;
const SEPARATOR = '---DOCKFLOW_META_SEP---';
const LIST = "-name '*.meta.json'";

function host(orchestrator: FakeOrchestrator, name: string): ClusterNodeRef {
  const node = [...orchestrator.target.managers, ...orchestrator.target.workers].find((candidate) => candidate.name === name);
  if (!node) throw new Error(`no node ${name}`);
  return node;
}

function meta(orchestrator: FakeOrchestrator, fields: Partial<BackupMetadata> & { id: string }, on = 'server_1'): BackupMetadata {
  const node = host(orchestrator, on);
  return {
    service: 'db',
    dbType: 'postgres',
    timestamp: '2026-01-02T10:00:00.000Z',
    size: '2 KB',
    sizeBytes: 2048,
    compression: 'gzip',
    durationMs: 10,
    stackName: SCOPE,
    nodeHost: node.connection.host,
    nodePort: node.connection.port,
    ...fields,
  };
}

function listing(...metas: BackupMetadata[]): { stdout: string } {
  return { stdout: metas.map((m) => `${SEPARATOR}\n${JSON.stringify(m, null, 2)}\n`).join('') };
}

function service(name: string, desired: number, role: ServiceInfo['role'] = 'accessory'): ServiceInfo {
  return {
    name,
    nativeName: name,
    kind: 'service',
    role,
    mode: 'replicated',
    image: 'postgres:17',
    replicas: { running: desired, desired },
    ports: [],
    state: 'running',
  };
}

function fake(kind: 'k3s' | 'swarm'): FakeOrchestrator {
  const orchestrator = new FakeOrchestrator(kind);
  installFakes([orchestrator]);
  return orchestrator;
}

const POSTGRES: BackupAccessoryConfig = { type: 'postgres' };
const REDIS: BackupAccessoryConfig = { type: 'redis' };
const VOLUME: BackupAccessoryConfig = { type: 'volume' };

function failure(result: Result<unknown, Error>): Error {
  if (result.success) throw new Error('expected a failure');
  return result.error;
}

// ---------------------------------------------------------------------------
// backup create
// ---------------------------------------------------------------------------

describe('Backup.backup', () => {
  it('dumps with the in-container script, verifies on the node holding the file, then writes 0600 metadata', async () => {
    const k3s = fake('k3s');
    nodes.on('stat -c %s', { stdout: '2048\n' });
    const result = await createBackup(k3s, ACCESSORY).backup('db', POSTGRES, 'gzip');
    expect(result.success).toBe(true);
    if (!result.success) return;
    const metadata = result.data;
    const path = `${DIR}/${metadata.id}.sql.gz`;

    expect(k3s.callsTo('backups.dump')).toEqual([[ACCESSORY, { service: 'db' }, buildDumpScript(POSTGRES, 'gzip'), path, { gzip: true }]]);
    expect(nodes.calls.map((call) => [call.node, call.via, call.command])).toEqual([
      ['server_1', 'exec', buildVerifyScript(path, 'gzip', 'gzip')],
      ['server_1', 'exec', `stat -c %s '${path}' 2>/dev/null || echo 0`],
      ['server_1', 'channel', `umask 077 && cat > '${DIR}/${metadata.id}.meta.json'`],
    ]);
    expect(JSON.parse(nodes.calls[2].input)).toEqual(metadata);
    expect(metadata).toMatchObject({
      service: 'db',
      dbType: 'postgres',
      compression: 'gzip',
      sizeBytes: 2048,
      stackName: SCOPE,
      nodeHost: '192.0.2.10',
      nodePort: 22,
      orchestrator: 'k3s',
      role: 'accessory',
    });
    expect(metadata.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(printed.filter((line) => line.level === 'warning')).toEqual([]);
  });

  it('a dump failing its verification is removed and reported, and no metadata is written', async () => {
    const k3s = fake('k3s');
    nodes.on('gunzip -t', { exitCode: 1, stdout: 'the gzip stream is corrupt or truncated\n' });
    const error = failure(await createBackup(k3s, ACCESSORY).backup('db', POSTGRES, 'gzip'));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('Backup verification failed: the gzip stream is corrupt or truncated');
    const path = (k3s.callsTo('backups.dump')[0] as unknown[])[3] as string;
    expect(nodes.commands()).toEqual([buildVerifyScript(path, 'gzip', 'gzip'), `rm -f -- '${path}'`]);
  });

  it('a plain-text postgres dump without compression is verified by its trailer', async () => {
    const k3s = fake('k3s');
    const result = await createBackup(k3s, ACCESSORY).backup('db', POSTGRES, 'none');
    expect(result.success).toBe(true);
    const path = (k3s.callsTo('backups.dump')[0] as unknown[])[3] as string;
    expect(path.endsWith('.sql')).toBe(true);
    expect((k3s.callsTo('backups.dump')[0] as unknown[])[2]).toBe(buildDumpScript(POSTGRES, 'none'));
    expect(nodes.commands()[0]).toBe(buildVerifyScript(path, 'none', 'trailer'));
  });

  it('an opaque combination is created with the basic check and a warning', async () => {
    const swarm = fake('swarm');
    const result = await createBackup(swarm, ACCESSORY).backup('cache', REDIS, 'none');
    expect(result.success).toBe(true);
    if (!result.success) return;
    const path = `/var/lib/dockflow/backups/${SCOPE}/cache/${result.data.id}.rdb`;
    expect(nodes.commands()[0]).toBe(buildVerifyScript(path, 'none', 'opaque'));
    expect(printed).toContainEqual({
      level: 'warning',
      message: `Backup ${result.data.id} of cache cannot be verified before a restore because it is not compressed; set compression: gzip for this service`,
    });
    expect(result.data.orchestrator).toBe('swarm');
  });

  it('volume backup: archives under the id prefix, every archive verified, per-volume metadata', async () => {
    const k3s = fake('k3s');
    const volumes: BackupVolume[] = [
      { name: 'db-data', kind: 'volume', source: 'db-data', mountPath: '/var/lib/postgresql/data', node: 'server_1' },
      { name: 'srv-uploads', kind: 'bind', source: '/srv/uploads', mountPath: '/srv/uploads', node: 'agent_1' },
    ];
    k3s.program('backups.volumes', volumes);
    nodes.on('stat -c %s', (command) => ({ stdout: command.includes('db-data') ? '100\n' : '50\n' }));
    const config: BackupAccessoryConfig = { type: 'volume', exclude_volumes: ['cache*'], include_bind_mounts: true };
    const result = await createBackup(k3s, ACCESSORY).backup('db', config, 'gzip');
    expect(result.success).toBe(true);
    if (!result.success) return;
    const prefix = `${DIR}/${result.data.id}`;

    expect(k3s.callsTo('backups.volumes')).toEqual([[ACCESSORY, 'db', { includeBindMounts: true, exclude: ['cache*'] }]]);
    expect(k3s.callsTo('backups.archiveVolumes')).toEqual([[ACCESSORY, 'db', volumes, prefix, { gzip: true }]]);
    expect(nodes.commands().slice(0, 2)).toEqual([
      buildVerifyScript(`${prefix}.db-data.tar.gz`, 'gzip', 'tar'),
      buildVerifyScript(`${prefix}.srv-uploads.tar.gz`, 'gzip', 'tar'),
    ]);
    expect(result.data.sizeBytes).toBe(150);
    expect(result.data.volumes).toEqual([
      { name: 'db-data', sizeBytes: 100, mountType: 'volume', sourcePath: 'db-data', mountPath: '/var/lib/postgresql/data', node: 'server_1' },
      { name: 'srv-uploads', sizeBytes: 50, mountType: 'bind', sourcePath: '/srv/uploads', mountPath: '/srv/uploads', node: 'agent_1' },
    ]);
    expect(JSON.parse(nodes.calls.find((call) => call.via === 'channel')?.input ?? '{}')).toEqual(result.data);
  });

  it('volume backup: one bad archive removes them all', async () => {
    const k3s = fake('k3s');
    k3s.program('backups.volumes', [
      { name: 'a', kind: 'volume', source: 'a', mountPath: '/a', node: null },
      { name: 'b', kind: 'bind', source: '/srv/b', mountPath: '/b', node: null },
    ]);
    nodes.on((command) => command.includes('.b.tar.gz') && command.includes('tar tf'), { exitCode: 1, stdout: 'the archive has no entries\n' });
    const error = failure(await createBackup(k3s, ACCESSORY).backup('db', VOLUME, 'gzip'));
    expect(error.message).toBe('Backup failed for bind /srv/b: the archive has no entries');
    const prefix = (k3s.callsTo('backups.archiveVolumes')[0] as unknown[])[3] as string;
    expect(nodes.commands().at(-1)).toBe(`rm -f -- '${prefix}.a.tar.gz' '${prefix}.b.tar.gz'`);
    expect(nodes.calls.some((call) => call.via === 'channel')).toBe(false);
  });

  it('a service without volumes keeps today text', async () => {
    const k3s = fake('k3s');
    const error = failure(await createBackup(k3s, ACCESSORY).backup('db', VOLUME, 'gzip'));
    expect(error.message).toBe('No volumes or bind mounts found for service db');
    expect(k3s.callsTo('backups.archiveVolumes')).toEqual([]);
  });

  it('the app role writes under the stack name', async () => {
    const k3s = fake('k3s');
    const result = await createBackup(k3s, APP).backup('web', POSTGRES, 'gzip');
    expect(result.success).toBe(true);
    const path = (k3s.callsTo('backups.dump')[0] as unknown[])[3] as string;
    expect(path.startsWith('/var/lib/dockflow/backups/shop-production/web/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// restore: verification before destruction (K23)
// ---------------------------------------------------------------------------

describe('Backup.restore verifies before anything is destroyed', () => {
  const ID = '20260102-100000-a1b2';

  it('gzip dump: the check runs on the node holding the file before the backend restore', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID })), 'server_1');
    let commandsBeforeRestore: string[] = [];
    k3s.program('backups.restore', () => {
      commandsBeforeRestore = nodes.commands();
      return { exitCode: 0, stderr: '' };
    });
    const result = await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false });
    expect(result.success).toBe(true);
    const path = `${DIR}/${ID}.sql.gz`;
    expect(commandsBeforeRestore).toContain(buildVerifyScript(path, 'gzip', 'gzip'));
    expect(k3s.callsTo('backups.restore')).toEqual([
      [ACCESSORY, { service: 'db' }, buildRestoreScript(POSTGRES), { node: host(k3s, 'server_1'), remotePath: path }, { gunzip: true }],
    ]);
    expect(k3s.callsTo('backups.restartAfterRestore')).toEqual([]);
  });

  it('a failing verification means the backend is never called', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID })), 'server_1');
    nodes.on('gunzip -t', { exitCode: 1, stdout: 'the gzip stream is corrupt or truncated\n' });
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false }));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);
    expect(error.message).toBe(`Backup ${ID} cannot be restored: the gzip stream is corrupt or truncated`);
    expect(k3s.callsTo('backups.restore')).toEqual([]);
    expect(k3s.callsTo('backups.restoreVolumes')).toEqual([]);
  });

  it('an opaque backup is refused without --force-unverified, before any check or backend call', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID, service: 'cache', dbType: 'redis', compression: 'none' })), 'server_1');
    const error = failure(await createBackup(k3s, ACCESSORY).restore('cache', ID, REDIS, undefined, { forceUnverified: false }));
    expect(error.message).toBe(`Backup ${ID} has no integrity data and cannot be verified before it replaces cache's data`);
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);
    expect((error as BackupError).suggestion).toBe(
      'Check the file yourself and re-run with `--force-unverified`, or take a new backup with `compression: gzip`.',
    );
    expect(nodes.commands().filter((command) => command.endsWith('\necho OK'))).toEqual([]);
    expect(k3s.callsTo('backups.restore')).toEqual([]);
  });

  it('with --force-unverified the basic check runs, the warning is printed and the backend is called', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID, service: 'cache', dbType: 'redis', compression: 'none' })), 'server_1');
    const result = await createBackup(k3s, ACCESSORY).restore('cache', ID, REDIS, undefined, { forceUnverified: true });
    expect(result.success).toBe(true);
    const path = `/var/lib/dockflow/backups/${SCOPE}/cache/${ID}.rdb`;
    expect(nodes.commands()).toContain(buildVerifyScript(path, 'none', 'opaque'));
    expect(printed).toContainEqual({ level: 'warning', message: `Restoring ${ID} without verifying it` });
    expect(k3s.callsTo('backups.restore')).toHaveLength(1);
    // the dump ran into a redis that restarts: the backend's restart follows
    expect(k3s.callsTo('backups.restartAfterRestore')).toEqual([[ACCESSORY, 'cache']]);
  });

  it('a text dump without its trailer fails closed; --force-unverified relaxes only that check', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID, compression: 'none' })), 'server_1');
    nodes.on('DOCKFLOW_DUMP_END', { exitCode: 1, stdout: 'the dump has no integrity marker\n' });
    const path = `${DIR}/${ID}.sql`;

    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false }));
    expect(error.message).toBe(`Backup ${ID} cannot be restored: the dump has no integrity marker`);
    expect((error as BackupError).suggestion).toContain('--force-unverified');
    expect(nodes.commands()).toContain(buildVerifyScript(path, 'none', 'trailer'));
    expect(k3s.callsTo('backups.restore')).toEqual([]);

    const forced = await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: true });
    expect(forced.success).toBe(true);
    expect(nodes.commands()).toContain(buildVerifyScript(path, 'none', 'opaque'));
    expect(k3s.callsTo('backups.restore')).toHaveLength(1);
  });

  it('--force-unverified never skips the gzip check', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID })), 'server_1');
    nodes.on('gunzip -t', { exitCode: 1, stdout: 'the gzip stream is corrupt or truncated\n' });
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: true }));
    expect(error.message).toBe(`Backup ${ID} cannot be restored: the gzip stream is corrupt or truncated`);
    expect(printed.filter((line) => line.level === 'warning')).toEqual([]);
    expect(k3s.callsTo('backups.restore')).toEqual([]);
  });

  it('volume restore: every archive verified before restoreVolumes, archives mapped from the metadata', async () => {
    const k3s = fake('k3s');
    const volumeMeta = meta(k3s, {
      id: ID,
      dbType: 'volume',
      volumes: [
        { name: 'db-data', sizeBytes: 1, mountType: 'volume', sourcePath: 'db-data', mountPath: '/var/lib/postgresql/data', node: 'server_1' },
        { name: 'uploads', sizeBytes: 1, mountType: 'bind', sourcePath: '/srv/uploads' },
      ],
    });
    nodes.on(LIST, listing(volumeMeta), 'server_1');
    nodes.on(`cat '${DIR}/${ID}.meta.json'`, { stdout: JSON.stringify(volumeMeta) });
    let commandsBefore: string[] = [];
    k3s.program('backups.restoreVolumes', () => {
      commandsBefore = nodes.commands();
    });
    const result = await createBackup(k3s, ACCESSORY).restore('db', ID, VOLUME, undefined, { forceUnverified: false });
    expect(result.success).toBe(true);
    const server = host(k3s, 'server_1');
    expect(commandsBefore).toContain(buildVerifyScript(`${DIR}/${ID}.db-data.tar.gz`, 'gzip', 'tar'));
    expect(commandsBefore).toContain(buildVerifyScript(`${DIR}/${ID}.uploads.tar.gz`, 'gzip', 'tar'));
    expect(k3s.callsTo('backups.restoreVolumes')).toEqual([
      [
        ACCESSORY,
        'db',
        [
          {
            volume: { name: 'db-data', kind: 'volume', source: 'db-data', mountPath: '/var/lib/postgresql/data', node: 'server_1' },
            file: { node: server, remotePath: `${DIR}/${ID}.db-data.tar.gz` },
          },
          {
            volume: { name: 'uploads', kind: 'bind', source: '/srv/uploads', mountPath: '', node: null },
            file: { node: server, remotePath: `${DIR}/${ID}.uploads.tar.gz` },
          },
        ],
      ],
    ]);
  });

  it('volume restore: a bad second archive means restoreVolumes is never called', async () => {
    const k3s = fake('k3s');
    const volumeMeta = meta(k3s, {
      id: ID,
      dbType: 'volume',
      compression: 'none',
      volumes: [
        { name: 'a', sizeBytes: 1, mountType: 'volume', sourcePath: 'a' },
        { name: 'b', sizeBytes: 1, mountType: 'volume', sourcePath: 'b' },
      ],
    });
    nodes.on(LIST, listing(volumeMeta), 'server_1');
    nodes.on(`cat '${DIR}/${ID}.meta.json'`, { stdout: JSON.stringify(volumeMeta) });
    nodes.on((command) => command.includes(`${ID}.b.tar'`) && command.includes('tar tf'), {
      exitCode: 1,
      stdout: 'the archive has no end-of-archive marker (truncated)\n',
    });
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, VOLUME, undefined, { forceUnverified: false }));
    expect(error.message).toBe(`Backup ${ID} cannot be restored: the archive has no end-of-archive marker (truncated) (volume b)`);
    expect(k3s.callsTo('backups.restoreVolumes')).toEqual([]);
  });

  it('volume metadata without mount information is refused', async () => {
    const k3s = fake('k3s');
    const volumeMeta = meta(k3s, {
      id: ID,
      dbType: 'volume',
      volumes: [{ name: 'uploads', sizeBytes: 1, mountType: 'bind', sourcePath: '' }],
    });
    nodes.on(LIST, listing(volumeMeta), 'server_1');
    nodes.on(`cat '${DIR}/${ID}.meta.json'`, { stdout: JSON.stringify(volumeMeta) });
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, VOLUME, undefined, { forceUnverified: false }));
    expect(error.message).toBe(`Backup metadata for ${ID} is missing mount information for "uploads"; refusing to restore`);
    expect(k3s.callsTo('backups.restoreVolumes')).toEqual([]);
  });

  it('a backup of another type than the configuration is refused', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID, dbType: 'mysql' })), 'server_1');
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false }));
    expect(error.message).toBe(`Backup ${ID} is a mysql backup, but db is configured with type postgres`);
    expect(k3s.callsTo('backups.restore')).toEqual([]);
  });

  it('a backup recorded on a host that is not a server of the environment is an error, not the manager', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing({ ...meta(k3s, { id: ID }), nodeHost: '203.0.113.99' }), 'server_1');
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false }));
    expect(error.message).toBe(`Backup ${ID} is stored on 203.0.113.99:22, which is not a server of production with SSH credentials`);
    expect(k3s.callsTo('backups.restore')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R-23 (K24)
// ---------------------------------------------------------------------------

describe('R-23 multi-replica refusal', () => {
  it('Backup.restore refuses desired: 2 itself, before any verification or backend call', async () => {
    for (const kind of ['k3s', 'swarm'] as const) {
      const orchestrator = fake(kind);
      orchestrator.program('stack.getServices', [service('db', 2)]);
      const error = failure(
        await createBackup(orchestrator, ACCESSORY).restore('db', '20260102-100000-a1b2', POSTGRES, undefined, { forceUnverified: false }),
      );
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect(error.message).toBe('Service db runs 2 replicas; dockflow backup restore writes one replica only');
      expect((error as UnsupportedOperationError).suggestion).toBe(
        'Set `deploy.replicas: 1` for db in accessories.yml and run `dockflow deploy production --accessories` first, restore, then set it back.',
      );
      expect(orchestrator.events).toEqual(['stack.getServices:accessory']);
      expect(nodes.calls).toEqual([]);
    }
  });

  it('desired: 1 passes', async () => {
    const k3s = fake('k3s');
    k3s.program('stack.getServices', [service('db', 1)]);
    nodes.on(LIST, listing(meta(k3s, { id: '20260102-100000-a1b2' })), 'server_1');
    const result = await createBackup(k3s, ACCESSORY).restore('db', '20260102-100000-a1b2', POSTGRES, undefined, { forceUnverified: false });
    expect(result.success).toBe(true);
    expect(k3s.callsTo('backups.restore')).toHaveLength(1);
  });

  it('assertSingleReplica: the app suggestion scales, the accessory one edits accessories.yml', () => {
    expect(() => assertSingleReplica(service('web', 3, 'app'), 'staging')).toThrow(
      new UnsupportedOperationError('Service web runs 3 replicas; dockflow backup restore writes one replica only'),
    );
    try {
      assertSingleReplica(service('web', 3, 'app'), 'staging');
    } catch (error) {
      expect((error as UnsupportedOperationError).suggestion).toBe(
        'Scale it to 1 first with `dockflow scale staging web 1`, restore, then scale it back.',
      );
      expect((error as UnsupportedOperationError).code).toBe(ErrorCode.UNSUPPORTED_OPERATION);
    }
    expect(() => assertSingleReplica(service('web', 1, 'app'), 'staging')).not.toThrow();
    expect(() => assertSingleReplica(service('web', 0, 'app'), 'staging')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R-17 on both orchestrators (K62c, S-13)
// ---------------------------------------------------------------------------

describe('R-17 redis appendonly refusal', () => {
  const ID = '20260102-100000-a1b2';
  const R17 = 'Redis in service cache has appendonly enabled; a restored dump.rdb would be ignored at startup, so nothing was changed';

  function expectR17(error: Error): void {
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe(R17);
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);
    expect((error as BackupError).suggestion).toBe('Back up and restore this service with `type: volume`.');
    for (const text of [error.message, (error as BackupError).suggestion ?? '', ...printed.map((line) => line.message)]) {
      expect(text).not.toContain('DOCKFLOW_REFUSED');
    }
  }

  it('Kubernetes bundle: the backend outcome carries the marker', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID, service: 'cache', dbType: 'redis' })), 'server_1');
    k3s.program('backups.restore', { exitCode: 3, stderr: 'DOCKFLOW_REFUSED: redis-appendonly\n' });
    expectR17(failure(await createBackup(k3s, ACCESSORY).restore('cache', ID, REDIS, undefined, { forceUnverified: false })));
    expect(k3s.callsTo('backups.restartAfterRestore')).toEqual([]);
  });

  it('Swarm bundle: the real Swarm backend returns docker exec stderr untouched and the engine classifies it', async () => {
    const swarm = fake('swarm');
    const backend = new SwarmBackupBackend(swarm.target, swarm.naming, { sleep: async () => {} });
    swarm.program('backups.restore', (ref, target, script, file, options) => backend.restore(ref, target, script, file, options));
    nodes.on(LIST, listing(meta(swarm, { id: ID, service: 'cache', dbType: 'redis' }, 'agent_1')), 'agent_1');
    nodes.on('com.docker.swarm.service.name=shop-production-accessories_cache', { stdout: 'ctr1\n' }, 'agent_1');
    nodes.on('docker exec -i', { exitCode: 3, stderr: 'DOCKFLOW_REFUSED: redis-appendonly\n' }, 'agent_1');
    expectR17(failure(await createBackup(swarm, ACCESSORY).restore('cache', ID, REDIS, undefined, { forceUnverified: false })));
    expect(swarm.callsTo('backups.restartAfterRestore')).toEqual([]);
  });

  it('the expected redis kill (non-zero exit, empty stderr) is a success followed by the restart', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID, service: 'cache', dbType: 'redis' })), 'server_1');
    k3s.program('backups.restore', { exitCode: 137, stderr: '' });
    const result = await createBackup(k3s, ACCESSORY).restore('cache', ID, REDIS, undefined, { forceUnverified: false });
    expect(result.success).toBe(true);
    expect(k3s.callsTo('backups.restartAfterRestore')).toEqual([[ACCESSORY, 'cache']]);
  });

  it('any other failure reports the detail without the marker line', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: ID })), 'server_1');
    k3s.program('backups.restore', { exitCode: 1, stderr: 'ERROR: relation "orders" already exists\n' });
    const error = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false }));
    expect(error.message).toBe('Restore failed: ERROR: relation "orders" already exists');
    expect((error as BackupError).code).toBe(ErrorCode.RESTORE_FAILED);

    k3s.program('backups.restore', { exitCode: 2, stderr: '' });
    const bare = failure(await createBackup(k3s, ACCESSORY).restore('db', ID, POSTGRES, undefined, { forceUnverified: false }));
    expect(bare.message).toBe('Restore failed: exit code 2');
  });
});

// ---------------------------------------------------------------------------
// list, latest and unreachable nodes (K64b)
// ---------------------------------------------------------------------------

describe('Backup.list and resolveBackup', () => {
  const NEWER = '20260105-100000-bbbb';
  const OLDER = '20260101-100000-aaaa';

  function twoNodes(): FakeOrchestrator {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: OLDER, timestamp: '2026-01-01T10:00:00.000Z' })), 'server_1');
    nodes.on(LIST, new Error('connect ECONNREFUSED 192.0.2.20:22'), 'agent_1');
    return k3s;
  }

  it('reports the node that did not answer instead of skipping it', async () => {
    const k3s = twoNodes();
    const result = await createBackup(k3s, ACCESSORY).list('db');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries.map((entry) => [entry.id, entry.node, entry.filePath])).toEqual([
      [OLDER, 'server_1', `${DIR}/${OLDER}.sql.gz`],
    ]);
    expect(result.data.unreachable.map((node) => node.name)).toEqual(['agent_1']);
    expect(nodes.commands('server_1')).toEqual([
      `find '${DIR}' -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${SEPARATOR}'; cat "$f"; done`,
    ]);
  });

  it('latest (implicit or explicit) is refused while a node is unreachable', async () => {
    const k3s = twoNodes();
    for (const id of [undefined, 'latest']) {
      const error = failure(await createBackup(k3s, ACCESSORY).resolveBackup('db', id));
      expect(error).toBeInstanceOf(BackupError);
      expect(error.message).toBe('The newest backup of db cannot be determined: agent_1 did not answer');
      expect((error as BackupError).code).toBe(ErrorCode.BACKUP_NOT_FOUND);
      expect((error as BackupError).suggestion).toBe('Name the backup explicitly with `--from <id>`, or bring agent_1 back and retry.');
    }
  });

  it('an explicit id on a reachable node resolves', async () => {
    const k3s = twoNodes();
    const result = await createBackup(k3s, ACCESSORY).resolveBackup('db', OLDER);
    expect(result.success && result.data.id).toBe(OLDER);
    const prefix = await createBackup(k3s, ACCESSORY).resolveBackup('db', '20260101');
    expect(prefix.success && prefix.data.id).toBe(OLDER);
  });

  it('with every node answering, latest is the newest across nodes', async () => {
    const k3s = fake('k3s');
    nodes.on(LIST, listing(meta(k3s, { id: OLDER, timestamp: '2026-01-01T10:00:00.000Z' })), 'server_1');
    nodes.on(LIST, listing(meta(k3s, { id: NEWER, timestamp: '2026-01-05T10:00:00.000Z' }, 'agent_1')), 'agent_1');
    const result = await createBackup(k3s, ACCESSORY).resolveBackup('db');
    expect(result.success && result.data.id).toBe(NEWER);
    const none = failure(await createBackup(k3s, ACCESSORY).resolveBackup('db', 'zzz'));
    expect(none.message).toBe('No backup matching "zzz" found for service db');
  });

  it('--node narrows the search to that server; an unknown name lists the valid ones', async () => {
    const k3s = twoNodes();
    const result = await createBackup(k3s, ACCESSORY).list('db', { node: 'server_1' });
    expect(result.success && result.data.unreachable).toEqual([]);
    expect(nodes.calls.map((call) => call.node)).toEqual(['server_1']);

    const error = failure(await createBackup(k3s, ACCESSORY).list('db', { node: 'server_9' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Server server_9 is not a server of production with SSH credentials');
    expect((error as ValidationError).suggestion).toBe('Pass one of: server_1, agent_1.');
  });

  it('without a service the whole role directory is searched; unusable metadata is skipped', async () => {
    const k3s = fake('k3s');
    const good = meta(k3s, { id: OLDER, service: 'cache', dbType: 'redis' });
    const badService = { ...meta(k3s, { id: NEWER }), service: '../etc' };
    nodes.on(LIST, { stdout: `${listing(good, badService).stdout}${SEPARATOR}\nnot json\n` }, 'server_1');
    const result = await createBackup(k3s, ACCESSORY).list();
    expect(result.success && result.data.entries.map((entry) => entry.id)).toEqual([OLDER]);
    expect(nodes.commands('server_1')[0]).toStartWith(`find '/var/lib/dockflow/backups/${SCOPE}' -name`);
  });
});

// ---------------------------------------------------------------------------
// prune: retention and orphaned data files (m12)
// ---------------------------------------------------------------------------

describe('Backup.prune', () => {
  const ORPHANS = '-mmin +1440';

  it('removes the backups past retention on the node they were listed on, and reports orphans', async () => {
    const k3s = fake('k3s');
    nodes.on(
      LIST,
      listing(
        meta(k3s, { id: '20260103-000000-cccc', timestamp: '2026-01-03T00:00:00.000Z', sizeBytes: 300 }),
        meta(k3s, { id: '20260101-000000-aaaa', timestamp: '2026-01-01T00:00:00.000Z', sizeBytes: 100 }),
      ),
      'server_1',
    );
    nodes.on(LIST, listing(meta(k3s, { id: '20260102-000000-bbbb', timestamp: '2026-01-02T00:00:00.000Z', sizeBytes: 200 }, 'agent_1')), 'agent_1');
    nodes.on(ORPHANS, { stdout: `4096\t${DIR}/20251201-000000-dead.sql.gz\n` }, 'agent_1');

    const result = await createBackup(k3s, ACCESSORY).prune('db', 1);
    expect(result.success && result.data).toEqual({ removed: 2, orphanFiles: 1, bytesFreed: 100 + 200 + 4096 });
    expect(nodes.commands('server_1')).toContain(`rm -f -- '${DIR}/20260101-000000-aaaa.'*`);
    expect(nodes.commands('agent_1')).toContain(`rm -f -- '${DIR}/20260102-000000-bbbb.'*`);
    expect(nodes.commands().filter((command) => command.startsWith('rm -f'))).toHaveLength(2);
    expect(printed).toContainEqual({ level: 'info', message: 'Removed 1 orphaned backup file(s) (4.0 KB) left by interrupted backups' });
  });

  it('prefetched entries skip the listing; --node narrows the orphan sweep', async () => {
    const k3s = fake('k3s');
    const listed = await createBackup(k3s, ACCESSORY).list('db');
    expect(listed.success).toBe(true);
    nodes.calls.length = 0;
    const result = await createBackup(k3s, ACCESSORY).prune('db', 5, { node: 'agent_1', prefetched: [] });
    expect(result.success && result.data).toEqual({ removed: 0, orphanFiles: 0, bytesFreed: 0 });
    expect(nodes.calls.map((call) => call.node)).toEqual(['agent_1']);
    expect(nodes.commands()[0]).toContain(ORPHANS);
    expect(printed.filter((line) => line.level === 'info')).toEqual([]);
  });

  it('a prefetched entry whose name could escape the backup directory prunes nothing', async () => {
    const k3s = fake('k3s');
    const listed = { ...meta(k3s, { id: '20260101-000000-aaaa' }), filePath: '', node: 'server_1' };
    const error = failure(
      await createBackup(k3s, ACCESSORY).prune('db', 0, {
        prefetched: [listed, { ...listed, id: '../../etc', timestamp: '2025-01-01T00:00:00.000Z' }],
      }),
    );
    expect(error.message).toBe('Backup "../../etc" of "db" has an unusable name; nothing was pruned');
    expect(nodes.commands().filter((command) => command.startsWith('rm'))).toEqual([]);
  });

  const SH = Bun.which('sh');

  describe.if(SH !== null)('orphan sweep executed by a real sh', () => {
    const root = mkdtempSync(join(tmpdir(), 'dockflow-backup-engine-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const shPath = (path: string): string =>
      process.platform === 'win32' ? `/${path[0].toLowerCase()}${path.slice(2).replace(/\\/g, '/')}` : path;

    it('an orphan older than 24 h is removed, a younger one and files with metadata are kept', async () => {
      const dir = join(root, SCOPE, 'db');
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

      const k3s = fake('k3s');
      k3s.target.workers.length = 0;
      nodes.on(ORPHANS, (command) => {
        const local = command.replaceAll('/var/lib/dockflow/backups', shPath(root));
        const proc = Bun.spawnSync([SH ?? 'sh', '-c', local], {
          env: { PATH: process.platform === 'win32' ? '/usr/bin:/bin' : (process.env.PATH ?? '') },
        });
        return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
      });

      const result = await createBackup(k3s, ACCESSORY).prune('db', 10);
      expect(result.success && result.data).toEqual({ removed: 0, orphanFiles: 3, bytesFreed: 1000 + 500 + 2 });
      expect(readdirSync(dir).sort()).toEqual([
        '20250101-000000-bbbb.sql.gz',
        '20250101-000000-cccc.meta.json',
        '20250101-000000-cccc.sql.gz',
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Swarm BackupBackend (design-06 4.4, 10.3)
// ---------------------------------------------------------------------------

describe('SwarmBackupBackend', () => {
  const LOCATE = 'label=com.docker.swarm.service.name=shop-production-accessories_db';

  function swarmBackend(): { swarm: FakeOrchestrator; backend: SwarmBackupBackend; sleeps: number[] } {
    const swarm = fake('swarm');
    const sleeps: number[] = [];
    const backend = new SwarmBackupBackend(swarm.target, swarm.naming, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // the container runs on the worker only
    nodes.on(LOCATE, { stdout: '' });
    nodes.on(LOCATE, { stdout: 'ctr1\n' }, 'agent_1');
    return { swarm, backend, sleeps };
  }

  it('dump: docker exec in the container, rc captured through gzip, umask 077, no credential on the host', async () => {
    const { swarm, backend } = swarmBackend();
    const script = buildDumpScript(POSTGRES, 'gzip');
    const file = await backend.dump(ACCESSORY, { service: 'db' }, script, `${DIR}/1.sql.gz`, { gzip: true });
    expect(file).toEqual({ node: host(swarm, 'agent_1'), remotePath: `${DIR}/1.sql.gz` });
    const dump = nodes.commands('agent_1').at(-1);
    expect(dump).toBe(buildCapturePipeline(`docker exec 'ctr1' sh -c ${ssh.shellQuote(script)}`, `${DIR}/1.sql.gz`, true));
    expect(dump).toStartWith('umask 077 && ');
    expect(nodes.commands().some((command) => command.includes('docker inspect'))).toBe(false);
    expect(nodes.commands().some((command) => / -e [A-Z_]+=/.test(command))).toBe(false);
  });

  it('dump: a failing exec removes the file and reports the exit status', async () => {
    const { backend } = swarmBackend();
    nodes.on('docker exec', { exitCode: 1, stderr: 'pg_dump: error: connection failed\n' }, 'agent_1');
    await expect(backend.dump(ACCESSORY, { service: 'db' }, 'x', `${DIR}/1.sql.gz`, { gzip: true })).rejects.toThrow(
      new BackupError('Backup of db failed (exit 1): pg_dump: error: connection failed'),
    );
    expect(nodes.commands('agent_1').at(-1)).toBe(`rm -f -- '${DIR}/1.sql.gz'`);
  });

  it('no running container is a BackupError', async () => {
    const swarm = fake('swarm');
    const backend = new SwarmBackupBackend(swarm.target, swarm.naming);
    await expect(backend.dump(ACCESSORY, { service: 'db' }, 'x', `${DIR}/1.sql.gz`, { gzip: true })).rejects.toThrow(
      'No running container found for service db',
    );
  });

  it('restore on the node holding the file: one pipeline; the outcome is returned with the marker untouched', async () => {
    const { swarm, backend } = swarmBackend();
    nodes.on('docker exec -i', { exitCode: 3, stderr: 'DOCKFLOW_REFUSED: redis-appendonly\n' }, 'agent_1');
    const file: BackupFile = { node: host(swarm, 'agent_1'), remotePath: `${DIR}/1.rdb.gz` };
    const outcome = await backend.restore(ACCESSORY, { service: 'db' }, 'restore-script', file, { gunzip: true });
    expect(outcome).toEqual({ exitCode: 3, stderr: 'DOCKFLOW_REFUSED: redis-appendonly\n' });
    expect(nodes.commands('agent_1').at(-1)).toBe(`gunzip -c '${DIR}/1.rdb.gz' | docker exec -i 'ctr1' sh -c 'restore-script'`);

    const plain = await backend.restore(ACCESSORY, { service: 'db' }, 'r', { ...file, remotePath: `${DIR}/1.sql` }, { gunzip: false });
    expect(plain.exitCode).toBe(3);
    expect(nodes.commands('agent_1').at(-1)).toBe(`docker exec -i 'ctr1' sh -c 'r' < '${DIR}/1.sql'`);
  });

  it('restore relays through the CLI when the container moved to another node', async () => {
    const { swarm, backend } = swarmBackend();
    nodes.on(`gunzip -c '${DIR}/1.sql.gz'`, { stdout: 'SQL BYTES' }, 'server_1');
    nodes.on('docker exec -i', { exitCode: 0, stderr: 'NOTICE: restored' }, 'agent_1');
    const outcome = await backend.restore(
      ACCESSORY,
      { service: 'db' },
      'restore-script',
      { node: host(swarm, 'server_1'), remotePath: `${DIR}/1.sql.gz` },
      { gunzip: true },
    );
    expect(outcome).toEqual({ exitCode: 0, stderr: 'NOTICE: restored' });
    const source = nodes.calls.find((call) => call.via === 'stream');
    const sink = nodes.calls.find((call) => call.via === 'channel');
    expect([source?.node, source?.command]).toEqual(['server_1', `gunzip -c '${DIR}/1.sql.gz'`]);
    expect([sink?.node, sink?.command, sink?.input]).toEqual(['agent_1', `docker exec -i 'ctr1' sh -c 'restore-script'`, 'SQL BYTES']);
  });

  it('a relay whose source fails is reported as unreadable', async () => {
    const { swarm, backend } = swarmBackend();
    nodes.on(`cat '${DIR}/1.sql'`, { exitCode: 1, stderr: 'cat: /x: Permission denied' }, 'server_1');
    await expect(
      backend.restore(ACCESSORY, { service: 'db' }, 'r', { node: host(swarm, 'server_1'), remotePath: `${DIR}/1.sql` }, { gunzip: false }),
    ).rejects.toThrow(`Cannot read backup file ${DIR}/1.sql on server_1: cat: /x: Permission denied`);
  });

  it('volumes: docker inspect mounts on the container node, excludes applied', async () => {
    const { backend } = swarmBackend();
    nodes.on(
      "docker inspect --format '{{json .Mounts}}' 'ctr1'",
      {
        stdout: JSON.stringify([
          { Type: 'volume', Name: `${SCOPE}_db-data`, Source: '/var/lib/docker/volumes/x/_data', Destination: '/var/lib/postgresql/data' },
          { Type: 'bind', Source: '/srv/uploads', Destination: '/srv/uploads', RW: true },
          { Type: 'volume', Name: `${SCOPE}_cache`, Source: '/y', Destination: '/cache' },
        ]),
      },
      'agent_1',
    );
    expect(await backend.volumes(ACCESSORY, 'db', { includeBindMounts: true, exclude: ['cache'] })).toEqual([
      { name: 'db-data', kind: 'volume', source: `${SCOPE}_db-data`, mountPath: '/var/lib/postgresql/data', node: 'agent_1' },
      { name: 'srv-uploads', kind: 'bind', source: '/srv/uploads', mountPath: '/srv/uploads', node: 'agent_1' },
    ]);
  });

  it('archiveVolumes: today alpine and host tar commands, with umask and rc capture; a failure removes every file', async () => {
    const { swarm, backend } = swarmBackend();
    const volumes: BackupVolume[] = [
      { name: 'db-data', kind: 'volume', source: `${SCOPE}_db-data`, mountPath: '/data', node: 'agent_1' },
      { name: 'srv-uploads', kind: 'bind', source: '/srv/uploads', mountPath: '/srv/uploads', node: 'agent_1' },
    ];
    const files = await backend.archiveVolumes(ACCESSORY, 'db', volumes, `${DIR}/7`, { gzip: true });
    const worker = host(swarm, 'agent_1');
    expect(files).toEqual([
      { node: worker, remotePath: `${DIR}/7.db-data.tar.gz` },
      { node: worker, remotePath: `${DIR}/7.srv-uploads.tar.gz` },
    ]);
    expect(nodes.commands('agent_1')).toEqual([
      buildCapturePipeline(
        `docker run --rm -v '${SCOPE}_db-data':/backup-source:ro alpine tar cf - -C /backup-source .`,
        `${DIR}/7.db-data.tar.gz`,
        true,
      ),
      buildCapturePipeline("tar cf - -C '/srv/uploads' .", `${DIR}/7.srv-uploads.tar.gz`, true),
    ]);

    nodes.calls.length = 0;
    nodes.on("tar cf - -C '/srv/uploads'", { exitCode: 2, stderr: 'tar: /srv/uploads: Cannot open: Permission denied' }, 'agent_1');
    await expect(backend.archiveVolumes(ACCESSORY, 'db', volumes, `${DIR}/8`, { gzip: false })).rejects.toThrow(
      'Backup failed for bind /srv/uploads: tar: /srv/uploads: Cannot open: Permission denied',
    );
    expect(nodes.commands('agent_1').slice(-2)).toEqual([`rm -f -- '${DIR}/8.db-data.tar'`, `rm -f -- '${DIR}/8.srv-uploads.tar'`]);
  });

  describe('restoreVolumes', () => {
    const ID = '20260102-100000-a1b2';
    const ID8 = shortHash(`${DIR}/${ID}`, 8);
    const VOLUME_LS = "docker volume ls --format '{{.Name}}'";

    function archives(swarm: FakeOrchestrator): { volume: BackupVolume; file: BackupFile }[] {
      const worker = host(swarm, 'agent_1');
      return [
        {
          volume: { name: 'db-data', kind: 'volume', source: `${SCOPE}_db-data`, mountPath: '/data', node: 'agent_1' },
          file: { node: worker, remotePath: `${DIR}/${ID}.db-data.tar.gz` },
        },
        {
          volume: { name: 'uploads', kind: 'bind', source: '/srv/uploads', mountPath: '/srv/uploads', node: null },
          file: { node: worker, remotePath: `${DIR}/${ID}.uploads.tar.gz` },
        },
      ];
    }

    const extract = `sh -c ${ssh.shellQuote(buildExtractScript('/dockflow/v0', ID8))}`;
    const swap = `sh -c ${ssh.shellQuote(buildSwapScript('/dockflow/v0', ID8))}`;
    const discard = `sh -c ${ssh.shellQuote(buildDiscardScript('/dockflow/v0', ID8))}`;

    it('every archive is extracted beside the data before any swap; nothing wipes a mount root', async () => {
      const { swarm, backend } = swarmBackend();
      nodes.on(VOLUME_LS, { stdout: `other\n${SCOPE}_db-data\n` }, 'agent_1');
      await backend.restoreVolumes(ACCESSORY, 'db', archives(swarm));
      expect(nodes.commands('agent_1')).toEqual([
        VOLUME_LS,
        `gunzip -c '${DIR}/${ID}.db-data.tar.gz' | docker run --rm -i -v '${SCOPE}_db-data':/dockflow/v0 alpine ${extract}`,
        `gunzip -c '${DIR}/${ID}.uploads.tar.gz' | docker run --rm -i -v '/srv/uploads':/dockflow/v0 alpine ${extract}`,
        `docker run --rm -v '${SCOPE}_db-data':/dockflow/v0 alpine ${swap}`,
        `docker run --rm -v '/srv/uploads':/dockflow/v0 alpine ${swap}`,
      ]);
      for (const command of nodes.commands()) {
        expect(command).not.toMatch(/find .*-delete|rm -rf \/dockflow\/v0\/\*/);
      }
    });

    it('an extraction failure on the second volume leaves no swap, cleans both, and says nothing changed', async () => {
      const { swarm, backend } = swarmBackend();
      nodes.on(VOLUME_LS, { stdout: `${SCOPE}_db-data\n` }, 'agent_1');
      nodes.on(`${ID}.uploads.tar.gz' | docker run`, { exitCode: 2, stderr: 'tar: Unexpected EOF in archive\n' }, 'agent_1');
      await expect(backend.restoreVolumes(ACCESSORY, 'db', archives(swarm))).rejects.toThrow(
        new BackupError('Restore of db failed while reading the archive of volume uploads: tar: Unexpected EOF in archive; nothing was changed'),
      );
      const commands = nodes.commands('agent_1');
      expect(commands.some((command) => command.includes(swap))).toBe(false);
      expect(commands.slice(-2)).toEqual([
        `docker run --rm -v '${SCOPE}_db-data':/dockflow/v0 alpine ${discard}`,
        `docker run --rm -v '/srv/uploads':/dockflow/v0 alpine ${discard}`,
      ]);
    });

    it('a full disk during extraction names the node and keeps the data', async () => {
      const { swarm, backend } = swarmBackend();
      nodes.on(VOLUME_LS, { stdout: `${SCOPE}_db-data\n` }, 'agent_1');
      nodes.on(`${ID}.db-data.tar.gz' | docker run`, { exitCode: 2, stderr: 'tar: ./x: Cannot write: No space left on device\n' }, 'agent_1');
      const error = await backend.restoreVolumes(ACCESSORY, 'db', archives(swarm)).catch((caught: unknown) => caught as BackupError);
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).message).toBe(
        'Restore of db needs room for a second copy of volume db-data on agent_1; nothing was changed',
      );
      expect((error as BackupError).suggestion).toBe('Free disk space on agent_1 and run the restore again; the current contents were kept.');
    });

    it('a swap failure names the directory holding the previous contents', async () => {
      const { swarm, backend } = swarmBackend();
      nodes.on(VOLUME_LS, { stdout: `${SCOPE}_db-data\n` }, 'agent_1');
      nodes.on((command) => command.includes(swap) && command.includes('/srv/uploads'), { exitCode: 1, stderr: 'mv: cannot move' }, 'agent_1');
      await expect(backend.restoreVolumes(ACCESSORY, 'db', archives(swarm))).rejects.toThrow(
        `Restore of db failed while swapping volume uploads: mv: cannot move; the previous contents are in uploads/.dockflow-old-${ID8}`,
      );
    });

    it('an archive whose volume does not exist is refused before anything runs', async () => {
      const { swarm, backend } = swarmBackend();
      nodes.on(VOLUME_LS, { stdout: 'unrelated\n' }, 'agent_1');
      await expect(backend.restoreVolumes(ACCESSORY, 'db', archives(swarm))).rejects.toThrow(
        'Backup volume db-data has no matching volume in service db; nothing was restored',
      );
      expect(nodes.commands().some((command) => command.includes('docker run'))).toBe(false);
    });
  });

  it('restartAfterRestore: a pause, then a forced service update on the manager; failures stay debug output', async () => {
    const { backend, sleeps } = swarmBackend();
    nodes.on('docker service update', { exitCode: 1, stderr: 'no such service' });
    await backend.restartAfterRestore(ACCESSORY, 'db');
    expect(sleeps).toEqual([3000]);
    expect(nodes.calls.at(-1)).toMatchObject({ node: 'server_1', command: "docker service update --force 'shop-production-accessories_db'" });
    expect(printed).toContainEqual({ level: 'debug', message: 'Service update after restore failed (non-fatal): no such service' });
  });
});
