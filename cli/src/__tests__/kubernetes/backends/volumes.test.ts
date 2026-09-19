import { afterEach, describe, expect, it } from 'bun:test';
import type { ClusterNodeRef, StackRole, VolumeInfo, VolumeScope } from '../../../services/orchestrator/interfaces';
import {
  KubernetesVolumeBackend,
  lostNodeLine,
  removeVolumesByProtocol,
  type VolumeNotices,
  VolumeRemovalError,
} from '../../../services/orchestrator/kubernetes/backends/volumes';
import { ANNOTATIONS, K8S_SYSTEM_NAMESPACE, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import type { SshChannel } from '../../../services/orchestrator/kubernetes/deps';
import { volumeClaimLabels } from '../../../services/orchestrator/kubernetes/labels';
import type {
  ApplyOptions,
  CreateOptions,
  CreateResult,
  GetJsonOptions,
  KubeDeleteOptions,
  KubeExecutor,
  KubectlCall,
  KubectlResult,
  ShellCall,
} from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { OrchestratorUnavailableError, ValidationError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { FakeKubeExecutor, type KubeStep, type RecordedKubeCall } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants, checkExecutorInvariants } from '../support/invariants';
import { expectCliError } from '../support/matchers';

const NS = 'dockflow-shop-production';
const SYSTEM = K8S_SYSTEM_NAMESPACE;
const P_BEFORE = ANNOTATIONS.reclaimPolicyBefore;
const SERVER_KEYS = ['server_1', 'agent_1'];
const HOST_ROOT = '/srv/dockflow-test/volumes';
const OK: KubectlResult = { exitCode: 0, stdout: '', stderr: '' };
const redactor = new Redactor([]);

type Policy = 'Retain' | 'Delete' | 'Recycle';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  kube: FakeKubeExecutor;
  cluster: FakeCluster | null;
  volumeDeletion: boolean;
}

let harnesses: Harness[] = [];

afterEach(() => {
  const current = harnesses;
  harnesses = [];
  for (const { kube, cluster, volumeDeletion } of current) {
    assertExecutorInvariants({ kube, redactor, allow: { volumeDeletion }, ...(cluster ? { volumes: cluster } : {}) });
    cluster?.assertNoProblems();
  }
});

function onCluster(options: { volumeDeletion?: boolean; script?: KubeStep[]; checked?: boolean } = {}): { cluster: FakeCluster; kube: FakeKubeExecutor } {
  const cluster = new FakeCluster();
  const kube = new FakeKubeExecutor({ redactor, cluster, script: options.script ?? [] });
  if (options.checked ?? true) harnesses.push({ kube, cluster, volumeDeletion: options.volumeDeletion ?? false });
  return { cluster, kube };
}

function scripted(script: KubeStep[], volumeDeletion = false): FakeKubeExecutor {
  const kube = new FakeKubeExecutor({ redactor, script });
  harnesses.push({ kube, cluster: null, volumeDeletion });
  return kube;
}

class Notices implements VolumeNotices {
  readonly warnings: { message: string; suggestion?: string }[] = [];
  warn(message: string, suggestion?: string): void {
    this.warnings.push(suggestion === undefined ? { message } : { message, suggestion });
  }
}

function volumesOf(kube: FakeKubeExecutor, notices = new Notices(), executor: KubeExecutor = kube): KubernetesVolumeBackend {
  return new KubernetesVolumeBackend({ kubectl: executor, distribution: kube.distribution }, { serverKeys: SERVER_KEYS, notices });
}

function scope(overrides: Partial<VolumeScope> = {}): VolumeScope {
  return { project: 'shop', env: 'production', role: null, ...overrides };
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

const uids = new Map<string, string>();

/** stable per namespace/name, and outside the fake cluster's own uid range */
function uidOf(key: string): string {
  let uid = uids.get(key);
  if (uid === undefined) {
    uid = `11111111-0000-4000-8000-${(uids.size + 1).toString(16).padStart(12, '0')}`;
    uids.set(key, uid);
  }
  return uid;
}

interface ClaimOptions {
  namespace?: string;
  /** null: a chart's claim without Dockflow labels */
  role?: StackRole | null;
  compose?: string;
  /** `P/volume` of a claim-template claim */
  template?: string;
  /** bound PV; null: Pending */
  volume?: string | null;
  capacity?: string;
  storageClass?: string;
  uid?: string;
}

function claim(name: string, options: ClaimOptions = {}): KubeObject {
  const namespace = options.namespace ?? NS;
  const role = options.role === undefined ? 'accessory' : options.role;
  const volume = options.volume === undefined ? `pv-${name}` : options.volume;
  const capacity = options.capacity ?? '1Gi';
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name,
      namespace,
      uid: options.uid ?? uidOf(`${namespace}/${name}`),
      labels:
        role === null ? { 'app.kubernetes.io/instance': 'postgres' } : volumeClaimLabels({ project: 'shop', namespace }, role, options.template ?? name),
      ...(options.compose !== undefined ? { annotations: { [ANNOTATIONS.composeVolume]: options.compose } } : {}),
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: capacity } },
      storageClassName: options.storageClass ?? 'dockflow-local',
      ...(volume !== null ? { volumeName: volume } : {}),
    },
    status: volume !== null ? { phase: 'Bound', accessModes: ['ReadWriteOnce'], capacity: { storage: capacity } } : { phase: 'Pending' },
  };
}

interface VolumeOptions {
  claim: string;
  namespace?: string;
  claimUid?: string;
  /** node of the local volume; null: no node affinity */
  node?: string | null;
  policy?: Policy;
  /** `P/reclaim-policy-before` */
  recorded?: string;
  phase?: 'Bound' | 'Released' | 'Failed';
  capacity?: string;
  storageClass?: string;
}

function volume(name: string, options: VolumeOptions): KubeObject {
  const namespace = options.namespace ?? NS;
  const node = options.node === undefined ? 'server-1' : options.node;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name, ...(options.recorded !== undefined ? { annotations: { [P_BEFORE]: options.recorded } } : {}) },
    spec: {
      accessModes: ['ReadWriteOnce'],
      capacity: { storage: options.capacity ?? '1Gi' },
      claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: options.claim, namespace, uid: options.claimUid ?? uidOf(`${namespace}/${options.claim}`) },
      hostPath: { path: `${HOST_ROOT}/${name}_${namespace}_${options.claim}`, type: 'DirectoryOrCreate' },
      ...(node !== null
        ? { nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: KUBE_KEYS.hostname, operator: 'In', values: [node] }] }] } } }
        : {}),
      persistentVolumeReclaimPolicy: options.policy ?? 'Retain',
      storageClassName: options.storageClass ?? 'dockflow-local',
      volumeMode: 'Filesystem',
    },
    status: { phase: options.phase ?? 'Bound' },
  };
}

