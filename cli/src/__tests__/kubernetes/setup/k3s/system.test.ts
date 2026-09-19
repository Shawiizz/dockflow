import { afterEach, describe, expect, it } from 'bun:test';
import { applySystemObjects, assertSingleDefaultStorageClass, reconcileNodeLabels, systemManifest } from '../../../../commands/setup/k3s/system';
import { SetupStepError } from '../../../../commands/setup/k3s/host-runner';
import { ANNOTATIONS, K8S_STORAGE_CLASS } from '../../../../services/orchestrator/kubernetes/constants';
import { Redactor } from '../../../../utils/redact';
import { FakeCluster, type KubeObject } from '../../fakes/fake-cluster';
import { FakeKubeExecutor, fakeNode } from '../../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../../support/invariants';

const KEY = 'server_1';
const ENV = 'production';
const redactor = new Redactor(['not-a-real-secret-value']);
let kubes: FakeKubeExecutor[] = [];

function kubeFor(cluster: FakeCluster): FakeKubeExecutor {
  const executor = new FakeKubeExecutor({ node: fakeNode(KEY), cluster, redactor, order: 'any' });
  kubes.push(executor);
  return executor;
}

afterEach(() => {
  const kube = kubes;
  kubes = [];
  for (const executor of kube) executor.assertDone();
  assertExecutorInvariants({ kube, redactor });
});

describe('system objects (S1, 11.1)', () => {
  it('the namespace and the class manifest golden', () => {
    const manifest = systemManifest();
    expect(manifest.match(/^---$/gm)).toHaveLength(2);
    expect(manifest).toContain('kind: Namespace');
    expect(manifest).toContain('name: dockflow-system');
    expect(manifest).toContain('kind: StorageClass');
    expect(manifest).toContain('name: dockflow-local');
    expect(manifest).toContain('provisioner: rancher.io/local-path');
    expect(manifest).toContain('reclaimPolicy: Retain');
    expect(manifest).toContain('volumeBindingMode: WaitForFirstConsumer');
  });

  it('applies cleanly against a fresh cluster', async () => {
    const cluster = new FakeCluster({ storageClasses: false, systemNamespace: false });
    const kube = kubeFor(cluster);
    await applySystemObjects(kube, { env: ENV });
    expect(cluster.get('Namespace', 'dockflow-system')).toBeDefined();
    const sc = cluster.get('StorageClass', K8S_STORAGE_CLASS) as { reclaimPolicy?: string } | undefined;
    expect(sc?.reclaimPolicy).toBe('Retain');
  });

  it('S2 an existing dockflow-local with reclaimPolicy Delete is refused', async () => {
    const cluster = new FakeCluster({ storageClasses: false });
    cluster.seed({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: K8S_STORAGE_CLASS },
      provisioner: 'rancher.io/local-path',
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
    });
    const kube = kubeFor(cluster);
    let error: unknown;
    try {
      await applySystemObjects(kube, { env: ENV });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SetupStepError);
    expect((error as SetupStepError).message).toBe(`StorageClass ${K8S_STORAGE_CLASS} on ${ENV} has reclaimPolicy Delete, and Dockflow needs Retain`);
  });
});

