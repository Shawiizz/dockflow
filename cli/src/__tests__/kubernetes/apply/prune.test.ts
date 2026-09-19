// Prune execution (design-03 8.4, DESIGN-CORE C11, C12; design-07 9.4 U-PRUNE-* execution rows):
// the ordered deletes design-03 8.1's F* rows describe, in cluster mode over FakeCluster.

import { afterEach, describe, expect, it } from 'bun:test';
import type { StackRef } from '../../../services/orchestrator/interfaces';
import { ApplyEngine } from '../../../services/orchestrator/kubernetes/apply/engine';
import { prune, pruneKinds } from '../../../services/orchestrator/kubernetes/apply/prune';
import { ANNOTATIONS } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo } from '../../../services/orchestrator/kubernetes/deps';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { hashedObjectLabels, podTemplateLabels, selectorLabels, serviceObjectLabels, volumeClaimLabels } from '../../../services/orchestrator/kubernetes/labels';
import type { Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type { Container, PersistentVolumeClaim, PodTemplateSpec, Secret, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ObjectMeta } from '../../../services/orchestrator/kubernetes/resources/meta';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import type { IngressRoute } from '../../../services/orchestrator/kubernetes/resources/traefik';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { FakeKubeExecutor, type RecordedKubeCall } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const NS = 'dockflow-shop-production';
const ID = { project: 'shop', namespace: NS };
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };

// ---------------------------------------------------------------------------
// Objects, shaped like the translator's output
// ---------------------------------------------------------------------------

function podTemplate(service: string): PodTemplateSpec {
  const container: Container = { name: service, image: `registry.example.com/shop/${service}:1` };
  return { metadata: { labels: podTemplateLabels(ID, 'app', service) }, spec: { containers: [container], terminationGracePeriodSeconds: 0 } };
}

function meta(name: string, service: string, extra: Partial<ObjectMeta> = {}): ObjectMeta {
  return { name, namespace: NS, labels: serviceObjectLabels(ID, 'app', service), annotations: { [ANNOTATIONS.composeService]: service }, ...extra };
}

function deployment(service: string, extra: Partial<ObjectMeta> = {}): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(service, service, extra),
    spec: { replicas: 1, selector: { matchLabels: selectorLabels(ID, service) }, template: podTemplate(service) },
  };
}

function statefulSet(service: string, claimTemplateNames: string[] = []): StatefulSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta(service, service),
    spec: {
      replicas: 1,
      serviceName: `${service}-hl`,
      selector: { matchLabels: selectorLabels(ID, service) },
      template: podTemplate(service),
      ...(claimTemplateNames.length > 0
        ? {
            volumeClaimTemplates: claimTemplateNames.map((name) => ({
              metadata: { name, labels: volumeClaimLabels(ID, 'app', name) },
              spec: { accessModes: ['ReadWriteOnce' as const], resources: { requests: { storage: '1Gi' } } },
            })),
          }
        : {}),
    },
  };
}

function service(name: string, owner: string): Service {
  return { apiVersion: 'v1', kind: 'Service', metadata: meta(name, owner), spec: { selector: selectorLabels(ID, owner), ports: [{ port: 80, protocol: 'TCP' }] } };
}

function job(name: string, svc: string, options: { active?: number } = {}): Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: meta(name, svc),
    spec: { backoffLimit: 0, completions: 1, parallelism: 1, template: { ...podTemplate(svc), spec: { ...podTemplate(svc).spec, restartPolicy: 'Never' } } },
    status: { active: options.active ?? 0 },
  };
}

function ingressRoute(name: string, owner: string): IngressRoute {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: meta(name, owner),
    spec: { routes: [{ kind: 'Rule', match: `Host(\`${owner}.example.com\`)`, services: [{ name: owner, port: 80 }] }] },
  };
}

function pvc(name: string, options: { volumeLabel?: string } = {}): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: NS, labels: volumeClaimLabels(ID, 'app', options.volumeLabel ?? name) },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
  };
}

function envSecret(name: string, owner: string): Secret {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { ...meta(name, owner), labels: hashedObjectLabels(ID, 'app', owner) }, immutable: true, data: { KEY: 'dmFsdWU=' } };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  clock: FakeClock;
  engine: ApplyEngine;
  infos: string[];
  warnings: string[];
  redactor: Redactor;
}

let current: Harness | null = null;

