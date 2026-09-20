// KubernetesStackBackend (design-03 2-18, design-04 3.8.1-3.8.8; design-07 10.1). Cluster mode over
// FakeCluster: `deploy`/`apply`/`finalize` drive the real ApplyEngine and prune/revert modules
// against a real in-memory API server, so ordering, selectors and live state are what the actual
// backend produces. Helm is faked at the executor level (the real KubernetesHelmBackend runs).
// Covers design-03 22.3's SD* and 22.5's F* rows at the stack.ts composition level (the pre-apply
// engine mechanics themselves are P41's own suite); W*/H*/R*/S* rows live in stack-wait.test.ts,
// apply/revert.test.ts and stack-day2.test.ts, split along PD-1's files (PD-11 (d)).

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ResolvedHelmRelease, StackArtifact, StackRef } from '../../../services/orchestrator/interfaces';
import { KubernetesStackBackend, type KubernetesStackBackendOptions } from '../../../services/orchestrator/kubernetes/backends/stack';
import { LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo } from '../../../services/orchestrator/kubernetes/deps';
import { helmSpecHash } from '../../../services/orchestrator/kubernetes/helm/resolve';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { namespaceFor } from '../../../services/orchestrator/kubernetes/naming';
import type { RenderEnvironment } from '../../../services/orchestrator/kubernetes/render';
import { withDigests } from '../../../services/orchestrator/file-resolver';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { ErrorCode } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { DEFAULT_SERVER_NAMES, deployInput, type DeployInputOverrides, fileResolver } from '../support/builders';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { fakeNode, FakeKubeExecutor } from '../fakes/fake-kube-executor';
import { FakeHelmExecutor } from '../fakes/fake-helm-executor';
import { FakeNodeShell } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';

const PROJECT = 'shop';
const ENV = 'production';
const NS = namespaceFor(PROJECT, ENV);
const REPO = 'https://charts.example.org';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  clock: FakeClock;
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  helmExec: FakeHelmExecutor;
  nodeShell: FakeNodeShell;
  redactor: Redactor;
  releases: FakeReleaseStore;
  backend: KubernetesStackBackend;
  preflightCalls: { routes: boolean; volumes: boolean; helm: boolean }[];
}

let current: Harness | null = null;

interface HarnessOptions {
  script?: { strict: true };
  proxy?: KubernetesStackBackendOptions['proxy'];
  helmAuth?: KubernetesStackBackendOptions['helmAuth'];
}

function harness(options: HarnessOptions = {}): Harness {
  const redactor = new Redactor([]);
  const clock = new FakeClock();
  const cluster = new FakeCluster({ clock });
  const kube = options.script
    ? new FakeKubeExecutor({ redactor, clock, order: 'strict' })
    : new FakeKubeExecutor({ redactor, cluster, clock });
  const nodeShell = new FakeNodeShell([], { redactor, interpretFileCommands: true });
  const helmExec = new FakeHelmExecutor({ redactor, node: kube.node, nodeShell, clock });
  const releases = new FakeReleaseStore();
  const preflightCalls: { routes: boolean; volumes: boolean; helm: boolean }[] = [];
  const render: RenderEnvironment = {
    traits: k3sDistribution.traits,
    imageDelivery: 'import',
    extraReservedHostPorts: [{ port: 22, protocol: 'TCP', reason: 'SSH port of server_1' }],
  };
  const backend = new KubernetesStackBackend({
    deps: { kubectl: kube, helm: helmExec, nodeShell: nodeShell.forNode, clock, redactor, distribution: kube.distribution },
    memo: createSharedMemo(),
    target: { env: ENV, controlPlane: fakeNode('server_1') },
    cluster: {
      preflight: async (needs) => {
        preflightCalls.push(needs);
      },
    },
    releases,
    render,
    serverNames: DEFAULT_SERVER_NAMES,
    helmHistoryMax: 5,
    proxy: options.proxy,
    helmAuth: options.helmAuth,
  });
  const h: Harness = { clock, cluster, kube, helmExec, nodeShell, redactor, releases, backend, preflightCalls };
  current = h;
  return h;
}

afterEach(() => {
  const h = current;
  current = null;
  if (!h) return;
  h.kube.assertDone();
  h.helmExec.assertDone();
  h.nodeShell.assertDone();
  assertExecutorInvariants({ kube: h.kube, helm: h.helmExec, nodeShell: h.nodeShell, redactor: h.redactor });
  h.cluster.assertNoProblems();
});

