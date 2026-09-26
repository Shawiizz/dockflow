import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderK3sConfig } from '../../../../commands/setup/k3s/config';
import {
  CURL_FLAGS,
  K3S_AGENT_TOKEN_FILE,
  K3S_BINARY,
  K3S_TOKEN_FILE,
  NODE_STEP_GUARD_S,
} from '../../../../commands/setup/k3s/constants';
import { setupMessages } from '../../../../commands/setup/k3s/messages';
import {
  type BuildClusterPlanInput,
  buildClusterPlan,
  buildLocalPlan,
  buildNodePlan,
  compareK3sVersions,
  deployPublicKeyFor,
  finalizeClusterPlan,
  firstUpgradingServer,
  installSequence,
  isPrivateIpv4,
  isUnusableClusterAddress,
  type K3sClusterPlan,
  type K3sNodeInspection,
  type K3sResolvedCluster,
  type K3sSetupOptions,
  localNodeNameFor,
  type PlanWarning,
  parseK3sVersion,
  sqliteCopyPath,
  validateK3sFlags,
} from '../../../../commands/setup/k3s/plan';
import { parseNodeInspection, parseNodePlan, parseNodeState } from '../../../../commands/setup/k3s/schema';
import { K3S_PIN } from '../../../../services/orchestrator/kubernetes/k3s/versions';
import { M } from '../../../../services/orchestrator/messages';
import type { ResolvedServer } from '../../../../types/servers';
import type { DockflowConfig } from '../../../../utils/config';
import { CLIError, ConfigError, ConnectionError, ErrorCode, ValidationError } from '../../../../utils/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEYS = join(import.meta.dir, 'golden', 'keys');
const keyFile = (name: string): string => readFileSync(join(KEYS, name), 'utf8');
const DEPLOY_KEY = keyFile('deploy_ed25519');
const PIN = K3S_PIN.version;
const GIB = 1024 ** 3;
const CA = 'c0ffee00'.repeat(8);
const ENV = 'production';

const OPTIONS: K3sSetupOptions = {
  sshUser: 'root',
  dryRun: false,
  yes: false,
  upgrade: false,
  convertDatastore: false,
  sharedCluster: false,
  flannelBackend: null,
  skipFirewall: false,
  skipNetworkCheck: false,
  skipReachabilityCheck: false,
  insecureHostKey: false,
  requireHostKey: false,
  rotateDeployToken: false,
  binary: null,
  dev: false,
  interactive: false,
};

const CONFIG = { project_name: 'shop', orchestrator: 'k3s' } as DockflowConfig;

interface ServerInput {
  host?: string;
  private_host?: string;
  role?: 'manager' | 'worker';
  tags?: string[];
  user?: string;
  labels?: Record<string, string>;
}

/** A ResolvedServer as resolveServersForEnvironment builds it: privateHost falls back to host. */
function srv(name: string, input: ServerInput = {}): ResolvedServer {
  const host = input.host ?? '203.0.113.10';
  return {
    name,
    role: input.role ?? 'manager',
    host,
    privateHost: input.private_host ?? host,
    declaredPrivateHost: input.private_host ?? null,
    nodeLabels: input.labels ?? {},
    port: 22,
    user: input.user ?? 'deploy',
    env: {},
    tags: input.tags ?? [ENV],
  };
}

const worker = (name: string, input: ServerInput = {}): ResolvedServer => srv(name, { ...input, role: 'worker' });

function planOf(
  servers: ResolvedServer[],
  options: Partial<K3sSetupOptions> = {},
  extra: Partial<BuildClusterPlanInput> = {},
): K3sClusterPlan {
  return buildClusterPlan({
    env: ENV,
    config: CONFIG,
    servers,
    deployKeys: Object.fromEntries(servers.map((server) => [server.name, DEPLOY_KEY])),
    options: { ...OPTIONS, ...options },
    dockflowVersion: '1.9.0',
    ...extra,
  });
}

function freshInspection(localIpv4: string[], patch?: (inspection: K3sNodeInspection) => void): K3sNodeInspection {
  const inspection: K3sNodeInspection = {
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
    firewall: { ufw: 'active', firewalld: 'absent' },
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
  patch?.(inspection);
  return inspection;
}

function nodeOf(cluster: K3sResolvedCluster, key: string) {
  const node = cluster.plan.nodes.find((candidate) => candidate.key === key);
  if (node === undefined) throw new Error(`no node ${key}`);
  return node;
}

/** The inspection of a node a previous run installed with the decisions of `cluster`. */
function installedInspection(
  cluster: K3sResolvedCluster,
  key: string,
  localIpv4: string[],
  patch?: (inspection: K3sNodeInspection) => void,
  version: string = PIN,
): K3sNodeInspection {
  const node = nodeOf(cluster, key);
  const isServer = node.role !== 'agent';
  const render = renderK3sConfig(node, {
    env: cluster.plan.env,
    addressMode: cluster.addressMode,
    flannelBackend: cluster.flannelBackend,
    clusterInit: cluster.clusterInitNode === key,
    network: cluster.network[key],
    joinUrl: cluster.joinUrls[key],
  });
  return freshInspection(localIpv4, (inspection) => {
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
        dockflowVersion: '1.9.0',
        envs: [ENV],
        nodeName: node.nodeName,
        role: isServer ? 'server' : 'agent',
        clusterInit: cluster.clusterInitNode === key,
        datastore: isServer ? cluster.datastore : null,
        flannelBackend: cluster.flannelBackend,
        k3sVersion: version,
        configSha256: render.sha256,
        restartSha256: render.restartSha256,
        caSha256: CA,
        installedAt: '2026-09-17T10:00:00Z',
        updatedAt: '2026-09-17T10:00:00Z',
      },
      dropinSha256: render.sha256,
      restartSha256: render.restartSha256,
      dropin: { ...render.values },
      caSha256: CA,
      datastore: isServer ? cluster.datastore : null,
      apiReady: isServer ? true : null,
      netcheckPresent: isServer ? false : null,
      defaultStorageClasses: isServer ? [{ name: 'dockflow-local', createdAt: '2026-09-17T10:01:00Z' }] : null,
    };
    patch?.(inspection);
  });
}

// design-05 2.4 worked plans
const EXAMPLE_A = [srv('main', { host: '203.0.113.10' })];
const EXAMPLE_B = [
  srv('srv-1', { host: '203.0.113.10', private_host: '10.0.0.10' }),
  worker('worker-1', { host: '203.0.113.21', private_host: '10.0.0.21' }),
  worker('worker-2', { host: '203.0.113.22', private_host: '10.0.0.22' }),
];
const EXAMPLE_C = [
  srv('srv-1', { host: '203.0.113.10', private_host: '10.0.0.10' }),
  srv('srv-2', { host: '203.0.113.11', private_host: '10.0.0.11' }),
  srv('srv-3', { host: '203.0.113.12', private_host: '10.0.0.12' }),
  worker('worker-1', { host: '203.0.113.21', private_host: '10.0.0.21' }),
];
const EXAMPLE_D = [
  srv('srv-1', { host: '203.0.113.10', private_host: '10.0.0.10' }),
  srv('srv-2', { host: '203.0.113.11', private_host: '10.0.0.11' }),
  srv('srv-3', { host: '203.0.113.12', private_host: '10.0.0.12' }),
  worker('worker-9', { host: '198.51.100.9' }),
];

/** local addresses: the private address when there is one, the public one only for directly attached hosts */
const LOCALS: Record<string, string[]> = {
  main: ['203.0.113.10'],
  'srv-1': ['10.0.0.10'],
  'srv-2': ['10.0.0.11'],
  'srv-3': ['10.0.0.12'],
  'worker-1': ['10.0.0.21'],
  'worker-2': ['10.0.0.22'],
  'worker-3': ['10.0.0.23'],
  'worker-9': ['198.51.100.9'],
};

function freshInspections(plan: K3sClusterPlan, patches: Record<string, (i: K3sNodeInspection) => void> = {}): Record<string, K3sNodeInspection> {
  return Object.fromEntries(plan.nodes.map((node) => [node.key, freshInspection(LOCALS[node.key] ?? [], patches[node.key])]));
}

/** Finalizes a fresh run, then returns the inspections a re-run sees on the installed nodes. */
function installedCluster(
  servers: ResolvedServer[],
  patches: Record<string, (i: K3sNodeInspection) => void> = {},
  version: string = PIN,
): Record<string, K3sNodeInspection> {
  const plan = planOf(servers);
  const cluster = finalizeClusterPlan(plan, freshInspections(plan));
  expect(cluster.refusals).toEqual([]);
  return Object.fromEntries(
    plan.nodes.map((node) => [node.key, installedInspection(cluster, node.key, LOCALS[node.key] ?? [], patches[node.key], version)]),
  );
}

const messagesOf = (cluster: K3sResolvedCluster): string[] => cluster.refusals.map((r) => r.message);
const warningsOf = (cluster: K3sResolvedCluster): string[] => cluster.warnings.map((w) => w.message);

// ---------------------------------------------------------------------------
// buildClusterPlan (2.1)
// ---------------------------------------------------------------------------

