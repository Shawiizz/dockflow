// Pure convergence evaluator, fail-fast classifier and health stability step (design-03 9.3-9.5
// and 10; K16, K19, K73). The stack backend polls; everything here decides from one poll, the
// state carried over from the previous poll and the `now` it is given. No I/O, no clock.

import type { Redactor } from '../../../../utils/redact';
import type { Protocol, ServiceFailure, StackRole, WorkloadChange, WorkloadKind } from '../../interfaces';
import { K8S_EVENTS_PER_FAILURE, K8S_LB_PENDING_GRACE_S, KUBE_KEYS, LABELS } from '../constants';
import { serviceNameFor } from '../naming';
import type { ControllerRevision, DaemonSet, Deployment, ReplicaSet, StatefulSet } from '../resources/apps';
import type { Job } from '../resources/batch';
import type {
  Container,
  ContainerStateTerminated,
  ContainerStatus,
  Event,
  PersistentVolumeClaim,
  Pod,
  Service,
} from '../resources/core';
import type { Condition, ObjectMeta } from '../resources/meta';
import type { ManifestObject } from '../resources/registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Seconds a fail-fast signal must persist before it fails the wait (design-03 21.1). Reasons not
 * listed fail at first sight: nothing resolves them without a new deploy.
 */
export const K8S_FAILFAST_GRACE_S = {
  ImagePullBackOff: 20,
  CreateContainerConfigError: 15,
  CreateContainerError: 15,
  RunContainerError: 15,
  Unschedulable: 60,
  PvcPending: 60,
} as const;

/** length limit of each `<reason>: <message>` attached to a failure */
export const EVENT_TEXT_MAX = 300;

/** F10 detail until the claim's last Warning event is known */
export const NO_PROVISIONING_EVENT = 'no provisioning event';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One workload changed by the deploy and waited on (design-03 9.1). */
export interface WatchTarget {
  /** compose name */
  service: string;
  kind: WorkloadKind;
  name: string;
  /** P/service label value, used in the poll selector */
  serviceLabel: string;
  /** post-apply metadata.generation from the receipt */
  generation: number;
}

/** same shape as the receipt's `lbWatch` ports (apply/snapshot.ts), so they pass through unchanged */
export interface LbPort {
  port: number;
  protocol: Protocol;
}

/** A `-lb` Service the deploy created or changed; it must obtain an ingress address (K19). */
export interface LbWatchTarget {
  /** compose name */
  service: string;
  /** Service object name, always `<svc>-lb` */
  name: string;
  /** published (port, protocol) pairs the Service asks ServiceLB to bind */
  ports: LbPort[];
}

/** One convergence poll (K12, plus K09 when asked), split by kind. */
export interface PollSnapshot {
  deployments: Deployment[];
  statefulSets: StatefulSet[];
  daemonSets: DaemonSet[];
  replicaSets: ReplicaSet[];
  jobs: Job[];
  pods: Pod[];
  controllerRevisions: ControllerRevision[];
  /** Services of the watched `-lb` targets; empty when the poll did not read services */
  services: Service[];
  /** null when not fetched this poll */
  pvcs: PersistentVolumeClaim[] | null;
}

/** Objects one K12 poll returns. */
export type PollObject = Deployment | StatefulSet | DaemonSet | ReplicaSet | ControllerRevision | Job | Pod | Service;

export interface WatchState {
  /** `${podUid}/${container}/${reason}`, `${podUid}/${reason}` or `${objectUid}/${reason}` -> ISO time first seen */
  firstSeen: Record<string, string>;
}

export interface EvaluationContext {
  /** K8S_IMPORTED_IMAGE_REGISTRY + '/' */
  importedPrefix: string;
  /** Kubernetes node name -> servers.yml key */
  nodeNames: Record<string, string>;
  role: StackRole;
  env: string;
  /** stack namespace; the port-owner lookup of F14b excludes the failing Service by it */
  namespace: string;
  timeoutS: number;
}

export interface ClaimRef {
  name: string;
  uid: string;
}

/** The failing `-lb` Service, for the cluster-wide port-owner lookup (K13b). */
export interface LoadBalancerRef {
  namespace: string;
  name: string;
  ports: LbPort[];
}

export interface ConvergedVerdict {
  state: 'converged';
  summary: string;
}

export interface ProgressingVerdict {
  state: 'progressing';
  summary: string;
  /** a current pod is Pending with a claim: the next poll also reads PVCs (K09) */
  needsPvcs: boolean;
  /** current pods, whose events a timeout attaches */
  podUids: string[];
  /** the workload (and its new ReplicaSet), or the `-lb` Service */
  ownerUids: string[];
}

export interface FailedVerdict {
  state: 'failed';
  /** message not yet enriched with events nor redacted */
  failure: ServiceFailure;
  suggestion: string;
  podUids: string[];
  ownerUids: string[];
  /** PvcPending: the pending claims, whose last Warning event completes the message */
  claims: ClaimRef[];
  /** LoadBalancerPending: resolved with the K13b read instead of K13 */
  loadBalancer: LoadBalancerRef | null;
}

export type Verdict = ConvergedVerdict | ProgressingVerdict | FailedVerdict;

export interface ConvergenceEvaluation {
  /** keyed by targetKey / lbTargetKey */
  verdicts: Record<string, Verdict>;
  state: WatchState;
}

export interface PodClassification {
  /** the first signal whose grace has passed, in pod name then container order */
  failed: FailedVerdict | null;
  needsPvcs: boolean;
  /** every signal seen in this poll; a signal absent from a poll starts over (transient states reset) */
  firstSeen: Record<string, string>;
}

export type PodClassifier = typeof classifyPods;

type Workload = Deployment | StatefulSet | DaemonSet | Job;
type RolledWorkload = Deployment | StatefulSet | DaemonSet;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface Named {
  kind: string;
  metadata: ObjectMeta;
}

/** uid, or a stable stand-in for objects built without one */
function uidOf(o: Named): string {
  return o.metadata.uid ?? `${o.kind}/${o.metadata.name}`;
}

function ownedBy(o: Named, ownerUid: string | undefined): boolean {
  return ownerUid !== undefined && (o.metadata.ownerReferences ?? []).some((r) => r.uid === ownerUid);
}

