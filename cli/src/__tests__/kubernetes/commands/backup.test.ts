// T/commands/backup.test.ts (P71-volumes-backup-commands, design-06 3.20): `dockflow backup
// create|restore|list|prune` over `FakeOrchestrator`, with node file operations (list, verify,
// metadata) answered by a scripted `sshExec`/`sshExecChannel` stub, the same technique
// `backup-engine.test.ts` uses for `services/backup.ts` (P34): those calls bypass the orchestrator
// abstraction and talk to nodes directly.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Writable } from 'stream';
import { runBackupCreate } from '../../../commands/backup/create';
import { runBackupList } from '../../../commands/backup/list';
import { runBackupPrune } from '../../../commands/backup/prune';
import { runBackupRestore } from '../../../commands/backup/restore';
import { __setOrchestratorOpenerForTests } from '../../../commands/shared/day2';
import type { BackupMetadata } from '../../../services/backup';
import type { ClusterNodeRef, ServiceInfo } from '../../../services/orchestrator/interfaces';
import * as configModule from '../../../utils/config';
import type { DockflowConfig } from '../../../utils/config';
import { DeployError, UnsupportedOperationError, ValidationError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import * as ssh from '../../../utils/ssh';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

// ---------------------------------------------------------------------------
// Scripted node shell (mirrors backup-engine.test.ts's FakeNodes, trimmed to what commands need)
// ---------------------------------------------------------------------------

const SEPARATOR = '---DOCKFLOW_META_SEP---';

type Reply = { exitCode?: number; stdout?: string; stderr?: string } | Error;

class FakeNodes {
  readonly calls: { node: string; command: string }[] = [];
  private readonly rules: { match: (command: string) => boolean; reply: Reply | ((command: string) => Reply) }[] = [];

  constructor(private readonly names: Map<string, string>) {
    // every verification script ends by printing OK when the archive is sound
    this.on((command) => command.endsWith('\necho OK'), { stdout: 'OK\n' });
  }

  on(match: (command: string) => boolean, reply: Reply | ((command: string) => Reply)): this {
    this.rules.push({ match, reply });
    return this;
  }

  nodeOf(host: string): string {
    return this.names.get(host) ?? host;
  }

  reply(node: string, command: string): Reply {
    const rule = [...this.rules].reverse().find((candidate) => candidate.match(command));
    if (!rule) return {};
    return typeof rule.reply === 'function' ? rule.reply(command) : rule.reply;
  }
}

let nodes: FakeNodes;
let sshSpies: ReturnType<typeof spyOn>[] = [];
let configSpy: ReturnType<typeof spyOn> | null = null;

function installSsh(orchestrator: FakeOrchestrator): FakeNodes {
  const names = new Map<string, string>();
  for (const node of [...orchestrator.target.managers, ...orchestrator.target.workers]) names.set(node.connection.host, node.name);
  nodes = new FakeNodes(names);
  sshSpies = [
    spyOn(ssh, 'sshExec').mockImplementation(async (conn: { host: string }, command: string) => {
      const node = nodes.nodeOf(conn.host);
      nodes.calls.push({ node, command });
      const reply = nodes.reply(node, command);
      if (reply instanceof Error) throw reply;
      return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    }),
    spyOn(ssh, 'sshExecChannel').mockImplementation(async (conn: { host: string }, command: string) => {
      const node = nodes.nodeOf(conn.host);
      nodes.calls.push({ node, command });
      const chunks: Buffer[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const done = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
        stream.on('finish', () => {
          const reply = nodes.reply(node, command);
          const result = reply instanceof Error ? { exitCode: 255, stdout: '', stderr: reply.message } : reply;
          resolve({ exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
        });
      });
      return { stream: stream as unknown as Awaited<ReturnType<typeof ssh.sshExecChannel>>['stream'], done };
    }),
  ];
  return nodes;
}

function withConfig(config: DockflowConfig | null): void {
  configSpy?.mockRestore();
  configSpy = spyOn(configModule, 'loadConfig').mockReturnValue(config);
}

function open(orchestrator: FakeOrchestrator): void {
  __setOrchestratorOpenerForTests(async () => ({ config: { project_name: 'shop', orchestrator: orchestrator.kind }, orchestrator }));
}

// decorative, never asserted on
const decorative = ['printIntro', 'printOutro', 'printBlank', 'printDim'] as const;
let decorativeSpies: ReturnType<typeof spyOn>[] = [];
// spies a test creates to assert on (printInfo, printWarning, printJSON, ...); tracked here so a
// stale mock from one test never leaks its call history into the next.
let adHocSpies: ReturnType<typeof spyOn>[] = [];

function watch<K extends 'printInfo' | 'printWarning' | 'printJSON' | 'printSuccess'>(obj: typeof output, key: K) {
  const spy = spyOn(obj, key);
  spy.mockImplementation((() => {}) as never);
  adHocSpies.push(spy);
  return spy;
}

beforeEach(() => {
  decorativeSpies = decorative.map((name) => spyOn(output, name).mockImplementation(() => {}));
});

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
  for (const spy of decorativeSpies) spy.mockRestore();
  for (const spy of adHocSpies) spy.mockRestore();
  for (const spy of sshSpies) spy.mockRestore();
  configSpy?.mockRestore();
  configSpy = null;
  sshSpies = [];
  adHocSpies = [];
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', orchestrator: 'k3s', backup: { accessories: { db: { type: 'postgres' } }, compression: 'gzip' }, ...overrides };
}

function service(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'db',
    nativeName: 'db',
    kind: 'service',
    role: 'accessory',
    mode: 'replicated',
    image: 'postgres:17',
    replicas: { running: 1, desired: 1 },
    ports: [],
    state: 'running',
    ...overrides,
  };
}