describe('buildClusterPlan: topology and order (P1-P3, U-SETUP-PLAN-01/02)', () => {
  it('P1 single manager: server-init only, no join URL', () => {
    const plan = planOf(EXAMPLE_A);
    expect(plan.nodes.map((n) => [n.key, n.role])).toEqual([['main', 'server-init']]);
    const sequence = installSequence(plan);
    expect(sequence.servers.map((n) => n.key)).toEqual(['main']);
    expect(sequence.agents).toEqual([]);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    expect(cluster.joinUrls).toEqual({ main: null });
    expect(cluster.clusterInitNode).toBeNull();
  });

  it('P2 one manager and two workers: server-init, then the agents as one parallel group', () => {
    const plan = planOf(EXAMPLE_B);
    const sequence = installSequence(plan);
    expect(sequence.servers.map((n) => [n.key, n.role])).toEqual([['srv-1', 'server-init']]);
    expect(sequence.agents.map((n) => n.key)).toEqual(['worker-1', 'worker-2']);
    expect(sequence.agentConcurrency).toBe(4);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    // U-SETUP-PLAN-01: no cluster-init with one manager
    expect(cluster.clusterInitNode).toBeNull();
    expect(renderK3sConfig(nodeOf(cluster, 'srv-1'), { ...configContext(cluster, 'srv-1') }).values['cluster-init']).toBeUndefined();
  });

  it('P3 three managers: the first is cluster-init, datastore etcd, servers one at a time', () => {
    const plan = planOf([...EXAMPLE_C, worker('worker-2', { host: '203.0.113.22', private_host: '10.0.0.22' })]);
    const sequence = installSequence(plan);
    expect(sequence.servers.map((n) => [n.key, n.role])).toEqual([
      ['srv-1', 'server-init'],
      ['srv-2', 'server'],
      ['srv-3', 'server'],
    ]);
    expect(sequence.agents.map((n) => n.key)).toEqual(['worker-1', 'worker-2']);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    expect(cluster.refusals).toEqual([]);
    expect(cluster.clusterInitNode).toBe('srv-1');
    expect(cluster.datastore).toBe('etcd');
    // U-SETUP-PLAN-02: joins to the private address of srv-1
    expect(cluster.joinUrls).toEqual({
      'srv-1': null,
      'srv-2': 'https://10.0.0.10:6443',
      'srv-3': 'https://10.0.0.10:6443',
      'worker-1': 'https://10.0.0.10:6443',
      'worker-2': 'https://10.0.0.10:6443',
    });
  });

  it('lists servers before agents whatever the servers.yml order', () => {
    const plan = planOf([worker('worker-1', { private_host: '10.0.0.21' }), srv('srv-1', { private_host: '10.0.0.10' })]);
    expect(plan.nodes.map((n) => n.key)).toEqual(['srv-1', 'worker-1']);
  });
});

