// Automatic revert execution (design-03 11.3, 11.4, DESIGN-CORE DV2; design-07 9.4 U-REVERT-*
// execution rows): the R* rows of design-03 22.4, in cluster mode over FakeCluster. Live state is
// built through the real ApplyEngine (as engine.test.ts does), so revision history, generations and
// pod readiness are exactly what a real deploy would leave.

import { afterEach, describe, expect, it } from 'bun:test';
import type { DeployReceipt, HelmBackend, ResolvedHelmRelease, StackRef } from '../../../services/orchestrator/interfaces';
import { ApplyEngine, type ApplyOutcome, type ApplyRequest } from '../../../services/orchestrator/kubernetes/apply/engine';
import { type Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import { revert } from '../../../services/orchestrator/kubernetes/apply/revert';
import { stateFor } from '../../../services/orchestrator/kubernetes/backends/stack-state';
import type { StackWaitDeps } from '../../../services/orchestrator/kubernetes/backends/stack-wait';
import { ANNOTATIONS, K8S_DELETE_WAIT_S, K8S_REVERT_TIMEOUT_S } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo } from '../../../services/orchestrator/kubernetes/deps';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { podTemplateLabels, selectorLabels, serviceObjectLabels, volumeClaimLabels } from '../../../services/orchestrator/kubernetes/labels';
import type { Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Container, PersistentVolumeClaim, PodTemplateSpec } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ObjectMeta } from '../../../services/orchestrator/kubernetes/resources/meta';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster } from '../fakes/fake-cluster';
import { FakeKubeExecutor } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const NS = 'dockflow-shop-production';
const ID = { project: 'shop', namespace: NS };
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const DIGEST = `sha256:${'0'.repeat(64)}`;
const NODE_NAMES = { 'server-1': 'server_1', 'agent-1': 'agent_1' };

// ---------------------------------------------------------------------------
// Objects, shaped like the translator's output
// ---------------------------------------------------------------------------

interface PodOptions {
  image?: string;
  grace?: number;
  claims?: readonly string[];
}

function podTemplate(service: string, options: PodOptions = {}, templates: readonly string[] = []): PodTemplateSpec {
  const mounts = [...(options.claims ?? []), ...templates];
  const container: Container = { name: service, image: options.image ?? `registry.example.com/shop/${service}:1` };
  if (mounts.length > 0) container.volumeMounts = mounts.map((name) => ({ name, mountPath: `/data/${name}` }));
  const spec: PodTemplateSpec['spec'] = { containers: [container], terminationGracePeriodSeconds: options.grace ?? 0 };
  if ((options.claims ?? []).length > 0) spec.volumes = (options.claims ?? []).map((claim) => ({ name: claim, persistentVolumeClaim: { claimName: claim } }));
  return { metadata: { labels: podTemplateLabels(ID, 'app', service) }, spec };
}

function meta(name: string, service: string): ObjectMeta {
  return { name, namespace: NS, labels: serviceObjectLabels(ID, 'app', service), annotations: { [ANNOTATIONS.composeService]: service } };
}

function deployment(service: string, options: PodOptions & { replicas?: number } = {}): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(service, service),
    spec: { replicas: options.replicas ?? 1, selector: { matchLabels: selectorLabels(ID, service) }, template: podTemplate(service, options) },
  };
}

function statefulSet(service: string, options: PodOptions & { claimTemplates?: string[] } = {}): StatefulSet {
  const templates = options.claimTemplates ?? [];
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta(service, service),
    spec: {
      replicas: 1,
      serviceName: `${service}-hl`,
      selector: { matchLabels: selectorLabels(ID, service) },
      template: podTemplate(service, options, templates),
      ...(templates.length > 0
        ? {
            volumeClaimTemplates: templates.map((name) => ({
              metadata: { name, labels: volumeClaimLabels(ID, 'app', name) },
              spec: { accessModes: ['ReadWriteOnce' as const], resources: { requests: { storage: '1Gi' } } },
            })),
          }
        : {}),
    },
  };
}

function pvc(name: string): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: NS, labels: volumeClaimLabels(ID, 'app', name) },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
  };
}

// ---------------------------------------------------------------------------
// A stub HelmBackend recording only what revert.ts calls
// ---------------------------------------------------------------------------

