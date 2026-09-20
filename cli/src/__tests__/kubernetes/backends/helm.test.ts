// KubernetesHelmBackend (design-04 3.5-3.9, D17, PD-3, PD-4, PD-9; design-07 10.6). Helm is faked at
// the executor level (DESIGN-CORE 8.9): these tests exercise the argv and stdin Dockflow actually
// sends, and the ownership/spec-hash labels it reads back over kubectl. PD-3 supersedes design-07's
// "checksum on an annotation" text: the skip predicate reads the `P/spec-hash` release LABEL, so the
// fixtures here seed that label directly instead of an annotation.

import { afterEach, describe, expect, test } from 'bun:test';
import type { HelmReleaseRecord, ResolvedHelmRelease } from '../../../services/orchestrator/interfaces';
import { KubernetesHelmBackend } from '../../../services/orchestrator/kubernetes/backends/helm';
import { removeVolumesByProtocol, type VolumeTarget } from '../../../services/orchestrator/kubernetes/backends/volumes';
import { LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { helmSpecHash } from '../../../services/orchestrator/kubernetes/helm/resolve';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { FakeClock } from '../fakes/fake-clock';
import { fakeNode, FakeKubeExecutor } from '../fakes/fake-kube-executor';
import { FakeHelmExecutor } from '../fakes/fake-helm-executor';
import { FakeNodeShell } from '../fakes/fake-node-shell';
import { assertExecutorInvariants, assertNoSecretLeak } from '../support/invariants';
import { readHelmFixture } from '../support/kubectl-fixtures';

const NODE = fakeNode('server_1');
const NS = 'dockflow-shop-production';
const REPO = 'https://charts.example.org';
const ENV = 'production';

// ---------------------------------------------------------------------------
// Harness (design-07 3.5, 3.6, 3.9): FakeHelmExecutor and FakeNodeShell share one node's file
// system, FakeCluster answers the kubectl reads of releaseLabels()/ownerOf()/namespaceOwnerOf().
// ---------------------------------------------------------------------------

interface Harness {
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  helm: FakeHelmExecutor;
  nodeShell: FakeNodeShell;
  clock: FakeClock;
  backend: KubernetesHelmBackend;
  /** this harness's test deletes a PersistentVolumeClaim/PersistentVolume (INV-04) */
  volumeDeletion: boolean;
}

let harnesses: Harness[] = [];

afterEach(() => {
  const current = harnesses;
  harnesses = [];
  for (const h of current) {
    h.kube.assertDone();
    h.helm.assertDone();
    h.nodeShell.assertDone();
    assertExecutorInvariants({
      kube: h.kube,
      helm: h.helm,
      nodeShell: h.nodeShell,
      redactor: h.kube.redactor,
      volumes: h.cluster,
      allow: { volumeDeletion: h.volumeDeletion },
    });
    h.cluster.assertNoProblems();
  }
});

function harness(options: { volumeDeletion?: boolean } = {}): Harness {
  const redactor = new Redactor([]);
  const cluster = new FakeCluster();
  const kube = new FakeKubeExecutor({ redactor, cluster, node: NODE });
  const nodeShell = new FakeNodeShell([], { redactor, interpretFileCommands: true });
  const helm = new FakeHelmExecutor({ redactor, node: NODE, nodeShell });
  const clock = new FakeClock();
  const backend = new KubernetesHelmBackend({
    deps: { helm, kubectl: kube, nodeShell: nodeShell.forNode, clock, redactor, distribution: kube.distribution },
    env: ENV,
  });
  const h: Harness = { cluster, kube, helm, nodeShell, clock, backend, volumeDeletion: options.volumeDeletion ?? false };
  harnesses.push(h);
  return h;
}

/** the Helm storage Secret kubectl sees for one revision: labels only, never the release payload */
function seedSecret(cluster: FakeCluster, params: { namespace: string; name: string; revision: number; stackId: string; role: string; specHash?: string; status?: string }): void {
  const object: KubeObject = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `sh.helm.release.v1.${params.name}.v${params.revision}`,
      namespace: params.namespace,
      labels: {
        owner: 'helm',
        name: params.name,
        status: params.status ?? 'deployed',
        version: String(params.revision),
        [LABELS.stack]: params.stackId,
        [LABELS.role]: params.role,
        ...(params.specHash !== undefined ? { [LABELS.specHash]: params.specHash } : {}),
      },
    },
  };
  cluster.seed(object);
}