function condition(conditions: readonly Condition[] | undefined, type: string): Condition | undefined {
  return conditions?.find((c) => c.type === type);
}

function byName(a: Named, b: Named): number {
  return a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0;
}

/** ServiceFailure.message is a single paragraph */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function composeFile(role: StackRole): string {
  return role === 'app' ? 'docker-compose.yml' : 'accessories.yml';
}

function logsSuggestion(service: string, context: EvaluationContext): string {
  const command = context.role === 'accessory' ? `dockflow accessories logs ${context.env} ${service}` : `dockflow logs ${context.env} ${service}`;
  return `Run \`${command}\`.`;
}

function diagnoseSuggestion(context: EvaluationContext): string {
  return `Run \`dockflow diagnose ${context.env}\`.`;
}

/** servers.yml key when mappable, else the Kubernetes node name */
function nodeOf(pod: Pod, context: EvaluationContext): string | undefined {
  const name = pod.spec.nodeName;
  if (name === undefined) return undefined;
  return Object.hasOwn(context.nodeNames, name) ? context.nodeNames[name] : name;
}

function graceOf(reason: string): number {
  return Object.hasOwn(K8S_FAILFAST_GRACE_S, reason) ? K8S_FAILFAST_GRACE_S[reason as keyof typeof K8S_FAILFAST_GRACE_S] : 0;
}

function podFailure(service: string, reason: string, message: string, pod: Pod, context: EvaluationContext): ServiceFailure {
  const node = nodeOf(pod, context);
  return node === undefined
    ? { service, reason, message, instance: pod.metadata.name }
    : { service, reason, message, instance: pod.metadata.name, node };
}

function failedVerdict(failure: ServiceFailure, suggestion: string, podUids: string[], ownerUids: string[]): FailedVerdict {
  return { state: 'failed', failure, suggestion, podUids, ownerUids, claims: [], loadBalancer: null };
}

function progressingVerdict(summary: string, needsPvcs: boolean, podUids: string[], ownerUids: string[]): ProgressingVerdict {
  return { state: 'progressing', summary, needsPvcs, podUids, ownerUids };
}

function exitText(terminated: ContainerStateTerminated | undefined): string {
  if (terminated === undefined) return 'unknown';
  return terminated.reason ? `${terminated.exitCode} (${terminated.reason})` : `${terminated.exitCode}`;
}

function statusesOf(pod: Pod): ContainerStatus[] {
  return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
}

function containerSpec(pod: Pod, name: string): Container | undefined {
  return [...(pod.spec.initContainers ?? []), ...(pod.spec.containers ?? [])].find((c) => c.name === name);
}

function isPodReady(pod: Pod): boolean {
  return pod.metadata.deletionTimestamp === undefined && condition(pod.status?.conditions, 'Ready')?.status === 'True';
}