function fakeHelm(): { calls: ResolvedHelmRelease[]; helm: Pick<HelmBackend, 'upgradeInstall'> } {
  const calls: ResolvedHelmRelease[] = [];
  const helm: Pick<HelmBackend, 'upgradeInstall'> = {
    async upgradeInstall(release) {
      calls.push(release);
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
    },
  };
  return { calls, helm };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  clock: FakeClock;
  engine: ApplyEngine;
  redactor: Redactor;
  helm: ReturnType<typeof fakeHelm>;
}

let current: Harness | null = null;

function harness(): Harness {
  const redactor = new Redactor([]);
  const clock = new FakeClock();
  const cluster = new FakeCluster({ clock });
  const kube = new FakeKubeExecutor({ redactor, cluster, clock });
  const engine = new ApplyEngine({ kubectl: kube, clock, distribution: k3sDistribution, memo: createSharedMemo() });
  current = { cluster, kube, clock, engine, redactor, helm: fakeHelm() };
  return current;
}

afterEach(() => {
  const h = current;
  current = null;
  if (!h) return;
  h.kube.assertDone();
  assertExecutorInvariants({ kube: h.kube, redactor: h.redactor });
  h.cluster.assertNoProblems();
});

function request(objects: ManifestObject[], overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return { ref: REF, version: '1', objects, mode: 'deploy', full: true, ...overrides };
}

async function deploy(h: Harness, objects: ManifestObject[]): Promise<ApplyOutcome> {
  return h.engine.execute(await h.engine.prepare(request(objects)));
}

function waitDeps(h: Harness): StackWaitDeps {
  return { kubectl: h.kube, clock: h.clock, redactor: h.redactor, distribution: h.kube.distribution, nodeNames: NODE_NAMES };
}

function deps(h: Harness) {
  return { kubectl: h.kube, engine: h.engine, helm: h.helm.helm, redactor: h.redactor, wait: waitDeps(h) };
}

function receipt(overrides: Partial<DeployReceipt> = {}): DeployReceipt {
  return {
    ref: REF,
    version: '1.4.2',
    startedAt: new Date(),
    services: null,
    skipped: false,
    artifactDigest: DIGEST,
    changes: [],
    helm: [],
    helmChanges: [],
    helmDeclared: [],
    previousVersion: '1.4.1',
    ...overrides,
  };
}