/** a Bound claim and its PV `pv-<name>` */
function bound(name: string, options: ClaimOptions & Partial<Omit<VolumeOptions, 'claim' | 'namespace' | 'claimUid' | 'capacity' | 'storageClass'>> = {}): KubeObject[] {
  return [
    claim(name, options),
    volume(`pv-${name}`, {
      claim: name,
      ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
      ...(options.uid !== undefined ? { claimUid: options.uid } : {}),
      ...(options.node !== undefined ? { node: options.node } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      ...(options.recorded !== undefined ? { recorded: options.recorded } : {}),
      ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
      ...(options.storageClass !== undefined ? { storageClass: options.storageClass } : {}),
    }),
  ];
}

interface PodOptions {
  claims: string[];
  namespace?: string;
  /** null: not scheduled */
  node?: string | null;
  phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed';
  compose?: string;
  grace?: number;
  terminating?: boolean;
  nodeSelector?: Record<string, string>;
}

function pod(name: string, options: PodOptions): KubeObject {
  const node = options.node === undefined ? 'server-1' : options.node;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: options.namespace ?? NS,
      ...(options.compose !== undefined ? { annotations: { [ANNOTATIONS.composeService]: options.compose } } : {}),
      ...(options.terminating ? { deletionTimestamp: '2026-01-01T00:00:00Z', deletionGracePeriodSeconds: 30 } : {}),
    },
    spec: {
      containers: [{ name: 'main', image: 'registry.example.com/shop/db:1' }],
      volumes: options.claims.map((claimName, index) => ({ name: `data-${index}`, persistentVolumeClaim: { claimName } })),
      terminationGracePeriodSeconds: options.grace ?? 30,
      ...(node !== null ? { nodeName: node } : {}),
      ...(options.nodeSelector ? { nodeSelector: options.nodeSelector } : {}),
    },
    status: { phase: options.phase ?? (node !== null ? 'Running' : 'Pending') },
  };
}

function node(name: string): KubeObject {
  return { apiVersion: 'v1', kind: 'Node', metadata: { name } };
}

function list(...items: KubeObject[]): { json: unknown } {
  return { json: { apiVersion: 'v1', kind: 'List', items } };
}

// ---------------------------------------------------------------------------
// Call shapes
// ---------------------------------------------------------------------------

const RECORD = (policy: Policy): string => JSON.stringify({ metadata: { annotations: { [P_BEFORE]: policy } } });
const TO_DELETE = JSON.stringify({ spec: { persistentVolumeReclaimPolicy: 'Delete' } });
const RESTORE = (policy: Policy): string =>
  JSON.stringify({ metadata: { annotations: { [P_BEFORE]: null } }, spec: { persistentVolumeReclaimPolicy: policy } });

const patchArgs = (pv: string, body: string): string[] => ['patch', `persistentvolumes/${pv}`, '--type=merge', '-p', body];
const deleteClaimArgs = (name: string, waitS = 120): string[] => [
  'delete',
  `persistentvolumeclaims/${name}`,
  '--ignore-not-found',
  '--wait=true',
  `--timeout=${waitS}s`,
];
const waitGoneArgs = (pv: string, waitS = 120): string[] => ['wait', '--for=delete', `persistentvolumes/${pv}`, `--timeout=${waitS}s`];

function executed(kube: FakeKubeExecutor): RecordedKubeCall[] {
  return kube.calls.filter((call) => call.method !== 'command');
}

function mutations(kube: FakeKubeExecutor): string[] {
  return executed(kube)
    .filter((call) => call.call.mutating)
    .map((call) => call.call.args.join(' '));
}

/** the deletion steps in call order: `claim <pvc>`, `Delete <pv>`, `gone <pv>` */
function deletionSteps(kube: FakeKubeExecutor): string[] {
  return executed(kube).flatMap((call) => {
    const [verb, target, ...rest] = call.call.args;
    if (verb === 'delete' && target?.startsWith('persistentvolumeclaims/')) return [`claim ${target.slice(target.indexOf('/') + 1)}`];
    if (verb === 'patch' && rest.includes(TO_DELETE)) return [`Delete ${target.slice(target.indexOf('/') + 1)}`];
    if (verb === 'wait' && rest[0]?.startsWith('persistentvolumes/')) return [`gone ${rest[0].slice(rest[0].indexOf('/') + 1)}`];
    return [];
  });
}

function pvState(cluster: FakeCluster, name: string): { policy: string | null; recorded: string | null; phase: string | null } | null {
  const pv = cluster.get('PersistentVolume', name);
  if (!pv) return null;
  const spec = pv.spec as { persistentVolumeReclaimPolicy?: string };
  const status = pv.status as { phase?: string } | undefined;
  return { policy: spec.persistentVolumeReclaimPolicy ?? null, recorded: pv.metadata.annotations?.[P_BEFORE] ?? null, phase: status?.phase ?? null };
}

function names(infos: VolumeInfo[]): string[] {
  return infos.map((info) => info.name);
}

/** A CLI killed at one call: that call and every later one never reach the cluster, so no finally runs remotely. */
class KilledAt implements KubeExecutor {
  private killed = false;

  constructor(
    private readonly inner: FakeKubeExecutor,
    private readonly at: (args: readonly string[]) => boolean,
  ) {}

  get node(): ClusterNodeRef {
    return this.inner.node;
  }

  private gate(args: readonly string[]): void {
    if (!this.killed && this.at(args)) this.killed = true;
    if (this.killed) throw new Error('the CLI was killed');
  }

  async run(call: KubectlCall): Promise<KubectlResult> {
    this.gate(call.args);
    return this.inner.run(call);
  }

  async getJson<T>(resources: string[], options?: GetJsonOptions): Promise<T[]> {
    this.gate(['get', ...resources]);
    return this.inner.getJson<T>(resources, options);
  }