let warnings: string[] = [];
let infos: string[] = [];

beforeEach(() => {
  warnings = [];
  infos = [];
  spyOn(output, 'printWarning').mockImplementation((message: string) => {
    warnings.push(message);
  });
  spyOn(output, 'printInfo').mockImplementation((message: string) => {
    infos.push(message);
  });
  spyOn(output, 'printDebug').mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Fake ReleaseStore (Pick<ReleaseStore, 'current' | 'currentVersion' | 'list' | 'readArtifact' | 'readState' | 'writeAccessoriesDigest'>)
// ---------------------------------------------------------------------------

interface ReleaseRow {
  version: string;
  epoch: number;
  artifact: StackArtifact;
}

class FakeReleaseStore {
  private rows: ReleaseRow[] = [];
  state: { current: string | null; accessoriesDigest: string | null } = { current: null, accessoriesDigest: null };
  readonly digestCalls: { stackName: string; digest: string | null }[] = [];
  readonly readStateCalls: string[] = [];

  seed(row: ReleaseRow, options: { current?: boolean } = {}): void {
    this.rows.push(row);
    if (options.current) this.state = { ...this.state, current: row.version };
  }

  async current() {
    const version = this.state.current;
    if (version === null) return null;
    const row = this.rows.find((r) => r.version === version);
    if (!row) return null;
    return {
      project_name: PROJECT,
      version: row.version,
      env: ENV,
      timestamp: '2026-01-01T00:00:00Z',
      epoch: row.epoch,
      performer: 'alice',
      branch: 'main',
    };
  }

  async currentVersion() {
    return this.state.current;
  }

  async list() {
    return this.rows.map((r) => ({
      project_name: PROJECT,
      version: r.version,
      env: ENV,
      timestamp: '2026-01-01T00:00:00Z',
      epoch: r.epoch,
      performer: 'alice',
      branch: 'main',
    }));
  }

  async readArtifact(_stackName: string, version: string): Promise<StackArtifact> {
    const row = this.rows.find((r) => r.version === version);
    if (!row) throw new Error(`Release ${version} not found`);
    return row.artifact;
  }

  async readState(stackName: string) {
    this.readStateCalls.push(stackName);
    return this.state;
  }

  async writeAccessoriesDigest(stackName: string, digest: string | null): Promise<void> {
    this.digestCalls.push({ stackName, digest });
    this.state = { ...this.state, accessoriesDigest: digest };
  }
}

// ---------------------------------------------------------------------------
// Helm helpers
// ---------------------------------------------------------------------------

function helmRelease(overrides: Partial<ResolvedHelmRelease> = {}): ResolvedHelmRelease {
  const values = overrides.values ?? { replicaCount: 1 };
  return {
    name: 'metrics',
    role: 'app',
    namespace: NS,
    chart: { kind: 'repo', repo: REPO, chart: 'metrics' },
    version: '1.0.0',
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: 300,
    auth: null,
    declaredDigest: null,
    ...overrides,
  };
}

/** Registers the chart and installs it at revision 1, deployed, on both fakes (mirrors helm.test.ts). */
function seedInstalledHelmRelease(h: Harness, release: ResolvedHelmRelease): void {
  const chartName = release.chart.kind === 'repo' ? release.chart.chart : 'chart';
  h.helmExec.chart({ name: chartName, version: release.version, repo: release.chart.kind === 'repo' ? release.chart.repo : undefined });
  const labels = { [LABELS.stack]: release.namespace, [LABELS.role]: release.role, [LABELS.specHash]: helmSpecHash(release) };
  h.helmExec.seedRelease({ name: release.name, namespace: release.namespace, revisions: [{ chart: chartName, version: release.version, values: release.values, labels }] });
  const secret: KubeObject = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `sh.helm.release.v1.${release.name}.v1`,
      namespace: release.namespace,
      labels: { owner: 'helm', name: release.name, status: 'deployed', version: '1', ...labels },
    },
  };
  h.cluster.seed(secret);
}

// ---------------------------------------------------------------------------
// Inputs and live reads
// ---------------------------------------------------------------------------