describe('assertSingleDefaultStorageClass (S4, 11.2)', () => {
  it('only dockflow-local default: no mutating call beyond the list', async () => {
    const cluster = new FakeCluster();
    const kube = kubeFor(cluster);
    const result = await assertSingleDefaultStorageClass(kube, { env: ENV });
    expect(result.actions).toEqual([]);
    expect(result.defaults.map((d) => d.name)).toEqual([K8S_STORAGE_CLASS]);
  });

  it('local-path also default: patched non-default, actions = [patched-local-path]', async () => {
    const cluster = new FakeCluster();
    cluster.seed(
      { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'local-path', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'rancher.io/local-path' },
      { reconcile: true },
    );
    const kube = kubeFor(cluster);
    const result = await assertSingleDefaultStorageClass(kube, { env: ENV });
    expect(result.actions).toEqual(['patched-local-path']);
    const localPath = cluster.get('StorageClass', 'local-path') as { metadata?: { annotations?: Record<string, string> } } | undefined;
    expect(localPath?.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class']).toBe('false');
  });

  it('a foreign default class refuses and is never patched', async () => {
    const cluster = new FakeCluster();
    cluster.seed({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'fast-ssd', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
      provisioner: 'example.com/fast',
    });
    const kube = kubeFor(cluster);
    let error: unknown;
    try {
      await assertSingleDefaultStorageClass(kube, { env: ENV });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SetupStepError);
    expect((error as SetupStepError).message).toContain('fast-ssd');
    const fastSsd = cluster.get('StorageClass', 'fast-ssd') as { metadata?: { annotations?: Record<string, string> } } | undefined;
    expect(fastSsd?.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class']).toBe('true');
  });

  it('local-path newer than dockflow-local: recreated, actions = [recreated-dockflow-local]', async () => {
    const cluster = new FakeCluster();
    const dockflowLocal = cluster.get('StorageClass', K8S_STORAGE_CLASS) as KubeObject;
    const older = new Date(Date.parse(dockflowLocal.metadata.creationTimestamp ?? '2026-01-01T00:00:00Z') - 3600_000).toISOString();
    // rebuild the cluster so dockflow-local is provably older than the local-path we seed next
    cluster.seed({ ...dockflowLocal, metadata: { ...dockflowLocal.metadata, creationTimestamp: older } });
    const localPath = { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'local-path', annotations: { 'storageclass.kubernetes.io/is-default-class': 'false' } }, provisioner: 'rancher.io/local-path' };
    cluster.seed(localPath);
    const kube = kubeFor(cluster);
    const result = await assertSingleDefaultStorageClass(kube, { env: ENV });
    expect(result.actions).toEqual(['recreated-dockflow-local']);
    expect(result.defaults.map((d) => d.name)).toEqual([K8S_STORAGE_CLASS]);
  });

  it('S5 idempotent across two runs: zero mutating calls the second time', async () => {
    const cluster = new FakeCluster();
    cluster.seed(
      { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'local-path', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'rancher.io/local-path' },
      { reconcile: true },
    );
    const first = kubeFor(cluster);
    const before = await assertSingleDefaultStorageClass(first, { env: ENV });
    expect(before.actions).toEqual(['patched-local-path']);

    const second = kubeFor(cluster);
    const after = await assertSingleDefaultStorageClass(second, { env: ENV });
    expect(after.actions).toEqual([]);
  });
});

describe('reconcileNodeLabels (S3, section 8)', () => {
  it('a Node without the annotation gets the labels plus the annotation', async () => {
    const cluster = new FakeCluster({ nodes: ['server-1'] });
    const kube = kubeFor(cluster);
    const result = await reconcileNodeLabels(kube, 'server-1', { zone: 'eu-west' });
    expect(result).toBe('updated');
    const node = cluster.get('Node', 'server-1') as { metadata: { labels?: Record<string, string>; annotations?: Record<string, string> } };
    expect(node.metadata.labels?.zone).toBe('eu-west');
    expect(JSON.parse(node.metadata.annotations?.[ANNOTATIONS.nodeLabels] ?? '[]')).toEqual(['zone']);
  });

  it('a key dropped from servers.yml is removed with <k>- and the annotation rewritten', async () => {
    const cluster = new FakeCluster({ nodes: ['server-1'] });
    const kube = kubeFor(cluster);
    await reconcileNodeLabels(kube, 'server-1', { zone: 'eu-west', tier: 'gold' });
    const result = await reconcileNodeLabels(kube, 'server-1', { zone: 'eu-west' });
    expect(result).toBe('updated');
    const node = cluster.get('Node', 'server-1') as { metadata: { labels?: Record<string, string>; annotations?: Record<string, string> } };
    expect(node.metadata.labels?.tier).toBeUndefined();
    expect(node.metadata.labels?.zone).toBe('eu-west');
    expect(JSON.parse(node.metadata.annotations?.[ANNOTATIONS.nodeLabels] ?? '[]')).toEqual(['zone']);
  });

  it('a label Dockflow never applied is left untouched', async () => {
    const cluster = new FakeCluster({ nodes: ['server-1'] });
    cluster.seed({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'server-1', labels: { 'operator.example.com/owned': 'true' } } }, { reconcile: true });
    const kube = kubeFor(cluster);
    await reconcileNodeLabels(kube, 'server-1', { zone: 'eu-west' });
    const node = cluster.get('Node', 'server-1') as { metadata: { labels?: Record<string, string> } };
    expect(node.metadata.labels?.['operator.example.com/owned']).toBe('true');
  });

  it('unchanged run issues no call', async () => {
    const cluster = new FakeCluster({ nodes: ['server-1'] });
    const first = kubeFor(cluster);
    await reconcileNodeLabels(first, 'server-1', { zone: 'eu-west' });

    const second = kubeFor(cluster);
    const result = await reconcileNodeLabels(second, 'server-1', { zone: 'eu-west' });
    expect(result).toBe('unchanged');
  });
});
