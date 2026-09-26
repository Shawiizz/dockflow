// Stack backend day-2 methods (design-03 17, 18; design-06 3.11-3.14, 3.16, 5; design-07 10.1 S*
// rows, U-BE-STACK-20, U-BE-STACK-25 classes). Cluster mode over FakeCluster: workloads and volumes
// are real objects a real ApplyEngine reads, so ordering and selector assertions exercise the actual
// kubectl argv. Helm and the release store are hand fakes (Pick<HelmBackend, ...> /
// Pick<ReleaseStore, ...>): rollbackService and remove call them as peer collaborators, exactly the
// seam PD-1 cut StackDay2Deps along, the same pattern apply/revert.test.ts uses for its HelmBackend
// stub. `apply` and `waitConvergence` are StackBackend's own methods (P61, not merged yet): recording
// stubs stand in, as the design intends this module to be testable before stack.ts exists.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type {
  ControlOptions,
  ConvergenceResult,
  DeployReceipt,
  HelmManifestObject,
  HelmReleaseRecord,
  HelmReleaseStatus,
  HelmUpgradeResult,
  ReleaseMetadata,
  ResolvedHelmRelease,
  StackArtifact,
  StackRef,
  StackRole,
} from '../../../services/orchestrator/interfaces';
import { ApplyEngine } from '../../../services/orchestrator/kubernetes/apply/engine';
import {
  exists,
  remove,
  restart,
  rollbackService,
  scale,
  type StackDay2Deps,
  stop,
} from '../../../services/orchestrator/kubernetes/backends/stack-day2';
import { VolumeRemovalError } from '../../../services/orchestrator/kubernetes/backends/volumes';
import { ANNOTATIONS, K8S_ROLLBACK_SCAN_LIMIT, deleteWaitS } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo } from '../../../services/orchestrator/kubernetes/deps';
import {
  podTemplateLabels,
  SEL_POD,
  SEL_ROLE,
  selectorLabels,
  serviceObjectLabels,
  volumeClaimLabels,
} from '../../../services/orchestrator/kubernetes/labels';
import { namespaceFor } from '../../../services/orchestrator/kubernetes/naming';
import type { DaemonSet, Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type {
  Container,
  PersistentVolume,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PodSpec,
  PodTemplateSpec,
} from '../../../services/orchestrator/kubernetes/resources/core';
import type { ObjectMeta } from '../../../services/orchestrator/kubernetes/resources/meta';
import { namespaceObject } from '../../../services/orchestrator/kubernetes/translate/namespace';
import { artifactDigest, emitManifests } from '../../../services/orchestrator/kubernetes/yaml';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { DeployError, ErrorCode, InterruptedError, UnsupportedOperationError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { FakeKubeExecutor, type KubeStep } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';
import { expectCliError, expectCommandShape } from '../support/matchers';

const PROJECT = 'shop';
const ENV = 'production';
const NS = namespaceFor(PROJECT, ENV);
const APP_REF: StackRef = { project: PROJECT, env: ENV, role: 'app' };
const ACC_REF: StackRef = { project: PROJECT, env: ENV, role: 'accessory' };
const NODE_NAMES = { 'server-1': 'server_1', 'agent-1': 'agent_1' };
const ID = { project: PROJECT, namespace: NS };
const ANNOTATION = ANNOTATIONS.replicasBeforeStop;

// ---------------------------------------------------------------------------
// Manifest builders (translator-shaped, like apply/engine.test.ts and apply/revert.test.ts)
// ---------------------------------------------------------------------------

interface PodOptions {
  image?: string;
  grace?: number;
  claims?: readonly string[];
}

function podSpec(service: string, options: PodOptions = {}): PodSpec {
  const claims = options.claims ?? [];
  const container: Container = { name: service, image: options.image ?? `registry.example.com/shop/${service}:1` };
  if (claims.length > 0) container.volumeMounts = claims.map((name) => ({ name, mountPath: `/data/${name}` }));
  const spec: PodSpec = { containers: [container], terminationGracePeriodSeconds: options.grace ?? 0 };
  if (claims.length > 0) spec.volumes = claims.map((name) => ({ name, persistentVolumeClaim: { claimName: name } }));
  return spec;
}

function podTemplate(service: string, role: StackRole, options: PodOptions = {}): PodTemplateSpec {
  return { metadata: { labels: podTemplateLabels(ID, role, service) }, spec: podSpec(service, options) };
}

function meta(name: string, service: string, role: StackRole): ObjectMeta {
  return { name, namespace: NS, labels: serviceObjectLabels(ID, role, service), annotations: { [ANNOTATIONS.composeService]: service } };
}

function deploymentObj(service: string, role: StackRole, options: PodOptions & { replicas?: number; annotation?: string } = {}): Deployment {
  const object: Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(service, service, role),
    spec: { replicas: options.replicas ?? 1, selector: { matchLabels: selectorLabels(ID, service) }, template: podTemplate(service, role, options) },
  };
  if (options.annotation !== undefined) object.metadata.annotations = { ...object.metadata.annotations, [ANNOTATION]: options.annotation };
  return object;
}

function daemonSetObj(service: string, role: StackRole, options: PodOptions = {}): DaemonSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: meta(service, service, role),
    spec: { selector: { matchLabels: selectorLabels(ID, service) }, template: podTemplate(service, role, options) },
  };
}

function jobObj(name: string, service: string, role: StackRole, options: PodOptions = {}): Job {
  const template = podTemplate(service, role, options);
  template.spec.restartPolicy = 'Never';
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: meta(name, service, role),
    spec: { backoffLimit: 0, completions: 1, parallelism: 1, template },
  };
}

interface ClaimOptions {
  role?: StackRole;
  accessModes?: PersistentVolumeAccessMode[];
  policy?: 'Retain' | 'Delete' | 'Recycle';
  composeVolume?: string;
}

function claimObj(name: string, options: ClaimOptions = {}): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name,
      namespace: NS,
      labels: volumeClaimLabels(ID, options.role ?? 'accessory', name),
      ...(options.composeVolume !== undefined ? { annotations: { [ANNOTATIONS.composeVolume]: options.composeVolume } } : {}),
    },
    spec: {
      accessModes: options.accessModes ?? ['ReadWriteOnce'],
      resources: { requests: { storage: '1Gi' } },
      storageClassName: 'dockflow-local',
      volumeName: `pv-${name}`,
    },
    status: { phase: 'Bound', accessModes: options.accessModes ?? ['ReadWriteOnce'], capacity: { storage: '1Gi' } },
  };
}