describe('buildClusterPlan: validation before any SSH (P4-P9, 2.1)', () => {
  const managers = (n: number): ResolvedServer[] =>
    Array.from({ length: n }, (_, i) => srv(`srv-${i + 1}`, { host: `203.0.113.${10 + i}`, private_host: `10.0.0.${10 + i}` }));

  it('P4 refuses every even manager count with M.managerCount and accepts odd counts', () => {
    for (const count of [2, 4, 6]) {
      expect(() => planOf(managers(count))).toThrow(new ConfigError(M.managerCount(ENV, count)));
      expect(() => planOf(managers(count))).toThrow(
        `servers: tag "production" has ${count} managers; an embedded-etcd cluster needs an odd number, so declare 1 or 3`,
      );
    }
    for (const count of [1, 3, 5]) expect(planOf(managers(count)).nodes).toHaveLength(count);
  });

  it('P5 refuses two keys with the same node name with M.duplicateNode', () => {
    const servers = [srv('web_1', { private_host: '10.0.0.10' }), worker('web-1', { private_host: '10.0.0.11' })];
    expect(() => planOf(servers)).toThrow(M.duplicateNode('web_1', 'web-1', 'web-1'));
    expect(() => planOf(servers)).toThrow('servers: "web_1" and "web-1" both become node name "web-1"; rename one');
  });

  it('P6 refuses IPv6 cluster addresses and a localhost host without private_host', () => {
    expect(() => planOf([srv('srv-1', { private_host: 'fd00::10' })])).toThrow(M.privateHostIpv6K3s('srv-1'));
    expect(() => planOf([srv('srv-1', { host: '2001:db8::10' })])).toThrow(M.privateHostIpv6K3s('srv-1'));
    let thrown: unknown;
    try {
      planOf([srv('srv-1', { host: 'localhost' })]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toBe('servers.srv-1.host is localhost; k3s needs the address other nodes use to reach srv-1');
    expect((thrown as ConfigError).suggestion).toBe('Set private_host.');
    // with private_host, localhost is only the SSH address (the e2e topology)
    expect(planOf([srv('srv-1', { host: 'localhost', private_host: '172.20.0.10' })]).nodes[0].hostName).toBe('localhost');
  });

  it('refuses loopback, link-local, this-network and multicast cluster addresses', () => {
    for (const address of ['127.0.0.2', '169.254.10.1', '0.0.0.0', '224.0.0.5']) {
      expect(() => planOf([srv('srv-1', { private_host: address })])).toThrow(setupMessages.clusterAddressUnusable('srv-1', address).message);
      expect(() => planOf([srv('srv-1', { host: address })])).toThrow(setupMessages.clusterAddressUnusable('srv-1', address).message);
    }
  });

  it('refuses two nodes sharing a private_host', () => {
    const servers = [srv('srv-1', { private_host: '10.0.0.10' }), worker('worker-1', { host: '203.0.113.21', private_host: '10.0.0.10' })];
    expect(() => planOf(servers)).toThrow('Servers srv-1 and worker-1 declare the same private_host 10.0.0.10');
  });

  it('refuses a key that does not map to a node name', () => {
    expect(() => planOf([srv('web.1', { private_host: '10.0.0.10' })])).toThrow(
      'servers.web.1 does not map to a Kubernetes node name (web.1)',
    );
    const long = 'a'.repeat(64);
    expect(() => planOf([srv(long, { private_host: '10.0.0.10' })])).toThrow(setupMessages.nodeNameInvalid(long, long).message);
  });

  it('P7 refuses a node without deploy credentials with a ConnectionError', () => {
    const servers = EXAMPLE_B;
    const deployKeys: Record<string, string> = { 'srv-1': DEPLOY_KEY, 'worker-2': DEPLOY_KEY };
    let thrown: unknown;
    try {
      planOf(servers, {}, { deployKeys });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectionError);
    expect((thrown as ConnectionError).message).toBe(
      'No deploy SSH key for worker-1 (PRODUCTION_WORKER-1_CONNECTION or PRODUCTION_SSH_PRIVATE_KEY)',
    );
    expect((thrown as ConnectionError).suggestion).toBe(
      'Setup authorizes the deploy key on every node and checks the deploy identity with it. Add the key to .env.dockflow or CI secrets first.',
    );
  });

  it('refuses a deploy user that is not a valid Linux user name', () => {
    for (const user of ['Deploy', 'bad user', 'a:b', 'root,x', '1user']) {
      expect(() => planOf([srv('srv-1', { private_host: '10.0.0.10', user })])).toThrow(
        `servers.srv-1.user ${user} is not a valid Linux user name`,
      );
    }
  });

  it('P8 derives the deploy public key like ssh-keygen -y, for ed25519 and RSA (OpenSSH and PEM)', () => {
    const expected = (name: string): string => keyFile(name).trim().split(' ').slice(0, 2).join(' ');
    expect(deployPublicKeyFor(keyFile('deploy_ed25519'))).toEqual({ line: `${expected('deploy_ed25519.pub.expected')} dockflow-deploy` });
    expect(deployPublicKeyFor(keyFile('deploy_rsa'))).toEqual({ line: `${expected('deploy_rsa.pub.expected')} dockflow-deploy` });
    expect(deployPublicKeyFor(keyFile('deploy_rsa_pem'))).toEqual({ line: `${expected('deploy_rsa.pub.expected')} dockflow-deploy` });
    expect(planOf(EXAMPLE_A).nodes[0].deployPublicKey).toBe(`${expected('deploy_ed25519.pub.expected')} dockflow-deploy`);
  });

  it('P8 refuses an encrypted, a public or a garbage deploy key', () => {
    const encrypted = deployPublicKeyFor(keyFile('deploy_encrypted'));
    expect('error' in encrypted && encrypted.error).toContain('passphrase');
    expect(deployPublicKeyFor(keyFile('deploy_ed25519.pub.expected'))).toEqual({ error: 'this is a public key, not a private key' });
    expect('error' in deployPublicKeyFor('not a key')).toBe(true);
    expect(() => planOf(EXAMPLE_A, {}, { deployKeys: { main: keyFile('deploy_encrypted') } })).toThrow(
      /^The deploy key for main cannot be parsed \(.*passphrase.*\)$/,
    );
  });

  it('P9 refuses a Swarm config.yml and derives proxyPorts from the proxy block', () => {
    const swarm = { project_name: 'shop', orchestrator: 'swarm' } as DockflowConfig;
    expect(() => planOf(EXAMPLE_A, {}, { config: swarm })).toThrow(
      new ConfigError('config.yml sets orchestrator: swarm; k3s setup needs orchestrator: k3s'),
    );
    const implicit = { project_name: 'shop' } as DockflowConfig;
    expect(() => planOf(EXAMPLE_A, {}, { config: implicit })).toThrow('config.yml sets orchestrator: swarm');

    const none = planOf(EXAMPLE_A, {}, { config: null });
    expect(none.proxyPorts).toEqual({ http: false, https: false });
    expect(none.project).toBeNull();
    const httpOnly = planOf(EXAMPLE_A, {}, { config: { ...CONFIG, proxy: { enabled: true, acme: false } } as DockflowConfig });
    expect(httpOnly.proxyPorts).toEqual({ http: true, https: false });
    const acme = planOf(EXAMPLE_A, {}, { config: { ...CONFIG, proxy: { enabled: true, email: 'ops@example.com' } } as DockflowConfig });
    expect(acme.proxyPorts).toEqual({ http: true, https: true });
    expect(acme.project).toBe('shop');
  });

  it('refuses an environment without servers or without a manager', () => {
    let thrown: unknown;
    try {
      planOf([srv('srv-1', { tags: ['staging'] })], {}, { availableEnvironments: ['staging'] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).code).toBe(ErrorCode.NO_SERVERS_FOR_ENV);
    expect((thrown as CLIError).message).toBe('No servers found with tag "production"');
    expect((thrown as CLIError).suggestion).toBe('Available environments: staging');
    expect(() => planOf([worker('worker-1', { private_host: '10.0.0.21' })])).toThrow(
      new ConfigError('Environment production has no manager (k3s server)'),
    );
  });

  it('U-SETUP-PLAN-08 excludes servers of other environments', () => {
    const plan = planOf([...EXAMPLE_B, srv('stage-1', { host: '203.0.113.99', tags: ['staging'] })]);
    expect(plan.nodes.map((n) => n.key)).toEqual(['srv-1', 'worker-1', 'worker-2']);
  });

  it('records the node addresses as written', () => {
    const plan = planOf([
      srv('srv-1', { host: '203.0.113.10', private_host: '10.0.0.10' }),
      worker('worker-1', { host: 'worker-1.example.com' }),
      worker('worker-2', { host: '10.0.0.22' }),
    ]);
    expect(plan.nodes.map((n) => [n.key, n.privateHost, n.hostIp, n.hostName])).toEqual([
      ['srv-1', '10.0.0.10', '203.0.113.10', null],
      ['worker-1', null, null, 'worker-1.example.com'],
      ['worker-2', null, '10.0.0.22', null],
    ]);
    expect(plan.nodes[0].ssh).toEqual({ host: '203.0.113.10', port: 22 });
    expect(plan.nodes[0].deployUser).toBe('deploy');
  });

  it('keeps a private_host written equal to host as declared, unlike the fallback to host', () => {
    const declared = managers(3).map((server) => ({ ...server, privateHost: server.host, declaredPrivateHost: server.host }));
    const plan = planOf(declared);
    expect(plan.nodes.map((n) => n.privateHost)).toEqual(['203.0.113.10', '203.0.113.11', '203.0.113.12']);

    const fallback = managers(3).map((server) => ({ ...server, privateHost: server.host, declaredPrivateHost: null }));
    expect(() => planOf(fallback)).toThrow(setupMessages.haNeedsPrivateNetwork(['srv-1', 'srv-2', 'srv-3']).message);
  });

  it('carries the flags finalizeClusterPlan and the node steps act on', () => {
    const plan = planOf(EXAMPLE_A, { sharedCluster: true, skipFirewall: true, convertDatastore: true, interactive: true, rotateDeployToken: true });
    expect(plan.flags).toEqual({
      sharedCluster: true,
      skipFirewall: true,
      skipNetworkCheck: false,
      rotateDeployToken: true,
      convertDatastore: true,
      interactive: true,
    });
    expect(plan.dockflowVersion).toBe('1.9.0');
    expect(plan.env).toBe(ENV);
  });
});

describe('validateK3sFlags (2.1, 19.1)', () => {
  it('refuses the invalid combinations with ValidationError', () => {
    expect(() => validateK3sFlags({ node: ['srv-1'] })).toThrow(new ValidationError('--node is only valid with --reset'));
    expect(() => validateK3sFlags({ deleteVolumes: true })).toThrow(new ValidationError('--delete-volumes is only valid with --reset'));
    expect(() => validateK3sFlags({ binary: './dockflow', dev: true })).toThrow(new ValidationError('--binary and --dev cannot be combined'));
    expect(() => validateK3sFlags({ insecureHostKey: true, requireHostKey: true })).toThrow(
      new ValidationError('--insecure-host-key and --require-host-key cannot be combined'),
    );
    expect(() => validateK3sFlags({ flannelBackend: 'host-gw' })).toThrow(new ValidationError('--flannel-backend must be vxlan or wireguard-native'));
    expect(() => planOf(EXAMPLE_A, { flannelBackend: 'ipsec' })).toThrow(ValidationError);
    expect(() => planOf(EXAMPLE_A, { binary: './dockflow', dev: true })).toThrow('--binary and --dev cannot be combined');
  });

  it('accepts the valid combinations and returns the requested backend', () => {
    expect(validateK3sFlags({})).toBeNull();
    expect(validateK3sFlags({ reset: true, node: ['srv-1'], deleteVolumes: true })).toBeNull();
    expect(validateK3sFlags({ flannelBackend: 'wireguard-native' })).toBe('wireguard-native');
    expect(planOf(EXAMPLE_A, { flannelBackend: 'vxlan' }).requestedBackend).toBe('vxlan');
  });
});

describe('buildLocalPlan (P10, 4.8)', () => {
  it('applies the single-host defaults', () => {
    const plan = buildLocalPlan({
      nodeName: 'main',
      deployUser: 'dockflow',
      deployPublicKey: null,
      privateHost: null,
      publicHost: '203.0.113.10',
      requestedBackend: null,
      dockflowVersion: '1.9.0',
    });
    expect(plan).toEqual({
      schema: 1,
      env: '',
      project: null,
      dockflowVersion: '1.9.0',
      proxyPorts: { http: false, https: false },
      nodes: [
        {
          key: 'main',
          nodeName: 'main',
          role: 'server-init',
          ssh: { host: '203.0.113.10', port: 22 },
          deployUser: 'dockflow',
          deployPublicKey: null,
          privateHost: null,
          hostIp: '203.0.113.10',
          hostName: null,
          nodeLabels: {},
        },
      ],
      requestedBackend: null,
      flags: {
        sharedCluster: false,
        skipFirewall: false,
        skipNetworkCheck: true,
        rotateDeployToken: false,
        convertDatastore: false,
        interactive: false,
      },
    });
  });

  it('maps the node name like a servers.yml key and validates the local flags', () => {
    const input = {
      nodeName: 'web_1',
      deployUser: 'dockflow',
      deployPublicKey: null,
      privateHost: '10.0.0.5',
      publicHost: null,
      requestedBackend: 'vxlan' as const,
      dockflowVersion: '1.9.0',
    };
    const plan = buildLocalPlan(input);
    expect(plan.nodes[0].nodeName).toBe('web-1');
    expect(plan.nodes[0].ssh.host).toBe('localhost');
    expect(plan.requestedBackend).toBe('vxlan');
    expect(() => buildLocalPlan({ ...input, nodeName: 'Web 1' })).toThrow(new ValidationError('--node-name Web 1 is not a valid node name'));
    expect(() => buildLocalPlan({ ...input, deployUser: 'Bad User' })).toThrow('--user Bad User is not a valid Linux user name');
    expect(() => buildLocalPlan({ ...input, privateHost: '127.0.0.1' })).toThrow('--private-host 127.0.0.1 must be an IPv4 address');
    expect(() => buildLocalPlan({ ...input, privateHost: 'fd00::1' })).toThrow(ValidationError);
    expect(localNodeNameFor('Web_1.example.com')).toBe('web-1');
    expect(localNodeNameFor('main')).toBe('main');
  });

  it('resolves like a single fresh server', () => {
    const plan = buildLocalPlan({
      nodeName: 'main',
      deployUser: 'dockflow',
      deployPublicKey: null,
      privateHost: '10.0.0.5',
      publicHost: null,
      requestedBackend: null,
      dockflowVersion: '1.9.0',
    });
    const cluster = finalizeClusterPlan(plan, { main: freshInspection(['10.0.0.5']) });
    expect(cluster.refusals).toEqual([]);
    expect(cluster.flannelBackend).toBe('vxlan');
    expect(cluster.actions.main.kind).toBe('install');
    expect(renderK3sConfig(nodeOf(cluster, 'main'), configContext(cluster, 'main')).content).toBe(
      readFileSync(join(import.meta.dir, 'golden', 'server-init-local.yaml'), 'utf8'),
    );
  });
});

function configContext(cluster: K3sResolvedCluster, key: string) {
  return {
    env: cluster.plan.env,
    addressMode: cluster.addressMode,
    flannelBackend: cluster.flannelBackend,
    clusterInit: cluster.clusterInitNode === key,
    network: cluster.network[key],
    joinUrl: cluster.joinUrls[key],
  };
}

// ---------------------------------------------------------------------------
// finalizeClusterPlan (2.2, 2.4)
// ---------------------------------------------------------------------------

describe('finalizeClusterPlan: worked plans of design-05 2.4', () => {
  it('A single public server: public, wireguard-native, sqlite, no peers', () => {
    const plan = planOf(EXAMPLE_A);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    expect(cluster.refusals).toEqual([]);
    expect([cluster.addressMode, cluster.flannelBackend, cluster.datastore, cluster.fresh]).toEqual(['public', 'wireguard-native', 'sqlite', true]);
    expect(cluster.network.main).toEqual({
      privateIp: null,
      publicIp: '203.0.113.10',
      nodeIp: '203.0.113.10',
      nodeExternalIp: '203.0.113.10',
      peerSources: [],
      serverPeerSources: [],
      cniInterfaces: ['cni0', 'flannel-wg'],
    });
    expect(cluster.joinUrls.main).toBeNull();
  });

  it('B server and two agents on a private network', () => {
    const plan = planOf(EXAMPLE_B);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    expect(cluster.refusals).toEqual([]);
    expect([cluster.addressMode, cluster.flannelBackend, cluster.datastore]).toEqual(['private', 'vxlan', 'sqlite']);
    expect(cluster.joinUrls).toEqual({ 'srv-1': null, 'worker-1': 'https://10.0.0.10:6443', 'worker-2': 'https://10.0.0.10:6443' });
    expect(cluster.network['worker-1'].peerSources).toEqual(['10.0.0.10', '10.0.0.22', '203.0.113.10', '203.0.113.22']);
    expect(cluster.network['worker-1'].serverPeerSources).toEqual(['10.0.0.10', '203.0.113.10']);
    expect(cluster.network['worker-1'].cniInterfaces).toEqual(['cni0', 'flannel.1']);
    expect(cluster.network['srv-1'].nodeExternalIp).toBeNull();
    expect(Object.values(cluster.actions).map((a) => a.kind)).toEqual(['install', 'install', 'install']);
  });

  it('C HA: three servers and one agent, etcd, joins to srv-1', () => {
    const plan = planOf(EXAMPLE_C);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    expect(cluster.refusals).toEqual([]);
    expect([cluster.addressMode, cluster.flannelBackend, cluster.datastore, cluster.clusterInitNode]).toEqual([
      'private',
      'vxlan',
      'etcd',
      'srv-1',
    ]);
    expect(renderK3sConfig(nodeOf(cluster, 'srv-1'), configContext(cluster, 'srv-1')).content).toBe(
      readFileSync(join(import.meta.dir, 'golden', 'server-init-ha.yaml'), 'utf8'),
    );
    expect(renderK3sConfig(nodeOf(cluster, 'srv-2'), configContext(cluster, 'srv-2')).content).toBe(
      readFileSync(join(import.meta.dir, 'golden', 'server-join.yaml'), 'utf8'),
    );
    expect(renderK3sConfig(nodeOf(cluster, 'worker-1'), configContext(cluster, 'worker-1')).content).toBe(
      readFileSync(join(import.meta.dir, 'golden', 'agent.yaml'), 'utf8'),
    );
  });

  it('D hybrid: private servers and a remote public agent', () => {
    const plan = planOf(EXAMPLE_D);
    const cluster = finalizeClusterPlan(plan, freshInspections(plan));
    expect(cluster.refusals).toEqual([]);
    expect([cluster.addressMode, cluster.flannelBackend, cluster.datastore]).toEqual(['public', 'wireguard-native', 'etcd']);
    expect(cluster.network['srv-1']).toMatchObject({ nodeIp: '10.0.0.10', nodeExternalIp: '203.0.113.10' });
    expect(cluster.network['worker-9']).toMatchObject({ nodeIp: '198.51.100.9', nodeExternalIp: '198.51.100.9' });
    expect(cluster.joinUrls['srv-2']).toBe('https://10.0.0.10:6443');
    expect(cluster.joinUrls['worker-9']).toBe('https://203.0.113.10:6443');
    expect(renderK3sConfig(nodeOf(cluster, 'srv-1'), configContext(cluster, 'srv-1')).content).toBe(
      readFileSync(join(import.meta.dir, 'golden', 'server-public.yaml'), 'utf8'),
    );
    expect(renderK3sConfig(nodeOf(cluster, 'worker-9'), configContext(cluster, 'worker-9')).content).toBe(
      readFileSync(join(import.meta.dir, 'golden', 'agent-wireguard.yaml'), 'utf8'),
    );
  });
});

describe('finalizeClusterPlan: addresses and pod network (F1-F4, U-SETUP-PLAN-05/06)', () => {
  it('F1 all private -> vxlan; one node without private -> public/wireguard; --flannel-backend honoured on a fresh cluster', () => {
    const privatePlan = planOf(EXAMPLE_B);
    expect(finalizeClusterPlan(privatePlan, freshInspections(privatePlan)).flannelBackend).toBe('vxlan');

    const mixed = planOf([...EXAMPLE_B, worker('worker-9', { host: '198.51.100.9' })]);
    const mixedCluster = finalizeClusterPlan(mixed, freshInspections(mixed));
    expect(mixedCluster.refusals).toEqual([]);
    expect([mixedCluster.addressMode, mixedCluster.flannelBackend]).toEqual(['public', 'wireguard-native']);

    const requested = planOf(EXAMPLE_A, { flannelBackend: 'vxlan' });
    const requestedCluster = finalizeClusterPlan(requested, freshInspections(requested));
    expect(requestedCluster.flannelBackend).toBe('vxlan');
    expect(requestedCluster.network.main.cniInterfaces).toEqual(['cni0', 'flannel.1']);
  });

  it('F2 HA with a server lacking private_host is refused (DV-S1): before SSH for a public host literal', () => {
    const servers = [...EXAMPLE_C.slice(0, 2), srv('srv-3', { host: '203.0.113.12' }), EXAMPLE_C[3]];
    expect(() => planOf(servers)).toThrow(
      new ConfigError(
        'High availability needs the servers on a private network: srv-3 has no private_host (k3s does not support embedded etcd over public addresses)',
      ),
    );
    // a private host literal is a private address; one manager needs none
    expect(planOf([...EXAMPLE_C.slice(0, 2), srv('srv-3', { host: '10.0.0.12' })]).nodes).toHaveLength(3);
    expect(planOf([srv('srv-1', { host: '203.0.113.10' })]).nodes).toHaveLength(1);
  });

  it('F2 HA with a server lacking private_host is refused (DV-S1): after inspection for a host name', () => {
    const plan = planOf([...EXAMPLE_C.slice(0, 2), srv('srv-3', { host: 'srv-3.example.com' }), EXAMPLE_C[3]]);
    const cluster = finalizeClusterPlan(
      plan,
      freshInspections(plan, {
        'srv-3': (i) => {
          i.network.localIpv4 = ['203.0.113.12'];
          i.network.resolvedHost = '203.0.113.12';
        },
      }),
    );
    expect(cluster.refusals).toEqual([{ node: null, ...setupMessages.haNeedsPrivateNetwork(['srv-3']) }]);
    expect(cluster.addressMode).toBe('public');
  });

  it('F3 nodeIp is omitted when the public address is not local (NAT) and nodeExternalIp is set', () => {
    const plan = planOf(EXAMPLE_A);
    const cluster = finalizeClusterPlan(plan, { main: freshInspection(['10.10.0.5']) });
    expect(cluster.refusals).toEqual([]);
    expect(cluster.network.main).toMatchObject({ nodeIp: null, nodeExternalIp: '203.0.113.10', publicIp: '203.0.113.10' });
    expect(renderK3sConfig(nodeOf(cluster, 'main'), configContext(cluster, 'main')).values['node-ip']).toBeUndefined();
  });

  it('F4 a host name resolving to loopback on the node is refused', () => {
    const plan = planOf([srv('srv-1', { host: 'srv-1.example.com' })]);
    const cluster = finalizeClusterPlan(plan, { 'srv-1': freshInspection(['10.0.0.10'], (i) => (i.network.resolvedHost = '127.0.1.1')) });
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.hostResolvesToLoopback('srv-1', 'srv-1.example.com', '127.0.1.1') }]);
    expect(cluster.refusals[0].message).toBe('servers.srv-1.host srv-1.example.com resolves to 127.0.1.1 on srv-1; set private_host');
  });

  it('U-SETUP-PLAN-05 node-ip is the host literal, or the address the host name resolves to on the node', () => {
    const literal = planOf([srv('srv-1', { host: '10.0.0.10' })]);
    expect(finalizeClusterPlan(literal, { 'srv-1': freshInspection(['10.0.0.10']) }).network['srv-1'].nodeIp).toBe('10.0.0.10');

    const named = planOf([srv('srv-1', { host: 'srv-1.internal' })]);
    const cluster = finalizeClusterPlan(named, { 'srv-1': freshInspection(['10.0.0.10'], (i) => (i.network.resolvedHost = '10.0.0.10')) });
    expect(cluster.network['srv-1']).toMatchObject({ privateIp: '10.0.0.10', nodeIp: '10.0.0.10' });
    expect(cluster.addressMode).toBe('private');
  });

  it('refuses a node without any usable address, and a node without a public address in public mode', () => {
    const plan = planOf([srv('srv-1', { host: 'srv-1.example.com' })]);
    const cluster = finalizeClusterPlan(plan, { 'srv-1': freshInspection(['10.0.0.10']) });
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.noReachableAddress('srv-1') }]);

    const hybrid = planOf([srv('srv-1', { host: 'srv-1.internal', private_host: '10.0.0.10' }), worker('worker-9', { host: '198.51.100.9' })]);
    const hybridCluster = finalizeClusterPlan(hybrid, freshInspections(hybrid));
    expect(hybridCluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.noPublicAddress('srv-1', ['worker-9']) }]);
  });

  it('classifies private address ranges', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.255']) expect(isPrivateIpv4(ip)).toBe(true);
    for (const ip of ['172.32.0.1', '203.0.113.10', '100.128.0.1', '11.0.0.1']) expect(isPrivateIpv4(ip)).toBe(false);
    for (const ip of ['127.0.1.1', '169.254.0.1', '0.0.0.0', '239.1.1.1', '255.255.255.255']) expect(isUnusableClusterAddress(ip)).toBe(true);
    expect(isUnusableClusterAddress('10.0.0.1')).toBe(false);
  });
});

