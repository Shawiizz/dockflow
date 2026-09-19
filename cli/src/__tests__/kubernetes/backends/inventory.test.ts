// design-06 2.2 and 10.2 (`backends/inventory.test.ts`): one namespace read per command without
// ReplicaSets or ControllerRevisions (m6), the revisions read only on demand and memoised, Helm
// workloads from Helm's ownership metadata, one extra read per other Helm namespace, the memo
// dropped only by invalidate, and the metrics memo.

import { afterEach, describe, expect, it } from 'bun:test';
import type { HelmBackend, HelmReleaseStatus, StackRole } from '../../../services/orchestrator/interfaces';
import {
  createInventoryReader,
  INVENTORY_RESOURCES,
  podMetricsPath,
  REVISION_RESOURCES,
} from '../../../services/orchestrator/kubernetes/backends/inventory';
import { HELM_MANAGED_BY, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { Redactor } from '../../../utils/redact';
import { FakeKubeExecutor, type KubeStep } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const SHARED = 'shared-charts';

type Obj = Record<string, unknown>;

const created: FakeKubeExecutor[] = [];

function fake(script: KubeStep[], order: 'strict' | 'any' = 'strict'): FakeKubeExecutor {
  const kube = new FakeKubeExecutor({ redactor: new Redactor([]), script, order });
  created.push(kube);
  return kube;
}

afterEach(() => {
  const kubes = created.splice(0);
  for (const kube of kubes) if (!kube.asserted) kube.assertDone();
  assertExecutorInvariants({ kube: kubes });
});

function list(items: Obj[]): { json: Obj } {
  return { json: { apiVersion: 'v1', kind: 'List', items } };
}

function inventoryStep(items: Obj[], namespace = NS, times: number = 1): KubeStep {
  return { id: `inventory ${namespace}`, method: 'getJson', namespace, args: ['get', INVENTORY_RESOURCES.join(','), '-o', 'json'], respond: list(items), times };
}

function revisionStep(items: Obj[], selector: string | null, namespace = NS): KubeStep {
  return {
    id: `revisions ${namespace} ${selector ?? 'all'}`,
    method: 'getJson',
    namespace,
    args: ['get', REVISION_RESOURCES.join(','), ...(selector === null ? [] : ['-l', selector]), '-o', 'json'],
    respond: list(items),
  };
}

function composeDeployment(service: string, role: StackRole): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: service,
      namespace: NS,
      uid: `uid-${service}`,
      labels: {
        'app.kubernetes.io/managed-by': 'dockflow',
        [`${P}/stack`]: NS,
        [`${P}/role`]: role,
        [`${P}/service`]: service,
        [`${P}/part`]: 'stack',
      },
      annotations: { [`${P}/compose-service`]: service },
    },
    spec: { replicas: 1, selector: {}, template: { metadata: {}, spec: { containers: [{ name: service, image: `registry.example.com/shop/${service}:1.4.2` }] } } },
  };
}

function helmWorkload(kind: string, name: string, release: string, namespace = NS, managedBy: string = HELM_MANAGED_BY): Obj {
  return {
    apiVersion: kind === 'Job' ? 'batch/v1' : 'apps/v1',
    kind,
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': managedBy, 'app.kubernetes.io/instance': release },
      annotations: { [KUBE_KEYS.helmReleaseName]: release, [KUBE_KEYS.helmReleaseNamespace]: namespace },
    },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name, image: `registry.example.com/charts/${name}:2.4.1` }] } } },
  };
}

function pod(name: string, owner: string): Obj {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: NS,
      labels: { [`${P}/stack`]: NS, [`${P}/role`]: 'app', [`${P}/service`]: 'web', 'pod-template-hash': '6d4b9c7f8' },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: owner, uid: `uid-${owner}`, controller: true }],
    },
    spec: { containers: [{ name: 'web', image: 'registry.example.com/shop/web:1.4.2' }], nodeName: 'worker-1' },
    status: { phase: 'Running' },
  };
}

function release(name: string, role: StackRole | null, namespace = NS): HelmReleaseStatus {
  return { name, namespace, role, revision: 1, status: 'deployed', chart: `${name}-2.4.1`, appVersion: '2.4.1', updated: null };
}

function helmStub(releases: HelmReleaseStatus[]): Pick<HelmBackend, 'listAll'> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listAll: async (stackId: string) => {
      calls.push(stackId);
      return releases;
    },
  };
}

const WEB_ITEMS: Obj[] = [composeDeployment('web', 'app'), pod('web-6d4b9c7f8-x2x4q', 'web-6d4b9c7f8'), composeDeployment('db', 'accessory')];

