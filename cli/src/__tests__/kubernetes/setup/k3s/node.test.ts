import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { DOCKFLOW_VERSION } from '../../../../constants';
import { K3S_SERVER_AGENT_TOKEN, K3S_SERVER_CA, K3S_SERVER_TOKEN, SETUP_LOCK_FILE } from '../../../../commands/setup/k3s/constants';
import { inspect, runK3sNodeStep } from '../../../../commands/setup/k3s/node';
import { buildLocalPlan, buildNodePlan, finalizeClusterPlan, type K3sNodeInspection, type K3sNodePlan, type NodeOperation } from '../../../../commands/setup/k3s/plan';
import { sha256Hex } from '../../../../utils/hash';
import * as output from '../../../../utils/output';
import { FakeCluster } from '../../fakes/fake-cluster';
import { FakeHostRunner, fakeTarball } from '../../fakes/fake-host-runner';
import { FakeKubeExecutor, fakeNode } from '../../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../../support/invariants';
import { Redactor } from '../../../../utils/redact';

const KEY = 'srv-1';
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOZ4hf7ZqvJ8n3x9C1Y7q6qgv9r0K5Z8mF3x2Q1w0e9 dockflow-deploy';

let runners: FakeHostRunner[] = [];
let kubeExecutors: FakeKubeExecutor[] = [];

function host(options: ConstructorParameters<typeof FakeHostRunner>[0] = {}): FakeHostRunner {
  const runner = new FakeHostRunner(options);
  runners.push(runner);
  return runner;
}

/**
 * A handful of read-only host probes of inspect() (4.1) that FakeHostRunner's stock handlers do not
 * cover (design-07's R-S6-05 seam has no opinion on them): stubbed here with plausible answers.
 */
