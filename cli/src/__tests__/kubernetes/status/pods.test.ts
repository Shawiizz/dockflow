import { describe, expect, it } from 'bun:test';
import type { InstanceInfo } from '../../../services/orchestrator/interfaces';
import type { ControllerRevision, Deployment, ReplicaSet, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type { ContainerStatus, Pod, PodStatus } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  buildInventoryView,
  FATAL_WAITING_REASONS,
  formatAge,
  formatRestarts,
  type HelmReleaseWorkloads,
  indexComposeWorkloads,
  instanceLabel,
  instancesFor,
  instanceStateText,
  type InventoryObject,
  type InventoryView,
  isCurrentRevision,
  nodeToServerMap,
  orderInstances,
  orderInstanceTable,
  podController,
  podDisplayStatus,
  podErrorText,
  podOwner,
  type RevisionIndex,
  selectContainer,
  selectInstance,
  statusSummary,
  toInstanceInfo,
  type WorkloadObject,
} from '../../../services/orchestrator/kubernetes/status/pods';
import { CLIError, ErrorCode, ValidationError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import {
  FIXTURE_SERVERS,
  fixtureNamespace,
  loadKubectlList,
  loadKubectlResources,
} from '../support/kubectl-fixtures';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const NOW = new Date('2026-01-01T00:30:00Z');
const INVENTORY_RESOURCES = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'pods',
  'services',
  'persistentvolumeclaims',
] as const;
const SERVERS = nodeToServerMap(Object.values(FIXTURE_SERVERS));
const NO_SECRETS = new Redactor();

function inventoryOf(scenario: string, capture = '', helm: HelmReleaseWorkloads[] = []): InventoryView {
  const list = loadKubectlResources<InventoryObject>(scenario, INVENTORY_RESOURCES, capture);
  return buildInventoryView(fixtureNamespace(scenario), list.items, helm);
}

function revisionsOf(scenario: string, capture = ''): RevisionIndex {
  return {
    replicaSets: loadKubectlList<ReplicaSet>(scenario, 'replicasets.apps', capture).items,
    controllerRevisions: loadKubectlList<ControllerRevision>(scenario, 'controllerrevisions.apps', capture).items,
  };
}

function podsOf(scenario: string, capture = ''): Pod[] {
  return loadKubectlList<Pod>(scenario, 'pods', capture).items;
}

function podNamed(scenario: string, name: string, capture = ''): Pod {
  const pod = podsOf(scenario, capture).find((p) => p.metadata.name === name);
  if (!pod) throw new Error(`no pod ${name} in ${scenario}`);
  return pod;
}

function container(name: string, extra: Partial<ContainerStatus> = {}): ContainerStatus {
  return { name, ready: true, restartCount: 0, image: 'busybox:1.37', state: { running: {} }, ...extra };
}

interface PodOptions {
  name?: string;
  deletion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  owner?: { kind: string; name: string };
  containers?: string[];
  initContainers?: { name: string; restartPolicy?: string }[];
  nodeName?: string;
}

function makePod(status: PodStatus, options: PodOptions = {}): Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: options.name ?? 'web-6d4b9c7f8-x2x4q',
      namespace: NS,
      labels: options.labels ?? { 'pod-template-hash': '6d4b9c7f8' },
      ...(options.annotations ? { annotations: options.annotations } : {}),
      ...(options.deletion ? { deletionTimestamp: options.deletion } : {}),
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: options.owner?.kind ?? 'ReplicaSet',
          name: options.owner?.name ?? 'web-6d4b9c7f8',
          uid: 'u',
          controller: true,
        },
      ],
    },
    spec: {
      containers: (options.containers ?? ['web']).map((name) => ({ name, image: 'busybox:1.37' })),
      ...(options.initContainers ? { initContainers: options.initContainers.map((c) => ({ image: 'busybox:1.37', ...c })) } : {}),
      ...(options.nodeName ? { nodeName: options.nodeName } : {}),
    },
    status,
  };
}

const running = (ready = true): PodStatus => ({ phase: 'Running', containerStatuses: [container('web', { ready })] });
const waiting = (reason: string, message?: string): ContainerStatus =>
  container('web', { ready: false, state: { waiting: message ? { reason, message } : { reason } } });