describe('namespace read', () => {
  it('reads the namespace once per command, without ReplicaSets or ControllerRevisions', async () => {
    const kube = fake([inventoryStep(WEB_ITEMS)]);
    const reader = createInventoryReader({ kubectl: kube, helm: null });
    const first = await reader.read(NS);
    const second = await reader.read(NS);
    expect(second).toBe(first);
    const reads = kube.calls.filter((call) => call.method === 'getJson');
    expect(reads).toHaveLength(1);
    expect(reads[0].call.args[1]).toBe('deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch,pods,services,persistentvolumeclaims');
    expect(reads[0].call.args[1]).not.toMatch(/replicasets|controllerrevisions/);
    expect(first.stackId).toBe(NS);
    expect(first.namespaces).toEqual([first.primary]);
    expect([...first.primary.composeWorkloads.keys()].sort()).toEqual(['db', 'web']);
    expect(first.primary.pods.map((p) => p.metadata.name)).toEqual(['web-6d4b9c7f8-x2x4q']);
  });

  it('a missing namespace is an empty inventory', async () => {
    const kube = fake([inventoryStep([])]);
    const stack = await createInventoryReader({ kubectl: kube, helm: helmStub([]) }).read(NS);
    expect(stack.primary.workloads).toEqual([]);
    expect(stack.primary.helm).toEqual([]);
    expect(await stack.primary.revisions('app')).toEqual({ replicaSets: [], controllerRevisions: [] });
    expect(kube.calls).toHaveLength(1);
  });

  it('a failed read is not memoised', async () => {
    const kube = fake([
      { ...inventoryStep(WEB_ITEMS), id: 'lost', respond: { transportError: true } },
      inventoryStep(WEB_ITEMS),
    ]);
    const reader = createInventoryReader({ kubectl: kube, helm: null });
    await expect(reader.read(NS)).rejects.toBeInstanceOf(KubeError);
    expect((await reader.read(NS)).primary.pods).toHaveLength(1);
  });

  it('a mutating method drops the memo so the next read goes to the cluster; reads alone never do', async () => {
    const kube = fake([inventoryStep(WEB_ITEMS, NS, 3)]);
    const reader = createInventoryReader({ kubectl: kube, helm: null });
    const first = await reader.read(NS);
    await reader.read(NS);
    expect(kube.calls).toHaveLength(1);
    reader.invalidate(NS);
    const second = await reader.read(NS);
    expect(second).not.toBe(first);
    expect(kube.calls).toHaveLength(2);
    reader.invalidate();
    await reader.read(NS);
    expect(kube.calls).toHaveLength(3);
  });
});

describe('revisions', () => {
  const replicaSet = {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: { name: 'web-6d4b9c7f8', namespace: NS, labels: { 'pod-template-hash': '6d4b9c7f8' } },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [] } } },
  };
  const controllerRevision = { apiVersion: 'apps/v1', kind: 'ControllerRevision', metadata: { name: 'db-5f7d', namespace: NS }, revision: 2 };

  it('are read on first use only, scoped to the role pods, and memoised', async () => {
    const kube = fake([inventoryStep(WEB_ITEMS), revisionStep([replicaSet, controllerRevision], `${P}/stack=${NS},${P}/role=app`)]);
    const stack = await createInventoryReader({ kubectl: kube, helm: null }).read(NS);
    // a command that never shows `current` stops here: no revisions read
    expect(kube.calls).toHaveLength(1);
    const revisions = await stack.primary.revisions('app');
    expect(revisions.replicaSets.map((r) => r.metadata.name)).toEqual(['web-6d4b9c7f8']);
    expect(revisions.controllerRevisions.map((r) => r.metadata.name)).toEqual(['db-5f7d']);
    expect(await stack.primary.revisions('app')).toBe(revisions);
    expect(kube.calls).toHaveLength(2);
  });

  it('read the whole namespace once for null, for a role with Helm releases, and serve every role from it', async () => {
    const items = [...WEB_ITEMS, helmWorkload('Deployment', 'search-api', 'search')];
    const kube = fake([inventoryStep(items), revisionStep([replicaSet], null)]);
    const stack = await createInventoryReader({ kubectl: kube, helm: helmStub([release('search', 'app')]) }).read(NS);
    const app = await stack.primary.revisions('app');
    expect(await stack.primary.revisions(null)).toBe(app);
    expect(await stack.primary.revisions('accessory')).toBe(app);
    expect(kube.calls).toHaveLength(2);
  });

  it('a read of a role without releases uses the role selector', async () => {
    const items = [...WEB_ITEMS, helmWorkload('Deployment', 'search-api', 'search')];
    const kube = fake([inventoryStep(items), revisionStep([], `${P}/stack=${NS},${P}/role=accessory`)]);
    const stack = await createInventoryReader({ kubectl: kube, helm: helmStub([release('search', 'app')]) }).read(NS);
    expect(await stack.primary.revisions('accessory')).toEqual({ replicaSets: [], controllerRevisions: [] });
  });
});

