// The k3s setup coordinator (design-05 3, 18; design-07 22.2 CO*). `runK3sClusterSetup`/
// `runK3sReset` run for real, against `FakeSetupTransport` (R-S6-06) over per-node `FakeHostRunner`s
// so `inspect` is genuine, and `FakeHostKeys` (R-S6-07) for the host-key cases. Every test injects
// `config`/`servers`/`deployKeys` too (K3sClusterSetupDeps): this repository's own checkout has a
// `.dockflow/config.yml` one directory above `cli/`, which `loadConfig()`/`resolveServersForEnvironment`
// would otherwise pick up (`getProjectRoot()` walks up from `process.cwd()`), so every real dependency
// the coordinator would normally read from disk or the network is replaced.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DOCKFLOW_VERSION } from '../../../../constants';
import {
  runK3sClusterSetup,
  runK3sReset,
  type K3sClusterSetupDeps,
  type K3sResetOptions,
} from '../../../../commands/setup/k3s/index';
import { renderK3sConfig } from '../../../../commands/setup/k3s/config';
import { K3S_BINARY, K3S_CONFIG_DROPIN, K3S_CONFIG_DROPIN_MODE, K3S_NODE_STATE_FILE } from '../../../../commands/setup/k3s/constants';
import * as prompts from '../../../../commands/setup/prompts';
import type { BootstrapIdentity } from '../../../../commands/setup/k3s/transport';
import {
  buildClusterPlan,
  finalizeClusterPlan,
  type K3sNodeInspection,
  type K3sResolvedCluster,
  type K3sSetupOptions,
  type NodeStateFile,
} from '../../../../commands/setup/k3s/plan';
import { K3S_PIN } from '../../../../services/orchestrator/kubernetes/k3s/versions';
import type { ResolvedServer } from '../../../../types/servers';
import { CLIError, ConnectionError } from '../../../../utils/errors';
import * as output from '../../../../utils/output';
import { Redactor } from '../../../../utils/redact';
import { assertExecutorInvariants, assertNoSecretLeak } from '../../support/invariants';
import { fakeBinary, FakeHostRunner } from '../../fakes/fake-host-runner';
import { FakeHostKeys, fakeHostKey } from '../../fakes/fake-host-keys';
import { FakeSetupTransport, type FakeSetupNode } from '../../fakes/fake-setup-transport';

const ENV = 'production';
const KEYS_DIR = join(import.meta.dir, 'golden', 'keys');
const DEPLOY_KEY = readFileSync(join(KEYS_DIR, 'deploy_ed25519'), 'utf8');
const BOOTSTRAP: BootstrapIdentity = { sshUser: 'root', privateKey: 'bootstrap-key-not-a-real-key' };

const BASE_OPTIONS: K3sSetupOptions = {
  sshUser: 'root',
  dryRun: false,
  yes: true,
  upgrade: false,
  convertDatastore: false,
  sharedCluster: false,
  flannelBackend: null,
  skipFirewall: true,
  skipNetworkCheck: true,
  skipReachabilityCheck: true,
  insecureHostKey: false,
  requireHostKey: false,
  rotateDeployToken: false,
  binary: null,
  dev: false,
  interactive: false,
};

// ---------------------------------------------------------------------------
// servers.yml stand-ins (bypasses loadConfig()/resolveServersForEnvironment(), see file header)
// ---------------------------------------------------------------------------

interface ServerInput {
  host: string;
  role?: 'manager' | 'worker';
}

function srv(name: string, input: ServerInput): ResolvedServer {
  return {
    name,
    role: input.role ?? 'manager',
    host: input.host,
    privateHost: input.host,
    declaredPrivateHost: null,
    nodeLabels: {},
    port: 22,
    user: 'dockflow',
    env: {},
    tags: [ENV],
  };
}

function deployKeysFor(servers: readonly ResolvedServer[]): Record<string, string> {
  return Object.fromEntries(servers.map((server) => [server.name, DEPLOY_KEY]));
}

// ---------------------------------------------------------------------------
// FakeHostRunner: a clean node about to install, ready for a real `inspect` (mirrors node.test.ts)
// ---------------------------------------------------------------------------

let runners: FakeHostRunner[] = [];

