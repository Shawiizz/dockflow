// design-03 5.1-5.9 (22.3 SD rows of the engine), DESIGN-CORE 8.4 (Immutable transitions), C11,
// design-02 7.4.1 and design-07 9.4 U-APPLY-01..10: the apply engine in cluster mode over
// FakeCluster. Pre-existing state is created through the engine itself, so every object carries
// the `dockflow` field manager exactly as after a real deploy.

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ApplyEngine,
  type ApplyOutcome,
  type ApplyRequest,
  assertPruneGuard,
  checkClaimTemplates,
  clusterIpFlips,
  compareQuantities,
  type ExecuteOptions,
  type PartialApply,
  partialApplyError,
  planLbWatch,
  samePorts,
} from '../../../services/orchestrator/kubernetes/apply/engine';
import { emptySnapshot, type LiveService, type Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import type { RevertResult, StackRef } from '../../../services/orchestrator/interfaces';
import { ANNOTATIONS, K8S_STORAGE_CLASS } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo, type SharedMemo } from '../../../services/orchestrator/kubernetes/deps';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import {
  hashedObjectLabels,
  podTemplateLabels,
  SEL_POD,
  SEL_ROLE,
  selectorLabels,
  serviceObjectLabels,
  volumeClaimLabels,
} from '../../../services/orchestrator/kubernetes/labels';
import type {
  DaemonSet,
  Deployment,
  PersistentVolumeClaimTemplate,
  StatefulSet,
} from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type {
  Container,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeClaimSpec,
  PodSpec,
  PodTemplateSpec,
  Secret,
  Service,
  ServiceSpec,
} from '../../../services/orchestrator/kubernetes/resources/core';
import type { ObjectMeta } from '../../../services/orchestrator/kubernetes/resources/meta';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { KubeError, kubeErrorToCliError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { namespaceObject } from '../../../services/orchestrator/kubernetes/translate/namespace';
import { emitManifests } from '../../../services/orchestrator/kubernetes/yaml';
import { CLIError, DeployError, ErrorCode } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster, type FakeClusterOptions, type KubeObject } from '../fakes/fake-cluster';
import { FakeKubeExecutor, type KubeStep, type RecordedKubeCall, REST } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const NS = 'dockflow-shop-production';
const ID = { project: 'shop', namespace: NS };
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const VERSION = '1.4.2';
const HEADER = { format: 'k8s-manifests/1' as const, stackName: 'shop-production', role: 'app' as const, version: VERSION };
const SNAPSHOT_GET = 'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch,services';

// ---------------------------------------------------------------------------
// Objects, shaped like the translator's output
// ---------------------------------------------------------------------------

interface PodOptions {
  image?: string;
  /** standalone claims mounted by the pod */
  claims?: readonly string[];
  hostPort?: number;
  hostNetwork?: boolean;
  grace?: number;
  envSecret?: string;
}

function podTemplate(service: string, options: PodOptions = {}, extra: { templates?: readonly string[]; job?: boolean } = {}): PodTemplateSpec {
  const claims = options.claims ?? [];
  const mounts = [...claims, ...(extra.templates ?? [])];
  const container: Container = { name: service, image: options.image ?? `registry.example.com/shop/${service}:1` };
  if (options.hostPort !== undefined) container.ports = [{ containerPort: options.hostPort, protocol: 'TCP', hostPort: options.hostPort }];
  if (mounts.length > 0) container.volumeMounts = mounts.map((name) => ({ name, mountPath: `/data/${name}` }));
  if (options.envSecret !== undefined) container.envFrom = [{ secretRef: { name: options.envSecret } }];
  const spec: PodSpec = { containers: [container], terminationGracePeriodSeconds: options.grace ?? 0 };
  if (extra.job) spec.restartPolicy = 'Never';
  if (options.hostNetwork) spec.hostNetwork = true;
  if (claims.length > 0) spec.volumes = claims.map((claim) => ({ name: claim, persistentVolumeClaim: { claimName: claim } }));
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

interface ClaimOptions {
  key?: string;
  storage?: string;
  storageClassName?: string;
  accessModes?: PersistentVolumeAccessMode[];
}

function claimSpec(options: ClaimOptions): PersistentVolumeClaimSpec {
  return {
    accessModes: options.accessModes ?? ['ReadWriteOnce'],
    resources: { requests: { storage: options.storage ?? '1Gi' } },
    storageClassName: options.storageClassName ?? K8S_STORAGE_CLASS,
  };
}

function claimTemplate(name: string, options: ClaimOptions = {}): PersistentVolumeClaimTemplate {
  return {
    metadata: { name, labels: volumeClaimLabels(ID, 'app', name), annotations: { [ANNOTATIONS.composeVolume]: options.key ?? name } },
    spec: claimSpec(options),
  };
}

function statefulSet(service: string, options: PodOptions & { claimTemplates?: PersistentVolumeClaimTemplate[] } = {}): StatefulSet {
  const templates = options.claimTemplates ?? [];
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta(service, service),
    spec: {
      replicas: 1,
      serviceName: `${service}-hl`,
      selector: { matchLabels: selectorLabels(ID, service) },
      template: podTemplate(service, options, { templates: templates.map((t) => t.metadata.name) }),
      ...(templates.length > 0 ? { volumeClaimTemplates: templates } : {}),
    },
  };
}

function daemonSet(service: string, options: PodOptions = {}): DaemonSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: meta(service, service),
    spec: { selector: { matchLabels: selectorLabels(ID, service) }, template: podTemplate(service, options) },
  };
}

function job(name: string, service: string, options: PodOptions = {}): Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: meta(name, service),
    spec: { backoffLimit: 0, completions: 1, parallelism: 1, template: podTemplate(service, options, { job: true }) },
  };
}

function service(name: string, owner: string, spec: ServiceSpec): Service {
  return { apiVersion: 'v1', kind: 'Service', metadata: meta(name, owner), spec: { selector: selectorLabels(ID, owner), ...spec } };
}

function pvc(name: string, options: ClaimOptions = {}): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name,
      namespace: NS,
      labels: volumeClaimLabels(ID, 'app', name),
      annotations: { [ANNOTATIONS.composeVolume]: options.key ?? name },
    },
    spec: claimSpec(options),
  };
}

function secret(name: string, owner: string, data: Record<string, string>): Secret {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { ...meta(name, owner), labels: hashedObjectLabels(ID, 'app', owner) }, immutable: true, data };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  clock: FakeClock;
  memo: SharedMemo;
  engine: ApplyEngine;
  steps: string[];
  warnings: string[];
  redactor: Redactor;
}

let current: Harness | null = null;

