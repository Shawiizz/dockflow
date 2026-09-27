// Convergence watcher, internal health check and inventory poll (design-03 9, 10, 18.4-18.6 and
// 22.4 W1..W19, H1..H6; design-07 10.1 U-BE-STACK-07/08/08b/09). Script mode replays recorded
// fixtures poll by poll; cluster mode lets FakeCluster's controllers move on the FakeClock.

import { afterEach, describe, expect, it } from 'bun:test';
import { DEFAULT_HEALTHCHECK_INTERVAL_S, DEFAULT_HEALTHCHECK_TIMEOUT_S, HEALTH_STABILITY_WINDOW_S } from '../../../constants';
import type {
  DeployReceipt,
  HealthOptions,
  StackRef,
  WaitOptions,
  WorkloadChange,
  WorkloadKind,
} from '../../../services/orchestrator/interfaces';
import type { LbWatchTarget } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import { stateFor } from '../../../services/orchestrator/kubernetes/backends/stack-state';
import {
  checkHealth,
  type InventoryObservation,
  type InventoryTarget,
  inventorySummary,
  isTransient,
  nodeNameMap,
  podsGone,
  pollInventoryUntil,
  rolledOut,
  type StackWaitDeps,
  scaledTo,
  type WaitReporter,
  type WaitSubject,
  waitConvergence,
} from '../../../services/orchestrator/kubernetes/backends/stack-wait';
import type {
  DaemonSet,
  Deployment,
  DeploymentStatus,
  ReplicaSet,
  StatefulSet,
} from '../../../services/orchestrator/kubernetes/resources/apps';
import type { ContainerStatus, Event, Pod, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import type { PollObject } from '../../../services/orchestrator/kubernetes/status/convergence';
import { OrchestratorUnavailableError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FAKE_CLOCK_START, FakeClock } from '../fakes/fake-clock';
import { FakeCluster } from '../fakes/fake-cluster';
import { FakeKubeExecutor, type KubeResponse, type KubeStep } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';
import { type CapturedResource, FIXTURE_SERVERS, loadKubectlResources } from '../support/kubectl-fixtures';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const K12 = 'deployments.apps,statefulsets.apps,daemonsets.apps,replicasets.apps,jobs.batch,pods';
const ROLE_PODS = `${P}/stack=${NS},${P}/role=app`;
const ROLE_OBJECTS = `app.kubernetes.io/managed-by=dockflow,${ROLE_PODS},${P}/part=stack`;
const WAIT: WaitOptions = { timeoutS: 300, intervalS: 5 };
const HEALTH: HealthOptions = {
  timeoutS: DEFAULT_HEALTHCHECK_TIMEOUT_S,
  intervalS: DEFAULT_HEALTHCHECK_INTERVAL_S,
  stabilityS: HEALTH_STABILITY_WINDOW_S,
};
const IMAGE = 'registry.example.com/shop/web:1.4.2';
const SECRET = 'hunter2-secret-value';
const FIXTURE_RESOURCES: readonly CapturedResource[] = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'controllerrevisions.apps',
  'jobs.batch',
  'pods',
  'services',
];
const WORKLOAD_RESOURCES = FIXTURE_RESOURCES.filter((r) => r !== 'services');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let kube: FakeKubeExecutor | undefined;

afterEach(() => {
  const used = kube;
  kube = undefined;
  if (used) assertExecutorInvariants({ kube: used });
});

class RecordingReporter implements WaitReporter {
  readonly spinner: string[] = [];
  readonly warnings: string[] = [];
  readonly debugs: string[] = [];

  start(text: string): void {
    this.spinner.push(`start: ${text}`);
  }

  update(text: string): void {
    this.spinner.push(`update: ${text}`);
  }

  succeed(text: string): void {
    this.spinner.push(`succeed: ${text}`);
  }

  fail(text: string): void {
    this.spinner.push(`fail: ${text}`);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  debug(line: string): void {
    this.debugs.push(line);
  }
}

function scripted(script: KubeStep[], clock: FakeClock, redactor: Redactor = new Redactor([])): FakeKubeExecutor {
  const created = new FakeKubeExecutor({ redactor, script, clock });
  kube = created;
  return created;
}

function clusterSetup(configure: (cluster: FakeCluster) => void = () => {}): { clock: FakeClock; cluster: FakeCluster; exec: FakeKubeExecutor } {
  const clock = new FakeClock();
  const cluster = new FakeCluster({ clock });
  configure(cluster);
  cluster.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } });
  const exec = new FakeKubeExecutor({ redactor: new Redactor([]), cluster, clock });
  kube = exec;
  return { clock, cluster, exec };
}

function depsFor(exec: FakeKubeExecutor, clock: FakeClock, reporter: WaitReporter, extra: Partial<StackWaitDeps> = {}): StackWaitDeps {
  return {
    kubectl: exec,
    clock,
    redactor: exec.redactor,
    distribution: exec.distribution,
    nodeNames: { ...FIXTURE_SERVERS },
    reporter,
    debug: false,
    ...extra,
  };
}

function change(service: string, kind: WorkloadKind, name: string, generation: number): WorkloadChange {
  return { service, kind, name, created: false, previousRevision: null, previousRevisionNumber: null, previousReplicas: null, generation };
}

interface SubjectOptions {
  lbWatch?: LbWatchTarget[];
  applied?: ManifestObject[];
  skipped?: boolean;
  /** false: a receipt this bundle knows nothing about */
  known?: boolean;
}

function subject(changes: WorkloadChange[], options: SubjectOptions = {}): WaitSubject {
  const now = new Date(FAKE_CLOCK_START);
  const receipt: DeployReceipt = {
    ref: REF,
    version: '1.4.2',
    startedAt: now,
    services: null,
    skipped: options.skipped ?? false,
    artifactDigest: `sha256:${'0'.repeat(64)}`,
    changes,
    helm: [],
    helmChanges: [],
    helmDeclared: [],
    previousVersion: '1.4.1',
  };
  const state =
    options.known === false
      ? undefined
      : stateFor({ ref: REF, namespace: NS, objects: [], applied: options.applied ?? [], lbWatch: options.lbWatch ?? [], now });
  return { receipt, state };
}

/** Runs `promise` to completion on fake time, one second at a time. */
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

function podSelector(...services: string[]): string {
  return `${ROLE_PODS},${P}/service in (${[...services].sort().join(',')})`;
}

function k12(services: string[], respond: KubeResponse, extra: { times?: number | 'any'; resources?: string; namespace?: string } = {}): KubeStep {
  return {
    id: 'K12',
    method: 'getJson',
    args: ['get', extra.resources ?? K12, '-l', podSelector(...services), '-o', 'json'],
    namespace: extra.namespace ?? NS,
    mutating: false,
    respond,
    ...(extra.times !== undefined ? { times: extra.times } : {}),
  };
}

/** checkHealth's warning read: K12 without the service term */
function roleRead(respond: KubeResponse): KubeStep {
  return { id: 'K12-role', method: 'getJson', args: ['get', K12, '-l', ROLE_PODS, '-o', 'json'], namespace: NS, mutating: false, respond };
}