  async delete(targets: string[], options: KubeDeleteOptions): Promise<void> {
    this.gate(['delete', ...targets]);
    return this.inner.delete(targets, options);
  }

  apply(manifests: string, options: ApplyOptions): Promise<void> {
    return this.inner.apply(manifests, options);
  }

  create<T = unknown>(manifest: string, options?: CreateOptions): Promise<CreateResult<T>> {
    return this.inner.create<T>(manifest, options);
  }

  replace<T = unknown>(manifest: string, options?: { namespace?: string }): Promise<T> {
    return this.inner.replace<T>(manifest, options);
  }

  stream(call: Omit<KubectlCall, 'mutating' | 'stdin'>, handlers: { stdout(chunk: string): void; stderr(chunk: string): void }): Promise<number> {
    return this.inner.stream(call, handlers);
  }

  shell(call: ShellCall): Promise<KubectlResult> {
    return this.inner.shell(call);
  }

  channel(script: string): Promise<SshChannel> {
    return this.inner.channel(script);
  }

  interactive(script: string): Promise<number> {
    return this.inner.interactive(script);
  }

  command(args: string[], namespace?: string): string {
    return this.inner.command(args, namespace);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  it('U-BE-VOL-01: joins claims, PVs and pods; node as the servers.yml key, hostPath, reclaim policy; role filter', async () => {
    const { cluster, kube } = onCluster();
    // provisioned the way the cluster does it, so hostPath comes from the provisioner
    cluster.seed([
      claim('db-data', { compose: 'db_data', volume: null, capacity: '10Gi' }),
      pod('db-0', { claims: ['db-data'], compose: 'db', node: null, nodeSelector: { [KUBE_KEYS.hostname]: 'agent-1' } }),
    ]);
    cluster.seed([...bound('uploads', { role: 'app', compose: 'uploads' })]);
    cluster.seed([...bound('data-postgres-0', { role: null, node: 'agent-1', capacity: '8Gi' })]);
    cluster.seed([pod('postgres-0', { claims: ['data-postgres-0'], node: 'agent-1' })], { reconcile: false });
    cluster.tick(3);

    const backend = volumesOf(kube);
    const all = await backend.list(scope());
    expect(names(all)).toEqual(['db-data', 'uploads', 'data-postgres-0']);
    const [db, uploads, postgres] = all;
    const provisioned = (cluster.get('PersistentVolumeClaim', 'db-data', NS)?.spec as { volumeName: string }).volumeName;
    expect(db).toEqual({
      name: 'db-data',
      composeName: 'db_data',
      role: 'accessory',
      phase: 'Bound',
      capacity: '10Gi',
      storageClass: 'dockflow-local',
      node: 'agent_1',
      reclaimPolicy: 'Retain',
      usedBy: ['db'],
      hostPath: `${kube.distribution.localVolumeRoot}/${provisioned}_${NS}_db-data`,
    });
    expect(uploads).toEqual({
      name: 'uploads',
      composeName: 'uploads',
      role: 'app',
      phase: 'Bound',
      capacity: '1Gi',
      storageClass: 'dockflow-local',
      node: 'server_1',
      reclaimPolicy: 'Retain',
      usedBy: [],
      hostPath: `${HOST_ROOT}/pv-uploads_${NS}_uploads`,
    });
    // a chart's claim: no Dockflow labels, listed with role null only
    expect(postgres).toMatchObject({ name: 'data-postgres-0', composeName: null, role: null, node: 'agent_1', reclaimPolicy: 'Retain', usedBy: ['postgres-0'] });

    expect(names(await backend.list(scope({ role: 'app' })))).toEqual(['uploads']);
    expect(names(await backend.list(scope({ role: 'accessory' })))).toEqual(['db-data']);
    expect(mutations(kube)).toEqual([]);
    expect(executed(kube).map((call) => call.call.args.join(' '))).toContain('get persistentvolumes -o json');
    kube.assertDone();
  });

  it('lists the namespace of a Helm release and dockflow-system when the scope names them', async () => {
    const { cluster, kube } = onCluster();
    cluster.seed([
      ...bound('uploads', { role: 'app' }),
      ...bound('data-search-0', { role: null, namespace: 'search' }),
      ...bound('dockflow-traefik', { role: null, namespace: SYSTEM }),
    ]);
    const backend = volumesOf(kube);
    expect(names(await backend.list(scope()))).toEqual(['uploads']);
    expect(names(await backend.list(scope({ namespace: 'search' })))).toEqual(['data-search-0']);
    const system = await backend.list(scope({ namespace: SYSTEM }));
    expect(system).toEqual([
      {
        name: 'dockflow-traefik',
        composeName: null,
        role: null,
        phase: 'Bound',
        capacity: '1Gi',
        storageClass: 'dockflow-local',
        node: 'server_1',
        reclaimPolicy: 'Retain',
        usedBy: [],
        hostPath: `${HOST_ROOT}/pv-dockflow-traefik_${SYSTEM}_dockflow-traefik`,
      },
    ]);
    expect(await backend.list(scope({ namespace: SYSTEM, role: 'app' }))).toEqual([]);
    kube.assertDone();
  });

  it('shows a pending claim, a released PV without claim, and an old PV of a claim re-created under the same name', async () => {
    const { cluster, kube } = onCluster();
    cluster.seed([
      claim('cache', { compose: 'cache', volume: null }),
      volume('pv-orphan', { claim: 'gone', phase: 'Released', capacity: '5Gi', node: 'agent-1' }),
      ...bound('media', { role: 'app', compose: 'media' }),
      // the previous PV of `media`: its claimRef carries the uid of a claim that no longer exists
      volume('pv-media-old', { claim: 'media', claimUid: '22222222-0000-4000-8000-000000000001', phase: 'Released' }),
    ]);
    const infos = await volumesOf(kube).list(scope());
    expect(names(infos)).toEqual(['cache', 'media', 'pv-media-old', 'pv-orphan']);
    expect(infos[0]).toEqual({
      name: 'cache',
      composeName: 'cache',
      role: 'accessory',
      phase: 'Pending',
      capacity: null,
      storageClass: 'dockflow-local',
      node: null,
      reclaimPolicy: null,
      usedBy: [],
      hostPath: null,
    });
    expect(infos[3]).toEqual({
      name: 'pv-orphan',
      composeName: null,
      role: null,
      phase: 'Released',
      capacity: '5Gi',
      storageClass: 'dockflow-local',
      node: 'agent_1',
      reclaimPolicy: 'Retain',
      usedBy: [],
      hostPath: `${HOST_ROOT}/pv-orphan_${NS}_gone`,
    });
    expect(infos[2]).toMatchObject({ name: 'pv-media-old', phase: 'Released', role: null });
    // released PVs carry no role label
    expect(names(await volumesOf(kube).list(scope({ role: 'accessory' })))).toEqual(['cache']);
    kube.assertDone();
  });

  it('counts scheduled, non-terminal pods as users (a Terminating one too), never an unschedulable Pending one', async () => {
    const { cluster, kube } = onCluster();
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('queue', { compose: 'queue' }), ...bound('spare', { compose: 'spare' })]);
    cluster.seed(
      [
        pod('db-0', { claims: ['db-data'], compose: 'db' }),
        pod('db-1', { claims: ['db-data'], compose: 'db' }),
        pod('backup-helper', { claims: ['db-data'] }),
        pod('worker-old', { claims: ['queue'], compose: 'worker', terminating: true }),
        pod('worker-done', { claims: ['queue'], compose: 'batch', phase: 'Succeeded' }),
        pod('worker-failed', { claims: ['queue'], compose: 'cron', phase: 'Failed' }),
        pod('traefik-pending', { claims: ['spare'], compose: 'proxy', node: null }),
      ],
      { reconcile: false },
    );
    const infos = await volumesOf(kube).list(scope());
    expect(infos.map((info) => [info.name, info.usedBy])).toEqual([
      ['db-data', ['backup-helper', 'db']],
      ['queue', ['worker']],
      ['spare', []],
    ]);
    kube.assertDone();
  });

  it('maps claim-template claims by their compose volume and P/volume', async () => {
    const { cluster, kube } = onCluster();
    cluster.seed([
      ...bound('data-db-1', { compose: 'db_data', template: 'data' }),
      ...bound('data-db-0', { compose: 'db_data', template: 'data' }),
    ]);
    const infos = await volumesOf(kube).list(scope());
    expect(infos.map((info) => [info.name, info.composeName, info.role])).toEqual([
      ['data-db-0', 'db_data', 'accessory'],
      ['data-db-1', 'db_data', 'accessory'],
    ]);
    kube.assertDone();
  });

  it('C13 step 5: puts the recorded policy back on a PV whose claim exists, warns, and leaves other Delete PVs alone', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([
      // interrupted deletion: recorded Retain, left Delete, claim still there
      ...bound('db-data', { compose: 'db_data', policy: 'Delete', recorded: 'Retain' }),
      // Delete without evidence: not Dockflow's doing, shown as it is
      ...bound('scratch', { compose: 'scratch', policy: 'Delete' }),
      // evidence on a released PV: its claim is gone, nothing to repair
      volume('pv-released', { claim: 'old', phase: 'Released', recorded: 'Retain' }),
    ]);
    const notices = new Notices();
    const infos = await volumesOf(kube, notices).list(scope());
    expect(infos.map((info) => [info.name, info.reclaimPolicy])).toEqual([
      ['db-data', 'Retain'],
      ['scratch', 'Delete'],
      ['pv-released', 'Retain'],
    ]);
    expect(notices.warnings).toEqual([{ message: 'Volume db-data: reclaim policy restored to Retain; a previous volume deletion was interrupted' }]);
    expect(mutations(kube)).toEqual([patchArgs('pv-db-data', RESTORE('Retain')).join(' ')]);
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    expect(pvState(cluster, 'pv-scratch')).toEqual({ policy: 'Delete', recorded: null, phase: 'Bound' });
    expect(pvState(cluster, 'pv-released')?.recorded).toBe('Retain');
    kube.assertDone();
  });

  it('warns with a suggestion when the repair itself fails, and still lists', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('db-data', { compose: 'db_data', policy: 'Delete', recorded: 'Retain' })]);
    cluster.rejectOn({ verb: 'patch', kind: 'PersistentVolume' }, 'Forbidden');
    const notices = new Notices();
    const infos = await volumesOf(kube, notices).list(scope());
    expect(infos.map((info) => info.reclaimPolicy)).toEqual(['Delete']);
    expect(notices.warnings).toHaveLength(1);
    expect(notices.warnings[0].message).toStartWith(
      'Volume db-data: reclaim policy could not be restored to Retain after an interrupted volume deletion (kubectl patch failed on server_1',
    );
    expect(notices.warnings[0].suggestion).toBe(
      'Set persistent volume pv-db-data back to Retain from `dockflow ssh production`, or run `dockflow volumes list production` again.',
    );
    kube.assertDone();
  });

  it('maps a failed read to the orchestrator error of the runtime', async () => {
    const kube = scripted([
      { args: ['get', 'persistentvolumeclaims,pods', '-o', 'json'], namespace: NS, respond: { error: 'Forbidden' } },
      { args: ['get', 'persistentvolumes', '-o', 'json'], namespace: null, respond: list() },
    ]);
    await expectCliError(volumesOf(kube).list(scope()), {
      type: OrchestratorUnavailableError,
      message: 'The Dockflow deploy identity is not allowed to list volumes',
    });
    kube.assertDone();
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('U-BE-VOL-02: refuses a volume in use, naming its users, before any mutation', async () => {
    const { cluster, kube } = onCluster();
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('cache', { compose: 'cache' })]);
    cluster.seed([pod('db-0', { claims: ['db-data'], compose: 'db' })], { reconcile: false });
    await expectCliError(volumesOf(kube).remove(scope(), ['db-data', 'cache']), {
      type: ValidationError,
      message: 'Volume db-data is in use by db',
      suggestion: 'Stop the workloads first with `dockflow stop production` or `dockflow accessories stop production <service>`.',
    });
    expect(mutations(kube)).toEqual([]);
    expect(pvState(cluster, 'pv-cache')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    kube.assertDone();
  });

  it('U-BE-VOL-03: records every policy, then one volume at a time: claim, wait, that PV to Delete, wait', async () => {
    const db = bound('db-data', { compose: 'db_data' });
    const cache = bound('cache-data', { compose: 'cache_data', node: 'agent-1' });
    const kube = scripted(
      [
        { id: 'list', args: ['get', 'persistentvolumeclaims,pods', '-o', 'json'], namespace: NS, respond: list(db[0], cache[0]) },
        { id: 'list-pv', args: ['get', 'persistentvolumes', '-o', 'json'], namespace: null, respond: list(db[1], cache[1]) },
        {
          id: 'claims',
          args: ['get', 'persistentvolumeclaims', 'db-data', 'cache-data', '--ignore-not-found', '-o', 'json'],
          namespace: NS,
          respond: list(db[0], cache[0]),
        },
        {
          id: 'volumes',
          args: ['get', 'persistentvolumes', 'pv-db-data', 'pv-cache-data', '--ignore-not-found', '-o', 'json'],
          namespace: null,
          respond: list(db[1], cache[1]),
        },
        { id: 'nodes', args: ['get', 'nodes', '-o', 'json'], respond: list(node('server-1'), node('agent-1')) },
        { id: 'record-db', args: patchArgs('pv-db-data', RECORD('Retain')), mutating: true, respond: OK },
        { id: 'record-cache', args: patchArgs('pv-cache-data', RECORD('Retain')), mutating: true, respond: OK },
        { id: 'claim-db', args: deleteClaimArgs('db-data'), namespace: NS, mutating: true, respond: OK },
        { id: 'delete-db', args: patchArgs('pv-db-data', TO_DELETE), mutating: true, respond: OK },
        { id: 'gone-db', args: waitGoneArgs('pv-db-data'), mutating: false, respond: OK },
        { id: 'claim-cache', args: deleteClaimArgs('cache-data'), namespace: NS, mutating: true, respond: OK },
        { id: 'delete-cache', args: patchArgs('pv-cache-data', TO_DELETE), mutating: true, respond: OK },
        { id: 'gone-cache', args: waitGoneArgs('pv-cache-data'), mutating: false, respond: OK },
      ],
      true,
    );
    const report = await volumesOf(kube).remove(scope(), ['db-data', 'cache-data']);
    expect(report).toEqual({
      deleted: [
        { claim: 'db-data', volume: 'pv-db-data' },
        { claim: 'cache-data', volume: 'pv-cache-data' },
      ],
      restored: [],
      restoreFailed: [],
      keptOnLostNode: [],
    });
    kube.assertDone();
  });

  it('U-BE-VOL-03 on a cluster: at most one PV is Delete at any instant (INV-04b), and the data goes', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([
      ...bound('db-data', { compose: 'db_data' }),
      ...bound('cache-data', { compose: 'cache_data', node: 'agent-1' }),
      ...bound('media', { role: 'app', compose: 'media' }),
      ...bound('keep', { compose: 'keep' }),
    ]);
    const report = await volumesOf(kube).remove(scope(), ['media', 'cache_data', 'db-data']);
    expect(report.deleted).toEqual([
      { claim: 'media', volume: 'pv-media' },
      { claim: 'cache-data', volume: 'pv-cache-data' },
      { claim: 'db-data', volume: 'pv-db-data' },
    ]);
    expect(report.restored).toEqual([]);
    expect(deletionSteps(kube)).toEqual([
      'claim media',
      'Delete pv-media',
      'gone pv-media',
      'claim cache-data',
      'Delete pv-cache-data',
      'gone pv-cache-data',
      'claim db-data',
      'Delete pv-db-data',
      'gone pv-db-data',
    ]);
    // every policy is recorded before the first claim goes
    const calls = mutations(kube);
    const firstClaim = calls.findIndex((call) => call.startsWith('delete persistentvolumeclaims/'));
    expect(calls.slice(0, firstClaim)).toEqual([
      patchArgs('pv-media', RECORD('Retain')).join(' '),
      patchArgs('pv-cache-data', RECORD('Retain')).join(' '),
      patchArgs('pv-db-data', RECORD('Retain')).join(' '),
    ]);
    for (const pv of ['pv-media', 'pv-cache-data', 'pv-db-data']) expect(pvState(cluster, pv)).toBeNull();
    expect(cluster.list('PersistentVolumeClaim', { namespace: NS }).map((pvc) => pvc.metadata.name)).toEqual(['keep']);
    expect(pvState(cluster, 'pv-keep')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    kube.assertDone();
  });

  it('U-BE-VOL-04: an unknown name is refused with the existing names, before any mutation', async () => {
    const { cluster, kube } = onCluster();
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('uploads', { role: 'app' })]);
    cluster.seed([...bound('dockflow-traefik', { role: null, namespace: SYSTEM }), ...bound('data-search-0', { role: null, namespace: 'search' })]);
    const backend = volumesOf(kube);
    await expectCliError(backend.remove(scope(), ['db-data', 'nope']), {
      type: ValidationError,
      message: `Volume nope not found in ${NS}`,
      suggestion: `Volumes in ${NS}: db-data, uploads. List the volumes with \`dockflow volumes list production\`.`,
    });
    await expectCliError(backend.remove(scope(), ['dockflow-traefik', 'nope']), {
      type: ValidationError,
      message: `Volumes dockflow-traefik, nope not found in ${NS}`,
    });
    await expectCliError(backend.remove(scope({ namespace: SYSTEM }), ['nope']), {
      type: ValidationError,
      message: `Volume nope not found in ${SYSTEM}`,
      suggestion: `Volumes in ${SYSTEM}: dockflow-traefik. List the volumes with \`dockflow volumes list production --system\`.`,
    });
    await expectCliError(backend.remove(scope({ namespace: 'search' }), ['nope']), {
      type: ValidationError,
      suggestion: 'Volumes in search: data-search-0. List the volumes with `dockflow volumes list production --namespace search`.',
    });
    expect(mutations(kube)).toEqual([]);
    kube.assertDone();
  });

  it('U-BE-VOL-05: a released PV without claim is recorded, patched and waited for; no claim is touched', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([volume('pv-orphan', { claim: 'gone', phase: 'Released' }), ...bound('db-data', { compose: 'db_data' })]);
    const report = await volumesOf(kube).remove(scope(), ['pv-orphan']);
    expect(report.deleted).toEqual([{ claim: 'pv-orphan', volume: 'pv-orphan' }]);
    expect(deletionSteps(kube)).toEqual(['Delete pv-orphan', 'gone pv-orphan']);
    expect(mutations(kube)).toEqual([patchArgs('pv-orphan', RECORD('Retain')).join(' '), patchArgs('pv-orphan', TO_DELETE).join(' ')]);
    expect(pvState(cluster, 'pv-orphan')).toBeNull();
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    kube.assertDone();
  });

  it('U-BE-VOL-06: failing between the claim and the PV deletion restores the recorded policy and reports it', async () => {
    const { cluster, kube } = onCluster({
      volumeDeletion: true,
      script: [
        {
          id: 'wait-fails',
          args: waitGoneArgs('pv-db-data'),
          respond: { exitCode: 1, stdout: '', stderr: 'error: timed out waiting for the condition on persistentvolumes/pv-db-data\n' },
        },
      ],
    });
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('cache-data', { compose: 'cache_data' })]);
    const error = await expectCliError(volumesOf(kube).remove(scope(), ['db-data', 'cache-data']), {
      type: VolumeRemovalError,
      message: 'The data of volume db-data was not removed within 120s',
    });
    expect(error.report).toEqual({ deleted: [], restored: ['pv-db-data', 'pv-cache-data'], restoreFailed: [], keptOnLostNode: [] });
    expect(error.suggestion).toBe(
      [
        'Kept, with the reclaim policy restored: pv-db-data, pv-cache-data.',
        'Check the storage provisioner with `dockflow diagnose production`, then run the command again to delete the released volume.',
      ].join('\n'),
    );
    // the claim went, its PV is Released and kept; the untouched volume is exactly as before
    expect(cluster.get('PersistentVolumeClaim', 'db-data', NS)).toBeUndefined();
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Released' });
    expect(pvState(cluster, 'pv-cache-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    expect(deletionSteps(kube)).toEqual(['claim db-data', 'Delete pv-db-data', 'gone pv-db-data']);
    cluster.tick(3);
    expect(pvState(cluster, 'pv-db-data')?.phase).toBe('Released');
    kube.assertDone();
  });

  it('a claim delete that fails (a pod started after the read) leaves every PV on its recorded policy, reported', async () => {
    const late: { cluster?: FakeCluster } = {};
    const { cluster, kube } = onCluster({
      volumeDeletion: true,
      script: [
        {
          // the last read before the first mutation: a pod starts on db-data right then
          id: 'nodes',
          args: ['get', 'nodes', '-o', 'json'],
          respond: () => {
            if (!late.cluster) throw new Error('no cluster');
            late.cluster.seed([pod('db-0', { claims: ['db-data'], compose: 'db' })], { reconcile: false });
            return { exitCode: 0, stdout: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: late.cluster.list('Node') }), stderr: '' };
          },
        },
      ],
    });
    late.cluster = cluster;
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('cache-data', { compose: 'cache_data' })]);
    const error = await expectCliError(volumesOf(kube).remove(scope(), ['db-data', 'cache-data']), {
      type: VolumeRemovalError,
      message:
        /^Volume db-data was not deleted: its claim could not be deleted \(kubectl delete failed on server_1 \(exit 1\): error: timed out waiting for the condition on persistentvolumeclaims\/db-data\)$/,
    });
    expect(error.report).toEqual({ deleted: [], restored: ['pv-db-data', 'pv-cache-data'], restoreFailed: [], keptOnLostNode: [] });
    expect(deletionSteps(kube)).toEqual(['claim db-data']);
    expect(cluster.get('PersistentVolumeClaim', 'db-data', NS)?.metadata.deletionTimestamp).toBeDefined();
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    expect(pvState(cluster, 'pv-cache-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    kube.assertDone();
  });

  it('a policy that cannot be recorded stops everything before any claim is touched, and clears what was recorded', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('cache-data', { compose: 'cache_data' })]);
    cluster.rejectOn({ verb: 'patch', kind: 'PersistentVolume', name: 'pv-cache-data' }, 'Forbidden', undefined, { times: 1 });
    const error = await expectCliError(volumesOf(kube).remove(scope(), ['db-data', 'cache-data']), {
      type: VolumeRemovalError,
      message: /^Volume cache-data was not deleted: its reclaim policy could not be recorded \(kubectl patch failed on server_1 \(exit 1\): .*Forbidden/,
    });
    expect(error.report).toEqual({ deleted: [], restored: ['pv-db-data', 'pv-cache-data'], restoreFailed: [], keptOnLostNode: [] });
    expect(deletionSteps(kube)).toEqual([]);
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    expect(pvState(cluster, 'pv-cache-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Bound' });
    kube.assertDone();
  });

  it('names a PV whose restore failed, and the invariant sees exactly that PV left Delete', async () => {
    const { cluster, kube } = onCluster({
      checked: false,
      script: [
        { id: 'wait-fails', args: waitGoneArgs('pv-db-data'), respond: { exitCode: 1, stdout: '', stderr: 'error: timed out waiting for the condition\n' } },
        { id: 'restore-fails', args: patchArgs('pv-db-data', RESTORE('Retain')), respond: { error: 'Forbidden' } },
      ],
    });
    cluster.seed([...bound('db-data', { compose: 'db_data' })]);
    const error = await expectCliError(volumesOf(kube).remove(scope(), ['db-data']), { type: VolumeRemovalError });
    expect(error.report.deleted).toEqual([]);
    expect(error.report.restored).toEqual([]);
    expect(error.report.restoreFailed).toHaveLength(1);
    expect(error.report.restoreFailed[0]).toMatchObject({ volume: 'pv-db-data', policy: 'Delete' });
    expect(error.report.restoreFailed[0].error).toContain('Forbidden');
    expect(error.suggestion).toContain(
      'Persistent volume pv-db-data is still set to reclaim Delete (kubectl patch failed on server_1 (exit 1): ',
    );
    expect(error.suggestion).toContain('set it back to Retain from `dockflow ssh production` before anything releases its claim.');
    kube.assertDone();
    const violations = checkExecutorInvariants({ kube, redactor, allow: { volumeDeletion: true }, volumes: cluster });
    expect(violations.map((violation) => violation.id)).toEqual(['INV-04b']);
    expect(violations[0].message).toContain('PV pv-db-data');
    cluster.assertNoProblems();
  });

  it('a lost connection on the Delete patch is reported as an unknown outcome and the PV is restored', async () => {
    const { cluster, kube } = onCluster({
      volumeDeletion: true,
      script: [{ id: 'lost', args: patchArgs('pv-db-data', TO_DELETE), respond: { transportError: true } }],
    });
    cluster.seed([...bound('db-data', { compose: 'db_data' })]);
    const error = await expectCliError(volumesOf(kube).remove(scope(), ['db-data']), {
      type: VolumeRemovalError,
      message: /^Deleting volume db-data was interrupted \(Lost the SSH connection to server_1 during kubectl patch: read ECONNRESET\); its outcome is unknown$/,
    });
    expect(error.report.restored).toEqual(['pv-db-data']);
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: null, phase: 'Released' });
    kube.assertDone();
  });

  it('a pending claim is deleted and nothing is patched', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([claim('cache', { compose: 'cache', volume: null })]);
    const report = await volumesOf(kube).remove(scope(), ['cache']);
    expect(report.deleted).toEqual([{ claim: 'cache', volume: null }]);
    expect(mutations(kube)).toEqual([deleteClaimArgs('cache').join(' ')]);
    expect(cluster.get('PersistentVolumeClaim', 'cache', NS)).toBeUndefined();
    kube.assertDone();
  });

  it('resolves a compose key (and a claim template) to every claim it names, one at a time', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([
      ...bound('data-db-0', { compose: 'db_data', template: 'data' }),
      ...bound('data-db-1', { compose: 'db_data', template: 'data', node: 'agent-1' }),
      ...bound('logs-db-0', { compose: 'db_logs', template: 'logs' }),
      ...bound('uploads', { role: 'app', compose: 'uploads' }),
    ]);
    const backend = volumesOf(kube);
    const byKey = await backend.remove(scope(), ['db_data']);
    expect(byKey.deleted.map((entry) => entry.claim)).toEqual(['data-db-0', 'data-db-1']);
    const byTemplate = await backend.remove(scope(), ['logs']);
    expect(byTemplate.deleted.map((entry) => entry.claim)).toEqual(['logs-db-0']);
    expect(deletionSteps(kube)).toEqual([
      'claim data-db-0',
      'Delete pv-data-db-0',
      'gone pv-data-db-0',
      'claim data-db-1',
      'Delete pv-data-db-1',
      'gone pv-data-db-1',
      'claim logs-db-0',
      'Delete pv-logs-db-0',
      'gone pv-logs-db-0',
    ]);
    expect(cluster.list('PersistentVolumeClaim', { namespace: NS }).map((pvc) => pvc.metadata.name)).toEqual(['uploads']);
    kube.assertDone();
  });

  it('derives the delete wait from the grace period of the pods referencing the claim; an unscheduled one does not block', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('db-data', { compose: 'db_data' })]);
    // 300 s of grace raises the budget; unscheduled, it holds neither the claim nor pvc-protection
    cluster.seed([pod('db-0', { claims: ['db-data'], compose: 'db', node: null, grace: 300 })], { reconcile: false });
    const report = await volumesOf(kube).remove(scope(), ['db-data']);
    expect(report.deleted).toEqual([{ claim: 'db-data', volume: 'pv-db-data' }]);
    expect(mutations(kube)).toEqual([
      patchArgs('pv-db-data', RECORD('Retain')).join(' '),
      deleteClaimArgs('db-data', 330).join(' '),
      patchArgs('pv-db-data', TO_DELETE).join(' '),
    ]);
    expect(executed(kube).find((call) => call.call.args[0] === 'wait')?.call.args).toEqual(waitGoneArgs('pv-db-data', 330));
    const claimDelete = executed(kube).find((call) => call.call.args[0] === 'delete');
    expect(claimDelete?.call.guardS).toBe(360);
    expect(pvState(cluster, 'pv-db-data')).toBeNull();
    kube.assertDone();
  });

  it('a PV whose class already deletes data is not patched: claim, then wait for the PV', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('scratch', { compose: 'scratch', policy: 'Delete', storageClass: 'fast-ssd' })]);
    const report = await volumesOf(kube).remove(scope(), ['scratch']);
    expect(report.deleted).toEqual([{ claim: 'scratch', volume: 'pv-scratch' }]);
    expect(mutations(kube)).toEqual([deleteClaimArgs('scratch').join(' ')]);
    expect(deletionSteps(kube)).toEqual(['claim scratch', 'gone pv-scratch']);
    expect(pvState(cluster, 'pv-scratch')).toBeNull();
    kube.assertDone();
  });

  it('lost-node rule: the ACME claim on a node gone from the cluster is deleted and its PV kept Released with Retain', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('dockflow-traefik', { role: null, namespace: SYSTEM, node: 'server-9' })]);
    // the recovery of design-04 2.6.1: the proxy pod cannot be scheduled while its claim is pinned
    // to the dead node, so it mounts nothing and neither the in-use refusal nor pvc-protection fires
    cluster.seed([pod('dockflow-traefik-0', { claims: ['dockflow-traefik'], namespace: SYSTEM, node: null, nodeSelector: { [KUBE_KEYS.hostname]: 'server-9' } })], {
      reconcile: false,
    });
    const notices = new Notices();
    const backend = volumesOf(kube, notices);
    expect((await backend.list(scope({ namespace: SYSTEM }))).map((info) => [info.name, info.usedBy])).toEqual([['dockflow-traefik', []]]);
    await expectCliError(backend.remove(scope(), ['dockflow-traefik']), {
      type: ValidationError,
      message: `Volume dockflow-traefik not found in ${NS}`,
    });
    const report = await backend.remove(scope({ namespace: SYSTEM }), ['dockflow-traefik']);
    expect(report).toEqual({
      deleted: [],
      restored: [],
      restoreFailed: [],
      keptOnLostNode: [{ claim: 'dockflow-traefik', volume: 'pv-dockflow-traefik', node: 'server-9' }],
    });
    expect(lostNodeLine(report.keptOnLostNode[0])).toBe(
      'Volume dockflow-traefik was on node server-9, which is no longer in the cluster; its claim was deleted and PersistentVolume pv-dockflow-traefik is kept as Released',
    );
    // the core report has no field for it, so the command hears it through the notices
    expect(notices.warnings).toEqual([
      {
        message: lostNodeLine(report.keptOnLostNode[0]),
        suggestion:
          'Delete persistent volume pv-dockflow-traefik by hand once node server-9 is gone for good; `dockflow volumes list production --system` shows it until then.',
      },
    ]);
    expect(mutations(kube)).toEqual([deleteClaimArgs('dockflow-traefik').join(' ')]);
    expect(cluster.get('PersistentVolumeClaim', 'dockflow-traefik', SYSTEM)).toBeUndefined();
    cluster.tick(3);
    expect(pvState(cluster, 'pv-dockflow-traefik')).toEqual({ policy: 'Retain', recorded: null, phase: 'Released' });
    kube.assertDone();
  });

  it('removes the ACME claim of a live node with namespace dockflow-system', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('dockflow-traefik', { role: null, namespace: SYSTEM })]);
    const report = await volumesOf(kube).remove(scope({ namespace: SYSTEM }), ['dockflow-traefik']);
    expect(report.deleted).toEqual([{ claim: 'dockflow-traefik', volume: 'pv-dockflow-traefik' }]);
    expect(pvState(cluster, 'pv-dockflow-traefik')).toBeNull();
    kube.assertDone();
  });

  it('CLI killed after recording: the next listing restores the evidence and warns', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('cache-data', { compose: 'cache_data' })]);
    const killed = new KilledAt(kube, (args) => args[0] === 'delete');
    await expect(volumesOf(kube, new Notices(), killed).remove(scope(), ['db-data', 'cache-data'])).rejects.toBeInstanceOf(VolumeRemovalError);
    // what a killed CLI leaves: evidence on both PVs, nothing deleted, no policy changed
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Retain', recorded: 'Retain', phase: 'Bound' });
    expect(pvState(cluster, 'pv-cache-data')).toEqual({ policy: 'Retain', recorded: 'Retain', phase: 'Bound' });

    const notices = new Notices();
    const infos = await volumesOf(kube, notices).list(scope());
    expect(infos.map((info) => [info.name, info.reclaimPolicy])).toEqual([
      ['cache-data', 'Retain'],
      ['db-data', 'Retain'],
    ]);
    expect(notices.warnings.map((warning) => warning.message)).toEqual([
      'Volume cache-data: reclaim policy restored to Retain; a previous volume deletion was interrupted',
      'Volume db-data: reclaim policy restored to Retain; a previous volume deletion was interrupted',
    ]);
    expect(pvState(cluster, 'pv-db-data')?.recorded).toBeNull();
    expect(pvState(cluster, 'pv-cache-data')?.recorded).toBeNull();
    kube.assertDone();
  });

  it('CLI killed after the Delete patch: only that claim-less PV goes, the next listing repairs the other', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('db-data', { compose: 'db_data' }), ...bound('cache-data', { compose: 'cache_data' })]);
    const killed = new KilledAt(kube, (args) => args[0] === 'wait');
    await expect(volumesOf(kube, new Notices(), killed).remove(scope(), ['db-data', 'cache-data'])).rejects.toBeInstanceOf(VolumeRemovalError);
    expect(pvState(cluster, 'pv-db-data')).toEqual({ policy: 'Delete', recorded: 'Retain', phase: 'Released' });
    cluster.tick(2);
    expect(pvState(cluster, 'pv-db-data')).toBeNull();

    const notices = new Notices();
    const infos = await volumesOf(kube, notices).list(scope());
    expect(infos.map((info) => [info.name, info.reclaimPolicy])).toEqual([['cache-data', 'Retain']]);
    expect(notices.warnings.map((warning) => warning.message)).toEqual([
      'Volume cache-data: reclaim policy restored to Retain; a previous volume deletion was interrupted',
    ]);
    kube.assertDone();
  });

  it('no names: nothing is read or changed', async () => {
    const kube = scripted([]);
    expect(await volumesOf(kube).remove(scope(), [])).toEqual({ deleted: [], restored: [], restoreFailed: [], keptOnLostNode: [] });
    kube.assertDone();
  });
});