function nodeRef(orchestrator: FakeOrchestrator, name = 'server_1'): ClusterNodeRef {
  const node = [...orchestrator.target.managers, ...orchestrator.target.workers].find((candidate) => candidate.name === name);
  if (!node) throw new Error(`test setup: no node ${name}`);
  return node;
}

function meta(orchestrator: FakeOrchestrator, fields: Partial<BackupMetadata> & { id: string }): BackupMetadata {
  const node = nodeRef(orchestrator, 'server_1');
  return {
    service: 'db',
    dbType: 'postgres',
    timestamp: '2026-01-02T10:00:00.000Z',
    size: '2.0 KB',
    sizeBytes: 2048,
    compression: 'gzip',
    durationMs: 10,
    stackName: 'shop-production-accessories',
    nodeHost: node.connection.host,
    nodePort: node.connection.port,
    orchestrator: 'k3s',
    role: 'accessory',
    ...fields,
  };
}

function listingReply(...metas: BackupMetadata[]): { stdout: string } {
  return { stdout: metas.map((m) => `${SEPARATOR}\n${JSON.stringify(m)}\n`).join('') };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('runBackupCreate', () => {
  it('requires the service argument', async () => {
    withConfig(baseConfig());
    await expect(runBackupCreate('production', undefined, {})).rejects.toThrow(ValidationError);
  });

  it('R-24: an unconfigured Traefik name is refused before any SSH, on k3s only', async () => {
    withConfig(baseConfig({ backup: {} }));
    let opened = false;
    __setOrchestratorOpenerForTests(async () => {
      opened = true;
      throw new Error('should never be reached');
    });
    await expect(runBackupCreate('production', 'dockflow-traefik', {})).rejects.toThrow(UnsupportedOperationError);
    expect(opened).toBe(false);
  });

  it('a genuinely unconfigured service is the ordinary missing-configuration error', async () => {
    withConfig(baseConfig({ backup: {} }));
    await expect(runBackupCreate('production', 'nope', {})).rejects.toMatchObject({ name: 'BackupError' });
  });

  it('creates a backup of a configured accessory, verified on the node holding it', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    installSsh(orchestrator);
    open(orchestrator);

    await runBackupCreate('production', 'db', {});

    const dumps = orchestrator.callsTo('backups.dump');
    expect(dumps.length).toBe(1);
    expect(dumps[0][0]).toMatchObject({ project: 'shop', env: 'production', role: 'accessory' });
  });

  it('--json prints the backup metadata', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    installSsh(orchestrator);
    open(orchestrator);
    const json = watch(output, 'printJSON');

    await runBackupCreate('production', 'db', { json: true });

    expect(json).toHaveBeenCalledTimes(1);
    const printedMeta = json.mock.calls[0][0] as BackupMetadata;
    expect(printedMeta.service).toBe('db');
    expect(printedMeta.dbType).toBe('postgres');
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('runBackupRestore', () => {
  it('requires the service argument', async () => {
    withConfig(baseConfig());
    await expect(runBackupRestore('production', undefined, {})).rejects.toThrow(ValidationError);
  });

  it('R-23: a service with more than one desired replica is refused before any prompt or lock', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ replicas: { running: 3, desired: 3 } })]);
    open(orchestrator);

    await expect(runBackupRestore('production', 'db', { yes: true })).rejects.toThrow(
      'Service db runs 3 replicas; dockflow backup restore writes one replica only',
    );
    expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
  });

  it('U-CMD-DAY2-05: without -y in a non-interactive session, a mismatched confirmation cancels with no lock or restore call', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    installSsh(orchestrator);
    nodes.on(
      (command) => command.includes("-name '*.meta.json'"),
      () => listingReply(meta(orchestrator, { id: '20260102-100000-a1b2' })),
    );
    open(orchestrator);
    const info = watch(output, 'printInfo');

    await runBackupRestore('production', 'db', {});

    expect(info).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
    expect(orchestrator.callsTo('backups.restore').length).toBe(0);
  });

  it('2.8: takes the deploy lock around the restore and releases it in finally', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    installSsh(orchestrator);
    nodes.on(
      (command) => command.includes("-name '*.meta.json'"),
      () => listingReply(meta(orchestrator, { id: '20260102-100000-a1b2' })),
    );
    open(orchestrator);

    await runBackupRestore('production', 'db', { yes: true });

    expect(orchestrator.events).toContain('lock.acquire');
    expect(orchestrator.events.indexOf('lock.acquire')).toBeLessThan(orchestrator.events.indexOf('backups.restore'));
    expect(orchestrator.events.indexOf('backups.restore')).toBeLessThan(orchestrator.events.indexOf('lock.release'));
  });

  it('2.8: a lock already held by another deploy fails with DEPLOY_LOCKED and never restores', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    installSsh(orchestrator);
    nodes.on(
      (command) => command.includes("-name '*.meta.json'"),
      () => listingReply(meta(orchestrator, { id: '20260102-100000-a1b2' })),
    );
    open(orchestrator);
    const held = await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'other deploy' });
    expect(held.success).toBe(true);

    await expect(runBackupRestore('production', 'db', { yes: true })).rejects.toThrow(DeployError);
    expect(orchestrator.callsTo('backups.restore').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('runBackupList', () => {
  it('merges backups of every configured source when no service is named', async () => {
    withConfig(baseConfig({ backup: { services: { web: { type: 'volume' } }, accessories: { db: { type: 'postgres' } } } }));
    const orchestrator = new FakeOrchestrator('k3s');
    installSsh(orchestrator);
    nodes.on(
      (command) => command.includes("-name '*.meta.json'"),
      (command) => {
        if (command.includes('accessories')) return listingReply(meta(orchestrator, { id: '20260102-100000-a1b2', service: 'db' }));
        return listingReply(meta(orchestrator, { id: '20260102-110000-c3d4', service: 'web', dbType: 'volume', stackName: 'shop-production' }));
      },
    );
    open(orchestrator);
    const json = watch(output, 'printJSON');

    await runBackupList('production', undefined, { json: true });

    const printed = json.mock.calls[0][0] as { entries: { service: string }[] };
    expect(printed.entries.map((e) => e.service).sort()).toEqual(['db', 'web']);
  });

  it('--node rejects a name that is not a server of the environment', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    installSsh(orchestrator);
    open(orchestrator);

    await expect(runBackupList('production', 'db', { node: 'bogus' })).rejects.toThrow(ValidationError);
  });

  it('warns about unreachable nodes and still lists what answered', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s', { target: { workers: [] } });
    installSsh(orchestrator);
    nodes.on(
      (command) => command.includes("-name '*.meta.json'"),
      () => new Error('connection refused'),
    );
    open(orchestrator);
    const warning = watch(output, 'printWarning');

    await runBackupList('production', 'db', {});

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('did not answer'));
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe('runBackupPrune', () => {
  it('rejects a non-numeric --keep', async () => {
    withConfig(baseConfig());
    await expect(runBackupPrune('production', 'db', { keep: 'many' })).rejects.toThrow(ValidationError);
  });

  it('nothing to prune when every service is within retention', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    installSsh(orchestrator);
    nodes.on(
      (command) => command.includes("-name '*.meta.json'"),
      () => listingReply(meta(orchestrator, { id: '20260102-100000-a1b2' })),
    );
    open(orchestrator);
    const info = watch(output, 'printInfo');

    await runBackupPrune('production', 'db', { keep: '10', yes: true });

    expect(info).toHaveBeenCalledWith(expect.stringContaining('Nothing to prune'));
  });

  it('prunes down to the retention count and reports the total removed', async () => {
    withConfig(baseConfig());
    const orchestrator = new FakeOrchestrator('k3s');
    installSsh(orchestrator);
    const entries = [
      meta(orchestrator, { id: '20260102-100000-a1b2', timestamp: '2026-01-02T10:00:00.000Z' }),
      meta(orchestrator, { id: '20260101-100000-c3d4', timestamp: '2026-01-01T10:00:00.000Z' }),
      meta(orchestrator, { id: '20251231-100000-e5f6', timestamp: '2025-12-31T10:00:00.000Z' }),
    ];
    nodes.on((command) => command.includes("-name '*.meta.json'"), () => listingReply(...entries));
    open(orchestrator);
    const warning = watch(output, 'printWarning');

    await runBackupPrune('production', 'db', { keep: '1', yes: true });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Will remove 2 backup(s)'));
    const removeCommands = nodes.calls.filter((call) => call.command.startsWith('rm -f'));
    expect(removeCommands.length).toBeGreaterThan(0);
  });
});