function release(overrides: Partial<ResolvedHelmRelease> = {}): ResolvedHelmRelease {
  const values = overrides.values ?? { replicaCount: 2 };
  return {
    name: 'postgres',
    role: 'accessory',
    namespace: NS,
    chart: { kind: 'repo', repo: REPO, chart: 'postgresql' },
    version: '16.7.4',
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: 300,
    auth: null,
    declaredDigest: null,
    ...overrides,
  };
}

function record(rel: ResolvedHelmRelease, chartSha256: string | null): HelmReleaseRecord {
  const { auth: _auth, declaredDigest: _declaredDigest, ...rest } = rel;
  return { ...rest, chartSha256 };
}

/**
 * Registers the chart of `rel` with the fake and installs it at revision 1, deployed — mirrored on
 * both fakes: FakeHelmExecutor's own revision labels (what a `helm list -l ...` selector matches)
 * and a FakeCluster Secret with the same labels (what `releaseLabels()`/`ownerOf()` read over kubectl).
 */
function seedInstalled(h: Harness, rel: ResolvedHelmRelease, options: { stackId?: string } = {}): string {
  const chartName = rel.chart.kind === 'repo' ? rel.chart.chart : 'chart';
  const stackId = options.stackId ?? rel.namespace;
  const sha256 = h.helm.chart({ name: chartName, version: rel.version, repo: rel.chart.kind === 'repo' ? rel.chart.repo : undefined });
  const labels = { [LABELS.stack]: stackId, [LABELS.role]: rel.role, [LABELS.specHash]: helmSpecHash(rel) };
  h.helm.seedRelease({ name: rel.name, namespace: rel.namespace, revisions: [{ chart: chartName, version: rel.version, values: rel.values, labels }] });
  seedSecret(h.cluster, { namespace: rel.namespace, name: rel.name, revision: 1, stackId, role: rel.role, specHash: helmSpecHash(rel) });
  return sha256;
}

/** a Bound PersistentVolumeClaim naming `volume`, minimal fields only (design-04 3.10, C13) */
function claimObj(name: string, volume: string): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: NS, uid: `uid-${name}` },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local', volumeName: volume },
    status: { phase: 'Bound' },
  };
}

/** the PersistentVolume `name` is bound to, Retain, no node affinity (not a lost-node case) */
function volumeObj(name: string, claim: string): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name },
    spec: {
      accessModes: ['ReadWriteOnce'],
      capacity: { storage: '1Gi' },
      claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: claim, namespace: NS, uid: `uid-${claim}` },
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'dockflow-local',
    },
    status: { phase: 'Bound' },
  };
}

class Events {
  readonly steps: string[] = [];
  readonly warnings: { message: string; suggestion?: string }[] = [];
  readonly sink = {
    step: (text: string): void => {
      this.steps.push(text);
    },
    warn: (message: string, suggestion?: string): void => {
      this.warnings.push(suggestion === undefined ? { message } : { message, suggestion });
    },
  };
}

// ---------------------------------------------------------------------------
// upgradeInstall (3.6)
// ---------------------------------------------------------------------------

