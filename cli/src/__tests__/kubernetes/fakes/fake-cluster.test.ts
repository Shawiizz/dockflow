import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANNOTATIONS, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';
import { classifyKubectlFailure, KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { Redactor } from '../../../utils/redact';
import { assertExecutorInvariants, INV08_RELEASE_LIST_TEMPLATE } from '../support/invariants';
import { FakeClock } from './fake-clock';
import { FakeCluster, type FakeClusterOptions, type KubeObject, type RejectReason } from './fake-cluster';
import { FakeKubeExecutor } from './fake-kube-executor';

const NS = 'dockflow-shop-production';
const SYSTEM = 'dockflow-system';
const UID_RE = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;

type Obj = Record<string, unknown>;

function setup(options: FakeClusterOptions = {}): { cluster: FakeCluster; kube: FakeKubeExecutor } {
  const cluster = new FakeCluster(options);
  return { cluster, kube: new FakeKubeExecutor({ redactor: new Redactor([]), cluster }) };
}

function manifest(...objects: object[]): string {
  return objects.map((object) => JSON.stringify(object)).join('\n---\n');
}

async function apply(kube: FakeKubeExecutor, ...objects: object[]): Promise<void> {
  await kube.apply(manifest(...objects), { dryRun: false });
}

async function get(kube: FakeKubeExecutor, resource: string, name: string, namespace: string | undefined = NS): Promise<KubeObject> {
  const [found] = await kube.getJson<KubeObject>([resource], { name, ...(namespace !== undefined ? { namespace } : {}) });
  if (!found) throw new Error(`${resource}/${name} not found`);
  return found;
}

async function list(kube: FakeKubeExecutor, resource: string, namespace = NS, selector?: string): Promise<KubeObject[]> {
  return kube.getJson<KubeObject>([resource], { namespace, ...(selector !== undefined ? { selector } : {}) });
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KubeError) return error.reason;
    throw error;
  }
  throw new Error('expected a KubeError');
}

function status(object: KubeObject): Obj {
  return (object.status ?? {}) as Obj;
}

function spec(object: KubeObject): Obj {
  return (object.spec ?? {}) as Obj;
}

function condition(object: KubeObject, type: string): Obj | undefined {
  return ((status(object).conditions ?? []) as Obj[]).find((entry) => entry.type === type);
}

function containerStatus(pod: KubeObject): Obj {
  return ((status(pod).containerStatuses ?? []) as Obj[])[0] ?? {};
}

const namespace = (name = NS): object => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });

const configMap = (name: string, data: Record<string, string> = { mode: 'production' }, extra: { labels?: Record<string, string>; namespace?: string } = {}): object => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name, namespace: extra.namespace ?? NS, ...(extra.labels ? { labels: extra.labels } : {}) },
  data,
});

function deployment(
  name: string,
  image: string,
  extra: { replicas?: number; revisionHistoryLimit?: number; grace?: number; selector?: Record<string, string>; labels?: Record<string, string> } = {},
): object {
  const selector = extra.selector ?? { app: name };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: NS, labels: { app: name, ...extra.labels } },
    spec: {
      replicas: extra.replicas ?? 1,
      ...(extra.revisionHistoryLimit !== undefined ? { revisionHistoryLimit: extra.revisionHistoryLimit } : {}),
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: { app: name, ...selector } },
        spec: { terminationGracePeriodSeconds: extra.grace ?? 0, containers: [{ name, image }] },
      },
    },
  };
}

function statefulSet(name: string, image: string, storage = '1Gi'): object {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name, namespace: NS },
    spec: {
      replicas: 2,
      serviceName: name,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name, image }] } },
      volumeClaimTemplates: [
        {
          metadata: { name: 'data' },
          spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'dockflow-local', resources: { requests: { storage } } },
        },
      ],
    },
  };
}

function job(name: string, image: string, backoffLimit?: number): object {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NS },
    spec: {
      ...(backoffLimit !== undefined ? { backoffLimit } : {}),
      template: { metadata: { labels: { app: name } }, spec: { restartPolicy: 'Never', containers: [{ name, image }] } },
    },
  };
}

function pod(name: string, image: string, extra: { claim?: string; nodeSelector?: Record<string, string>; labels?: Record<string, string> } = {}): object {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: NS, labels: { app: name, ...extra.labels } },
    spec: {
      terminationGracePeriodSeconds: 0,
      ...(extra.nodeSelector ? { nodeSelector: extra.nodeSelector } : {}),
      containers: [{ name: 'main', image, ...(extra.claim ? { volumeMounts: [{ name: 'data', mountPath: '/data' }] } : {}) }],
      ...(extra.claim ? { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: extra.claim } }] } : {}),
    },
  };
}

const claim = (name: string, extra: { storage?: string; accessModes?: string[]; storageClassName?: string } = {}): object => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name, namespace: NS },
  spec: {
    accessModes: extra.accessModes ?? ['ReadWriteOnce'],
    storageClassName: extra.storageClassName ?? 'dockflow-local',
    resources: { requests: { storage: extra.storage ?? '1Gi' } },
  },
});

const lease = (name: string, holder: string, resourceVersion?: string): object => ({
  apiVersion: 'coordination.k8s.io/v1',
  kind: 'Lease',
  metadata: { name, namespace: SYSTEM, ...(resourceVersion !== undefined ? { resourceVersion } : {}) },
  spec: { holderIdentity: holder, leaseDurationSeconds: 1800 },
});

const loadBalancer = (name: string, port: number): object => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name, namespace: NS },
  spec: { type: 'LoadBalancer', selector: { app: 'web' }, ports: [{ name: 'http', port, protocol: 'TCP', targetPort: 80 }] },
});