function withInspectStubs(runner: FakeHostRunner): FakeHostRunner {
  runner.seedFile('/proc/meminfo', 'MemTotal:        4046456 kB\n');
  return runner
    .on(['getenforce'], { exitCode: 1, stderr: 'getenforce: command not found' })
    .on(['nproc'], { stdout: '4\n' })
    .on(['df', '-B1', '--output=avail', '/var/lib'], { stdout: 'Avail\n21474836480\n' })
    .on(['ss', '-Hlntup'], { stdout: '' })
    .on(['docker', 'info', '--format', '{{.Swarm.LocalNodeState}}'], { exitCode: 1, stderr: 'docker: command not found' })
    .on(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'], { exitCode: 1, stderr: 'timedatectl: command not found' })
    .on(['ip', 'link', 'add', 'dockflow-wgtest', 'type', 'wireguard'], { exitCode: 1, stderr: 'RTNETLINK answers: Operation not permitted' })
    .on(['ip', 'link', 'del', 'dockflow-wgtest'], { exitCode: 1, stderr: 'Cannot find device "dockflow-wgtest"' });
}

function inspectPlan(): K3sNodePlan {
  const cluster = buildLocalPlan({
    nodeName: KEY,
    deployUser: 'dockflow',
    deployPublicKey: PUBLIC_KEY,
    privateHost: null,
    publicHost: '10.0.0.10',
    requestedBackend: null,
    dockflowVersion: DOCKFLOW_VERSION,
  });
  return buildNodePlan({ operation: 'inspect', node: cluster.nodes[0].key, arch: 'amd64', plan: cluster });
}

function stdinOf(text: string): Readable {
  return Readable.from([text]);
}

async function run(text: string, runner: FakeHostRunner): Promise<{ lines: unknown[]; errors: string[]; exitCode: number | undefined }> {
  const raw = spyOn(output, 'printRaw').mockImplementation(() => {});
  const err = spyOn(output, 'printError').mockImplementation(() => {});
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await runK3sNodeStep(stdinOf(text), { runner });
    return {
      lines: raw.mock.calls.map((call) => JSON.parse(String(call[0]))),
      errors: err.mock.calls.map((call) => String(call[0])),
      exitCode: process.exitCode,
    };
  } finally {
    // Bun (confirmed on 1.3.5) leaves process.exitCode unchanged when assigned `undefined` once it
    // already holds a number, so `undefined` is unusable as the "restore to no exit code" sentinel.
    process.exitCode = previousExit ?? 0;
    raw.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => {
  const hostRunner = runners;
  const kube = kubeExecutors;
  runners = [];
  kubeExecutors = [];
  for (const runner of hostRunner) runner.assertDone();
  for (const executor of kube) executor.assertDone();
  assertExecutorInvariants({ hostRunner, kube, redactor: new Redactor() });
});

describe('runK3sNodeStep protocol (3.4)', () => {
  it('N1 refuses a non-root invocation with exit 2 and no result line', async () => {
    const runner = host({ euid: 1000 });
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([]);
  });

  it('N2 invalid JSON is refused with exit 2 and no result line', async () => {
    const runner = host();
    const result = await run('{not valid json', runner);
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([]);
  });

  it('N2 a schema violation is refused with exit 2 and no result line', async () => {
    const runner = host();
    const plan = inspectPlan() as unknown as Record<string, unknown>;
    delete plan.schema; // required by the zod schema
    const result = await run(JSON.stringify(plan), runner);
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([]);
  });

  it('N3 a plan from another Dockflow version is refused, with a result line', async () => {
    const runner = host();
    const plan = { ...inspectPlan(), dockflowVersion: '0.0.1-does-not-exist' };
    const result = await run(JSON.stringify(plan), runner);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toHaveLength(1);
    const body = result.lines[0] as { dockflowNodeResult: { status: string; error: { message: string } | null } };
    expect(body.dockflowNodeResult.status).toBe('refused');
    expect(body.dockflowNodeResult.error?.message).toContain('0.0.1-does-not-exist');
  });

  it('N4 a lock held by a live pid is refused with a message', async () => {
    const runner = host();
    await runner.writeFile(SETUP_LOCK_FILE, '4242\n', { mode: 0o600 });
    runner.seedDir('/proc/4242');
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(1);
    const body = result.lines[0] as { dockflowNodeResult: { status: string; error: { message: string } | null } };
    expect(body.dockflowNodeResult.status).toBe('refused');
    expect(body.dockflowNodeResult.error?.message).toBe(`Another dockflow setup is running on ${KEY} (pid 4242)`);
    expect(await runner.stat(SETUP_LOCK_FILE)).not.toBeNull();
  });

  it('N4 a stale lock (dead pid) is removed and the run proceeds', async () => {
    const runner = withInspectStubs(host());
    await runner.writeFile(SETUP_LOCK_FILE, '9999\n', { mode: 0o600 });
    // /proc/9999 does not exist: the pid is dead
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(0);
    const body = result.lines[0] as { dockflowNodeResult: { status: string } };
    expect(body.dockflowNodeResult.status).toBe('ok');
  });

  it('N5 stdout carries exactly one JSON line, the result, and install.sh output never reaches it', async () => {
    const runner = withInspectStubs(host());
    runner.installScript = { exitCode: 0, stdout: 'super secret install.sh chatter that must stay off stdout' };
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(1);
    const body = result.lines[0] as { dockflowNodeResult: { schema: number; node: string; operation: string } };
    expect(body.dockflowNodeResult.schema).toBe(1);
    expect(body.dockflowNodeResult.node).toBe(KEY);
    expect(body.dockflowNodeResult.operation).toBe('inspect');
    for (const line of result.lines) expect(JSON.stringify(line)).not.toContain('super secret install.sh chatter');
  });
});

describe('inspect (4.1, N6)', () => {
  // read-only per 4.1, plus the two exceptions the design's own probe table specifies: the
  // `ip link add/del` pair that measures WireGuard kernel support.
  const READ_ONLY_PREFIXES: readonly string[] = [
    'uname',
    'getenforce',
    'nproc',
    'df',
    'ip',
    'getent',
    'which',
    'systemctl',
    'ss',
    'docker',
    'timedatectl',
    'ufw',
    '/usr/local/bin/k3s',
    '/usr/local/lib/dockflow/bin/helm',
  ];

  it('performs only read-only host commands (allowlist)', async () => {
    const runner = withInspectStubs(host());
    const plan = inspectPlan();
    const result = await inspect(runner, plan);
    expect(result.os.arch).toBe('amd64');

    for (const call of runner.calls) {
      const cmd = call.argv[0];
      expect(READ_ONLY_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(prefix))).toBe(true);
    }
    // the wireguard capability probe: an interface created and removed in the same pass, never left behind
    const links = runner.calls.filter((call) => call.argv[0] === 'ip' && call.argv[1] === 'link');
    expect(links.map((call) => call.argv[2])).toEqual(['add', 'del']);
    runner.assertDone();
  });

  it('reads the memory controller from cgroup.controllers on a cgroup v2 host', async () => {
    const runner = withInspectStubs(host());
    runner.seedFile('/sys/fs/cgroup/cgroup.controllers', 'cpuset cpu io memory hugetlb pids rdma misc\n');
    const result = await inspect(runner, inspectPlan());
    expect(result.cgroupVersion).toBe(2);
    expect(result.cgroupMemory).toBe(true);
  });

  it('a cgroup v2 host without the memory controller reads as memory disabled', async () => {
    const runner = withInspectStubs(host());
    runner.seedFile('/sys/fs/cgroup/cgroup.controllers', 'cpuset cpu io pids\n');
    const result = await inspect(runner, inspectPlan());
    expect(result.cgroupVersion).toBe(2);
    expect(result.cgroupMemory).toBe(false);
  });

  it('a host without cgroup.controllers is cgroup v1, its memory controller read from /proc/cgroups', async () => {
    const runner = withInspectStubs(host());
    runner.seedFile(
      '/proc/cgroups',
      '#subsys_name\thierarchy\tnum_cgroups\tenabled\ncpuset\t1\t26\t1\nmemory\t5\t184\t1\npids\t12\t97\t1\n',
    );
    const result = await inspect(runner, inspectPlan());
    expect(result.cgroupVersion).toBe(1);
    expect(result.cgroupMemory).toBe(true);
  });

  it('inspect takes the lock itself when run through the full step (no dry-run races a real run)', async () => {
    const runner = withInspectStubs(host());
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.exitCode).toBe(0);
    expect(await runner.stat(SETUP_LOCK_FILE)).toBeNull();
  });
});