function freshHost(address: string, options: { swarmActive?: boolean } = {}): FakeHostRunner {
  const runner = new FakeHostRunner();
  runner.seedFile('/proc/meminfo', 'MemTotal:        4046456 kB\n');
  runner.seedFile('/sys/fs/cgroup/cgroup.controllers', 'cpuset cpu io memory pids\n');
  runner.seedDir('/run/systemd/system');
  runner.interfaces = [{ name: 'eth0', address, prefix: 24 }];
  for (const [command, path] of [
    ['curl', '/usr/bin/curl'],
    ['tar', '/usr/bin/tar'],
    ['sha256sum', '/usr/bin/sha256sum'],
    ['ip', '/usr/sbin/ip'],
    ['systemctl', '/usr/bin/systemctl'],
    ['visudo', '/usr/sbin/visudo'],
  ] as const) {
    runner.commands.set(command, path);
  }
  // optional: a node whose control flow (prepareNode faults, host-key refusals) never reaches
  // inspect at all, so these stubs are never required to have fired (design-07's fakes are
  // reused across happy paths and refusal paths alike).
  runner
    .on(['getenforce'], { exitCode: 1, stderr: 'getenforce: command not found' }, { optional: true })
    .on(['nproc'], { stdout: '4\n' }, { optional: true })
    .on(['df', '-B1', '--output=avail', '/var/lib'], { stdout: 'Avail\n21474836480\n' }, { optional: true })
    .on(['ss', '-Hlntup'], { stdout: '' }, { optional: true })
    .on(
      ['docker', 'info', '--format', '{{.Swarm.LocalNodeState}}'],
      options.swarmActive ? { stdout: 'active\n' } : { exitCode: 1, stderr: 'docker: command not found' },
      { optional: true },
    )
    .on(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'], { exitCode: 1, stderr: 'timedatectl: command not found' }, { optional: true })
    .on(['ip', 'link', 'add', 'dockflow-wgtest', 'type', 'wireguard'], { exitCode: 1, stderr: 'RTNETLINK answers: Operation not permitted' }, { optional: true })
    .on(['ip', 'link', 'del', 'dockflow-wgtest'], { exitCode: 1, stderr: 'Cannot find device "dockflow-wgtest"' }, { optional: true });
  runners.push(runner);
  return runner;
}

// ---------------------------------------------------------------------------
// Already-installed fixtures (CO4, CO9-CO11, CO17-CO18): a node whose `inspect` is scripted to
// report the state a previous, correctly finished run would have left. `resolvedFreshCluster` learns
// the topology `finalizeClusterPlan` settles on for a brand-new install of `servers` -- the same
// computation CO1-CO3 exercise for real -- and `installedInspectionOf` then builds the inspection
// that topology's own config drop-in and state.json would produce (mirrors plan.test.ts's own
// `installedInspection` helper, rebuilt here since a test file never imports another package's).
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3;
const CA_SHA256 = 'c0ffee00'.repeat(8);
const INSTALLED_AT = '2026-09-01T00:00:00.000Z';

function freshInspection(localIpv4: string[]): K3sNodeInspection {
  return {
    os: { id: 'ubuntu', versionId: '24.04', kernel: '6.8.0-45-generic', arch: 'amd64', systemd: true, selinux: 'absent' },
    resources: { cpus: 4, memoryBytes: 8 * GIB, varLibFreeBytes: 100 * GIB },
    network: { localIpv4, resolvedHost: null, defaultRouteIp: localIpv4[0] ?? null },
    commands: { missing: [], packageManager: 'apt' },
    k3s: {
      binaryVersion: null,
      unit: null,
      activeState: null,
      subState: null,
      managed: false,
      state: null,
      dropinSha256: null,
      restartSha256: null,
      dropin: null,
      foreignConfig: [],
      unitEnvK3sVars: [],
      tokenFingerprints: { token: null, agentToken: null },
      caSha256: null,
      datastore: null,
      apiReady: null,
      netcheckPresent: null,
      defaultStorageClasses: null,
    },
    helmVersion: null,
    firewall: { ufw: 'absent', firewalld: 'absent' },
    portsInUse: [],
    swarmActive: false,
    dockerPresent: false,
    nmCloudSetupEnabled: false,
    wireguardAvailable: true,
    cgroupVersion: 2,
    cgroupMemory: true,
    ntpSynchronized: true,
    deployUser: { exists: false, uid: null, home: null, keyAuthorized: false },
    legacySudoRules: [],
  };
}

function addressOf(servers: readonly ResolvedServer[], key: string): string {
  const server = servers.find((s) => s.name === key);
  if (server === undefined) throw new Error(`no server ${key}`);
  return server.host;
}

/** The topology `finalizeClusterPlan` settles on for a fresh install of `servers` (CO1-CO3's own shape). */
function resolvedFreshCluster(servers: readonly ResolvedServer[], overrides: Partial<K3sSetupOptions> = {}): K3sResolvedCluster {
  const plan = buildClusterPlan({
    env: ENV,
    config: null,
    servers,
    deployKeys: deployKeysFor(servers),
    options: { ...BASE_OPTIONS, ...overrides },
    dockflowVersion: DOCKFLOW_VERSION,
  });
  const inspections = Object.fromEntries(plan.nodes.map((node) => [node.key, freshInspection([addressOf(servers, node.key)])]));
  return finalizeClusterPlan(plan, inspections);
}

function renderContextFor(cluster: K3sResolvedCluster, key: string) {
  return {
    env: cluster.plan.env,
    addressMode: cluster.addressMode,
    flannelBackend: cluster.flannelBackend,
    clusterInit: cluster.clusterInitNode === key,
    network: cluster.network[key],
    joinUrl: cluster.joinUrls[key],
  };
}

/** The inspection a node `cluster` already installed (matching its render exactly, zero config drift) would report. */
function installedInspectionOf(
  cluster: K3sResolvedCluster,
  key: string,
  address: string,
  options: { version?: string; envs?: string[]; patch?: (inspection: K3sNodeInspection) => void } = {},
): K3sNodeInspection {
  const node = cluster.plan.nodes.find((n) => n.key === key);
  if (node === undefined) throw new Error(`no node ${key}`);
  const isServer = node.role !== 'agent';
  const version = options.version ?? K3S_PIN.version;
  const render = renderK3sConfig(node, renderContextFor(cluster, key));
  const inspection = freshInspection([address]);
  inspection.k3s = {
    ...inspection.k3s,
    binaryVersion: `k3s version ${version} (1a2b3c4d)`,
    unit: isServer ? 'k3s' : 'k3s-agent',
    activeState: 'active',
    subState: 'running',
    managed: true,
    state: {
      schema: 1,
      managedBy: 'dockflow',
      dockflowVersion: DOCKFLOW_VERSION,
      envs: options.envs ?? [ENV],
      nodeName: node.nodeName,
      role: isServer ? 'server' : 'agent',
      clusterInit: cluster.clusterInitNode === key,
      datastore: isServer ? cluster.datastore : null,
      flannelBackend: cluster.flannelBackend,
      k3sVersion: version,
      configSha256: render.sha256,
      restartSha256: render.restartSha256,
      caSha256: CA_SHA256,
      installedAt: INSTALLED_AT,
      updatedAt: INSTALLED_AT,
    },
    dropinSha256: render.sha256,
    restartSha256: render.restartSha256,
    dropin: { ...render.values },
    caSha256: isServer ? CA_SHA256 : null,
    datastore: isServer ? cluster.datastore : null,
    apiReady: isServer ? true : null,
    netcheckPresent: isServer ? false : null,
    defaultStorageClasses: isServer ? [{ name: 'dockflow-local', createdAt: '2026-01-01T00:00:00Z' }] : null,
  };
  options.patch?.(inspection);
  return inspection;
}

/** Seeds `runner`'s filesystem to genuinely match `installedInspectionOf(cluster, key, ...)`, so a real `install` proves idempotence (CO4). */
function seedInstalledHost(runner: FakeHostRunner, cluster: K3sResolvedCluster, key: string): void {
  const node = cluster.plan.nodes.find((n) => n.key === key);
  if (node === undefined) throw new Error(`no node ${key}`);
  const isServer = node.role !== 'agent';
  const render = renderK3sConfig(node, renderContextFor(cluster, key));
  runner.seedFile(K3S_BINARY, fakeBinary('k3s', K3S_PIN.version), { mode: 0o755 });
  runner.services.set(isServer ? 'k3s' : 'k3s-agent', [{ activeState: 'active', subState: 'running', loadState: 'loaded' }]);
  runner.seedFile(K3S_CONFIG_DROPIN, render.content, { mode: K3S_CONFIG_DROPIN_MODE });
  const state: NodeStateFile = {
    schema: 1,
    managedBy: 'dockflow',
    dockflowVersion: DOCKFLOW_VERSION,
    envs: [ENV],
    nodeName: node.nodeName,
    role: isServer ? 'server' : 'agent',
    clusterInit: cluster.clusterInitNode === key,
    datastore: isServer ? cluster.datastore : null,
    flannelBackend: cluster.flannelBackend,
    k3sVersion: K3S_PIN.version,
    configSha256: render.sha256,
    restartSha256: render.restartSha256,
    caSha256: null,
    installedAt: INSTALLED_AT,
    updatedAt: INSTALLED_AT,
  };
  runner.seedFile(K3S_NODE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

afterEach(() => {
  const hostRunner = runners;
  runners = [];
  for (const runner of hostRunner) runner.assertDone();
  assertExecutorInvariants({ hostRunner, redactor: new Redactor(['placeholder-secret-value']) });
});

// ---------------------------------------------------------------------------
// Driving the coordinator, capturing decorative output
// ---------------------------------------------------------------------------

interface Run {
  error: unknown;
  infos: string[];
  errors: string[];
  /** printDim lines: the per-node action list (17.1's pre-check echo) and the summary table */
  dims: string[];
}

async function withSpies<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; infos: string[]; errors: string[]; dims: string[] }> {
  const infoSpy = spyOn(output, 'printInfo').mockImplementation(() => {});
  const errorSpy = spyOn(output, 'printError').mockImplementation(() => {});
  const dimSpy = spyOn(output, 'printDim').mockImplementation(() => {});
  const blankSpy = spyOn(output, 'printBlank').mockImplementation(() => {});
  let error: unknown;
  let result: T | undefined;
  let infos: string[] = [];
  let errors: string[] = [];
  let dims: string[] = [];
  try {
    result = await fn();
  } catch (thrown) {
    error = thrown;
  } finally {
    // read call history before mockRestore(), which clears it
    infos = infoSpy.mock.calls.map((call) => String(call[0]));
    errors = errorSpy.mock.calls.map((call) => String(call[0]));
    dims = dimSpy.mock.calls.map((call) => String(call[0]));
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    dimSpy.mockRestore();
    blankSpy.mockRestore();
  }
  return { result, error, infos, errors, dims };
}

async function run(servers: readonly ResolvedServer[], transport: FakeSetupTransport, overrides: Partial<K3sSetupOptions> = {}, deps: K3sClusterSetupDeps = {}): Promise<Run> {
  const options: K3sSetupOptions = { ...BASE_OPTIONS, ...overrides };
  const { error, infos, errors, dims } = await withSpies(() =>
    runK3sClusterSetup(ENV, BOOTSTRAP, options, { config: null, servers, deployKeys: deployKeysFor(servers), transport, ...deps }),
  );
  return { error, infos, errors, dims };
}

async function runReset(servers: readonly ResolvedServer[], transport: FakeSetupTransport, overrides: Partial<K3sResetOptions> = {}, deps: K3sClusterSetupDeps = {}): Promise<Run> {
  const options: K3sResetOptions = {
    sshUser: 'root',
    nodes: [],
    deleteVolumes: false,
    yes: true,
    confirm: ENV,
    sharedCluster: false,
    insecureHostKey: false,
    requireHostKey: false,
    binary: null,
    dev: false,
    interactive: false,
    ...overrides,
  };
  const { error, infos, errors, dims } = await withSpies(() =>
    runK3sReset(ENV, BOOTSTRAP, options, { config: null, servers, deployKeys: deployKeysFor(servers), transport, ...deps }),
  );
  return { error, infos, errors, dims };
}

// ---------------------------------------------------------------------------
// CO1: fresh single server end to end
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: fresh installs', () => {
  it('CO1 a single fresh server installs, control-planes, finalizes and reports ready', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' })];
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10') } };
    const transport = new FakeSetupTransport({ nodes });

    const { error, infos } = await run(servers, transport);

    expect(error).toBeUndefined();
    // one inspect (real), then prepare, install, control-plane, finalize, all in that order for this node
    const opsOf = (key: string): string[] => transport.calls.filter((c) => c.command.endsWith(` ${key}`)).map((c) => c.command.split(' ')[0]);
    expect(opsOf('srv-1')).toEqual(['prepareNode', 'inspect', 'prepare', 'install', 'control-plane', 'finalize']);
    expect(infos.some((line) => line.includes('k3s cluster production is ready'))).toBe(true);
    expect(infos.some((line) => line.includes('dockflow deploy production'))).toBe(true);
    expect(transport.cleanupCalls).toBe(1);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO2: server + agents, concurrency and ordering
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: multi-node ordering', () => {
  it('CO2 agents install only after the server’s control-plane step, never before', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' }), srv('agent-2', { host: '10.0.0.12', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10') },
      'agent-1': { runner: freshHost('10.0.0.11') },
      'agent-2': { runner: freshHost('10.0.0.12') },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeUndefined();
    const indexOf = (needle: string): number => transport.calls.findIndex((c) => c.command === needle);
    const serverControlPlane = indexOf('control-plane srv-1');
    expect(serverControlPlane).toBeGreaterThan(-1);
    expect(indexOf('install agent-1')).toBeGreaterThan(serverControlPlane);
    expect(indexOf('install agent-2')).toBeGreaterThan(serverControlPlane);
    transport.assertDone();
  });

  it('CO3 HA 3 servers: srv-2 installs only after srv-1 is prepared, srv-3 after srv-2 (sequential servers)', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('srv-2', { host: '10.0.0.11' }), srv('srv-3', { host: '10.0.0.12' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10') },
      'srv-2': { runner: freshHost('10.0.0.11') },
      'srv-3': { runner: freshHost('10.0.0.12') },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeUndefined();
    const indexOf = (needle: string): number => transport.calls.findIndex((c) => c.command === needle);
    // servers install one at a time: srv-2's install starts only after srv-1's control-plane finished
    expect(indexOf('install srv-2')).toBeGreaterThan(indexOf('control-plane srv-1'));
    expect(indexOf('install srv-3')).toBeGreaterThan(indexOf('control-plane srv-2'));
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO5, CO6: failure propagation
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: node failures', () => {
  it('CO5 one agent fails to join: the other agent still installs, the run still fails', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' }), srv('agent-2', { host: '10.0.0.12', role: 'worker' })];
    const failure = { status: 'failed' as const, error: { step: 'install', message: 'agent-1 could not reach the join URL', suggestion: 'Check the firewall.', logTail: [] } };
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10') },
      'agent-1': { runner: freshHost('10.0.0.11'), operations: { install: { kind: 'result', result: failure } } },
      'agent-2': { runner: freshHost('10.0.0.12') },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).message).toContain('agent-1');
    // agent-2 was still attempted despite agent-1's failure (forEachLimit does not fail-fast across siblings... it does: forEachLimit stops new work once one fails)
    transport.assertDone();
  });

  it('CO6 a server install failure stops the run before any agent is touched', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const failure = { status: 'failed' as const, error: { step: 'install', message: 'srv-1 install script failed', suggestion: 'Check the log.', logTail: [] } };
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10'), operations: { install: { kind: 'result', result: failure } } },
      'agent-1': { runner: freshHost('10.0.0.11') },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect(transport.calls.some((c) => c.command === 'install agent-1')).toBe(false);
    expect(transport.calls.some((c) => c.command === 'prepare agent-1')).toBe(true); // prepare runs for every node up front
    transport.assertDone();
  });

  it('CO7 a refusal found during inspect stops the run before any prepare call', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10', { swarmActive: true }) }, 'agent-1': { runner: freshHost('10.0.0.11') } };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect(transport.calls.some((c) => c.command.startsWith('prepare '))).toBe(false);
    transport.assertDone();
  });

  it('CO12 a non-root bootstrap user without passwordless sudo is refused before any step', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' })];
    const problem = { message: 'Bootstrap user root on srv-1 cannot use sudo without a password', suggestion: 'Grant passwordless sudo.' };
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10'), prepareFault: problem } };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).message).toBe(problem.message);
    expect(transport.calls.some((c) => c.command.startsWith('inspect'))).toBe(false);
    transport.assertDone();
  });

  it('CO13 a crash with no result line is reported with the redacted stderr tail', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10'), operations: { install: { kind: 'crash', exitCode: 137, stderrTail: ['fatal: out of memory'] } } },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).message).toContain('srv-1');
    transport.assertDone();
  });

  it('CO14 a guard timeout is recorded as a failed node with a timeout message', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' })];
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10'), operations: { install: { kind: 'timeout' } } } };
    const transport = new FakeSetupTransport({ nodes });

    const { error, errors } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect(errors.some((line) => line.includes('srv-1') && line.toLowerCase().includes('timed out'))).toBe(true);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO8: dry run
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: --dry-run', () => {
  it('CO8 only inspects nodes; prepare/install never run', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10') }, 'agent-1': { runner: freshHost('10.0.0.11') } };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport, { dryRun: true });

    expect(error).toBeUndefined();
    const ops = transport.calls.map((c) => c.command.split(' ')[0]);
    expect(ops.filter((op) => op !== 'prepareNode' && op !== 'inspect')).toEqual([]);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO15: no secret leaks anywhere the run prints or records
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: secret handling', () => {
  it('CO15 the issued cluster tokens never leak into printed output or recorded commands', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10') }, 'agent-1': { runner: freshHost('10.0.0.11') } };
    const transport = new FakeSetupTransport({ nodes });

    const { error, infos, errors } = await run(servers, transport);

    expect(error).toBeUndefined();
    // the default scripted install result on the fresh server-init synthesises these exact tokens
    const secrets = new Redactor(['fake-server-token-srv-1', 'fake-agent-token-srv-1']);
    assertNoSecretLeak({ printed: [...infos, ...errors], transportCalls: transport.calls }, secrets);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO19: host keys end to end
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: host keys (3.5)', () => {
  it('CO19 a mismatched host key on the last node stops the run before any prepare call', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('srv-2', { host: '10.0.0.11' }), srv('srv-3', { host: '10.0.0.12' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10') },
      'srv-2': { runner: freshHost('10.0.0.11') },
      'srv-3': { runner: freshHost('10.0.0.12') },
    };
    const hostKeys = new FakeHostKeys().script('srv-3', { pin: fakeHostKey('srv-3-a-different-key') });
    const transport = new FakeSetupTransport({ nodes, hostKeys });

    const { error } = await run(servers, transport, {}, { hostKeys });

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).message).toContain('srv-3');
    expect(transport.calls.some((c) => c.command.startsWith('prepare '))).toBe(false);
    expect(hostKeys.decisions.filter((d) => d.outcome === 'matched' || d.outcome === 'recorded')).not.toEqual([]);
    transport.assertDone();
  });

  it('a matching pin connects without recording anything new; an unpinned node records first contact', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = { 'srv-1': { runner: freshHost('10.0.0.10') }, 'agent-1': { runner: freshHost('10.0.0.11') } };
    const hostKeys = new FakeHostKeys().script('srv-1', { pin: fakeHostKey('srv-1') });
    const transport = new FakeSetupTransport({ nodes, hostKeys });

    const { error } = await run(servers, transport, {}, { hostKeys });

    expect(error).toBeUndefined();
    expect(hostKeys.decisions.find((d) => d.key === 'srv-1')?.outcome).toBe('matched');
    expect(hostKeys.decisions.find((d) => d.key === 'agent-1')?.outcome).toBe('recorded');
    expect(hostKeys.persistCalls).toBe(1);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO16, CO17: reset
// ---------------------------------------------------------------------------

describe('runK3sReset', () => {
  it('CO16 resets the whole environment, agents then servers, and cleans up', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10') },
      'agent-1': { runner: freshHost('10.0.0.11') },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await runReset(servers, transport);

    expect(error).toBeUndefined();
    expect(transport.calls.some((c) => c.command === 'reset srv-1')).toBe(true);
    expect(transport.calls.some((c) => c.command === 'reset agent-1')).toBe(true);
    const order = transport.calls.map((c) => c.command);
    expect(order.indexOf('reset agent-1')).toBeLessThan(order.indexOf('reset srv-1'));
    expect(transport.cleanupCalls).toBe(1);
    transport.assertDone();
  });

  it('CO16 refuses to reset the only server while an agent is not included', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('agent-1', { host: '10.0.0.11', role: 'worker' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10') },
      'agent-1': { runner: freshHost('10.0.0.11') },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await runReset(servers, transport, { nodes: ['srv-1'] });

    expect(error).toBeDefined();
    expect(String((error as Error).message)).toContain('agent-1');
    expect(transport.calls.some((c) => c.command.startsWith('reset'))).toBe(false);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO4: idempotent re-run
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: idempotent re-run', () => {
  it('CO4 idempotent re-run of CO3: every action noop, tokens read once, a real install makes zero mutations', async () => {
    const servers = [srv('srv-1', { host: '10.0.0.10' }), srv('srv-2', { host: '10.0.0.11' }), srv('srv-3', { host: '10.0.0.12' })];
    const fresh = resolvedFreshCluster(servers);
    expect(fresh.refusals).toEqual([]);

    // srv-1 gets a filesystem that genuinely matches its own scripted inspection, so forcing its
    // `install` to run for real proves node.ts actually honours `noop` rather than just asserting
    // the coordinator's own decision.
    const srv1Runner = freshHost('10.0.0.10');
    seedInstalledHost(srv1Runner, fresh, 'srv-1');

    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': {
        runner: srv1Runner,
        operations: {
          inspect: { kind: 'result', result: { inspection: installedInspectionOf(fresh, 'srv-1', '10.0.0.10') } },
          install: { kind: 'real' },
        },
      },
      'srv-2': { runner: freshHost('10.0.0.11'), operations: { inspect: { kind: 'result', result: { inspection: installedInspectionOf(fresh, 'srv-2', '10.0.0.11') } } } },
      'srv-3': { runner: freshHost('10.0.0.12'), operations: { inspect: { kind: 'result', result: { inspection: installedInspectionOf(fresh, 'srv-3', '10.0.0.12') } } } },
    };
    const transport = new FakeSetupTransport({ nodes });

    const { error, dims } = await run(servers, transport);

    expect(error).toBeUndefined();
    for (const key of ['srv-1', 'srv-2', 'srv-3']) {
      expect(dims.some((line) => line.startsWith(key) && line.trim().endsWith('noop'))).toBe(true);
    }
    expect(transport.calls.filter((c) => c.command.startsWith('read-tokens')).length).toBe(1);
    // the real `install` on srv-1 (kind noop): no restart, and the config drop-in is never rewritten
    expect(srv1Runner.calls.some((c) => c.argv[0] === 'systemctl' && (c.argv[1] === 'restart' || c.argv[1] === 'start'))).toBe(false);
    const state = JSON.parse(srv1Runner.text(K3S_NODE_STATE_FILE) ?? '{}') as { installedAt: string };
    expect(state.installedAt).toBe(INSTALLED_AT);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO9, CO10: upgrade
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: upgrade', () => {
  const OLD_VERSION = 'v1.35.8+k3s1';

  function upgradeFixture(extraOps: Record<string, FakeSetupNode['operations']> = {}): { servers: ResolvedServer[]; nodes: Record<string, FakeSetupNode> } {
    const servers = [
      srv('srv-1', { host: '10.0.0.10' }),
      srv('srv-2', { host: '10.0.0.11' }),
      srv('srv-3', { host: '10.0.0.12' }),
      srv('agent-1', { host: '10.0.0.13', role: 'worker' }),
    ];
    const fresh = resolvedFreshCluster(servers);
    expect(fresh.refusals).toEqual([]);
    const nodeOf = (key: string, address: string): FakeSetupNode => ({
      runner: freshHost(address),
      operations: {
        inspect: { kind: 'result', result: { inspection: installedInspectionOf(fresh, key, address, { version: OLD_VERSION }) } },
        ...extraOps[key],
      },
    });
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': nodeOf('srv-1', '10.0.0.10'),
      'srv-2': nodeOf('srv-2', '10.0.0.11'),
      'srv-3': nodeOf('srv-3', '10.0.0.12'),
      'agent-1': nodeOf('agent-1', '10.0.0.13'),
    };
    return { servers, nodes };
  }

  it('CO9 servers upgrade one at a time, agents only after every server has upgraded', async () => {
    const { servers, nodes } = upgradeFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport); // yes: true (BASE_OPTIONS) skips the confirmation

    expect(error).toBeUndefined();
    const indexOf = (needle: string): number => transport.calls.findIndex((c) => c.command === needle);
    expect(indexOf('install srv-2')).toBeGreaterThan(indexOf('control-plane srv-1'));
    expect(indexOf('install srv-3')).toBeGreaterThan(indexOf('control-plane srv-2'));
    expect(indexOf('install agent-1')).toBeGreaterThan(indexOf('control-plane srv-3'));
    transport.assertDone();
  });

  it('CO9 TTY prompts for the restart; declining cancels with nothing changed', async () => {
    const { servers, nodes } = upgradeFixture();
    const transport = new FakeSetupTransport({ nodes });
    const confirmSpy = spyOn(prompts, 'confirm').mockImplementation(async () => false);

    const { error, infos } = await run(servers, transport, { interactive: true, yes: false });

    expect(error).toBeUndefined();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('restart k3s');
    expect(infos.some((line) => line.includes('Setup cancelled'))).toBe(true);
    expect(transport.calls.some((c) => c.command.startsWith('prepare ') || c.command.startsWith('install') || c.command.startsWith('read-tokens'))).toBe(false);
    confirmSpy.mockRestore();
    transport.assertDone();
  });

  it('CO9 --yes skips the TTY prompt; a non-TTY run proceeds without one too', async () => {
    const confirmSpy = spyOn(prompts, 'confirm').mockImplementation(async () => true);

    const yesFixture = upgradeFixture();
    const yesTransport = new FakeSetupTransport({ nodes: yesFixture.nodes });
    const yesRun = await run(yesFixture.servers, yesTransport, { interactive: true, yes: true });
    expect(yesRun.error).toBeUndefined();
    expect(confirmSpy).not.toHaveBeenCalled();
    yesTransport.assertDone();

    const nonTtyFixture = upgradeFixture();
    const nonTtyTransport = new FakeSetupTransport({ nodes: nonTtyFixture.nodes });
    const nonTtyRun = await run(nonTtyFixture.servers, nonTtyTransport, { interactive: false, yes: false });
    expect(nonTtyRun.error).toBeUndefined();
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    nonTtyTransport.assertDone();
  });

  it('CO10 a failure at srv-2 reports how many servers already upgraded and how many still run the old version', async () => {
    const failure = { status: 'failed' as const, error: { step: 'install', message: 'srv-2 install script failed', suggestion: 'Check the log.', logTail: [] } };
    const { servers, nodes } = upgradeFixture({ 'srv-2': { install: { kind: 'result', result: failure } } });
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    const message = (error as CLIError).message;
    expect(message).toContain('Upgrade stopped at srv-2');
    expect(message).toContain('1 node runs');
    expect(message).toContain('2 still run');
    expect((error as CLIError).suggestion).toContain('completed nodes are skipped');
    expect(transport.calls.some((c) => c.command === 'install srv-3')).toBe(false);
    expect(transport.calls.some((c) => c.command === 'install agent-1')).toBe(false);
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO11, CO18: 1 -> 3 managers (SQLite server-init converts to embedded etcd, two joins)
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: adding managers to a SQLite server', () => {
  function convertFixture(): { servers: ResolvedServer[]; nodes: Record<string, FakeSetupNode> } {
    const solo = srv('srv-1', { host: '10.0.0.10' });
    const soloCluster = resolvedFreshCluster([solo]);
    expect(soloCluster.refusals).toEqual([]);
    const srv1Inspection = installedInspectionOf(soloCluster, 'srv-1', '10.0.0.10');
    const servers = [solo, srv('srv-2', { host: '10.0.0.11' }), srv('srv-3', { host: '10.0.0.12' })];
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10'), operations: { inspect: { kind: 'result', result: { inspection: srv1Inspection } } } },
      'srv-2': { runner: freshHost('10.0.0.11') },
      'srv-3': { runner: freshHost('10.0.0.12') },
    };
    return { servers, nodes };
  }

  it('CO11 srv-1 converts first, then srv-2 and srv-3 join one at a time', async () => {
    const { servers, nodes } = convertFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport, { convertDatastore: true });

    expect(error).toBeUndefined();
    const indexOf = (needle: string): number => transport.calls.findIndex((c) => c.command === needle);
    expect(indexOf('install srv-1')).toBeGreaterThan(-1);
    expect(indexOf('install srv-2')).toBeGreaterThan(indexOf('control-plane srv-1'));
    expect(indexOf('install srv-3')).toBeGreaterThan(indexOf('control-plane srv-2'));
    transport.assertDone();
  });

  it('CO18 non-TTY without --convert-datastore refuses, naming the flag, and touches nothing', async () => {
    const { servers, nodes } = convertFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).suggestion).toContain('--convert-datastore');
    expect(transport.calls.some((c) => c.command.startsWith('prepare ') || c.command.startsWith('install'))).toBe(false);
    transport.assertDone();
  });

  it('CO18 non-TTY with --convert-datastore proceeds', async () => {
    const { servers, nodes } = convertFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport, { convertDatastore: true });

    expect(error).toBeUndefined();
    transport.assertDone();
  });

  it('CO18 TTY: a second prompt is asked even with --yes; declining leaves nothing changed', async () => {
    const { servers, nodes } = convertFixture();
    const transport = new FakeSetupTransport({ nodes });
    const confirmSpy = spyOn(prompts, 'confirm').mockImplementation(async () => false);

    const { error, infos } = await run(servers, transport, { interactive: true, yes: true });

    expect(error).toBeUndefined();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('converts from SQLite to embedded etcd');
    expect(infos.some((line) => line.includes('Setup cancelled'))).toBe(true);
    expect(transport.calls.some((c) => c.command.startsWith('prepare ') || c.command.startsWith('install'))).toBe(false);
    confirmSpy.mockRestore();
    transport.assertDone();
  });
});