describe('podDisplayStatus', () => {
  const rows: [string, Pod, string, InstanceInfo['severity']][] = [
    ['1 deletionTimestamp', makePod(running(), { deletion: '2026-01-01T00:20:00Z' }), 'Terminating', 'warning'],
    ['2 status.reason', makePod({ phase: 'Failed', reason: 'Evicted' }), 'Evicted', 'error'],
    [
      '3 init container failed',
      makePod(
        {
          phase: 'Pending',
          initContainerStatuses: [container('init', { ready: false, state: { terminated: { exitCode: 1, reason: 'Error' } } })],
        },
        { initContainers: [{ name: 'init' }] },
      ),
      'Init:Error',
      'error',
    ],
    [
      '4 init container waiting',
      makePod({ phase: 'Pending', initContainerStatuses: [waiting('CrashLoopBackOff')] }, { initContainers: [{ name: 'web' }] }),
      'Init:CrashLoopBackOff',
      'error',
    ],
    [
      '5 init containers not all done',
      makePod(
        {
          phase: 'Pending',
          initContainerStatuses: [
            container('a', { state: { terminated: { exitCode: 0, reason: 'Completed' } } }),
            container('b', { state: { waiting: { reason: 'PodInitializing' } } }),
          ],
        },
        { initContainers: [{ name: 'a' }, { name: 'b' }] },
      ),
      'Init:1/2',
      'warning',
    ],
    ['6 app container waiting', makePod({ phase: 'Running', containerStatuses: [waiting('CrashLoopBackOff')] }), 'CrashLoopBackOff', 'error'],
    ['7 Succeeded', makePod({ phase: 'Succeeded' }), 'Completed', 'ok'],
    [
      '8 Failed',
      makePod({ phase: 'Failed', containerStatuses: [container('web', { state: { terminated: { exitCode: 1, reason: 'Error' } } })] }),
      'Error',
      'error',
    ],
    [
      '9 Pending, PodScheduled=False',
      makePod({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'no node' }] }),
      'Pending (Unschedulable)',
      'error',
    ],
    ['10 Pending', makePod({ phase: 'Pending' }), 'Pending', 'warning'],
    ['11 Running, all ready', makePod(running()), 'Running', 'ok'],
    ['12 Running, not ready', makePod(running(false)), 'Running (not ready)', 'warning'],
    ['13 anything else', makePod({ phase: 'Unknown' }), 'Unknown', 'warning'],
  ];
  for (const [rule, pod, status, severity] of rows) {
    it(`rule ${rule}`, () => {
      expect(podDisplayStatus(pod)).toEqual({ status, severity });
    });
  }

  it('Terminating wins over CrashLoopBackOff', () => {
    const pod = makePod({ phase: 'Running', containerStatuses: [waiting('CrashLoopBackOff')] }, { deletion: '2026-01-01T00:20:00Z' });
    expect(podDisplayStatus(pod)).toEqual({ status: 'Terminating', severity: 'warning' });
  });

  it('prints Init:ExitCode:<n> for a failed init container without reason', () => {
    const pod = makePod(
      { phase: 'Pending', initContainerStatuses: [container('init', { state: { terminated: { exitCode: 1 } } })] },
      { initContainers: [{ name: 'init' }] },
    );
    expect(podDisplayStatus(pod)).toEqual({ status: 'Init:ExitCode:1', severity: 'error' });
  });

  it('prints Init:2/3 while the third init container runs', () => {
    const done = { state: { terminated: { exitCode: 0, reason: 'Completed' } } };
    const pod = makePod(
      { phase: 'Pending', initContainerStatuses: [container('a', done), container('b', done), container('c', { ready: false })] },
      { initContainers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    );
    expect(podDisplayStatus(pod)).toEqual({ status: 'Init:2/3', severity: 'warning' });
  });

  it('counts a started native sidecar as done', () => {
    const pod = makePod(
      {
        phase: 'Running',
        initContainerStatuses: [container('proxy', { started: true })],
        containerStatuses: [container('web')],
      },
      { initContainers: [{ name: 'proxy', restartPolicy: 'Always' }] },
    );
    expect(podDisplayStatus(pod)).toEqual({ status: 'Running', severity: 'ok' });
  });

  it('keeps a non-fatal init waiting reason as a warning', () => {
    const pod = makePod({ phase: 'Pending', initContainerStatuses: [waiting('ContainerCreating')] }, { initContainers: [{ name: 'web' }] });
    expect(podDisplayStatus(pod)).toEqual({ status: 'Init:ContainerCreating', severity: 'warning' });
  });

  it('ContainerCreating and PodInitializing are warnings, the fatal set errors', () => {
    expect(podDisplayStatus(makePod({ phase: 'Pending', containerStatuses: [waiting('ContainerCreating')] }))).toEqual({
      status: 'ContainerCreating',
      severity: 'warning',
    });
    expect(podDisplayStatus(makePod({ phase: 'Pending', containerStatuses: [waiting('PodInitializing')] })).severity).toBe('warning');
    for (const reason of FATAL_WAITING_REASONS) {
      expect(podDisplayStatus(makePod({ phase: 'Pending', containerStatuses: [waiting(reason)] }))).toEqual({ status: reason, severity: 'error' });
    }
    expect(podDisplayStatus(makePod({ phase: 'Pending', containerStatuses: [waiting('ErrImageNeverPull')] })).severity).toBe('error');
  });

  it('prefers a fatal waiting reason over another container that is only creating', () => {
    const pod = makePod({
      phase: 'Pending',
      containerStatuses: [waiting('ContainerCreating'), { ...waiting('ImagePullBackOff'), name: 'sidecar' }],
    });
    expect(podDisplayStatus(pod).status).toBe('ImagePullBackOff');
  });

  it('phase Failed shows OOMKilled, else Failed', () => {
    const oom = makePod({
      phase: 'Failed',
      containerStatuses: [container('web', { state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } })],
    });
    expect(podDisplayStatus(oom)).toEqual({ status: 'OOMKilled', severity: 'error' });
    expect(podDisplayStatus(makePod({ phase: 'Failed' }))).toEqual({ status: 'Failed', severity: 'error' });
  });

  it('Pending (Unschedulable) is an error only for reason Unschedulable', () => {
    const gated = makePod({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'SchedulingGated' }] });
    expect(podDisplayStatus(gated)).toEqual({ status: 'Pending (Unschedulable)', severity: 'warning' });
  });

  it('Running (not ready) with an OOMKilled last state is an error', () => {
    const pod = makePod({
      phase: 'Running',
      containerStatuses: [container('web', { ready: false, restartCount: 2, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } })],
    });
    expect(podDisplayStatus(pod)).toEqual({ status: 'Running (not ready)', severity: 'error' });
  });

  it('a pod without phase is Unknown', () => {
    expect(podDisplayStatus(makePod({}))).toEqual({ status: 'Unknown', severity: 'warning' });
  });

  it('matches the kubectl printer on the recorded scenarios (U-STATUS-PODS-01)', () => {
    const cases: [string, string, string, InstanceInfo['severity']][] = [
      ['crashloop', 'web-app-p2xkk2fn8m-zbc2k', 'CrashLoopBackOff', 'error'],
      ['init-container-crash', 'web-gwx9gxmmlm-8j722', 'Init:CrashLoopBackOff', 'error'],
      ['terminating-pods', 'web-qw9jpb6slq-6sb4b', 'Terminating', 'warning'],
      ['terminating-pods', 'web-qw9jpb6slq-gmnrj', 'Running', 'ok'],
      ['evicted-pod', 'web-kvz7hg45z8-lwht6', 'Evicted', 'error'],
      ['evicted-pod', 'web-kvz7hg45z8-bz4r2', 'Running', 'ok'],
      ['oom-killed', 'web-qlwq4g8hrz-bqtf5', 'CrashLoopBackOff', 'error'],
      ['unschedulable-resources', 'web-8k689hhgsx-rvc8f', 'Pending (Unschedulable)', 'error'],
      ['pvc-pending-rwx', 'web-5hrbmx46j5-fl6xj', 'Pending', 'warning'],
      ['job-complete', 'migrate-ab6158d4-jqsjt', 'Completed', 'ok'],
      ['job-failed', 'migrate-aefdcfd1-6wjcc', 'Error', 'error'],
      ['rollout-progressing', 'web-htj6sx4lpn-ff4rl', 'Running (not ready)', 'warning'],
      ['multi-container', 'api-bg5g5vghlb-27kgr', 'Running', 'ok'],
      ['err-image-never-pull', 'web-dgnq2qql9c-f55cv', 'ErrImageNeverPull', 'error'],
      ['image-pull-backoff', 'web-h7fqpf2pgw-hhx68', 'ImagePullBackOff', 'error'],
      ['create-container-config-error', 'web-z67tgvktnp-s8578', 'CreateContainerConfigError', 'error'],
      ['invalid-image-name', 'web-stwzqdsq9f-xqfnm', 'InvalidImageName', 'error'],
    ];
    for (const [scenario, name, status, severity] of cases) {
      expect({ scenario, ...podDisplayStatus(podNamed(scenario, name)) }).toEqual({ scenario, status, severity });
    }
  });
});