function k13(respond: KubeResponse): KubeStep {
  return { id: 'K13', method: 'run', args: ['get', 'events', '--field-selector=type=Warning', '-o', 'json'], namespace: NS, mutating: false, respond };
}

function k13b(respond: KubeResponse): KubeStep {
  return { id: 'K13b', method: 'getJson', args: ['get', 'services', '--all-namespaces', '-o', 'json'], namespace: null, mutating: false, respond };
}

function k09(respond: KubeResponse): KubeStep {
  return { id: 'K09', method: 'getJson', args: ['get', 'persistentvolumeclaims', '-l', ROLE_OBJECTS, '-o', 'json'], namespace: NS, mutating: false, respond };
}

function fixture(scenario: string, resources: readonly CapturedResource[] = FIXTURE_RESOURCES): KubeResponse {
  return { fixture: resources.map((resource) => `${scenario}/${resource}`) };
}

function items(scenario: string, resources: readonly CapturedResource[] = FIXTURE_RESOURCES, capture = ''): PollObject[] {
  return structuredClone(loadKubectlResources<PollObject>(scenario, resources, capture).items);
}

function listBody(objects: readonly object[]): object {
  return { apiVersion: 'v1', items: objects, kind: 'List', metadata: { resourceVersion: '' } };
}

function list(...objects: object[]): KubeResponse {
  return { json: listBody(objects) };
}

function findPod(objects: readonly PollObject[], name: string): Pod {
  const found = objects.find((o): o is Pod => o.kind === 'Pod' && o.metadata.name === name);
  if (!found) throw new Error(`no pod ${name}`);
  return found;
}

function firstStatus(pod: Pod): ContainerStatus {
  const [status] = pod.status?.containerStatuses ?? [];
  if (!status) throw new Error(`pod ${pod.metadata.name} has no container status`);
  return status;
}

function k12Calls(exec: FakeKubeExecutor): string[][] {
  return exec.calls.filter((c) => c.call.args[0] === 'get' && c.call.args[1]?.startsWith('deployments.apps')).map((c) => c.call.args);
}

// ---------------------------------------------------------------------------
// Hand-built objects (scenarios the recorded fixtures do not cover)
// ---------------------------------------------------------------------------

const DEPLOY_UID = '00000000-0000-4000-8000-000000000101';

function podLabels(service: string): Record<string, string> {
  return { [`${P}/stack`]: NS, [`${P}/role`]: 'app', [`${P}/service`]: service };
}

function objectLabels(service: string): Record<string, string> {
  return { 'app.kubernetes.io/managed-by': 'dockflow', ...podLabels(service), [`${P}/part`]: 'stack' };
}

interface DeploymentOptions {
  name?: string;
  uid?: string;
  revision?: string;
  generation: number;
  replicas?: number;
  status: DeploymentStatus;
  paused?: boolean;
}

function deployment(options: DeploymentOptions): Deployment {
  const name = options.name ?? 'web';
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: NS,
      uid: options.uid ?? DEPLOY_UID,
      generation: options.generation,
      labels: objectLabels(name),
      annotations: {
        [`${P}/compose-service`]: name,
        ...(options.revision !== undefined ? { 'deployment.kubernetes.io/revision': options.revision } : {}),
      },
    },
    spec: {
      replicas: options.replicas ?? 1,
      selector: { matchLabels: { [`${P}/stack`]: NS, [`${P}/service`]: name } },
      template: { metadata: { labels: podLabels(name) }, spec: { containers: [{ name, image: IMAGE }] } },
      ...(options.paused !== undefined ? { paused: options.paused } : {}),
    },
    status: options.status,
  };
}

function replicaSet(revision: string, uid: string): ReplicaSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: `web-${revision}`,
      namespace: NS,
      uid,
      labels: podLabels('web'),
      annotations: { 'deployment.kubernetes.io/revision': revision },
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: DEPLOY_UID, controller: true }],
    },
  };
}

type PodState = 'ready' | 'crashloop' | 'creating' | 'running';

function pod(name: string, uid: string, owner: { kind: string; name: string; uid: string }, state: PodState, options: { restarts?: number; deleting?: boolean } = {}): Pod {
  const ready = state === 'ready';
  const containerState =
    state === 'crashloop'
      ? { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s restarting failed container' } }
      : state === 'creating'
        ? { waiting: { reason: 'ContainerCreating' } }
        : { running: { startedAt: '2026-01-01T00:00:01Z' } };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: NS,
      uid,
      labels: podLabels('web'),
      ownerReferences: [{ apiVersion: 'apps/v1', kind: owner.kind, name: owner.name, uid: owner.uid, controller: true }],
      ...(options.deleting ? { deletionTimestamp: '2026-01-01T00:00:05Z' } : {}),
    },
    spec: { nodeName: 'server-1', containers: [{ name: 'web', image: IMAGE }] },
    status: {
      phase: state === 'creating' ? 'Pending' : 'Running',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Ready', status: ready ? 'True' : 'False' },
      ],
      containerStatuses: [
        {
          name: 'web',
          ready,
          restartCount: options.restarts ?? (state === 'crashloop' ? 4 : 0),
          image: IMAGE,
          state: containerState,
          ...(state === 'crashloop' ? { lastState: { terminated: { exitCode: 1, reason: 'Error' } } } : {}),
        },
      ],
    },
  };
}

function lbService(name: string, namespace: string, ports: number[], bound: boolean, uid: string): Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, uid, ...(namespace === NS ? { labels: objectLabels('web') } : {}) },
    spec: { type: 'LoadBalancer', ports: ports.map((port) => ({ name: `tcp-${port}`, port, protocol: 'TCP', targetPort: port })) },
    status: { loadBalancer: bound ? { ingress: [{ ip: '192.0.2.10' }] } : {} },
  };
}

const WEB_LB: LbWatchTarget = { service: 'web', name: 'web-lb', ports: [{ port: 80, protocol: 'TCP' }] };

// Cluster-mode manifests: valid objects with the labels the translator emits.

function workloadManifest(service: string, image: string, replicas = 1): Record<string, unknown> {
  const selector = { [`${P}/stack`]: NS, [`${P}/service`]: service };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: service, namespace: NS, labels: objectLabels(service), annotations: { [`${P}/compose-service`]: service } },
    spec: {
      replicas,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: podLabels(service) },
        spec: { terminationGracePeriodSeconds: 0, containers: [{ name: service, image }] },
      },
    },
  };
}

function lbManifest(service: string, port: number): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: `${service}-lb`, namespace: NS, labels: objectLabels(service), annotations: { [`${P}/compose-service`]: service } },
    spec: {
      type: 'LoadBalancer',
      selector: { [`${P}/stack`]: NS, [`${P}/service`]: service },
      ports: [{ name: `tcp-${port}`, port, protocol: 'TCP', targetPort: port }],
    },
  };
}

async function applyAll(exec: FakeKubeExecutor, ...objects: Record<string, unknown>[]): Promise<void> {
  await exec.apply(objects.map((object) => JSON.stringify(object)).join('\n---\n'), { dryRun: false, namespace: NS });
}