function portsText(ports: readonly LbPort[]): string {
  return ports.map((p) => `${p.port}/${p.protocol}`).join(', ');
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** milliseconds; MicroTime fractions (six digits) are kept, missing or invalid times sort last */
function timeOf(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const match = RFC3339.exec(value);
  const base = Date.parse(match ? `${match[1]}${match[3]}` : value);
  if (Number.isNaN(base)) return Number.NEGATIVE_INFINITY;
  return match?.[2] ? base + Number(`0.${match[2]}`) * 1000 : base;
}

// ---------------------------------------------------------------------------
// Poll snapshot and targets
// ---------------------------------------------------------------------------

/** Splits the items of one multi-resource `get` by kind; other kinds are ignored. */
export function pollSnapshot(items: readonly PollObject[], pvcs: PersistentVolumeClaim[] | null = null): PollSnapshot {
  const snap: PollSnapshot = {
    deployments: [],
    statefulSets: [],
    daemonSets: [],
    replicaSets: [],
    jobs: [],
    pods: [],
    controllerRevisions: [],
    services: [],
    pvcs,
  };
  for (const item of items) {
    switch (item.kind) {
      case 'Deployment':
        snap.deployments.push(item);
        break;
      case 'StatefulSet':
        snap.statefulSets.push(item);
        break;
      case 'DaemonSet':
        snap.daemonSets.push(item);
        break;
      case 'ReplicaSet':
        snap.replicaSets.push(item);
        break;
      case 'ControllerRevision':
        snap.controllerRevisions.push(item);
        break;
      case 'Job':
        snap.jobs.push(item);
        break;
      case 'Pod':
        snap.pods.push(item);
        break;
      case 'Service':
        snap.services.push(item);
        break;
      default:
        break;
    }
  }
  return snap;
}

/** The watch target of a receipt change; the poll selector uses the applied object's P/service label. */
export function watchTarget(change: WorkloadChange, applied: readonly ManifestObject[]): WatchTarget {
  const object = applied.find((o) => o.kind === change.kind && o.metadata.name === change.name);
  return {
    service: change.service,
    kind: change.kind,
    name: change.name,
    serviceLabel: object?.metadata.labels?.[LABELS.service] ?? serviceNameFor(change.service).value,
    generation: change.generation,
  };
}

export function targetKey(target: Pick<WatchTarget, 'kind' | 'name'>): string {
  return `${target.kind}/${target.name}`;
}

export function lbTargetKey(target: Pick<LbWatchTarget, 'name'>): string {
  return `Service/${target.name}`;
}

function findWorkload(target: WatchTarget, snap: PollSnapshot): Workload | undefined {
  const named = <T extends Named>(list: readonly T[]): T | undefined => list.find((w) => w.metadata.name === target.name);
  switch (target.kind) {
    case 'Deployment':
      return named(snap.deployments);
    case 'StatefulSet':
      return named(snap.statefulSets);
    case 'DaemonSet':
      return named(snap.daemonSets);
    case 'Job':
      return named(snap.jobs);
  }
}

// ---------------------------------------------------------------------------
// Revisions (the two gates, K16)
// ---------------------------------------------------------------------------

/** Gate 1. Jobs have no `status.observedGeneration` and are never re-applied (K43), so it does not apply to them. */
function generationObserved(w: RolledWorkload): boolean {
  return (w.status?.observedGeneration ?? 0) >= (w.metadata.generation ?? 0);
}

/** The ReplicaSet of the Deployment's own revision annotation. */
function newReplicaSet(w: Deployment, snap: PollSnapshot): ReplicaSet | undefined {
  const revision = w.metadata.annotations?.[KUBE_KEYS.deploymentRevision];
  if (revision === undefined) return undefined;
  return snap.replicaSets.find(
    (rs) => ownedBy(rs, w.metadata.uid) && rs.metadata.annotations?.[KUBE_KEYS.deploymentRevision] === revision,
  );
}

function newestRevision(w: DaemonSet, snap: PollSnapshot): ControllerRevision | undefined {
  let newest: ControllerRevision | undefined;
  for (const revision of snap.controllerRevisions) {
    if (!ownedBy(revision, w.metadata.uid)) continue;
    if (newest === undefined || (revision.revision ?? 0) > (newest.revision ?? 0)) newest = revision;
  }
  return newest;
}

/** DaemonSet pods carry the hash only; the revision name is `<daemonset>-<hash>`. */
function revisionHash(revision: ControllerRevision, owner: string): string {
  const label = revision.metadata.labels?.[KUBE_KEYS.controllerRevisionHash];
  if (label !== undefined) return label;
  const prefix = `${owner}-`;
  return revision.metadata.name.startsWith(prefix) ? revision.metadata.name.slice(prefix.length) : revision.metadata.name;
}

/**
 * Pods a controller still counts: terminating pods and pods in a terminal phase are left out. A
 * Deployment, StatefulSet or DaemonSet replaces an evicted pod, which lingers as Failed until
 * garbage collection.
 */
function livePods(pods: readonly Pod[]): Pod[] {
  return pods.filter(
    (p) => p.metadata.deletionTimestamp === undefined && p.status?.phase !== 'Failed' && p.status?.phase !== 'Succeeded',
  );
}

/**
 * Pods of the revision being rolled out, never pods of older ReplicaSets or revisions. Returns null
 * when the controller has not produced that revision yet (gate 2, K16). Every pod of a Job counts:
 * a Job has no revisions.
 */
export function currentPods(w: Workload, snap: PollSnapshot): Pod[] | null {
  const uid = w.metadata.uid;
  switch (w.kind) {
    case 'Deployment': {
      const rs = newReplicaSet(w, snap);
      if (rs === undefined) return null;
      return livePods(snap.pods.filter((p) => ownedBy(p, rs.metadata.uid)));
    }
    case 'StatefulSet': {
      const hash = w.status?.updateRevision;
      if (!hash || !snap.controllerRevisions.some((r) => r.metadata.name === hash && ownedBy(r, uid))) return null;
      return livePods(snap.pods.filter((p) => ownedBy(p, uid) && p.metadata.labels?.[KUBE_KEYS.controllerRevisionHash] === hash));
    }
    case 'DaemonSet': {
      // Gate 1 already guarantees the newest revision describes the applied template: the controller
      // builds its history at the start of a sync and writes observedGeneration at the end. It is not
      // compared with the previous revision, since an updateStrategy-only change creates none.
      const newest = newestRevision(w, snap);
      if (newest === undefined) return null;
      const hash = revisionHash(newest, w.metadata.name);
      return livePods(snap.pods.filter((p) => ownedBy(p, uid) && p.metadata.labels?.[KUBE_KEYS.controllerRevisionHash] === hash));
    }
    case 'Job':
      return snap.pods.filter((p) => ownedBy(p, uid) && p.metadata.deletionTimestamp === undefined);
  }
}

// ---------------------------------------------------------------------------
// Fail-fast classifier (design-03 9.4, F1..F10)
// ---------------------------------------------------------------------------

interface Signal {
  key: string;
  reason: string;
  message: string;
  suggestion: string;
  claims: ClaimRef[];
}

/** Whether the kubelet starts this container again after the exit it reports. */
function restartsAfterExit(pod: Pod, status: ContainerStatus, exitCode: number): boolean {
  const init = pod.status?.initContainerStatuses?.includes(status) ?? false;
  // a native sidecar (an init container with restartPolicy Always) restarts like a regular container
  if (init && (containerSpec(pod, status.name) as { restartPolicy?: string } | undefined)?.restartPolicy === 'Always') return true;
  const policy = pod.spec.restartPolicy ?? 'Always';
  if (init) return exitCode !== 0 && policy !== 'Never';
  return policy === 'Always' || (policy === 'OnFailure' && exitCode !== 0);
}

function containerSignal(service: string, pod: Pod, status: ContainerStatus, context: EvaluationContext): Signal | null {
  const c = status.name;
  const spec = containerSpec(pod, c);
  const image = status.image || spec?.image || 'unknown';
  const node = nodeOf(pod, context) ?? 'unknown';
  const signal = (reason: string, message: string, suggestion: string): Signal => ({
    key: `${uidOf(pod)}/${c}/${reason}`,
    reason,
    message,
    suggestion,
    claims: [],
  });

  // before CrashLoopBackOff: an OOM-killed container crash-loops too, and the limit is the cause (F8)
  if (status.lastState?.terminated?.reason === 'OOMKilled' || status.state?.terminated?.reason === 'OOMKilled') {
    return signal(
      'OOMKilled',
      `Service ${service} was killed for exceeding its memory limit (container ${c}, limit ${spec?.resources?.limits?.memory ?? 'none'})`,
      `Raise deploy.resources.limits.memory of services.${service}.`,
    );
  }
  const waiting = status.state?.waiting;
  // some kubelets (k3s 1.36) keep a crashed container `terminated` through its back-off instead of
  // waiting with reason CrashLoopBackOff; one that will be started again is that same crash loop
  const exited = status.state?.terminated;
  const reason = exited !== undefined && restartsAfterExit(pod, status, exited.exitCode) ? 'CrashLoopBackOff' : waiting?.reason;
  const detail = oneLine(waiting?.message ?? reason ?? '');
  switch (reason) {
    case 'ErrImageNeverPull':
      return signal(
        'ErrImageNeverPull',
        `Service ${service} cannot start: image ${image} is not present on node ${node} and its pull policy is Never`,
        `Remove pull_policy: never from services.${service}, or make sure the image exists on every node.`,
      );
    case 'InvalidImageName':
      return signal(
        'InvalidImageName',
        `Service ${service} cannot start: image reference ${image} is invalid`,
        `Fix the image of services.${service} in ${composeFile(context.role)}.`,
      );
    case 'ErrImagePull':
    case 'ImagePullBackOff': {
      // kubelet alternates the two reasons between retries; one key per failure reason keeps the grace running
      const imported = context.importedPrefix !== '' && [status.image, spec?.image].some((i) => i?.startsWith(context.importedPrefix));
      if (imported) {
        return signal(
          'ErrImagePull',
          `Service ${service} cannot start: image ${image} was not imported on node ${node}`,
          'Deploy again without `--skip-build` and check the image distribution output.',
        );
      }
      return signal(
        'ImagePullBackOff',
        `Service ${service} cannot pull image ${image} on node ${node}: ${detail}`,
        'Check that the tag exists and that the registry credentials in config.yml are valid.',
      );
    }
    case 'CreateContainerConfigError':
      return signal('CreateContainerConfigError', `Service ${service} cannot create container ${c}: ${detail}`, diagnoseSuggestion(context));
    case 'CreateContainerError':
    case 'RunContainerError':
      return signal(
        reason,
        `Service ${service} cannot start container ${c}: ${detail}`,
        `Check command, entrypoint, user and volumes of services.${service}.`,
      );
    case 'CrashLoopBackOff':
      return signal(
        'CrashLoopBackOff',
        `Service ${service} keeps crashing: container ${c} restarted ${status.restartCount} time(s), last exit code ${exitText(exited ?? status.lastState?.terminated)}`,
        logsSuggestion(service, context),
      );
    default:
      return null;
  }
}

export function pvcPendingMessage(service: string, claim: string, detail: string): string {
  return `Service ${service} is waiting for volume ${claim}: ${detail}`;
}

function podSignals(service: string, pod: Pod, snap: PollSnapshot, context: EvaluationContext): { signals: Signal[]; needsPvcs: boolean } {
  const signals: Signal[] = [];
  for (const status of statusesOf(pod)) {
    const signal = containerSignal(service, pod, status, context);
    if (signal) signals.push(signal);
  }

  let needsPvcs = false;
  const claimNames = (pod.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : []));
  if (pod.status?.phase === 'Pending' && claimNames.length > 0) {
    needsPvcs = true;
    const pending: ClaimRef[] = [];
    for (const name of claimNames) {
      const pvc = snap.pvcs?.find((p) => p.metadata.name === name);
      if (pvc?.status?.phase === 'Pending') pending.push({ name, uid: uidOf(pvc) });
    }
    if (pending.length > 0) {
      signals.push({
        key: `${uidOf(pod)}/PvcPending`,
        reason: 'PvcPending',
        message: pvcPendingMessage(service, pending[0].name, NO_PROVISIONING_EVENT),
        suggestion: `Check the volume with \`dockflow volumes list ${context.env}\`.`,
        claims: pending,
      });
    }
  }

  const scheduled = condition(pod.status?.conditions, 'PodScheduled');
  if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') {
    signals.push({
      key: `${uidOf(pod)}/Unschedulable`,
      reason: 'Unschedulable',
      message: `Service ${service} cannot be scheduled: ${oneLine(scheduled.message ?? 'no scheduler message')}`,
      suggestion: `Check \`deploy.placement\`, \`x-dockflow.node_selector\` and node resources with \`dockflow diagnose ${context.env}\`.`,
      claims: [],
    });
  }
  return { signals, needsPvcs };
}