describe('finalizeClusterPlan: existing clusters (F6-F8, F10)', () => {
  it('an unchanged re-run is noop everywhere, with no refusal', () => {
    for (const servers of [EXAMPLE_A, EXAMPLE_B, EXAMPLE_C, EXAMPLE_D]) {
      const plan = planOf(servers);
      const cluster = finalizeClusterPlan(plan, installedCluster(servers));
      expect(cluster.refusals).toEqual([]);
      expect(cluster.fresh).toBe(false);
      expect(new Set(Object.values(cluster.actions).map((a) => a.kind))).toEqual(new Set(['noop']));
      expect(Object.values(cluster.actions).every((a) => a.fromVersion === PIN && a.toVersion === PIN)).toBe(true);
    }
  });

  it('F6 reordering servers.yml does not create a new cluster-init node', () => {
    const inspections = installedCluster(EXAMPLE_C);
    const reordered = planOf([EXAMPLE_C[1], EXAMPLE_C[0], EXAMPLE_C[2], EXAMPLE_C[3]]);
    expect(reordered.nodes[0]).toMatchObject({ key: 'srv-2', role: 'server-init' });
    const cluster = finalizeClusterPlan(reordered, inspections);
    expect(cluster.refusals).toEqual([]);
    expect(cluster.clusterInitNode).toBe('srv-1');
    expect(cluster.plan.nodes.filter((n) => n.role === 'server-init').map((n) => n.key)).toEqual(['srv-1']);
    expect(installSequence(cluster.plan).servers.map((n) => n.key)).toEqual(['srv-1', 'srv-2', 'srv-3']);
    expect(new Set(Object.values(cluster.actions).map((a) => a.kind))).toEqual(new Set(['noop']));
    expect(renderK3sConfig(nodeOf(cluster, 'srv-2'), configContext(cluster, 'srv-2')).values['cluster-init']).toBeUndefined();
  });

  it('F7 one to three managers: convert-to-etcd on the SQLite server, then two joins', () => {
    const single = [EXAMPLE_C[0]];
    const inspections = {
      ...installedCluster(single),
      'srv-2': freshInspection(['10.0.0.11']),
      'srv-3': freshInspection(['10.0.0.12']),
    };
    const plan = planOf(EXAMPLE_C.slice(0, 3), { convertDatastore: true });
    const cluster = finalizeClusterPlan(plan, inspections);
    expect(cluster.refusals).toEqual([]);
    expect(cluster.datastore).toBe('etcd');
    expect(cluster.clusterInitNode).toBe('srv-1');
    expect(cluster.actions['srv-1']).toEqual({ kind: 'convert-to-etcd', changedKeys: ['cluster-init'], fromVersion: PIN, toVersion: PIN });
    expect(cluster.actions['srv-2'].kind).toBe('install');
    expect(cluster.actions['srv-3'].kind).toBe('install');
    expect(cluster.joinUrls['srv-2']).toBe('https://10.0.0.10:6443');
    expect(cluster.joinUrls['srv-3']).toBe('https://10.0.0.10:6443');
  });

  it('F7 the conversion needs --convert-datastore without a terminal, and a terminal prompt otherwise', () => {
    const inspections = { ...installedCluster([EXAMPLE_C[0]]), 'srv-2': freshInspection(['10.0.0.11']), 'srv-3': freshInspection(['10.0.0.12']) };
    const refused = finalizeClusterPlan(planOf(EXAMPLE_C.slice(0, 3)), inspections);
    expect(refused.refusals).toEqual([{ node: 'srv-1', ...setupMessages.convertNeedsConsent(ENV, 'srv-1') }]);
    expect(refused.refusals[0].message).toBe(
      'Adding managers to production converts the datastore of srv-1 from SQLite to embedded etcd, which cannot be undone',
    );
    expect(finalizeClusterPlan(planOf(EXAMPLE_C.slice(0, 3), { interactive: true }), inspections).refusals).toEqual([]);
  });

  it('F8 a pod network change on an existing cluster is refused', () => {
    const inspections = { ...installedCluster(EXAMPLE_B), 'worker-9': freshInspection(['198.51.100.9']) };
    const cluster = finalizeClusterPlan(planOf([...EXAMPLE_B, worker('worker-9', { host: '198.51.100.9' })]), inspections);
    expect(cluster.refusals).toEqual([
      { node: null, ...setupMessages.flannelChange(ENV, 'vxlan', 'wireguard-native', 'worker-9 has no private_host') },
    ]);
    expect(cluster.refusals[0].message).toBe(
      'The flannel backend of production is vxlan; Dockflow would now use wireguard-native (worker-9 has no private_host)',
    );
    expect(cluster.flannelBackend).toBe('vxlan');

    const requested = finalizeClusterPlan(planOf(EXAMPLE_B, { flannelBackend: 'wireguard-native' }), installedCluster(EXAMPLE_B));
    expect(requested.refusals).toEqual([{ node: null, ...setupMessages.flannelChange(ENV, 'vxlan', 'wireguard-native', '--flannel-backend') }]);
  });

  it('keeps vxlan on a single public server installed with --flannel-backend vxlan', () => {
    const plan = planOf(EXAMPLE_A, { flannelBackend: 'vxlan' });
    const fresh = finalizeClusterPlan(plan, freshInspections(plan));
    const inspections = { main: installedInspection(fresh, 'main', LOCALS.main) };
    const rerun = finalizeClusterPlan(planOf(EXAMPLE_A), inspections);
    expect(rerun.refusals).toEqual([]);
    expect(rerun.flannelBackend).toBe('vxlan');
    expect(rerun.actions.main.kind).toBe('noop');
  });

  it('F10 the join URL is the first ready managed server when the first manager is down', () => {
    const inspections = {
      ...installedCluster(EXAMPLE_C, {
        'srv-1': (i) => {
          i.k3s.activeState = 'failed';
          i.k3s.subState = 'failed';
          i.k3s.apiReady = false;
        },
      }),
      'worker-2': freshInspection(['10.0.0.22']),
    };
    const cluster = finalizeClusterPlan(planOf([...EXAMPLE_C, worker('worker-2', { host: '203.0.113.22', private_host: '10.0.0.22' })]), inspections);
    expect(cluster.refusals).toEqual([]);
    expect(cluster.joinUrls['worker-2']).toBe('https://10.0.0.11:6443');
    expect(cluster.joinUrls['srv-2']).toBe('https://10.0.0.12:6443');
    expect(cluster.actions['srv-1'].kind).toBe('start');
    expect(cluster.actions['worker-2'].kind).toBe('install');
  });

  it('refuses joining nodes when no server of the cluster answers', () => {
    const inspections = {
      ...installedCluster(EXAMPLE_B, { 'srv-1': (i) => (i.k3s.apiReady = false) }),
      'worker-3': freshInspection(['10.0.0.23']),
    };
    const cluster = finalizeClusterPlan(planOf([...EXAMPLE_B, worker('worker-3', { host: '203.0.113.23', private_host: '10.0.0.23' })]), inspections);
    expect(cluster.refusals).toEqual([{ node: null, ...setupMessages.noServerAnswering(ENV, ['srv-1']) }]);
    expect(cluster.refusals[0].message).toBe(
      'No k3s server of production is answering; start k3s on a server before adding or changing nodes',
    );
  });
});