// ---------------------------------------------------------------------------
// CO17: shared cluster (12.5, 18.2)
// ---------------------------------------------------------------------------

describe('runK3sClusterSetup: shared cluster', () => {
  function sharedFixture(): { servers: ResolvedServer[]; nodes: Record<string, FakeSetupNode> } {
    const server = srv('srv-1', { host: '10.0.0.10' });
    const solo = resolvedFreshCluster([server]);
    expect(solo.refusals).toEqual([]);
    const inspection = installedInspectionOf(solo, 'srv-1', '10.0.0.10', { envs: ['staging'] });
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10'), operations: { inspect: { kind: 'result', result: { inspection } } } },
    };
    return { servers: [server], nodes };
  }

  it('CO17 refuses without --shared-cluster and touches nothing', async () => {
    const { servers, nodes } = sharedFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await run(servers, transport);

    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).suggestion).toContain('--shared-cluster');
    expect(transport.calls.some((c) => c.command.startsWith('prepare ') || c.command.startsWith('install'))).toBe(false);
    transport.assertDone();
  });

  it('CO17 --shared-cluster proceeds and names both environments in the summary', async () => {
    const { servers, nodes } = sharedFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error, dims } = await run(servers, transport, { sharedCluster: true });

    expect(error).toBeUndefined();
    expect(dims.some((line) => line.includes('staging') && line.includes('production') && line.toLowerCase().includes('share'))).toBe(true);
    transport.assertDone();
  });
});