/**
 * F1..F10 over the given pods: init containers, then containers, then pod conditions. A signal with
 * grace `g` fails only once it has been seen for `g` seconds without interruption.
 */
export function classifyPods(
  service: string,
  pods: readonly Pod[],
  snap: PollSnapshot,
  state: WatchState,
  now: Date,
  context: EvaluationContext,
): PodClassification {
  const firstSeen: Record<string, string> = {};
  let failed: FailedVerdict | null = null;
  let needsPvcs = false;
  for (const pod of [...pods].sort(byName)) {
    const found = podSignals(service, pod, snap, context);
    needsPvcs ||= found.needsPvcs;
    for (const signal of found.signals) {
      const since = state.firstSeen[signal.key] ?? now.toISOString();
      firstSeen[signal.key] = since;
      if (failed === null && now.getTime() - Date.parse(since) >= graceOf(signal.reason) * 1000) {
        failed = {
          state: 'failed',
          failure: podFailure(service, signal.reason, signal.message, pod, context),
          suggestion: signal.suggestion,
          podUids: [uidOf(pod)],
          ownerUids: [],
          claims: signal.claims,
          loadBalancer: null,
        };
      }
    }
  }
  return { failed, needsPvcs, firstSeen };
}

// ---------------------------------------------------------------------------
// Evaluator (design-03 9.3)
// ---------------------------------------------------------------------------

/** Rollout progress from the status counters, each omitted counter read as 0 (Kubernetes omits zeros). */
function progressOf(w: RolledWorkload): { converged: boolean; summary: string } {
  switch (w.kind) {
    case 'Deployment': {
      const desired = w.spec.replicas ?? 1;
      const updated = w.status?.updatedReplicas ?? 0;
      const replicas = w.status?.replicas ?? 0;
      const available = w.status?.availableReplicas ?? 0;
      if (updated < desired) return { converged: false, summary: `${updated}/${desired} updated` };
      if (replicas > updated) return { converged: false, summary: `${replicas - updated} old pod(s) pending termination` };
      if (available < updated) return { converged: false, summary: `${available}/${desired} ready` };
      return { converged: true, summary: `${desired}/${desired} ready` };
    }
    case 'StatefulSet': {
      const desired = w.spec.replicas ?? 1;
      const ready = w.status?.readyReplicas ?? 0;
      const updated = w.status?.updatedReplicas ?? 0;
      const available = w.status?.availableReplicas ?? ready;
      if (ready < desired) return { converged: false, summary: `${ready}/${desired} ready` };
      if (updated < desired || w.status?.updateRevision !== w.status?.currentRevision) {
        return { converged: false, summary: `${updated}/${desired} updated` };
      }
      if (available < desired) return { converged: false, summary: `${available}/${desired} available` };
      return { converged: true, summary: `${desired}/${desired} ready` };
    }
    case 'DaemonSet': {
      const desired = w.status?.desiredNumberScheduled ?? 0;
      const updated = w.status?.updatedNumberScheduled ?? 0;
      const available = w.status?.numberAvailable ?? 0;
      if (updated < desired) return { converged: false, summary: `${updated}/${desired} nodes updated` };
      if (available < desired) return { converged: false, summary: `${available}/${desired} nodes ready` };
      return { converged: true, summary: `${desired}/${desired} nodes ready` };
    }
  }
}