function volumeObj(claimName: string, options: { policy?: 'Retain' | 'Delete' | 'Recycle' } = {}): PersistentVolume {
  const name = `pv-${claimName}`;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name },
    spec: {
      accessModes: ['ReadWriteOnce'],
      capacity: { storage: '1Gi' },
      claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: claimName, namespace: NS, uid: `uid-${claimName}` },
      hostPath: { path: `/srv/dockflow-test/volumes/${name}` },
      persistentVolumeReclaimPolicy: options.policy ?? 'Retain',
      storageClassName: 'dockflow-local',
    },
    status: { phase: 'Bound' },
  };
}

/** a Bound claim and its PV, seeded together (mirrors backends/volumes.test.ts's `bound`) */
function bound(name: string, options: ClaimOptions & { policy?: 'Retain' | 'Delete' | 'Recycle' } = {}): KubeObject[] {
  return [toKube(claimObj(name, options)), toKube(volumeObj(name, { policy: options.policy }))];
}

/** the typed resource builders above are read/written through the fake's generic `KubeObject` store */
function toKube(object: object): KubeObject {
  return object as unknown as KubeObject;
}

// ---------------------------------------------------------------------------
// Fake HelmBackend (Pick<HelmBackend, 'listAll' | 'manifestObjects' | 'uninstall' | 'upgradeInstall'>)
// ---------------------------------------------------------------------------

interface FakeHelmRow {
  name: string;
  namespace: string;
  role: StackRole;
  manifest?: HelmManifestObject[];
}

class FakeHelmBackend {
  private rows: FakeHelmRow[] = [];
  readonly uninstallCalls: { namespace: string; name: string; timeoutS: number }[] = [];
  readonly upgradeInstallCalls: { release: ResolvedHelmRelease; historyMax: number; stackId: string }[] = [];

  seed(row: FakeHelmRow): void {
    this.rows.push(row);
  }

  async listAll(stackId: string): Promise<HelmReleaseStatus[]> {
    return this.rows
      .filter((row) => row.namespace === stackId)
      .map((row) => ({ name: row.name, namespace: row.namespace, role: row.role, revision: 1, status: 'deployed', chart: `${row.name}-1.0.0`, appVersion: null, updated: null }));
  }

  async manifestObjects(namespace: string, name: string): Promise<HelmManifestObject[]> {
    return this.rows.find((row) => row.namespace === namespace && row.name === name)?.manifest ?? [];
  }

  async uninstall(namespace: string, name: string, options: { timeoutS: number }): Promise<void> {
    this.uninstallCalls.push({ namespace, name, timeoutS: options.timeoutS });
    this.rows = this.rows.filter((row) => !(row.namespace === namespace && row.name === name));
  }