function harness(): Harness {
  const redactor = new Redactor([]);
  const cluster = new FakeCluster();
  cluster.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } });
  const kube = new FakeKubeExecutor({ redactor, cluster });
  const clock = new FakeClock();
  const engine = new ApplyEngine({ kubectl: kube, clock, distribution: k3sDistribution, memo: createSharedMemo() });
  const infos: string[] = [];
  const warnings: string[] = [];
  current = { cluster, kube, clock, engine, infos, warnings, redactor };
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

function seed(h: Harness, ...objects: (ManifestObject | Job)[]): void {
  h.cluster.seed(objects as unknown as KubeObject[]);
}

function run(h: Harness, rendered: ManifestObject[], routes = true) {
  return prune(
    { kubectl: h.kube, engine: h.engine, notices: { info: (m) => h.infos.push(m), warn: (m) => h.warnings.push(m) } },
    { ref: REF, namespace: NS, rendered, routes },
  );
}

function callId(record: RecordedKubeCall): string {
  const args = record.call.args;
  const [verb, first] = args;
  if (verb === 'delete') {
    if (args.some((a) => a.startsWith('ingressroutes.') || a.startsWith('middlewares.'))) return 'K18';
    if (args.some((a) => a.startsWith('services/'))) return 'K20-svc';
    if (args.some((a) => a.startsWith('secrets/') || a.startsWith('configmaps/'))) return 'K20-hashed';
    return 'K19';
  }
  if (verb === 'get' && first === 'secrets,configmaps') return 'K15';
  if (verb === 'get' && first === 'persistentvolumeclaims') return 'K09';
  if (verb === 'get' && first === 'pods,deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch,replicasets.apps,controllerrevisions.apps') return 'K16';
  return args.join(' ');
}

function live(h: Harness, resource: string, name: string) {
  return h.cluster.get(resource, name, NS);
}

// ---------------------------------------------------------------------------