function evaluateWorkload(
  target: WatchTarget,
  snap: PollSnapshot,
  state: WatchState,
  now: Date,
  context: EvaluationContext,
  classify: PodClassifier,
  seen: Record<string, string>,
): Verdict {
  const w = findWorkload(target, snap);
  if (w === undefined) return progressingVerdict(`waiting for ${target.kind} ${target.name}`, false, [], []);
  const service = target.service;
  const ownerUids = [uidOf(w)];

  // Gate 1 runs before anything else: until the controller has synced, its revision annotation and
  // its pods still describe the previous rollout, whose failures are not this deploy's.
  if (w.kind !== 'Job' && !generationObserved(w)) return progressingVerdict('waiting for the controller', false, [], ownerUids);
  if (w.metadata.deletionTimestamp !== undefined) {
    return failedVerdict(
      {
        service,
        reason: 'WorkloadDeleting',
        message: `Service ${service} (${w.kind.toLowerCase()}/${w.metadata.name}) is being deleted while this deploy waits for it`,
      },
      `Wait until it is gone, then run \`dockflow deploy ${context.env}\` again.`,
      [],
      ownerUids,
    );
  }
  if (w.kind === 'Deployment' && w.spec.paused === true) {
    const namespace = w.metadata.namespace ?? context.namespace;
    return failedVerdict(
      { service, reason: 'Paused', message: `Service ${service} has a paused rollout, so the new version cannot start` },
      `Resume it with \`kubectl -n ${namespace} rollout resume deployment/${w.metadata.name}\`, then deploy again.`,
      [],
      ownerUids,
    );
  }
  const pods = currentPods(w, snap);
  if (pods === null) return progressingVerdict('waiting for the new revision', false, [], ownerUids);
  if (w.kind === 'Deployment') {
    const rs = newReplicaSet(w, snap);
    if (rs !== undefined) ownerUids.push(uidOf(rs));
  }
  const podUids = pods.map(uidOf);

  if (w.kind === 'Deployment') {
    const progressing = condition(w.status?.conditions, 'Progressing');
    if (progressing?.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') {
      const desired = w.spec.replicas ?? 1;
      const ready = pods.filter(isPodReady).length;
      return failedVerdict(
        {
          service,
          reason: 'ProgressDeadlineExceeded',
          message: `Service ${service} made no progress for ${w.spec.progressDeadlineSeconds ?? 600}s: ${ready}/${desired} updated pod(s) ready`,
        },
        logsSuggestion(service, context),
        podUids,
        ownerUids,
      );
    }
    const replicaFailure = condition(w.status?.conditions, 'ReplicaFailure');
    if (replicaFailure?.status === 'True') {
      return failedVerdict(
        {
          service,
          reason: 'ReplicaFailure',
          message: `Service ${service} cannot create pods: ${oneLine(replicaFailure.message ?? replicaFailure.reason ?? 'no reason reported')}`,
        },
        diagnoseSuggestion(context),
        podUids,
        ownerUids,
      );
    }
  }

  if (w.kind === 'Job') {
    const conditions = w.status?.conditions;
    const isTrue = (type: string): Condition | undefined => {
      const c = condition(conditions, type);
      return c?.status === 'True' ? c : undefined;
    };
    if (isTrue('Complete') || isTrue('SuccessCriteriaMet')) return { state: 'converged', summary: 'completed' };
    const jobFailed = isTrue('Failed') ?? isTrue('FailureTarget');
    if (jobFailed !== undefined) {
      return failedVerdict(
        { service, reason: 'TaskFailed', message: `Job ${service} failed: ${oneLine(jobFailed.message ?? jobFailed.reason ?? 'no reason reported')}` },
        logsSuggestion(service, context),
        podUids,
        ownerUids,
      );
    }
  }

  const classified = classify(service, pods, snap, state, now, context);
  Object.assign(seen, classified.firstSeen);
  if (classified.failed !== null) return { ...classified.failed, ownerUids };

  if (w.kind === 'Job') {
    return progressingVerdict(`${w.status?.active ?? 0} running, ${w.status?.succeeded ?? 0} succeeded`, classified.needsPvcs, podUids, ownerUids);
  }
  const progress = progressOf(w);
  if (progress.converged) return { state: 'converged', summary: progress.summary };
  return progressingVerdict(progress.summary, classified.needsPvcs, podUids, ownerUids);
}

export function loadBalancerMessage(service: string, port: LbPort | undefined, owner: { name: string; namespace: string } | null): string {
  const subject = port === undefined ? `The published ports of service ${service}` : `Published port ${portsText([port])} of service ${service}`;
  if (owner !== null) return `${subject} cannot be bound: it is already used by service ${owner.name} in namespace ${owner.namespace}`;
  return `${subject} ${port === undefined ? 'were' : 'was'} not bound by the load balancer within ${K8S_LB_PENDING_GRACE_S}s`;
}

function loadBalancerVerdict(target: LbWatchTarget, uid: string | null, context: EvaluationContext): FailedVerdict {
  return {
    state: 'failed',
    failure: { service: target.service, reason: 'LoadBalancerPending', message: loadBalancerMessage(target.service, target.ports[0], null) },
    suggestion: `Change the published port of \`${target.service}\` in ${composeFile(context.role)}, or stop the stack that uses it.`,
    podUids: [],
    ownerUids: uid === null ? [] : [uid],
    claims: [],
    loadBalancer: { namespace: context.namespace, name: target.name, ports: [...target.ports] },
  };
}