function harness(options: { script?: KubeStep[]; secrets?: string[]; cluster?: FakeClusterOptions } = {}): Harness {
  const redactor = new Redactor(options.secrets ?? []);
  const cluster = new FakeCluster(options.cluster);
  const kube = new FakeKubeExecutor({ redactor, cluster, ...(options.script ? { script: options.script } : {}) });
  const clock = new FakeClock();
  const memo = createSharedMemo();
  const steps: string[] = [];
  const warnings: string[] = [];
  const engine = new ApplyEngine({
    kubectl: kube,
    clock,
    distribution: k3sDistribution,
    memo,
    events: { step: (text) => steps.push(text), warn: (message) => warnings.push(message) },
  });
  current = { cluster, kube, clock, memo, engine, steps, warnings, redactor };
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
  return { ref: REF, version: VERSION, objects, mode: 'deploy', full: true, ...overrides };
}

async function deploy(h: Harness, objects: ManifestObject[], overrides: Partial<ApplyRequest> = {}, options: ExecuteOptions = {}): Promise<ApplyOutcome> {
  return h.engine.execute(await h.engine.prepare(request(objects, overrides)), options);
}

/** catalogue id of a recorded call (design-03 20) */
function callId(record: RecordedKubeCall): string {
  const args = record.call.args;
  const [verb, first] = args;
  if (verb === 'apply') return args.includes('--dry-run=server') ? 'K10' : record.call.namespace === undefined ? 'K02' : 'K11';
  if (verb === 'get' && args.includes('--show-managed-fields')) return 'K49';
  if (verb === 'get' && first === 'namespaces') return 'K01';
  if (verb === 'get' && first === SNAPSHOT_GET) return 'K07';
  if (verb === 'get' && first === 'controllerrevisions.apps') return 'K08';
  if (verb === 'get' && first === 'persistentvolumeclaims') return 'K09';
  if (verb === 'get' && first === 'storageclasses.storage.k8s.io') return 'K06';
  if (verb === 'get' && first === 'pods') return 'pods';
  if (verb === 'delete') return args.some((arg) => arg.startsWith('services/')) ? 'K20' : 'K19';
  if (verb === 'wait') return 'K38';
  return args.join(' ');
}

function since(h: Harness, mark: number): RecordedKubeCall[] {
  return h.kube.calls.slice(mark);
}

function ids(calls: readonly RecordedKubeCall[]): string[] {
  return calls.map(callId);
}

function mutations(calls: readonly RecordedKubeCall[]): string[] {
  return calls.filter((call) => call.call.mutating).map(callId);
}

function stdinOf(calls: readonly RecordedKubeCall[], id: string): string[] {
  return calls.filter((call) => callId(call) === id).map((call) => call.stdinText);
}

async function refusal(promise: Promise<unknown>): Promise<DeployError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeployError) return error;
    throw error;
  }
  throw new Error('expected a DeployError');
}

async function kubeFailure(promise: Promise<unknown>): Promise<KubeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KubeError) return error;
    throw error;
  }
  throw new Error('expected a KubeError');
}

function live(h: Harness, resource: string, name: string): KubeObject | undefined {
  return h.cluster.get(resource, name, NS);
}