  async upgradeInstall(release: ResolvedHelmRelease, options: { historyMax: number; stackId: string }): Promise<HelmUpgradeResult> {
    this.upgradeInstallCalls.push({ release, historyMax: options.historyMax, stackId: options.stackId });
    return {
      name: release.name,
      namespace: release.namespace,
      role: release.role,
      revision: 2,
      status: 'deployed',
      chart: release.chart.kind === 'repo' ? release.chart.chart : release.chart.ref,
      appVersion: null,
      updated: null,
      changed: true,
      previousRevision: 1,
      chartSha256: release.declaredDigest ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Fake ReleaseStore (Pick<ReleaseStore, 'current' | 'list' | 'readArtifact' | 'writeAccessoriesDigest'>)
// ---------------------------------------------------------------------------

interface FakeReleaseRow {
  metadata: ReleaseMetadata;
  artifact: StackArtifact;
}

class FakeReleaseStore {
  private rows: FakeReleaseRow[] = [];
  private currentVersion: string | null = null;
  readonly digestCalls: { stackName: string; digest: string | null }[] = [];
  readonly readArtifactCalls: string[] = [];

  seed(row: FakeReleaseRow, options: { current?: boolean } = {}): void {
    this.rows.push(row);
    this.rows.sort((a, b) => b.metadata.epoch - a.metadata.epoch);
    if (options.current) this.currentVersion = row.metadata.version;
  }

  async current(): Promise<ReleaseMetadata | null> {
    if (this.currentVersion === null) return null;
    return this.rows.find((row) => row.metadata.version === this.currentVersion)?.metadata ?? null;
  }

  async list(): Promise<ReleaseMetadata[]> {
    return this.rows.map((row) => row.metadata);
  }

  async readArtifact(stackName: string, version: string): Promise<StackArtifact> {
    this.readArtifactCalls.push(version);
    const row = this.rows.find((r) => r.metadata.version === version);
    if (!row) throw new DeployError(`Release ${version} not found in ${stackName}`, ErrorCode.ROLLBACK_FAILED);
    return row.artifact;
  }

  async writeAccessoriesDigest(stackName: string, digest: string | null): Promise<void> {
    this.digestCalls.push({ stackName, digest });
  }
}

function releaseMeta(version: string, epoch: number): ReleaseMetadata {
  return { project_name: PROJECT, version, env: ENV, timestamp: '2026-01-01T00:00:00Z', epoch, performer: 'alice', branch: 'main' };
}

function artifactOf(objects: Deployment[], helm: HelmReleaseRecord[] = []): StackArtifact {
  const content = emitManifests(objects, { format: 'k8s-manifests/1', stackName: `${PROJECT}-${ENV}`, role: 'app', version: '-' });
  return { format: 'k8s-manifests/1', role: 'app', content, helm, diagnostics: [], digest: artifactDigest(content, helm) };
}

function helmRecordFor(name: string, overrides: Partial<HelmReleaseRecord> = {}): HelmReleaseRecord {
  const values = overrides.values ?? {};
  return {
    name,
    role: 'app',
    namespace: NS,
    chart: { kind: 'repo', repo: 'https://charts.example.org', chart: name },
    version: '1.0.0',
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: 300,
    chartSha256: 'a'.repeat(64),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ApplyCall {
  ref: StackRef;
  version: string;
  artifact: StackArtifact;
  options: { prune: boolean; services: string[] | null };
}

interface WaitCall {
  receipt: DeployReceipt;
  options: { timeoutS: number; intervalS: number };
}

interface Harness {
  clock: FakeClock;
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  redactor: Redactor;
  engine: ApplyEngine;
  helm: FakeHelmBackend;
  releases: FakeReleaseStore;
  applyCalls: ApplyCall[];
  waitCalls: WaitCall[];
  state: { crdsRoutes: boolean; applyResult: { success: true; data: DeployReceipt } | { success: false; error: DeployError }; waitResult: ConvergenceResult };
  deps: StackDay2Deps;
}

let current: Harness | null = null;

function fakeReceipt(version: string): DeployReceipt {
  return {
    ref: APP_REF,
    version,
    startedAt: new Date(),
    services: null,
    skipped: false,
    artifactDigest: `sha256:${'0'.repeat(64)}`,
    changes: [],
    helm: [],
    helmChanges: [],
    helmDeclared: [],
    previousVersion: null,
  };
}

function harness(options: { script?: KubeStep[]; seedNamespace?: boolean; checked?: boolean } = {}): Harness {
  const redactor = new Redactor([]);
  const clock = new FakeClock();
  const cluster = new FakeCluster({ clock });
  const kube = new FakeKubeExecutor({ redactor, cluster, clock, script: options.script ?? [] });
  if (options.seedNamespace ?? true) cluster.seed(toKube(namespaceObject(APP_REF)));
  const engine = new ApplyEngine({ kubectl: kube, clock, distribution: kube.distribution, memo: createSharedMemo() });
  const helm = new FakeHelmBackend();
  const releases = new FakeReleaseStore();
  const applyCalls: ApplyCall[] = [];
  const waitCalls: WaitCall[] = [];
  const state: Harness['state'] = {
    crdsRoutes: true,
    applyResult: { success: true, data: fakeReceipt('0.0.0') },
    waitResult: { status: 'converged', failures: [] },
  };
  const deps: StackDay2Deps = {
    kubectl: kube,
    clock,
    redactor,
    distribution: kube.distribution,
    nodeNames: NODE_NAMES,
    engine,
    helm,
    releases,
    crds: async () => ({ routes: state.crdsRoutes }),
    apply: async (ref, version, artifact, applyOptions) => {
      applyCalls.push({ ref, version, artifact, options: applyOptions });
      return state.applyResult;
    },
    waitConvergence: async (receipt, waitOptions) => {
      waitCalls.push({ receipt, options: waitOptions });
      return state.waitResult;
    },
    helmHistoryMax: 5,
    helmAuth: () => null,
  };
  const h: Harness = { clock, cluster, kube, redactor, engine, helm, releases, applyCalls, waitCalls, state, deps };
  if (options.checked ?? true) current = h;
  return h;
}

afterEach(() => {
  const h = current;
  current = null;
  if (!h) return;
  h.kube.assertDone();
  assertExecutorInvariants({ kube: h.kube, redactor: h.redactor, allow: { volumeDeletion: true } });
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

function applyLive(kube: FakeKubeExecutor, ...objects: object[]): Promise<void> {
  return kube.apply(objects.map((object) => JSON.stringify(object)).join('\n---\n'), { dryRun: false, namespace: NS });
}

/** Runs `promise` to completion on fake time, one second at a time (the inventory poll cadence). */
async function drive<T>(clock: FakeClock, promise: Promise<T>, limitMs = 300_000): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await clock.advance(0);
  for (let elapsed = 0; !settled; elapsed += 1000) {
    if (elapsed >= limitMs) throw new Error(`did not settle within ${limitMs} ms of fake time`);
    await clock.advance(1000);
  }
  return promise;
}

function mark(h: Harness): number {
  return h.kube.calls.length;
}

function callsSince(h: Harness, from: number): readonly string[][] {
  return h.kube.calls.slice(from).map((call) => call.call.args);
}

// ---------------------------------------------------------------------------
// removeVolumesByProtocol wiring (S2, S2b-e): call-order helpers over the real protocol
// (backends/volumes.ts, P44); PD-15 implements it once, this file only checks stack-day2's wiring.
// ---------------------------------------------------------------------------

const TO_DELETE = JSON.stringify({ spec: { persistentVolumeReclaimPolicy: 'Delete' } });
const RESTORE_RETAIN = JSON.stringify({ metadata: { annotations: { [ANNOTATIONS.reclaimPolicyBefore]: null } }, spec: { persistentVolumeReclaimPolicy: 'Retain' } });

function pvSteps(calls: readonly string[][]): string[] {
  const steps: string[] = [];
  for (const args of calls) {
    const [verb, target, ...rest] = args;
    if (verb === 'delete' && target?.startsWith('persistentvolumeclaims/')) steps.push(`claim ${target.slice('persistentvolumeclaims/'.length)}`);
    else if (verb === 'patch' && rest.includes(TO_DELETE)) steps.push(`Delete ${target.slice('persistentvolumes/'.length)}`);
    else if (verb === 'wait' && rest[0]?.startsWith('persistentvolumes/')) steps.push(`gone ${rest[0].slice('persistentvolumes/'.length)}`);
  }
  return steps;
}

function reclaimPolicyOf(h: Harness, pv: string): string | undefined {
  const object = h.cluster.get('PersistentVolume', pv);
  return (object?.spec as { persistentVolumeReclaimPolicy?: string } | undefined)?.persistentVolumeReclaimPolicy;
}

// ---------------------------------------------------------------------------
// exists (design-03 18.1)
// ---------------------------------------------------------------------------

describe('exists', () => {
  it('is false for a missing namespace, with no mutating call', async () => {
    const h = harness({ seedNamespace: false });
    const from = mark(h);
    expect(await exists(h.deps, APP_REF)).toBe(false);
    expect(h.kube.calls.slice(from).some((c) => c.call.mutating)).toBe(false);
  });

  it('is false for an owned namespace with nothing deployed', async () => {
    const h = harness();
    expect(await exists(h.deps, APP_REF)).toBe(false);
  });

  it('is true when the role has a live workload', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('web', 'app'));
    expect(await exists(h.deps, APP_REF)).toBe(true);
  });

  it('is true when only a Helm release of the role exists (no compose workload)', async () => {
    const h = harness();
    h.helm.seed({ name: 'metrics', namespace: NS, role: 'app' });
    expect(await exists(h.deps, APP_REF)).toBe(true);
    expect(await exists(h.deps, ACC_REF)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remove (design-03 18.2, 18.3; S1-S5, S2b-e, S15)
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('S1: stop app (retain) deletes routes, then workloads, then Services; no volume calls', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('web', 'app'));
    const from = mark(h);

    await drive(h.clock, remove(h.deps, APP_REF, { volumes: 'retain' }));

    const calls = callsSince(h, from);
    const roleSel = SEL_ROLE(NS, 'app');
    const podSel = SEL_POD(NS, 'app');
    const waitS = deleteWaitS([{ graceSeconds: 0 }]);
    const iRoutes = calls.findIndex((a) => a[0] === 'delete' && a[1] === 'ingressroutes.traefik.io,middlewares.traefik.io');
    const iWorkloads = calls.findIndex((a) => a[0] === 'delete' && a[1] === 'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch');
    const iWaitPods = calls.findIndex((a) => a[0] === 'wait');
    const iServices = calls.findIndex((a) => a[0] === 'delete' && a[1] === 'services,secrets,configmaps');
    expect(iRoutes).toBeGreaterThanOrEqual(0);
    expect(iRoutes).toBeLessThan(iWorkloads);
    expect(iWorkloads).toBeLessThan(iWaitPods);
    expect(iWaitPods).toBeLessThan(iServices);

    expectCommandShape(calls[iRoutes], ['delete', 'ingressroutes.traefik.io,middlewares.traefik.io', '-l', roleSel, '--ignore-not-found', '--wait=false']);
    expectCommandShape(calls[iWorkloads], [
      'delete',
      'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch',
      '-l',
      roleSel,
      '--ignore-not-found',
      '--cascade=foreground',
      '--wait=true',
      `--timeout=${waitS}s`,
    ]);
    expectCommandShape(calls[iWaitPods], ['wait', '--for=delete', 'pods', '-l', podSel, `--timeout=${waitS}s`]);
    expectCommandShape(calls[iServices], ['delete', 'services,secrets,configmaps', '-l', roleSel, '--ignore-not-found', '--wait=false']);

    expect(calls.some((a) => a[1]?.includes('persistentvolumeclaims') || a[1]?.startsWith('persistentvolumes'))).toBe(false);
    expect(h.releases.digestCalls).toEqual([]);
  });

  it('S2: accessories remove --volumes deletes claims one at a time, never two Delete patches before a gone-wait', async () => {
    const h = harness();
    h.cluster.seed([...bound('redis-data'), ...bound('pg-data')]);
    const from = mark(h);
    // the fake ReleaseStore has no kubectl call of its own; record the kube call count at the
    // moment it fires so the digest write can be placed among the calls below
    let kubeCallsWhenDigestWritten = -1;
    const originalWrite = h.releases.writeAccessoriesDigest.bind(h.releases);
    h.releases.writeAccessoriesDigest = async (stackName, digest) => {
      kubeCallsWhenDigestWritten = h.kube.calls.length;
      return originalWrite(stackName, digest);
    };

    await drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete' }));

    const calls = callsSince(h, from);
    const steps = pvSteps(calls);
    const first = steps[0]?.split(' ')[1];
    expect(first).toBeDefined();
    const second = first === 'redis-data' ? 'pg-data' : 'redis-data';
    expect(steps).toEqual([`claim ${first}`, `Delete pv-${first}`, `gone pv-${first}`, `claim ${second}`, `Delete pv-${second}`, `gone pv-${second}`]);
    expect(h.cluster.get('PersistentVolumeClaim', 'redis-data', NS)).toBeUndefined();
    expect(h.cluster.get('PersistentVolumeClaim', 'pg-data', NS)).toBeUndefined();
    expect(h.cluster.get('PersistentVolume', 'pv-redis-data')).toBeUndefined();
    expect(h.cluster.get('PersistentVolume', 'pv-pg-data')).toBeUndefined();
    // accessories change detection cleared once the workloads are gone, before any volume is touched
    expect(h.releases.digestCalls).toEqual([{ stackName: NS, digest: null }]);
    const beforeDigest = h.kube.calls.slice(0, kubeCallsWhenDigestWritten).map((c) => c.call.args);
    expect(beforeDigest.some((a) => a[0] === 'delete' && a[1] === 'services,secrets,configmaps')).toBe(true);
    expect(pvSteps(beforeDigest)).toEqual([]);
  });

  it('S2-int: Ctrl+C before the volumes keeps every one of them and still clears the digest', async () => {
    const h = harness();
    h.cluster.seed([...bound('pg-data')]);
    const interrupt = new AbortController();
    interrupt.abort();
    const from = mark(h);

    await expectCliError(drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete', signal: interrupt.signal })), {
      type: InterruptedError,
      message: 'Removal interrupted before any volume was deleted',
    });
    expect(pvSteps(callsSince(h, from))).toEqual([]);
    expect(h.cluster.get('PersistentVolumeClaim', 'pg-data', NS)).toBeDefined();
    expect(h.releases.digestCalls).toEqual([{ stackName: NS, digest: null }]);
  });

  it('S2-int2: Ctrl+C during a volume finishes it, keeps the next one with its policy restored, and says which', async () => {
    const h = harness();
    h.cluster.seed([...bound('redis-data'), ...bound('pg-data')]);
    const interrupt = new AbortController();
    const originalRun = h.kube.run.bind(h.kube);
    h.kube.run = async (call) => {
      if (call.args[0] === 'wait' && call.args[2]?.startsWith('persistentvolumes/')) interrupt.abort();
      return originalRun(call);
    };
    const from = mark(h);

    const error = await expectCliError(drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete', signal: interrupt.signal })), {
      type: VolumeRemovalError,
      message: /^Volume deletion interrupted before (redis-data|pg-data)$/,
    });
    const steps = pvSteps(callsSince(h, from));
    const first = steps[0]?.split(' ')[1] ?? '';
    const second = first === 'redis-data' ? 'pg-data' : 'redis-data';
    expect(steps).toEqual([`claim ${first}`, `Delete pv-${first}`, `gone pv-${first}`]);
    expect(error.code).toBe(ErrorCode.INTERRUPTED);
    expect(error.suggestion?.split('\n').at(-1)).toBe(`Deleted ${first}; kept ${second}. Run the command again to delete the rest.`);
    expect(h.cluster.get('PersistentVolume', `pv-${first}`)).toBeUndefined();
    expect(h.cluster.get('PersistentVolumeClaim', second, NS)).toBeDefined();
    expect(reclaimPolicyOf(h, `pv-${second}`)).toBe('Retain');
    const pv = h.cluster.get('PersistentVolume', `pv-${second}`);
    expect((pv?.metadata as ObjectMeta | undefined)?.annotations?.[ANNOTATIONS.reclaimPolicyBefore]).toBeUndefined();
  });

  it('S2b: a failing claim delete leaves the PV untouched and names the volume', async () => {
    const h = harness({
      script: [{ id: 'k40-fails', method: 'delete', args: ['delete', 'persistentvolumeclaims/pg-data', '--ignore-not-found', '--wait=true', '--timeout=120s'], respond: { error: 'Forbidden' } }],
    });
    h.cluster.seed([...bound('pg-data')]);

    const error = await expectCliError(drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete' })), {
      type: VolumeRemovalError,
      message: /^Volume pg-data was not deleted: its claim could not be deleted/,
    });
    expect(error.report.deleted).toEqual([]);
    // the record step (before any claim delete) writes the P/reclaim-policy-before annotation only;
    // no K39 (spec.persistentVolumeReclaimPolicy) patch in either direction, because the claim delete
    // itself never got a chance to succeed
    expect(h.kube.calls.some((c) => c.call.args[0] === 'patch' && c.call.args[1] === 'persistentvolumes/pv-pg-data' && c.call.args.includes(TO_DELETE))).toBe(false);
    expect(reclaimPolicyOf(h, 'pv-pg-data')).toBe('Retain');
  });

  it('S2c: the PV not going Released after the patch restores the recorded policy in the finally', async () => {
    const h = harness({
      script: [{ id: 'k41-fails', method: 'run', args: ['wait', '--for=delete', 'persistentvolumes/pv-pg-data', '--timeout=120s'], respond: { exitCode: 1, stdout: '', stderr: '' } }],
    });
    h.cluster.seed([...bound('pg-data')]);
    const from = mark(h);

    const error = await expectCliError(drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete' })), {
      type: VolumeRemovalError,
      message: 'The data of volume pg-data was not removed within 120s',
    });
    expect(error.report.restored).toEqual(['pv-pg-data']);

    const calls = callsSince(h, from);
    const restoreArgs = ['patch', 'persistentvolumes/pv-pg-data', '--type=merge', '-p', RESTORE_RETAIN];
    expect(calls.some((a) => a.join(' ') === restoreArgs.join(' '))).toBe(true);
    expect(reclaimPolicyOf(h, 'pv-pg-data')).toBe('Retain');
  });

  it('S2d: the restore patch itself failing is reported by volume name', async () => {
    const restoreArgs = ['patch', 'persistentvolumes/pv-pg-data', '--type=merge', '-p', RESTORE_RETAIN];
    // checked: false (mirrors backends/volumes.test.ts): the whole point of this scenario is a PV
    // deliberately left at reclaim Delete, which INV-04b would otherwise flag as unaccounted for.
    const h = harness({
      checked: false,
      script: [
        { id: 'k41-fails', method: 'run', args: ['wait', '--for=delete', 'persistentvolumes/pv-pg-data', '--timeout=120s'], respond: { exitCode: 1, stdout: '', stderr: '' } },
        { id: 'restore-fails', method: 'run', args: restoreArgs, respond: { error: 'Forbidden' } },
      ],
    });
    h.cluster.seed([...bound('pg-data')]);

    const error = await expectCliError(drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete' })), { type: VolumeRemovalError });
    expect(error.report.restored).toEqual([]);
    expect(error.report.restoreFailed).toHaveLength(1);
    expect(error.report.restoreFailed[0].volume).toBe('pv-pg-data');
  });

  it('S2e: a PV already Delete needs only the claim gone; no reclaim patch in either direction', async () => {
    const h = harness();
    h.cluster.seed([...bound('pg-data', { policy: 'Delete' })]);
    const from = mark(h);

    await drive(h.clock, remove(h.deps, ACC_REF, { volumes: 'delete' }));

    const calls = callsSince(h, from);
    expect(calls.some((a) => a[0] === 'patch' && a[1] === 'persistentvolumes/pv-pg-data')).toBe(false);
    expect(h.cluster.get('PersistentVolumeClaim', 'pg-data', NS)).toBeUndefined();
    expect(h.cluster.get('PersistentVolume', 'pv-pg-data')).toBeUndefined();
  });

  it('S3: pods still terminating after the wait times out fails with the count and a diagnose hint', async () => {
    const stalePods = { apiVersion: 'v1', kind: 'List', items: [{ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-1', namespace: NS }, spec: { containers: [] } }, { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-2', namespace: NS }, spec: { containers: [] } }] };
    const h = harness({
      script: [
        { id: 'wait-fails', method: 'run', args: ['wait', '--for=delete', 'pods', '-l', SEL_POD(NS, 'app'), '--timeout=120s'], respond: { exitCode: 1, stdout: '', stderr: '' } },
        { id: 'count', method: 'getJson', args: ['get', 'pods', '-l', SEL_POD(NS, 'app'), '-o', 'json'], respond: { json: stalePods } },
      ],
    });

    await expectCliError(drive(h.clock, remove(h.deps, APP_REF, { volumes: 'retain' })), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Stopping namespace dockflow-shop-production timed out after 120s: 2 pod(s) still terminating',
      suggestion: 'Run `dockflow diagnose production`.',
    });
  });

  it('S4: a Helm release owning a PVC is kept and warned about; other steps still run', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('web', 'app'));
    h.helm.seed({ name: 'metrics', namespace: NS, role: 'app', manifest: [{ kind: 'PersistentVolumeClaim', name: 'metrics-data', namespace: NS, keep: false, claimTemplates: [] }] });
    const from = mark(h);

    await drive(h.clock, remove(h.deps, APP_REF, { volumes: 'retain' }));

    expect(h.helm.uninstallCalls).toEqual([]);
    expect(warnings).toEqual(['Helm release metrics owns volumes (metrics-data) and keeps running; remove it with: dockflow helm uninstall production metrics --volumes']);
    const calls = callsSince(h, from);
    expect(calls.some((a) => a[0] === 'delete' && a[1] === 'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch')).toBe(true);
  });

  it('S5: a missing namespace returns without any mutating call', async () => {
    const h = harness({ seedNamespace: false });
    const from = mark(h);

    await drive(h.clock, remove(h.deps, APP_REF, { volumes: 'delete' }));

    const calls = h.kube.calls.slice(from);
    expect(calls.every((c) => !c.call.mutating)).toBe(true);
  });

  it('S15: a long grace period scales delete/wait timeouts and the local guard (K41(b))', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('db', 'app', { grace: 300 }));
    const from = mark(h);

    await drive(h.clock, remove(h.deps, APP_REF, { volumes: 'retain' }));

    const waitS = deleteWaitS([{ graceSeconds: 300 }]);
    const recorded = h.kube.calls.slice(from);
    const workloadDelete = recorded.find((c) => c.call.args[0] === 'delete' && c.call.args[1] === 'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch');
    const waitPods = recorded.find((c) => c.call.args[0] === 'wait');
    expect(waitS).toBe(330);
    expect(workloadDelete?.call.args.at(-1)).toBe(`--timeout=${waitS}s`);
    expect(workloadDelete?.call.guardS).toBe(waitS + 30);
    expect(waitPods?.call.args.at(-1)).toBe(`--timeout=${waitS}s`);
    expect(waitPods?.call.guardS).toBe(waitS + 30);
  });
});