function input(overrides: DeployInputOverrides = {}) {
  return deployInput({ ref: { project: PROJECT, env: ENV, role: 'app' }, ...overrides });
}

function live(h: Harness, resource: string, name: string): KubeObject | undefined {
  return h.cluster.get(resource, name, NS);
}

function artifactOf(h: Harness, forInput = input()): StackArtifact {
  return h.backend.render(forInput);
}

// ---------------------------------------------------------------------------
// render (design-03 4, PD-1)
// ---------------------------------------------------------------------------

describe('render', () => {
  it('does no remote work: the render never touches the executor (K73)', () => {
    const h = harness({ script: { strict: true } });
    const artifact = h.backend.render(input());
    expect(artifact.content).toContain('kind: Deployment');
    expect(h.kube.calls).toEqual([]);
  });

  it('memoizes the render and re-renders only when a resolved file changes', () => {
    const h = harness({ script: { strict: true } });
    const composeWithEnvFile = { services: { web: { image: 'nginx:1.27', env_file: 'app.env' } } };
    const files = withDigests(fileResolver({ 'app.env': 'FOO=bar' }));
    const withFile = input({ compose: composeWithEnvFile, files });
    const first = h.backend.render(withFile);
    const second = h.backend.render(input({ compose: composeWithEnvFile, files }));
    expect(second).toBe(first);

    const changedFiles = withDigests(fileResolver({ 'app.env': 'FOO=baz' }));
    const third = h.backend.render(input({ compose: composeWithEnvFile, files: changedFiles }));
    expect(third).not.toBe(first);
  });

  it('renderKey depends on the input alone: the same input always yields the same digest', () => {
    const h = harness({ script: { strict: true } });
    const a = h.backend.render(input());
    const b = h.backend.render(input());
    expect(a.digest).toBe(b.digest);
  });
});

// ---------------------------------------------------------------------------
// deploy (design-03 5, 2.5; design-03 22.3 SD*)
// ---------------------------------------------------------------------------

