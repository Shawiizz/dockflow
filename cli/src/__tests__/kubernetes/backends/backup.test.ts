// design-06 4.3 and 10.7 (`backends/backup.test.ts`, U-BE-BACKUP-01..06, 08): kubectl exec pipelines
// for dump and restore (same node and the CLI relay), volume discovery from a running pod or the
// workload template, the backup helper pod (creation, collision retry, ready wait, stale sweep,
// always removed), the extract-beside-then-swap volume restore (K23) with the live replica re-check
// (R-23, exact wording, K24) and its two failure modes, and the restart wait after a redis restore.

import { afterEach, describe, expect, it } from 'bun:test';
import { posix } from 'path';
import { parse as parseYaml } from 'yaml';
import type { BackupFile, BackupVolume, ClusterNodeRef, StackRef, StackRole } from '../../../services/orchestrator/interfaces';
import { KubernetesBackupBackend } from '../../../services/orchestrator/kubernetes/backends/backup';
import { createInventoryReader, INVENTORY_RESOURCES } from '../../../services/orchestrator/kubernetes/backends/inventory';
import { ANNOTATIONS, LABELS, PARTS } from '../../../services/orchestrator/kubernetes/constants';
import type { K8sDistribution } from '../../../services/orchestrator/kubernetes/distribution';
import { kubectlCommand, type KubectlResult } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { buildCapturePipeline, buildDiscardScript, buildExtractScript, buildSwapScript } from '../../../services/backup-strategies';
import { shortHash } from '../../../utils/hash';
import { BackupError, ErrorCode, UnsupportedOperationError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { fakeNode, FakeKubeExecutor, type KubeStep } from '../fakes/fake-kube-executor';
import { FakeNodeShell, type NodeShellStep } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';
import { expectCliError } from '../support/matchers';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const APP: StackRef = { project: 'shop', env: 'production', role: 'app' };
const ACC: StackRef = { ...APP, role: 'accessory' };
/** the fake's default distribution, so command strings are built exactly as the executor builds them */
const DISTRIBUTION: K8sDistribution = new FakeKubeExecutor({ redactor: new Redactor([]) }).distribution;
const HELPER_IMAGE = DISTRIBUTION.traits.helperImage;

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

function composeLabels(role: StackRole, serviceName: string): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'dockflow',
    [`${P}/stack`]: NS,
    [`${P}/role`]: role,
    [`${P}/service`]: serviceName,
    [`${P}/part`]: 'stack',
  };
}

function templateLabels(role: StackRole, serviceName: string): Record<string, string> {
  return { [`${P}/stack`]: NS, [`${P}/role`]: role, [`${P}/service`]: serviceName };
}

function template(container: string, volumes?: Obj[], mounts?: Obj[]): Obj {
  return {
    metadata: {},
    spec: { containers: [{ name: container, image: `registry.example.com/shop/${container}:1.4.2`, volumeMounts: mounts }], volumes },
  };
}

interface WorkloadOptions {
  replicas?: number;
  volumes?: Obj[];
  mounts?: Obj[];
  graceSeconds?: number;
}

function deployment(service: string, role: StackRole, o: WorkloadOptions = {}): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: service, namespace: NS, uid: `uid-${service}`, labels: composeLabels(role, service), annotations: { [`${P}/compose-service`]: service } },
    spec: {
      replicas: o.replicas ?? 1,
      selector: {},
      template: { ...template(service, o.volumes, o.mounts), spec: { ...(template(service, o.volumes, o.mounts).spec as Obj), terminationGracePeriodSeconds: o.graceSeconds } },
    },
  };
}

function statefulSet(service: string, role: StackRole, o: WorkloadOptions = {}): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: service, namespace: NS, uid: `uid-${service}`, labels: composeLabels(role, service), annotations: { [`${P}/compose-service`]: service } },
    spec: { replicas: o.replicas ?? 1, serviceName: service, selector: {}, template: template(service, o.volumes, o.mounts) },
  };
}

function daemonSet(service: string, role: StackRole): Obj {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: service, namespace: NS, uid: `uid-${service}`, labels: composeLabels(role, service), annotations: { [`${P}/compose-service`]: service } },
    spec: { selector: {}, template: template(service) },
  };
}

interface PodOptions {
  ready?: boolean;
  node?: string;
  restarts?: number;
  volumes?: Obj[];
  mounts?: Obj[];
}