// ---------------------------------------------------------------------------
// stop (design-03 18.4; S6)
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('S6: accessories stop patches one merge per target and leaves an already-stopped target alone', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('worker', 'accessory', { replicas: 2 }));
    await h.clock.advance(2000);
    const from = mark(h);

    const wait = drive(h.clock, stop(h.deps, ACC_REF, null, { wait: true, timeoutS: 60 }));
    await wait;

    const patches = h.kube.calls.slice(from).filter((c) => c.call.args[0] === 'patch');
    expect(patches).toHaveLength(1);
    expectCommandShape(patches[0], [
      'patch',
      'deployments.apps/worker',
      '--type=merge',
      '-p',
      JSON.stringify({ metadata: { annotations: { [ANNOTATION]: '2' } }, spec: { replicas: 0 } }),
    ]);
    expect(h.kube.calls.slice(from).some((c) => c.call.args[0] === 'scale')).toBe(false);

    // already at 0: no further call
    const from2 = mark(h);
    await stop(h.deps, ACC_REF, ['worker'], { wait: false, timeoutS: 60 });
    expect(h.kube.calls.slice(from2).some((c) => c.call.args[0] === 'patch')).toBe(false);
  });

  it('a DaemonSet of a Helm release is warned about, never patched and never waited for', async () => {
    const h = harness();
    const agent: DaemonSet = {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'logs-agent', namespace: NS, labels: { 'app.kubernetes.io/managed-by': 'Helm' } },
      spec: {
        selector: { matchLabels: { app: 'logs-agent' } },
        template: { metadata: { labels: { app: 'logs-agent' } }, spec: { containers: [{ name: 'agent', image: 'busybox:1.37' }] } },
      },
    };
    await applyLive(h.kube, agent);
    h.helm.seed({ name: 'logs', namespace: NS, role: 'app', manifest: [{ kind: 'DaemonSet', name: 'logs-agent', namespace: NS, keep: false, claimTemplates: [] }] });
    const from = mark(h);

    await stop(h.deps, APP_REF, null, { wait: true, timeoutS: 60 });

    expect(h.kube.calls.slice(from).some((c) => c.call.args[0] === 'patch')).toBe(false);
    expect(warnings).toEqual(['Helm release logs runs DaemonSet logs-agent on every node, which was not stopped']);
  });
});

