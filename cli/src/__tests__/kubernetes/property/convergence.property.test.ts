// design-07 8.3 P-C01..P-C03 and the K16 rule of design-03 9.3, over generated workload states:
// the two gates run before any pod is classified, a fatal signal on a current-revision pod always
// fails the wait, a graced signal fails only after an uninterrupted grace, pods of older revisions
// and of other workloads never influence a verdict, and an unbound `-lb` Service fails after its
// grace. The receipt side of P-C03 (which Services become targets) belongs to the apply planners.
// Status counters are derived from the generated pods the way the controllers report them.

import { describe, expect, mock } from 'bun:test';
import { K8S_LB_PENDING_GRACE_S, KUBE_KEYS, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import type {
  ControllerRevision,
  DaemonSet,
  Deployment,
  ReplicaSet,
  StatefulSet,
} from '../../../services/orchestrator/kubernetes/resources/apps';
import type { ContainerState, ContainerStatus, Pod, PodSpec, PodStatus, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { OwnerReference } from '../../../services/orchestrator/kubernetes/resources/meta';
import {
  classifyPods,
  convergenceStep,
  type EvaluationContext,
  evaluateConvergence,
  K8S_FAILFAST_GRACE_S,
  type LbPort,
  type LbWatchTarget,
  lbTargetKey,
  type PollObject,
  pollSnapshot,
  targetKey,
  timeoutVerdicts,
  type Verdict,
  type WatchState,
  type WatchTarget,
} from '../../../services/orchestrator/kubernetes/status/convergence';
import { pick, randomInt, type Rng } from '../support/prng';
import { forAll, type Gen } from '../support/property';

const T0 = new Date('2026-01-01T00:20:00.000Z');
const DEADLINE = new Date(T0.getTime() + 300_000);
const NS = 'dockflow-shop-production';
const EMPTY: WatchState = { firstSeen: {} };
const CONTEXT: EvaluationContext = {
  importedPrefix: 'dockflow.invalid/',
  nodeNames: { 'server-1': 'server_1' },
  role: 'app',
  env: 'production',
  namespace: NS,
  timeoutS: 300,
};

const PUBLIC_IMAGE = 'registry.example.com/shop/web:1.4.2';
const IMPORTED_IMAGE = 'dockflow.invalid/shop-web:1.4.2';
const NEW_HASH = '7c9d8e6f5a';
const OLD_HASH = '5f2a1b3c4d';
const OTHER_HASH = 'a1b2c3d4e5';
const OTHER_UID = 'uid-other';
const SUFFIX_CHARS = [...'bcdfghjklmnpqrstvwxz2456789'];

type RolledKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';
const KINDS: readonly RolledKind[] = ['Deployment', 'StatefulSet', 'DaemonSet'];
/** compose name, Kubernetes name */
const NAMES: readonly (readonly [string, string])[] = [
  ['web', 'web'],
  ['web_app', 'web-app'],
  ['db', 'db'],
  ['queue', 'queue'],
  ['agent', 'agent'],
];

/** states whose signal has grace 0, with the reason they fail with */
const FATAL_REASON = {
  crashloop: 'CrashLoopBackOff',
  'never-pull': 'ErrImageNeverPull',
  'invalid-image': 'InvalidImageName',
  'pull-imported': 'ErrImagePull',
  oom: 'OOMKilled',
} as const;
/** states whose signal only fails after its grace */
const GRACED_REASON = {
  'pull-public': 'ImagePullBackOff',
  'config-error': 'CreateContainerConfigError',
  'create-error': 'CreateContainerError',
  unschedulable: 'Unschedulable',
} as const;
const QUIET_STATES = ['ready', 'running-unready', 'creating'] as const;

type FatalState = keyof typeof FATAL_REASON;
type GracedState = keyof typeof GRACED_REASON;
type PodState = (typeof QUIET_STATES)[number] | GracedState | FatalState;

const FATAL_STATES = Object.keys(FATAL_REASON) as FatalState[];
const GRACED_STATES = Object.keys(GRACED_REASON) as GracedState[];
const ALL_STATES: readonly PodState[] = [...QUIET_STATES, ...GRACED_STATES, ...FATAL_STATES];

function isFatal(state: PodState): state is FatalState {
  return Object.hasOwn(FATAL_REASON, state);
}

interface PodCase {
  state: PodState;
  /** the signal sits on an init container */
  init: boolean;
  /** pull failures: ErrImagePull instead of ImagePullBackOff (kubelet alternates the two) */
  alt: boolean;
  suffix: string;
}

interface WorkloadCase {
  kind: RolledKind;
  service: string;
  name: string;
  generation: number;
  observedGeneration: number;
  /** the ReplicaSet / ControllerRevision of the applied revision exists */
  revisionExists: boolean;
  paused: boolean;
  deleting: boolean;
  desired: number;
  /** pods of the applied revision */
  current: PodCase[];
  /** pods of the previous revision of the same workload */
  old: PodCase[];
  /** pods of another workload carrying the same labels */
  unrelated: PodCase[];
  /** Kubernetes omits zero counters */
  omitZeros: boolean;
}

// ---------------------------------------------------------------------------
// Object builders
// ---------------------------------------------------------------------------

type PodGroup = 'current' | 'old' | 'unrelated';

function podName(c: WorkloadCase, group: PodGroup, pod: PodCase, index: number): string {
  const prefix = group === 'unrelated' ? 'other' : c.name;
  return `${prefix}-${group === 'old' ? 'o' : ''}${pod.suffix}${index}`;
}

function ownerRef(kind: string, name: string, uid: string): OwnerReference {
  return { apiVersion: 'apps/v1', kind, name, uid, controller: true };
}

function waiting(name: string, image: string, reason: string, message: string, restartCount = 0, lastState?: ContainerState): ContainerStatus {
  return { name, image, ready: false, restartCount, state: { waiting: { reason, message } }, ...(lastState ? { lastState } : {}) };
}

function signalStatus(name: string, image: string, pod: PodCase): ContainerStatus {
  switch (pod.state) {
    case 'pull-public':
    case 'pull-imported':
      return waiting(name, image, pod.alt ? 'ErrImagePull' : 'ImagePullBackOff', `Back-off pulling image "${image}"`);
    case 'config-error':
      return waiting(name, image, 'CreateContainerConfigError', 'secret "web-env" not found');
    case 'create-error':
      return waiting(name, image, 'CreateContainerError', 'failed to create containerd task');
    case 'crashloop':
      return waiting(name, image, 'CrashLoopBackOff', 'back-off 40s restarting failed container', 3, { terminated: { exitCode: 1, reason: 'Error' } });
    case 'oom':
      return waiting(name, image, 'CrashLoopBackOff', 'back-off 20s restarting failed container', 2, {
        terminated: { exitCode: 137, reason: 'OOMKilled' },
      });
    case 'never-pull':
      return waiting(name, image, 'ErrImageNeverPull', 'Container image is not present with pull policy of Never');
    case 'invalid-image':
      return waiting(name, image, 'InvalidImageName', 'failed to parse the image name');
    default:
      return waiting(name, image, 'ContainerCreating', '');
  }
}

function podStatus(pod: PodCase, image: string, spec: PodSpec): PodStatus {
  const ready = (value: boolean) => [
    { type: 'PodScheduled', status: 'True' as const },
    { type: 'Ready', status: value ? ('True' as const) : ('False' as const) },
  ];
  switch (pod.state) {
    case 'ready':
      return {
        phase: 'Running',
        conditions: ready(true),
        containerStatuses: [{ name: 'app', image, ready: true, restartCount: 0, state: { running: { startedAt: '2026-01-01T00:19:00Z' } } }],
      };
    case 'running-unready':
      return {
        phase: 'Running',
        conditions: ready(false),
        containerStatuses: [{ name: 'app', image, ready: false, restartCount: 0, state: { running: { startedAt: '2026-01-01T00:19:00Z' } } }],
      };
    case 'creating':
      return { phase: 'Pending', conditions: ready(false), containerStatuses: [waiting('app', image, 'ContainerCreating', '')] };
    case 'unschedulable':
      return {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available: 2 Insufficient memory.' }],
      };
    default:
      if (pod.init) {
        spec.initContainers = [{ name: 'init', image }];
        return {
          phase: 'Pending',
          conditions: ready(false),
          initContainerStatuses: [signalStatus('init', image, pod)],
          containerStatuses: [waiting('app', image, 'PodInitializing', '')],
        };
      }
      return { phase: 'Running', conditions: ready(false), containerStatuses: [signalStatus('app', image, pod)] };
  }
}

function buildPod(name: string, owner: OwnerReference, labels: Record<string, string>, pod: PodCase): Pod {
  const image = pod.state === 'pull-imported' ? IMPORTED_IMAGE : PUBLIC_IMAGE;
  const spec: PodSpec = { containers: [{ name: 'app', image }] };
  if (pod.state !== 'unschedulable') spec.nodeName = 'server-1';
  const status = podStatus(pod, image, spec);
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: NS, uid: `uid-pod-${name}`, labels, ownerReferences: [owner] },
    spec,
    status,
  };
}