// ---------------------------------------------------------------------------
// removeVolumesByProtocol (the stack and chart callers)
// ---------------------------------------------------------------------------

describe('removeVolumesByProtocol', () => {
  it('puts an interrupted run back to its recorded policy before touching the claim', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([...bound('db-data', { compose: 'db_data', policy: 'Delete', recorded: 'Retain' })]);
    const report = await removeVolumesByProtocol({ kubectl: kube }, [{ claim: 'db-data', volume: null }], { namespace: NS, env: 'production' });
    expect(report.deleted).toEqual([{ claim: 'db-data', volume: 'pv-db-data' }]);
    expect(mutations(kube)).toEqual([
      patchArgs('pv-db-data', JSON.stringify({ metadata: { annotations: { [P_BEFORE]: 'Retain' } }, spec: { persistentVolumeReclaimPolicy: 'Retain' } })).join(
        ' ',
      ),
      deleteClaimArgs('db-data').join(' '),
      patchArgs('pv-db-data', TO_DELETE).join(' '),
    ]);
    expect(pvState(cluster, 'pv-db-data')).toBeNull();
    kube.assertDone();
  });

  it('a PV released by a chart uninstall is deleted by name; a claim still bound to it goes first', async () => {
    const { cluster, kube } = onCluster({ volumeDeletion: true });
    cluster.seed([
      volume('pv-released', { claim: 'data-postgres-0', phase: 'Released' }),
      ...bound('data-postgres-1', { role: null }),
    ]);
    const report = await removeVolumesByProtocol(
      { kubectl: kube },
      [
        { claim: 'data-postgres-0', volume: 'pv-released' },
        { claim: null, volume: 'pv-data-postgres-1' },
      ],
      { namespace: NS, env: 'production', waitS: 150 },
    );
    expect(report.deleted).toEqual([
      { claim: 'pv-released', volume: 'pv-released' },
      { claim: 'data-postgres-1', volume: 'pv-data-postgres-1' },
    ]);
    expect(deletionSteps(kube)).toEqual([
      'Delete pv-released',
      'gone pv-released',
      'claim data-postgres-1',
      'Delete pv-data-postgres-1',
      'gone pv-data-postgres-1',
    ]);
    expect(mutations(kube)).toContain(deleteClaimArgs('data-postgres-1', 150).join(' '));
    expect(pvState(cluster, 'pv-released')).toBeNull();
    expect(pvState(cluster, 'pv-data-postgres-1')).toBeNull();
    kube.assertDone();
  });

  it('nothing to delete: no call', async () => {
    const kube = scripted([]);
    expect(await removeVolumesByProtocol({ kubectl: kube }, [], { namespace: NS, env: 'production' })).toEqual({
      deleted: [],
      restored: [],
      restoreFailed: [],
      keptOnLostNode: [],
    });
    kube.assertDone();
  });
});