function composePod(service: string, role: StackRole, o: PodOptions = {}): Obj {
  const ready = o.ready ?? true;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${service}-abc12-x1x1x`,
      namespace: NS,
      uid: `uid-${service}-pod`,
      labels: templateLabels(role, service),
      // direct StatefulSet ownership (podController): the pod's own workload is a StatefulSet named `service`
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: service, uid: `uid-${service}`, controller: true }],
    },
    spec: {
      nodeName: o.node ?? 'worker-1',
      containers: [{ name: service, image: `registry.example.com/shop/${service}:1.4.2`, volumeMounts: o.mounts }],
      volumes: o.volumes,
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: service, ready, restartCount: o.restarts ?? 0, image: `registry.example.com/shop/${service}:1.4.2`, state: ready ? { running: {} } : { waiting: { reason: 'ContainerCreating' } } },
      ],
    },
  };
}

function pvc(name: string, o: { composeVolume?: string; volumeName?: string; accessModes?: string[] } = {}): Obj {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: NS, ...(o.composeVolume ? { annotations: { [ANNOTATIONS.composeVolume]: o.composeVolume } } : {}) },
    spec: { accessModes: o.accessModes ?? ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local', volumeName: o.volumeName },
    status: { phase: 'Bound', accessModes: o.accessModes ?? ['ReadWriteOnce'] },
  };
}

function pv(name: string, o: { node?: string } = {}): Obj {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name },
    spec: {
      capacity: { storage: '1Gi' },
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'dockflow-local',
      ...(o.node ? { nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [o.node] }] }] } } } : {}),
    },
    status: { phase: 'Bound' },
  };
}

function helperPod(name: string, ready: boolean): Obj {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: NS, labels: { 'app.kubernetes.io/managed-by': 'dockflow', [LABELS.stack]: NS, [LABELS.part]: PARTS.helper } },
    spec: { nodeName: 'server_1', containers: [{ name: 'helper', image: HELPER_IMAGE }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'helper', ready, restartCount: 0, image: HELPER_IMAGE, state: ready ? { running: {} } : { waiting: {} } }] },
  };
}

function list(items: Obj[]): { json: Obj } {
  return { json: { apiVersion: 'v1', kind: 'List', items } };
}

function result(exitCode: number, stdout = '', stderr = ''): KubectlResult {
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cmd(args: string[], namespace = NS): string {
  return kubectlCommand(DISTRIBUTION, { args, namespace, requestTimeoutS: null });
}

const HELPER_SELECTOR = `${LABELS.part}=${PARTS.helper}`;

function sweepStep(items: Obj[] = []): KubeStep {
  return { id: 'sweep', method: 'getJson', namespace: NS, args: ['get', 'pods', '-l', HELPER_SELECTOR, '-o', 'json'], respond: list(items) };
}

function createStep(id: string, respond: KubeStep['respond']): KubeStep {
  return { id, method: 'create', namespace: NS, args: ['create', '-f', '-'], respond };
}

function deleteHelperStep(name: string, wait: boolean, respond: KubeStep['respond'] = result(0), extra: Partial<KubeStep> = {}): KubeStep {
  const args = wait ? ['delete', `pods/${name}`, '--ignore-not-found', '--wait=true', '--timeout=30s'] : ['delete', `pods/${name}`, '--ignore-not-found', '--wait=false'];
  return { method: 'delete', namespace: NS, args, respond, ...extra };
}

function readyStep(name: string, pod: Obj, times: number | 'any' = 1): KubeStep {
  return { id: `ready ${name}`, method: 'getJson', namespace: NS, args: ['get', 'pods', name, '--ignore-not-found', '-o', 'json'], respond: list([pod]), times };
}

interface Harness {
  kube: FakeKubeExecutor;
  nodeShell: FakeNodeShell;
  backend: KubernetesBackupBackend;
  clock: FakeClock;
}

const createdKube: FakeKubeExecutor[] = [];
const createdNodeShell: FakeNodeShell[] = [];

afterEach(() => {
  const kubes = createdKube.splice(0);
  for (const kube of kubes) if (!kube.asserted) kube.assertDone();
  const nodeShells = createdNodeShell.splice(0);
  for (const nodeShell of nodeShells) if (!nodeShell.asserted) nodeShell.assertDone();
  assertExecutorInvariants({ kube: kubes, nodeShell: nodeShells });
});

function harness(items: Obj[], script: KubeStep[] = [], options: { nodeShellSteps?: NodeShellStep[] } = {}): Harness {
  const clock = new FakeClock();
  const redactor = new Redactor([]);
  const inventory: KubeStep = {
    id: 'inventory',
    method: 'getJson',
    namespace: NS,
    args: ['get', INVENTORY_RESOURCES.join(','), '-o', 'json'],
    respond: list(items),
    optional: true,
    times: 'any',
  };
  const kube = new FakeKubeExecutor({ redactor, script: [inventory, ...script], order: 'any', clock });
  createdKube.push(kube);
  const nodeShell = new FakeNodeShell(options.nodeShellSteps ?? [], { redactor });
  createdNodeShell.push(nodeShell);
  const backend = new KubernetesBackupBackend({
    deps: { kubectl: kube, nodeShell: nodeShell.forNode, clock, redactor, distribution: kube.distribution },
    inventory: createInventoryReader({ kubectl: kube, helm: null }),
    env: 'production',
    serverNames: ['server_1', 'worker_1'],
  });
  return { kube, nodeShell, backend, clock };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

async function settle<T>(promise: Promise<T>, clock: FakeClock, maxMs = 130_000): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await clock.runUntilIdle(maxMs);
  return outcome;
}

const WEB: BackupFile['node'] = fakeNode('server_1');
const OTHER_NODE: ClusterNodeRef = fakeNode('server_2');

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

describe('dump', () => {
  const POD = 'db-abc12-x1x1x';

  it('U-BE-BACKUP-01: streams kubectl exec stdout through gzip into the remote path, with umask 077', async () => {
    const items = [statefulSet('db', 'accessory'), composePod('db', 'accessory')];
    const producer = cmd(['exec', POD, '-c', 'db', '--', 'sh', '-c', 'pg_dump db'], NS);
    const script = buildCapturePipeline(producer, '/var/lib/dockflow/backups/shop-production-accessories/db/id.sql.gz', true);
    const h = harness(items, [{ method: 'shell', args: [script], respond: result(0) }]);
    const file = await h.backend.dump(ACC, { service: 'db' }, 'pg_dump db', '/var/lib/dockflow/backups/shop-production-accessories/db/id.sql.gz', { gzip: true });
    expect(file).toEqual({ node: h.kube.node, remotePath: '/var/lib/dockflow/backups/shop-production-accessories/db/id.sql.gz' });
    expect(script).toStartWith('umask 077 && mkdir -p');
    expect(script).toContain(' | gzip -c > ');
  });

  it('a non-zero exit removes the partial file and reports the redacted stderr', async () => {
    const items = [statefulSet('db', 'accessory'), composePod('db', 'accessory')];
    const producer = cmd(['exec', POD, '-c', 'db', '--', 'sh', '-c', 'pg_dump db'], NS);
    const remotePath = '/var/lib/dockflow/backups/shop-production-accessories/db/id.sql';
    const script = buildCapturePipeline(producer, remotePath, false);
    const h = harness(items, [
      { method: 'shell', args: [script], respond: result(1, '', 'pg_dump: error: connection failed') },
      { method: 'shell', args: [`rm -f -- '${remotePath}'`], respond: result(0) },
    ]);
    const error = await failure(h.backend.dump(ACC, { service: 'db' }, 'pg_dump db', remotePath, { gzip: false }));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('Backup of db failed (exit 1): pg_dump: error: connection failed');
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('restore', () => {
  const POD = 'db-abc12-x1x1x';

  it('U-BE-BACKUP-02: streams the file into exec -i stdin on the control-plane node, stripping the terminated line', async () => {
    const items = [statefulSet('db', 'accessory'), composePod('db', 'accessory')];
    const consumer = cmd(['exec', '-i', POD, '-c', 'db', '--', 'sh', '-c', 'psql db'], NS);
    const script = `gunzip -c '/backups/id.sql.gz' | ${consumer}`;
    const h = harness(items, [{ method: 'shell', args: [script], respond: result(1, '', 'restore failed here\ncommand terminated with exit code 1\n') }]);
    const outcome = await h.backend.restore(ACC, { service: 'db' }, 'psql db', { node: WEB, remotePath: '/backups/id.sql.gz' }, { gunzip: true });
    expect(outcome).toEqual({ exitCode: 1, stderr: 'restore failed here\n' });
  });

  it('relays the file through the CLI when it is on another node, redacting stderr and stopping the read on failure', async () => {
    const items = [statefulSet('db', 'accessory'), composePod('db', 'accessory')];
    const consumer = cmd(['exec', '-i', POD, '-c', 'db', '--', 'sh', '-c', 'psql db'], NS);
    const h = harness(
      items,
      [{ method: 'channel', args: [consumer], respond: result(0, '', 'noise') }],
      {
        nodeShellSteps: [{ node: 'server_2', kind: 'channel', script: /^gunzip -c/, respond: { exitCode: 0 } }],
      },
    );
    const outcome = await h.backend.restore(ACC, { service: 'db' }, 'psql db', { node: OTHER_NODE, remotePath: '/backups/id.sql.gz' }, { gunzip: true });
    expect(outcome).toEqual({ exitCode: 0, stderr: 'noise' });
  });

  it('a source that cannot be read is a BackupError, whatever the consumer channel concludes', async () => {
    const items = [statefulSet('db', 'accessory'), composePod('db', 'accessory')];
    const consumer = cmd(['exec', '-i', 'db-abc12-x1x1x', '-c', 'db', '--', 'sh', '-c', 'psql db'], NS);
    const h = harness(items, [{ method: 'channel', args: [consumer], respond: result(1, '', 'psql: fatal: empty input') }], {
      nodeShellSteps: [{ node: 'server_2', kind: 'channel', script: /^cat /, respond: { exitCode: 1, stderr: 'No such file or directory' } }],
    });
    const error = await failure(h.backend.restore(ACC, { service: 'db' }, 'psql db', { node: OTHER_NODE, remotePath: '/backups/missing.sql' }, { gunzip: false }));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('Cannot read backup file /backups/missing.sql on server_2: No such file or directory');
  });
});

// ---------------------------------------------------------------------------
// volumes
// ---------------------------------------------------------------------------

describe('volumes', () => {
  it('U-BE-BACKUP-03: PVC and read-write bind mounts of the running pod, excluding by name, source and mount path', async () => {
    const podVolumes = [
      { name: 'data', persistentVolumeClaim: { claimName: 'db-data' } },
      { name: 'uploads', hostPath: { path: '/srv/uploads' } },
      { name: 'ro', hostPath: { path: '/srv/readonly' } },
      { name: 'cfg', configMap: { name: 'db-cfg' } },
    ];
    const mounts = [
      { name: 'data', mountPath: '/var/lib/postgresql/data' },
      { name: 'uploads', mountPath: '/srv/uploads' },
      { name: 'ro', mountPath: '/srv/readonly', readOnly: true },
      { name: 'cfg', mountPath: '/etc/db' },
    ];
    const items = [
      statefulSet('db', 'accessory'),
      composePod('db', 'accessory', { volumes: podVolumes, mounts }),
      pvc('db-data', { composeVolume: 'data', volumeName: 'pv-data', accessModes: ['ReadWriteOnce'] }),
      pv('pv-data', { node: 'worker-1' }),
    ];
    const claimStep: KubeStep = {
      id: 'claim',
      method: 'getJson',
      namespace: NS,
      args: ['get', 'persistentvolumeclaims', 'db-data', '--ignore-not-found', '-o', 'json'],
      respond: list([pvc('db-data', { composeVolume: 'data', volumeName: 'pv-data', accessModes: ['ReadWriteOnce'] })]),
      times: 2,
    };
    const pvStep: KubeStep = {
      id: 'pv',
      method: 'getJson',
      args: ['get', 'persistentvolumes', 'pv-data', '--ignore-not-found', '-o', 'json'],
      respond: list([pv('pv-data', { node: 'worker-1' })]),
      times: 2,
    };
    const h = harness(items, [claimStep, pvStep]);
    const volumes = await h.backend.volumes(ACC, 'db', { includeBindMounts: true, exclude: [] });
    expect(volumes).toEqual([
      { name: 'data', kind: 'volume', source: 'db-data', mountPath: '/var/lib/postgresql/data', node: 'worker_1' },
      { name: 'srv-uploads', kind: 'bind', source: '/srv/uploads', mountPath: '/srv/uploads', node: 'worker_1' },
    ]);
    const excluded = await h.backend.volumes(ACC, 'db', { includeBindMounts: true, exclude: ['/srv/uploads'] });
    expect(excluded).toEqual([{ name: 'data', kind: 'volume', source: 'db-data', mountPath: '/var/lib/postgresql/data', node: 'worker_1' }]);
  });

  it('refuses a ReadWriteOncePod claim while the pod is running (R-15)', async () => {
    const podVolumes = [{ name: 'data', persistentVolumeClaim: { claimName: 'db-data' } }];
    const mounts = [{ name: 'data', mountPath: '/data' }];
    const items = [
      statefulSet('db', 'accessory'),
      composePod('db', 'accessory', { volumes: podVolumes, mounts }),
      pvc('db-data', { accessModes: ['ReadWriteOncePod'] }),
    ];
    const claimStep: KubeStep = {
      id: 'claim',
      method: 'getJson',
      namespace: NS,
      args: ['get', 'persistentvolumeclaims', 'db-data', '--ignore-not-found', '-o', 'json'],
      respond: list([pvc('db-data', { accessModes: ['ReadWriteOncePod'] })]),
    };
    const h = harness(items, [claimStep]);
    const error = await expectCliError(h.backend.volumes(ACC, 'db', { includeBindMounts: false, exclude: [] }), {
      type: UnsupportedOperationError,
      message: 'Volume db-data of service db is ReadWriteOncePod and cannot be read while db runs',
      suggestion: 'Stop it with `dockflow accessories stop production db`, run the backup, then `dockflow accessories restart production db`.',
    });
    expect(error).toBeDefined();
  });

  it('falls back to the workload pod template when no instance is running', async () => {
    const podVolumes = [{ name: 'data', persistentVolumeClaim: { claimName: 'db-data' } }];
    const mounts = [{ name: 'data', mountPath: '/data' }];
    const items = [deployment('db', 'accessory', { volumes: podVolumes, mounts })];
    const claimStep: KubeStep = {
      id: 'claim',
      method: 'getJson',
      namespace: NS,
      args: ['get', 'persistentvolumeclaims', 'db-data', '--ignore-not-found', '-o', 'json'],
      respond: list([]),
    };
    const h = harness(items, [claimStep]);
    const volumes = await h.backend.volumes(ACC, 'db', { includeBindMounts: false, exclude: [] });
    expect(volumes).toEqual([{ name: 'db-data', kind: 'volume', source: 'db-data', mountPath: '/data', node: null }]);
  });
});

// ---------------------------------------------------------------------------
// archiveVolumes
// ---------------------------------------------------------------------------

describe('archiveVolumes', () => {
  const VOLUMES: BackupVolume[] = [{ name: 'data', kind: 'volume', source: 'db-data', mountPath: '/var/lib/postgresql/data', node: null }];
  const PREFIX = '/var/lib/dockflow/backups/shop-production-accessories/db/20260101-000000-aaaa';
  const ID8 = shortHash(PREFIX, 8);
  const HELPER = `dockflow-helper-backup-${ID8}`;

  it('U-BE-BACKUP-04: creates a read-only helper pod, tars each volume through it, and always removes it (INV-12)', async () => {
    const items = [deployment('db', 'accessory')];
    const producer = cmd(['exec', HELPER, '-c', 'helper', '--', 'tar', 'cf', '-', '-C', '/dockflow/v0', '.'], NS);
    const script = buildCapturePipeline(producer, `${PREFIX}.data.tar.gz`, true);
    let created: Obj | undefined;
    const h = harness(items, [
      sweepStep([]),
      createStep('create', (call) => {
        created = parseYaml(String(call.stdin)) as Obj;
        return result(0);
      }),
      readyStep(HELPER, helperPod(HELPER, true)),
      { method: 'shell', args: [script], respond: result(0) },
      deleteHelperStep(HELPER, false),
    ]);
    const files = await h.backend.archiveVolumes(ACC, 'db', VOLUMES, PREFIX, { gzip: true });
    expect(files).toEqual([{ node: h.kube.node, remotePath: `${PREFIX}.data.tar.gz` }]);

    expect(created).toBeDefined();
    const manifest = created as Obj;
    expect(manifest.kind).toBe('Pod');
    const metadata = manifest.metadata as Obj;
    expect(metadata.name).toBe(HELPER);
    expect((metadata.labels as Obj)[LABELS.part]).toBe(PARTS.helper);
    expect((metadata.annotations as Obj)[ANNOTATIONS.composeService]).toBe('db');
    const spec = manifest.spec as Obj;
    expect(spec.nodeName).toBeUndefined();
    expect(spec.tolerations).toEqual([
      { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
      { key: 'node-role.kubernetes.io/master', operator: 'Exists', effect: 'NoSchedule' },
      { key: 'CriticalAddonsOnly', operator: 'Exists' },
    ]);
    const containers = spec.containers as Obj[];
    expect(containers[0].image).toBe(HELPER_IMAGE);
    const volumes = spec.volumes as Obj[];
    expect((volumes[0].persistentVolumeClaim as Obj).readOnly).toBe(true);
  });

  it('a name collision deletes the existing helper and retries once; a second collision is an error', async () => {
    const items = [deployment('db', 'accessory')];
    const h = harness(items, [
      sweepStep([]),
      createStep('create-1', { exitCode: 1, stdout: '', stderr: '(AlreadyExists) pods "dockflow-helper-backup" already exists' }),
      deleteHelperStep(HELPER, true),
      createStep('create-2', { exitCode: 1, stdout: '', stderr: '(AlreadyExists) pods "dockflow-helper-backup" already exists' }),
    ]);
    const error = await failure(h.backend.archiveVolumes(ACC, 'db', VOLUMES, PREFIX, { gzip: true }));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('A backup helper pod for db already exists and could not be replaced');
  });

  it('the stale sweep removes a Succeeded or long-running helper before creating a new one', async () => {
    const items = [deployment('db', 'accessory')];
    const oldHelper = { ...helperPod('dockflow-helper-backup-stale', true), status: { phase: 'Succeeded' } };
    const producer = cmd(['exec', HELPER, '-c', 'helper', '--', 'tar', 'cf', '-', '-C', '/dockflow/v0', '.'], NS);
    const script = buildCapturePipeline(producer, `${PREFIX}.data.tar.gz`, true);
    const h = harness(items, [
      sweepStep([oldHelper]),
      { method: 'delete', namespace: NS, args: ['delete', 'pods/dockflow-helper-backup-stale', '--ignore-not-found', '--wait=false'], respond: result(0) },
      createStep('create', result(0)),
      readyStep(HELPER, helperPod(HELPER, true)),
      { method: 'shell', args: [script], respond: result(0) },
      deleteHelperStep(HELPER, false),
    ]);
    await h.backend.archiveVolumes(ACC, 'db', VOLUMES, PREFIX, { gzip: true });
  });

  it('a tar failure removes the partial file, still deletes the helper, and reports the volume', async () => {
    const items = [deployment('db', 'accessory')];
    const producer = cmd(['exec', HELPER, '-c', 'helper', '--', 'tar', 'cf', '-', '-C', '/dockflow/v0', '.'], NS);
    const remotePath = `${PREFIX}.data.tar.gz`;
    const script = buildCapturePipeline(producer, remotePath, true);
    const h = harness(items, [
      sweepStep([]),
      createStep('create', result(0)),
      readyStep(HELPER, helperPod(HELPER, true)),
      { method: 'shell', args: [script], respond: result(1, '', 'tar: short read') },
      { method: 'shell', args: [`rm -f -- '${remotePath}'`], respond: result(0) },
      deleteHelperStep(HELPER, false),
    ]);
    const error = await failure(h.backend.archiveVolumes(ACC, 'db', VOLUMES, PREFIX, { gzip: true }));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('Backup failed for volume db-data: tar: short read');
  });

  it('two bind mounts on different nodes are refused before any mutating call', async () => {
    const items = [deployment('db', 'accessory')];
    const volumes: BackupVolume[] = [
      { name: 'a', kind: 'bind', source: '/srv/a', mountPath: '/a', node: 'worker_1' },
      { name: 'b', kind: 'bind', source: '/srv/b', mountPath: '/b', node: 'worker_2' },
    ];
    const h = harness(items, []);
    const error = await failure(h.backend.archiveVolumes(ACC, 'db', volumes, PREFIX, { gzip: true }));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('Bind mounts of db live on different nodes (worker_1, worker_2)');
    expect(h.kube.calls.some((c) => c.call.mutating)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restoreVolumes
// ---------------------------------------------------------------------------

describe('restoreVolumes', () => {
  const FILE_A: BackupFile = { node: WEB, remotePath: '/backups/shop-production-accessories/db/20260101-000000-bbbb.data.tar.gz' };
  const FILE_B: BackupFile = { node: WEB, remotePath: '/backups/shop-production-accessories/db/20260101-000000-bbbb.uploads.tar.gz' };
  const ID8 = shortHash(`${posix.dirname(FILE_A.remotePath)}/${posix.basename(FILE_A.remotePath).split('.')[0]}`, 8);
  const HELPER = `dockflow-helper-restore-${ID8}`;

  function archives(): { volume: BackupVolume; file: BackupFile }[] {
    return [
      { volume: { name: 'data', kind: 'volume', source: 'db-data', mountPath: '/var/lib/postgresql/data', node: null }, file: FILE_A },
      { volume: { name: 'uploads', kind: 'bind', source: '/srv/uploads', mountPath: '/srv/uploads', node: 'worker_1' }, file: FILE_B },
    ];
  }

  function liveStep(replicas: number, graceSeconds?: number): KubeStep {
    return {
      id: 'live',
      method: 'getJson',
      namespace: NS,
      args: ['get', 'deployments.apps', 'db', '--ignore-not-found', '-o', 'json'],
      respond: list([deployment('db', 'accessory', { replicas, graceSeconds })]),
    };
  }

  function extractStep(index: number, remotePath: string): KubeStep {
    const consumer = cmd(['exec', '-i', HELPER, '-c', 'helper', '--', 'sh', '-c', buildExtractScript(`/dockflow/v${index}`, ID8)], NS);
    return { method: 'shell', args: [`gunzip -c '${remotePath}' | ${consumer}`], respond: result(0) };
  }

  function swapStep(index: number): KubeStep {
    const script = cmd(['exec', HELPER, '-c', 'helper', '--', 'sh', '-c', buildSwapScript(`/dockflow/v${index}`, ID8)], NS);
    return { method: 'shell', args: [script], respond: result(0) };
  }

  function discardStep(index: number): KubeStep {
    const script = cmd(['exec', HELPER, '-c', 'helper', '--', 'sh', '-c', buildDiscardScript(`/dockflow/v${index}`, ID8)], NS);
    return { method: 'shell', args: [script], respond: result(0) };
  }

  /** `mapRestoreTargets` reads every current claim of the namespace to resolve each archive's PVC */
  function pvcListStep(claims: Obj[]): KubeStep {
    return { id: 'claims', method: 'getJson', namespace: NS, args: ['get', 'persistentvolumeclaims', '-o', 'json'], respond: list(claims) };
  }

  it('U-BE-BACKUP-05: stops the workload, extracts beside the data, swaps, then resumes; the helper is always removed', async () => {
    const items = [deployment('db', 'accessory'), pvc('db-data', { composeVolume: 'data' })];
    const h = harness(items, [
      liveStep(1),
      pvcListStep([pvc('db-data', { composeVolume: 'data' })]),
      sweepStep([]),
      createStep('create', result(0)),
      readyStep(HELPER, helperPod(HELPER, true)),
      { id: 'stop', method: 'run', namespace: NS, args: ['patch', 'deployment/db', '--type=merge', '-p', /"replicas":0/], respond: result(0) },
      { id: 'gone', method: 'getJson', namespace: NS, args: ['get', 'pods', '-l', `${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.service} in (db)`, '-o', 'json'], respond: list([]) },
      extractStep(0, FILE_A.remotePath),
      extractStep(1, FILE_B.remotePath),
      swapStep(0),
      swapStep(1),
      { id: 'resume', method: 'run', namespace: NS, args: ['patch', 'deployment/db', '--type=merge', '-p', /"replicas":1/], respond: result(0) },
      deleteHelperStep(HELPER, false),
    ]);
    await h.backend.restoreVolumes(ACC, 'db', archives());
  });

  it('U-BE-BACKUP-08: the live replica re-check refuses with R-23\'s exact wording, before any mutation', async () => {
    const items = [deployment('db', 'accessory')];
    const h = harness(items, [liveStep(2)]);
    const error = await expectCliError(h.backend.restoreVolumes(ACC, 'db', archives()), {
      type: UnsupportedOperationError,
      message: 'Service db runs 2 replicas; dockflow backup restore writes one replica only',
      suggestion: 'Set `deploy.replicas: 1` for db in accessories.yml and run `dockflow deploy production --accessories` first, restore, then set it back.',
    });
    expect(error).toBeDefined();
    const mutating = h.kube.calls.filter((c) => c.call.mutating);
    expect(mutating).toEqual([]);
  });

  it('U-BE-BACKUP-08 (app role): the suggestion names `dockflow scale`', async () => {
    const items = [deployment('web', 'app')];
    const h = harness(items, [
      {
        id: 'live',
        method: 'getJson',
        namespace: NS,
        args: ['get', 'deployments.apps', 'web', '--ignore-not-found', '-o', 'json'],
        respond: list([deployment('web', 'app', { replicas: 3 })]),
      },
    ]);
    const app: { volume: BackupVolume; file: BackupFile }[] = [{ volume: { name: 'data', kind: 'volume', source: 'web-data', mountPath: '/data', node: null }, file: FILE_A }];
    await expectCliError(h.backend.restoreVolumes(APP, 'web', app), {
      type: UnsupportedOperationError,
      message: 'Service web runs 3 replicas; dockflow backup restore writes one replica only',
      suggestion: 'Scale it to 1 first with `dockflow scale production web 1`, restore, then scale it back.',
    });
  });

  it('a DaemonSet is refused (R-16) before any read of the live object', async () => {
    const items = [daemonSet('agent', 'accessory')];
    const h = harness(items, []);
    const error = await expectCliError(h.backend.restoreVolumes(ACC, 'agent', archives()), {
      type: UnsupportedOperationError,
      message: 'Service agent runs as a DaemonSet and cannot be stopped for a volume restore',
      suggestion: 'Restore the files with `dockflow cp`, or use a database backup type.',
    });
    expect(error).toBeDefined();
  });

  it('an extraction failure leaves the data untouched: no swap call, discard runs, the workload resumes, and the helper is removed', async () => {
    const items = [deployment('db', 'accessory'), pvc('db-data', { composeVolume: 'data' })];
    const h = harness(items, [
      liveStep(1),
      pvcListStep([pvc('db-data', { composeVolume: 'data' })]),
      sweepStep([]),
      createStep('create', result(0)),
      readyStep(HELPER, helperPod(HELPER, true)),
      { id: 'stop', method: 'run', namespace: NS, args: ['patch', 'deployment/db', '--type=merge', '-p', /"replicas":0/], respond: result(0) },
      { id: 'gone', method: 'getJson', namespace: NS, args: ['get', 'pods', '-l', `${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.service} in (db)`, '-o', 'json'], respond: list([]) },
      { ...extractStep(0, FILE_A.remotePath), respond: result(1, '', 'tar: unexpected EOF') },
      discardStep(0),
      discardStep(1),
      { id: 'resume', method: 'run', namespace: NS, args: ['patch', 'deployment/db', '--type=merge', '-p', /"replicas":1/], respond: result(0) },
      deleteHelperStep(HELPER, false),
    ]);
    const error = await failure(h.backend.restoreVolumes(ACC, 'db', archives()));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toBe('Restore of db failed while reading the archive of volume data: tar: unexpected EOF; nothing was changed');
    const swaps = h.kube.calls.filter((c) => c.method === 'shell' && c.call.args[0].includes('rmdir'));
    expect(swaps).toEqual([]);
  });

  it('a swap failure leaves the workload stopped: no resume call, and the message names the old-contents directory', async () => {
    const items = [deployment('db', 'accessory'), pvc('db-data', { composeVolume: 'data' })];
    const h = harness(items, [
      liveStep(1),
      pvcListStep([pvc('db-data', { composeVolume: 'data' })]),
      sweepStep([]),
      createStep('create', result(0)),
      readyStep(HELPER, helperPod(HELPER, true)),
      { id: 'stop', method: 'run', namespace: NS, args: ['patch', 'deployment/db', '--type=merge', '-p', /"replicas":0/], respond: result(0) },
      { id: 'gone', method: 'getJson', namespace: NS, args: ['get', 'pods', '-l', `${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.service} in (db)`, '-o', 'json'], respond: list([]) },
      extractStep(0, FILE_A.remotePath),
      extractStep(1, FILE_B.remotePath),
      { ...swapStep(0), respond: result(1, '', 'mv: Device or resource busy') },
      deleteHelperStep(HELPER, false),
    ]);
    const error = await failure(h.backend.restoreVolumes(ACC, 'db', archives()));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.message).toContain('failed while swapping volume data');
    expect(error.message).toContain('the previous contents are in data/.dockflow-old-');
    const resumes = h.kube.calls.filter((c) => c.method === 'run' && c.call.args.some((arg) => typeof arg === 'string' && arg.includes('"replicas":1')));
    expect(resumes).toEqual([]);
  });

  it('does not stop with more than the desired replicas already at zero (an already-stopped service)', async () => {
    const items = [deployment('db', 'accessory'), pvc('db-data', { composeVolume: 'data' })];
    const h = harness(items, [
      liveStep(0),
      pvcListStep([pvc('db-data', { composeVolume: 'data' })]),
      sweepStep([]),
      createStep('create', result(0)),
      readyStep(HELPER, helperPod(HELPER, true)),
      extractStep(0, FILE_A.remotePath),
      extractStep(1, FILE_B.remotePath),
      swapStep(0),
      swapStep(1),
      deleteHelperStep(HELPER, false),
    ]);
    await h.backend.restoreVolumes(ACC, 'db', archives());
    expect(h.kube.calls.some((c) => c.method === 'run')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restartAfterRestore
// ---------------------------------------------------------------------------

describe('restartAfterRestore', () => {
  it('U-BE-BACKUP-06: returns once the remembered container restarted and is ready', async () => {
    const consumer = kubectlCommand(DISTRIBUTION, { args: ['exec', '-i', 'db-abc12-x1x1x', '-c', 'db', '--', 'sh', '-c', 'redis restore'], namespace: NS, requestTimeoutS: null });
    const items = [statefulSet('db', 'accessory'), composePod('db', 'accessory')];
    const notYet = composePod('db', 'accessory', { restarts: 0 });
    const restarted = composePod('db', 'accessory', { restarts: 1 });
    const h = harness(items, [
      { method: 'shell', args: [`cat '/backups/id.rdb' | ${consumer}`], respond: result(0) },
      {
        id: 'poll',
        method: 'getJson',
        namespace: NS,
        args: ['get', 'pods', '-l', `${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.service} in (db)`, '-o', 'json'],
        respond: list([notYet]),
        times: 1,
      },
      {
        id: 'poll2',
        method: 'getJson',
        namespace: NS,
        args: ['get', 'pods', '-l', `${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.service} in (db)`, '-o', 'json'],
        respond: list([restarted]),
      },
    ]);
    await h.backend.restore(ACC, { service: 'db' }, 'redis restore', { node: WEB, remotePath: '/backups/id.rdb' }, { gunzip: false });
    const outcome = await settle(h.backend.restartAfterRestore(ACC, 'db'), h.clock, 10_000);
    expect(outcome.ok).toBe(true);
  });

  it('times out after 120s with a diagnose suggestion', async () => {
    const items = [deployment('db', 'accessory')];
    const h = harness(items, [
      {
        id: 'poll',
        method: 'getJson',
        namespace: NS,
        args: ['get', 'pods', '-l', `${LABELS.stack}=${NS},${LABELS.role}=accessory,${LABELS.service} in (db)`, '-o', 'json'],
        respond: list([]),
        times: 'any',
      },
    ]);
    const outcome = await settle(h.backend.restartAfterRestore(ACC, 'db'), h.clock);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(BackupError);
      const error = outcome.error as BackupError;
      expect(error.message).toBe('Service db did not become ready within 120s after the restore');
      expect(error.code).toBe(ErrorCode.RESTORE_FAILED);
      expect(error.suggestion).toBe('Run `dockflow diagnose production`.');
    }
  });
});