describe('deploy', () => {
  it('deploys a fresh app role over an empty namespace (SD1)', async () => {
    const h = harness();
    const result = await h.backend.deploy(input());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.skipped).toBe(false);
    expect(result.data.previousVersion).toBeNull();
    expect(result.data.changes.some((c) => c.service === 'web' && c.created)).toBe(true);
    expect(live(h, 'deployments.apps', 'web')).toBeDefined();
    expect(h.preflightCalls.length).toBe(1);
    expect(infos.some((m) => m.startsWith('Applied '))).toBe(true);
  });

  it('applies only the closure under --only and marks receipt.services (SD9)', async () => {
    const h = harness();
    const two = input({ compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.27' } } } });
    await h.backend.deploy(two);

    const only = input({
      compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.27' } } },
      services: ['web'],
      previousVersion: '1.4.2',
    });
    const result = await h.backend.deploy(only);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.services).toEqual(['web']);
  });

  it('warns once about local changes --only leaves undeployed (SD10)', async () => {
    const h = harness();
    await h.backend.deploy(
      input({ compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.27' } } } }),
    );
    const changedWorker = input({
      compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.28' } } },
      services: ['web'],
    });
    warnings.length = 0;
    await h.backend.deploy(changedWorker);
    const hits = warnings.filter((m) => m.includes('has local changes') && m.includes('--only does not deploy'));
    expect(hits.length).toBe(1);
  });

  it('refuses a full deploy that would prune every live workload (SD11)', async () => {
    const h = harness();
    await h.backend.deploy(input());
    const empty = input({ compose: { services: {} } });
    const result = await h.backend.deploy(empty);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/Refusing to prune/);
  });

  describe('accessories change detection (SD16-SD18)', () => {
    function accessoryInput(overrides: DeployInputOverrides = {}) {
      return deployInput({ ref: { project: PROJECT, env: ENV, role: 'accessory' }, ...overrides });
    }

    it('skips when the digest matches and every rendered workload is already live (SD16)', async () => {
      const h = harness();
      const first = await h.backend.deploy(accessoryInput());
      expect(first.success).toBe(true);
      if (!first.success) return;
      h.releases.state = { ...h.releases.state, accessoriesDigest: first.data.artifactDigest };

      const second = await h.backend.deploy(accessoryInput());
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.data.skipped).toBe(true);
      expect(infos).toContain('Accessories unchanged, skipping');
    });

    it('does not skip when the digest matches but a rendered workload is missing (SD17)', async () => {
      const h = harness();
      const artifact = artifactOf(h, accessoryInput());
      h.releases.state = { ...h.releases.state, accessoriesDigest: artifact.digest };

      const result = await h.backend.deploy(accessoryInput());
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.skipped).toBe(false);
      expect(live(h, 'deployments.apps', 'web')).toBeDefined();
    });

    it('force bypasses the digest check without reading the stored state (SD18)', async () => {
      const h = harness();
      const first = await h.backend.deploy(accessoryInput());
      expect(first.success).toBe(true);
      if (!first.success) return;
      h.releases.state = { ...h.releases.state, accessoriesDigest: first.data.artifactDigest };
      h.releases.readStateCalls.length = 0;

      const result = await h.backend.deploy(accessoryInput({ force: true }));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.skipped).toBe(false);
      expect(h.releases.readStateCalls).toEqual([]);
    });
  });

  describe('Helm app releases (SD19, SD20, SD37)', () => {
    it('installs an app-role Helm release as part of the deploy, with the derived history budget (SD19)', async () => {
      const h = harness();
      const release = helmRelease();
      h.helmExec.chart({ name: 'metrics', version: '1.0.0', repo: REPO });
      const result = await h.backend.deploy(input({ helm: [release], helmDeclared: ['metrics'] }));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.helm[0]).toMatchObject({ name: 'metrics', status: 'deployed' });
      expect(result.data.helmChanges[0]).toMatchObject({ name: 'metrics', action: 'installed' });
      const upgrade = h.helmExec.calls.find((c) => c.args[0] === 'upgrade');
      expect(upgrade).toBeDefined();
      expect(upgrade?.args[(upgrade?.args.indexOf('--history-max') ?? -1) + 1]).toBe('5');
      expect(live(h, 'deployments.apps', 'web')).toBeDefined();
    });

    it('reverts what was already applied and reports the failure when a later Helm release fails (SD20)', async () => {
      const h = harness();
      const releaseA = helmRelease({ name: 'metrics' });
      const releaseB = helmRelease({ name: 'search', chart: { kind: 'repo', repo: REPO, chart: 'search' }, version: '2.0.0' });
      h.helmExec.chart({ name: 'metrics', version: '1.0.0', repo: REPO });
      h.helmExec.chart({ name: 'search', version: '2.0.0', repo: REPO });
      h.helmExec.failNext('search', 'Error: admission webhook "policy" denied the request');

      const result = await h.backend.deploy(input({ helm: [releaseA, releaseB], helmDeclared: ['metrics', 'search'] }));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).toMatch(/^Helm release search failed:/);
      expect(result.error.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(h.helmExec.release(NS, 'metrics')).not.toBeNull();
      expect(h.helmExec.release(NS, 'search')).toBeNull();
      expect(live(h, 'deployments.apps', 'web')).toBeUndefined();
    });

    it('skips an unchanged Helm release: no upgrade argv, nothing recorded as applied (SD37)', async () => {
      const h = harness();
      // a first deploy with no Helm release owns the namespace properly before the release is seeded
      await h.backend.deploy(input());
      const release = helmRelease();
      seedInstalledHelmRelease(h, release);
      const result = await h.backend.deploy(input({ helm: [release], helmDeclared: ['metrics'] }));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.helmChanges[0].action).toBe('skipped');
      expect(h.helmExec.calls.some((c) => c.args[0] === 'upgrade')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// apply (design-03 16.2)
// ---------------------------------------------------------------------------

describe('apply', () => {
  function appArtifact(): StackArtifact {
    return new KubernetesStackBackend(baseOptions(harness())).render(input());
  }

  function baseOptions(h: Harness): KubernetesStackBackendOptions {
    return {
      deps: { kubectl: h.kube, helm: h.helmExec, nodeShell: h.nodeShell.forNode, clock: h.clock, redactor: h.redactor, distribution: h.kube.distribution },
      memo: createSharedMemo(),
      target: { env: ENV, controlPlane: fakeNode('server_1') },
      cluster: { preflight: async () => {} },
      releases: h.releases,
      render: { traits: k3sDistribution.traits, imageDelivery: 'import', extraReservedHostPorts: [] },
      serverNames: DEFAULT_SERVER_NAMES,
      helmHistoryMax: 5,
    };
  }

  it('refuses an artifact of the wrong format', async () => {
    const h = harness({ script: { strict: true } });
    const artifact: StackArtifact = { format: 'swarm-compose/1', role: 'app', content: '', helm: [], diagnostics: [], digest: 'x' };
    const result = await h.backend.apply({ project: PROJECT, env: ENV, role: 'app' }, '1.0.0', artifact, { prune: true, services: null });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.ROLLBACK_FAILED);
    expect(result.error.message).toMatch(/produced for swarm-compose\/1/);
  });

  it('refuses an artifact recorded for a different role', async () => {
    const h = harness();
    const artifact = h.backend.render(deployInput({ ref: { project: PROJECT, env: ENV, role: 'accessory' } }));
    const result = await h.backend.apply({ project: PROJECT, env: ENV, role: 'app' }, '1.0.0', artifact, { prune: true, services: null });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(ErrorCode.ROLLBACK_FAILED);
    expect(result.error.message).toMatch(/recorded for role accessory/);
  });

  it('restores a stored artifact over the live namespace (16.2 restore semantics)', async () => {
    const h = harness();
    const artifact = h.backend.render(input());
    const result = await h.backend.apply({ project: PROJECT, env: ENV, role: 'app' }, '1.0.0', artifact, { prune: true, services: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.previousVersion).toBeNull();
    expect(live(h, 'deployments.apps', 'web')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// finalize (design-03 8; design-03 22.5 F*; NEVER THROWS)
// ---------------------------------------------------------------------------

describe('finalize', () => {
  it('is a no-op for a skipped receipt', async () => {
    const h = harness();
    const acc = deployInput({ ref: { project: PROJECT, env: ENV, role: 'accessory' } });
    const first = await h.backend.deploy(acc);
    expect(first.success).toBe(true);
    if (!first.success) return;
    h.releases.state = { ...h.releases.state, accessoriesDigest: first.data.artifactDigest };
    const second = await h.backend.deploy(acc);
    expect(second.success).toBe(true);
    if (!second.success || !second.data.skipped) return;
    const mark = h.kube.calls.length;
    await h.backend.finalize(second.data);
    expect(h.kube.calls.slice(mark)).toEqual([]);
  });

  it('prunes objects no longer in the render on a full deploy (F1)', async () => {
    const h = harness();
    const two = input({ compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.27' } } } });
    const first = await h.backend.deploy(two);
    expect(first.success).toBe(true);
    if (!first.success) return;
    await h.backend.finalize(first.data);

    const one = input({ compose: { services: { web: { image: 'nginx:1.27' } } } });
    const second = await h.backend.deploy(one);
    expect(second.success).toBe(true);
    if (!second.success) return;
    await h.backend.finalize(second.data);

    expect(live(h, 'deployments.apps', 'worker')).toBeUndefined();
    expect(live(h, 'deployments.apps', 'web')).toBeDefined();
    expect(infos.some((m) => /^Pruned \d+ object/.test(m))).toBe(true);
  });

  it('swallows a failing prune step and still runs the remaining steps (F4)', async () => {
    const h = harness();
    const result = await h.backend.deploy(input());
    expect(result.success).toBe(true);
    if (!result.success) return;
    h.cluster.rejectOn({ verb: 'get', kind: 'CustomResourceDefinition' }, 'Forbidden');
    await expect(h.backend.finalize(result.data)).resolves.toBeUndefined();
    expect(warnings.some((m) => m.startsWith('Cleanup after deploy failed (prune):'))).toBe(true);
  });

  it('uninstalls an app Helm release removed from config.yml when it owns no volume (F5)', async () => {
    const h = harness();
    const release = helmRelease();
    h.helmExec.chart({ name: 'metrics', version: '1.0.0', repo: REPO });
    const deployed = await h.backend.deploy(input({ helm: [release], helmDeclared: ['metrics'] }));
    expect(deployed.success).toBe(true);
    if (!deployed.success) return;

    const removed = await h.backend.deploy(input({ helm: [], helmDeclared: [] }));
    expect(removed.success).toBe(true);
    if (!removed.success) return;
    await h.backend.finalize(removed.data);

    expect(h.helmExec.release(NS, 'metrics')).toBeNull();
    expect(infos.some((m) => m.includes('Uninstalled Helm release metrics'))).toBe(true);
  });

  it('keeps an app Helm release that owns a volume and warns with the DV3 text (F6)', async () => {
    const h = harness();
    const deployed = await h.backend.deploy(input({ helm: [], helmDeclared: [] }));
    expect(deployed.success).toBe(true);
    if (!deployed.success) return;

    h.helmExec.chart({ name: 'db', version: '1.0.0', repo: REPO });
    // a live release finalize sees but that is not in this deploy's helmDeclared, with a PVC in its manifest
    const manifest = ['apiVersion: v1', 'kind: PersistentVolumeClaim', 'metadata:', '  name: db-data', `  namespace: ${NS}`].join('\n');
    h.helmExec.seedRelease({
      name: 'db',
      namespace: NS,
      revisions: [{ chart: 'db', version: '1.0.0', manifest, labels: { [LABELS.stack]: NS, [LABELS.role]: 'app' } }],
    });

    await h.backend.finalize(deployed.data);

    expect(h.helmExec.release(NS, 'db')).not.toBeNull();
    expect(warnings.some((m) => m.includes('Helm release db is no longer in config.yml but owns volumes') && m.includes('--volumes'))).toBe(true);
  });

  it('writes the accessories digest whether or not the role prunes (F7)', async () => {
    const h = harness();
    const acc = deployInput({ ref: { project: PROJECT, env: ENV, role: 'accessory' } });
    const result = await h.backend.deploy(acc);
    expect(result.success).toBe(true);
    if (!result.success) return;
    await h.backend.finalize(result.data);
    expect(h.releases.digestCalls.at(-1)).toEqual({ stackName: NS, digest: result.data.artifactDigest });
  });

  it('drops the registry pull Secret once no credentials are configured (F8)', async () => {
    const h = harness();
    const result = await h.backend.deploy(input());
    expect(result.success).toBe(true);
    if (!result.success) return;
    h.cluster.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'dockflow-registry', namespace: NS, labels: { [LABELS.part]: 'registry' } },
    });
    await h.backend.finalize(result.data);
    expect(live(h, 'secrets', 'dockflow-registry')).toBeUndefined();
  });

  it('issues no call at all for a partial (--only) receipt (F10)', async () => {
    const h = harness();
    const two = input({ compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.27' } } } });
    await h.backend.deploy(two);
    const only = input({
      compose: { services: { web: { image: 'nginx:1.27' }, worker: { image: 'nginx:1.27' } } },
      services: ['web'],
    });
    const result = await h.backend.deploy(only);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const mark = h.kube.calls.length;
    await h.backend.finalize(result.data);
    expect(h.kube.calls.slice(mark)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// revert / day-2 wiring (light smoke tests; exhaustive coverage lives in apply/revert.test.ts
// and stack-day2.test.ts, split along PD-1's files, PD-11 (d))
// ---------------------------------------------------------------------------

describe('revert', () => {
  it('reports an internal error for a receipt this backend never produced (R8)', async () => {
    const h = harness();
    const foreign = { ref: { project: PROJECT, env: ENV, role: 'app' } as StackRef, version: '1', startedAt: new Date(), services: null, skipped: false, artifactDigest: 'x', changes: [], helm: [], helmChanges: [], helmDeclared: [], previousVersion: null };
    const result = await h.backend.revert(foreign);
    expect(result).toEqual({ status: 'failed', services: [], message: 'internal error: receipt was not produced by this backend' });
  });
});

describe('day-2 delegation', () => {
  it('scale delegates to stack-day2 and reaches the target replica count', async () => {
    const h = harness();
    const deployed = await h.backend.deploy(input());
    expect(deployed.success).toBe(true);
    if (!deployed.success) return;
    await h.backend.scale({ project: PROJECT, env: ENV, role: 'app' }, 'web', 3, { wait: false, timeoutS: 30 });
    const web = live(h, 'deployments.apps', 'web') as { spec: { replicas: number } } | undefined;
    expect(web?.spec.replicas).toBe(3);
  });

  it('exists reflects whether the namespace was ever created', async () => {
    const h = harness();
    expect(await h.backend.exists({ project: PROJECT, env: ENV, role: 'app' })).toBe(false);
    await h.backend.deploy(input());
    expect(await h.backend.exists({ project: PROJECT, env: ENV, role: 'app' })).toBe(true);
  });
});