/** Runs `promise` to completion on fake time, one second at a time (waitConvergence polls the clock). */
async function drive<T>(clock: FakeClock, promise: Promise<T>, limitMs = 900_000): Promise<T> {
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

function live(h: Harness, resource: string, name: string) {
  return h.cluster.get(resource, name, NS);
}

function emptySnapshot(h: Harness): Snapshot {
  return { takenAt: h.clock.now(), workloads: [], services: [] };
}

// ---------------------------------------------------------------------------

describe('revert', () => {
  it('leaves workloads in place on a first deploy and reports nothing-to-revert (R2, D15)', async () => {
    const h = harness();
    const v1 = [deployment('web')];
    const outcome = await deploy(h, v1);
    await h.clock.advance(3000);
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: outcome.applied,
      now: outcome.after.takenAt,
      before: emptySnapshot(h),
      after: outcome.after,
      previous: null,
    });
    const mark = h.kube.calls.length;
    const result = await revert(deps(h), { receipt: receipt({ version: '1.0.0', previousVersion: null, changes: outcome.changes }), state, helmHistoryMax: 5 });
    expect(result).toEqual({
      status: 'nothing-to-revert',
      services: [],
      message: 'nothing to roll back to (first deployment of this stack); workloads were left in place for debugging',
    });
    expect(h.kube.calls.slice(mark).some((c) => c.call.mutating)).toBe(false);
    expect(live(h, 'deployments.apps', 'web')).toBeDefined();
  });

  it('returns an internal error for a receipt this bundle did not produce, with zero calls (R8)', async () => {
    const h = harness();
    const mark = h.kube.calls.length;
    const result = await revert(deps(h), { receipt: receipt(), state: undefined, helmHistoryMax: 5 });
    expect(result).toEqual({ status: 'failed', services: [], message: 'internal error: receipt was not produced by this backend' });
    expect(h.kube.calls.slice(mark)).toEqual([]);
  });

  it('honours failure_action pause and reports nothing-to-revert without touching the cluster (R5, DV-S2-1)', async () => {
    const h = harness();
    const v1 = [deployment('web')];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2Outcome = await deploy(h, [deployment('web', { image: 'registry.example.com/shop/web:2' })]);
    await h.clock.advance(3000);
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
      failureActions: { web: 'pause' },
    });
    const mark = h.kube.calls.length;
    const result = await revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 });
    expect(result).toEqual({ status: 'nothing-to-revert', services: [], message: 'web was not reverted because its update_config.failure_action is pause' });
    expect(h.kube.calls.slice(mark).some((c) => c.call.mutating)).toBe(false);
  });

  it('restores the changed service and removes the one the failed version added (R1, worked example 11.3)', async () => {
    const h = harness();
    const v1 = [deployment('web')];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2 = [deployment('web', { image: 'registry.example.com/shop/web:2' }), deployment('worker')];
    const v2Outcome = await deploy(h, v2);
    await h.clock.advance(3000);
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v2,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
    });
    const result = await drive(h.clock, revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 }));
    expect(result.status).toBe('reverted');
    expect(result.services.sort()).toEqual(['web', 'worker']);
    expect(result.message).toBe('reverted web to 1.4.1; removed worker (new in 1.4.2)');
    const restoredWeb = live(h, 'deployments.apps', 'web');
    expect((restoredWeb?.spec as { template: { spec: { containers: { image: string }[] } } }).template.spec.containers[0].image).toBe(
      'registry.example.com/shop/web:1',
    );
    expect(live(h, 'deployments.apps', 'worker')).toBeUndefined();
  });

  it('rolls an accessory back with `rollout undo` when no artifact is stored (R3)', async () => {
    const h = harness();
    const v1 = [deployment('redis')];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2Outcome = await deploy(h, [deployment('redis', { image: 'registry.example.com/shop/redis:2' })]);
    await h.clock.advance(3000);
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: null,
    });
    const result = await drive(h.clock, revert(deps(h), { receipt: receipt({ previousVersion: null, changes: v2Outcome.changes }), state, helmHistoryMax: 5 }));
    expect(result.status).toBe('reverted');
    expect(result.services).toEqual(['redis']);
    const restored = live(h, 'deployments.apps', 'redis');
    expect((restored?.spec as { template: { spec: { containers: { image: string }[] } } }).template.spec.containers[0].image).toBe(
      'registry.example.com/shop/redis:1',
    );
  });

  it('cleans up only the StatefulSet pod stuck on the failed revision (R4, K17 forced rollback)', async () => {
    const h = harness();
    const v1 = [pvc('data'), statefulSet('db', { claims: ['data'] })];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2 = [pvc('data'), statefulSet('db', { claims: ['data'], image: 'registry.example.com/shop/db:2' })];
    const v2Outcome = await deploy(h, v2);
    // one tick: the new pod is created (CrashLoopBackOff simulated by never-ready) but the old one is untouched
    h.cluster.behave('registry.example.com/shop/db:2', { kind: 'never-ready' });
    await h.clock.advance(2000);
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
    });
    const result = await drive(h.clock, revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 }));
    expect(result.status).toBe('reverted');
    const pods = h.cluster.list('pods', { namespace: NS });
    expect(pods.map((p) => p.metadata.name).sort()).toEqual(['db-0']);
  });

  it('never throws when the restore apply is rejected (R6)', async () => {
    const h = harness();
    const v1 = [deployment('web')];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2Outcome = await deploy(h, [deployment('web', { image: 'registry.example.com/shop/web:2' })]);
    await h.clock.advance(3000);
    h.cluster.rejectOn({ verb: 'apply', kind: 'Deployment', name: 'web' }, 'Conflict', undefined, { dryRun: false });
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
    });
    const result = await revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 });
    expect(result.status).toBe('failed');
    expect(result.services).toEqual([]);
    expect(result.message).toBeDefined();
  });

  it('reports failed, never throwing, when the reverted workload does not converge (R7)', async () => {
    const h = harness();
    const v1 = [deployment('web')];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2Outcome = await deploy(h, [deployment('web', { image: 'registry.example.com/shop/web:2' })]);
    await h.clock.advance(3000);
    h.cluster.behave('registry.example.com/shop/web:1', { kind: 'crashloop', exitCode: 1 });
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
    });
    const result = await drive(h.clock, revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 }));
    expect(result.status).toBe('failed');
    expect(result.message).toBeDefined();
  });

  it('derives the revert wait from the live grace period: 300s grace -> 360s budget, converging at +250s is reverted (R9, K41(c))', async () => {
    const h = harness();
    const v1 = [deployment('db', { grace: 300 })];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2Outcome = await deploy(h, [deployment('db', { grace: 300, image: 'registry.example.com/shop/db:2' })]);
    await h.clock.advance(3000);
    // the restored pod takes 250s to become ready, well inside the derived 360s budget but past the 180s floor
    h.cluster.behave('registry.example.com/shop/db:1', { kind: 'ready', afterTicks: 250 });
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
    });
    const result = await drive(h.clock, revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 }), 400_000);
    expect(result.status).toBe('reverted');
    expect(Math.max(K8S_REVERT_TIMEOUT_S, 300 + 60)).toBe(360);
    expect(K8S_DELETE_WAIT_S).toBeLessThan(360);
  });

  it('deletes the live workload of the switched kind before re-applying the previous one (R10, K15)', async () => {
    const h = harness();
    const v1 = [pvc('pgdata'), deployment('db', { claims: ['pgdata'] })];
    await deploy(h, v1);
    await h.clock.advance(3000);
    const v2 = [pvc('pgdata'), statefulSet('db', { claims: ['pgdata'] })];
    const v2Outcome = await deploy(h, v2);
    await h.clock.advance(3000);
    expect(v2Outcome.disruptive.map((d) => d.service)).toEqual(['db']);
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: v1,
      applied: v2Outcome.applied,
      now: v2Outcome.after.takenAt,
      before: v2Outcome.before,
      after: v2Outcome.after,
      previous: { version: '1.4.1', objects: v1, helm: [] },
      disruptive: v2Outcome.disruptive,
    });
    const mark = h.kube.calls.length;
    const result = await drive(h.clock, revert(deps(h), { receipt: receipt({ changes: v2Outcome.changes }), state, helmHistoryMax: 5 }));
    expect(result.status).toBe('reverted');
    const calls = h.kube.calls.slice(mark).filter((c) => c.call.mutating);
    const deleteIndex = calls.findIndex((c) => c.call.args[0] === 'delete' && c.call.args[1] === 'statefulsets.apps/db');
    const applyIndex = calls.findIndex((c) => c.call.args[0] === 'apply' && !c.call.args.includes('--dry-run=server'));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(applyIndex).toBeGreaterThan(deleteIndex);
    expect(live(h, 'statefulsets.apps', 'db')).toBeUndefined();
    expect(live(h, 'deployments.apps', 'db')).toBeDefined();
  });

  it('re-installs only the Helm releases the failed deploy replaced, on a partial receipt (R11, K18)', async () => {
    const h = harness();
    const previousRecord = {
      name: 'metrics',
      role: 'app' as const,
      namespace: NS,
      chart: { kind: 'repo' as const, repo: 'https://charts.example.com', chart: 'metrics' },
      version: '1.0.0',
      values: {},
      valuesSha256: 'a'.repeat(64),
      timeoutS: 300,
      chartSha256: 'b'.repeat(64),
    };
    const failedRecord = { ...previousRecord, version: '2.0.0', valuesSha256: 'c'.repeat(64), chartSha256: 'd'.repeat(64) };
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects: [],
      applied: [],
      now: h.clock.now(),
      previous: null,
      targets: null,
      helmApplied: [{ release: failedRecord, replaced: previousRecord }],
      helmInputs: [{ ...failedRecord, auth: null, declaredDigest: failedRecord.chartSha256 }],
    });
    expect(state.previous).toBeNull();
    expect(state.targets).toBeNull();
    const mark = h.kube.calls.length;
    const result = await revert(deps(h), { receipt: receipt({ changes: [] }), state, helmHistoryMax: 5 });
    expect(result.status).toBe('reverted');
    expect(h.helm.calls.map((c) => c.version)).toEqual(['1.0.0']);
    expect(h.helm.calls[0].declaredDigest).toBe(previousRecord.chartSha256);
    expect(h.kube.calls.slice(mark).some((c) => c.call.mutating)).toBe(false);
  });
});