function generationOf(cluster: FakeCluster, name: string): number {
  const generation = cluster.get('deployments.apps', name, NS)?.metadata.generation;
  if (generation === undefined) throw new Error(`deployment ${name} has no generation`);
  return generation;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('isTransient: the API or the connection did not answer, nothing else', () => {
    const kubeError = (reason: 'Unreachable' | 'Timeout' | 'Forbidden' | 'Unauthorized') => new KubeError(reason, 'x', 'server_1', 1, '');
    expect(isTransient(kubeError('Unreachable'))).toBe(true);
    expect(isTransient(kubeError('Timeout'))).toBe(true);
    expect(isTransient(kubeError('Forbidden'))).toBe(false);
    expect(isTransient(kubeError('Unauthorized'))).toBe(false);
    expect(isTransient(new OrchestratorUnavailableError('lost', undefined, kubeError('Unreachable')))).toBe(true);
    expect(isTransient(new OrchestratorUnavailableError('refused', undefined, kubeError('Forbidden')))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });

  it('nodeNameMap maps each Kubernetes node name back to its servers.yml key', () => {
    expect(nodeNameMap(['server_1', 'Agent_2'])).toEqual({ 'server-1': 'server_1', 'agent-2': 'Agent_2' });
  });
});

// ---------------------------------------------------------------------------
// waitConvergence
// ---------------------------------------------------------------------------