describe('Helm workloads', () => {
  it('are the namespace workloads carrying Helm ownership metadata; no release manifest is fetched', async () => {
    const items = [
      ...WEB_ITEMS,
      helmWorkload('Deployment', 'search-api', 'search'),
      helmWorkload('StatefulSet', 'search-db', 'search'),
      helmWorkload('DaemonSet', 'cache-agent', 'cache'),
      helmWorkload('Job', 'search-migrate', 'search'),
      helmWorkload('Deployment', 'lookalike', 'search', NS, 'dockflow'),
    ];
    const kube = fake([inventoryStep(items)]);
    const helm = helmStub([release('search', 'app'), release('cache', 'accessory'), release('idle', 'app'), release('unlabelled', null)]);
    const stack = await createInventoryReader({ kubectl: kube, helm }).read(NS);
    expect(helm.calls).toEqual([NS]);
    expect(stack.primary.helm).toEqual([
      { release: 'cache', role: 'accessory', namespace: NS, workloads: [{ kind: 'DaemonSet', name: 'cache-agent' }] },
      { release: 'idle', role: 'app', namespace: NS, workloads: [] },
      {
        release: 'search',
        role: 'app',
        namespace: NS,
        workloads: [
          { kind: 'Deployment', name: 'search-api' },
          { kind: 'StatefulSet', name: 'search-db' },
        ],
      },
      { release: 'unlabelled', role: null, namespace: NS, workloads: [] },
    ]);
    // compose workloads are untouched by chart objects
    expect([...stack.primary.composeWorkloads.keys()].sort()).toEqual(['db', 'web']);
    expect(stack.releases.map((r) => r.name)).toEqual(['search', 'cache', 'idle', 'unlabelled']);
  });

  it('a release in another namespace triggers exactly one extra read of that namespace', async () => {
    const shared = [helmWorkload('Deployment', 'cache', 'cache', SHARED), helmWorkload('Deployment', 'queue', 'queue', SHARED)];
    const kube = fake([inventoryStep(WEB_ITEMS), inventoryStep(shared, SHARED), revisionStep([], null, SHARED)], 'any');
    const helm = helmStub([release('cache', 'accessory', SHARED), release('queue', 'app', SHARED), release('search', 'app')]);
    const stack = await createInventoryReader({ kubectl: kube, helm }).read(NS);
    expect(stack.namespaces.map((n) => n.namespace)).toEqual([NS, SHARED]);
    expect(kube.calls.filter((c) => c.call.namespace === SHARED)).toHaveLength(1);
    const other = stack.namespaces[1];
    expect(other.helm.map((h) => [h.release, h.workloads.map((w) => w.name)])).toEqual([
      ['cache', ['cache']],
      ['queue', ['queue']],
    ]);
    expect(stack.primary.helm.map((h) => h.release)).toEqual(['search']);
    // chart pods of another namespace carry no Dockflow labels: the whole namespace is read
    await other.revisions('app');
  });
});

describe('pod metrics', () => {
  const metricsStep: KubeStep = {
    id: 'metrics',
    method: 'run',
    namespace: null,
    args: ['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`],
    mutating: false,
    respond: { fixture: 'metrics/metrics-top' },
  };

  it('are read at most once per namespace and bundle, invalidate included', async () => {
    const kube = fake([metricsStep]);
    const reader = createInventoryReader({ kubectl: kube, helm: null });
    const first = await reader.podMetrics(NS);
    reader.invalidate(NS);
    expect(await reader.podMetrics(NS)).toBe(first);
    expect(podMetricsPath(NS)).toBe(`/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`);
    expect(first.map((m) => m.metadata.name)).toEqual(['db-0', 'dockflow-helper-archive-3f9a2c1b', 'web-782lrz9hsf-6dfnp', 'web-782lrz9hsf-7fvrw']);
    expect(first[2].containers).toEqual([{ name: 'web', usage: { cpu: '987204n', memory: '3964Ki' } }]);
  });

  it('output that is not JSON is a KubeError, and is read again next time', async () => {
    const kube = fake([{ ...metricsStep, id: 'garbage', respond: { exitCode: 0, stdout: '<html>', stderr: '' } }, metricsStep]);
    const reader = createInventoryReader({ kubectl: kube, helm: null });
    await expect(reader.podMetrics(NS)).rejects.toThrow(`kubectl get --raw ${podMetricsPath(NS)} returned output that is not JSON on server_1`);
    expect(await reader.podMetrics(NS)).toHaveLength(4);
  });

  it('a metrics-server failure surfaces as a KubeError carrying the stderr', async () => {
    const stderr = 'Error from server (ServiceUnavailable): the server is currently unable to handle the request (get pods.metrics.k8s.io)\n';
    const kube = fake([{ ...metricsStep, respond: { exitCode: 1, stdout: '', stderr } }]);
    const error = await createInventoryReader({ kubectl: kube, helm: null })
      .podMetrics(NS)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(KubeError);
    expect((error as KubeError).stderr).toContain('(ServiceUnavailable)');
  });
});