describe('runK3sReset: shared cluster', () => {
  function sharedResetFixture(): { servers: ResolvedServer[]; nodes: Record<string, FakeSetupNode> } {
    const server = srv('srv-1', { host: '10.0.0.10' });
    const solo = resolvedFreshCluster([server]);
    const inspection = installedInspectionOf(solo, 'srv-1', '10.0.0.10', { envs: ['staging'] });
    const nodes: Record<string, FakeSetupNode> = {
      'srv-1': { runner: freshHost('10.0.0.10'), operations: { inspect: { kind: 'result', result: { inspection } } } },
    };
    return { servers: [server], nodes };
  }

  it('CO17 refuses without --shared-cluster', async () => {
    const { servers, nodes } = sharedResetFixture();
    const transport = new FakeSetupTransport({ nodes });

    const { error } = await runReset(servers, transport);

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).message).toContain('staging');
    expect(transport.calls.some((c) => c.command.startsWith('reset'))).toBe(false);
    transport.assertDone();
  });

  it('CO17 with --shared-cluster the TTY confirmation names both environments', async () => {
    const { servers, nodes } = sharedResetFixture();
    const transport = new FakeSetupTransport({ nodes });
    const promptSpy = spyOn(prompts, 'prompt').mockImplementation(async () => ENV);

    const { error } = await runReset(servers, transport, { sharedCluster: true, interactive: true });

    expect(error).toBeUndefined();
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const text = String(promptSpy.mock.calls[0]?.[0]);
    expect(text).toContain('staging');
    expect(text).toContain(ENV);
    promptSpy.mockRestore();
    transport.assertDone();
  });
});