describe('finalizeClusterPlan: the node action table of 4.2 (F5)', () => {
  const single = [EXAMPLE_C[0]];
  const decide = (inspections: Record<string, K3sNodeInspection>, servers: ResolvedServer[] = single, options: Partial<K3sSetupOptions> = {}) =>
    finalizeClusterPlan(planOf(servers, options), inspections);

  it('1 nothing installed -> install', () => {
    const cluster = decide({ 'srv-1': freshInspection(['10.0.0.10']) });
    expect(cluster.actions['srv-1']).toEqual({ kind: 'install', changedKeys: [], fromVersion: null, toVersion: PIN });
  });

  it('2 k3s present without state.json -> refused as unmanaged', () => {
    const cluster = decide({
      'srv-1': freshInspection(['10.0.0.10'], (i) => {
        i.k3s.binaryVersion = `k3s version ${PIN} (1a2b3c4d)`;
        i.k3s.unit = 'k3s';
      }),
    });
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.unmanagedK3s('srv-1', ENV) }]);
    expect(cluster.refusals[0].message).toBe('k3s is already installed on srv-1 but not by Dockflow');
    const unitOnly = decide({ 'srv-1': freshInspection(['10.0.0.10'], (i) => (i.k3s.unit = 'k3s')) });
    expect(messagesOf(unitOnly)).toEqual([setupMessages.unmanagedK3s('srv-1', ENV).message]);
  });

  it('3 state.json present, binary missing -> repair', () => {
    const cluster = decide(installedCluster(single, { 'srv-1': (i) => (i.k3s.binaryVersion = null) }));
    expect(cluster.refusals).toEqual([]);
    expect(cluster.actions['srv-1']).toEqual({ kind: 'repair', changedKeys: [], fromVersion: null, toVersion: PIN });
  });

  it('4 installed role differs from servers.yml -> refused', () => {
    const cluster = decide(installedCluster(single, { 'srv-1': (i) => i.k3s.state && (i.k3s.state.role = 'agent') }));
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.roleChanged('srv-1', 'agent', 'manager', ENV) }]);
    expect(cluster.refusals[0].message).toBe('srv-1 is a k3s agent but servers.yml declares manager');
  });

  it('5 registered node name differs -> refused', () => {
    const cluster = decide(installedCluster(single, { 'srv-1': (i) => i.k3s.state && (i.k3s.state.nodeName = 'old-name') }));
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.nodeRenamed('srv-1', 'old-name', 'srv-1') }]);
  });

  it('6 a CA different from the majority of servers -> refused as another cluster', () => {
    const other = 'deadbeef'.repeat(8);
    const cluster = decide(installedCluster(EXAMPLE_C, { 'srv-3': (i) => (i.k3s.caSha256 = other) }), EXAMPLE_C);
    expect(cluster.refusals).toEqual([{ node: 'srv-3', ...setupMessages.foreignCluster('srv-3', other, CA) }]);
    expect(cluster.refusals[0].message).toBe('srv-3 belongs to another k3s cluster (CA deadbeef, cluster CA c0ffee00)');
  });

  it('7 newer than the pin -> refused (no downgrade)', () => {
    const cluster = decide(installedCluster(single, {}, 'v1.37.1+k3s1'));
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.downgrade('srv-1', 'v1.37.1+k3s1', PIN, '1.9.0') }]);
    expect(cluster.refusals[0].message).toBe(`srv-1 runs k3s v1.37.1+k3s1, newer than ${PIN} pinned by Dockflow 1.9.0; downgrades are not supported`);
  });

  it('8 below the minimum or more than one minor behind -> refused (C1)', () => {
    const below = decide(installedCluster(single, {}, 'v1.33.5+k3s1'));
    expect(below.refusals).toEqual([{ node: 'srv-1', ...setupMessages.minorSkip('srv-1', 'v1.33.5+k3s1', PIN, 34) }]);
    const skip = decide(installedCluster(single, {}, 'v1.34.2+k3s1'));
    expect(skip.refusals).toEqual([{ node: 'srv-1', ...setupMessages.minorSkip('srv-1', 'v1.34.2+k3s1', PIN, 35) }]);
    expect(skip.refusals[0].suggestion).toBe('Run the setup of the Dockflow release that pins k3s v1.35 first, then this one.');
  });

  it('9 an agent newer than the servers after the plan -> refused', () => {
    const base = planOf([EXAMPLE_C[0], EXAMPLE_C[3]]);
    const fresh = finalizeClusterPlan(base, freshInspections(base));
    const inspections = {
      'srv-1': installedInspection(fresh, 'srv-1', LOCALS['srv-1'], undefined, 'v1.35.8+k3s1'),
      'worker-1': installedInspection(fresh, 'worker-1', LOCALS['worker-1']),
      'srv-2': freshInspection(['10.0.0.11']),
      'srv-3': freshInspection(['10.0.0.12']),
    };
    // the conversion keeps srv-1 on its version for this run, so the agent would be ahead of it
    const cluster = decide(inspections, EXAMPLE_C, { convertDatastore: true });
    expect(cluster.actions['srv-1']).toMatchObject({ kind: 'convert-to-etcd', toVersion: 'v1.35.8+k3s1' });
    expect(cluster.refusals).toEqual([{ node: 'worker-1', ...setupMessages.agentNewerThanServers('worker-1') }]);
  });

  it('10 older than the pin -> upgrade, carrying the restart-class drift', () => {
    const cluster = decide(installedCluster(single, { 'srv-1': (i) => i.k3s.dropin && (i.k3s.dropin['write-kubeconfig-mode'] = '0644') }, 'v1.35.8+k3s1'));
    expect(cluster.refusals).toEqual([]);
    expect(cluster.actions['srv-1']).toEqual({ kind: 'upgrade', changedKeys: ['write-kubeconfig-mode'], fromVersion: 'v1.35.8+k3s1', toVersion: PIN });
    const agents = decide(installedCluster(EXAMPLE_B, {}, 'v1.35.8+k3s1'), EXAMPLE_B);
    expect(Object.values(agents.actions).map((a) => a.kind)).toEqual(['upgrade', 'upgrade', 'upgrade']);
  });

  it('11 a refuse-class drift -> refused, even when an upgrade is due', () => {
    const drifted = (i: K3sNodeInspection): void => {
      if (i.k3s.dropin) i.k3s.dropin.disable = ['servicelb', 'traefik'];
    };
    const cluster = decide(installedCluster(single, { 'srv-1': drifted }));
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.disabledComponents('srv-1', ['servicelb', 'traefik']) }]);
    expect(decide(installedCluster(single, { 'srv-1': drifted }, 'v1.35.8+k3s1')).refusals).toHaveLength(1);
  });

  it('12 SQLite bootstrap server, etcd planned -> convert-to-etcd (and it wins over an upgrade)', () => {
    const inspections = {
      ...installedCluster(single, {}, 'v1.35.8+k3s1'),
      'srv-2': freshInspection(['10.0.0.11']),
      'srv-3': freshInspection(['10.0.0.12']),
    };
    const cluster = decide(inspections, EXAMPLE_C.slice(0, 3), { convertDatastore: true });
    expect(cluster.actions['srv-1']).toEqual({ kind: 'convert-to-etcd', changedKeys: ['cluster-init'], fromVersion: 'v1.35.8+k3s1', toVersion: 'v1.35.8+k3s1' });
  });

  it('13 restart-class drift only -> reconfigure', () => {
    const cluster = decide(installedCluster(EXAMPLE_B, { 'worker-1': (i) => i.k3s.dropin && (i.k3s.dropin['node-ip'] = '10.0.0.99') }), EXAMPLE_B);
    expect(cluster.refusals).toEqual([]);
    expect(cluster.actions['worker-1']).toEqual({ kind: 'reconfigure', changedKeys: ['node-ip'], fromVersion: PIN, toVersion: PIN });
    expect(cluster.actions['srv-1'].kind).toBe('noop');
  });

  it('13 a missing drop-in on an installed node is rewritten with a restart', () => {
    const cluster = decide(installedCluster(single, { 'srv-1': (i) => (i.k3s.dropin = null) }));
    expect(cluster.actions['srv-1'].kind).toBe('reconfigure');
    expect(cluster.actions['srv-1'].changedKeys).toContain('node-name');
  });

  it('14 unit not active/running -> start', () => {
    const cluster = decide(
      installedCluster(single, {
        'srv-1': (i) => {
          i.k3s.activeState = 'inactive';
          i.k3s.subState = 'dead';
        },
      }),
    );
    expect(cluster.actions['srv-1']).toEqual({ kind: 'start', changedKeys: [], fromVersion: PIN, toVersion: PIN });
  });

  it('15 otherwise -> noop, also when only no-restart keys changed', () => {
    expect(decide(installedCluster(single)).actions['srv-1'].kind).toBe('noop');
    const rewritten = decide(installedCluster(EXAMPLE_B, { 'worker-1': (i) => i.k3s.dropin && (i.k3s.dropin.server = 'https://10.0.0.99:6443') }), EXAMPLE_B);
    expect(rewritten.actions['worker-1'].kind).toBe('noop');
  });

  it('refuses a version it cannot read', () => {
    const cluster = decide(installedCluster(single, { 'srv-1': (i) => (i.k3s.binaryVersion = 'garbage') }));
    expect(cluster.refusals).toEqual([{ node: 'srv-1', ...setupMessages.unknownVersion('srv-1', 'garbage') }]);
  });
});