describe('owning workload', () => {
  it('finds a Deployment through its ReplicaSet name without reading ReplicaSets', () => {
    expect(podController(podNamed('crashloop', 'web-app-p2xkk2fn8m-zbc2k'))).toEqual({ kind: 'Deployment', name: 'web-app' });
    expect(podController(podNamed('statefulset-stuck', 'db-0'))).toEqual({ kind: 'StatefulSet', name: 'db' });
    expect(podController(podNamed('daemonset-rolling', 'agent-8szr6'))).toEqual({ kind: 'DaemonSet', name: 'agent' });
    expect(podController(podNamed('job-complete', 'migrate-ab6158d4-jqsjt'))).toEqual({ kind: 'Job', name: 'migrate-ab6158d4' });
  });

  it('excludes helper pods and pods without a controller', () => {
    const inventory = inventoryOf('metrics-top');
    const helper = podNamed('metrics-top', 'dockflow-helper-archive-3f9a2c1b');
    expect(podOwner(helper, inventory)).toBeNull();
    const bare = makePod(running());
    bare.metadata.ownerReferences = [];
    expect(podOwner(bare, inventory)).toBeNull();
  });

  it('maps compose pods to the compose name and role', () => {
    const inventory = inventoryOf('crashloop');
    const owner = podOwner(podNamed('crashloop', 'web-app-p2xkk2fn8m-zbc2k'), inventory);
    expect(owner).toMatchObject({ source: 'compose', service: 'web_app', role: 'app', kind: 'Deployment', name: 'web-app', serviceName: 'web-app' });
  });
});