function readyCount(pods: readonly PodCase[]): number {
  return pods.filter((p) => p.state === 'ready').length;
}

function compact<T extends object>(status: T, omitZeros: boolean): T {
  if (!omitZeros) return status;
  return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== 0)) as T;
}

interface Built {
  /** workloads, ReplicaSets and ControllerRevisions */
  objects: PollObject[];
  current: Pod[];
  /** old-revision and unrelated pods */
  noise: Pod[];
}

function buildPods(c: WorkloadCase, group: PodGroup, owner: OwnerReference, labels: Record<string, string>): Pod[] {
  return c[group].map((pod, i) => buildPod(podName(c, group, pod, i), owner, labels, pod));
}

function build(c: WorkloadCase): Built {
  const uid = `uid-${c.kind.toLowerCase()}-${c.name}`;
  const labels = { [LABELS.service]: c.name };
  const metadata = {
    name: c.name,
    namespace: NS,
    uid,
    generation: c.generation,
    labels,
    ...(c.deleting ? { deletionTimestamp: '2026-01-01T00:19:30Z' } : {}),
  };
  const template = { metadata: { labels }, spec: { containers: [{ name: 'app', image: PUBLIC_IMAGE }] } };
  const selector = { matchLabels: labels };
  const all = [...c.current, ...c.old];
  const self = ownerRef(c.kind, c.name, uid);

  switch (c.kind) {
    case 'Deployment': {
      const revision = KUBE_KEYS.deploymentRevision;
      const replicaSet = (name: string, rsUid: string, rev: string, owner: OwnerReference): ReplicaSet => ({
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: { name, namespace: NS, uid: rsUid, annotations: { [revision]: rev }, ownerReferences: [owner] },
      });
      const rsNew = replicaSet(`${c.name}-${NEW_HASH}`, `${uid}-rs-new`, '2', self);
      const rsOld = replicaSet(`${c.name}-${OLD_HASH}`, `${uid}-rs-old`, '1', self);
      // same revision number, other owner: never the new ReplicaSet of this Deployment
      const rsOther = replicaSet(`other-${NEW_HASH}`, `${OTHER_UID}-rs`, '2', ownerRef('Deployment', 'other', OTHER_UID));
      const deployment: Deployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { ...metadata, annotations: { [revision]: '2' } },
        spec: {
          ...(c.desired === 1 && c.omitZeros ? {} : { replicas: c.desired }),
          selector,
          template,
          ...(c.paused ? { paused: true } : {}),
        },
        status: compact(
          {
            observedGeneration: c.observedGeneration,
            replicas: all.length,
            updatedReplicas: c.current.length,
            readyReplicas: readyCount(all),
            availableReplicas: readyCount(all),
          },
          c.omitZeros,
        ),
      };
      const hash = (h: string) => ({ ...labels, [KUBE_KEYS.podTemplateHash]: h });
      return {
        objects: [deployment, ...(c.revisionExists ? [rsNew] : []), rsOld, rsOther],
        current: buildPods(c, 'current', ownerRef('ReplicaSet', rsNew.metadata.name, rsNew.metadata.uid ?? ''), hash(NEW_HASH)),
        noise: [
          ...buildPods(c, 'old', ownerRef('ReplicaSet', rsOld.metadata.name, rsOld.metadata.uid ?? ''), hash(OLD_HASH)),
          ...buildPods(c, 'unrelated', ownerRef('ReplicaSet', rsOther.metadata.name, rsOther.metadata.uid ?? ''), hash(NEW_HASH)),
        ],
      };
    }
    case 'StatefulSet': {
      const newRevision = `${c.name}-${NEW_HASH}`;
      const oldRevision = `${c.name}-${OLD_HASH}`;
      const revision = (name: string, number: number): ControllerRevision => ({
        apiVersion: 'apps/v1',
        kind: 'ControllerRevision',
        metadata: { name, namespace: NS, uid: `uid-cr-${name}`, labels: { [KUBE_KEYS.controllerRevisionHash]: name }, ownerReferences: [self] },
        revision: number,
      });
      const rolledOut = c.old.length === 0 && c.current.length === c.desired;
      const statefulSet: StatefulSet = {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata,
        spec: { replicas: c.desired, selector, template, serviceName: `${c.name}-hl` },
        status: {
          ...compact(
            {
              observedGeneration: c.observedGeneration,
              replicas: all.length,
              readyReplicas: readyCount(all),
              currentReplicas: rolledOut ? c.current.length : c.old.length,
              updatedReplicas: c.current.length,
              availableReplicas: readyCount(all),
            },
            c.omitZeros,
          ),
          currentRevision: rolledOut ? newRevision : oldRevision,
          updateRevision: newRevision,
        },
      };
      const hash = (h: string) => ({ ...labels, [KUBE_KEYS.controllerRevisionHash]: h });
      return {
        objects: [statefulSet, ...(c.revisionExists ? [revision(newRevision, 2)] : []), revision(oldRevision, 1)],
        current: buildPods(c, 'current', self, hash(newRevision)),
        noise: [
          ...buildPods(c, 'old', self, hash(oldRevision)),
          ...buildPods(c, 'unrelated', ownerRef('StatefulSet', 'other', OTHER_UID), hash(newRevision)),
        ],
      };
    }
    case 'DaemonSet': {
      const revision = (owner: OwnerReference, hashValue: string, number: number): ControllerRevision => ({
        apiVersion: 'apps/v1',
        kind: 'ControllerRevision',
        metadata: {
          name: `${owner.name}-${hashValue}`,
          namespace: NS,
          uid: `uid-cr-${owner.name}-${hashValue}`,
          labels: { [KUBE_KEYS.controllerRevisionHash]: hashValue },
          ownerReferences: [owner],
        },
        revision: number,
      });
      const other = ownerRef('DaemonSet', 'other', OTHER_UID);
      const daemonSet: DaemonSet = {
        apiVersion: 'apps/v1',
        kind: 'DaemonSet',
        metadata,
        spec: { selector, template },
        status: compact(
          {
            observedGeneration: c.observedGeneration,
            desiredNumberScheduled: c.desired,
            currentNumberScheduled: all.length,
            updatedNumberScheduled: c.current.length,
            numberReady: readyCount(all),
            numberAvailable: readyCount(all),
          },
          c.omitZeros,
        ),
      };
      const hash = (h: string) => ({ ...labels, [KUBE_KEYS.controllerRevisionHash]: h });
      return {
        objects: [
          daemonSet,
          ...(c.revisionExists ? [revision(self, NEW_HASH, 2), revision(self, OLD_HASH, 1)] : []),
          // a newer revision of another DaemonSet is never this one's newest
          revision(other, OTHER_HASH, 99),
        ],
        current: buildPods(c, 'current', self, hash(NEW_HASH)),
        noise: [...buildPods(c, 'old', self, hash(OLD_HASH)), ...buildPods(c, 'unrelated', other, hash(NEW_HASH))],
      };
    }
  }
}