function evaluateLoadBalancer(
  target: LbWatchTarget,
  snap: PollSnapshot,
  state: WatchState,
  now: Date,
  context: EvaluationContext,
  seen: Record<string, string>,
): Verdict {
  const service = snap.services.find((s) => s.metadata.name === target.name);
  if (service === undefined) return progressingVerdict('waiting for the Service', false, [], []);
  const ports = portsText(target.ports);
  if ((service.status?.loadBalancer?.ingress?.length ?? 0) > 0) return { state: 'converged', summary: `${ports} bound` };
  const uid = uidOf(service);
  const key = `${uid}/LoadBalancerPending`;
  const since = state.firstSeen[key] ?? now.toISOString();
  seen[key] = since;
  if (now.getTime() - Date.parse(since) >= K8S_LB_PENDING_GRACE_S * 1000) return loadBalancerVerdict(target, uid, context);
  return progressingVerdict(`waiting for ${ports} on every node`, false, [], [uid]);
}

/**
 * One poll against every target. Both gates run before any pod of a workload is classified; pods
 * of older revisions are never a failure signal (K16). `classify` is replaceable for tests only.
 */
export function evaluateConvergence(
  targets: readonly WatchTarget[],
  lb: readonly LbWatchTarget[],
  snap: PollSnapshot,
  state: WatchState,
  now: Date,
  context: EvaluationContext,
  classify: PodClassifier = classifyPods,
): ConvergenceEvaluation {
  const seen: Record<string, string> = {};
  const verdicts: Record<string, Verdict> = {};
  for (const target of targets) verdicts[targetKey(target)] = evaluateWorkload(target, snap, state, now, context, classify, seen);
  for (const target of lb) verdicts[lbTargetKey(target)] = evaluateLoadBalancer(target, snap, state, now, context, seen);
  return { verdicts, state: { firstSeen: seen } };
}

/** F14 per workload that did not converge, F14b per `-lb` Service still without an address. */
export function timeoutVerdicts(
  evaluation: ConvergenceEvaluation,
  targets: readonly WatchTarget[],
  lb: readonly LbWatchTarget[],
  context: EvaluationContext,
): FailedVerdict[] {
  const out: FailedVerdict[] = [];
  for (const target of targets) {
    const verdict = evaluation.verdicts[targetKey(target)];
    if (verdict?.state === 'converged') continue;
    if (verdict?.state === 'failed') {
      out.push(verdict);
      continue;
    }
    const summary = verdict?.summary ?? `waiting for ${target.kind} ${target.name}`;
    out.push(
      failedVerdict(
        {
          service: target.service,
          reason: 'Timeout',
          message: `Service ${target.service} did not become ready within ${context.timeoutS}s: ${summary}`,
        },
        diagnoseSuggestion(context),
        verdict?.podUids ?? [],
        verdict?.ownerUids ?? [],
      ),
    );
  }
  for (const target of lb) {
    const verdict = evaluation.verdicts[lbTargetKey(target)];
    if (verdict?.state === 'converged') continue;
    if (verdict?.state === 'failed') {
      out.push(verdict);
      continue;
    }
    out.push(loadBalancerVerdict(target, verdict?.ownerUids[0] ?? null, context));
  }
  return out;
}

export type ConvergenceStep =
  | { status: 'converged' }
  | { status: 'failed'; failed: FailedVerdict[] }
  | { status: 'timeout'; failed: FailedVerdict[] }
  | { status: 'pending'; wantPvcs: boolean };

/** Outcome of one poll of the wait loop (design-03 9.6): failure first, then convergence, then the deadline. */
export function convergenceStep(
  evaluation: ConvergenceEvaluation,
  targets: readonly WatchTarget[],
  lb: readonly LbWatchTarget[],
  now: Date,
  deadline: Date,
  context: EvaluationContext,
): ConvergenceStep {
  const verdicts = Object.values(evaluation.verdicts);
  const failed = verdicts.filter((v): v is FailedVerdict => v.state === 'failed');
  if (failed.length > 0) return { status: 'failed', failed };
  if (verdicts.every((v) => v.state === 'converged')) return { status: 'converged' };
  if (now.getTime() >= deadline.getTime()) return { status: 'timeout', failed: timeoutVerdicts(evaluation, targets, lb, context) };
  return { status: 'pending', wantPvcs: verdicts.some((v) => v.state === 'progressing' && v.needsPvcs) };
}