describe('waitConvergence', () => {
  it('converges without any call when there is nothing to wait on (skipped, unknown receipt, no change)', async () => {
    const clock = new FakeClock();
    const exec = scripted([], clock);
    const reporter = new RecordingReporter();
    const deps = depsFor(exec, clock, reporter);
    const web = [change('web', 'Deployment', 'web', 2)];
    for (const target of [subject(web, { skipped: true }), subject(web, { known: false }), subject([])]) {
      expect(await drive(clock, waitConvergence(target, WAIT, deps))).toEqual({ status: 'converged', failures: [] });
    }
    exec.assertDone();
    expect(exec.calls).toHaveLength(0);
    expect(reporter.spinner).toEqual([]);
    expect(clock.sleeps).toEqual([]);
  });

  it('W1 rolling update converges on the 2 s -> 5 s cadence, one namespace read per poll', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], fixture('rollout-progressing')),
        k12(['web'], fixture('rollout-progressing')),
        k12(['web'], fixture('rollout-complete')),
      ],
      clock,
    );
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result).toEqual({ status: 'converged', failures: [] });
    expect(clock.sleeps).toEqual([2000, 3000]);
    expect(k12Calls(exec)).toHaveLength(3);
    expect(exec.calls[0].commandString).toContain(`${P}/service in (web)`);
    expect(reporter.spinner).toEqual([
      'start: Waiting for web...',
      'update: Waiting: web 1/3 updated (0s)',
      'update: Waiting: web 1/3 updated (2s)',
      'succeed: web ready (5s)',
    ]);
  });

  it('W2 CrashLoopBackOff fails at the first poll with the F7 message and its events, no log read', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web-app'], fixture('crashloop')), k13({ fixture: 'crashloop/events' })], clock);
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web_app', 'Deployment', 'web-app', 1)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
    const [failure] = result.failures;
    expect(failure).toMatchObject({ service: 'web_app', reason: 'CrashLoopBackOff', instance: 'web-app-fbf7d977d-dqwf8', node: 'server_1' });
    expect(failure.message.startsWith('Service web_app keeps crashing: container web-app restarted 3 time(s), last exit code 1 (Error)')).toBe(true);
    expect(failure.message).toContain(' (events: BackOff: Back-off restarting failed container web-app in pod web-app-fbf7d977d-dqwf8');
    expect(result.message).toBe(failure.message);
    expect(result.suggestion).toBe('Run `dockflow logs production web_app`.');
    expect(exec.calls.some((c) => c.call.args[0] === 'logs')).toBe(false);
    expect(clock.sleeps).toEqual([]);
    expect(reporter.spinner.at(-1)).toBe(`fail: ${failure.message}`);
  });

  it('W3 with --debug, the failing container logs are read with --previous and reported redacted', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web-app'], fixture('crashloop')),
        k13({ fixture: 'crashloop/events' }),
        {
          id: 'K14',
          method: 'run',
          args: ['logs', 'web-app-fbf7d977d-dqwf8', '-c', 'web-app', '--tail=20', '--previous'],
          namespace: NS,
          mutating: false,
          respond: { exitCode: 0, stdout: `booting\nDB_PASSWORD=${SECRET}\n\nfatal: cannot reach the database\n`, stderr: '' },
        },
      ],
      clock,
      new Redactor([SECRET]),
    );
    const reporter = new RecordingReporter();
    const result = await drive(
      clock,
      waitConvergence(subject([change('web_app', 'Deployment', 'web-app', 1)]), WAIT, depsFor(exec, clock, reporter, { debug: true })),
    );
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(reporter.debugs).toEqual([
      'Last log lines of web-app-fbf7d977d-dqwf8/web-app:',
      '  booting',
      '  DB_PASSWORD=***',
      '  fatal: cannot reach the database',
    ]);
  });

  it('W4 an image missing on a worker fails immediately with F3 and the servers.yml node name', async () => {
    const clock = new FakeClock();
    const objects = items('image-pull-backoff', WORKLOAD_RESOURCES);
    const broken = findPod(objects, 'web-679ff8548-l5hvb');
    const imported = 'dockflow.invalid/shop-web-production:1.4.2';
    broken.spec.nodeName = 'agent-1';
    broken.spec.containers[0].image = imported;
    const status = firstStatus(broken);
    status.image = imported;
    status.state = { waiting: { reason: 'ErrImagePull', message: `rpc error: failed to resolve reference "${imported}": not found` } };
    const exec = scripted([k12(['web'], list(...objects)), k13(list())], clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 1)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([
      {
        service: 'web',
        reason: 'ErrImagePull',
        message: `Service web cannot start: image ${imported} was not imported on node agent_1`,
        instance: 'web-679ff8548-l5hvb',
        node: 'agent_1',
      },
    ]);
    expect(result.suggestion).toBe('Deploy again without `--skip-build` and check the image distribution output.');
    expect(clock.sleeps).toEqual([]);
  });

  it('W5 a public image pull back-off fails on the first poll past its 20 s grace', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], fixture('image-pull-backoff'), { times: 'any' }), k13({ fixture: 'image-pull-backoff/events' })], clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 1)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures[0].reason).toBe('ImagePullBackOff');
    expect(result.failures[0].message.startsWith('Service web cannot pull image ')).toBe(true);
    // polls at 0, 2, 5, 9, 14, 19 are inside the grace; 24 is past it
    expect(clock.sleeps).toEqual([2000, 3000, 4000, 5000, 5000, 5000]);
    expect(k12Calls(exec)).toHaveLength(7);
  });

  it('W6 a transient CreateContainerConfigError does not fail once the pod recovers', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], fixture('create-container-config-error')),
        k12(['web'], fixture('create-container-config-error')),
        k12(['web'], fixture('rollout-complete')),
      ],
      clock,
    );
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result).toEqual({ status: 'converged', failures: [] });
  });

  it('W6 a signal absent from one poll starts its grace over', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], fixture('create-container-config-error')),
        k12(['web'], fixture('rollout-progressing')),
        k12(['web'], fixture('create-container-config-error'), { times: 'any' }),
        k13(list()),
      ],
      clock,
    );
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures[0]).toMatchObject({ reason: 'CreateContainerConfigError', message: 'Service web cannot create container web: secret "web-env-d521dbe6" not found' });
    // seen at 0, gone at 2, seen again from 5: 19 - 5 < 15, so it fails at 24 (not at 19)
    expect(clock.sleeps).toEqual([2000, 3000, 4000, 5000, 5000, 5000]);
  });

  it('W7 an unschedulable pod fails with F9 once 60 s passed', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [k12(['web'], fixture('unschedulable-resources'), { times: 'any' }), k13({ fixture: 'unschedulable-resources/events' })],
      clock,
    );
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 1)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    const [failure] = result.failures;
    expect(failure.reason).toBe('Unschedulable');
    expect(failure.message.startsWith('Service web cannot be scheduled: 0/2 nodes are available: 2 Insufficient memory.')).toBe(true);
    expect(failure.message).toContain('(events: FailedScheduling: ');
    const elapsed = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
    expect(elapsed - (clock.sleeps.at(-1) ?? 0)).toBeLessThan(60_000);
  });

  it('W8 ProgressDeadlineExceeded fails with F12 and the probe event', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], fixture('progress-deadline-exceeded')), k13({ fixture: 'progress-deadline-exceeded/events' })], clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 1)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures[0].reason).toBe('ProgressDeadlineExceeded');
    expect(result.failures[0].message.startsWith('Service web made no progress for 45s: ')).toBe(true);
    expect(result.failures[0].message).toContain('(events: Unhealthy: Readiness probe failed:');
    expect(result.suggestion).toBe('Run `dockflow logs production web`.');
  });

  it('W9 the deadline ends the wait with one F14 per pending target and its last Warning event', async () => {
    const clock = new FakeClock();
    const unhealthy: Event = {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: 'web-96d55d8c4-l67lt.1', namespace: NS },
      type: 'Warning',
      reason: 'Unhealthy',
      message: 'Readiness probe failed: HTTP probe failed with statuscode: 503',
      involvedObject: { kind: 'Pod', name: 'web-96d55d8c4-l67lt', uid: '00000000-0000-4000-8000-000000000007' },
      lastTimestamp: '2026-01-01T00:18:30Z',
    };
    const exec = scripted([k12(['web'], fixture('rollout-progressing'), { times: 'any' }), k13(list(unhealthy))], clock);
    const reporter = new RecordingReporter();
    const result = await drive(
      clock,
      waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), { timeoutS: 30, intervalS: 5 }, depsFor(exec, clock, reporter)),
    );
    exec.assertDone();
    expect(result).toEqual({
      status: 'timeout',
      failures: [
        {
          service: 'web',
          reason: 'Timeout',
          message: 'Service web did not become ready within 30s: 1/3 updated (events: Unhealthy: Readiness probe failed: HTTP probe failed with statuscode: 503)',
        },
      ],
      message: 'Service web did not become ready within 30s: 1/3 updated (events: Unhealthy: Readiness probe failed: HTTP probe failed with statuscode: 503)',
      suggestion: 'Run `dockflow diagnose production`.',
    });
    // the last sleep is cut to the deadline
    expect(clock.sleeps).toEqual([2000, 3000, 4000, 5000, 5000, 5000, 5000, 1000]);
    expect(reporter.spinner.at(-1)).toBe('fail: Timed out after 30s');
  });

  it('W10 two consecutive transient failures are absorbed at the current delay', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], { error: 'Unreachable' }),
        k12(['web'], { transportError: true }),
        k12(['web'], fixture('rollout-complete')),
      ],
      clock,
    );
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result).toEqual({ status: 'converged', failures: [] });
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  it('the transient count is consecutive: a good poll resets it', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], { transportError: true }, { times: 2 }),
        k12(['web'], fixture('rollout-progressing')),
        k12(['web'], { error: 'Unreachable' }, { times: 2 }),
        k12(['web'], fixture('rollout-complete')),
      ],
      clock,
    );
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('converged');
    expect(clock.sleeps).toEqual([2000, 2000, 2000, 3000, 3000]);
  });

  it('a local guard expiry (Timeout) is transient too', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], { hang: true }), k12(['web'], fixture('rollout-complete'))], clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('converged');
    // the executor's 45 s guard, then the 2 s poll delay
    expect(clock.sleeps).toEqual([45_000, 2000]);
  });

  it('W11 the third consecutive transient failure ends the wait with "Lost contact"', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], { transportError: true }, { times: 3 })], clock);
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.status).toBe('timeout');
    expect(result.failures).toEqual([]);
    expect(result.message?.startsWith('Lost contact with the Kubernetes API on server_1 while waiting for web: ')).toBe(true);
    expect(result.suggestion).toBe('Run `dockflow status production`.');
    expect(clock.sleeps).toEqual([2000, 2000]);
    expect(reporter.spinner.at(-1)).toBe('fail: Lost contact with the Kubernetes API');
  });

  it('W12 a DaemonSet target adds controllerrevisions to the read and converges on its node counts', async () => {
    const clock = new FakeClock();
    const resources = `${K12},controllerrevisions.apps`;
    const completed: KubeResponse = { fixture: FIXTURE_RESOURCES.map((r) => `daemonset-rolling/completed/${r}`) };
    const exec = scripted(
      [k12(['agent'], fixture('daemonset-rolling'), { resources }), k12(['agent'], completed, { resources })],
      clock,
    );
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('agent', 'DaemonSet', 'agent', 2)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result).toEqual({ status: 'converged', failures: [] });
    expect(reporter.spinner[1]).toBe('update: Waiting: agent 1/2 nodes updated (0s)');
  });

  it('W13 a failed Job fails with TaskFailed', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['migrate'], fixture('job-failed')), k13({ fixture: 'job-failed/events' })], clock);
    const result = await drive(clock, waitConvergence(subject([change('migrate', 'Job', 'migrate-0a492d34', 1)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures[0].reason).toBe('TaskFailed');
    expect(result.failures[0].message.startsWith('Job migrate failed: ')).toBe(true);
    expect(result.failures[0].message).toContain('(events: BackoffLimitExceeded: Job has reached the specified backoff limit)');
  });

  it('W14 a Pending claim reads PVCs from the next poll on and fails with F10 and the provisioning event', async () => {
    const clock = new FakeClock();
    // polls at 0, 2, 5, 9, ..., 59, 64: the claim is seen Pending from 2 s, so 64 s is the first past 60 s
    const script: KubeStep[] = [k12(['web'], fixture('pvc-pending-rwx'))];
    for (let i = 0; i < 14; i++) script.push(k12(['web'], fixture('pvc-pending-rwx')), k09({ fixture: 'pvc-pending-rwx/persistentvolumeclaims' }));
    script.push(k13({ fixture: 'pvc-pending-rwx/events' }));
    const exec = scripted(script, clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 1)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures[0].reason).toBe('PvcPending');
    expect(result.failures[0].message).toBe(
      'Service web is waiting for volume shared: failed to provision volume with StorageClass "dockflow-local": NodePath only supports ReadWriteOnce and ReadWriteOncePod (1.22+) access modes',
    );
    expect(result.suggestion).toBe('Check the volume with `dockflow volumes list production`.');
  });

  it('W15 a fix for a crash-looping service is not failed by the old pods before the controller syncs (K16)', async () => {
    const clock = new FakeClock();
    const rs7 = replicaSet('7', '00000000-0000-4000-8000-000000000107');
    const rs8 = replicaSet('8', '00000000-0000-4000-8000-000000000108');
    const owner = (rs: ReplicaSet) => ({ kind: 'ReplicaSet', name: rs.metadata.name, uid: rs.metadata.uid ?? '' });
    const oldPod = pod('web-7-a', '00000000-0000-4000-8000-000000000117', owner(rs7), 'crashloop');
    const newPod = (state: PodState) => pod('web-8-a', '00000000-0000-4000-8000-000000000118', owner(rs8), state);
    const exec = scripted(
      [
        k12(['web'], list(deployment({ generation: 8, revision: '7', status: { observedGeneration: 7, replicas: 1, updatedReplicas: 1 } }), rs7, oldPod)),
        k12(
          ['web'],
          list(deployment({ generation: 8, revision: '8', status: { observedGeneration: 8, replicas: 2, updatedReplicas: 1 } }), rs7, rs8, oldPod, newPod('creating')),
        ),
        k12(
          ['web'],
          list(
            deployment({ generation: 8, revision: '8', status: { observedGeneration: 8, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } }),
            rs8,
            newPod('ready'),
          ),
        ),
      ],
      clock,
    );
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 8)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result).toEqual({ status: 'converged', failures: [] });
    expect(reporter.spinner).toEqual([
      'start: Waiting for web...',
      'update: Waiting: web waiting for the controller (0s)',
      'update: Waiting: web 1 old pod(s) pending termination (2s)',
      'succeed: web ready (5s)',
    ]);
  });

  it('W16 a published port held by another stack fails with LoadBalancerPending naming its owner (K19)', async () => {
    const clock = new FakeClock();
    const ready = items('rollout-complete', WORKLOAD_RESOURCES);
    const unbound = lbService('web-lb', NS, [80], false, '00000000-0000-4000-8000-000000000201');
    const traefik = lbService('dockflow-traefik', 'dockflow-system', [80, 443], true, '00000000-0000-4000-8000-000000000202');
    const exec = scripted(
      [
        k12(['web'], list(...ready, unbound), { times: 'any', resources: `${K12},services` }),
        k13b(list(unbound, traefik)),
      ],
      clock,
    );
    const result = await drive(
      clock,
      waitConvergence(subject([change('web', 'Deployment', 'web', 2)], { lbWatch: [WEB_LB] }), WAIT, depsFor(exec, clock, new RecordingReporter())),
    );
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([
      {
        service: 'web',
        reason: 'LoadBalancerPending',
        message: 'Published port 80/TCP of service web cannot be bound: it is already used by service dockflow-traefik in namespace dockflow-system',
      },
    ]);
    expect(result.suggestion).toBe('Change the published port of `web` in docker-compose.yml, or stop the stack that uses it.');
    // no K13: the owner lookup replaces the events read for this failure
    expect(exec.calls.some((c) => c.call.args[1] === 'events')).toBe(false);
    const elapsed = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
  });

  it('W17 a -lb Service bound late converges without the owner lookup', async () => {
    const clock = new FakeClock();
    const startMs = clock.now().getTime();
    const ready = items('rollout-complete', WORKLOAD_RESOURCES);
    const exec = scripted(
      [
        k12(
          ['web'],
          () => {
            const bound = clock.now().getTime() - startMs >= 40_000;
            const service = lbService('web-lb', NS, [80], bound, '00000000-0000-4000-8000-000000000201');
            return { exitCode: 0, stdout: JSON.stringify(listBody([...ready, service])), stderr: '' };
          },
          { times: 'any', resources: `${K12},services` },
        ),
      ],
      clock,
    );
    const reporter = new RecordingReporter();
    const result = await drive(
      clock,
      waitConvergence(subject([change('web', 'Deployment', 'web', 2)], { lbWatch: [WEB_LB] }), WAIT, depsFor(exec, clock, reporter)),
    );
    exec.assertDone();
    expect(result).toEqual({ status: 'converged', failures: [] });
    expect(reporter.spinner).toContain('update: Waiting: web ready · web-lb pending (0s)');
    expect(reporter.spinner.at(-1)).toBe('succeed: web ready (44s)');
  });

  it('reads the -lb Services in the same call, with their service in the selector (K19)', async () => {
    const clock = new FakeClock();
    const ready = items('rollout-complete', FIXTURE_RESOURCES);
    const exec = scripted([k12(['api', 'web'], list(...ready), { resources: `${K12},services` })], clock);
    const api = change('api', 'Deployment', 'web', 2);
    const result = await drive(clock, waitConvergence(subject([api], { lbWatch: [WEB_LB] }), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('converged');
    expect(exec.calls).toHaveLength(1);
  });

  it('W18 a non-transient read error ends the wait with its own message, never "Lost contact" (K73)', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], { error: 'Forbidden' })], clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result).toEqual({
      status: 'timeout',
      failures: [],
      message: 'The Dockflow deploy identity is not allowed to watch the rollout of web',
      suggestion: 'Re-run `dockflow setup k3s production`.',
    });
    expect(clock.sleeps).toEqual([]);
  });

  it('W19 a paused Deployment fails with F15 at the first poll', async () => {
    const clock = new FakeClock();
    const rs = replicaSet('3', '00000000-0000-4000-8000-000000000103');
    const paused = deployment({ generation: 3, revision: '3', paused: true, status: { observedGeneration: 3, replicas: 1 } });
    const exec = scripted([k12(['web'], list(paused, rs)), k13(list())], clock);
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 3)]), WAIT, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([{ service: 'web', reason: 'Paused', message: 'Service web has a paused rollout, so the new version cannot start' }]);
    expect(result.suggestion).toBe(`Resume it with \`kubectl -n ${NS} rollout resume deployment/web\`, then deploy again.`);
  });

  it('redacts failure messages and the events attached to them', async () => {
    const clock = new FakeClock();
    const events = structuredClone(loadKubectlResources<Event>('crashloop', ['events']).items);
    const backOff = events.find((e) => e.reason === 'BackOff');
    if (!backOff) throw new Error('no BackOff event');
    backOff.message = `Back-off restarting failed container web-app: password ${SECRET} rejected`;
    const exec = scripted([k12(['web-app'], fixture('crashloop')), k13(list(...events))], clock, new Redactor([SECRET]));
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web_app', 'Deployment', 'web-app', 1)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.failures[0].message).toContain('password *** rejected');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(reporter.spinner.join('\n')).not.toContain(SECRET);
  });

  it('never throws: an unexpected error becomes a failed result', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], () => {
          throw new Error(`boom ${SECRET}`);
        }),
      ],
      clock,
      new Redactor([SECRET]),
    );
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', 2)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result).toEqual({ status: 'failed', failures: [], message: 'Waiting for app workloads failed: boom ***' });
    expect(reporter.spinner.at(-1)).toBe('fail: Waiting for app workloads failed: boom ***');
  });
});