describe('indexComposeWorkloads', () => {
  const deployment = (name: string, labels: Record<string, string>, annotations: Record<string, string>, created = '2026-01-01T00:00:00Z'): Deployment => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels, annotations, creationTimestamp: created },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name, image: 'busybox:1.37' }] } } },
  });
  const stackLabels = (service: string, role = 'app') => ({
    'app.kubernetes.io/managed-by': 'dockflow',
    [`${P}/part`]: 'stack',
    [`${P}/role`]: role,
    [`${P}/service`]: service,
  });

  it('keeps Dockflow stack workloads with a compose name only', () => {
    const index = indexComposeWorkloads([
      deployment('web-app', stackLabels('web-app'), { [`${P}/compose-service`]: 'web_app' }),
      deployment('chart-web', { 'app.kubernetes.io/managed-by': 'Helm' }, { [`${P}/compose-service`]: 'x' }),
      deployment('helper', { ...stackLabels('helper'), [`${P}/part`]: 'helper' }, { [`${P}/compose-service`]: 'helper' }),
      deployment('nameless', stackLabels('nameless'), {}),
      deployment('bad-role', stackLabels('bad-role', 'other'), { [`${P}/compose-service`]: 'bad_role' }),
    ]);
    expect([...index.keys()]).toEqual(['web_app']);
    expect(index.get('web_app')).toMatchObject({ service: 'web_app', serviceName: 'web-app', role: 'app', kind: 'Deployment' });
  });

  it('keeps the newest of several Jobs of one service', () => {
    const job = (name: string, created: string): Job => ({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name, creationTimestamp: created, labels: stackLabels('migrate'), annotations: { [`${P}/compose-service`]: 'migrate' } },
      spec: { template: { metadata: {}, spec: { containers: [{ name: 'migrate', image: 'busybox:1.37' }] } } },
    });
    const index = indexComposeWorkloads([job('migrate-bbbbbbbb', '2026-01-01T00:10:00Z'), job('migrate-aaaaaaaa', '2026-01-01T00:05:00Z')]);
    expect(index.get('migrate')?.object.metadata.name).toBe('migrate-bbbbbbbb');
  });
});

describe('isCurrentRevision', () => {
  const rs = (name: string, revision: string, created: string, hash: string): ReplicaSet => ({
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name,
      creationTimestamp: created,
      labels: { 'pod-template-hash': hash },
      annotations: { 'deployment.kubernetes.io/revision': revision },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'd1', controller: true }],
    },
  });
  const web: Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', uid: 'd1' },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'web', image: 'busybox:1.37' }] } } },
  };

  it('Deployment: the highest revision wins, not the newest ReplicaSet', () => {
    const revisions: RevisionIndex = {
      replicaSets: [
        rs('web-aaa', '1', '2026-01-01T00:00:00Z', 'aaa'),
        rs('web-ccc', '3', '2026-01-01T00:01:00Z', 'ccc'),
        rs('web-bbb', '2', '2026-01-01T00:09:00Z', 'bbb'),
      ],
      controllerRevisions: [],
    };
    const podWith = (hash: string) => makePod(running(), { labels: { 'pod-template-hash': hash } });
    expect(isCurrentRevision(podWith('ccc'), { kind: 'Deployment', object: web }, revisions)).toBe(true);
    expect(isCurrentRevision(podWith('bbb'), { kind: 'Deployment', object: web }, revisions)).toBe(false);
    expect(isCurrentRevision(podWith('aaa'), { kind: 'Deployment', object: web }, revisions)).toBe(false);
  });

  it('Deployment without an owned ReplicaSet counts as current', () => {
    const pod = makePod(running(), { labels: { 'pod-template-hash': 'zzz' } });
    expect(isCurrentRevision(pod, { kind: 'Deployment', object: web }, { replicaSets: [], controllerRevisions: [] })).toBe(true);
  });

  it('Deployment mid-rollout (recorded)', () => {
    const inventory = inventoryOf('rollout-progressing');
    const revisions = revisionsOf('rollout-progressing');
    const workload = inventory.composeWorkloads.get('web');
    if (!workload) throw new Error('no web');
    const current = podsOf('rollout-progressing').map((p) => [p.metadata.name, isCurrentRevision(p, workload, revisions)]);
    expect(current).toEqual([
      ['web-b4phj422s5-6lnzl', false],
      ['web-b4phj422s5-gs8jf', false],
      ['web-b4phj422s5-j8mhb', false],
      ['web-htj6sx4lpn-ff4rl', true],
    ]);
  });

  it('StatefulSet mid-update compares with updateRevision', () => {
    const inventory = inventoryOf('statefulset-stuck');
    const workload = inventory.composeWorkloads.get('db');
    if (!workload) throw new Error('no db');
    const revisions = revisionsOf('statefulset-stuck');
    expect(isCurrentRevision(podNamed('statefulset-stuck', 'db-0'), workload, revisions)).toBe(false);
    expect(isCurrentRevision(podNamed('statefulset-stuck', 'db-1'), workload, revisions)).toBe(true);
  });

  it('StatefulSet with an empty updateRevision falls back to currentRevision', () => {
    const sts: StatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'db' },
      spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'db', image: 'busybox:1.37' }] } } },
      status: { currentRevision: 'db-abc', updateRevision: '' },
    };
    const pod = (hash: string) => makePod(running(), { name: 'db-0', labels: { 'controller-revision-hash': hash } });
    const none = { replicaSets: [], controllerRevisions: [] };
    expect(isCurrentRevision(pod('db-abc'), { kind: 'StatefulSet', object: sts }, none)).toBe(true);
    expect(isCurrentRevision(pod('db-old'), { kind: 'StatefulSet', object: sts }, none)).toBe(false);
  });

  it('DaemonSet: the ControllerRevision with the highest revision defines the hash', () => {
    const inventory = inventoryOf('daemonset-rolling');
    const workload = inventory.composeWorkloads.get('agent');
    if (!workload) throw new Error('no agent');
    const revisions = revisionsOf('daemonset-rolling');
    expect(isCurrentRevision(podNamed('daemonset-rolling', 'agent-nhfnb'), workload, revisions)).toBe(true);
    expect(isCurrentRevision(podNamed('daemonset-rolling', 'agent-8szr6'), workload, revisions)).toBe(false);
  });

  it('a Job pod is always current', () => {
    const inventory = inventoryOf('job-complete');
    const workload = inventory.composeWorkloads.get('migrate');
    if (!workload) throw new Error('no migrate');
    expect(isCurrentRevision(podNamed('job-complete', 'migrate-ab6158d4-jqsjt'), workload, revisionsOf('job-complete'))).toBe(true);
  });
});