describe('finalizeClusterPlan: preflight rows of 4.1 (F9)', () => {
  const single = [EXAMPLE_C[0]];
  const run = (patch: (i: K3sNodeInspection) => void, options: Partial<K3sSetupOptions> = {}, extra: Partial<BuildClusterPlanInput> = {}) =>
    finalizeClusterPlan(planOf(single, options, extra), { 'srv-1': freshInspection(['10.0.0.10'], patch) });
  const runInstalled = (patch: (i: K3sNodeInspection) => void, options: Partial<K3sSetupOptions> = {}) =>
    finalizeClusterPlan(planOf(single, options), installedCluster(single, { 'srv-1': patch }));

  const REFUSALS: [string, (i: K3sNodeInspection) => void, ReturnType<typeof setupMessages.noSystemd>][] = [
    ['no systemd', (i) => (i.os.systemd = false), setupMessages.noSystemd('srv-1')],
    [
      'missing commands without a package manager',
      (i) => {
        i.commands.missing = ['curl', 'sha256sum'];
        i.commands.packageManager = null;
      },
      setupMessages.missingCommands('srv-1', ['curl', 'sha256sum']),
    ],
    ['memory cgroup controller disabled', (i) => (i.cgroupMemory = false), setupMessages.cgroupMemory('srv-1')],
    ['cgroup v1 host', (i) => (i.cgroupVersion = 1), setupMessages.cgroupV1('srv-1')],
    [
      'cgroup v1 is reported instead of the memory controller, whose fix is not a kernel flag there',
      (i) => {
        i.cgroupVersion = 1;
        i.cgroupMemory = false;
      },
      setupMessages.cgroupV1('srv-1'),
    ],
    ['Docker Swarm member', (i) => (i.swarmActive = true), setupMessages.swarmActive('srv-1')],
    [
      'nm-cloud-setup on RHEL 8.2',
      (i) => {
        i.os.id = 'rhel';
        i.os.versionId = '8.2';
        i.nmCloudSetupEnabled = true;
      },
      setupMessages.nmCloudSetup('srv-1'),
    ],
    [
      'k3s port held by another process',
      (i) => (i.portsInUse = [{ port: 6443, proto: 'tcp', process: 'haproxy' }]),
      setupMessages.portInUse('srv-1', 6443, 'tcp', 'haproxy'),
    ],
    [
      'flannel port held by an unnamed socket',
      (i) => (i.portsInUse = [{ port: 8472, proto: 'udp', process: '' }]),
      setupMessages.portInUse('srv-1', 8472, 'udp', 'an unknown process'),
    ],
    [
      'ufw and firewalld both active',
      (i) => (i.firewall = { ufw: 'active', firewalld: 'running' }),
      setupMessages.bothFirewalls('srv-1'),
    ],
    ['private_host not local', (i) => (i.network.localIpv4 = ['10.0.0.99']), setupMessages.privateIpNotLocal('srv-1', '10.0.0.10')],
    [
      'foreign config setting a managed key',
      (i) => (i.k3s.foreignConfig = [{ file: '/etc/rancher/k3s/config.yaml', keys: ['token', 'node-ip'] }]),
      setupMessages.foreignConfigManaged('/etc/rancher/k3s/config.yaml', 'srv-1', ['node-ip', 'token']),
    ],
  ];

  for (const [name, patch, problem] of REFUSALS) {
    it(`refuses: ${name}`, () => {
      const cluster = run(patch);
      expect(cluster.refusals).toContainEqual({ node: 'srv-1', ...problem });
    });
  }

  it('accepts what the refusals do not cover', () => {
    expect(run((i) => (i.commands.missing = ['curl'])).refusals).toEqual([]);
    const rhel84 = (i: K3sNodeInspection): void => {
      i.os.id = 'rhel';
      i.os.versionId = '8.4';
      i.nmCloudSetupEnabled = true;
    };
    expect(run(rhel84).refusals).toEqual([]);
    expect(run((i) => (i.portsInUse = [{ port: 10250, proto: 'tcp', process: 'k3s-server' }])).refusals).toEqual([]);
    expect(run((i) => (i.portsInUse = [{ port: 80, proto: 'tcp', process: 'nginx' }])).refusals).toEqual([]);
    expect(run((i) => (i.k3s.foreignConfig = [{ file: '/etc/rancher/k3s/config.yaml', keys: ['kubelet-arg'] }])).refusals).toEqual([]);
  });

  it('refuses k3s ports only on nodes to install', () => {
    const installed = runInstalled((i) => (i.portsInUse = [{ port: 6443, proto: 'tcp', process: 'haproxy' }]));
    expect(installed.refusals).toEqual([]);
  });

  it('refuses 80 and 443 held on a server when the proxy is enabled', () => {
    const config = { ...CONFIG, proxy: { enabled: true, email: 'ops@example.com' } } as DockflowConfig;
    const cluster = run(
      (i) =>
        (i.portsInUse = [
          { port: 80, proto: 'tcp', process: 'nginx' },
          { port: 443, proto: 'tcp', process: 'nginx' },
        ]),
      {},
      { config },
    );
    expect(cluster.refusals).toEqual([
      { node: 'srv-1', ...setupMessages.proxyPortInUse('srv-1', 80, 'nginx') },
      { node: 'srv-1', ...setupMessages.proxyPortInUse('srv-1', 443, 'nginx') },
    ]);
    expect(cluster.refusals[0].message).toBe('Port 80/tcp on srv-1 is used by nginx, so Traefik could not receive traffic there (proxy.enabled)');
    const httpOnly = { ...CONFIG, proxy: { enabled: true, acme: false } } as DockflowConfig;
    expect(run((i) => (i.portsInUse = [{ port: 443, proto: 'tcp', process: 'nginx' }]), {}, { config: httpOnly }).refusals).toEqual([]);
  });

  it('refuses a node serving another environment unless --shared-cluster, then warns', () => {
    const staging = (i: K3sNodeInspection): void => {
      if (i.k3s.state) i.k3s.state.envs = ['staging'];
    };
    expect(runInstalled(staging).refusals).toEqual([{ node: 'srv-1', ...setupMessages.otherEnvironment('srv-1', 'staging', ENV) }]);
    const shared = runInstalled(staging, { sharedCluster: true });
    expect(shared.refusals).toEqual([]);
    expect(shared.warnings).toContainEqual({ node: null, level: 'warn', message: setupMessages.sharedCluster(['production', 'staging']), suggestion: null });
    expect(warningsOf(shared)).toContain(
      'Environments production, staging share this cluster and one cluster-admin identity: a deploy key of either administers both',
    );
  });

  it('refuses a foreign default StorageClass once, and accepts local-path and dockflow-local', () => {
    const cluster = finalizeClusterPlan(
      planOf(EXAMPLE_C),
      installedCluster(EXAMPLE_C, {
        'srv-1': (i) => (i.k3s.defaultStorageClasses = [{ name: 'fast-ssd', createdAt: 't' }, { name: 'local-path', createdAt: 't' }]),
        'srv-2': (i) => (i.k3s.defaultStorageClasses = [{ name: 'fast-ssd', createdAt: 't' }]),
      }),
    );
    expect(cluster.refusals).toEqual([{ node: null, ...setupMessages.foreignDefaultStorageClass(ENV, 'fast-ssd') }]);
  });

  it('refuses public mode without WireGuard, unless the backend is vxlan', () => {
    const plan = planOf(EXAMPLE_A);
    const noWg = freshInspection(['203.0.113.10'], (i) => (i.wireguardAvailable = false));
    expect(finalizeClusterPlan(plan, { main: noWg }).refusals).toEqual([{ node: 'main', ...setupMessages.wireguardMissing('main') }]);
    expect(finalizeClusterPlan(planOf(EXAMPLE_A, { flannelBackend: 'vxlan' }), { main: noWg }).refusals).toEqual([]);
  });

  it('warns when no host firewall is managed, naming the idle tool or --skip-firewall', () => {
    const noFirewall = (reason: string | null): PlanWarning => {
      const problem = setupMessages.noFirewall('srv-1', ENV, reason);
      return { node: 'srv-1', level: 'warn', message: problem.message, suggestion: problem.suggestion };
    };
    expect(run((i) => (i.firewall = { ufw: 'inactive', firewalld: 'absent' })).warnings).toEqual([noFirewall('ufw is installed but inactive')]);
    expect(run((i) => (i.firewall = { ufw: 'absent', firewalld: 'stopped' })).warnings).toEqual([noFirewall('firewalld is installed but stopped')]);
    expect(run((i) => (i.firewall = { ufw: 'absent', firewalld: 'absent' })).warnings).toEqual([noFirewall(null)]);
    const skipped = run((i) => (i.firewall = { ufw: 'active', firewalld: 'running' }), { skipFirewall: true });
    expect(skipped.refusals).toEqual([]);
    expect(skipped.warnings).toEqual([noFirewall('--skip-firewall')]);
    expect(run(() => undefined).warnings).toEqual([]);
    expect(noFirewall('ufw is installed but inactive').message).toBe(
      'No host firewall is managed on srv-1, so 6443, 10250, 2379-2380 and 8472 stay open unless your provider firewall blocks them (ufw is installed but inactive)',
    );
  });

  it('warns about resources, disk, clock, Docker, foreign settings and unit overrides; SELinux is informational', () => {
    const cluster = run((i) => {
      i.resources = { cpus: 1, memoryBytes: 1 * GIB, varLibFreeBytes: 5 * GIB };
      i.ntpSynchronized = false;
      i.dockerPresent = true;
      i.os.selinux = 'enforcing';
      i.k3s.foreignConfig = [{ file: '/etc/rancher/k3s/config.yaml.d/10-extra.yaml', keys: ['kubelet-arg'] }];
      i.k3s.unitEnvK3sVars = ['K3S_TOKEN'];
    });
    expect(cluster.refusals).toEqual([]);
    expect(warningsOf(cluster)).toEqual([
      setupMessages.foreignConfigOther('/etc/rancher/k3s/config.yaml.d/10-extra.yaml', 'srv-1', ['kubelet-arg']),
      setupMessages.unitEnvOverrides('k3s', 'srv-1', ['K3S_TOKEN']),
      'srv-1 has 1.0 GiB/1 CPU; k3s recommends 2 CPUs and 2 GB for servers',
      'srv-1 has 5.0 GiB free under /var/lib (images and volumes live there)',
      'The clock of srv-1 is not NTP-synchronized; etcd and certificates need accurate time',
      "Docker is installed on srv-1; k3s uses its own containerd and Docker images are not visible to the cluster",
      'SELinux is enforcing on srv-1; the k3s install script installs the signed k3s-selinux package from rpm.rancher.io',
    ]);
    expect(cluster.warnings.at(-1)?.level).toBe('info');
    expect(cluster.warnings[0].message).toBe('/etc/rancher/k3s/config.yaml.d/10-extra.yaml on srv-1 adds k3s settings Dockflow does not manage: kubelet-arg');
  });

  it('warns about a small agent and a left-over netcheck DaemonSet', () => {
    const cluster = finalizeClusterPlan(
      planOf(EXAMPLE_B),
      installedCluster(EXAMPLE_B, {
        'srv-1': (i) => (i.k3s.netcheckPresent = true),
        'worker-1': (i) => (i.resources.memoryBytes = 256 * 1024 ** 2),
      }),
    );
    expect(cluster.refusals).toEqual([]);
    const netcheck = setupMessages.netcheckLeftOver(ENV);
    expect(cluster.warnings).toEqual([
      { node: 'worker-1', level: 'warn', message: setupMessages.lowResourcesAgent('worker-1', '0.3 GiB'), suggestion: null },
      { node: null, level: 'warn', message: netcheck.message, suggestion: netcheck.suggestion },
    ]);
  });

  it('orders refusals by node, cluster-level ones last', () => {
    const plan = planOf([...EXAMPLE_C.slice(0, 2), srv('srv-3', { host: 'srv-3.example.com' }), EXAMPLE_C[3]]);
    const cluster = finalizeClusterPlan(
      plan,
      freshInspections(plan, {
        'srv-3': (i) => {
          i.network.localIpv4 = ['203.0.113.12'];
          i.network.resolvedHost = '203.0.113.12';
        },
        'worker-1': (i) => (i.swarmActive = true),
        'srv-1': (i) => (i.os.systemd = false),
      }),
    );
    expect(cluster.refusals.map((r) => r.node)).toEqual(['srv-1', 'worker-1', null]);
  });

  it('refuses when an inspection is missing', () => {
    const cluster = finalizeClusterPlan(planOf(EXAMPLE_B), { 'srv-1': freshInspection(['10.0.0.10']) });
    expect(cluster.refusals).toEqual([
      { node: 'worker-1', ...setupMessages.inspectionMissing('worker-1') },
      { node: 'worker-2', ...setupMessages.inspectionMissing('worker-2') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildNodePlan and the node plan schema (3.4)
// ---------------------------------------------------------------------------

describe('buildNodePlan', () => {
  const labelled = [
    srv('srv-1', { host: '203.0.113.10', private_host: '10.0.0.10', labels: { zone: 'eu-west-1a', disk: 'ssd' } }),
    ...EXAMPLE_C.slice(1),
  ];
  const plan = planOf(labelled);
  const cluster = finalizeClusterPlan(plan, freshInspections(plan));

  it('inspect carries no cluster section and no token', () => {
    const inspect = buildNodePlan({ operation: 'inspect', node: 'srv-2', arch: 'arm64', plan });
    expect(inspect.cluster).toBeUndefined();
    expect(inspect.tokens).toEqual({ server: null, agent: null });
    expect(inspect.pins.k3s.binary).toEqual({ url: K3S_PIN.binaries.arm64.url, sha256: K3S_PIN.binaries.arm64.sha256 });
    expect(inspect.pins.helm?.archive.url).toContain('linux-arm64');
    expect(inspect.env).toBe(ENV);
    expect(inspect.dockflowVersion).toBe('1.9.0');
  });

  it('carries the decisions of the node and every node for finalize', () => {
    const install = buildNodePlan({ operation: 'install', node: 'srv-2', arch: 'amd64', plan, cluster, firewallTool: 'ufw' });
    expect(install.cluster).toMatchObject({
      addressMode: 'private',
      flannelBackend: 'vxlan',
      datastore: 'etcd',
      clusterInit: false,
      joinUrl: 'https://10.0.0.10:6443',
      action: { kind: 'install' },
      firewallTool: 'ufw',
      datastoreBackup: null,
      proxyPorts: { http: false, https: false },
    });
    expect(install.cluster?.network.nodeIp).toBe('10.0.0.11');
    expect(buildNodePlan({ operation: 'install', node: 'srv-1', arch: 'amd64', plan, cluster }).cluster?.clusterInit).toBe(true);
    // U-SETUP-PLAN-07: node_labels reach the node plans
    const finalize = buildNodePlan({ operation: 'finalize', node: 'srv-1', arch: 'amd64', plan, cluster });
    expect(finalize.node.nodeLabels).toEqual({ disk: 'ssd', zone: 'eu-west-1a' });
    expect(finalize.cluster?.nodes).toEqual([
      { key: 'srv-1', nodeName: 'srv-1', role: 'server-init', nodeIp: '10.0.0.10', nodeLabels: { disk: 'ssd', zone: 'eu-west-1a' } },
      { key: 'srv-2', nodeName: 'srv-2', role: 'server', nodeIp: '10.0.0.11', nodeLabels: {} },
      { key: 'srv-3', nodeName: 'srv-3', role: 'server', nodeIp: '10.0.0.12', nodeLabels: {} },
      { key: 'worker-1', nodeName: 'worker-1', role: 'agent', nodeIp: '10.0.0.21', nodeLabels: {} },
    ]);
  });

  it('gives Helm pins to servers only', () => {
    expect(buildNodePlan({ operation: 'prepare', node: 'worker-1', arch: 'amd64', plan, cluster }).pins.helm).toBeNull();
    expect(buildNodePlan({ operation: 'prepare', node: 'srv-3', arch: 'amd64', plan, cluster }).pins.helm?.version).toBeTruthy();
  });

  it('marks the first server to upgrade on an etcd cluster for the snapshot (15.3)', () => {
    const upgrading = finalizeClusterPlan(planOf(EXAMPLE_C), installedCluster(EXAMPLE_C, {}, 'v1.35.8+k3s1'));
    expect(firstUpgradingServer(upgrading)).toBe('srv-1');
    const backups = ['srv-1', 'srv-2', 'srv-3', 'worker-1'].map(
      (key) => buildNodePlan({ operation: 'install', node: key, arch: 'amd64', plan: upgrading.plan, cluster: upgrading }).cluster?.datastoreBackup,
    );
    const name = `dockflow-pre-${K3S_PIN.version.replace('+', '-')}`;
    expect(backups).toEqual([{ kind: 'etcd-snapshot', name }, null, null, null]);
    expect(firstUpgradingServer(cluster)).toBeNull();
    expect(sqliteCopyPath(name)).toBe(`/var/lib/rancher/k3s/server/db-${name}`);
  });

  it('needs the resolved cluster for every operation but inspect, and a node of the plan', () => {
    expect(() => buildNodePlan({ operation: 'prepare', node: 'srv-1', arch: 'amd64', plan })).toThrow('needs the resolved cluster');
    expect(() => buildNodePlan({ operation: 'inspect', node: 'nope', arch: 'amd64', plan })).toThrow('nope is not a node of this plan');
  });

  it('U-SETUP-PLAN-10 never serializes the deploy private key', () => {
    const body = DEPLOY_KEY.split('\n')[1];
    for (const operation of ['inspect', 'prepare', 'install', 'control-plane', 'finalize'] as const) {
      const json = JSON.stringify(buildNodePlan({ operation, node: 'srv-1', arch: 'amd64', plan, cluster }));
      expect(json).not.toContain('PRIVATE KEY');
      expect(json).not.toContain(body);
    }
    expect(JSON.stringify(plan)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(cluster)).not.toContain(body);
  });

  it('round-trips through JSON and the node step schema for every operation and node', () => {
    const tokens = { server: `K10${CA}::server:abcdef0123456789`, agent: `K10${CA}::node:${'ab'.repeat(32)}` };
    for (const node of cluster.plan.nodes) {
      for (const operation of ['inspect', 'prepare', 'install', 'control-plane', 'read-tokens', 'finalize', 'reset'] as const) {
        const nodePlan = buildNodePlan({ operation, node: node.key, arch: 'amd64', plan, cluster, tokens, firewallTool: 'firewalld' });
        const parsed = parseNodePlan(JSON.stringify(nodePlan));
        expect(parsed).toEqual({ success: true, data: nodePlan });
      }
    }
  });
});

describe('node plan schema (3.4)', () => {
  const plan = planOf(EXAMPLE_B);
  const cluster = finalizeClusterPlan(plan, freshInspections(plan));
  const install = buildNodePlan({ operation: 'install', node: 'worker-1', arch: 'amd64', plan, cluster });

  it('refuses what is not a valid plan, naming fields and never values', () => {
    expect(parseNodePlan('{not json')).toEqual({ success: false, error: 'the plan is not valid JSON' });
    expect(parseNodePlan(' '.repeat(1024 * 1024 + 1))).toEqual({ success: false, error: 'the plan is larger than 1048576 bytes' });
    const { cluster: _dropped, ...withoutCluster } = install;
    const missing = parseNodePlan(JSON.stringify(withoutCluster));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toContain('cluster: the install operation needs the cluster section');
    const extra = parseNodePlan(JSON.stringify({ ...install, surprise: true }));
    expect(extra.success).toBe(false);
    const badToken = parseNodePlan(JSON.stringify({ ...install, tokens: { server: null, agent: 'has space' } }));
    expect(badToken.success).toBe(false);
    if (!badToken.success) expect(badToken.error).not.toContain('has space');
    const badVersion = parseNodePlan(JSON.stringify({ ...install, schema: 2 }));
    expect(badVersion.success).toBe(false);
  });

  it('validates state.json and inspections', () => {
    const inspections = installedCluster(EXAMPLE_B);
    const inspection = inspections['srv-1'];
    expect(parseNodeState(JSON.parse(JSON.stringify(inspection.k3s.state)))).toEqual(inspection.k3s.state);
    expect(parseNodeState({ schema: 2 })).toBeNull();
    expect(parseNodeInspection(JSON.parse(JSON.stringify(inspection)))).toEqual({ success: true, data: inspection });
    expect(parseNodeInspection({}).success).toBe(false);
  });
});

describe('setup constants (4.0, 15.6)', () => {
  it('pins the one curl flag set and the step guards', () => {
    expect(CURL_FLAGS).toEqual([
      '-fsSL',
      '--proto',
      '=https',
      '--tlsv1.2',
      '--retry',
      '3',
      '--retry-delay',
      '2',
      '--connect-timeout',
      '20',
      '--max-time',
      '900',
    ]);
    expect(NODE_STEP_GUARD_S).toEqual({
      inspect: 120,
      prepare: 1200,
      install: 1200,
      'control-plane': 600,
      'read-tokens': 60,
      finalize: 900,
      reset: 900,
    });
    expect([K3S_TOKEN_FILE, K3S_AGENT_TOKEN_FILE, K3S_BINARY]).toEqual([
      '/etc/rancher/k3s/dockflow/token',
      '/etc/rancher/k3s/dockflow/agent-token',
      '/usr/local/bin/k3s',
    ]);
  });
});

describe('k3s versions (15.2)', () => {
  it('parses `k3s --version` and compares as a tuple', () => {
    expect(parseK3sVersion('k3s version v1.36.4+k3s1 (1a2b3c4d)')).toEqual({ major: 1, minor: 36, patch: 4, k3s: 1, text: 'v1.36.4+k3s1' });
    expect(parseK3sVersion('v1.34.0')).toEqual({ major: 1, minor: 34, patch: 0, k3s: 0, text: 'v1.34.0' });
    expect(parseK3sVersion('nothing')).toBeNull();
    const v = (text: string) => parseK3sVersion(text) ?? { major: 0, minor: 0, patch: 0, k3s: 0, text: '' };
    expect(compareK3sVersions(v('v1.36.4+k3s2'), v('v1.36.4+k3s1'))).toBeGreaterThan(0);
    expect(compareK3sVersions(v('v1.35.9+k3s1'), v('v1.36.0+k3s1'))).toBeLessThan(0);
    expect(compareK3sVersions(v(PIN), v(PIN))).toBe(0);
  });
});