// ---------------------------------------------------------------------------
// scale (design-03 18.5; S16)
// ---------------------------------------------------------------------------

describe('scale', () => {
  it('S16: scaling a stopped service resumes with one merge patch, never scale + a separate unannotate', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('web', 'app', { replicas: 0, annotation: '3' }));
    const from = mark(h);

    await scale(h.deps, APP_REF, 'web', 2, { wait: false, timeoutS: 60 });

    const calls = h.kube.calls.slice(from);
    const patches = calls.filter((c) => c.call.args[0] === 'patch');
    expect(patches).toHaveLength(1);
    expectCommandShape(patches[0], ['patch', 'deployments.apps/web', '--type=merge', '-p', JSON.stringify({ metadata: { annotations: { [ANNOTATION]: null } }, spec: { replicas: 2 } })]);
    expect(calls.some((c) => c.call.args[0] === 'scale')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restart (design-03 18.6; S7, S7b, S7c)
// ---------------------------------------------------------------------------

describe('restart', () => {
  it('S7: restarting a stopped accessory resumes it instead of rolling out', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('worker', 'accessory', { replicas: 0, annotation: '2' }));
    const from = mark(h);

    await restart(h.deps, ACC_REF, 'worker', { wait: false, timeoutS: 60 });

    const calls = h.kube.calls.slice(from);
    const patches = calls.filter((c) => c.call.args[0] === 'patch');
    expect(patches).toHaveLength(1);
    expectCommandShape(patches[0], ['patch', 'deployments.apps/worker', '--type=merge', '-p', JSON.stringify({ metadata: { annotations: { [ANNOTATION]: null } }, spec: { replicas: 2 } })]);
    expect(calls.some((c) => c.call.args[0] === 'rollout')).toBe(false);
  });

  it('S7b: restarting a service scaled to 0 without an annotation resumes to 1 and the wait converges (?? 0)', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('web', 'app', { replicas: 0 }));
    const from = mark(h);

    await drive(h.clock, restart(h.deps, APP_REF, 'web', { wait: true, timeoutS: 60 }));

    const calls = h.kube.calls.slice(from);
    const patch = calls.find((c) => c.call.args[0] === 'patch');
    expect(patch).toBeDefined();
    if (patch) expectCommandShape(patch, ['patch', 'deployments.apps/web', '--type=merge', '-p', JSON.stringify({ metadata: { annotations: { [ANNOTATION]: null } }, spec: { replicas: 1 } })]);
    expect(calls.some((c) => c.call.args[0] === 'rollout')).toBe(false);
  });

  it('S7c: restarting the whole role issues one rollout restart naming every target (K65, no field manager)', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('web', 'app'), deploymentObj('api', 'app'));
    const from = mark(h);

    await restart(h.deps, APP_REF, null, { wait: false, timeoutS: 60 });

    const rollouts = h.kube.calls.slice(from).filter((c) => c.call.args[0] === 'rollout');
    expect(rollouts).toHaveLength(1);
    expect(rollouts[0].call.args[1]).toBe('restart');
    expect(new Set(rollouts[0].call.args.slice(2))).toEqual(new Set(['deployments.apps/web', 'deployments.apps/api']));
    expect(rollouts[0].call.args.some((a) => a.includes('field-manager'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rollbackService (design-03 17; S8-S14, U-BE-STACK-20)
// ---------------------------------------------------------------------------

describe('rollbackService', () => {
  const OPTS: ControlOptions = { wait: true, timeoutS: 300 };

  it('S8: finds the newest older release whose closure differs and applies it (U-BE-STACK-20)', async () => {
    const h = harness();
    h.releases.seed({ metadata: releaseMeta('1.4.2', 3), artifact: artifactOf([deploymentObj('web', 'app', { image: 'registry.example.com/shop/web:2' })]) }, { current: true });
    h.releases.seed({ metadata: releaseMeta('1.4.1', 2), artifact: artifactOf([deploymentObj('web', 'app', { image: 'registry.example.com/shop/web:2' })]) });
    h.releases.seed({ metadata: releaseMeta('1.4.0', 1), artifact: artifactOf([deploymentObj('web', 'app', { image: 'registry.example.com/shop/web:1' })]) });

    const result = await rollbackService(h.deps, APP_REF, 'web', OPTS);

    expect(result).toEqual({ toVersion: '1.4.0' });
    expect(h.applyCalls).toHaveLength(1);
    expect(h.applyCalls[0].ref).toEqual(APP_REF);
    expect(h.applyCalls[0].version).toBe('1.4.0');
    expect(h.applyCalls[0].options).toEqual({ prune: false, services: ['web'] });
    expect(h.waitCalls).toHaveLength(1);
    expect(infos).toEqual(['Service web rolled back to its definition in release 1.4.0']);
  });

  it('S9: an older release missing the service is skipped, the search continues, no rollout undo (K20)', async () => {
    const h = harness();
    h.releases.seed({ metadata: releaseMeta('1.4.2', 3), artifact: artifactOf([deploymentObj('web', 'app', { image: 'registry.example.com/shop/web:2' })]) }, { current: true });
    h.releases.seed({ metadata: releaseMeta('1.4.1', 2), artifact: artifactOf([deploymentObj('other', 'app')]) });
    h.releases.seed({ metadata: releaseMeta('1.4.0', 1), artifact: artifactOf([deploymentObj('web', 'app', { image: 'registry.example.com/shop/web:1' })]) });

    const result = await rollbackService(h.deps, APP_REF, 'web', { wait: false, timeoutS: 300 });

    expect(result).toEqual({ toVersion: '1.4.0' });
    expect(h.releases.readArtifactCalls).toEqual(['1.4.2', '1.4.1', '1.4.0']);
    expect(h.kube.calls.some((c) => c.call.args[0] === 'rollout' && c.call.args[1] === 'undo')).toBe(false);
  });

  it('S10: nothing differs raises R-11 with no apply and no rollout undo', async () => {
    const h = harness();
    const image = 'registry.example.com/shop/web:1';
    h.releases.seed({ metadata: releaseMeta('1.4.2', 3), artifact: artifactOf([deploymentObj('web', 'app', { image })]) }, { current: true });
    h.releases.seed({ metadata: releaseMeta('1.4.1', 2), artifact: artifactOf([deploymentObj('web', 'app', { image })]) });
    h.releases.seed({ metadata: releaseMeta('1.4.0', 1), artifact: artifactOf([deploymentObj('web', 'app', { image })]) });

    await expectCliError(rollbackService(h.deps, APP_REF, 'web', { wait: false, timeoutS: 300 }), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Service web has the same definition in every stored release; there is nothing to roll back to',
      suggestion: 'Restore a whole release with `dockflow rollback production`.',
    });
    expect(h.applyCalls).toEqual([]);
    expect(h.kube.calls.some((c) => c.call.args[0] === 'rollout')).toBe(false);
  });

  it('S11: the scan reads at most K8S_ROLLBACK_SCAN_LIMIT older releases, then R-11', async () => {
    const h = harness();
    const image = 'registry.example.com/shop/web:1';
    h.releases.seed({ metadata: releaseMeta('v13', 13), artifact: artifactOf([deploymentObj('web', 'app', { image })]) }, { current: true });
    for (let epoch = 12; epoch >= 1; epoch--) {
      h.releases.seed({ metadata: releaseMeta(`v${epoch}`, epoch), artifact: artifactOf([deploymentObj('web', 'app', { image })]) });
    }

    await expectCliError(rollbackService(h.deps, APP_REF, 'web', { wait: false, timeoutS: 300 }), { type: DeployError, code: ErrorCode.ROLLBACK_FAILED });
    // the current release is read once up front, then at most K8S_ROLLBACK_SCAN_LIMIT older ones
    expect(h.releases.readArtifactCalls).toHaveLength(K8S_ROLLBACK_SCAN_LIMIT + 1);
  });

  it('S12: no release recorded raises ROLLBACK_FAILED, not STACK_NOT_FOUND', async () => {
    const h = harness();
    await expectCliError(rollbackService(h.deps, APP_REF, 'web', { wait: false, timeoutS: 300 }), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'No release is recorded for shop-production',
      suggestion: 'Deploy first with `dockflow deploy production`.',
    });
    expect(h.releases.readArtifactCalls).toEqual([]);
  });

  it('S13: an accessory ref is refused before any read (R-12)', async () => {
    const h = harness();
    const from = mark(h);
    // R-12: a CLIError(SERVICE_NOT_FOUND), never UnsupportedOperationError (the command's own guard
    // raises R-12 for real traffic; this is the backend's defensive repeat of it).
    await expectCliError(rollbackService(h.deps, ACC_REF, 'worker', { wait: false, timeoutS: 300 }), {
      code: ErrorCode.SERVICE_NOT_FOUND,
      message: 'Service worker is an accessory; accessories have no release history',
      suggestion: 'Change accessories.yml and run `dockflow deploy production --accessories`.',
    });
    expect(h.kube.calls.slice(from)).toEqual([]);
  });

  it('S14: rolling back a Helm release re-installs the older stored record, chart bytes re-verified', async () => {
    const h = harness();
    h.releases.seed(
      { metadata: releaseMeta('1.4.2', 3), artifact: artifactOf([], [helmRecordFor('metrics', { version: '3.0.0' })]) },
      { current: true },
    );
    h.releases.seed({ metadata: releaseMeta('1.4.1', 2), artifact: artifactOf([], [helmRecordFor('metrics', { version: '3.0.0' })]) });
    h.releases.seed({ metadata: releaseMeta('1.4.0', 1), artifact: artifactOf([], [helmRecordFor('metrics', { version: '2.0.0' })]) });

    const result = await rollbackService(h.deps, APP_REF, 'metrics', { wait: true, timeoutS: 300 });

    expect(result).toEqual({ toVersion: '1.4.0' });
    expect(h.helm.upgradeInstallCalls).toHaveLength(1);
    expect(h.helm.upgradeInstallCalls[0].release.version).toBe('2.0.0');
    expect(h.helm.upgradeInstallCalls[0].release.declaredDigest).toBe('a'.repeat(64));
    expect(h.helm.upgradeInstallCalls[0].historyMax).toBe(5);
    expect(h.helm.upgradeInstallCalls[0].stackId).toBe(NS);
    expect(h.applyCalls).toEqual([]);
    expect(h.waitCalls).toEqual([]);
    expect(infos).toEqual(['Helm release metrics rolled back to its definition in release 1.4.0']);
  });
});

// ---------------------------------------------------------------------------
// Refusal catalogue (design-06 5): the classes this backend itself detects (U-BE-STACK-25)
// ---------------------------------------------------------------------------

describe('refusal catalogue (U-BE-STACK-25 classes this backend detects)', () => {
  it('R-06: scaling a global service', async () => {
    const h = harness();
    await applyLive(h.kube, daemonSetObj('agent', 'app'));
    await expectCliError(scale(h.deps, APP_REF, 'agent', 2, { wait: false, timeoutS: 60 }), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: 'Service agent runs in global mode (one instance per node) and cannot be scaled',
      suggestion: 'Change `deploy.mode` in docker-compose.yml, or use placement constraints to choose its nodes.',
    });
  });

  it('R-07: scaling a job', async () => {
    const h = harness();
    await applyLive(h.kube, jobObj('migrate', 'migrate', 'app'));
    await expectCliError(scale(h.deps, APP_REF, 'migrate', 2, { wait: false, timeoutS: 60 }), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: 'Service migrate runs as a job and cannot be scaled',
      suggestion: 'Run it again with `dockflow deploy production`.',
    });
  });

  it('R-08: scaling above 1 with a shared ReadWriteOnce claim (S17)', async () => {
    const h = harness();
    await applyLive(h.kube, deploymentObj('db', 'app', { claims: ['pgdata'] }));
    h.cluster.seed(toKube(claimObj('pgdata', { role: 'app', composeVolume: 'pgdata' })));
    const from = mark(h);

    await expectCliError(scale(h.deps, APP_REF, 'db', 2, { wait: false, timeoutS: 60 }), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: 'Service db mounts volume pgdata (ReadWriteOnce) and cannot run more than 1 replica',
      suggestion: 'Give each replica its own volume with `x-dockflow: {kind: statefulset}` and `volumes.<key>.x-dockflow.per_replica: true`.',
    });
    expect(h.kube.calls.slice(from).some((c) => c.call.mutating)).toBe(false);
  });

  it('R-10: restarting a job by name', async () => {
    const h = harness();
    await applyLive(h.kube, jobObj('migrate', 'migrate', 'app'));
    await expectCliError(restart(h.deps, APP_REF, 'migrate', { wait: false, timeoutS: 60 }), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: 'Service migrate runs as a Kubernetes Job and cannot be restarted',
      suggestion: 'Change its definition and run `dockflow deploy production` to run it again.',
    });
  });

  it('R-13: stopping a named global service (app role wording)', async () => {
    const h = harness();
    await applyLive(h.kube, daemonSetObj('agent', 'app'));
    await expectCliError(stop(h.deps, APP_REF, ['agent'], { wait: false, timeoutS: 60 }), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: 'Service agent runs in global mode and cannot be stopped',
      suggestion: 'Remove it with `dockflow stop production`, or change `deploy.mode`.',
    });
  });

  it('R-13: stopping a named global accessory (accessory role wording)', async () => {
    const h = harness();
    await applyLive(h.kube, daemonSetObj('agent', 'accessory'));
    await expectCliError(stop(h.deps, ACC_REF, ['agent'], { wait: false, timeoutS: 60 }), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: 'Accessory agent runs in global mode and cannot be stopped',
      suggestion: 'Remove the accessories with `dockflow accessories remove production`, or change `deploy.mode`.',
    });
  });

  it('R-13: a global accessory swept up by "all" is warned about and skipped, not refused', async () => {
    const h = harness();
    await applyLive(h.kube, daemonSetObj('agent', 'accessory'));
    await stop(h.deps, ACC_REF, null, { wait: false, timeoutS: 60 });
    expect(warnings).toEqual(['Accessory agent runs in global mode and was not stopped']);
  });
});