describe('toInstanceInfo', () => {
  it('maps a recorded pod (U-STATUS-PODS-04)', () => {
    const inventory = inventoryOf('crashloop');
    const info = toInstanceInfo(podNamed('crashloop', 'web-app-p2xkk2fn8m-zbc2k'), inventory, revisionsOf('crashloop'), SERVERS, NO_SECRETS);
    expect(info).toEqual({
      id: 'web-app-p2xkk2fn8m-zbc2k',
      label: 'web_app.zbc2k',
      service: 'web_app',
      node: 'server_1',
      status: 'CrashLoopBackOff',
      severity: 'error',
      ready: false,
      restarts: 3,
      current: true,
      startedAt: '2026-01-01T00:15:00Z',
      error:
        'back-off 1m20s restarting failed container=web-app pod=web-app-p2xkk2fn8m-zbc2k_fixture-crashloop(00000000-0000-4000-8000-000000000004)',
      containers: ['web-app'],
    });
  });

  it('maps the node to its servers.yml key (agent_1 <- agent-1) and keeps an unknown node', () => {
    const inventory = inventoryOf('multi-container');
    const pod = podNamed('multi-container', 'api-bg5g5vghlb-27kgr');
    expect(toInstanceInfo(pod, inventory, null, SERVERS, NO_SECRETS)?.node).toBe('agent_1');
    expect(toInstanceInfo(pod, inventory, null, nodeToServerMap(['server_1']), NO_SECRETS)?.node).toBe('agent-1');
    expect(toInstanceInfo(pod, inventory, null, SERVERS, NO_SECRETS)?.containers).toEqual(['api', 'log-shipper']);
  });

  it('has no node and no start time while unscheduled', () => {
    const inventory = inventoryOf('unschedulable-resources');
    const info = toInstanceInfo(podNamed('unschedulable-resources', 'web-8k689hhgsx-rvc8f'), inventory, null, SERVERS, NO_SECRETS);
    expect(info).toMatchObject({ node: null, startedAt: null, status: 'Pending (Unschedulable)' });
    expect(info?.error).toContain('Insufficient memory');
  });

  it('sums restarts over init and app containers', () => {
    const inventory = inventoryOf('multi-container');
    const pod = podNamed('multi-container', 'api-bg5g5vghlb-27kgr');
    pod.status = {
      ...pod.status,
      initContainerStatuses: [container('init', { restartCount: 1, state: { terminated: { exitCode: 0 } } })],
      containerStatuses: [container('api', { restartCount: 2 }), container('log-shipper', { restartCount: 3 })],
    };
    expect(toInstanceInfo(pod, inventory, null, SERVERS, NO_SECRETS)?.restarts).toBe(6);
  });

  it('error priority: waiting message, then last termination, then the scheduler message', () => {
    const scheduled = { type: 'PodScheduled', status: 'False' as const, reason: 'Unschedulable', message: 'no node fits' };
    const terminated = { exitCode: 1, reason: 'Error', finishedAt: '2026-01-01T00:16:13Z' };
    const all = makePod({
      phase: 'Running',
      conditions: [scheduled],
      containerStatuses: [container('web', { state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } }, lastState: { terminated } })],
    });
    expect(podErrorText(all)).toBe('back-off');
    const noWaiting = makePod({ phase: 'Running', conditions: [scheduled], containerStatuses: [container('web', { lastState: { terminated } })] });
    expect(podErrorText(noWaiting)).toBe('Error (exit 1) at 2026-01-01T00:16:13Z');
    const onlyScheduling = makePod({ phase: 'Pending', conditions: [scheduled] });
    expect(podErrorText(onlyScheduling)).toBe('no node fits');
    expect(podErrorText(makePod(running()))).toBeNull();
  });

  it('uses the eviction message of an evicted pod', () => {
    const pod = makePod({ phase: 'Failed', reason: 'Evicted', message: 'The node was low on resource: ephemeral-storage.' });
    expect(podErrorText(pod)).toBe('The node was low on resource: ephemeral-storage.');
  });

  it('redacts the error with the bundle Redactor', () => {
    const inventory = inventoryOf('crashloop');
    const pod = podNamed('crashloop', 'web-app-p2xkk2fn8m-zbc2k');
    pod.status = { ...pod.status, containerStatuses: [waiting('CreateContainerConfigError', 'bad value s3cr3t-token-value in env')] };
    const info = toInstanceInfo(pod, inventory, null, SERVERS, new Redactor(['s3cr3t-token-value']));
    expect(info?.error).toBe('bad value *** in env');
  });

  it('marks every instance current when revisions are not read', () => {
    const inventory = inventoryOf('rollout-progressing');
    const infos = podsOf('rollout-progressing').map((p) => toInstanceInfo(p, inventory, null, SERVERS, NO_SECRETS));
    expect(infos.every((i) => i?.current === true)).toBe(true);
  });

  it('returns null for a helper pod', () => {
    const inventory = inventoryOf('metrics-top');
    expect(toInstanceInfo(podNamed('metrics-top', 'dockflow-helper-archive-3f9a2c1b'), inventory, null, SERVERS, NO_SECRETS)).toBeNull();
  });

  it('names a chart pod after its Helm release', () => {
    const inventory = inventoryOf('multi-container', '', [
      { release: 'search', role: 'app', namespace: fixtureNamespace('multi-container'), workloads: [{ kind: 'Deployment', name: 'api' }] },
    ]);
    // the compose index would claim it first; drop it to model a chart-owned Deployment
    const chartOnly: InventoryView = { ...inventory, composeWorkloads: new Map() };
    const info = toInstanceInfo(podNamed('multi-container', 'api-bg5g5vghlb-27kgr'), chartOnly, null, SERVERS, NO_SECRETS);
    expect(info).toMatchObject({ service: 'search', label: 'search.27kgr' });
  });
});