/** an unmanaged, freshly reachable node: fed straight to `finalizeClusterPlan`, no real `inspect()` needed */
function freshLocalInspection(): K3sNodeInspection {
  return {
    os: { id: 'ubuntu', versionId: '24.04', kernel: '6.8.0-45-generic', arch: 'amd64', systemd: true, selinux: 'absent' },
    resources: { cpus: 4, memoryBytes: 8 * 1024 ** 3, varLibFreeBytes: 100 * 1024 ** 3 },
    network: { localIpv4: ['10.0.0.10'], resolvedHost: null, defaultRouteIp: '10.0.0.10' },
    commands: { missing: [], packageManager: 'apt-get' },
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

function localPreparePlan(): K3sNodePlan {
  const localCluster = buildLocalPlan({
    nodeName: KEY,
    deployUser: 'dockflow',
    deployPublicKey: PUBLIC_KEY,
    privateHost: null,
    publicHost: '10.0.0.10',
    requestedBackend: null,
    dockflowVersion: DOCKFLOW_VERSION,
    flags: { skipFirewall: true },
  });
  const resolved = finalizeClusterPlan(localCluster, { [KEY]: freshLocalInspection() });
  return buildNodePlan({ operation: 'prepare', node: KEY, arch: 'amd64', plan: localCluster, cluster: resolved });
}

/** seeds the download cache so every `prepare` step downstream of `packages` succeeds too (self-consistent fake pins: real K3S_PIN/HELM_PIN hashes are of actual release artefacts, unreproducible here) */
function wireLocalPreparePlan(runner: FakeHostRunner): K3sNodePlan {
  const plan = localPreparePlan();
  const k3sBytes = Buffer.from('#!fake k3s binary\n');
  const scriptBytes = Buffer.from('#!/bin/sh\nexit 0\n');
  const helmBytes = Buffer.from('#!fake helm archive\n');
  runner.seedCache(k3sBytes);
  runner.seedCache(scriptBytes);
  runner.seedCache(helmBytes);
  return {
    ...plan,
    pins: {
      k3s: {
        version: plan.pins.k3s.version,
        binary: { url: 'https://fake.invalid/k3s', sha256: sha256Hex(k3sBytes) },
        installScript: { url: 'https://fake.invalid/install.sh', sha256: sha256Hex(scriptBytes) },
      },
      helm: plan.pins.helm === null ? null : { version: plan.pins.helm.version, archive: { url: 'https://fake.invalid/helm', sha256: sha256Hex(helmBytes) } },
    },
  };
}

describe('dockflowNodeEvent progress lines (3.4)', () => {
  it('prepare emits a start event and a matching finish event around every step, before the result line', async () => {
    const runner = host();
    const wired = wireLocalPreparePlan(runner);

    const result = await run(JSON.stringify(wired), runner);
    expect(result.exitCode).toBe(0);
    expect(result.lines.length).toBeGreaterThan(1);

    type EventLine = { dockflowNodeEvent: { step: string; status: string; detail?: string } };
    type ResultLine = { dockflowNodeResult: { steps: { id: string }[] } };
    const eventLines = result.lines.slice(0, -1) as EventLine[];
    const resultLine = result.lines.at(-1) as ResultLine;
    expect(resultLine).toHaveProperty('dockflowNodeResult');
    for (const line of eventLines) expect(line).toHaveProperty('dockflowNodeEvent');

    const events = eventLines.map((line) => line.dockflowNodeEvent);
    const starts = events.filter((e) => e.status === 'start').map((e) => e.step);
    // one start event per recorded step, in the same order the result lists them (3.4's own example: `download-k3s`)
    expect(starts).toEqual(resultLine.dockflowNodeResult.steps.map((s) => s.id));
    expect(starts).toContain('download-k3s');
    const startIndex = events.findIndex((e) => e.step === 'download-k3s' && e.status === 'start');
    const finishIndex = events.findIndex((e) => e.step === 'download-k3s' && e.status === 'ok');
    expect(finishIndex).toBeGreaterThan(startIndex);
  });

  it('inspect (no steps) prints no event lines, only the result (N5 stays exactly one line)', async () => {
    const runner = withInspectStubs(host());
    const result = await run(JSON.stringify(inspectPlan()), runner);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toHaveProperty('dockflowNodeResult');
  });
});

describe('packages step (4.3)', () => {
  it('nothing missing -> skip, no package manager probed', async () => {
    const runner = host();
    const wired = wireLocalPreparePlan(runner);
    for (const command of ['curl', 'tar', 'sha256sum', 'ip']) runner.commands.set(command, `/usr/bin/${command}`);
    // dockflow is the deploy user (not root): visudo is also checked
    runner.commands.set('visudo', '/usr/sbin/visudo');
    const result = await run(JSON.stringify(wired), runner);
    const body = result.lines.at(-1) as { dockflowNodeResult: { status: string; steps: { id: string; status: string }[] } };
    expect(body.dockflowNodeResult.status).toBe('ok');
    expect(body.dockflowNodeResult.steps.find((s) => s.id === 'packages')?.status).toBe('skip');
    expect(runner.commandsStartingWith('apt-get')).toEqual([]);
  });

  it('missing commands are installed through the detected package manager', async () => {
    const runner = host();
    const wired = wireLocalPreparePlan(runner);
    runner.commands.set('apt-get', '/usr/bin/apt-get');
    runner.commands.set('visudo', '/usr/sbin/visudo');
    // curl, tar, sha256sum, ip stay unregistered: `which` reports them missing
    runner.on(['apt-get', 'install', '-y'], {}, { id: 'install missing packages' });
    const result = await run(JSON.stringify(wired), runner);
    const body = result.lines.at(-1) as { dockflowNodeResult: { status: string; steps: { id: string; status: string }[] } };
    expect(body.dockflowNodeResult.status).toBe('ok');
    expect(body.dockflowNodeResult.steps.find((s) => s.id === 'packages')?.status).toBe('ok');
    const installCalls = runner.commandsStartingWith('apt-get', 'install', '-y');
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]).toEqual(['apt-get', 'install', '-y', 'curl', 'tar', 'coreutils', 'iproute2']);
  });

  it('no package manager found -> skip (finalizeClusterPlan would already have refused otherwise)', async () => {
    const runner = host();
    const wired = wireLocalPreparePlan(runner);
    runner.commands.set('visudo', '/usr/sbin/visudo');
    const result = await run(JSON.stringify(wired), runner);
    const body = result.lines.at(-1) as { dockflowNodeResult: { status: string; steps: { id: string; status: string }[] } };
    expect(body.dockflowNodeResult.status).toBe('ok');
    expect(body.dockflowNodeResult.steps.find((s) => s.id === 'packages')?.status).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// install / control-plane / read-tokens / finalize / reset (4.4-4.8): the operations `packages
// step (4.3)` above does not reach. A fresh single-node cluster plan, reused as the base of every
// operation's own node plan (operation is the only field that differs).
// ---------------------------------------------------------------------------

function bootstrapCluster(): { localCluster: ReturnType<typeof buildLocalPlan>; resolved: ReturnType<typeof finalizeClusterPlan> } {
  const localCluster = buildLocalPlan({
    nodeName: KEY,
    deployUser: 'dockflow',
    deployPublicKey: PUBLIC_KEY,
    privateHost: null,
    publicHost: '10.0.0.10',
    requestedBackend: null,
    dockflowVersion: DOCKFLOW_VERSION,
    flags: { skipFirewall: true },
  });
  const resolved = finalizeClusterPlan(localCluster, { [KEY]: freshLocalInspection() });
  return { localCluster, resolved };
}

const BOOTSTRAP_K3S_BYTES = Buffer.from('#!fake k3s binary\n');
const BOOTSTRAP_SCRIPT_BYTES = Buffer.from('#!/bin/sh\nexit 0\n');
// a real (fake) tar.gz: installHelm extracts this member, so unlike the plain bytes of
// wireLocalPreparePlan (which only ever reach the download cache, never tar) it must be one.
const BOOTSTRAP_HELM_ARCHIVE = fakeTarball({ 'linux-amd64/helm': '#!fake helm v4.3.0\n' });

/** self-consistent fake pins for every operation below, keyed by content hash like the real cache. */
function wireBootstrapPlan(operation: NodeOperation, bootstrap: ReturnType<typeof bootstrapCluster>): K3sNodePlan {
  const plan = buildNodePlan({ operation, node: KEY, arch: 'amd64', plan: bootstrap.localCluster, cluster: bootstrap.resolved });
  return {
    ...plan,
    pins: {
      k3s: {
        version: plan.pins.k3s.version,
        binary: { url: 'https://fake.invalid/k3s', sha256: sha256Hex(BOOTSTRAP_K3S_BYTES) },
        installScript: { url: 'https://fake.invalid/install.sh', sha256: sha256Hex(BOOTSTRAP_SCRIPT_BYTES) },
      },
      helm: plan.pins.helm === null ? null : { version: plan.pins.helm.version, archive: { url: 'https://fake.invalid/helm', sha256: sha256Hex(BOOTSTRAP_HELM_ARCHIVE) } },
    },
  };
}

function seedBootstrapCache(runner: FakeHostRunner): void {
  runner.seedCache(BOOTSTRAP_K3S_BYTES);
  runner.seedCache(BOOTSTRAP_SCRIPT_BYTES);
  runner.seedCache(BOOTSTRAP_HELM_ARCHIVE);
}

const APPLY_ARGS = ['apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '-f', '-'];

describe('install, control-plane and reset (4.4, 4.5, 18.3): a node through its own lifecycle', () => {
  it('installs the unit, brings up the control plane over it, then resets cleanly', async () => {
    const bootstrap = bootstrapCluster();
    // control-plane's own kube calls, scripted; the readyz probe install's wait-service step also
    // issues is served by the cluster fallback (it precedes every scripted row, so strict order
    // never tries to match it against them).
    const kube = new FakeKubeExecutor({
      node: fakeNode(KEY),
      redactor: new Redactor(),
      cluster: new FakeCluster(),
      order: 'strict',
      script: [
        {
          id: 'get-local-path',
          args: ['get', 'storageclass', 'local-path', '-o', 'json'],
          respond: { json: { items: [{ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'local-path' }, provisioner: 'rancher.io/local-path' }] } },
        },
        { id: 'apply-namespace', args: APPLY_ARGS, respond: { exitCode: 0, stdout: '', stderr: '' } },
        { id: 'get-storageclass-existing', args: ['get', 'storageclass', 'dockflow-local', '-o', 'json'], respond: { json: { items: [] } } },
        { id: 'apply-storageclass', args: APPLY_ARGS, respond: { exitCode: 0, stdout: '', stderr: '' } },
        { id: 'apply-identity', args: APPLY_ARGS, respond: { exitCode: 0, stdout: '', stderr: '' } },
        {
          id: 'get-deployer-token',
          args: ['get', 'secrets', 'dockflow-deployer-token', '-o', 'json'],
          respond: {
            json: {
              items: [
                {
                  apiVersion: 'v1',
                  kind: 'Secret',
                  metadata: { name: 'dockflow-deployer-token', namespace: 'dockflow-system' },
                  type: 'kubernetes.io/service-account-token',
                  data: { token: Buffer.from('deployer-token-value').toString('base64') },
                },
              ],
            },
          },
        },
        {
          id: 'get-storageclass-list',
          args: ['get', 'storageclass', '-o', 'json'],
          respond: {
            json: {
              items: [
                {
                  apiVersion: 'storage.k8s.io/v1',
                  kind: 'StorageClass',
                  metadata: { name: 'dockflow-local', creationTimestamp: '2026-01-01T00:00:00Z', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
                  provisioner: 'rancher.io/local-path',
                  reclaimPolicy: 'Retain',
                },
              ],
            },
          },
        },
        { id: 'get-helmcharts', args: ['get', 'helmcharts.helm.cattle.io', '-o', 'json'], respond: { json: { items: [] } } },
        { id: 'get-traefik-deployment', args: ['get', 'deployments.apps', 'traefik', '-o', 'json'], respond: { json: { items: [] } } },
      ],
    });
    kubeExecutors.push(kube);
    const runner = host({ kube });
    seedBootstrapCache(runner);
    // the first poll must already see the unit up: this test never advances a clock (systemClock is real).
    runner.services.set('k3s', [{ activeState: 'active', subState: 'running' }]);

    const installResult = await run(JSON.stringify(wireBootstrapPlan('install', bootstrap)), runner);
    expect(installResult.exitCode).toBe(0);
    const installBody = installResult.lines.at(-1) as { dockflowNodeResult: { status: string; tokens: { server: string; agent: string } | null } };
    expect(installBody.dockflowNodeResult.status).toBe('ok');
    expect(installBody.dockflowNodeResult.tokens?.agent).toMatch(/^[0-9a-f]{64}$/);
    expect(await runner.stat(K3S_SERVER_CA)).toBeNull(); // real k3s writes it; this fake install.sh does not

    runner.addUser('dockflow', { uid: 1500 });
    runner.seedFile(K3S_SERVER_CA, '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n');

    const controlPlaneResult = await run(JSON.stringify(wireBootstrapPlan('control-plane', bootstrap)), runner);
    expect(controlPlaneResult.exitCode).toBe(0);
    const cpBody = controlPlaneResult.lines.at(-1) as {
      dockflowNodeResult: { status: string; controlPlane: { helmVersion: string; kubeconfig: string; traefikBundled: boolean; encryption: { hashMatch: boolean } } | null };
    };
    expect(cpBody.dockflowNodeResult.status).toBe('ok');
    expect(cpBody.dockflowNodeResult.controlPlane?.helmVersion).toBe('v4.3.0');
    expect(cpBody.dockflowNodeResult.controlPlane?.kubeconfig).toBe('written');
    expect(cpBody.dockflowNodeResult.controlPlane?.traefikBundled).toBe(false);
    expect(cpBody.dockflowNodeResult.controlPlane?.encryption.hashMatch).toBe(true); // FakeHostRunner's default encryptionStatus

    const resetResult = await run(JSON.stringify(wireBootstrapPlan('reset', bootstrap)), runner);
    expect(resetResult.exitCode).toBe(0);
    const resetBody = resetResult.lines.at(-1) as { dockflowNodeResult: { status: string; reset: { removed: string[] } | null } };
    expect(resetBody.dockflowNodeResult.status).toBe('ok');
    expect(resetBody.dockflowNodeResult.reset?.removed.length).toBeGreaterThan(0);
  });
});

describe('read-tokens (4.6)', () => {
  it('reads and validates the server and the bootstrap agent token', async () => {
    const bootstrap = bootstrapCluster();
    const runner = host();
    runner.seedFile(K3S_SERVER_TOKEN, 'K10deadbeef::server:secretpw\n', { mode: 0o600 });
    runner.seedFile(K3S_SERVER_AGENT_TOKEN, 'K10deadbeef::node:secretpw2\n', { mode: 0o600 });

    const result = await run(JSON.stringify(wireBootstrapPlan('read-tokens', bootstrap)), runner);
    expect(result.exitCode).toBe(0);
    const body = result.lines.at(-1) as { dockflowNodeResult: { status: string; tokens: { server: string; agent: string } | null } };
    expect(body.dockflowNodeResult.status).toBe('ok');
    expect(body.dockflowNodeResult.tokens).toEqual({ server: 'K10deadbeef::server:secretpw', agent: 'K10deadbeef::node:secretpw2' });
  });

  it('an agent-token symlink (the server never had a real one) is refused', async () => {
    const bootstrap = bootstrapCluster();
    const runner = host();
    runner.seedFile(K3S_SERVER_TOKEN, 'K10deadbeef::server:secretpw\n', { mode: 0o600 });
    runner.seedSymlink(K3S_SERVER_AGENT_TOKEN, K3S_SERVER_TOKEN);

    const result = await run(JSON.stringify(wireBootstrapPlan('read-tokens', bootstrap)), runner);
    expect(result.exitCode).toBe(1);
    const body = result.lines.at(-1) as { dockflowNodeResult: { status: string; error: { message: string } | null } };
    expect(body.dockflowNodeResult.status).toBe('failed');
    expect(body.dockflowNodeResult.error?.message).toContain('equals the server token');
  });
});

describe('finalize (4.7)', () => {
  function finalizeKube(nodeName: string, kubeletVersion: string): FakeKubeExecutor {
    const executor = new FakeKubeExecutor({
      node: fakeNode(KEY),
      redactor: new Redactor(),
      script: [
        { id: 'remove-netcheck', args: ['get', 'daemonset', 'dockflow-netcheck', '-o', 'json'], respond: { json: { items: [] } } },
        { id: 'get-node', args: ['get', 'node', nodeName, '-o', 'json'], respond: { json: { items: [] } } },
        {
          id: 'get-nodes',
          args: ['get', 'nodes', '-o', 'json'],
          respond: {
            json: {
              items: [
                {
                  apiVersion: 'v1',
                  kind: 'Node',
                  metadata: { name: nodeName, labels: { 'node-role.kubernetes.io/control-plane': 'true' } },
                  status: { conditions: [{ type: 'Ready', status: 'True' }], addresses: [], nodeInfo: { kubeletVersion } },
                },
              ],
            },
          },
        },
        {
          id: 'get-kube-system-deployments',
          args: ['get', 'deployments.apps', '-o', 'json'],
          respond: {
            json: {
              items: [
                { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'coredns', generation: 1 }, spec: { replicas: 1, selector: { matchLabels: {} }, template: { metadata: {}, spec: { containers: [] } } }, status: { availableReplicas: 1, observedGeneration: 1 } },
                { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'local-path-provisioner', generation: 1 }, spec: { replicas: 1, selector: { matchLabels: {} }, template: { metadata: {}, spec: { containers: [] } } }, status: { availableReplicas: 1, observedGeneration: 1 } },
              ],
            },
          },
        },
        { id: 'get-helmcharts', args: ['get', 'helmcharts.helm.cattle.io', '-o', 'json'], respond: { json: { items: [] } } },
        { id: 'get-traefik-deployment', args: ['get', 'deployments.apps', 'traefik', '-o', 'json'], respond: { json: { items: [] } } },
        {
          id: 'get-storageclass-list',
          args: ['get', 'storageclass', '-o', 'json'],
          respond: {
            json: {
              items: [
                {
                  apiVersion: 'storage.k8s.io/v1',
                  kind: 'StorageClass',
                  metadata: { name: 'dockflow-local', creationTimestamp: '2026-01-01T00:00:00Z', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
                  provisioner: 'rancher.io/local-path',
                  reclaimPolicy: 'Retain',
                },
              ],
            },
          },
        },
        { id: 'get-deployer-sa', args: ['get', 'serviceaccounts', 'dockflow-deployer', '-o', 'json'], respond: { json: { items: [{ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'dockflow-deployer', namespace: 'dockflow-system' } }] } } },
        {
          id: 'get-deployer-token',
          args: ['get', 'secrets', 'dockflow-deployer-token', '-o', 'json'],
          respond: {
            json: {
              items: [
                {
                  apiVersion: 'v1',
                  kind: 'Secret',
                  metadata: { name: 'dockflow-deployer-token', namespace: 'dockflow-system' },
                  type: 'kubernetes.io/service-account-token',
                  data: { token: Buffer.from('t').toString('base64') },
                },
              ],
            },
          },
        },
        {
          id: 'get-deployer-crb',
          args: ['get', 'clusterrolebindings', 'dockflow-deployer', '-o', 'json'],
          respond: { json: { items: [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'dockflow-deployer' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' } }] } },
        },
      ],
    });
    kubeExecutors.push(executor);
    return executor;
  }

  it('a single, fully healthy node passes cluster verification', async () => {
    const bootstrap = bootstrapCluster();
    const nodeName = bootstrap.resolved.plan.nodes[0].nodeName;
    const kubeletVersion = bootstrap.resolved.actions[KEY]?.toVersion ?? '';
    const kube = finalizeKube(nodeName, kubeletVersion);
    const runner = host({ kube });

    const result = await run(JSON.stringify(wireBootstrapPlan('finalize', bootstrap)), runner);
    expect(result.exitCode).toBe(0);
    const body = result.lines.at(-1) as { dockflowNodeResult: { status: string; verification: { problems: { severity: string }[]; readyNodes: number } | null } };
    expect(body.dockflowNodeResult.status).toBe('ok');
    expect(body.dockflowNodeResult.verification?.readyNodes).toBe(1);
    expect(body.dockflowNodeResult.verification?.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });
});