describe('upgradeInstall', () => {
  test('U-BE-HELM-01: a fresh install returns HelmReleaseStatus from list --filter, never status -o json', async () => {
    const h = harness();
    const rel = release({ name: 'search', declaredDigest: null });
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });

    const events = new Events();
    const result = await h.backend.upgradeInstall(rel, { historyMax: 5, stackId: NS, events: events.sink });

    expect(result.changed).toBe(true);
    expect(result.previousRevision).toBeNull();
    expect(result.status).toBe('deployed');
    expect(result.chartSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(h.helm.statusCalls).toBe(0);
    expect(events.steps).toEqual([`Installing Helm release search (postgresql 16.7.4 from ${REPO})...`]);

    const upgrade = h.helm.calls.find((call) => call.args[0] === 'upgrade');
    expect(upgrade).toBeDefined();
    expect(upgrade?.args).not.toContain('--version');
    expect(upgrade?.args).not.toContain('--repo');
    expect(upgrade?.stdin).toBe(`${canonicalJson(rel.values)}\n`);
    expect(upgrade?.args).toContain('--labels');
    expect(upgrade?.args[upgrade.args.indexOf('--labels') + 1]).toBe(`${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.specHash}=${helmSpecHash(rel)}`);
  });

  test('U-BE-HELM-08: the skip predicate reads the P/spec-hash release LABEL (PD-3), never an annotation', async () => {
    const h = harness();
    const rel = release({ name: 'postgres' });
    seedInstalled(h, rel);

    const events = new Events();
    const callsBefore = h.helm.calls.length;
    const result = await h.backend.upgradeInstall(rel, { historyMax: 5, stackId: NS, events: events.sink });

    expect(result.changed).toBe(false);
    expect(result.previousRevision).toBe(1);
    expect(events.steps).toEqual([]);
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade' || call.args[0] === 'install')).toBe(false);
    // the skip rule reuses the read planning already did: no further Helm call at all (3.6)
    expect(h.helm.calls.length).toBe(callsBefore + 1);

    const secret = h.cluster.get('Secret', 'sh.helm.release.v1.postgres.v1', NS);
    expect(secret?.metadata.annotations?.[LABELS.specHash]).toBeUndefined();
    expect(secret?.metadata.labels?.[LABELS.specHash]).toBe(helmSpecHash(rel));
  });

  test('U-BE-HELM-08: changed values, a changed chart version and a changed repo each cause one upgrade', async () => {
    for (const changed of [
      release({ name: 'postgres', values: { replicaCount: 3 } }),
      release({ name: 'postgres', version: '17.0.0' }),
      release({ name: 'postgres', chart: { kind: 'repo', repo: 'https://charts.other.example.org', chart: 'postgresql' } }),
    ]) {
      const h = harness();
      seedInstalled(h, release({ name: 'postgres' }));
      h.helm.chart({ name: 'postgresql', version: changed.version, repo: changed.chart.kind === 'repo' ? changed.chart.repo : undefined });

      const result = await h.backend.upgradeInstall(changed, { historyMax: 5, stackId: NS });

      expect(result.changed).toBe(true);
      expect(result.previousRevision).toBe(1);
      const upgrade = h.helm.calls.find((call) => call.args[0] === 'upgrade');
      expect(upgrade).toBeDefined();
    }
  });

  test('U-BE-HELM-06: a failed upgrade with --rollback-on-failure is a redacted DeployError', async () => {
    const h = harness();
    const rel = release({ name: 'search', values: { message: 'changed' } });
    seedInstalled(h, release({ name: 'search' }));
    h.helm.chart({ name: 'postgresql', version: rel.version, repo: REPO });
    h.helm.failNext('search', readHelmFixture('helm-history-rollback', 'upgrade-stderr.txt'));

    try {
      await h.backend.upgradeInstall(rel, { historyMax: 5, stackId: NS });
      throw new Error('expected upgradeInstall to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      const deployError = error as DeployError;
      expect(deployError.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(deployError.message).toContain('failed to upgrade and was rolled back to its previous revision');
      expect(deployError.message).not.toContain('UPGRADE FAILED');
    }
  });

  test('an adoption dry-runs the upgrade first (3.7.4 step 4)', async () => {
    const h = harness();
    const rel = release({ name: 'legacy', role: 'app' });
    const sha256 = h.helm.chart({ name: 'postgresql', version: rel.version, repo: REPO });
    h.helm.seedRelease({ name: 'legacy', namespace: NS, revisions: [{ chart: 'postgresql', version: rel.version, values: { replicaCount: 1 } }] });
    // no P/stack label: not installed by Dockflow, so plan() reports owner 'none'

    const events = new Events();
    const result = await h.backend.upgradeInstall(rel, { historyMax: 5, stackId: NS, adopt: true, events: events.sink });

    expect(result.changed).toBe(true);
    expect(result.adopted).toBe(true);
    expect(result.previousRevision).toBe(1);
    expect(result.chartSha256).toBe(sha256);
    expect(events.steps).toEqual([`Taking over Helm release legacy (postgresql ${rel.version} from ${REPO})...`]);
    const upgrades = h.helm.calls.filter((call) => call.args[0] === 'upgrade');
    expect(upgrades).toHaveLength(2);
    expect(upgrades[0].args).toContain('--dry-run=server');
    expect(upgrades[1].args).not.toContain('--dry-run=server');
  });

  test('a release owned by another Dockflow stack is blocked before any Helm mutation', async () => {
    const h = harness();
    const rel = release({ name: 'postgres' });
    seedInstalled(h, rel, { stackId: 'dockflow-other-production' });

    await expect(h.backend.upgradeInstall(rel, { historyMax: 5, stackId: NS })).rejects.toThrow(DeployError);
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade' || call.args[0] === 'install')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list / listAll (3.6)
// ---------------------------------------------------------------------------

describe('list / listAll', () => {
  test('U-BE-HELM-02, U-BE-HELM-09: roles from labels, one release per namespace, no payload reads', async () => {
    const h = harness();
    const app = release({ name: 'search', role: 'app', chart: { kind: 'repo', repo: REPO, chart: 'search' } });
    const accessory = release({ name: 'postgres', role: 'accessory' });
    seedInstalled(h, app);
    seedInstalled(h, accessory);

    const owned = await h.backend.list([], NS);
    expect(owned).toHaveLength(2);
    expect(owned.find((row) => row.name === 'search')?.role).toBe('app');
    expect(owned.find((row) => row.name === 'postgres')?.role).toBe('accessory');

    const scoped = await h.backend.listAll(NS);
    expect(scoped.map((row) => row.name).sort()).toEqual(['postgres', 'search']);

    const narrowed = await h.backend.list([NS], NS);
    expect(narrowed).toHaveLength(2);

    // U-BE-HELM-09: listing never pulls a release's manifest or values
    expect(h.helm.calls.some((call) => call.args[0] === 'get')).toBe(false);
  });

  test('an unlabelled release outside any stack is listed with role null', async () => {
    const h = harness();
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });
    h.helm.seedRelease({ name: 'vault', namespace: NS, revisions: [{ chart: 'postgresql', version: '16.7.4' }] });

    const rows = await h.backend.list([NS], null);
    expect(rows).toEqual([expect.objectContaining({ name: 'vault', role: null })]);
  });
});

// ---------------------------------------------------------------------------
// history (3.6)
// ---------------------------------------------------------------------------

interface HistoryFixtureRow {
  revision: number;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

describe('history', () => {
  test('U-BE-HELM-03, U-BE-HELM-09: the helm-history-rollback fixture parses to superseded, failed, deployed', async () => {
    const h = harness();
    const rows = JSON.parse(readHelmFixture('helm-history-rollback', 'history.json')) as HistoryFixtureRow[];
    const namespace = 'fixture-helm-history-rollback';
    h.helm.seedRelease({
      name: 'web',
      namespace,
      revisions: rows.map((row) => {
        const [chart, version] = splitChart(row.chart);
        return { chart, version, appVersion: row.app_version, status: row.status, description: row.description };
      }),
    });

    const history = await h.backend.history(namespace, 'web', 20);

    expect(history.map((entry) => entry.status)).toEqual(rows.map((row) => row.status).reverse());
    expect(history.map((entry) => entry.revision)).toEqual(rows.map((row) => row.revision).reverse());
    expect(history.every((entry) => entry.description !== null)).toBe(true);
    // U-BE-HELM-09: a history read never pulls the manifest or the values
    expect(h.helm.calls.some((call) => call.args[0] === 'get')).toBe(false);
  });
});

/** `e2e-web-0.1.0` -> `['e2e-web', '0.1.0']`, the shape `helm list`/`history` print a chart as */
function splitChart(chart: string): [string, string] {
  const match = /^(.*)-(\d+\.\d+\.\d+.*)$/.exec(chart);
  if (!match) throw new Error(`Fixture chart string ${chart} does not split into name and version`);
  return [match[1], match[2]];
}

// ---------------------------------------------------------------------------
// manifestObjects (3.6, DV3, helm uninstall --volumes)
// ---------------------------------------------------------------------------

describe('manifestObjects', () => {
  test('U-BE-HELM-04, U-BE-HELM-07: kind/name, hook-only and empty documents, keep annotation, namespace and claim templates', async () => {
    const h = harness();
    const manifest = [
      '---',
      '# Source: db/templates/hook.yaml',
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      '  name: db-migrate',
      '  annotations:',
      '    "helm.sh/hook": pre-upgrade',
      '---',
      '# empty document between two real ones',
      '---',
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      '  name: data-keep',
      '  namespace: dockflow-shop-production',
      '  annotations:',
      '    helm.sh/resource-policy: keep',
      '---',
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      '  name: data-delete',
      '---',
      'apiVersion: apps/v1',
      'kind: StatefulSet',
      'metadata: {name: db, namespace: dockflow-shop-production}',
      'spec:',
      '  volumeClaimTemplates:',
      '    - metadata: {name: data}',
    ].join('\n');
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO, manifest });
    h.helm.seedRelease({ name: 'postgres', namespace: NS, revisions: [{ chart: 'postgresql', version: '16.7.4', manifest }] });

    const objects = await h.backend.manifestObjects(NS, 'postgres');

    expect(objects).toEqual([
      { kind: 'Job', name: 'db-migrate', namespace: null, keep: false, claimTemplates: [] },
      { kind: 'PersistentVolumeClaim', name: 'data-keep', namespace: NS, keep: true, claimTemplates: [] },
      { kind: 'PersistentVolumeClaim', name: 'data-delete', namespace: null, keep: false, claimTemplates: [] },
      { kind: 'StatefulSet', name: 'db', namespace: NS, keep: false, claimTemplates: ['data'] },
    ]);
    // DV3: a PersistentVolumeClaim object is identified by kind alone, no separate flag needed
    expect(objects.filter((object) => object.kind === 'PersistentVolumeClaim').map((object) => object.keep)).toEqual([true, false]);
  });

  test('a release with no manifest yet (not installed) returns []', async () => {
    const h = harness();
    expect(await h.backend.manifestObjects(NS, 'absent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// uninstall (3.6)
// ---------------------------------------------------------------------------

describe('uninstall', () => {
  test('U-BE-HELM-05: --wait=watcher --cascade=foreground --timeout <t>s --ignore-not-found; not found -> no error', async () => {
    const h = harness();
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });
    h.helm.seedRelease({ name: 'postgres', namespace: NS, revisions: [{ chart: 'postgresql', version: '16.7.4' }] });

    const events = new Events();
    await h.backend.uninstall(NS, 'postgres', { timeoutS: 120, events: events.sink });

    const call = h.helm.calls.find((c) => c.args[0] === 'uninstall');
    expect(call?.args).toEqual(
      expect.arrayContaining(['uninstall', 'postgres', '-n', NS, '--wait=watcher', '--cascade=foreground', '--timeout', '120s', '--ignore-not-found']),
    );
    expect(events.steps).toEqual(['Uninstalling Helm release postgres...']);
    expect(h.helm.release(NS, 'postgres')).toBeNull();

    // a second uninstall of the now-missing release does not throw (--ignore-not-found)
    await h.backend.uninstall(NS, 'postgres', { timeoutS: 120 });
  });
});

// ---------------------------------------------------------------------------
// rollback, plan, deployedValues, revisionsWithSpec, ownerOf (U-BE-HELM-07)
// ---------------------------------------------------------------------------

describe('rollback', () => {
  test('rolls back to a revision and returns the resulting status, never status -o json', async () => {
    const h = harness();
    const rel = release({ name: 'postgres', values: { replicaCount: 1 } });
    seedInstalled(h, rel);
    // a second revision so revision 1 is something to roll back to
    h.helm.chart({ name: 'postgresql', version: '17.0.0' });
    await h.backend.upgradeInstall(release({ name: 'postgres', version: '17.0.0' }), { historyMax: 5, stackId: NS });

    const status = await h.backend.rollback(NS, 'postgres', 1, { timeoutS: 120, historyMax: 5 });
    expect(status.revision).toBeGreaterThan(1);
    expect(status.status).toBe('deployed');
    expect(h.helm.statusCalls).toBe(0);
    const call = h.helm.calls.find((c) => c.args[0] === 'rollback');
    expect(call?.args).toEqual(expect.arrayContaining(['rollback', 'postgres', '1', '-n', NS, '--wait=watcher', '--wait-for-jobs', '--timeout', '120s', '--history-max', '5']));
  });
});

describe('plan', () => {
  test('not installed, unchanged, changed and a foreign owner', async () => {
    const h = harness();
    const unchanged = release({ name: 'postgres' });
    seedInstalled(h, unchanged);
    const changedRelease = release({ name: 'search', role: 'app', chart: { kind: 'repo', repo: REPO, chart: 'search' } });
    seedInstalled(h, release({ name: 'search', role: 'app', chart: { kind: 'repo', repo: REPO, chart: 'search' }, values: { replicaCount: 1 } }));
    const notInstalled = release({ name: 'cache', role: 'app', chart: { kind: 'repo', repo: REPO, chart: 'cache' } });
    const foreign = release({ name: 'vault', role: 'app', chart: { kind: 'repo', repo: REPO, chart: 'vault' } });
    seedInstalled(h, foreign, { stackId: 'dockflow-other-production' });

    const entries = await h.backend.plan([unchanged, changedRelease, notInstalled, foreign], NS);

    expect(entries.find((e) => e.release === 'postgres')?.action).toBe('skipped');
    expect(entries.find((e) => e.release === 'search')?.action).toBe('upgraded');
    expect(entries.find((e) => e.release === 'cache')).toEqual(expect.objectContaining({ action: 'installed', reason: 'not installed' }));
    expect(entries.find((e) => e.release === 'vault')?.action).toBe('blocked');
  });
});

describe('deployedValues', () => {
  test('values and their sha256, a specific revision, and null for a missing release', async () => {
    const h = harness();
    const rel = release({ name: 'postgres', values: { replicaCount: 3, image: { tag: 'v16' } } });
    seedInstalled(h, rel);

    const values = await h.backend.deployedValues(NS, 'postgres');
    expect(values).toEqual({ values: rel.values, valuesSha256: sha256Hex(canonicalJson(rel.values)) });

    const byRevision = await h.backend.deployedValues(NS, 'postgres', 1);
    expect(byRevision?.values).toEqual(rel.values);

    expect(await h.backend.deployedValues(NS, 'absent')).toBeNull();
  });

  test('a release installed without values returns {} rather than null', async () => {
    const h = harness();
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });
    h.helm.seedRelease({ name: 'postgres', namespace: NS, revisions: [{ chart: 'postgresql', version: '16.7.4' }] });

    expect(await h.backend.deployedValues(NS, 'postgres')).toEqual({ values: {}, valuesSha256: sha256Hex(canonicalJson({})) });
  });
});

describe('revisionsWithSpec', () => {
  test('deployed/superseded revisions, newest first, optionally filtered by spec hash', async () => {
    const h = harness();
    const rel = release({ name: 'postgres', values: { replicaCount: 1 } });
    seedInstalled(h, rel);
    h.helm.chart({ name: 'postgresql', version: '17.0.0' });
    await h.backend.upgradeInstall(release({ name: 'postgres', version: '17.0.0' }), { historyMax: 5, stackId: NS });
    seedSecret(h.cluster, { namespace: NS, name: 'postgres', revision: 2, stackId: NS, role: 'accessory', specHash: helmSpecHash(release({ name: 'postgres', version: '17.0.0' })), status: 'deployed' });

    const all = await h.backend.revisionsWithSpec(NS, 'postgres');
    expect(all.map((r) => r.revision)).toEqual([2, 1]);

    const filtered = await h.backend.revisionsWithSpec(NS, 'postgres', helmSpecHash(rel));
    expect(filtered.map((r) => r.revision)).toEqual([1]);
  });
});

describe('ownerOf', () => {
  test('the stack and role of a labelled release, null for one Dockflow never touched', async () => {
    const h = harness();
    seedInstalled(h, release({ name: 'postgres', role: 'accessory' }));

    expect(await h.backend.ownerOf(NS, 'postgres')).toEqual({ stackId: NS, role: 'accessory' });
    expect(await h.backend.ownerOf(NS, 'absent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pinCharts (3.4.4)
// ---------------------------------------------------------------------------

describe('pinCharts', () => {
  test('a config digest is verified, a previous record is reused, otherwise the archive is pulled', async () => {
    const h = harness();
    const bytes = 'fake chart archive postgresql-16.7.4\n';
    const sha256 = h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO, bytes });
    // a cache hit for the config-declared digest needs no network (design-04 3.5.3 step 1)
    h.helm.seedCache(sha256, bytes);

    const declared = release({ name: 'declared', declaredDigest: sha256 });
    const fromRecord = release({ name: 'from-record' });
    const previous: HelmReleaseRecord[] = [record(fromRecord, sha256)];
    const fresh = release({ name: 'fresh' });

    const pinned = await h.backend.pinCharts([declared, fromRecord, fresh], previous, { allowChartDrift: false });

    expect(pinned.find((r) => r.name === 'declared')?.declaredDigest).toBe(sha256);
    expect(pinned.find((r) => r.name === 'from-record')?.declaredDigest).toBe(sha256);
    expect(pinned.find((r) => r.name === 'fresh')?.declaredDigest).toBe(sha256);
    // a cache hit and a record reuse pin the digest without pulling; only "fresh" needed the network
    const pulls = h.helm.calls.filter((c) => c.args[0] === 'pull');
    expect(pulls).toHaveLength(1);
  });

  test('a mismatched declared digest refuses without --allow-chart-drift', async () => {
    const h = harness();
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });
    const declared = release({ name: 'declared', declaredDigest: '0'.repeat(64) });

    await expect(h.backend.pinCharts([declared], [], { allowChartDrift: false })).rejects.toThrow(DeployError);
  });

  test('a mismatched declared digest is repinned to the actual bytes with --allow-chart-drift', async () => {
    const h = harness();
    const sha256 = h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });
    const declared = release({ name: 'declared', declaredDigest: '0'.repeat(64) });

    const pinned = await h.backend.pinCharts([declared], [], { allowChartDrift: true });

    expect(pinned[0]?.declaredDigest).toBe(sha256);
    expect(pinned[0]?.declaredDigest).not.toBe('0'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// credentials (3.5.3): a private repository authenticates without exposing them in argv
// ---------------------------------------------------------------------------

describe('credentials', () => {
  test('a private repository chart authenticates through a per-call file, never argv', async () => {
    const h = harness();
    const password = 'chart-repo-password-5519';
    // registered on the harness's shared redactor: afterEach's assertExecutorInvariants (INV-02)
    // checks every kube/helm/nodeShell call for it too
    h.helm.redactor.add([password]);
    const auth = { username: 'ci-bot', password };
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO });
    const rel = release({ name: 'private', declaredDigest: null, auth });

    const result = await h.backend.upgradeInstall(rel, { historyMax: 5, stackId: NS });

    expect(result.changed).toBe(true);
    expect(h.helm.credentials.some((c) => c.kind === 'repo-update')).toBe(true);
    // the credentials file lived only inside the pull's own temp directory, removed in `finally`
    expect(h.helm.credentialFilesLeft()).toEqual([]);
    assertNoSecretLeak(h.helm, [password]);
  });
});

// ---------------------------------------------------------------------------
// uninstall --volumes (design-04 3.10): the C13 protocol runs after the release is gone
// ---------------------------------------------------------------------------

describe('uninstall --volumes', () => {
  test('manifestObjects is read before uninstall, then removeVolumesByProtocol deletes the claims it found, one at a time', async () => {
    const h = harness({ volumeDeletion: true });
    const manifest = [
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata: {name: data-a}',
      '---',
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata: {name: data-b}',
    ].join('\n');
    h.helm.chart({ name: 'postgresql', version: '16.7.4', repo: REPO, manifest });
    h.helm.seedRelease({ name: 'postgres', namespace: NS, revisions: [{ chart: 'postgresql', version: '16.7.4', manifest }] });
    h.cluster.seed([claimObj('data-a', 'pv-data-a'), volumeObj('pv-data-a', 'data-a'), claimObj('data-b', 'pv-data-b'), volumeObj('pv-data-b', 'data-b')]);

    // design-04 3.10 step 0: the deletable claims are read from the manifest while the release still exists
    const claims: VolumeTarget[] = (await h.backend.manifestObjects(NS, 'postgres'))
      .filter((object) => object.kind === 'PersistentVolumeClaim' && !object.keep)
      .map((object) => ({ claim: object.name, volume: null }));
    expect(claims.map((c) => c.claim)).toEqual(['data-a', 'data-b']);

    // step 1: helm uninstall itself never touches the PVCs (they are not part of the Helm call)
    await h.backend.uninstall(NS, 'postgres', { timeoutS: 120 });
    expect(h.helm.release(NS, 'postgres')).toBeNull();
    expect(h.cluster.get('PersistentVolumeClaim', 'data-a', NS)).toBeDefined();

    // step 2: the core C13 protocol, one volume at a time
    const report = await removeVolumesByProtocol({ kubectl: h.kube }, claims, { namespace: NS, env: ENV });

    expect(report.deleted.map((d) => d.claim).sort()).toEqual(['data-a', 'data-b']);
    expect(h.cluster.get('PersistentVolumeClaim', 'data-a', NS)).toBeUndefined();
    expect(h.cluster.get('PersistentVolumeClaim', 'data-b', NS)).toBeUndefined();
    expect(h.cluster.get('PersistentVolume', 'pv-data-a')).toBeUndefined();
    expect(h.cluster.get('PersistentVolume', 'pv-data-b')).toBeUndefined();
  });
});