describe('instancesFor', () => {
  it('filters by role and leaves helper pods out', () => {
    const inventory = inventoryOf('metrics-top');
    const app = instancesFor(inventory, { role: 'app' }, null, SERVERS, NO_SECRETS);
    expect(app.map((i) => i.id)).toEqual(['web-782lrz9hsf-6dfnp', 'web-782lrz9hsf-7fvrw']);
    const accessory = instancesFor(inventory, { role: 'accessory' }, null, SERVERS, NO_SECRETS);
    expect(accessory.map((i) => [i.id, i.label, i.node])).toEqual([['db-0', 'db.0', 'server_1']]);
  });

  it('keeps Completed and Failed pods only with includeTerminated', () => {
    const inventory = inventoryOf('job-complete');
    expect(instancesFor(inventory, { role: 'app' }, null, SERVERS, NO_SECRETS)).toEqual([]);
    const all = instancesFor(inventory, { role: 'app', includeTerminated: true }, null, SERVERS, NO_SECRETS);
    expect(all.map((i) => [i.service, i.status])).toEqual([['migrate', 'Completed']]);
  });

  it('narrows to one service', () => {
    const inventory = inventoryOf('headless-no-ports');
    const worker = instancesFor(inventory, { role: 'app', service: 'worker' }, null, SERVERS, NO_SECRETS);
    expect(worker.map((i) => i.service)).toEqual(['worker', 'worker']);
  });
});

function instance(id: string, fields: Partial<InstanceInfo> & { service: string; label: string }): InstanceInfo {
  return {
    id,
    node: 'server_1',
    status: 'Running',
    severity: 'ok',
    ready: true,
    restarts: 0,
    current: true,
    startedAt: '2026-01-01T00:10:00Z',
    error: null,
    containers: [fields.service],
    ...fields,
  };
}

// not ready old revision, ready old revision, ready current (two start times), equal start times, sts ordinals 2/0/1
const ORDERING: InstanceInfo[] = [
  instance('web-aaaaa', { service: 'web', label: 'web.aaaaa', ready: false, current: false, status: 'Running (not ready)', startedAt: '2026-01-01T00:20:00Z' }),
  instance('web-fffff', { service: 'web', label: 'web.fffff', startedAt: '2026-01-01T00:10:00Z' }),
  instance('web-bbbbb', { service: 'web', label: 'web.bbbbb', current: false, startedAt: '2026-01-01T00:20:00Z' }),
  instance('web-eeeee', { service: 'web', label: 'web.eeeee', startedAt: '2026-01-01T00:10:00Z' }),
  instance('web-ccccc', { service: 'web', label: 'web.ccccc', startedAt: '2026-01-01T00:10:00Z' }),
  instance('web-ddddd', { service: 'web', label: 'web.ddddd', startedAt: '2026-01-01T00:12:00Z' }),
  instance('db-2', { service: 'db', label: 'db.2', startedAt: '2026-01-01T00:25:00Z' }),
  instance('db-0', { service: 'db', label: 'db.0', startedAt: '2026-01-01T00:05:00Z' }),
  instance('db-1', { service: 'db', label: 'db.1', startedAt: '2026-01-01T00:15:00Z' }),
];
const WEB_ORDER = ['web-ddddd', 'web-ccccc', 'web-eeeee', 'web-fffff', 'web-bbbbb', 'web-aaaaa'];