/** `web 1/2 updated · api 0/1 ready · web-lb pending · worker ready` */
export function progressLine(targets: readonly WatchTarget[], lb: readonly LbWatchTarget[], verdicts: Record<string, Verdict>): string {
  const parts: string[] = [];
  for (const target of targets) {
    const verdict = verdicts[targetKey(target)];
    const text = verdict === undefined ? 'pending' : verdict.state === 'converged' ? 'ready' : verdict.state === 'failed' ? 'failed' : verdict.summary;
    parts.push(`${target.service} ${text}`);
  }
  for (const target of lb) {
    const verdict = verdicts[lbTargetKey(target)];
    parts.push(`${target.name} ${verdict?.state === 'converged' ? 'bound' : verdict?.state === 'failed' ? 'failed' : 'pending'}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Enrichment (design-03 9.5)
// ---------------------------------------------------------------------------

function isWarning(event: Event): boolean {
  // K13 already reads Warning events only; the filter keeps these functions right for any list
  return event.type !== 'Normal';
}

function eventOrder(events: readonly Event[]): Event[] {
  return events
    .map((event, index) => ({ event, index, at: timeOf(event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : b.at > a.at ? 1 : -1))
    .map(({ event }) => event);
}

/**
 * Appends the latest Warning events of the given objects (failing pods, their ReplicaSet, the
 * workload): newest first, at most K8S_EVENTS_PER_FAILURE, each `<reason>: <message>` cut to
 * EVENT_TEXT_MAX characters.
 */
export function attachEvents(failure: ServiceFailure, events: readonly Event[], uids: readonly string[]): ServiceFailure {
  const wanted = new Set(uids);
  const texts = eventOrder(events.filter((e) => isWarning(e) && e.involvedObject?.uid !== undefined && wanted.has(e.involvedObject.uid)))
    .slice(0, K8S_EVENTS_PER_FAILURE)
    .map((e) => truncate(oneLine(`${e.reason ?? 'Event'}: ${e.message ?? ''}`), EVENT_TEXT_MAX));
  if (texts.length === 0) return failure;
  return { ...failure, message: `${failure.message} (events: ${texts.join(' | ')})` };
}

/** The last Warning event of the claims, as F10 reports it; null when there is none. */
export function claimEventText(events: readonly Event[], claims: readonly ClaimRef[]): string | null {
  const uids = new Set(claims.map((c) => c.uid));
  const names = new Set(claims.map((c) => c.name));
  const [latest] = eventOrder(
    events.filter((e) => {
      const target = e.involvedObject;
      if (!isWarning(e) || target === undefined) return false;
      if (target.uid !== undefined) return uids.has(target.uid);
      return target.kind === 'PersistentVolumeClaim' && target.name !== undefined && names.has(target.name);
    }),
  );
  if (latest === undefined) return null;
  return truncate(oneLine(latest.message ?? latest.reason ?? ''), EVENT_TEXT_MAX);
}

export function redactFailure(failure: ServiceFailure, redactor: Redactor): ServiceFailure {
  return { ...failure, message: redactor.redact(failure.message) };
}

/** The K13 enrichment of a failed verdict: claim event (F10), attached events, then redaction. */
export function enrichFailure(verdict: FailedVerdict, events: readonly Event[], redactor: Redactor): ServiceFailure {
  let failure = verdict.failure;
  const claim = verdict.claims[0];
  if (failure.reason === 'PvcPending' && claim !== undefined) {
    const detail = claimEventText(events, verdict.claims);
    if (detail !== null) failure = { ...failure, message: pvcPendingMessage(failure.service, claim.name, detail) };
  }
  return redactFailure(attachEvents(failure, events, [...verdict.podUids, ...verdict.ownerUids]), redactor);
}

export interface PortOwner {
  port: LbPort;
  name: string;
  namespace: string;
}

/**
 * The K13b reduction: the first other LoadBalancer Service asking for one of the failing Service's
 * (port, protocol) pairs. Only names and ports are read from other namespaces.
 */
export function findPortOwner(services: readonly Service[], self: Omit<LoadBalancerRef, 'ports'>, ports: readonly LbPort[]): PortOwner | null {
  for (const port of ports) {
    const candidates = services.filter(
      (s) =>
        s.spec.type === 'LoadBalancer' &&
        !(s.metadata.name === self.name && (s.metadata.namespace ?? '') === self.namespace) &&
        (s.spec.ports ?? []).some((p) => p.port === port.port && (p.protocol ?? 'TCP') === port.protocol),
    );
    // ServiceLB gives a host port to one Service only: the one with an address is the holder
    const holder = candidates.find((s) => (s.status?.loadBalancer?.ingress?.length ?? 0) > 0) ?? candidates[0];
    if (holder !== undefined) return { port, name: holder.metadata.name, namespace: holder.metadata.namespace ?? '' };
  }
  return null;
}

/** The K13b enrichment of a LoadBalancerPending verdict: names the Service holding the port, then redacts. */
export function enrichLoadBalancerFailure(verdict: FailedVerdict, services: readonly Service[], redactor: Redactor): ServiceFailure {
  const lb = verdict.loadBalancer;
  if (lb === null) return redactFailure(verdict.failure, redactor);
  const owner = findPortOwner(services, lb, lb.ports);
  const message = owner === null ? loadBalancerMessage(verdict.failure.service, lb.ports[0], null) : loadBalancerMessage(verdict.failure.service, owner.port, owner);
  return redactFailure({ ...verdict.failure, message }, redactor);
}

// ---------------------------------------------------------------------------
// Health stability (design-03 10)
// ---------------------------------------------------------------------------

export type NotReady =
  | { kind: 'pod'; service: string; pod: Pod; ownerUids: string[] }
  | { kind: 'count'; service: string; ready: number; desired: number; podUids: string[]; ownerUids: string[] };

export interface HealthEvaluation {
  /** F1..F10 signals past their grace and restarts beyond the baseline, at most one per target */
  failures: FailedVerdict[];
  /** every target has its desired number of current pods, all Ready and not terminating */
  allReady: boolean;
  /** `${podUid}/${container}` -> restartCount of every current pod */
  restartCounts: Record<string, number>;
  notReady: NotReady[];
  state: WatchState;
}

function desiredPods(w: RolledWorkload): number {
  return w.kind === 'DaemonSet' ? (w.status?.desiredNumberScheduled ?? 0) : (w.spec.replicas ?? 1);
}

/** kubectl-style state of a pod that is not Ready, for the health timeout message */
export function podStateText(pod: Pod): string {
  if (pod.metadata.deletionTimestamp !== undefined) return 'Terminating';
  if (pod.status?.reason) return pod.status.reason;
  for (const status of pod.status?.initContainerStatuses ?? []) {
    const terminated = status.state?.terminated;
    if (terminated !== undefined && terminated.exitCode !== 0) return `Init:${terminated.reason ?? `ExitCode:${terminated.exitCode}`}`;
    const waiting = status.state?.waiting?.reason;
    if (waiting !== undefined && waiting !== 'PodInitializing') return `Init:${waiting}`;
  }
  for (const status of pod.status?.containerStatuses ?? []) {
    const waiting = status.state?.waiting?.reason;
    if (waiting !== undefined) return waiting;
  }
  const phase = pod.status?.phase ?? 'Unknown';
  if (phase === 'Pending' && condition(pod.status?.conditions, 'PodScheduled')?.status === 'False') return 'Pending (Unschedulable)';
  if (phase === 'Running') return isPodReady(pod) ? 'Running' : 'Running (not ready)';
  return phase;
}

function restartedVerdict(service: string, pod: Pod, status: ContainerStatus, ownerUids: string[], context: EvaluationContext): FailedVerdict {
  const terminated = status.lastState?.terminated;
  const last = terminated === undefined ? 'last exit code unknown' : `last exit code ${terminated.exitCode}${terminated.reason ? `, ${terminated.reason}` : ''}`;
  return failedVerdict(
    podFailure(
      service,
      'ContainerRestarted',
      `Service ${service} restarted during the health window: container ${status.name} in pod ${pod.metadata.name} (${last})`,
      pod,
      context,
    ),
    logsSuggestion(service, context),
    [uidOf(pod)],
    ownerUids,
  );
}

/**
 * One health poll over the current pods of each non-Job target. `baseline` holds the restart counts
 * recorded when every pod was first Ready; null before that, when no restart is judged yet.
 */
export function evaluateHealth(
  targets: readonly WatchTarget[],
  snap: PollSnapshot,
  baseline: Record<string, number> | null,
  state: WatchState,
  now: Date,
  context: EvaluationContext,
  classify: PodClassifier = classifyPods,
): HealthEvaluation {
  const seen: Record<string, string> = {};
  const failures: FailedVerdict[] = [];
  const restartCounts: Record<string, number> = {};
  const notReady: NotReady[] = [];
  let allReady = true;

  for (const target of targets) {
    if (target.kind === 'Job') continue;
    const w = findWorkload(target, snap);
    const rolled = w !== undefined && w.kind !== 'Job' ? w : undefined;
    const pods = rolled !== undefined && generationObserved(rolled) && rolled.metadata.deletionTimestamp === undefined ? currentPods(rolled, snap) : null;
    const ownerUids = w === undefined ? [] : [uidOf(w)];
    const desired = rolled === undefined ? 1 : desiredPods(rolled);
    if (rolled === undefined || pods === null) {
      allReady = false;
      notReady.push({ kind: 'count', service: target.service, ready: 0, desired, podUids: [], ownerUids });
      continue;
    }
    if (rolled.kind === 'Deployment') {
      const rs = newReplicaSet(rolled, snap);
      if (rs !== undefined) ownerUids.push(uidOf(rs));
    }

    const classified = classify(target.service, pods, snap, state, now, context);
    Object.assign(seen, classified.firstSeen);
    let failure: FailedVerdict | null = classified.failed === null ? null : { ...classified.failed, ownerUids };
    const sorted = [...pods].sort(byName);
    for (const pod of sorted) {
      for (const status of statusesOf(pod)) {
        const key = `${uidOf(pod)}/${status.name}`;
        restartCounts[key] = status.restartCount;
        if (failure === null && baseline !== null && Object.hasOwn(baseline, key) && status.restartCount > baseline[key]) {
          failure = restartedVerdict(target.service, pod, status, ownerUids, context);
        }
      }
    }
    if (failure !== null) failures.push(failure);

    const unready = sorted.filter((p) => !isPodReady(p));
    if (unready.length > 0 || pods.length < desired) allReady = false;
    if (unready.length > 0) {
      for (const pod of unready) notReady.push({ kind: 'pod', service: target.service, pod, ownerUids });
    } else if (pods.length < desired) {
      notReady.push({ kind: 'count', service: target.service, ready: pods.length, desired, podUids: pods.map(uidOf), ownerUids });
    }
  }
  return { failures, allReady, restartCounts, notReady, state: { firstSeen: seen } };
}

/** Timeout failure of a target that was not healthy at the deadline. */
export function notReadyFailure(entry: NotReady, context: EvaluationContext): FailedVerdict {
  const prefix = `Service ${entry.service} is not healthy after ${context.timeoutS}s`;
  if (entry.kind === 'pod') {
    return failedVerdict(
      podFailure(entry.service, 'Timeout', `${prefix}: pod ${entry.pod.metadata.name} is ${podStateText(entry.pod)}`, entry.pod, context),
      diagnoseSuggestion(context),
      [uidOf(entry.pod)],
      entry.ownerUids,
    );
  }
  return failedVerdict(
    { service: entry.service, reason: 'Timeout', message: `${prefix}: ${entry.ready}/${entry.desired} pod(s) ready` },
    diagnoseSuggestion(context),
    entry.podUids,
    entry.ownerUids,
  );
}

export interface HealthProgress {
  /** restart counts when every pod was first Ready */
  baseline: Record<string, number> | null;
  /** start of the current uninterrupted all-Ready stretch */
  stableSince: Date | null;
  state: WatchState;
}

export function initialHealthProgress(): HealthProgress {
  return { baseline: null, stableSince: null, state: { firstSeen: {} } };
}

export type HealthStep =
  | { status: 'healthy'; progress: HealthProgress }
  | { status: 'unhealthy'; failed: FailedVerdict[]; progress: HealthProgress }
  | { status: 'timeout'; failed: FailedVerdict[]; progress: HealthProgress }
  | { status: 'pending'; progress: HealthProgress };

/**
 * One poll of the health window (design-03 10): healthy once every pod stayed Ready with unchanged
 * restart counts for `stabilityS`. Not being Ready restarts the window; the deadline fails the
 * check only while a pod is not Ready (a window already running completes).
 */
export function healthStep(
  targets: readonly WatchTarget[],
  snap: PollSnapshot,
  progress: HealthProgress,
  now: Date,
  deadline: Date,
  stabilityS: number,
  context: EvaluationContext,
): HealthStep {
  const evaluation = evaluateHealth(targets, snap, progress.baseline, progress.state, now, context);
  if (evaluation.failures.length > 0) {
    return { status: 'unhealthy', failed: evaluation.failures, progress: { ...progress, state: evaluation.state } };
  }
  if (evaluation.allReady) {
    const next: HealthProgress = {
      baseline: progress.baseline ?? evaluation.restartCounts,
      stableSince: progress.stableSince ?? now,
      state: evaluation.state,
    };
    const stableFor = now.getTime() - (next.stableSince ?? now).getTime();
    return { status: stableFor >= stabilityS * 1000 ? 'healthy' : 'pending', progress: next };
  }
  const next: HealthProgress = { baseline: progress.baseline, stableSince: null, state: evaluation.state };
  if (now.getTime() >= deadline.getTime()) {
    return { status: 'timeout', failed: evaluation.notReady.map((entry) => notReadyFailure(entry, context)), progress: next };
  }
  return { status: 'pending', progress: next };
}