describe('prune', () => {
  it('deletes a removed service in rank order and reports it (F1)', async () => {
    const h = harness();
    seed(h, deployment('worker'), service('worker', 'worker'), ingressRoute('worker-route', 'worker'));
    const outcome = await run(h, []);
    expect(outcome.deleted.map((r) => `${r.kind}/${r.name}`).sort()).toEqual(['Deployment/worker', 'IngressRoute/worker-route', 'Service/worker']);
    expect(live(h, 'ingressroutes.traefik.io', 'worker-route')).toBeUndefined();
    expect(live(h, 'deployments.apps', 'worker')).toBeUndefined();
    expect(live(h, 'services', 'worker')).toBeUndefined();
    const workloadDelete = h.kube.calls.find((c) => c.call.args[0] === 'delete' && c.call.args.some((a) => a.startsWith('deployments.apps/')));
    expect(workloadDelete?.call.args).toEqual([
      'delete',
      'deployments.apps/worker',
      '--ignore-not-found',
      '--cascade=foreground',
      '--wait=true',
      '--timeout=120s',
    ]);
    expect(h.infos).toEqual(['Pruned 3 object(s) no longer in docker-compose.yml: ingressroute/worker-route, deployment/worker, service/worker']);
    expect(h.warnings).toEqual([]);
  });

  it('deletes routes before workloads before Services (rank order, F1)', async () => {
    const h = harness();
    seed(h, deployment('worker'), service('worker', 'worker'), ingressRoute('worker-route', 'worker'));
    const calls0 = h.kube.calls.length;
    await run(h, []);
    const ids = h.kube.calls.slice(calls0).filter((c) => c.call.mutating).map(callId);
    expect(ids).toEqual(['K18', 'K19', 'K20-svc']);
  });

  it('keeps a hashed object referenced by a retained ReplicaSet and deletes the unreferenced one (F2)', async () => {
    const h = harness();
    seed(h, envSecret('web-env-old', 'web'), envSecret('web-env-older', 'web'));
    const rs = {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: { name: 'web-rs-old', namespace: NS, ownerReferences: [], labels: { 'dockflow.shawiizz.dev/service': 'web' } },
      spec: {
        selector: { matchLabels: selectorLabels(ID, 'web') },
        template: { metadata: {}, spec: { containers: [{ name: 'web', image: 'x', envFrom: [{ secretRef: { name: 'web-env-old' } }] }] } },
      },
    };
    h.cluster.seed(rs as unknown as KubeObject);
    await run(h, []);
    expect(live(h, 'secrets', 'web-env-old')).toBeDefined();
    expect(live(h, 'secrets', 'web-env-older')).toBeUndefined();
  });

  it('warns about an orphan PVC and never deletes it (F3)', async () => {
    const h = harness();
    seed(h, pvc('uploads', { volumeLabel: 'uploads' }));
    const outcome = await run(h, []);
    expect(outcome.orphanPvcs).toEqual([{ name: 'uploads', volume: 'uploads' }]);
    expect(h.warnings).toEqual([
      'Volume data kept: persistentvolumeclaim/uploads is no longer used by docker-compose.yml; delete it (and its data) with: dockflow volumes rm production uploads',
    ]);
    expect(live(h, 'persistentvolumeclaims', 'uploads')).toBeDefined();
    for (const call of h.kube.calls) expect(call.call.args.some((a) => a.includes('persistentvolumeclaims/'))).toBe(false);
  });

  it('never orphans the per-replica claims of a live StatefulSet (K40, F13)', async () => {
    const h = harness();
    seed(h, statefulSet('queue', ['queue-data']), pvc('queue-data-queue-0', { volumeLabel: 'queue-data' }), pvc('queue-data-queue-1', { volumeLabel: 'queue-data' }), pvc('uploads', { volumeLabel: 'uploads' }));
    const outcome = await run(h, [statefulSet('queue', ['queue-data'])]);
    expect(outcome.orphanPvcs).toEqual([{ name: 'uploads', volume: 'uploads' }]);
    expect(h.warnings).toHaveLength(1);
  });

  it('never removes an active Job, and warns it is still running (F1 keptJobs)', async () => {
    const h = harness();
    seed(h, job('migrate-3f9a1c2e', 'migrate', { active: 1 }));
    const outcome = await run(h, []);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.keptJobs.map((j) => j.name)).toEqual(['migrate-3f9a1c2e']);
    expect(h.warnings).toEqual(['Job migrate (job/migrate-3f9a1c2e) is still running and was not removed; it is no longer in docker-compose.yml']);
    expect(live(h, 'jobs.batch', 'migrate-3f9a1c2e')).toBeDefined();
  });

  it('never lists the traefik kinds when the CRDs are absent (F9)', async () => {
    const h = harness();
    seed(h, deployment('worker'));
    const calls0 = h.kube.calls.length;
    await run(h, [], false);
    const k17 = h.kube.calls.slice(calls0).find((c) => c.call.args[0] === 'get' && c.call.args[1] !== 'secrets,configmaps' && !c.call.args[1]?.includes('pods,'));
    expect(k17?.call.args[1]).toBe(pruneKinds(false).join(','));
    expect(k17?.call.args[1]).not.toContain('traefik');
  });

  it('derives the delete wait from the live grace period (K41(b), F11)', async () => {
    const h = harness();
    const slow: Deployment = { ...deployment('worker'), spec: { ...deployment('worker').spec, template: { ...podTemplate('worker'), spec: { ...podTemplate('worker').spec, terminationGracePeriodSeconds: 300 } } } };
    seed(h, slow);
    await run(h, []);
    const workloadDelete = h.kube.calls.find((c) => c.call.args[0] === 'delete' && c.call.args.some((a) => a.startsWith('deployments.apps/')));
    expect(workloadDelete?.call.args).toContain('--timeout=330s');
  });

  it('never throws when the prune read is forbidden, and still runs the hashed-object GC (F4)', async () => {
    const h = harness();
    seed(h, deployment('worker'), envSecret('web-env-older', 'web'));
    h.cluster.rejectOn({ verb: 'get', kind: 'PersistentVolumeClaim' }, 'Forbidden');
    const outcome = await run(h, []);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toStartWith('Cleanup after deploy failed (prune): ');
    expect(h.warnings[0]).toEndWith('; the deploy itself succeeded');
    // the prune step's own PVC read failed, but the hashed step still ran and deleted the unreferenced secret
    expect(outcome.deleted).toEqual([]);
    expect(outcome.deletedHashed).toEqual([{ kind: 'Secret', name: 'web-env-older' }]);
    expect(live(h, 'deployments.apps', 'worker')).toBeDefined();
  });

  it('reports nothing when the live set already matches the render', async () => {
    const h = harness();
    seed(h, deployment('web'));
    const outcome = await run(h, [deployment('web')]);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.deletedHashed).toEqual([]);
    expect(h.infos).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(live(h, 'deployments.apps', 'web')).toBeDefined();
  });
});