describe('waitConvergence on FakeCluster', () => {
  it('U-BE-STACK-07 a crash-looping rollout fails fast, within 3 polls, and never throws', async () => {
    const { clock, cluster, exec } = clusterSetup((c) => c.behave(IMAGE, { kind: 'crashloop', exitCode: 1, message: 'cannot open config' }));
    await applyAll(exec, workloadManifest('web', IMAGE));
    const result = await drive(
      clock,
      waitConvergence(subject([change('web', 'Deployment', 'web', generationOf(cluster, 'web'))]), WAIT, depsFor(exec, clock, new RecordingReporter())),
    );
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result.status).toBe('failed');
    expect(result.failures[0].reason).toBe('CrashLoopBackOff');
    expect(result.failures[0].message).toContain('(events: BackOff: Back-off restarting failed container web');
    expect(k12Calls(exec).length).toBeLessThanOrEqual(3);
    // the 2 s -> 5 s cadence, one second more per poll
    expect(clock.sleeps.every((ms, i) => ms === Math.min(2000 + i * 1000, 5000))).toBe(true);
  });

  it('U-BE-STACK-08 everything Ready converges with one combined read per poll, -lb Services included', async () => {
    const { clock, cluster, exec } = clusterSetup();
    await applyAll(exec, workloadManifest('web', IMAGE, 2), lbManifest('web', 8080));
    const lb: LbWatchTarget = { service: 'web', name: 'web-lb', ports: [{ port: 8080, protocol: 'TCP' }] };
    const result = await drive(
      clock,
      waitConvergence(subject([change('web', 'Deployment', 'web', generationOf(cluster, 'web'))], { lbWatch: [lb] }), WAIT, depsFor(exec, clock, new RecordingReporter())),
    );
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result).toEqual({ status: 'converged', failures: [] });
    const reads = exec.calls.filter((c) => c.call.args[0] === 'get');
    expect(reads).toHaveLength(clock.sleeps.length + 1);
    expect(reads.every((c) => c.call.args[1] === `${K12},services`)).toBe(true);
  });

  it('U-BE-STACK-08b a host port claimed in another namespace fails with LoadBalancerPending after the grace', async () => {
    const { clock, cluster, exec } = clusterSetup((c) => c.claimHostPort(8080, 'TCP', { namespace: 'dockflow-other-production', name: 'api-lb' }));
    await applyAll(exec, workloadManifest('web', IMAGE), lbManifest('web', 8080));
    const lb: LbWatchTarget = { service: 'web', name: 'web-lb', ports: [{ port: 8080, protocol: 'TCP' }] };
    const result = await drive(
      clock,
      waitConvergence(subject([change('web', 'Deployment', 'web', generationOf(cluster, 'web'))], { lbWatch: [lb] }), WAIT, depsFor(exec, clock, new RecordingReporter())),
    );
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([
      {
        service: 'web',
        reason: 'LoadBalancerPending',
        message: 'Published port 8080/TCP of service web cannot be bound: it is already used by service api-lb in namespace dockflow-other-production',
      },
    ]);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it('K16 lag: the old crash-looping pods are ignored until the controller observes the new generation', async () => {
    const broken = 'registry.example.com/shop/web:1.4.1';
    const { clock, cluster, exec } = clusterSetup((c) => c.behave(broken, { kind: 'crashloop', exitCode: 1 }));
    await applyAll(exec, workloadManifest('web', broken));
    await clock.advance(5000);
    cluster.lag(3);
    await applyAll(exec, workloadManifest('web', IMAGE));
    const generation = generationOf(cluster, 'web');
    expect(generation).toBe(2);
    const reporter = new RecordingReporter();
    const result = await drive(clock, waitConvergence(subject([change('web', 'Deployment', 'web', generation)]), WAIT, depsFor(exec, clock, reporter)));
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result).toEqual({ status: 'converged', failures: [] });
    // v1's pods crash-loop through the lag, and the wait never reads them as a failure
    expect(reporter.spinner.slice(0, 3)).toEqual([
      'start: Waiting for web...',
      'update: Waiting: web waiting for the controller (0s)',
      'update: Waiting: web waiting for the controller (2s)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

describe('checkHealth', () => {
  it('is healthy without any call when nothing but Jobs changed, or the receipt is skipped or unknown', async () => {
    const clock = new FakeClock();
    const exec = scripted([], clock);
    const reporter = new RecordingReporter();
    const deps = depsFor(exec, clock, reporter);
    const web = [change('web', 'Deployment', 'web', 2)];
    for (const target of [subject([change('migrate', 'Job', 'migrate-0a492d34', 1)]), subject(web, { skipped: true }), subject(web, { known: false })]) {
      expect(await drive(clock, checkHealth(target, HEALTH, deps))).toEqual({ healthy: true, rolledBack: false, failures: [] });
    }
    exec.assertDone();
    expect(exec.calls).toHaveLength(0);
    expect(reporter.spinner).toEqual([]);
  });

  it('H1 stays healthy for the window, polling every 5 s', async () => {
    const clock = new FakeClock();
    const exec = scripted([roleRead(fixture('rollout-complete')), k12(['web'], fixture('rollout-complete'), { times: 3 })], clock);
    const reporter = new RecordingReporter();
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), HEALTH, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result).toEqual({ healthy: true, rolledBack: false, failures: [] });
    expect(clock.sleeps).toEqual([5000, 5000]);
    expect(reporter.spinner).toEqual(['start: Checking that web stay healthy for 10s...', 'succeed: web stayed healthy for 10s']);
    expect(reporter.warnings).toEqual([]);
  });

  it('H2 a restart inside the window is ContainerRestarted', async () => {
    const clock = new FakeClock();
    const restarted = items('rollout-complete');
    const status = firstStatus(findPod(restarted, 'web-b655d585b-7jdgc'));
    status.restartCount = 1;
    status.lastState = { terminated: { exitCode: 137, reason: 'Error' } };
    const exec = scripted(
      [roleRead(fixture('rollout-complete')), k12(['web'], fixture('rollout-complete')), k12(['web'], list(...restarted)), k13(list())],
      clock,
    );
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), HEALTH, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.healthy).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.failures).toEqual([
      {
        service: 'web',
        reason: 'ContainerRestarted',
        message: 'Service web restarted during the health window: container web in pod web-b655d585b-7jdgc (last exit code 137, Error)',
        instance: 'web-b655d585b-7jdgc',
        node: 'server_1',
      },
    ]);
    expect(result.message).toBe(result.failures[0].message);
  });

  it('H3 an unhealthy unchanged workload is a warning only', async () => {
    const clock = new FakeClock();
    const worker = deployment({ name: 'worker', uid: '00000000-0000-4000-8000-000000000301', generation: 1, status: { observedGeneration: 1 } });
    const exec = scripted([roleRead(list(...items('rollout-complete'), worker)), k12(['web'], fixture('rollout-complete'), { times: 3 })], clock);
    const reporter = new RecordingReporter();
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), HEALTH, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.healthy).toBe(true);
    expect(reporter.warnings).toEqual(['Service worker (unchanged by this deploy) has 0/1 ready pod(s); run dockflow diagnose production']);
  });

  it('a failed warning read is ignored', async () => {
    const clock = new FakeClock();
    const exec = scripted([roleRead({ error: 'Forbidden' }), k12(['web'], fixture('rollout-complete'), { times: 3 })], clock);
    const reporter = new RecordingReporter();
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), HEALTH, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.healthy).toBe(true);
    expect(reporter.warnings).toEqual([]);
  });

  it('H4 two lost polls neither fail the check nor reset the stability window (K41(a))', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        roleRead(fixture('rollout-complete')),
        k12(['web'], fixture('rollout-complete')),
        k12(['web'], { error: 'Unreachable' }),
        k12(['web'], { transportError: true }),
        k12(['web'], fixture('rollout-complete'), { times: 2 }),
      ],
      clock,
    );
    const options: HealthOptions = { ...HEALTH, stabilityS: 20 };
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), options, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    // Ready at 0, lost at 5 and 10, Ready at 15 and 20: the window opened at 0 closes at 20
    expect(result).toEqual({ healthy: true, rolledBack: false, failures: [] });
    expect(clock.sleeps).toEqual([5000, 5000, 5000, 5000]);
  });

  it('H5 the third lost poll fails the check with "Lost contact"', async () => {
    const clock = new FakeClock();
    const exec = scripted([roleRead(fixture('rollout-complete')), k12(['web'], { transportError: true }, { times: 3 })], clock);
    const reporter = new RecordingReporter();
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), HEALTH, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.healthy).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.message?.startsWith('Lost contact with the Kubernetes API on server_1 while checking web: ')).toBe(true);
    expect(result.suggestion).toBe('Run `dockflow status production`.');
    expect(reporter.spinner.at(-1)).toBe('fail: Lost contact with the Kubernetes API');
  });

  it('H6 a refused read fails the check with its own message', async () => {
    const clock = new FakeClock();
    const exec = scripted([roleRead(fixture('rollout-complete')), k12(['web'], { error: 'Forbidden' })], clock);
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), HEALTH, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result).toEqual({
      healthy: false,
      rolledBack: false,
      failures: [],
      message: 'The Dockflow deploy identity is not allowed to check the health of web',
      suggestion: 'Re-run `dockflow setup k3s production`.',
    });
  });

  it('times out with the pod that is not Ready', async () => {
    const clock = new FakeClock();
    const exec = scripted([roleRead(fixture('rollout-progressing')), k12(['web'], fixture('rollout-progressing'), { times: 'any' }), k13(list())], clock);
    const reporter = new RecordingReporter();
    const options: HealthOptions = { ...HEALTH, timeoutS: 12 };
    const result = await drive(clock, checkHealth(subject([change('web', 'Deployment', 'web', 2)]), options, depsFor(exec, clock, reporter)));
    exec.assertDone();
    expect(result.healthy).toBe(false);
    expect(result.failures).toEqual([
      {
        service: 'web',
        reason: 'Timeout',
        message: 'Service web is not healthy after 12s: pod web-96d55d8c4-l67lt is Running (not ready)',
        instance: 'web-96d55d8c4-l67lt',
        node: 'agent_1',
      },
    ]);
    expect(reporter.spinner.at(-1)).toBe('fail: Health check timed out after 12s');
  });

  it('U-BE-STACK-09 restarts during the stability window on FakeCluster', async () => {
    const { clock, cluster, exec } = clusterSetup((c) => c.behave(IMAGE, { kind: 'restarts-after-ready', everyTicks: 4 }));
    await applyAll(exec, workloadManifest('web', IMAGE));
    await clock.advance(3000);
    const result = await drive(
      clock,
      checkHealth(subject([change('web', 'Deployment', 'web', generationOf(cluster, 'web'))]), HEALTH, depsFor(exec, clock, new RecordingReporter())),
    );
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result.healthy).toBe(false);
    expect(result.failures[0].reason).toBe('ContainerRestarted');
  });
});