describe('FakeCluster', () => {
  describe('storage', () => {
    it('keys objects by kind, namespace and name with uid and resourceVersion counters and clock timestamps', async () => {
      const clock = new FakeClock();
      const { kube } = setup({ clock });
      await apply(kube, namespace());
      await clock.advance(5000);
      await apply(kube, configMap('first'), configMap('second'));
      const first = await get(kube, 'configmaps', 'first');
      const second = await get(kube, 'configmaps', 'second');
      expect(first.metadata.uid).toMatch(UID_RE);
      expect(second.metadata.uid).toMatch(UID_RE);
      expect(first.metadata.uid).not.toBe(second.metadata.uid);
      expect(Number(second.metadata.resourceVersion)).toBeGreaterThan(Number(first.metadata.resourceVersion));
      expect(first.metadata.creationTimestamp).toBe('2026-01-01T00:00:05Z');
      // the same name in another namespace is another object
      await apply(kube, configMap('first', { mode: 'staging' }, { namespace: 'default' }));
      expect((await get(kube, 'configmaps', 'first', 'default')).data).toEqual({ mode: 'staging' });
      expect((await get(kube, 'configmaps', 'first')).data).toEqual({ mode: 'production' });
    });
  });

  describe('apply --server-side', () => {
    it('fails the test when an applied object fails schema validation', async () => {
      const { cluster, kube } = setup();
      const bad = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'bad', namespace: 'default' }, datta: { a: 'b' } };
      await expect(apply(kube, bad)).rejects.toThrow(/fails schema validation[\s\S]*unknown field datta/);
      expect(cluster.problems).toHaveLength(1);
      expect(() => cluster.assertNoProblems()).toThrow(/ConfigMap\/bad datta: unknown-field/);
    });

    it('replaces applied fields, bumps generation only for spec changes and keeps resourceVersion on an unchanged apply', async () => {
      const { kube } = setup();
      await apply(kube, namespace(), deployment('web', 'shop/web:1'));
      const created = await get(kube, 'deployments.apps', 'web');
      expect(created.metadata.generation).toBe(1);
      await apply(kube, deployment('web', 'shop/web:1'));
      const unchanged = await get(kube, 'deployments.apps', 'web');
      expect(unchanged.metadata.resourceVersion).toBe(created.metadata.resourceVersion);
      await apply(kube, deployment('web', 'shop/web:1', { labels: { tier: 'front' } }));
      const relabelled = await get(kube, 'deployments.apps', 'web');
      expect(relabelled.metadata.generation).toBe(1);
      expect(relabelled.metadata.labels).toEqual({ app: 'web', tier: 'front' });
      expect(Number(relabelled.metadata.resourceVersion)).toBeGreaterThan(Number(created.metadata.resourceVersion));
      await apply(kube, deployment('web', 'shop/web:2'));
      const updated = await get(kube, 'deployments.apps', 'web');
      expect(updated.metadata.generation).toBe(2);
      // the label only the applier owned is gone with its omission
      expect(updated.metadata.labels).toEqual({ app: 'web' });
    });

    it('stores nothing on --dry-run=server', async () => {
      const { kube } = setup();
      await apply(kube, namespace(), deployment('web', 'shop/web:1'));
      await kube.apply(manifest(deployment('web', 'shop/web:1', { replicas: 5 }), configMap('fresh')), { dryRun: true });
      expect(spec(await get(kube, 'deployments.apps', 'web')).replicas).toBe(1);
      expect(await kube.getJson(['configmaps'], { namespace: NS, name: 'fresh', allowNotFound: true })).toEqual([]);
      const dryRun = kube.calls.find((call) => call.call.args.includes('--dry-run=server'));
      expect(dryRun?.result?.stdout).toBe('deployment.apps/web serverside-applied (server dry run)\nconfigmap/fresh serverside-applied (server dry run)\n');
    });

    it('keeps the keys of each field manager on a shared object and clears only what the applier dropped', async () => {
      const { kube } = setup();
      await apply(kube, namespace());
      const state = (data: Record<string, string>): string => manifest(configMap('dockflow-state', data));
      await kube.apply(state({ current: '1.4.2', schema: '1' }), { dryRun: false, fieldManager: 'dockflow-release-state' });
      await kube.apply(state({ 'accessories-digest': 'abc', schema: '1' }), { dryRun: false, fieldManager: 'dockflow-accessories-state' });
      expect((await get(kube, 'configmaps', 'dockflow-state')).data).toEqual({ 'accessories-digest': 'abc', current: '1.4.2', schema: '1' });
      await kube.apply(state({ schema: '1' }), { dryRun: false, fieldManager: 'dockflow-release-state' });
      expect((await get(kube, 'configmaps', 'dockflow-state')).data).toEqual({ 'accessories-digest': 'abc', schema: '1' });
      await kube.apply(state({ current: '1.4.3' }), { dryRun: false, fieldManager: 'dockflow-release-state' });
      // schema is still applied by the accessories manager, so it stays
      expect((await get(kube, 'configmaps', 'dockflow-state')).data).toEqual({ 'accessories-digest': 'abc', current: '1.4.3', schema: '1' });
      await kube.run({ args: ['label', 'configmap', 'dockflow-state', 'extra=yes'], namespace: NS, mutating: true });
      await kube.apply(state({ current: '1.4.3' }), { dryRun: false, fieldManager: 'dockflow-release-state' });
      expect((await get(kube, 'configmaps', 'dockflow-state')).metadata.labels).toEqual({ extra: 'yes' });
      const [managed] = await kube.getJson<KubeObject>(['configmaps/dockflow-state'.split('/')[0]], { namespace: NS, name: 'dockflow-state' });
      expect(managed.metadata.managedFields).toBeUndefined();
      const shown = await kube.run({ args: ['get', 'configmaps', 'dockflow-state', '--show-managed-fields', '-o', 'json'], namespace: NS, mutating: false });
      const managers = ((JSON.parse(shown.stdout) as KubeObject).metadata.managedFields as Obj[]).map((entry) => `${entry.manager}:${entry.operation}`);
      expect(managers.sort()).toEqual(['dockflow-accessories-state:Apply', 'dockflow-release-state:Apply', 'kubectl-label:Update']);
    });
  });

  describe('create and replace', () => {
    it('creates with AlreadyExists, and replaces with optimistic concurrency on metadata.resourceVersion (Lease takeover)', async () => {
      const { kube } = setup();
      const created = await kube.create<KubeObject>(manifest(lease('lock-dockflow-shop-production', 'alice')), { namespace: SYSTEM, json: true });
      if (created.result !== 'created' || created.object === null) throw new Error('expected a created Lease');
      const { uid, resourceVersion } = created.object.metadata;
      expect(uid).toMatch(UID_RE);
      expect(resourceVersion).toBeDefined();
      expect(await kube.create(manifest(lease('lock-dockflow-shop-production', 'bob')), { namespace: SYSTEM })).toEqual({ result: 'exists' });
      const replaced = await kube.replace<KubeObject>(manifest(lease('lock-dockflow-shop-production', 'bob', resourceVersion)), { namespace: SYSTEM });
      expect(replaced.metadata.uid).toBe(uid);
      expect(replaced.metadata.resourceVersion).not.toBe(resourceVersion);
      expect(spec(replaced).holderIdentity).toBe('bob');
      // a second takeover that read the old version loses
      expect(await reason(kube.replace(manifest(lease('lock-dockflow-shop-production', 'carol', resourceVersion)), { namespace: SYSTEM }))).toBe('Conflict');
      expect(await reason(kube.replace(manifest(lease('lock-missing', 'carol', '1')), { namespace: SYSTEM }))).toBe('NotFound');
      const withVersion = kube.create(manifest(lease('lock-other', 'dave', '12')), { namespace: SYSTEM });
      await expect(withVersion).rejects.toThrow(/resourceVersion should not be set on objects to be created/);
    });
  });

  describe('get', () => {
    it('selects by k=v, k!=v, k, !k, in and notin', async () => {
      const { kube } = setup();
      await apply(
        kube,
        namespace(),
        configMap('a', {}, { labels: { tier: 'web', env: 'prod' } }),
        configMap('b', {}, { labels: { tier: 'db', env: 'prod' } }),
        configMap('c', {}, { labels: { tier: 'web' } }),
        configMap('d', {}),
      );
      const names = async (selector: string): Promise<string[]> => (await list(kube, 'configmaps', NS, selector)).map((object) => object.metadata.name);
      expect(await names('tier=web')).toEqual(['a', 'c']);
      expect(await names('tier!=web')).toEqual(['b', 'd']);
      expect(await names('env')).toEqual(['a', 'b']);
      expect(await names('!env')).toEqual(['c', 'd']);
      expect(await names('tier in (web,db)')).toEqual(['a', 'b', 'c']);
      expect(await names('tier notin (web)')).toEqual(['b', 'd']);
      expect(await names('tier=web,env=prod')).toEqual(['a']);
    });

    it('reads several names and several resources in one call, a single object for one name, and NotFound otherwise', async () => {
      const { kube } = setup();
      const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's1', namespace: NS }, data: { k: 'dg==' } };
      await apply(kube, namespace(), configMap('a'), configMap('b'), secret);
      const some = await kube.getJson<KubeObject>(['configmaps'], { namespace: NS, names: ['a', 'missing', 'b'], ignoreNotFound: true });
      expect(some.map((object) => object.metadata.name)).toEqual(['a', 'b']);
      expect(await reason(kube.getJson(['configmaps'], { namespace: NS, names: ['a', 'missing'] }))).toBe('NotFound');
      const mixed = await kube.getJson<KubeObject>(['configmaps', 'secrets'], { namespace: NS });
      expect(mixed.map((object) => `${object.kind}/${object.metadata.name}`)).toEqual(['ConfigMap/a', 'ConfigMap/b', 'Secret/s1']);
      const single = await kube.run({ args: ['get', 'configmaps', 'a', '-o', 'json'], namespace: NS, mutating: false });
      expect((JSON.parse(single.stdout) as KubeObject).kind).toBe('ConfigMap');
      const listed = await kube.run({ args: ['get', 'configmaps', '-o', 'json'], namespace: NS, mutating: false });
      expect(JSON.parse(listed.stdout)).toMatchObject({ apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '' } });
      expect(await kube.getJson(['configmaps'], { namespace: NS, name: 'missing', allowNotFound: true })).toEqual([]);
    });

    it('lists names with -o name, releases with the PD-7 go-template, and answers --raw, api-resources and version', async () => {
      const { cluster, kube } = setup();
      const metadata = Buffer.from(JSON.stringify({ version: '1.4.2' })).toString('base64');
      const release = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'dockflow-release-1-4-2',
          namespace: NS,
          labels: { 'dockflow.shawiizz.dev/part': 'release' },
          annotations: { [ANNOTATIONS.release]: '1.4.2' },
        },
        data: { 'metadata.json': metadata, 'stack.yml.gz': 'cGF5bG9hZA==' },
      };
      await apply(kube, namespace(), release, configMap('a'));
      const names = await kube.run({ args: ['get', 'secrets,configmaps', '-o', 'name'], namespace: NS, mutating: false });
      expect(names.stdout).toBe('secret/dockflow-release-1-4-2\nconfigmap/a\n');
      const rows = await kube.run({ args: ['get', 'secrets', '-l', 'dockflow.shawiizz.dev/part=release', '-o', INV08_RELEASE_LIST_TEMPLATE], namespace: NS, mutating: false });
      expect(rows.stdout).toBe(`dockflow-release-1-4-2 1.4.2 ${metadata}\n`);
      expect(rows.stdout).not.toContain('cGF5bG9hZA==');
      expect((await kube.run({ args: ['get', '--raw=/readyz'], mutating: false })).stdout).toBe('ok');
      cluster.apiReady = false;
      expect((await kube.run({ args: ['get', '--raw=/readyz'], mutating: false, allowFailure: true })).exitCode).toBe(1);
      const resources = (await kube.run({ args: ['api-resources', '-o', 'name'], mutating: false })).stdout.split('\n');
      expect(resources).toContain('deployments.apps');
      expect(resources).toContain('ingressroutes.traefik.io');
      expect(resources).toContain('pods.metrics.k8s.io');
      const version = JSON.parse((await kube.run({ args: ['version', '-o', 'json'], mutating: false })).stdout) as { serverVersion: { gitVersion: string } };
      expect(version.serverVersion.gitVersion).toBe(K3S_PIN.version);
    });

    it('serves metrics.k8s.io for running pods and reports ServiceUnavailable without it', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), pod('web', 'shop/web:1'));
      cluster.tick(2);
      cluster.setPodMetrics(`${NS}/web`, { main: { cpu: '5m', memory: '20Mi' } });
      const raw = await kube.run({ args: ['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`], mutating: false });
      const metrics = JSON.parse(raw.stdout) as { kind: string; items: { metadata: { name: string }; containers: { name: string; usage: Obj }[] }[] };
      expect(metrics.kind).toBe('PodMetricsList');
      expect(metrics.items.map((item) => item.metadata.name)).toEqual(['web']);
      expect(metrics.items[0].containers).toEqual([{ name: 'main', usage: { cpu: '5m', memory: '20Mi' } }]);
      cluster.metricsAvailable = false;
      const refused = await kube.run({ args: ['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`], mutating: false, allowFailure: true });
      expect(refused.stderr).toContain('(ServiceUnavailable)');
    });
  });

  describe('delete', () => {
    it('honours --ignore-not-found and reports NotFound without it', async () => {
      const { kube } = setup();
      await apply(kube, namespace(), configMap('a'));
      await kube.delete(['configmaps/missing'], { namespace: NS, wait: false, ignoreNotFound: true });
      expect(await reason(kube.delete(['configmaps/missing'], { namespace: NS, wait: false, ignoreNotFound: false }))).toBe('NotFound');
      await kube.delete(['configmaps'], { namespace: NS, wait: true, ignoreNotFound: false }).catch(() => {});
      await kube.delete(['configmaps/a'], { namespace: NS, wait: true, ignoreNotFound: false });
      expect(await list(kube, 'configmaps')).toEqual([]);
    });

    it('--cascade=foreground --wait returns once the pods terminated after their grace period, and times out before that', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), deployment('web', 'shop/web:1', { replicas: 2, grace: 5 }));
      cluster.tick(2);
      expect((await list(kube, 'pods')).filter((object) => condition(object, 'Ready')?.status === 'True')).toHaveLength(2);
      const tooShort = kube.delete(['deployments.apps/web'], { namespace: NS, wait: true, timeoutS: 2, ignoreNotFound: true, cascade: 'foreground' });
      expect(await reason(tooShort)).toBe('Timeout');
      const pods = await list(kube, 'pods');
      expect(pods).toHaveLength(2);
      expect(pods.every((object) => object.metadata.deletionTimestamp !== undefined)).toBe(true);
      expect((await get(kube, 'deployments.apps', 'web')).metadata.finalizers).toEqual(['foregroundDeletion']);
      const before = cluster.tickCount;
      await kube.delete(['deployments.apps/web'], { namespace: NS, wait: true, timeoutS: 60, ignoreNotFound: true, cascade: 'foreground' });
      expect(cluster.tickCount - before).toBe(3);
      expect(await list(kube, 'pods')).toEqual([]);
      expect(await list(kube, 'replicasets.apps')).toEqual([]);
      expect(await kube.getJson(['deployments.apps'], { namespace: NS, name: 'web', allowNotFound: true })).toEqual([]);
    });

    it('waits on the clock when there is one', async () => {
      const clock = new FakeClock();
      const { kube } = setup({ clock });
      await apply(kube, namespace(), pod('slow', 'shop/web:1'));
      await clock.advance(2000);
      const podObject = await get(kube, 'pods', 'slow');
      expect(podObject.status).toMatchObject({ phase: 'Running' });
      await kube.run({ args: ['patch', 'pods/slow', '--type=merge', '-p', '{"spec":{"activeDeadlineSeconds":600}}'], namespace: NS, mutating: true });
      let finished = false;
      const deleting = kube.run({ args: ['delete', 'pods/slow', '--grace-period=4', '--wait=true'], namespace: NS, mutating: true }).then((result) => {
        finished = true;
        return result;
      });
      await clock.advance(3000);
      expect(finished).toBe(false);
      await clock.advance(1000);
      expect((await deleting).stdout).toBe('pod "slow" deleted\n');
      expect(finished).toBe(true);
    });

    it('delete --raw checks the DeleteOptions preconditions: a mismatch is a Conflict and deletes nothing', async () => {
      const { kube } = setup();
      const created = await kube.create<KubeObject>(manifest(lease('lock-dockflow-shop-production', 'alice')), { namespace: SYSTEM, json: true });
      if (created.result !== 'created' || created.object === null) throw new Error('expected a created Lease');
      const { uid, resourceVersion } = created.object.metadata;
      const uri = `--raw=/apis/coordination.k8s.io/v1/namespaces/${SYSTEM}/leases/lock-dockflow-shop-production`;
      const release = (preconditions: Obj) =>
        kube.run({
          args: ['delete', uri, '-f', '-'],
          stdin: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions }),
          mutating: true,
          allowFailure: true,
        });
      const wrongUid = await release({ uid: '00000000-0000-4000-8000-0000000000ff', resourceVersion });
      expect(classifyKubectlFailure(wrongUid.exitCode, wrongUid.stderr)).toBe('Conflict');
      expect(wrongUid.stderr).toContain('Precondition failed: UID in precondition: 00000000-0000-4000-8000-0000000000ff');
      const staleVersion = await release({ uid, resourceVersion: '1' });
      expect(classifyKubectlFailure(staleVersion.exitCode, staleVersion.stderr)).toBe('Conflict');
      expect(await get(kube, 'leases.coordination.k8s.io', 'lock-dockflow-shop-production', SYSTEM)).toBeDefined();
      const released = await release({ uid, resourceVersion });
      expect(released.exitCode).toBe(0);
      expect(JSON.parse(released.stdout)).toMatchObject({ kind: 'Status', status: 'Success', details: { name: 'lock-dockflow-shop-production', uid } });
      const again = await release({ uid, resourceVersion });
      expect(classifyKubectlFailure(again.exitCode, again.stderr)).toBe('NotFound');
    });
  });

  describe('Services', () => {
    it('gives a LoadBalancer ingress one tick after creation', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), loadBalancer('web-lb', 8080));
      expect(status(await get(kube, 'services', 'web-lb'))).toEqual({ loadBalancer: {} });
      cluster.tick();
      expect(status(await get(kube, 'services', 'web-lb'))).toEqual({
        loadBalancer: {
          ingress: [
            { ip: '192.0.2.10', ipMode: 'VIP' },
            { ip: '192.0.2.20', ipMode: 'VIP' },
          ],
        },
      });
    });

    it('keeps a second LoadBalancer on a claimed port without ingress for good', async () => {
      const { cluster, kube } = setup();
      cluster.claimHostPort(8080, 'TCP', { namespace: 'dockflow-other-production', name: 'api-lb' });
      await apply(kube, namespace(), loadBalancer('web-lb', 8080), loadBalancer('admin-lb', 9090));
      cluster.tick(30);
      expect(status(await get(kube, 'services', 'web-lb'))).toEqual({ loadBalancer: {} });
      expect((status(await get(kube, 'services', 'admin-lb')).loadBalancer as Obj).ingress).toHaveLength(2);
      const all = await kube.getJson<KubeObject>(['services'], { allNamespaces: true });
      const owner = all.find((service) => service.metadata.name === 'api-lb');
      expect(owner?.metadata.namespace).toBe('dockflow-other-production');
      expect((status(owner as KubeObject).loadBalancer as Obj).ingress).toHaveLength(2);
    });

    it('keeps the allocated cluster IP and publishes ready pods in an EndpointSlice', async () => {
      const { cluster, kube } = setup();
      const service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: NS }, spec: { selector: { app: 'web' }, ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: 80 }] } };
      await apply(kube, namespace(), service, deployment('web', 'shop/web:1', { replicas: 2 }));
      const allocated = spec(await get(kube, 'services', 'web')).clusterIP;
      expect(allocated).toMatch(/^10\.43\./);
      await apply(kube, service);
      expect(spec(await get(kube, 'services', 'web')).clusterIP).toBe(allocated);
      cluster.tick(2);
      const pods = await list(kube, 'pods');
      expect(cluster.endpointsOf('web', NS).sort()).toEqual(pods.map((object) => String(status(object).podIP)).sort());
      const [slice] = await list(kube, 'endpointslices.discovery.k8s.io', NS, 'kubernetes.io/service-name=web');
      expect(slice.ports).toEqual([{ name: 'http', port: 80, protocol: 'TCP' }]);
    });
  });

  describe('PersistentVolumes', () => {
    it('binds a claim when a pod uses it, keeps a Retain volume Released, and deletes one patched to Delete a tick later', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), claim('data'));
      cluster.tick(3);
      expect(status(await get(kube, 'persistentvolumeclaims', 'data')).phase).toBe('Pending');
      await apply(kube, pod('user', 'shop/web:1', { claim: 'data' }));
      cluster.tick();
      const bound = await get(kube, 'persistentvolumeclaims', 'data');
      expect(status(bound).phase).toBe('Bound');
      const volume = `pvc-${bound.metadata.uid}`;
      expect(spec(bound).volumeName).toBe(volume);
      const pv = await get(kube, 'persistentvolumes', volume, undefined);
      expect(spec(pv).persistentVolumeReclaimPolicy).toBe('Retain');
      expect(spec(pv).claimRef).toMatchObject({ name: 'data', namespace: NS, uid: bound.metadata.uid });
      expect(cluster.pvFor('data', NS)).toMatchObject({ name: volume, originalPolicy: 'Retain', reclaimPolicy: 'Retain', phase: 'Bound', exists: true });

      // pvc-protection: the claim waits for its pod
      await kube.delete(['persistentvolumeclaims/data'], { namespace: NS, wait: false, ignoreNotFound: false });
      cluster.tick();
      expect((await get(kube, 'persistentvolumeclaims', 'data')).metadata.deletionTimestamp).toBeDefined();
      await kube.delete(['pods/user'], { namespace: NS, wait: true, timeoutS: 30, ignoreNotFound: false });
      cluster.tick(3);
      expect(await kube.getJson(['persistentvolumeclaims'], { namespace: NS, name: 'data', allowNotFound: true })).toEqual([]);
      expect(status(await get(kube, 'persistentvolumes', volume, undefined)).phase).toBe('Released');
      expect(cluster.reclaimPolicyOf(volume)).toBe('Retain');

      await kube.run({
        args: ['patch', 'persistentvolumes', volume, '--type=merge', '-p', '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'],
        mutating: true,
      });
      expect(cluster.reclaimPolicyOf(volume)).toBe('Delete');
      cluster.tick();
      expect(cluster.reclaimPolicyOf(volume)).toBeNull();
      expect(cluster.pvFor('data', NS)).toMatchObject({ originalPolicy: 'Retain', reclaimPolicy: null, exists: false });
      kube.assertDone();
      assertExecutorInvariants({ kube, allow: { volumeDeletion: true }, volumes: cluster });
    });
  });

  describe('workload verbs', () => {
    it('serves scale, rollout undo and restart, patch, label and annotate', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), deployment('web', 'shop/web:1'));
      cluster.tick(3);
      await apply(kube, deployment('web', 'shop/web:2'));
      cluster.tick(4);
      const run = (...args: string[]) => kube.run({ args, namespace: NS, mutating: true });

      expect((await run('scale', 'deployments.apps/web', '--replicas=3')).stdout).toBe('deployment.apps/web scaled\n');
      cluster.tick(3);
      expect(status(await get(kube, 'deployments.apps', 'web'))).toMatchObject({ readyReplicas: 3, updatedReplicas: 3 });

      expect((await run('rollout', 'undo', 'deployments.apps/web', '--to-revision=1')).stdout).toBe('deployment.apps/web rolled back\n');
      cluster.tick(4);
      const undone = await get(kube, 'deployments.apps', 'web');
      expect(((spec(undone).template as Obj).spec as { containers: Obj[] }).containers[0].image).toBe('shop/web:1');
      expect(undone.metadata.annotations?.[KUBE_KEYS.deploymentRevision]).toBe('3');
      expect(await reason(run('rollout', 'undo', 'deployments.apps/web', '--to-revision=9'))).toBe('Unknown');

      await run('rollout', 'restart', 'deployments.apps/web');
      const restarted = await get(kube, 'deployments.apps', 'web');
      expect(((spec(restarted).template as Obj).metadata as KubeObject['metadata']).annotations?.['kubectl.kubernetes.io/restartedAt']).toBeDefined();
      expect(restarted.metadata.generation).toBe(undone.metadata.generation !== undefined ? undone.metadata.generation + 1 : 0);

      const patched = await run('patch', 'deployments.apps/web', '--type=merge', '-p', JSON.stringify({ metadata: { annotations: { [ANNOTATIONS.replicasBeforeStop]: '3' } }, spec: { replicas: 0 } }));
      expect(patched.stdout).toBe('deployment.apps/web patched\n');
      const stopped = await get(kube, 'deployments.apps', 'web');
      expect(spec(stopped).replicas).toBe(0);
      expect(stopped.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop]).toBe('3');

      await run('label', 'deployments.apps/web', 'tier=front');
      expect(await reason(run('label', 'deployments.apps/web', 'tier=back'))).toBe('Unknown');
      await run('label', 'deployments.apps/web', 'tier=back', '--overwrite');
      await run('annotate', 'deployments.apps/web', 'note=kept');
      const labelled = await get(kube, 'deployments.apps', 'web');
      expect(labelled.metadata.labels).toEqual({ app: 'web', tier: 'back' });
      expect(labelled.metadata.annotations?.note).toBe('kept');
    });
  });

  describe('wait and node verbs', () => {
    it('waits for deletion and conditions, and serves label, cordon and drain on nodes', async () => {
      const { cluster, kube } = setup();
      cluster.behave('shop/idle:1', { kind: 'never-ready' });
      await apply(kube, namespace(), deployment('web', 'shop/web:1', { replicas: 2, grace: 3 }), pod('idle', 'shop/idle:1'));
      cluster.tick(2);
      const run = (...args: string[]) => kube.run({ args, namespace: NS, mutating: args[0] !== 'wait', allowFailure: true });

      await run('delete', 'pods', '-l', 'app=web', '--wait=false');
      const before = cluster.tickCount;
      const gone = await run('wait', '--for=delete', 'pods', '-l', 'app=web', '--timeout=30s');
      expect(gone.exitCode).toBe(0);
      expect(cluster.tickCount - before).toBe(3);
      const established = await run('wait', '--for=condition=Established', 'customresourcedefinitions.apiextensions.k8s.io/ingressroutes.traefik.io', '--timeout=60s');
      expect(established.stdout).toBe('customresourcedefinition.apiextensions.k8s.io/ingressroutes.traefik.io condition met\n');
      const never = await run('wait', '--for=condition=Ready', 'pods/idle', '--timeout=5s');
      expect(classifyKubectlFailure(never.exitCode, never.stderr)).toBe('Timeout');

      await run('label', 'node', 'agent-1', 'dockflow.shawiizz.dev/zone=eu');
      expect(cluster.get('nodes', 'agent-1')?.metadata.labels?.['dockflow.shawiizz.dev/zone']).toBe('eu');
      await run('label', 'nodes/agent-1', 'dockflow.shawiizz.dev/zone-');
      expect(cluster.get('nodes', 'agent-1')?.metadata.labels?.['dockflow.shawiizz.dev/zone']).toBeUndefined();

      cluster.tick(2);
      expect((await list(kube, 'pods', NS, 'app=web')).map((object) => spec(object).nodeName).sort()).toEqual(['agent-1', 'server-1']);
      expect((await run('cordon', 'agent-1')).stdout).toBe('node/agent-1 cordoned\n');
      expect(spec(cluster.get('nodes', 'agent-1') as KubeObject).unschedulable).toBe(true);
      const drained = await run('drain', 'agent-1', '--ignore-daemonsets', '--delete-emptydir-data', '--timeout=60s');
      expect(drained.stdout).toContain('node/agent-1 drained');
      cluster.tick(2);
      const web = await list(kube, 'pods', NS, 'app=web');
      expect(web.map((object) => spec(object).nodeName)).toEqual(['server-1', 'server-1']);
      await run('uncordon', 'agent-1');
      expect(spec(cluster.get('nodes', 'agent-1') as KubeObject).unschedulable).toBeUndefined();
    });
  });

  describe('exec and logs', () => {
    it('answers exec from the registered per-pod handler, over run, shell, channel and interactive', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), pod('shell', 'busybox:1.37'));
      cluster.tick(2);
      const seen: { argv: string[]; stdin: string; tty: boolean }[] = [];
      cluster.onExec({ selector: 'app=shell', container: 'main' }, (request) => {
        seen.push({ argv: request.argv, stdin: request.stdin, tty: request.tty });
        return { exitCode: 0, stdout: request.stdin.toUpperCase() };
      });
      const direct = await kube.run({ args: ['exec', '-i', 'shell', '-c', 'main', '--', 'sh', '-c', 'cat'], namespace: NS, stdin: 'hello', mutating: true });
      expect(direct.stdout).toBe('HELLO');
      const viaShell = await kube.shell({ script: kube.command(['exec', '-i', 'shell', '--', 'tar', 'xf', '-'], NS), stdin: 'bytes', guardS: null });
      expect(viaShell.stdout).toBe('BYTES');
      const channel = await kube.channel(kube.command(['exec', '-i', 'shell', '--', 'cat'], NS));
      const chunks: string[] = [];
      channel.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      channel.stdin.end('streamed');
      expect(await channel.done).toEqual({ exitCode: 0 });
      expect(chunks.join('')).toBe('STREAMED');
      expect(await kube.interactive(kube.command(['exec', '-it', 'shell', '--', '/bin/sh'], NS))).toBe(0);
      expect(seen.map((entry) => entry.argv)).toEqual([['sh', '-c', 'cat'], ['tar', 'xf', '-'], ['cat'], ['/bin/sh']]);
      expect(seen[3].tty).toBe(true);
      await expect(kube.shell({ script: `${kube.command(['exec', 'shell', '--', 'cat'], NS)} | gzip > /tmp/out`, guardS: null })).rejects.toThrow(/cannot run the shell script/);
      expect(await reason(kube.run({ args: ['exec', 'other', '--', 'true'], namespace: NS, mutating: true }))).toBe('NotFound');
      await expect(kube.run({ args: ['exec', 'shell', '-c', 'main', '--', 'true'], namespace: NS, mutating: true })).resolves.toMatchObject({ exitCode: 0 });
      await apply(kube, pod('silent', 'busybox:1.37', { labels: { role: 'other' } }));
      cluster.tick(2);
      await expect(kube.run({ args: ['exec', 'silent', '--', 'true'], namespace: NS, mutating: true })).rejects.toThrow(/no exec handler for pod silent/);
    });

    it('serves appended logs with --tail, --timestamps, --prefix, --previous and streaming', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), pod('web', 'shop/web:1', { labels: { role: 'app' } }));
      cluster.tick(2);
      cluster.appendLogs(`${NS}/web`, 'main', ['one', 'two', 'three']);
      const tail = await kube.run({ args: ['logs', 'web', '-c', 'main', '--tail=2', '--timestamps'], namespace: NS, mutating: false });
      expect(tail.stdout).toBe('2026-01-01T00:00:02.000000000Z two\n2026-01-01T00:00:02.000000000Z three\n');
      const prefixed = await kube.run({ args: ['logs', '-l', 'role=app', '--prefix'], namespace: NS, mutating: false });
      expect(prefixed.stdout).toBe('[pod/web/main] one\n[pod/web/main] two\n[pod/web/main] three\n');
      const noPrevious = await kube.run({ args: ['logs', 'web', '--previous'], namespace: NS, mutating: false, allowFailure: true });
      expect(noPrevious.stderr).toContain('previous terminated container "main" in pod "web" not found');
      cluster.appendLogs({ namespace: NS, name: 'web' }, 'main', ['crashed'], { previous: true });
      expect((await kube.run({ args: ['logs', 'web', '-p'], namespace: NS, mutating: false })).stdout).toBe('crashed\n');
      const streamed: string[] = [];
      const exitCode = await kube.stream({ args: ['logs', '-f', 'pod/web'], namespace: NS }, { stdout: (chunk) => streamed.push(chunk), stderr: () => {} });
      expect(exitCode).toBe(0);
      expect(streamed.join('')).toBe('one\ntwo\nthree\n');
    });
  });

  describe('controllers', () => {
    it('rolls a Deployment through ReplicaSets with pod-template-hash and revisions, trimming to revisionHistoryLimit', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), deployment('web', 'shop/web:1', { replicas: 2, revisionHistoryLimit: 1 }));
      cluster.tick(2);
      const first = await get(kube, 'deployments.apps', 'web');
      expect(status(first)).toMatchObject({ observedGeneration: 1, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 });
      expect(condition(first, 'Progressing')).toMatchObject({ status: 'True', reason: 'NewReplicaSetAvailable' });
      expect(condition(first, 'Available')).toMatchObject({ status: 'True' });
      const [rs] = await list(kube, 'replicasets.apps');
      const hash = rs.metadata.labels?.[KUBE_KEYS.podTemplateHash];
      expect(rs.metadata.name).toBe(`web-${hash}`);
      expect(rs.metadata.annotations?.[KUBE_KEYS.deploymentRevision]).toBe('1');
      expect(rs.metadata.ownerReferences?.[0]).toMatchObject({ kind: 'Deployment', name: 'web', uid: first.metadata.uid, controller: true });
      const pods = await list(kube, 'pods');
      expect(pods).toHaveLength(2);
      expect(pods.every((object) => object.metadata.ownerReferences?.[0].uid === rs.metadata.uid && object.metadata.labels?.[KUBE_KEYS.podTemplateHash] === hash)).toBe(true);

      for (const version of ['2', '3']) {
        await apply(kube, deployment('web', `shop/web:${version}`, { replicas: 2, revisionHistoryLimit: 1 }));
        cluster.tick(6);
      }
      const sets = await list(kube, 'replicasets.apps');
      expect(sets.map((set) => set.metadata.annotations?.[KUBE_KEYS.deploymentRevision]).sort()).toEqual(['2', '3']);
      const last = await get(kube, 'deployments.apps', 'web');
      expect(last.metadata.annotations?.[KUBE_KEYS.deploymentRevision]).toBe('3');
      expect(status(last)).toMatchObject({ observedGeneration: 3, replicas: 2, updatedReplicas: 2 });
    });

    it('runs a StatefulSet by ordinal with claims and ControllerRevisions, and never replaces a broken updated pod', async () => {
      const { cluster, kube } = setup();
      cluster.behave('shop/db:2', { kind: 'crashloop', exitCode: 1 });
      await apply(kube, namespace(), statefulSet('db', 'shop/db:1'));
      cluster.tick(2);
      expect((await list(kube, 'pods')).map((object) => object.metadata.name)).toEqual(['db-0']);
      cluster.tick(2);
      const set = await get(kube, 'statefulsets.apps', 'db');
      const [revision] = await list(kube, 'controllerrevisions.apps');
      expect(revision.revision).toBe(1);
      expect(status(set)).toMatchObject({ replicas: 2, readyReplicas: 2, updateRevision: revision.metadata.name, currentRevision: revision.metadata.name });
      const claims = await list(kube, 'persistentvolumeclaims');
      expect(claims.map((object) => [object.metadata.name, status(object).phase])).toEqual([
        ['data-db-0', 'Bound'],
        ['data-db-1', 'Bound'],
      ]);
      expect((await list(kube, 'pods')).map((object) => object.metadata.labels?.[KUBE_KEYS.controllerRevisionHash])).toEqual([revision.metadata.name, revision.metadata.name]);

      await apply(kube, statefulSet('db', 'shop/db:2'));
      cluster.tick(3);
      const broken = await get(kube, 'pods', 'db-1');
      cluster.tick(20);
      const later = await get(kube, 'pods', 'db-1');
      expect(later.metadata.uid).toBe(broken.metadata.uid);
      expect(containerStatus(later)).toMatchObject({ state: { waiting: { reason: 'CrashLoopBackOff' } } });
      expect(Number(containerStatus(later).restartCount)).toBeGreaterThan(Number(containerStatus(broken).restartCount));
      const stuck = status(await get(kube, 'statefulsets.apps', 'db'));
      expect(stuck.updateRevision).not.toBe(stuck.currentRevision);
      expect((await get(kube, 'pods', 'db-0')).metadata.labels?.[KUBE_KEYS.controllerRevisionHash]).toBe(revision.metadata.name);
    });

    it('runs a DaemonSet on every node of cluster.nodes', async () => {
      const { cluster, kube } = setup();
      const daemon = {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata: { name: 'agent', namespace: NS },
        spec: { selector: { matchLabels: { app: 'agent' } }, template: { metadata: { labels: { app: 'agent' } }, spec: { containers: [{ name: 'agent', image: 'shop/agent:1' }] } } },
      };
      await apply(kube, namespace(), daemon);
      cluster.tick(2);
      expect(cluster.nodes).toEqual(['server-1', 'agent-1']);
      expect((await list(kube, 'pods')).map((object) => spec(object).nodeName).sort()).toEqual(['agent-1', 'server-1']);
      cluster.addNode('agent-2');
      cluster.tick(2);
      const pods = await list(kube, 'pods');
      expect(pods.map((object) => spec(object).nodeName).sort()).toEqual(['agent-1', 'agent-2', 'server-1']);
      const [revision] = await list(kube, 'controllerrevisions.apps');
      expect(pods.every((object) => `agent-${object.metadata.labels?.[KUBE_KEYS.controllerRevisionHash]}` === revision.metadata.name)).toBe(true);
      expect(status(await get(kube, 'daemonsets.apps', 'agent'))).toMatchObject({ desiredNumberScheduled: 3, numberReady: 3, updatedNumberScheduled: 3 });
    });

    it('completes and fails Jobs', async () => {
      const { cluster, kube } = setup();
      cluster.behave('shop/migrate:bad', { kind: 'crashloop', exitCode: 2 });
      await apply(kube, namespace(), job('migrate', 'shop/migrate:1'), job('broken', 'shop/migrate:bad', 1));
      cluster.tick(8);
      const done = await get(kube, 'jobs.batch', 'migrate');
      expect(condition(done, 'Complete')).toMatchObject({ status: 'True' });
      expect(status(done)).toMatchObject({ succeeded: 1 });
      const failed = await get(kube, 'jobs.batch', 'broken');
      expect(condition(failed, 'Failed')).toMatchObject({ status: 'True', reason: 'BackoffLimitExceeded' });
      expect(status(failed)).toMatchObject({ failed: 2 });
    });

    it('records scheduling Events', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace(), pod('placed', 'shop/web:1'), pod('nowhere', 'shop/web:1', { nodeSelector: { disk: 'ssd' } }));
      cluster.tick();
      const warnings = await kube.run({ args: ['get', 'events', '--field-selector=type=Warning', '-o', 'json'], namespace: NS, mutating: false });
      const items = (JSON.parse(warnings.stdout) as { items: Obj[] }).items;
      expect(items.map((event) => [event.reason, (event.involvedObject as Obj).name, event.message])).toEqual([
        [
          'FailedScheduling',
          'nowhere',
          "0/2 nodes are available: 2 node(s) didn't match Pod's node affinity/selector. preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.",
        ],
      ]);
      const all = (await list(kube, 'events')).map((event) => `${event.reason}/${(event.involvedObject as Obj).name}`);
      expect(all).toContain('Scheduled/placed');
    });

    it('ticks with FakeClock.advance', async () => {
      const clock = new FakeClock();
      const { cluster, kube } = setup({ clock });
      await apply(kube, namespace(), deployment('web', 'shop/web:1'));
      await clock.advance(1000);
      expect(status(await get(kube, 'deployments.apps', 'web'))).toMatchObject({ observedGeneration: 1, updatedReplicas: 1 });
      await clock.advance(1000);
      expect(status(await get(kube, 'deployments.apps', 'web'))).toMatchObject({ readyReplicas: 1, availableReplicas: 1 });
      expect(cluster.tickCount).toBe(2);
    });
  });

  describe('controller lag', () => {
    it('keeps only the previous ReplicaSet and its pods until the lag passes, then writes observedGeneration and the revision', async () => {
      const { cluster, kube } = setup();
      cluster.behave('shop/web:1', { kind: 'crashloop', exitCode: 1 });
      await apply(kube, namespace(), deployment('web', 'shop/web:1'));
      cluster.tick(3);
      const [old] = await list(kube, 'replicasets.apps');
      expect(containerStatus((await list(kube, 'pods'))[0])).toMatchObject({ state: { waiting: { reason: 'CrashLoopBackOff' } } });

      cluster.lag(3);
      await apply(kube, deployment('web', 'shop/web:2'));
      for (let tick = 1; tick <= 2; tick++) {
        cluster.tick();
        const current = await get(kube, 'deployments.apps', 'web');
        expect(current.metadata.generation).toBe(2);
        expect(status(current).observedGeneration).toBe(1);
        expect(current.metadata.annotations?.[KUBE_KEYS.deploymentRevision]).toBe('1');
        expect((await list(kube, 'replicasets.apps')).map((rs) => rs.metadata.name)).toEqual([old.metadata.name]);
        const pods = await list(kube, 'pods');
        expect(pods.every((object) => object.metadata.ownerReferences?.[0].uid === old.metadata.uid)).toBe(true);
        // K16: an old crash-looping pod while the new generation is not observed yet
        expect(containerStatus(pods[0])).toMatchObject({ state: { waiting: { reason: 'CrashLoopBackOff' } } });
      }
      cluster.tick();
      const synced = await get(kube, 'deployments.apps', 'web');
      expect(status(synced).observedGeneration).toBe(2);
      expect(synced.metadata.annotations?.[KUBE_KEYS.deploymentRevision]).toBe('2');
      expect(await list(kube, 'replicasets.apps')).toHaveLength(2);
    });
  });

  describe('pod behaviour', () => {
    it('drives pods by image through every PodBehavior', async () => {
      const { cluster, kube } = setup();
      cluster.behave('shop/slow:*', { kind: 'ready', afterTicks: 2 });
      cluster.behave('shop/stuck:1', { kind: 'never-ready' });
      cluster.behave(/crash/, { kind: 'crashloop', exitCode: 3, message: 'boom' });
      cluster.behave('registry.example.com/missing:1', { kind: 'waiting', reason: 'ImagePullBackOff', message: 'manifest unknown' });
      cluster.behave('shop/nowhere:1', { kind: 'unschedulable', message: '0/2 nodes are available: 2 Insufficient memory.' });
      cluster.behave('shop/oom:1', { kind: 'oom', afterTicks: 2 });
      cluster.behave('shop/flaky:1', { kind: 'restarts-after-ready', everyTicks: 2 });
      await apply(
        kube,
        namespace(),
        pod('slow', 'shop/slow:1'),
        pod('stuck', 'shop/stuck:1'),
        pod('crash', 'shop/crash:1'),
        pod('missing', 'registry.example.com/missing:1'),
        pod('nowhere', 'shop/nowhere:1'),
        pod('oom', 'shop/oom:1'),
        pod('flaky', 'shop/flaky:1'),
      );
      const at = async (name: string): Promise<KubeObject> => get(kube, 'pods', name);
      cluster.tick(2);
      expect(condition(await at('slow'), 'Ready')?.status).toBe('False');
      cluster.tick();
      expect(condition(await at('slow'), 'Ready')?.status).toBe('True');
      expect(await at('stuck')).toMatchObject({ status: { phase: 'Running' } });
      expect(containerStatus(await at('stuck'))).toMatchObject({ ready: false, state: { running: {} } });
      expect(containerStatus(await at('crash'))).toMatchObject({
        ready: false,
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { exitCode: 3, reason: 'Error', message: 'boom' } },
      });
      expect(Number(containerStatus(await at('crash')).restartCount)).toBeGreaterThanOrEqual(2);
      expect(await at('missing')).toMatchObject({ status: { phase: 'Pending' } });
      expect(containerStatus(await at('missing'))).toMatchObject({ state: { waiting: { reason: 'ImagePullBackOff', message: 'manifest unknown' } } });
      expect(spec(await at('nowhere')).nodeName).toBeUndefined();
      expect(condition(await at('nowhere'), 'PodScheduled')).toMatchObject({ status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available: 2 Insufficient memory.' });
      expect(containerStatus(await at('oom'))).toMatchObject({ state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } });
      const flaky = containerStatus(await at('flaky'));
      cluster.tick(4);
      const flakyLater = containerStatus(await at('flaky'));
      expect(flakyLater.ready).toBe(true);
      expect(Number(flakyLater.restartCount)).toBeGreaterThan(Number(flaky.restartCount));
      const reasons = (await list(kube, 'events')).map((event) => `${event.type}/${event.reason}/${(event.involvedObject as Obj).name}`);
      expect(reasons).toContain('Warning/BackOff/crash');
      expect(reasons).toContain('Warning/Failed/missing');
      expect(reasons).toContain('Warning/FailedScheduling/nowhere');
    });
  });

  describe('fault injection', () => {
    const reasons: RejectReason[] = ['Invalid', 'Forbidden', 'AdmissionDenied', 'Immutable', 'Conflict', 'NoKindMatch', 'Unauthorized', 'Unreachable'];
    for (const rejected of reasons) {
      it(`rejectOn answers ${rejected} with a recorded stderr the classifier maps to it`, async () => {
        const { cluster, kube } = setup();
        await apply(kube, namespace());
        cluster.rejectOn({ verb: 'apply', kind: 'ConfigMap', name: 'target' }, rejected);
        expect(await reason(apply(kube, configMap('target')))).toBe(rejected);
      });
    }

    it('rejects one object of a multi-document apply, honours times, dryRun: false and a stderr fixture', async () => {
      const { cluster, kube } = setup();
      await apply(kube, namespace());
      cluster.rejectOn({ verb: 'apply', kind: 'ConfigMap', name: 'bad' }, 'Invalid', undefined, { times: 1 });
      expect(await reason(apply(kube, configMap('good'), configMap('bad')))).toBe('Invalid');
      expect((await list(kube, 'configmaps')).map((object) => object.metadata.name)).toEqual(['good']);
      await apply(kube, configMap('bad'));
      cluster.rejectOn({ verb: 'apply', kind: 'Deployment' }, 'Forbidden', undefined, { dryRun: false });
      await kube.apply(manifest(deployment('web', 'shop/web:1')), { dryRun: true });
      expect(await reason(apply(kube, deployment('web', 'shop/web:1')))).toBe('Forbidden');
      cluster.rejectOn({ verb: 'replace', kind: 'Lease' }, 'Conflict', 'Conflict/2.txt');
      await kube.create(manifest(lease('lock-dockflow-shop-production', 'alice')), { namespace: SYSTEM });
      const error = await kube.replace(manifest(lease('lock-dockflow-shop-production', 'bob', '1')), { namespace: SYSTEM }).catch((caught: unknown) => caught);
      const expected = readFileSync(join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr', 'Conflict', '2.txt'), 'utf8').replace(/\r\n/g, '\n');
      expect(error).toBeInstanceOf(KubeError);
      expect((error as KubeError).stderr).toBe(expected);
    });

    it('answers NoKindMatch for Traefik kinds without their CRDs', async () => {
      const { kube } = setup({ traefikCrds: false });
      await apply(kube, namespace());
      const route = { apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name: 'web', namespace: NS }, spec: { routes: [] } };
      expect(await reason(apply(kube, route))).toBe('NoKindMatch');
      expect((await kube.run({ args: ['get', 'ingressroutes.traefik.io', '-o', 'json'], namespace: NS, mutating: false, allowFailure: true })).stderr).toContain(
        `the server doesn't have a resource type "ingressroutes"`,
      );
    });
  });

  describe('immutability', () => {
    it('rejects a changed Deployment selector and StatefulSet claim templates', async () => {
      const { kube } = setup();
      await apply(kube, namespace(), deployment('web', 'shop/web:1'), statefulSet('db', 'shop/db:1'));
      expect(await reason(apply(kube, deployment('web', 'shop/web:1', { selector: { app: 'web', tier: 'front' } })))).toBe('Immutable');
      expect(await reason(apply(kube, statefulSet('db', 'shop/db:1', '2Gi')))).toBe('Immutable');
    });

    it('rejects the re-apply of an unchanged Job: the omitted server-written selector is cleared (K43)', async () => {
      const { kube } = setup();
      await apply(kube, namespace(), job('migrate', 'shop/migrate:1'));
      const created = await get(kube, 'jobs.batch', 'migrate');
      expect((spec(created).selector as Obj).matchLabels).toEqual({ 'batch.kubernetes.io/controller-uid': created.metadata.uid });
      const labels = (((spec(created).template as Obj).metadata as Obj).labels ?? {}) as Record<string, string>;
      expect(labels['batch.kubernetes.io/job-name']).toBe('migrate');
      expect(await reason(apply(kube, job('migrate', 'shop/migrate:1')))).toBe('Immutable');
      expect((await get(kube, 'jobs.batch', 'migrate')).metadata.resourceVersion).toBe(created.metadata.resourceVersion);
    });

    it('rejects data changes of an immutable Secret, PVC spec changes, shrinking or unsupported expansion, and a changed cluster IP', async () => {
      const { cluster, kube } = setup();
      cluster.seed({
        apiVersion: 'storage.k8s.io/v1',
        kind: 'StorageClass',
        metadata: { name: 'expandable' },
        provisioner: 'rancher.io/local-path',
        reclaimPolicy: 'Retain',
        allowVolumeExpansion: true,
      });
      const secret = (value: string, labels: Record<string, string> = {}): object => ({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'web-env', namespace: NS, labels },
        immutable: true,
        data: { KEY: Buffer.from(value).toString('base64') },
      });
      const service = (clusterIP?: string): object => ({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'db', namespace: NS },
        spec: { ...(clusterIP ? { clusterIP } : {}), selector: { app: 'db' }, ports: [{ name: 'pg', port: 5432, protocol: 'TCP' }] },
      });
      await apply(kube, namespace(), secret('a'), service());
      expect(await reason(apply(kube, secret('b')))).toBe('Immutable');
      await apply(kube, secret('a', { tier: 'web' }));
      expect(await reason(apply(kube, service('None')))).toBe('Immutable');

      await apply(kube, claim('data'), claim('grow', { storageClassName: 'expandable' }), claim('idle'));
      await apply(kube, pod('user-a', 'shop/web:1', { claim: 'data' }), pod('user-b', 'shop/web:1', { claim: 'grow' }));
      cluster.tick();
      expect(status(await get(kube, 'persistentvolumeclaims', 'data')).phase).toBe('Bound');
      expect(await reason(apply(kube, claim('idle', { storage: '2Gi' })))).toBe('Immutable');
      expect(await reason(apply(kube, claim('data', { accessModes: ['ReadWriteOncePod'] })))).toBe('Immutable');
      expect(await reason(apply(kube, claim('data', { storage: '2Gi' })))).toBe('Forbidden');
      expect(await reason(apply(kube, claim('data', { storage: '512Mi' })))).toBe('Invalid');
      await apply(kube, claim('grow', { storageClassName: 'expandable', storage: '2Gi' }));
      expect(spec(await get(kube, 'persistentvolumeclaims', 'grow')).resources).toEqual({ requests: { storage: '2Gi' } });
    });
  });

  describe('seeding and inspection', () => {
    it('seeds objects, freezes recorded state on request, and serves shell scripts that are one kubectl command', async () => {
      const { cluster, kube } = setup();
      const [seeded] = cluster.seed(
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'recorded', namespace: 'fixture' },
          spec: { containers: [{ name: 'main', image: 'shop/web:1' }] },
          status: { phase: 'Failed', reason: 'Evicted' },
        },
        { reconcile: false },
      );
      expect(seeded.metadata.uid).toMatch(UID_RE);
      cluster.tick(3);
      expect(cluster.get('pods', 'recorded', 'fixture')?.status).toEqual({ phase: 'Failed', reason: 'Evicted' });
      expect(cluster.list('namespaces').map((object) => object.metadata.name)).toContain('fixture');
      const listed = await kube.shell({ script: kube.command(['get', 'pods', '-o', 'json'], 'fixture'), guardS: null });
      expect((JSON.parse(listed.stdout) as { items: KubeObject[] }).items.map((object) => object.metadata.name)).toEqual(['recorded']);
      await expect(kube.run({ args: ['get', 'pods'], namespace: 'fixture', mutating: false })).rejects.toThrow(/-o \(table\) is not served/);
      expect(cluster.problems).toHaveLength(1);
    });
  });
});