describe('instance order and selection', () => {
  it('orderInstances: ready, current, ordinal, newest start, id', () => {
    expect(orderInstances(ORDERING.filter((i) => i.service === 'web')).map((i) => i.id)).toEqual(WEB_ORDER);
    expect(orderInstances(ORDERING.filter((i) => i.service === 'db')).map((i) => i.id)).toEqual(['db-0', 'db-1', 'db-2']);
  });

  it('is the one order of selectInstance, the --pick prompt and the ps table (m8)', () => {
    const picked = selectInstance(ORDERING, { service: 'web', requireReady: false, env: 'production' });
    const prompt = orderInstances(ORDERING.filter((i) => i.service === 'web')).map((i) => i.id);
    const table = orderInstanceTable(ORDERING).map((i) => i.id);
    expect(picked.id).toBe(prompt[0]);
    expect(prompt).toEqual(WEB_ORDER);
    expect(table).toEqual(['db-0', 'db-1', 'db-2', ...WEB_ORDER]);
  });

  it('ps table puts the current revision first within a service', () => {
    const rows = [
      instance('web-old', { service: 'web', label: 'web.x-old', current: false }),
      instance('web-new', { service: 'web', label: 'web.x-new', ready: false, status: 'Running (not ready)' }),
    ];
    expect(orderInstanceTable(rows).map((i) => i.id)).toEqual(['web-new', 'web-old']);
    expect(orderInstances(rows).map((i) => i.id)).toEqual(['web-old', 'web-new']);
  });

  it('accepts a --pod of the service and rejects one of another service with the list', () => {
    expect(selectInstance(ORDERING, { service: 'web', instance: 'web-bbbbb', requireReady: false, env: 'production' }).id).toBe('web-bbbbb');
    let error: unknown;
    try {
      selectInstance(ORDERING, { service: 'web', instance: 'db-0', requireReady: false, env: 'production' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe('Instance db-0 does not belong to service web');
    expect((error as ValidationError).suggestion).toBe(`Choose one of: \`${WEB_ORDER.join(', ')}\`.`);
  });

  it('refuses a --pod of the service that is not running', () => {
    const rows = [instance('web-1', { service: 'web', label: 'web.1', status: 'CrashLoopBackOff', severity: 'error', ready: false })];
    expect(() => selectInstance(rows, { service: 'web', instance: 'web-1', requireReady: false, env: 'production' })).toThrow(
      'Instance web-1 of service web is not running (CrashLoopBackOff)',
    );
  });

  it('requireReady with only unready pods -> CONTAINER_NOT_FOUND with the status summary', () => {
    const rows = [
      instance('db-0', { service: 'db', label: 'db.0', ready: false, status: 'Running (not ready)' }),
      instance('db-1', { service: 'db', label: 'db.1', ready: false, status: 'Running (not ready)' }),
    ];
    let error: unknown;
    try {
      selectInstance(rows, { service: 'db', requireReady: true, env: 'production' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect((error as CLIError).message).toBe('Service db has no ready instance (2 Running (not ready))');
    expect(selectInstance(rows, { service: 'db', requireReady: false, env: 'production' }).id).toBe('db-0');
  });

  it('no candidate -> CONTAINER_NOT_FOUND naming the statuses, or no pods', () => {
    const rows = [
      instance('web-1', { service: 'web', label: 'web.1', status: 'Pending (Unschedulable)', severity: 'error', ready: false }),
      instance('web-2', { service: 'web', label: 'web.2', status: 'CrashLoopBackOff', severity: 'error', ready: false }),
      instance('web-3', { service: 'web', label: 'web.3', status: 'Terminating', severity: 'warning' }),
    ];
    let error: unknown;
    try {
      selectInstance(rows, { service: 'web', requireReady: false, env: 'production' });
    } catch (e) {
      error = e;
    }
    expect((error as CLIError).code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect((error as CLIError).message).toBe('Service web has no running instance (1 Terminating, 1 Pending (Unschedulable), 1 CrashLoopBackOff)');
    expect((error as CLIError).suggestion).toBe('Run `dockflow diagnose production`.');
    expect(() => selectInstance([], { service: 'web', requireReady: false, env: 'production' })).toThrow('Service web has no running instance (no pods)');
  });

  it('statusSummary counts statuses in order of appearance', () => {
    const rows = [
      instance('a', { service: 'web', label: 'web.a', status: 'Pending (Unschedulable)' }),
      instance('b', { service: 'web', label: 'web.b', status: 'CrashLoopBackOff' }),
      instance('c', { service: 'web', label: 'web.c', status: 'Pending (Unschedulable)' }),
    ];
    expect(statusSummary(rows)).toBe('2 Pending (Unschedulable), 1 CrashLoopBackOff');
    expect(statusSummary([])).toBe('no pods');
  });
});

describe('selectContainer (U-STATUS-PODS-03)', () => {
  const multi = podNamed('multi-container', 'api-bg5g5vghlb-27kgr');

  it('takes the requested container, else refuses a missing one', () => {
    expect(selectContainer(multi, 'log-shipper', 'api')).toBe('log-shipper');
    let error: unknown;
    try {
      selectContainer(multi, 'nope', 'api');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe('Container nope is not part of pod api-bg5g5vghlb-27kgr');
    expect((error as ValidationError).suggestion).toBe('Choose one of: `api, log-shipper`.');
  });

  it('honours the default-container annotation', () => {
    expect(selectContainer(multi, undefined, 'other')).toBe('api');
  });

  it('takes the container named after the service, then the only container', () => {
    expect(selectContainer(makePod(running(), { containers: ['sidecar', 'web'] }), undefined, 'web')).toBe('web');
    expect(selectContainer(makePod(running(), { containers: ['main'] }), undefined, 'web')).toBe('main');
  });

  it('refuses an ambiguous pod, listing names in spec order', () => {
    const pod = makePod(running(), { name: 'search-7c9f-abcde', containers: ['b-side', 'a-main'] });
    let error: unknown;
    try {
      selectContainer(pod, undefined, 'search');
    } catch (e) {
      error = e;
    }
    expect((error as ValidationError).message).toBe('Pod search-7c9f-abcde has several containers');
    expect((error as ValidationError).suggestion).toBe('Name one with `--container <name>`: `b-side, a-main`.');
  });
});

describe('instanceLabel', () => {
  it('uses the StatefulSet ordinal, else the last 5 characters', () => {
    expect(instanceLabel({ id: 'db-0', service: 'db' }, 'db')).toBe('db.0');
    expect(instanceLabel({ id: 'web-6d4b9c7f8-x2x4q', service: 'web' }, 'web')).toBe('web.x2x4q');
    expect(instanceLabel({ id: 'web-app-p2xkk2fn8m-zbc2k', service: 'web_app' }, 'web-app')).toBe('web_app.zbc2k');
    expect(instanceLabel({ id: 'web-worker', service: 'web' }, 'web')).toBe('web.orker');
    expect(instanceLabel({ id: 'db-12a', service: 'db' }, 'db')).toBe('db.b-12a');
  });

  it('gives a Swarm task its slot', () => {
    expect(instanceLabel({ id: 'shop-production_web.2', service: 'web' }, 'shop-production_web')).toBe('web.2');
  });
});

describe('display helpers', () => {
  const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

  it('formatAge', () => {
    expect(formatAge(ago(0), NOW)).toBe('0s');
    expect(formatAge(ago(59), NOW)).toBe('59s');
    expect(formatAge(ago(60), NOW)).toBe('1m');
    expect(formatAge(ago(59 * 60), NOW)).toBe('59m');
    expect(formatAge(ago(47 * 3600), NOW)).toBe('47h');
    expect(formatAge(ago(48 * 3600), NOW)).toBe('2d');
    expect(formatAge(null, NOW)).toBe('-');
    expect(formatAge('not a date', NOW)).toBe('-');
    expect(formatAge(ago(-30), NOW)).toBe('0s');
  });

  it('prints an unknown restart count as - and leaves unknown parts out of a --tasks block (M9)', () => {
    expect(formatRestarts(null)).toBe('-');
    expect(formatRestarts(0)).toBe('0');
    expect(instanceStateText({ status: 'Failed', restarts: null, startedAt: null }, NOW)).toBe('Failed');
    expect(instanceStateText({ status: 'CrashLoopBackOff', restarts: 5, startedAt: ago(12 * 60) }, NOW)).toBe('CrashLoopBackOff (restarts 5, age 12m)');
    expect(instanceStateText({ status: 'Running', restarts: null, startedAt: ago(3 * 3600) }, NOW)).toBe('Running (age 3h)');
  });
});

describe('buildInventoryView', () => {
  it('sorts the items of one read by kind and indexes compose workloads', () => {
    const inventory = inventoryOf('metrics-top');
    expect(inventory.namespace).toBe('fixture-metrics-top');
    expect([...inventory.composeWorkloads.keys()].sort()).toEqual(['db', 'web']);
    expect(inventory.workloads.map((w: WorkloadObject) => `${w.kind}/${w.metadata.name}`)).toEqual(['Deployment/web', 'StatefulSet/db']);
    expect(inventory.pods).toHaveLength(4);
  });

  it('keeps only the Helm releases of its namespace', () => {
    const inventory = inventoryOf('crashloop', '', [
      { release: 'here', role: 'app', namespace: 'fixture-crashloop', workloads: [] },
      { release: 'there', role: 'app', namespace: 'other', workloads: [] },
    ]);
    expect(inventory.helm.map((h) => h.release)).toEqual(['here']);
  });
});