// ---------------------------------------------------------------------------
// pollInventoryUntil
// ---------------------------------------------------------------------------

const WEB_TARGET: InventoryTarget = { service: 'web', kind: 'Deployment', name: 'web', namespace: NS };
const INVENTORY = { env: 'production', role: 'app' as const, timeoutS: 60, selectors: { [NS]: podSelector('web') } };

function observation(workload: InventoryObservation['workload'], extra: Partial<InventoryObservation> = {}): InventoryObservation {
  return { target: WEB_TARGET, workload, currentPods: [], pods: [], ...extra };
}

describe('pollInventoryUntil', () => {
  it('waits for a scaled Deployment on FakeCluster', async () => {
    const { clock, cluster, exec } = clusterSetup();
    await applyAll(exec, workloadManifest('web', IMAGE));
    await clock.advance(5000);
    await exec.run({ args: ['scale', 'deployments.apps/web', '--replicas=2'], namespace: NS, mutating: true });
    const result = await drive(clock, pollInventoryUntil([WEB_TARGET], scaledTo(2), INVENTORY, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.observations[0].pods.filter((p) => p.metadata.deletionTimestamp === undefined)).toHaveLength(2);
  });

  it('fails fast on a crash-looping current pod (U-BE-STACK-18)', async () => {
    const { clock, cluster, exec } = clusterSetup((c) => c.behave(IMAGE, { kind: 'crashloop', exitCode: 1 }));
    await applyAll(exec, workloadManifest('web', IMAGE));
    const result = await drive(clock, pollInventoryUntil([WEB_TARGET], rolledOut(), INVENTORY, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    cluster.assertNoProblems();
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.reason).toBe('CrashLoopBackOff');
    expect(result.failure.message.startsWith('Service web keeps crashing: container web restarted')).toBe(true);
    expect(result.suggestion).toBe('Run `dockflow logs production web`.');
  });

  it('a target of 0 replicas whose status counters are omitted is done at the first poll (?? 0)', async () => {
    const clock = new FakeClock();
    const stopped = deployment({ generation: 3, revision: '3', replicas: 0, status: { observedGeneration: 3 } });
    const exec = scripted([k12(['web'], list(stopped), { times: 2 })], clock);
    const deps = depsFor(exec, clock, new RecordingReporter());
    expect((await drive(clock, pollInventoryUntil([WEB_TARGET], scaledTo(0), INVENTORY, deps))).status).toBe('done');
    expect((await drive(clock, pollInventoryUntil([WEB_TARGET], rolledOut(), INVENTORY, deps))).status).toBe('done');
    exec.assertDone();
    expect(clock.sleeps).toEqual([]);
  });

  it('times out with the pending targets and where they stand', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], fixture('rollout-progressing', WORKLOAD_RESOURCES), { times: 'any' })], clock);
    const result = await drive(clock, pollInventoryUntil([WEB_TARGET], scaledTo(3), { ...INVENTORY, timeoutS: 6 }, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('timeout');
    if (result.status !== 'timeout') return;
    expect(result.pending).toHaveLength(1);
    expect(inventorySummary(result.pending[0])).toBe('pod web-96d55d8c4-l67lt is Running (not ready)');
    expect(clock.sleeps).toEqual([2000, 3000, 1000]);
  });

  it('stop waits until no pod of the target remains, terminating ones included', async () => {
    const clock = new FakeClock();
    const rs = replicaSet('3', '00000000-0000-4000-8000-000000000103');
    const stopped = deployment({ generation: 4, revision: '3', replicas: 0, status: { observedGeneration: 4 } });
    const leaving = pod('web-3-a', '00000000-0000-4000-8000-000000000113', { kind: 'ReplicaSet', name: rs.metadata.name, uid: rs.metadata.uid ?? '' }, 'running', { deleting: true });
    const exec = scripted([k12(['web'], list(stopped, rs, leaving)), k12(['web'], list(stopped, rs))], clock);
    const result = await drive(clock, pollInventoryUntil([WEB_TARGET], podsGone(), INVENTORY, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('done');
    expect(clock.sleeps).toEqual([2000]);
  });

  it('reads each namespace once per poll, with its own selector or none', async () => {
    const clock = new FakeClock();
    const cacheNs = 'shop-cache';
    const exec = scripted(
      [
        k12(['web'], fixture('rollout-complete', WORKLOAD_RESOURCES)),
        { id: 'K12-helm', method: 'getJson', args: ['get', K12, '-o', 'json'], namespace: cacheNs, mutating: false, respond: fixture('rollout-complete', WORKLOAD_RESOURCES) },
      ],
      clock,
    );
    const targets: InventoryTarget[] = [WEB_TARGET, { service: 'cache', kind: 'Deployment', name: 'web', namespace: cacheNs }];
    const result = await drive(clock, pollInventoryUntil(targets, rolledOut(), INVENTORY, depsFor(exec, clock, new RecordingReporter())));
    exec.assertDone();
    expect(result.status).toBe('done');
    expect(exec.calls.map((c) => c.call.namespace)).toEqual([NS, cacheNs]);
  });

  it('absorbs two transient failures and throws "Lost contact" on the third', async () => {
    const clock = new FakeClock();
    const exec = scripted(
      [
        k12(['web'], { error: 'Unreachable' }, { times: 2 }),
        k12(['web'], fixture('rollout-complete', WORKLOAD_RESOURCES)),
        k12(['web'], { transportError: true }, { times: 3 }),
      ],
      clock,
    );
    const deps = depsFor(exec, clock, new RecordingReporter());
    expect((await drive(clock, pollInventoryUntil([WEB_TARGET], rolledOut(), INVENTORY, deps))).status).toBe('done');
    const lost = drive(clock, pollInventoryUntil([WEB_TARGET], rolledOut(), INVENTORY, deps));
    await expect(lost).rejects.toBeInstanceOf(OrchestratorUnavailableError);
    await expect(lost).rejects.toThrow(/^Lost contact with the Kubernetes API on server_1 while waiting for web: /);
    exec.assertDone();
  });

  it('throws what a refused read maps to', async () => {
    const clock = new FakeClock();
    const exec = scripted([k12(['web'], { error: 'Forbidden' })], clock);
    const refused = drive(clock, pollInventoryUntil([WEB_TARGET], rolledOut(), INVENTORY, depsFor(exec, clock, new RecordingReporter())));
    await expect(refused).rejects.toThrow('The Dockflow deploy identity is not allowed to wait for web');
    exec.assertDone();
  });

  it('is done without any read when there is no target', async () => {
    const clock = new FakeClock();
    const exec = scripted([], clock);
    expect(await drive(clock, pollInventoryUntil([], rolledOut(), INVENTORY, depsFor(exec, clock, new RecordingReporter())))).toEqual({
      status: 'done',
      observations: [],
    });
    exec.assertDone();
  });
});

describe('inventory predicates', () => {
  const statefulSet = (status: StatefulSet['status'], replicas = 2): StatefulSet => ({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: 'db', namespace: NS, generation: 2 },
    spec: { replicas, selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'db', image: 'postgres:17' }] } } },
    status,
  });
  const daemonSet = (status: DaemonSet['status']): DaemonSet => ({
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: 'agent', namespace: NS, generation: 1 },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'agent', image: 'registry.example.com/shop/agent:1' }] } } },
    status,
  });

  it('rolledOut reads every counter with ?? 0 and requires the latest generation observed', () => {
    const done = rolledOut();
    expect(done(observation(null))).toBe(false);
    expect(done(observation(deployment({ generation: 2, replicas: 0, status: { observedGeneration: 2 } })))).toBe(true);
    expect(done(observation(deployment({ generation: 3, replicas: 0, status: { observedGeneration: 2 } })))).toBe(false);
    expect(done(observation(deployment({ generation: 2, replicas: 2, status: { observedGeneration: 2, replicas: 3, updatedReplicas: 2, readyReplicas: 2 } })))).toBe(false);
    expect(done(observation(deployment({ generation: 2, replicas: 2, status: { observedGeneration: 2, replicas: 2, updatedReplicas: 2, readyReplicas: 2 } })))).toBe(true);
    expect(done(observation(statefulSet({ observedGeneration: 2, currentRevision: 'db-1', updateRevision: 'db-2', readyReplicas: 2 })))).toBe(false);
    expect(done(observation(statefulSet({ observedGeneration: 2, currentRevision: 'db-2', updateRevision: 'db-2', readyReplicas: 2 })))).toBe(true);
    expect(done(observation(statefulSet({ observedGeneration: 2 }, 0)))).toBe(true);
    expect(done(observation(daemonSet({ observedGeneration: 1 })))).toBe(true);
    expect(done(observation(daemonSet({ observedGeneration: 1, desiredNumberScheduled: 2, updatedNumberScheduled: 2, numberReady: 1 })))).toBe(false);
  });

  it('scaledTo counts only pods that are not terminating and never matches a DaemonSet', () => {
    const rs = replicaSet('3', '00000000-0000-4000-8000-000000000103');
    const owner = { kind: 'ReplicaSet', name: rs.metadata.name, uid: rs.metadata.uid ?? '' };
    const web = deployment({ generation: 2, replicas: 1, status: { observedGeneration: 2, readyReplicas: 1 } });
    const ready = pod('web-3-a', '00000000-0000-4000-8000-000000000113', owner, 'ready');
    const leaving = pod('web-3-b', '00000000-0000-4000-8000-000000000114', owner, 'running', { deleting: true });
    expect(scaledTo(1)(observation(web, { pods: [ready, leaving] }))).toBe(true);
    expect(scaledTo(1)(observation(web, { pods: [ready, { ...ready, metadata: { ...ready.metadata, name: 'web-3-c' } }] }))).toBe(false);
    expect(scaledTo(0)(observation(daemonSet({ observedGeneration: 1 })))).toBe(false);
  });

  it('inventorySummary says where a target stands', () => {
    expect(inventorySummary(observation(null))).toBe('deployment/web was not found');
    expect(inventorySummary(observation(deployment({ generation: 3, status: { observedGeneration: 2 } })))).toBe('waiting for the controller');
    expect(inventorySummary(observation(deployment({ generation: 2, status: { observedGeneration: 2 } }), { currentPods: null }))).toBe(
      'waiting for the new revision',
    );
    expect(
      inventorySummary(observation(deployment({ generation: 2, replicas: 2, status: { observedGeneration: 2, readyReplicas: 1 } }), { currentPods: [] })),
    ).toBe('1/2 ready');
  });
});