function jobState(h: Harness, name: string): string | null {
  const conditions = ((live(h, 'jobs.batch', name)?.status as { conditions?: { type: string; status: string }[] } | undefined)?.conditions ?? []);
  return conditions.find((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True')?.type ?? null;
}

// ---------------------------------------------------------------------------

describe('ApplyEngine', () => {
  describe('namespace (design-03 5.2)', () => {
    it('creates the namespace with its Namespace object before the artifact, then dry-runs and applies the same stdin (U-APPLY-01, U-APPLY-03, SD1)', async () => {
      const h = harness();
      const objects = [deployment('web'), deployment('api')];
      const outcome = await deploy(h, objects);
      const calls = since(h, 0);
      expect(ids(calls)).toEqual(['K01', 'K02', 'K07', 'K49', 'K10', 'K11', 'K07']);
      const [k02] = calls.filter((call) => callId(call) === 'K02');
      expect(k02.fieldManager).toBe('dockflow');
      expect(k02.stdinText).toBe(
        [
          'apiVersion: v1',
          'kind: Namespace',
          'metadata:',
          '  name: dockflow-shop-production',
          '  annotations:',
          '    dockflow.shawiizz.dev/stack-name: shop-production',
          '  labels:',
          '    app.kubernetes.io/instance: dockflow-shop-production',
          '    app.kubernetes.io/managed-by: dockflow',
          '    app.kubernetes.io/part-of: shop',
          '    dockflow.shawiizz.dev/stack: dockflow-shop-production',
          '',
        ].join('\n'),
      );
      expect(parseYaml(k02.stdinText)).toEqual(namespaceObject(REF));
      const emitted = emitManifests(objects, HEADER);
      expect(stdinOf(calls, 'K10')).toEqual([emitted]);
      expect(stdinOf(calls, 'K11')).toEqual([emitted]);
      expect(calls.find((call) => callId(call) === 'K11')?.call.namespace).toBe(NS);
      expect(outcome.changes.map((c) => `${c.kind}/${c.name} created=${c.created} generation=${c.generation}`)).toEqual([
        'Deployment/api created=true generation=1',
        'Deployment/web created=true generation=1',
      ]);
      expect(outcome.changes.every((c) => c.previousRevision === null && c.previousReplicas === null)).toBe(true);
      expect(live(h, 'namespaces', NS)?.metadata.annotations?.[ANNOTATIONS.stackName]).toBe('shop-production');
    });

    it('ensures a namespace once per bundle and adopts one this stack owns without writing it', async () => {
      const h = harness();
      await h.engine.ensureNamespace(REF);
      const accessories: StackRef = { ...REF, role: 'accessory' };
      await h.engine.ensureNamespace(accessories);
      expect(ids(since(h, 0))).toEqual(['K01', 'K02']);
      // another bundle: the namespace is found and adopted, never re-applied
      const other = new ApplyEngine({ kubectl: h.kube, clock: h.clock, distribution: k3sDistribution, memo: createSharedMemo() });
      const mark = h.kube.calls.length;
      await other.ensureNamespace(REF);
      expect(await other.assertNamespaceOwner(REF)).toBe('owned');
      expect(ids(since(h, mark))).toEqual(['K01', 'K01']);
    });

    it('reports a missing namespace from the read-only guard without creating it', async () => {
      const h = harness();
      expect(await h.engine.assertNamespaceOwner(REF)).toBe('missing');
      expect(mutations(since(h, 0))).toEqual([]);
    });

    it('refuses a namespace nobody owns, before any mutating call (U-APPLY-02)', async () => {
      const h = harness();
      h.cluster.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } });
      const error = await refusal(h.engine.prepare(request([deployment('web')])));
      expect(error.message).toBe('Namespace dockflow-shop-production exists and belongs to no Dockflow stack; rename project_name or env');
      expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(ids(since(h, 0))).toEqual(['K01']);
    });

    it('refuses a namespace another Dockflow stack owns, and forgets the failed ensure (SD2)', async () => {
      const h = harness();
      h.cluster.seed({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: NS, labels: { 'app.kubernetes.io/managed-by': 'dockflow' }, annotations: { [ANNOTATIONS.stackName]: 'other-production' } },
      });
      const error = await refusal(h.engine.ensureNamespace(REF));
      expect(error.message).toBe('Namespace dockflow-shop-production exists and belongs to other-production; rename project_name or env');
      await refusal(h.engine.ensureNamespace(REF));
      expect(ids(since(h, 0))).toEqual(['K01', 'K01']);
      expect(mutations(since(h, 0))).toEqual([]);
    });

    it('refuses a namespace that is being deleted (SD3)', async () => {
      const h = harness({
        script: [
          {
            id: 'K01',
            args: ['get', 'namespaces', NS, '-o', 'json'],
            respond: { json: { ...namespaceObject(REF), metadata: { ...namespaceObject(REF).metadata, deletionTimestamp: '2026-01-01T00:00:00Z' } } },
          },
        ],
      });
      const error = await refusal(h.engine.ensureNamespace(REF));
      expect(error.message).toBe('Namespace dockflow-shop-production is being deleted');
      expect(error.suggestion).toBe('Wait until it is gone, then run `dockflow deploy production` again.');
      expect(mutations(since(h, 0))).toEqual([]);
    });
  });

  describe('snapshots and change detection (design-03 2.4, 5.6)', () => {
    it('reads the role in one get and ControllerRevisions only when a StatefulSet or DaemonSet needs them (R5)', async () => {
      const h = harness();
      await deploy(h, [deployment('web')]);
      h.cluster.tick(3);
      let mark = h.kube.calls.length;
      const plain = await h.engine.snapshot(NS, 'app');
      const [k07] = since(h, mark);
      expect(ids(since(h, mark))).toEqual(['K07']);
      expect(k07.call.args).toEqual(['get', SNAPSHOT_GET, '-l', SEL_ROLE(NS, 'app'), '-o', 'json']);
      expect(plain.takenAt).toEqual(h.clock.now());
      expect(plain.workloads.map((w) => `${w.kind}/${w.name}`)).toEqual(['Deployment/web']);

      await deploy(h, [deployment('web'), statefulSet('db')]);
      h.cluster.tick(3);
      mark = h.kube.calls.length;
      const withRevisions = await h.engine.snapshot(NS, 'app');
      expect(ids(since(h, mark))).toEqual(['K07', 'K08']);
      expect(since(h, mark)[1].call.args).toEqual(['get', 'controllerrevisions.apps', '-l', SEL_POD(NS, 'app'), '-o', 'json']);
      const db = withRevisions.workloads.find((w) => w.name === 'db');
      expect(db?.revision).not.toBeNull();
      expect(db?.revisionNumber).toBe(1);
    });

    it('reports created workloads and generation bumps only, with the previous revision and replicas (U-APPLY-05, SD4)', async () => {
      const h = harness();
      await deploy(h, [deployment('web'), deployment('api')]);
      h.cluster.tick(3);
      const changed = await deploy(h, [deployment('web', { image: 'registry.example.com/shop/web:2' }), deployment('api'), deployment('worker')]);
      expect(changed.changes).toEqual([
        {
          service: 'web',
          kind: 'Deployment',
          name: 'web',
          created: false,
          previousRevision: '1',
          previousRevisionNumber: 1,
          previousReplicas: 1,
          generation: 2,
        },
        {
          service: 'worker',
          kind: 'Deployment',
          name: 'worker',
          created: true,
          previousRevision: null,
          previousRevisionNumber: null,
          previousReplicas: null,
          generation: 1,
        },
      ]);
      h.cluster.tick(3);
      const unchanged = await deploy(h, [deployment('web', { image: 'registry.example.com/shop/web:2' }), deployment('api'), deployment('worker')]);
      expect(unchanged.changes).toEqual([]);
      expect(unchanged.disruptive).toEqual([]);
    });
  });

  describe('pre-apply refusals, each before any mutating call (design-03 5.4)', () => {
    it('refuses a full deploy without workloads while workloads run (C11, SD11, U-PRUNE-07)', async () => {
      const h = harness();
      await deploy(h, [deployment('web'), deployment('api'), deployment('worker')]);
      const mark = h.kube.calls.length;
      const error = await refusal(h.engine.prepare(request([])));
      expect(error.message).toBe('Refusing to prune: the rendered stack has no services but 3 workloads run in dockflow-shop-production');
      expect(error.suggestion).toBe('Remove them with `dockflow stop production`, then deploy again.');
      expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(ids(since(h, mark))).toEqual(['K07']);
      // --only never prunes, so the guard does not apply
      const only = await h.engine.prepare(request([], { full: false }));
      expect(only.toApply).toEqual([]);
    });

    it('refuses a kind switch that would strand a mounted claim (K15, SD31)', async () => {
      const h = harness();
      await deploy(h, [pvc('pgdata'), deployment('db', { claims: ['pgdata'] })]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const error = await refusal(h.engine.prepare(request([pvc('pgdata'), statefulSet('db')])));
      expect(error.message).toBe(
        'Service db changes from Deployment to StatefulSet and would stop using volume pgdata, whose data is kept but no longer mounted',
      );
      expect(ids(since(h, mark))).toEqual(['K07']);
      expect(live(h, 'deployments.apps', 'db')).toBeDefined();
    });

    it('refuses to switch away from a Job that is still running (K15, SD30)', async () => {
      const h = harness();
      h.cluster.behave('registry.example.com/shop/seed:1', { kind: 'never-ready' });
      await deploy(h, [job('seed-3f9a1c2e', 'seed')]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const error = await refusal(h.engine.prepare(request([deployment('seed')])));
      expect(error.message).toBe('Service seed changes from Job to Deployment while its job is still running');
      expect(error.suggestion).toBe('Wait for it to finish (`dockflow ps production`), then deploy again.');
      expect(mutations(since(h, mark))).toEqual([]);
    });

    it('refuses a changed claim template of a live StatefulSet with the core K29 message (SD33)', async () => {
      const h = harness();
      await deploy(h, [statefulSet('queue', { claimTemplates: [claimTemplate('queue-data', { key: 'queue_data' })] })]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const error = await refusal(
        h.engine.prepare(request([statefulSet('queue', { claimTemplates: [claimTemplate('queue-data', { key: 'queue_data', storage: '5Gi' })] })])),
      );
      expect(error.message).toBe('Volume queue_data cannot change size, storage class or access mode after creation; its data is kept');
      expect(error.suggestion).toBe(
        'Create a new volume and copy the data, or remove this one with `dockflow volumes rm production queue-data-queue-<ordinal>` after taking a backup.',
      );
      expect(ids(since(h, mark))).toEqual(['K07', 'K08']);
    });

    it('refuses a claim-shape change naming both claims, and proceeds with --rebind-volumes (K14, SD32)', async () => {
      const h = harness();
      await deploy(h, [pvc('pgdata'), deployment('db', { claims: ['pgdata'] })]);
      h.cluster.tick(3);
      const perReplica = [statefulSet('db', { claimTemplates: [claimTemplate('pgdata')] })];
      let mark = h.kube.calls.length;
      const error = await refusal(h.engine.prepare(request(perReplica)));
      expect(error.message).toBe(
        'Volume pgdata would move from the claim pgdata to the new per-replica claims pgdata-db-<ordinal>, which start empty; pgdata and its data are kept',
      );
      expect(error.suggestion).toContain('`dockflow deploy production --rebind-volumes`');
      expect(ids(since(h, mark))).toEqual(['K07', 'K09']);

      mark = h.kube.calls.length;
      const outcome = await deploy(h, perReplica, { rebindVolumes: true });
      expect(h.warnings).toEqual(['Volume pgdata now uses pgdata-db-<ordinal>; pgdata is kept and listed by dockflow volumes list']);
      expect(mutations(since(h, mark))).toEqual(['K10', 'K19', 'K11']);
      expect(ids(since(h, mark)).slice(-5)).toEqual(['K19', 'K38', 'K11', 'K07', 'K08']);
      expect(outcome.changes.map((c) => `${c.kind}/${c.name} created=${c.created}`)).toEqual(['StatefulSet/db created=true']);
      // nothing about the rebind deletes data
      expect(live(h, 'persistentvolumeclaims', 'pgdata')).toBeDefined();
    });

    it('refuses a standalone claim that would shrink (SD12)', async () => {
      const h = harness();
      await deploy(h, [pvc('jobs-data', { key: 'jobs_data', storage: '10Gi' })]);
      const mark = h.kube.calls.length;
      const error = await refusal(h.engine.prepare(request([pvc('jobs-data', { key: 'jobs_data', storage: '5Gi' })])));
      expect(error.message).toBe('Volume jobs_data (persistentvolumeclaim/jobs-data) cannot shrink from 10Gi to 5Gi');
      expect(error.suggestion).toBe('Set x-dockflow.size back to 10Gi.');
      expect(ids(since(h, mark))).toEqual(['K07', 'K09']);
    });

    it('refuses growth on a class without volume expansion (SD13)', async () => {
      const h = harness();
      await deploy(h, [pvc('jobs-data', { key: 'jobs_data', storage: '1Gi' })]);
      const mark = h.kube.calls.length;
      const error = await refusal(h.engine.prepare(request([pvc('jobs-data', { key: 'jobs_data', storage: '5Gi' })])));
      expect(error.message).toBe(
        'Volume jobs_data (persistentvolumeclaim/jobs-data) cannot grow from 1Gi to 5Gi: storage class dockflow-local does not allow volume expansion',
      );
      expect(error.suggestion).toBe('Set x-dockflow.size back to 1Gi.');
      expect(mutations(since(h, mark))).toEqual([]);
    });

    it('refuses a storage class change and an access-mode change (SD14)', async () => {
      const h = harness();
      h.cluster.seed({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'fast-ssd' }, provisioner: 'example.com/ssd' });
      await deploy(h, [pvc('jobs-data', { key: 'jobs_data' })]);
      const mark = h.kube.calls.length;
      const moved = await refusal(h.engine.prepare(request([pvc('jobs-data', { key: 'jobs_data', storageClassName: 'fast-ssd' })])));
      expect(moved.message).toBe('Volume jobs_data (persistentvolumeclaim/jobs-data) cannot change storage class from dockflow-local to fast-ssd');
      expect(moved.suggestion).toBe('Keep the previous x-dockflow.storage_class, or declare a new volume key and migrate the data.');
      const remoded = await refusal(h.engine.prepare(request([pvc('jobs-data', { key: 'jobs_data', accessModes: ['ReadWriteOncePod'] })])));
      expect(remoded.message).toBe('Volume jobs_data (persistentvolumeclaim/jobs-data) cannot change access mode from ReadWriteOnce to ReadWriteOncePod');
      expect(remoded.suggestion).toBe('Keep the previous x-dockflow.access_mode, or declare a new volume key and migrate the data.');
      expect(mutations(since(h, mark))).toEqual([]);
      // the storage classes are read once per bundle
      expect(ids(since(h, 0)).filter((id) => id === 'K06')).toHaveLength(2);
    });

    it('refuses a claim on a storage class the cluster does not have', async () => {
      const h = harness();
      const error = await refusal(h.engine.prepare(request([pvc('uploads', { storageClassName: 'nope' })])));
      expect(error.message).toBe('StorageClass nope does not exist on the cluster (used by volumes.uploads)');
      expect(error.suggestion).toBe('Set `x-dockflow.storage_class` to an existing class, or re-run `dockflow setup k3s production`.');
      expect(mutations(since(h, 0))).toEqual(['K02']);
    });

    it('refuses an object another manager owns in the stack namespace (K74, SD34)', async () => {
      const h = harness({
        script: [
          {
            id: 'K49',
            args: ['get', 'services/web', 'deployments.apps/web', '--ignore-not-found', '--show-managed-fields', '-o', 'json'],
            namespace: NS,
            mutating: false,
            respond: {
              json: {
                apiVersion: 'v1',
                kind: 'List',
                items: [
                  {
                    apiVersion: 'v1',
                    kind: 'Service',
                    metadata: {
                      name: 'web',
                      namespace: NS,
                      labels: { 'app.kubernetes.io/managed-by': 'Helm' },
                      managedFields: [{ manager: 'helm', operation: 'Update' }],
                    },
                    spec: { ports: [{ port: 80, protocol: 'TCP' }] },
                  },
                ],
              },
            },
          },
        ],
      });
      const error = await refusal(
        h.engine.prepare(request([service('web', 'web', { ports: [{ name: 'http', port: 80, protocol: 'TCP' }] }), deployment('web')])),
      );
      expect(error.message).toBe('Service web in namespace dockflow-shop-production is owned by helm and would be taken over by service web');
      expect(error.suggestion).toBe('Rename the service, or move the Helm release that creates it to its own namespace with `helm.releases[].namespace`.');
      expect(ids(since(h, 0))).toEqual(['K01', 'K02', 'K07', 'K49']);
    });
  });

  describe('volumes (design-03 5.4.2)', () => {
    it('lets a claim grow on a class that allows expansion (I-28)', async () => {
      const h = harness();
      h.cluster.seed({
        apiVersion: 'storage.k8s.io/v1',
        kind: 'StorageClass',
        metadata: { name: 'expandable' },
        provisioner: 'rancher.io/local-path',
        reclaimPolicy: 'Retain',
        volumeBindingMode: 'WaitForFirstConsumer',
        allowVolumeExpansion: true,
      });
      await deploy(h, [pvc('data', { storageClassName: 'expandable' }), deployment('db', { claims: ['data'] })]);
      h.cluster.tick(3);
      await deploy(h, [pvc('data', { storageClassName: 'expandable', storage: '2Gi' }), deployment('db', { claims: ['data'] })]);
      expect((live(h, 'persistentvolumeclaims', 'data')?.spec as PersistentVolumeClaimSpec).resources.requests.storage).toBe('2Gi');
    });

    it('never re-applies an existing claim in restore mode, and restores a missing one', async () => {
      const h = harness();
      await deploy(h, [pvc('data', { storage: '10Gi' }), deployment('db', { claims: ['data'] })]);
      h.cluster.tick(3);
      const older = [pvc('data', { storage: '5Gi' }), pvc('cache'), deployment('db', { claims: ['data', 'cache'] })];
      const prepared = await h.engine.prepare(request(older, { mode: 'restore', full: false }));
      expect(prepared.toApply.map((o) => `${o.kind}/${o.metadata.name}`)).toEqual(['PersistentVolumeClaim/cache', 'Deployment/db']);
      await h.engine.execute(prepared);
      expect((live(h, 'persistentvolumeclaims', 'data')?.spec as PersistentVolumeClaimSpec).resources.requests.storage).toBe('10Gi');
      expect(live(h, 'persistentvolumeclaims', 'cache')).toBeDefined();
    });
  });

  describe('kind switches (design-03 5.4.3, K15)', () => {
    it('deletes the Deployment and proves its pods gone before the StatefulSet mounts the same RWO claim (SD15, U-APPLY-07)', async () => {
      const h = harness();
      await deploy(h, [pvc('pgdata'), deployment('db', { claims: ['pgdata'] })]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const outcome = await deploy(h, [pvc('pgdata'), statefulSet('db', { claims: ['pgdata'] })]);
      const calls = since(h, mark);
      // the storage class was read by the first deploy of this bundle (K06 memo)
      expect(ids(calls)).toEqual(['K07', 'K09', 'K49', 'K10', 'K19', 'K38', 'K11', 'K07', 'K08']);
      const [k19, k38] = calls.slice(4, 6);
      expect(k19.call.args).toEqual(['delete', 'deployments.apps/db', '--ignore-not-found', '--cascade=foreground', '--wait=true', '--timeout=120s']);
      expect(k19.call.guardS).toBe(150);
      expect(k38.call.args).toEqual(['wait', '--for=delete', 'pods', '-l', SEL_POD(NS, 'app', ['db']), '--timeout=120s']);
      expect(k38.call.mutating).toBe(false);
      expect(k38.call.guardS).toBe(150);
      expect(outcome.changes.map((c) => `${c.kind}/${c.name} created=${c.created}`)).toEqual(['StatefulSet/db created=true']);
      expect(outcome.disruptive).toEqual([{ service: 'db', from: 'Deployment', to: 'StatefulSet', deleted: { kind: 'Deployment', name: 'db' } }]);
      expect(h.steps).toEqual(['Replacing Deployment/db with StatefulSet/db for service db; its pods restart']);
      expect(live(h, 'deployments.apps', 'db')).toBeUndefined();
    });

    it('replaces a Deployment holding a host port with a DaemonSet, waiting the derived delete budget (SD23, U-APPLY-10)', async () => {
      const h = harness();
      await deploy(h, [deployment('edge', { hostPort: 8080, grace: 300 })]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      await deploy(h, [daemonSet('edge', { hostPort: 8080 })]);
      const calls = since(h, mark);
      const k19 = calls.find((call) => callId(call) === 'K19');
      const k38 = calls.find((call) => callId(call) === 'K38');
      expect(k19?.call.args).toContain('--timeout=330s');
      expect(k19?.call.guardS).toBe(360);
      expect(k38?.call.args).toContain('--timeout=330s');
      expect(k38?.call.guardS).toBe(360);
      expect(mutations(calls)).toEqual(['K10', 'K19', 'K11']);
      expect(live(h, 'daemonsets.apps', 'edge')).toBeDefined();
    });

    it('replaces a Deployment with a hostNetwork DaemonSet delete-first (SD24)', async () => {
      const h = harness();
      await deploy(h, [deployment('probe')]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      await deploy(h, [daemonSet('probe', { hostNetwork: true })]);
      expect(mutations(since(h, mark))).toEqual(['K10', 'K19', 'K11']);
      expect(h.steps).toEqual(['Replacing Deployment/probe with DaemonSet/probe for service probe; its pods restart']);
    });

    it('switches between a Deployment and a Job delete-first in both directions (SD26)', async () => {
      const h = harness();
      await deploy(h, [deployment('seed')]);
      h.cluster.tick(3);
      let mark = h.kube.calls.length;
      const toJob = await deploy(h, [job('seed-3f9a1c2e', 'seed')]);
      expect(mutations(since(h, mark))).toEqual(['K10', 'K19', 'K11']);
      expect(toJob.changes.map((c) => `${c.kind}/${c.name} created=${c.created}`)).toEqual(['Job/seed-3f9a1c2e created=true']);
      h.cluster.tick(5);
      expect(jobState(h, 'seed-3f9a1c2e')).toBe('Complete');
      mark = h.kube.calls.length;
      const back = await deploy(h, [deployment('seed')]);
      expect(since(h, mark).find((call) => callId(call) === 'K19')?.call.args[1]).toBe('jobs.batch/seed-3f9a1c2e');
      expect(back.disruptive).toEqual([{ service: 'seed', from: 'Job', to: 'Deployment', deleted: { kind: 'Job', name: 'seed-3f9a1c2e' } }]);
    });

    it('overlaps a stateless switch: nothing deleted, both workloads live until finalize prunes (SD25, U-APPLY-08)', async () => {
      const h = harness();
      await deploy(h, [deployment('api')]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const outcome = await deploy(h, [daemonSet('api')]);
      expect(mutations(since(h, mark))).toEqual(['K10', 'K11']);
      expect(outcome.disruptive).toEqual([]);
      expect(h.steps).toEqual([]);
      expect(live(h, 'deployments.apps', 'api')).toBeDefined();
      expect(live(h, 'daemonsets.apps', 'api')).toBeDefined();
    });

    it('stops before the apply when the old pods do not terminate in time', async () => {
      const h = harness({
        script: [
          {
            id: 'K19',
            args: ['delete', 'deployments.apps/db', REST],
            respond: { error: 'Timeout', stderr: 'error: timed out waiting for the condition on deployments/db' },
          },
        ],
      });
      await deploy(h, [pvc('pgdata'), deployment('db', { claims: ['pgdata'] })]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const error = await refusal(deploy(h, [pvc('pgdata'), statefulSet('db', { claims: ['pgdata'] })]));
      expect(error.message).toBe('Replacing Deployment db timed out after 120s: 1 pod(s) still terminating');
      expect(error.suggestion).toBe('Run `dockflow diagnose production`.');
      expect(ids(since(h, mark)).slice(-2)).toEqual(['K19', 'pods']);
      expect(live(h, 'statefulsets.apps', 'db')).toBeUndefined();
    });
  });

  describe('Jobs (design-03 5.4.4, K43)', () => {
    it('never re-applies an existing Job and does not wait on it (SD27, U-APPLY-09)', async () => {
      const h = harness();
      await deploy(h, [job('migrate-3f9a1c2e', 'migrate')]);
      h.cluster.tick(5);
      expect(jobState(h, 'migrate-3f9a1c2e')).toBe('Complete');
      const mark = h.kube.calls.length;
      const outcome = await deploy(h, [job('migrate-3f9a1c2e', 'migrate'), deployment('web')]);
      const calls = since(h, mark);
      for (const text of [...stdinOf(calls, 'K10'), ...stdinOf(calls, 'K11')]) expect(text).not.toContain('kind: Job');
      expect(outcome.applied.map((o) => o.kind)).toEqual(['Deployment']);
      expect(outcome.changes.map((c) => c.kind)).toEqual(['Deployment']);
      expect(h.warnings).toEqual([]);
    });

    it('deletes a failed Job and runs it again under the same name (SD28)', async () => {
      const h = harness();
      h.cluster.behave('registry.example.com/shop/migrate:1', { kind: 'crashloop', exitCode: 1 });
      await deploy(h, [job('migrate-3f9a1c2e', 'migrate')]);
      h.cluster.tick(5);
      expect(jobState(h, 'migrate-3f9a1c2e')).toBe('Failed');
      const mark = h.kube.calls.length;
      const outcome = await deploy(h, [job('migrate-3f9a1c2e', 'migrate'), deployment('web')]);
      const calls = since(h, mark);
      expect(mutations(calls)).toEqual(['K10', 'K19', 'K11']);
      expect(calls.find((call) => callId(call) === 'K19')?.call.args[1]).toBe('jobs.batch/migrate-3f9a1c2e');
      // dry-running the Job over its live namesake would fail on the generated selector
      expect(stdinOf(calls, 'K10')).toEqual([emitManifests([deployment('web')], HEADER)]);
      expect(stdinOf(calls, 'K11')).toEqual([emitManifests([job('migrate-3f9a1c2e', 'migrate'), deployment('web')], HEADER)]);
      expect(outcome.changes.map((c) => `${c.kind}/${c.name} created=${c.created}`)).toEqual([
        'Job/migrate-3f9a1c2e created=true',
        'Deployment/web created=true',
      ]);
      expect(outcome.disruptive).toEqual([{ service: 'migrate', from: null, to: 'Job', deleted: { kind: 'Job', name: 'migrate-3f9a1c2e' } }]);
      expect(h.steps).toEqual(['Job migrate failed in a previous deploy and is run again']);
      expect(calls.find((call) => callId(call) === 'K38')?.call.args).toEqual(['wait', '--for=delete', 'pods', '-l', 'batch.kubernetes.io/job-name in (migrate-3f9a1c2e)', '--timeout=120s']);
    });

    it('re-runs a failed Job while an earlier finished Job of the service keeps its pod', async () => {
      const h = harness();
      await deploy(h, [job('migrate-00000000', 'migrate')]);
      h.cluster.tick(5);
      expect(jobState(h, 'migrate-00000000')).toBe('Complete');
      h.cluster.behave('registry.example.com/shop/migrate:1', { kind: 'crashloop', exitCode: 1 });
      await deploy(h, [job('migrate-3f9a1c2e', 'migrate')]);
      h.cluster.tick(5);
      expect(jobState(h, 'migrate-3f9a1c2e')).toBe('Failed');

      const outcome = await deploy(h, [job('migrate-3f9a1c2e', 'migrate')]);

      expect(outcome.changes.map((c) => `${c.kind}/${c.name} created=${c.created}`)).toEqual(['Job/migrate-3f9a1c2e created=true']);
      expect(jobState(h, 'migrate-00000000')).toBe('Complete');
    });

    it('leaves a still-active Job alone, with a warning (SD29)', async () => {
      const h = harness();
      h.cluster.behave('registry.example.com/shop/migrate:1', { kind: 'never-ready' });
      await deploy(h, [job('migrate-3f9a1c2e', 'migrate')]);
      h.cluster.tick(3);
      const mark = h.kube.calls.length;
      const outcome = await deploy(h, [job('migrate-3f9a1c2e', 'migrate'), deployment('web')]);
      expect(stdinOf(since(h, mark), 'K11')[0]).not.toContain('kind: Job');
      expect(outcome.changes.map((c) => c.kind)).toEqual(['Deployment']);
      expect(h.warnings).toEqual(['Job migrate from an earlier deploy is still running; this deploy does not wait for it']);
    });
  });

  describe('server dry-run and apply (design-03 5.5)', () => {
    it('leaves the cluster untouched when the dry-run is rejected (U-APPLY-04, SD5)', async () => {
      const h = harness();
      await h.engine.ensureNamespace(REF);
      h.cluster.rejectOn({ verb: 'apply', kind: 'Deployment', name: 'web' }, 'Invalid');
      const mark = h.kube.calls.length;
      const error = await kubeFailure(h.engine.prepare(request([service('web', 'web', { ports: [{ name: 'http', port: 80, protocol: 'TCP' }] }), deployment('web')])));
      expect(error.reason).toBe('Invalid');
      const mapped = kubeErrorToCliError(error, { env: 'production', operation: 'deploy', mutating: true, distribution: 'k3s' });
      expect(mapped.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(mapped.message).toStartWith('Kubernetes rejected Deployment web: ');
      expect(ids(since(h, mark))).toEqual(['K07', 'K49', 'K10']);
      expect(live(h, 'deployments.apps', 'web')).toBeUndefined();
      expect(live(h, 'services', 'web')).toBeUndefined();
    });

    it('re-creates a Service whose clusterIP shape flips, found by the dry-run (core K29)', async () => {
      const h = harness();
      await deploy(h, [service('db', 'db', { ports: [{ name: 'pg', port: 5432, protocol: 'TCP' }] }), deployment('db')]);
      h.cluster.tick(2);
      expect((live(h, 'services', 'db')?.spec as ServiceSpec).clusterIP).not.toBe('None');
      const headless = service('db', 'db', { clusterIP: 'None', ports: [{ name: 'placeholder', port: 9, protocol: 'TCP' }] });
      const mark = h.kube.calls.length;
      const prepared = await h.engine.prepare(request([headless, deployment('db')]));
      expect(prepared.recreate).toEqual(['db']);
      expect(ids(since(h, mark))).toEqual(['K07', 'K49', 'K10', 'K10']);
      // the second dry-run validates everything else
      expect(since(h, mark)[3].stdinText).toBe(emitManifests([deployment('db')], HEADER));
      expect(h.kube.calls.length - mark).toBe(4);
      await h.engine.execute(prepared);
      const calls = since(h, mark);
      expect(ids(calls).slice(4)).toEqual(['K20', 'K11', 'K07']);
      expect(calls[4].call.args).toEqual(['delete', 'services/db', '--ignore-not-found', '--wait=true', '--timeout=120s']);
      expect(stdinOf(calls, 'K11')).toEqual([emitManifests([headless, deployment('db')], HEADER)]);
      expect((live(h, 'services', 'db')?.spec as ServiceSpec).clusterIP).toBe('None');
      expect(h.steps).toEqual(['Service db changed its addressing mode and was re-created']);
    });

    it('re-creates the Service and retries once when the apply itself meets the flip', async () => {
      const h = harness();
      await deploy(h, [service('db', 'db', { ports: [{ name: 'pg', port: 5432, protocol: 'TCP' }] })]);
      const mark = h.kube.calls.length;
      const headless = service('db', 'db', { clusterIP: 'None', ports: [{ name: 'placeholder', port: 9, protocol: 'TCP' }] });
      await h.engine.apply(NS, [headless]);
      expect(ids(since(h, mark))).toEqual(['K11', 'K20', 'K11']);
      expect((live(h, 'services', 'db')?.spec as ServiceSpec).clusterIP).toBe('None');
      expect(h.steps).toEqual(['Service db changed its addressing mode and was re-created']);
    });

    it('sends Secret values on stdin only (SD22)', async () => {
      const value = 's3cr3t-value';
      const h = harness({ secrets: [value] });
      const env = secret('web-env-3f9a1c2e', 'web', { DB_PASSWORD: Buffer.from(value).toString('base64') });
      await deploy(h, [env, deployment('web', { envSecret: 'web-env-3f9a1c2e' })]);
      const calls = since(h, 0);
      expect(stdinOf(calls, 'K11')[0]).toContain(Buffer.from(value).toString('base64'));
      for (const call of calls) expect(`${call.commandString} ${call.call.args.join(' ')}`).not.toContain(value);
      // afterEach: INV-02 over every argv and command string
    });

    it('sends only the selected closure under --only and never runs the prune guard (U-APPLY-06, SD9)', async () => {
      const h = harness();
      await deploy(h, [deployment('web'), deployment('worker')]);
      const mark = h.kube.calls.length;
      const web = [deployment('web', { image: 'registry.example.com/shop/web:2' })];
      const outcome = await deploy(h, [...web, deployment('worker', { image: 'registry.example.com/shop/worker:2' })], { applied: web, full: false });
      expect(stdinOf(since(h, mark), 'K11')).toEqual([emitManifests(web, HEADER)]);
      expect(since(h, mark).find((call) => callId(call) === 'K49')?.call.args).toEqual([
        'get',
        'deployments.apps/web',
        '--ignore-not-found',
        '--show-managed-fields',
        '-o',
        'json',
      ]);
      expect(outcome.changes.map((c) => c.name)).toEqual(['web']);
    });
  });

  describe('apply failure after a successful dry-run (design-03 5.8)', () => {
    async function failingApply(h: Harness): Promise<{ run: (options: ExecuteOptions) => Promise<unknown>; partials: PartialApply[]; progress: string[] }> {
      await deploy(h, [deployment('web')]);
      h.cluster.tick(3);
      h.cluster.rejectOn({ verb: 'apply', kind: 'Deployment', name: 'web' }, 'AdmissionDenied', undefined, { dryRun: false });
      const prepared = await h.engine.prepare(request([deployment('web', { image: 'registry.example.com/shop/web:2' }), deployment('worker')]));
      const partials: PartialApply[] = [];
      const progress: string[] = [];
      const run = (options: ExecuteOptions) =>
        h.engine.execute(prepared, {
          onApplyProgress: (p) => progress.push(p.kind === 'reverted' ? `reverted:${p.revert.status}` : p.kind),
          ...options,
        });
      return { run, partials, progress };
    }

    const DETAIL = 'Cluster policy rejected an object: images from registry.example.com/untrusted are not allowed';

    it('hands the partial state to the revert and reports a confirmed revert (SD8)', async () => {
      const h = harness();
      const { run, partials, progress } = await failingApply(h);
      const revert = async (partial: PartialApply): Promise<RevertResult> => {
        partials.push(partial);
        return { status: 'reverted', services: ['web'], message: 'reverted web to 1.4.1' };
      };
      const error = await refusal(run({ revert }));
      expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(error.message).toBe(`Applying namespace dockflow-shop-production failed after validation: ${DETAIL}; reverted web to 1.4.1`);
      expect(progress).toEqual(['started', 'reverted:reverted']);
      expect(partials).toHaveLength(1);
      // kubectl applied the documents it could: the new worker is live, web kept its generation
      expect(partials[0].changes.map((c) => `${c.name} created=${c.created}`)).toEqual(['worker created=true']);
      expect(partials[0].after.workloads.map((w) => w.name)).toEqual(['web', 'worker']);
      expect(partials[0].error).toBeInstanceOf(KubeError);
    });

    it('maps a revert that did not converge to ROLLBACK_FAILED, and nothing-to-revert to DEPLOY_FAILED', async () => {
      const h = harness();
      const { run, progress } = await failingApply(h);
      const failed = await refusal(run({ revert: async () => ({ status: 'failed', services: ['web'], message: 'web did not become ready' }) }));
      expect(failed.code).toBe(ErrorCode.ROLLBACK_FAILED);
      expect(failed.message).toBe(
        `Applying namespace dockflow-shop-production failed after validation (${DETAIL}) and the automatic revert did not converge (web did not become ready)`,
      );
      expect(failed.suggestion).toBe('Run `dockflow status production`, then `dockflow rollback production`.');
      const nothing = await refusal(
        run({ revert: async () => ({ status: 'nothing-to-revert', services: [], message: 'web was not reverted because its update_config.failure_action is pause' }) }),
      );
      expect(nothing.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(nothing.message).toEndWith('; web was not reverted because its update_config.failure_action is pause');
      expect(progress).toEqual(['started', 'reverted:failed', 'started', 'reverted:nothing-to-revert']);
    });

    it('rethrows the apply error as is when no revert is given (rollbacks)', async () => {
      const h = harness();
      const { run, progress } = await failingApply(h);
      const error = await kubeFailure(run({}));
      expect(error.reason).toBe('AdmissionDenied');
      expect(progress).toEqual(['started']);
    });
  });

  describe('-lb Services to watch (design-03 5.9, K19)', () => {
    it('watches a created or unbound -lb Service, not an unchanged bound one (SD35)', async () => {
      const h = harness();
      const lb = service('web-lb', 'web', { type: 'LoadBalancer', ports: [{ name: 'tcp-8080', port: 8080, protocol: 'TCP', targetPort: 8080 }] });
      const created = await deploy(h, [deployment('web'), lb]);
      expect(created.lbWatch).toEqual([{ service: 'web', name: 'web-lb', ports: [{ port: 8080, protocol: 'TCP' }] }]);
      h.cluster.tick(2);
      const bound = await deploy(h, [deployment('web'), lb]);
      expect(bound.lbWatch).toEqual([]);

      h.cluster.claimHostPort(9090, 'TCP', 'other-project/proxy');
      const blocked = service('api-lb', 'api', { type: 'LoadBalancer', ports: [{ name: 'tcp-9090', port: 9090, protocol: 'TCP', targetPort: 9090 }] });
      await deploy(h, [deployment('web'), lb, deployment('api'), blocked]);
      h.cluster.tick(2);
      const retried = await deploy(h, [deployment('web'), lb, deployment('api'), blocked]);
      expect(retried.lbWatch).toEqual([{ service: 'api', name: 'api-lb', ports: [{ port: 9090, protocol: 'TCP' }] }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('engine pure helpers', () => {
  const T0 = new Date('2026-09-17T10:00:00.000Z');

  function lbService(name: string, ports: number[], hasIngress: boolean): LiveService {
    return { name, service: name.replace(/-lb$/, ''), type: 'LoadBalancer', clusterIP: '10.43.0.9', ports: ports.map((port) => ({ port, protocol: 'TCP', targetPort: port })), hasIngress };
  }

  function snapshotOf(services: LiveService[]): Snapshot {
    return { ...emptySnapshot(T0), services };
  }

  it('compares quantities by value', () => {
    expect(compareQuantities('5Gi', '10Gi')).toBe(-1);
    expect(compareQuantities('1024Mi', '1Gi')).toBe(0);
    expect(compareQuantities('2G', '1Gi')).toBe(1);
    expect(compareQuantities('1500m', '1')).toBe(1);
    expect(compareQuantities('lots', '1Gi')).toBe(0);
  });

  it('compares published ports as sets', () => {
    const a = [
      { port: 80, protocol: 'TCP' as const, targetPort: 8080 },
      { port: 53, protocol: 'UDP' as const, targetPort: 53 },
    ];
    expect(samePorts(a, [...a].reverse())).toBe(true);
    expect(samePorts(a, [{ port: 80, protocol: 'TCP', targetPort: 80 }, { port: 53, protocol: 'UDP', targetPort: null }])).toBe(true);
    expect(samePorts(a, [{ port: 80, protocol: 'UDP', targetPort: 8080 }, { port: 53, protocol: 'UDP', targetPort: 53 }])).toBe(false);
  });

  it('plans -lb watches for created, re-ported and unbound LoadBalancer Services only', () => {
    const applied: ManifestObject[] = [
      service('web-lb', 'web', { type: 'LoadBalancer', ports: [{ port: 80, protocol: 'TCP', targetPort: 8080 }] }),
      service('api-lb', 'api', { type: 'LoadBalancer', ports: [{ port: 81, protocol: 'TCP', targetPort: 8081 }] }),
      service('db-lb', 'db', { type: 'LoadBalancer', ports: [{ port: 5432, protocol: 'TCP', targetPort: 5432 }] }),
      service('gone-lb', 'gone', { type: 'LoadBalancer', ports: [{ port: 82, protocol: 'TCP', targetPort: 82 }] }),
      service('web', 'web', { ports: [{ port: 8080, protocol: 'TCP' }] }),
    ];
    const before = snapshotOf([lbService('web-lb', [80], true), lbService('api-lb', [8081], true), lbService('db-lb', [5432], false)]);
    const after = snapshotOf([lbService('web-lb', [80], true), lbService('api-lb', [81], true), lbService('db-lb', [5432], false)]);
    expect(planLbWatch(applied, before, after)).toEqual([
      { service: 'api', name: 'api-lb', ports: [{ port: 81, protocol: 'TCP' }] },
      { service: 'db', name: 'db-lb', ports: [{ port: 5432, protocol: 'TCP' }] },
    ]);
  });

  it('recognises a clusterIP flip only when it is the whole failure', () => {
    const flip = readFileSync(join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr', 'Immutable', '2.txt'), 'utf8').trim();
    const error = new KubeError('Immutable', 'kubectl apply failed', 'server_1', 1, `${flip}\n`);
    const db = service('db', 'db', { clusterIP: 'None', ports: [{ port: 9, protocol: 'TCP' }] });
    expect(flip).toContain('Service "db"');
    expect(clusterIpFlips(error, [db])).toEqual(['db']);
    expect(clusterIpFlips(error, [service('web', 'web', { ports: [{ port: 80, protocol: 'TCP' }] })])).toEqual([]);
    const mixed = new KubeError('Immutable', 'kubectl apply failed', 'server_1', 1, `${flip}\nError from server (Invalid): Deployment.apps "db" is invalid: spec.selector: Invalid value: x: field is immutable\n`);
    expect(clusterIpFlips(mixed, [db])).toEqual([]);
    expect(clusterIpFlips(new Error('boom'), [db])).toEqual([]);
    expect(clusterIpFlips(new KubeError('Invalid', 'x', 'server_1', 1, flip), [db])).toEqual([]);
  });

  it('builds the partial-apply error from any error and a revert without a message', () => {
    const error = partialApplyError(NS, new Error('the connection dropped'), { status: 'reverted', services: ['web', 'api'] }, { env: 'production', distribution: 'k3s' });
    expect(error.message).toBe('Applying namespace dockflow-shop-production failed after validation: the connection dropped; reverted web, api');
    expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(error).toBeInstanceOf(CLIError);
  });

  it('checks live claim templates by class, access-mode set and canonical size', () => {
    const before: Snapshot = {
      ...emptySnapshot(T0),
      workloads: [
        {
          kind: 'StatefulSet',
          name: 'queue',
          service: 'queue',
          uid: 'u1',
          generation: 1,
          replicas: 1,
          revision: 'queue-1',
          pendingRevision: 'queue-1',
          revisionNumber: 1,
          graceSeconds: 30,
          paused: false,
          deleting: false,
          job: null,
          claimTemplates: [{ name: 'queue-data', volumeKey: 'queue_data', storageClassName: K8S_STORAGE_CLASS, accessModes: ['ReadWriteOnce'], storage: '1Gi' }],
          refs: { secrets: [], configMaps: [], claims: [], images: [] },
        },
      ],
    };
    const withTemplate = (options: ClaimOptions) => [statefulSet('queue', { claimTemplates: [claimTemplate('queue-data', { key: 'queue_data', ...options })] })];
    expect(() => checkClaimTemplates(withTemplate({ storage: '1024Mi' }), before, REF)).not.toThrow();
    expect(() => checkClaimTemplates(withTemplate({ storageClassName: 'fast-ssd' }), before, REF)).toThrow(
      'Volume queue_data cannot change size, storage class or access mode after creation; its data is kept',
    );
    expect(() => checkClaimTemplates(withTemplate({ accessModes: ['ReadWriteOncePod'] }), before, REF)).toThrow(DeployError);
    // a new template name, or a StatefulSet that does not exist yet, is not this rule's
    expect(() => checkClaimTemplates([statefulSet('queue', { claimTemplates: [claimTemplate('other', { storage: '9Gi' })] })], before, REF)).not.toThrow();
    expect(() => checkClaimTemplates(withTemplate({ storage: '9Gi' }), emptySnapshot(T0), REF)).not.toThrow();
  });

  it('names the accessory removal in the prune guard of the accessory role', () => {
    const before: Snapshot = {
      ...emptySnapshot(T0),
      workloads: [
        {
          kind: 'Deployment',
          name: 'redis',
          service: 'redis',
          uid: 'u2',
          generation: 1,
          replicas: 1,
          revision: '1',
          pendingRevision: null,
          revisionNumber: 1,
          graceSeconds: 30,
          paused: false,
          deleting: false,
          job: null,
          claimTemplates: [],
          refs: { secrets: [], configMaps: [], claims: [], images: [] },
        },
      ],
    };
    let caught: unknown;
    try {
      assertPruneGuard([], before, NS, { env: 'production', role: 'accessory' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).suggestion).toBe('Remove them with `dockflow accessories remove production`, then deploy again.');
    expect(() => assertPruneGuard([deployment('redis')], before, NS, REF)).not.toThrow();
  });
});