function targetOf(c: WorkloadCase): WatchTarget {
  return { service: c.service, kind: c.kind, name: c.name, serviceLabel: c.name, generation: c.generation };
}

function evaluateCase(c: WorkloadCase, noise: boolean, state: WatchState = EMPTY, now: Date = T0) {
  const built = build(c);
  const snap = pollSnapshot([...built.objects, ...built.current, ...(noise ? built.noise : [])]);
  const classify = mock(classifyPods);
  const target = targetOf(c);
  const evaluation = evaluateConvergence([target], [], snap, state, now, CONTEXT, classify);
  const verdict: Verdict = evaluation.verdicts[targetKey(target)];
  return { verdict, state: evaluation.state, classify, current: built.current };
}

/** the first current pod, in the classifier's name order, whose signal fails at first sight */
function firstFatal(c: WorkloadCase): { name: string; reason: string } | null {
  const named = c.current.map((pod, i) => ({ pod, name: podName(c, 'current', pod, i) }));
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { pod, name } of named) if (isFatal(pod.state)) return { name, reason: FATAL_REASON[pod.state] };
  return null;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function suffix(rng: Rng): string {
  return Array.from({ length: 5 }, () => pick(rng, SUFFIX_CHARS)).join('');
}

function podCases(rng: Rng, count: number, states: readonly PodState[]): PodCase[] {
  return Array.from({ length: count }, () => ({ state: pick(rng, states), init: rng() < 0.3, alt: rng() < 0.5, suffix: suffix(rng) }));
}

interface CaseOptions {
  /** observedGeneration below generation (true), equal (false), either (undefined) */
  lag?: boolean;
  revisionExists?: boolean;
  /** paused Deployments and workloads being deleted may be generated */
  disruptions: boolean;
  /** at least this many current pods */
  minCurrent: number;
  currentStates: readonly PodState[];
  noiseStates: readonly PodState[];
}

function workloadCases(options: CaseOptions): Gen<WorkloadCase> {
  return (rng) => {
    const kind = pick(rng, KINDS);
    const [service, name] = pick(rng, NAMES);
    const generation = randomInt(rng, 1, 20);
    const lag = options.lag ?? rng() < 0.25;
    const desired = randomInt(rng, options.minCurrent, 4);
    const currentCount = randomInt(rng, options.minCurrent, desired);
    // a Deployment surges beside its old pods; StatefulSet ordinals and DaemonSet nodes hold one pod each
    const oldCount = kind === 'Deployment' ? randomInt(rng, 0, 3) : randomInt(rng, 0, desired - currentCount);
    return {
      kind,
      service,
      name,
      generation,
      observedGeneration: lag ? randomInt(rng, 0, generation - 1) : generation,
      revisionExists: options.revisionExists ?? rng() < 0.85,
      paused: options.disruptions && kind === 'Deployment' && rng() < 0.15,
      deleting: options.disruptions && rng() < 0.15,
      desired,
      current: podCases(rng, currentCount, options.currentStates),
      old: podCases(rng, oldCount, options.noiseStates),
      unrelated: podCases(rng, randomInt(rng, 0, 3), options.noiseStates),
      omitZeros: rng() < 0.5,
    };
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('convergence evaluator (design-07 8.3)', () => {
  forAll(
    'P-C02 generation not observed: progressing whatever the pods, and no pod is classified',
    workloadCases({ lag: true, disruptions: true, minCurrent: 1, currentStates: FATAL_STATES, noiseStates: FATAL_STATES }),
    (c) => {
      const { verdict, state, classify } = evaluateCase(c, true);
      expect(verdict).toMatchObject({ state: 'progressing', summary: 'waiting for the controller' });
      expect(classify).not.toHaveBeenCalled();
      expect(state.firstSeen).toEqual({});
    },
  );

  forAll(
    'P-C02 new revision not created yet: progressing whatever the pods, and no pod is classified',
    workloadCases({ lag: false, revisionExists: false, disruptions: false, minCurrent: 1, currentStates: FATAL_STATES, noiseStates: FATAL_STATES }),
    (c) => {
      const { verdict, state, classify } = evaluateCase(c, true);
      expect(verdict).toMatchObject({ state: 'progressing', summary: 'waiting for the new revision' });
      expect(classify).not.toHaveBeenCalled();
      expect(state.firstSeen).toEqual({});
    },
  );

  forAll(
    'P-C01 converged only with every current pod Ready; a fatal signal on a current pod fails with its reason',
    workloadCases({ disruptions: false, minCurrent: 0, currentStates: ALL_STATES, noiseStates: ALL_STATES }),
    (c) => {
      const { verdict } = evaluateCase(c, true);
      if (c.observedGeneration < c.generation || !c.revisionExists) {
        expect(verdict.state).toBe('progressing');
        return;
      }
      const fatal = firstFatal(c);
      if (fatal === null) expect(verdict.state).not.toBe('failed');
      else expect(verdict).toMatchObject({ state: 'failed', failure: { service: c.service, reason: fatal.reason, instance: fatal.name } });

      const rolledOut = c.current.length === c.desired && c.current.every((p) => p.state === 'ready');
      if (verdict.state === 'converged') expect(rolledOut).toBe(true);
      if (rolledOut && c.old.length === 0) expect(verdict.state).toBe('converged');
    },
  );

  forAll(
    'pods of older revisions and of other workloads never change a verdict',
    workloadCases({ disruptions: true, minCurrent: 0, currentStates: ALL_STATES, noiseStates: FATAL_STATES }),
    (c) => {
      const noisy = evaluateCase(c, true);
      const quiet = evaluateCase(c, false);
      expect(noisy.verdict).toEqual(quiet.verdict);
      expect(noisy.state).toEqual(quiet.state);
      const current = new Set(noisy.current.map((p) => p.metadata.name));
      for (const call of noisy.classify.mock.calls) for (const pod of call[1]) expect(current.has(pod.metadata.name)).toBe(true);
      if (!c.paused && !c.deleting && !c.current.some((p) => isFatal(p.state))) expect(noisy.verdict.state).not.toBe('failed');
    },
  );

  interface GraceCase {
    state: GracedState;
    init: boolean;
    polls: { present: boolean; alt: boolean; dt: number }[];
  }

  forAll(
    'a graced signal fails once it has been seen without interruption for its grace, never earlier',
    (rng): GraceCase => ({
      state: pick(rng, GRACED_STATES),
      init: rng() < 0.3,
      polls: Array.from({ length: randomInt(rng, 1, 12) }, () => ({ present: rng() < 0.75, alt: rng() < 0.5, dt: randomInt(rng, 1, 25) })),
    }),
    (g) => {
      const reason = GRACED_REASON[g.state];
      const graceMs = K8S_FAILFAST_GRACE_S[reason] * 1000;
      let state = EMPTY;
      let nowMs = T0.getTime();
      let sinceMs: number | null = null;
      for (const poll of g.polls) {
        nowMs += poll.dt * 1000;
        const pod: PodCase = { state: poll.present ? g.state : 'creating', init: g.init, alt: poll.alt, suffix: 'x7k2p' };
        const c: WorkloadCase = {
          kind: 'Deployment',
          service: 'web',
          name: 'web',
          generation: 2,
          observedGeneration: 2,
          revisionExists: true,
          paused: false,
          deleting: false,
          desired: 1,
          current: [pod],
          old: [],
          unrelated: [],
          omitZeros: false,
        };
        const result = evaluateCase(c, false, state, new Date(nowMs));
        state = result.state;
        sinceMs = poll.present ? (sinceMs ?? nowMs) : null;
        if (sinceMs !== null && nowMs - sinceMs >= graceMs) {
          expect(result.verdict).toMatchObject({ state: 'failed', failure: { reason } });
          return;
        }
        expect(result.verdict.state).toBe('progressing');
      }
    },
  );
});

describe('-lb Service targets (design-07 8.3 P-C03, K19)', () => {
  interface LbCase {
    service: string;
    name: string;
    ports: LbPort[];
    bound: boolean;
    elapsedS: number;
  }

  forAll(
    'P-C03 a -lb Service without an ingress address fails with LoadBalancerPending once its grace has passed',
    (rng): LbCase => {
      const [service, name] = pick(rng, NAMES);
      return {
        service,
        name: `${name}-lb`,
        ports: Array.from({ length: randomInt(rng, 1, 3) }, () => ({ port: randomInt(rng, 1, 65535), protocol: pick(rng, ['TCP', 'UDP'] as const) })),
        bound: rng() < 0.3,
        elapsedS: randomInt(rng, 0, 180),
      };
    },
    (l) => {
      const target: LbWatchTarget = { service: l.service, name: l.name, ports: l.ports };
      const lb: Service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: l.name, namespace: NS, uid: `uid-svc-${l.name}` },
        spec: { type: 'LoadBalancer', ports: l.ports.map((p) => ({ port: p.port, protocol: p.protocol, targetPort: p.port })) },
        status: { loadBalancer: l.bound ? { ingress: [{ ip: '192.0.2.10' }] } : {} },
      };
      const snap = pollSnapshot([lb]);
      const now = new Date(T0.getTime() + l.elapsedS * 1000);
      const first = evaluateConvergence([], [target], snap, EMPTY, T0, CONTEXT);
      const later = evaluateConvergence([], [target], snap, first.state, now, CONTEXT);
      const verdict = later.verdicts[lbTargetKey(target)];
      const step = convergenceStep(later, [], [target], now, DEADLINE, CONTEXT);

      if (l.bound) {
        expect(verdict.state).toBe('converged');
        expect(step.status).toBe('converged');
        return;
      }
      if (l.elapsedS < K8S_LB_PENDING_GRACE_S) {
        expect(verdict.state).toBe('progressing');
        expect(step.status).toBe('pending');
        // the deadline turns a pending -lb Service into the same failure
        const [atDeadline] = timeoutVerdicts(later, [], [target], CONTEXT);
        expect(atDeadline.failure.reason).toBe('LoadBalancerPending');
        return;
      }
      expect(verdict).toMatchObject({
        state: 'failed',
        failure: { service: l.service, reason: 'LoadBalancerPending' },
        loadBalancer: { namespace: NS, name: l.name, ports: l.ports },
      });
      expect(step.status).toBe('failed');
    },
  );
});
