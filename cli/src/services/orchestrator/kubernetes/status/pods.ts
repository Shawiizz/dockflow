// Pure day-2 view of pods (design-06 2.2 indexing rules, 2.3): display status, owning workload,
// current revision, InstanceInfo mapping, the one instance order and the selection of one instance
// or container. No I/O and no clock: `now` is always a parameter.

import { CLIError, ErrorCode, ValidationError } from '../../../../utils/errors';
import type { Redactor } from '../../../../utils/redact';
import type { InstanceInfo, StackRole, WorkloadKind } from '../../interfaces';
import { ANNOTATIONS, K8S_MANAGED_BY, KUBE_KEYS, LABELS, PARTS } from '../constants';
import { nodeNameFor } from '../naming';
import type { ControllerRevision, DaemonSet, Deployment, ReplicaSet, StatefulSet } from '../resources/apps';
import type { Job } from '../resources/batch';
import type { Container, ContainerStatus, PersistentVolumeClaim, Pod, Service } from '../resources/core';
import type { Condition, ObjectMeta } from '../resources/meta';

// ---------------------------------------------------------------------------
// Inventory shape consumed by the pure status modules
// ---------------------------------------------------------------------------

export type WorkloadObject = Deployment | StatefulSet | DaemonSet | Job;

/** Objects of the namespace read the status modules index (design-06 2.2). */
export type InventoryObject = WorkloadObject | Pod | Service | PersistentVolumeClaim;

export interface WorkloadRecord {
  /** compose service name (annotation P/compose-service) */
  service: string;
  /** Kubernetes service name (label P/service): selector value and container name */
  serviceName: string;
  role: StackRole;
  kind: WorkloadKind;
  object: WorkloadObject;
}

export interface HelmReleaseWorkloads {
  release: string;
  /** release label P/role; null when the release carries none */
  role: StackRole | null;
  namespace: string;
  workloads: { kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'; name: string }[];
}

export interface RevisionIndex {
  replicaSets: ReplicaSet[];
  controllerRevisions: ControllerRevision[];
}

/**
 * The synchronous part of one namespace read (design-06 2.2 `NamespaceInventory`). The backend's
 * inventory adds the lazy `revisions()` read on top of it.
 */
export interface InventoryView {
  namespace: string;
  /** compose workloads of both roles, keyed by compose service name */
  composeWorkloads: ReadonlyMap<string, WorkloadRecord>;
  /** every Deployment, StatefulSet, DaemonSet and Job of the namespace, chart-owned ones included */
  workloads: readonly WorkloadObject[];
  /** Helm releases of both roles present in this namespace */
  helm: readonly HelmReleaseWorkloads[];
  pods: readonly Pod[];
  services: readonly Service[];
  claims: readonly PersistentVolumeClaim[];
}

function isRole(value: string | undefined): value is StackRole {
  return value === 'app' || value === 'accessory';
}

function isNewer(a: WorkloadObject, b: WorkloadObject): boolean {
  const at = a.metadata.creationTimestamp ?? '';
  const bt = b.metadata.creationTimestamp ?? '';
  if (at !== bt) return at > bt;
  return a.metadata.name > b.metadata.name;
}

/**
 * Compose workloads: managed by Dockflow, `P/part=stack`, a compose name in `P/compose-service`.
 * Several Jobs of one service (an old one not pruned yet) keep the newest.
 */
export function indexComposeWorkloads(objects: readonly WorkloadObject[]): Map<string, WorkloadRecord> {
  const index = new Map<string, WorkloadRecord>();
  for (const object of objects) {
    const labels = object.metadata.labels ?? {};
    const service = object.metadata.annotations?.[ANNOTATIONS.composeService];
    const role = labels[LABELS.role];
    const serviceName = labels[LABELS.service];
    if (labels[LABELS.managedBy] !== K8S_MANAGED_BY || labels[LABELS.part] !== PARTS.stack) continue;
    if (!service || !serviceName || !isRole(role)) continue;
    const existing = index.get(service);
    if (existing && !isNewer(object, existing.object)) continue;
    index.set(service, { service, serviceName, role, kind: object.kind, object });
  }
  return index;
}

/** Indexes the items of one namespace read; `helm` comes from the release manifests. */
export function buildInventoryView(
  namespace: string,
  items: readonly InventoryObject[],
  helm: readonly HelmReleaseWorkloads[],
): InventoryView {
  const workloads: WorkloadObject[] = [];
  const pods: Pod[] = [];
  const services: Service[] = [];
  const claims: PersistentVolumeClaim[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'Deployment':
      case 'StatefulSet':
      case 'DaemonSet':
      case 'Job':
        workloads.push(item);
        break;
      case 'Pod':
        pods.push(item);
        break;
      case 'Service':
        services.push(item);
        break;
      case 'PersistentVolumeClaim':
        claims.push(item);
        break;
    }
  }
  return {
    namespace,
    composeWorkloads: indexComposeWorkloads(workloads),
    workloads,
    helm: helm.filter((release) => release.namespace === namespace),
    pods,
    services,
    claims,
  };
}

// ---------------------------------------------------------------------------
// Owning workload
// ---------------------------------------------------------------------------

export interface WorkloadRef {
  kind: WorkloadKind;
  name: string;
}

export function isHelperPod(pod: Pod): boolean {
  return pod.metadata.labels?.[LABELS.part] === PARTS.helper;
}

/**
 * The workload that controls a pod, read from its controller ownerReference. A Deployment pod is
 * owned by a ReplicaSet named `<deployment>-<pod-template-hash>`, so the Deployment is found
 * without reading ReplicaSets (they are not part of the main inventory read).
 */
export function podController(pod: Pod): WorkloadRef | null {
  const ref = pod.metadata.ownerReferences?.find((r) => r.controller === true);
  if (!ref) return null;
  switch (ref.kind) {
    case 'ReplicaSet': {
      const hash = pod.metadata.labels?.[KUBE_KEYS.podTemplateHash];
      if (!hash || !ref.name.endsWith(`-${hash}`)) return null;
      return { kind: 'Deployment', name: ref.name.slice(0, -(hash.length + 1)) };
    }
    case 'StatefulSet':
      return { kind: 'StatefulSet', name: ref.name };
    case 'DaemonSet':
      return { kind: 'DaemonSet', name: ref.name };
    case 'Job':
      return { kind: 'Job', name: ref.name };
    default:
      return null;
  }
}

export interface PodOwner {
  source: 'compose' | 'helm';
  /** compose service name, or Helm release name */
  service: string;
  role: StackRole | null;
  kind: WorkloadKind;
  /** workload metadata.name */
  name: string;
  /** the name a container of the workload is expected to carry: P/service, or the workload name for charts */
  serviceName: string;
  /** null when a release manifest names a workload the namespace read did not return */
  object: WorkloadObject | null;
}

function sameRef(object: WorkloadObject, ref: WorkloadRef): boolean {
  return object.kind === ref.kind && object.metadata.name === ref.name;
}

/** Compose workload or Helm release owning the pod; null for helper pods and uncontrolled pods. */
export function podOwner(pod: Pod, inventory: InventoryView): PodOwner | null {
  if (isHelperPod(pod)) return null;
  const ref = podController(pod);
  if (!ref) return null;
  for (const record of inventory.composeWorkloads.values()) {
    if (sameRef(record.object, ref)) {
      return {
        source: 'compose',
        service: record.service,
        role: record.role,
        kind: record.kind,
        name: ref.name,
        serviceName: record.serviceName,
        object: record.object,
      };
    }
  }
  for (const release of inventory.helm) {
    if (!release.workloads.some((w) => w.kind === ref.kind && w.name === ref.name)) continue;
    return {
      source: 'helm',
      service: release.release,
      role: release.role,
      kind: ref.kind,
      name: ref.name,
      serviceName: ref.name,
      object: inventory.workloads.find((w) => sameRef(w, ref)) ?? null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display status (kubectl printer parity)
// ---------------------------------------------------------------------------

export type InstanceSeverity = InstanceInfo['severity'];

export interface PodStatusView {
  status: string;
  severity: InstanceSeverity;
}

/** Waiting reasons that never resolve on their own. */
export const FATAL_WAITING_REASONS: ReadonlySet<string> = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'ErrImageNeverPull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

export const STATUS_RUNNING = 'Running';
export const STATUS_RUNNING_NOT_READY = 'Running (not ready)';
export const STATUS_TERMINATING = 'Terminating';
export const STATUS_UNSCHEDULABLE = 'Pending (Unschedulable)';

export function podCondition(pod: Pod, type: string): Condition | undefined {
  return pod.status?.conditions?.find((c) => c.type === type);
}

/** `PodScheduled=False`: the scheduler found no node */
export function isUnscheduled(pod: Pod): boolean {
  return pod.status?.phase === 'Pending' && podCondition(pod, 'PodScheduled')?.status === 'False';
}

/** Native sidecars (init containers with `restartPolicy: Always`) count as done once started. */
type InitContainerSpec = Container & { restartPolicy?: string };

function initStatus(pod: Pod): PodStatusView | null {
  const statuses = pod.status?.initContainerStatuses ?? [];
  if (statuses.length === 0) return null;
  const specs: readonly InitContainerSpec[] = pod.spec.initContainers ?? [];
  const total = Math.max(specs.length, statuses.length);
  let done = 0;
  for (const s of statuses) {
    const terminated = s.state?.terminated;
    if (terminated && terminated.exitCode === 0) {
      done++;
      continue;
    }
    const sidecar = specs.find((c) => c.name === s.name)?.restartPolicy === 'Always';
    if (sidecar && s.started === true) {
      done++;
      continue;
    }
    if (terminated) {
      return {
        status: terminated.reason ? `Init:${terminated.reason}` : `Init:ExitCode:${terminated.exitCode}`,
        severity: 'error',
      };
    }
    const reason = s.state?.waiting?.reason;
    if (reason && reason !== 'PodInitializing') {
      return { status: `Init:${reason}`, severity: FATAL_WAITING_REASONS.has(reason) ? 'error' : 'warning' };
    }
    return { status: `Init:${done}/${total}`, severity: 'warning' };
  }
  return done < total ? { status: `Init:${done}/${total}`, severity: 'warning' } : null;
}

function waitingStatus(containers: readonly ContainerStatus[]): PodStatusView | null {
  let first: PodStatusView | null = null;
  for (const c of containers) {
    const reason = c.state?.waiting?.reason;
    if (!reason) continue;
    if (FATAL_WAITING_REASONS.has(reason)) return { status: reason, severity: 'error' };
    first ??= { status: reason, severity: 'warning' };
  }
  return first;
}

function failedReason(containers: readonly ContainerStatus[]): string | null {
  for (const c of containers) {
    const terminated = c.state?.terminated ?? c.lastState?.terminated;
    if (terminated && terminated.exitCode !== 0 && terminated.reason) return terminated.reason;
  }
  return null;
}

export function allContainersReady(pod: Pod): boolean {
  const containers = pod.status?.containerStatuses ?? [];
  return containers.length > 0 && containers.every((c) => c.ready);
}

/** design-06 2.3: the first rule that applies wins. */
export function podDisplayStatus(pod: Pod): PodStatusView {
  const status = pod.status ?? {};
  if (pod.metadata.deletionTimestamp) return { status: STATUS_TERMINATING, severity: 'warning' };
  if (status.reason) return { status: status.reason, severity: 'error' };
  const init = initStatus(pod);
  if (init) return init;
  const containers = status.containerStatuses ?? [];
  const waiting = waitingStatus(containers);
  if (waiting) return waiting;
  switch (status.phase) {
    case 'Succeeded':
      return { status: 'Completed', severity: 'ok' };
    case 'Failed':
      return { status: failedReason(containers) ?? 'Failed', severity: 'error' };
    case 'Pending': {
      const scheduled = podCondition(pod, 'PodScheduled');
      if (scheduled?.status === 'False') {
        return { status: STATUS_UNSCHEDULABLE, severity: scheduled.reason === 'Unschedulable' ? 'error' : 'warning' };
      }
      return { status: 'Pending', severity: 'warning' };
    }
    case 'Running': {
      if (allContainersReady(pod)) return { status: STATUS_RUNNING, severity: 'ok' };
      const oomKilled = containers.some((c) => c.restartCount > 0 && c.lastState?.terminated?.reason === 'OOMKilled');
      return { status: STATUS_RUNNING_NOT_READY, severity: oomKilled ? 'error' : 'warning' };
    }
    default:
      return { status: status.phase ?? 'Unknown', severity: 'warning' };
  }
}

// ---------------------------------------------------------------------------
// Current revision
// ---------------------------------------------------------------------------

function ownedBy(meta: ObjectMeta, object: WorkloadObject): boolean {
  const uid = object.metadata.uid;
  return (meta.ownerReferences ?? []).some(
    (r) => r.controller === true && r.kind === object.kind && r.name === object.metadata.name && (!uid || !r.uid || r.uid === uid),
  );
}

function revisionNumber(value: string | number | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Whether a pod runs the workload's newest template. Deployment: the owned ReplicaSet with the
 * highest revision annotation (not the newest one) defines the pod-template-hash; StatefulSet:
 * `updateRevision`, else `currentRevision`; DaemonSet: the owned ControllerRevision with the highest
 * `.revision`; Job: always. Nothing to compare with counts as current.
 */
export function isCurrentRevision(pod: Pod, workload: { kind: WorkloadKind; object: WorkloadObject }, revisions: RevisionIndex): boolean {
  const labels = pod.metadata.labels ?? {};
  const object = workload.object;
  switch (object.kind) {
    case 'Deployment': {
      let newest: ReplicaSet | null = null;
      for (const rs of revisions.replicaSets) {
        if (!ownedBy(rs.metadata, object)) continue;
        const rev = revisionNumber(rs.metadata.annotations?.[KUBE_KEYS.deploymentRevision]);
        if (!newest || rev > revisionNumber(newest.metadata.annotations?.[KUBE_KEYS.deploymentRevision])) newest = rs;
      }
      const hash = newest?.metadata.labels?.[KUBE_KEYS.podTemplateHash];
      return !hash || labels[KUBE_KEYS.podTemplateHash] === hash;
    }
    case 'StatefulSet': {
      const revision = object.status?.updateRevision || object.status?.currentRevision;
      return !revision || labels[KUBE_KEYS.controllerRevisionHash] === revision;
    }
    case 'DaemonSet': {
      let newest: ControllerRevision | null = null;
      for (const cr of revisions.controllerRevisions) {
        if (!ownedBy(cr.metadata, object)) continue;
        if (!newest || revisionNumber(cr.revision) > revisionNumber(newest.revision)) newest = cr;
      }
      if (!newest) return true;
      const prefix = `${object.metadata.name}-`;
      const hash =
        newest.metadata.labels?.[KUBE_KEYS.controllerRevisionHash] ??
        (newest.metadata.name.startsWith(prefix) ? newest.metadata.name.slice(prefix.length) : newest.metadata.name);
      return labels[KUBE_KEYS.controllerRevisionHash] === hash;
    }
    case 'Job':
      return true;
  }
}

// ---------------------------------------------------------------------------
// InstanceInfo
// ---------------------------------------------------------------------------

/** `nodeNameFor(key)` -> servers.yml key, for every server of the environment. */
export function nodeToServerMap(serverKeys: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of serverKeys) map.set(nodeNameFor(key), key);
  return map;
}

function allContainerStatuses(pod: Pod): ContainerStatus[] {
  return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
}

function terminationText(t: { reason?: string; exitCode: number; finishedAt?: string }): string {
  const at = t.finishedAt ? ` at ${t.finishedAt}` : '';
  return `${t.reason ?? 'Terminated'} (exit ${t.exitCode})${at}`;
}

/**
 * First of: a waiting message; the pod's own message when the kubelet set a reason (eviction);
 * the last termination of a container; the scheduler's message. Redacted.
 */
export function podErrorText(pod: Pod): string | null {
  const statuses = allContainerStatuses(pod);
  const waiting = statuses.find((c) => c.state?.waiting?.message)?.state?.waiting?.message;
  if (waiting) return waiting;
  if (pod.status?.reason && pod.status.message) return pod.status.message;
  for (const c of statuses) {
    const last = c.lastState?.terminated;
    if (last && (last.exitCode !== 0 || last.reason === 'OOMKilled')) return terminationText(last);
  }
  for (const c of statuses) {
    const current = c.state?.terminated;
    if (current && current.exitCode !== 0) return terminationText(current);
  }
  const scheduled = podCondition(pod, 'PodScheduled');
  if (scheduled?.status === 'False' && scheduled.message) return scheduled.message;
  return null;
}

/**
 * Maps one pod to the core InstanceInfo; null for helper pods and pods no compose workload or Helm
 * release owns. `revisions` null: the caller does not display `current`, every instance is current.
 */
export function toInstanceInfo(
  pod: Pod,
  inventory: InventoryView,
  revisions: RevisionIndex | null,
  nodeToServer: ReadonlyMap<string, string>,
  redactor: Redactor,
): InstanceInfo | null {
  const owner = podOwner(pod, inventory);
  if (!owner) return null;
  const view = podDisplayStatus(pod);
  const nodeName = pod.spec.nodeName;
  const error = podErrorText(pod);
  const info: InstanceInfo = {
    id: pod.metadata.name,
    label: '',
    service: owner.service,
    node: nodeName ? (nodeToServer.get(nodeName) ?? nodeName) : null,
    status: view.status,
    severity: view.severity,
    ready: allContainersReady(pod),
    restarts: allContainerStatuses(pod).reduce((sum, c) => sum + c.restartCount, 0),
    current: revisions === null || owner.object === null ? true : isCurrentRevision(pod, { kind: owner.kind, object: owner.object }, revisions),
    startedAt: pod.status?.startTime ?? null,
    error: error === null ? null : redactor.redact(error),
    containers: pod.spec.containers.map((c) => c.name),
  };
  info.label = instanceLabel(info, owner.name);
  return info;
}

export interface InstanceQuery {
  role: StackRole;
  /** compose service name or Helm release name */
  service?: string;
  /** keep pods in phase Succeeded / Failed */
  includeTerminated?: boolean;
}

/** `StackBackend.listInstances` over one inventory, in the table order. */
export function instancesFor(
  inventory: InventoryView,
  query: InstanceQuery,
  revisions: RevisionIndex | null,
  nodeToServer: ReadonlyMap<string, string>,
  redactor: Redactor,
): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  for (const pod of inventory.pods) {
    const owner = podOwner(pod, inventory);
    if (!owner || owner.role !== query.role) continue;
    if (query.service !== undefined && owner.service !== query.service) continue;
    const phase = pod.status?.phase;
    if (!query.includeTerminated && (phase === 'Succeeded' || phase === 'Failed')) continue;
    const info = toInstanceInfo(pod, inventory, revisions, nodeToServer, redactor);
    if (info) out.push(info);
  }
  return orderInstanceTable(out);
}

// ---------------------------------------------------------------------------
// Labels, order and selection
// ---------------------------------------------------------------------------

/**
 * `<service>.<suffix>` for log prefixes and pickers: the ordinal when the id is `<nativeName>-<n>`
 * (StatefulSet pod) or `<nativeName>.<n>` (Swarm task name and slot), else the last 5 characters.
 */
export function instanceLabel(info: Pick<InstanceInfo, 'id' | 'service'>, nativeName: string): string {
  for (const separator of ['-', '.']) {
    const prefix = `${nativeName}${separator}`;
    const rest = info.id.startsWith(prefix) ? info.id.slice(prefix.length) : '';
    if (/^\d+$/.test(rest)) return `${info.service}.${rest}`;
  }
  return `${info.service}.${info.id.slice(-5)}`;
}

function ordinalOf(info: InstanceInfo): number | null {
  const match = /\.(\d+)$/.exec(info.label);
  if (!match) return null;
  const ordinal = match[1];
  return info.id.endsWith(`-${ordinal}`) || info.id.endsWith(`.${ordinal}`) ? Number(ordinal) : null;
}

function startedMs(info: InstanceInfo): number | null {
  if (info.startedAt === null) return null;
  const ms = Date.parse(info.startedAt);
  return Number.isNaN(ms) ? null : ms;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareInstances(a: InstanceInfo, b: InstanceInfo): number {
  if (a.ready !== b.ready) return a.ready ? -1 : 1;
  if (a.current !== b.current) return a.current ? -1 : 1;
  const ao = ordinalOf(a);
  const bo = ordinalOf(b);
  if (ao !== null && bo !== null && ao !== bo) return ao - bo;
  const as = startedMs(a);
  const bs = startedMs(b);
  if (as !== bs) {
    if (as === null) return 1;
    if (bs === null) return -1;
    return bs - as;
  }
  return compareCodeUnits(a.id, b.id);
}

/**
 * The single instance order (m8) used by `selectInstance`, the `--pick` prompt and every table:
 * ready first, current revision first, StatefulSet ordinal ascending, newest start first (unknown
 * last), then id.
 */
export function orderInstances(instances: readonly InstanceInfo[]): InstanceInfo[] {
  return [...instances].sort(compareInstances);
}

/** `ps` table: by service, current revision first, then `orderInstances`. */
export function orderInstanceTable(instances: readonly InstanceInfo[]): InstanceInfo[] {
  return [...instances].sort((a, b) => {
    const byService = compareCodeUnits(a.service, b.service);
    if (byService !== 0) return byService;
    if (a.current !== b.current) return a.current ? -1 : 1;
    return compareInstances(a, b);
  });
}

/** `1 Pending (Unschedulable), 1 CrashLoopBackOff`, in order of first appearance; `no pods` when empty. */
export function statusSummary(instances: readonly InstanceInfo[]): string {
  if (instances.length === 0) return 'no pods';
  const counts = new Map<string, number>();
  for (const i of instances) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
}

function isRunningStatus(info: InstanceInfo): boolean {
  return info.status === STATUS_RUNNING || info.status === STATUS_RUNNING_NOT_READY;
}

export interface InstanceRequest {
  service: string;
  /** InstanceInfo.id chosen by --pod */
  instance?: string;
  /** backup: the chosen instance must be ready */
  requireReady: boolean;
  /** environment name, for the suggestion */
  env: string;
}

/** Picks one running instance of a service without prompting (exec, cp, backup). */
export function selectInstance(instances: readonly InstanceInfo[], request: InstanceRequest): InstanceInfo {
  const own = orderInstances(instances.filter((i) => i.service === request.service));
  const candidates = own.filter(isRunningStatus);
  const diagnose = `Run \`dockflow diagnose ${request.env}\`.`;
  if (request.instance !== undefined) {
    const hit = candidates.find((i) => i.id === request.instance);
    if (hit) {
      if (request.requireReady && !hit.ready) {
        throw new CLIError(`Instance ${hit.id} of service ${request.service} is not ready (${hit.status})`, ErrorCode.CONTAINER_NOT_FOUND, diagnose);
      }
      return hit;
    }
    const known = own.find((i) => i.id === request.instance);
    if (known) {
      throw new CLIError(`Instance ${known.id} of service ${request.service} is not running (${known.status})`, ErrorCode.CONTAINER_NOT_FOUND, diagnose);
    }
    if (candidates.length > 0) {
      throw new ValidationError(
        `Instance ${request.instance} does not belong to service ${request.service}`,
        `Choose one of: \`${candidates.map((i) => i.id).join(', ')}\`.`,
      );
    }
  }
  const first = candidates[0];
  if (!first) {
    throw new CLIError(`Service ${request.service} has no running instance (${statusSummary(own)})`, ErrorCode.CONTAINER_NOT_FOUND, diagnose);
  }
  if (request.requireReady && !first.ready) {
    throw new CLIError(`Service ${request.service} has no ready instance (${statusSummary(own)})`, ErrorCode.CONTAINER_NOT_FOUND, diagnose);
  }
  return first;
}

/**
 * Container a command targets when none is named: the default-container annotation, the container
 * named after the service, the only container; null when several remain.
 */
export function defaultContainerName(
  names: readonly string[],
  annotations: Record<string, string> | undefined,
  serviceName: string,
): string | null {
  const annotated = annotations?.[ANNOTATIONS.defaultContainer];
  if (annotated && names.includes(annotated)) return annotated;
  if (names.includes(serviceName)) return serviceName;
  return names.length === 1 ? names[0] : null;
}

export function selectContainer(pod: Pod, requested: string | undefined, serviceName: string): string {
  const names = pod.spec.containers.map((c) => c.name);
  const listed = `\`${names.join(', ')}\``;
  if (requested !== undefined) {
    if (names.includes(requested)) return requested;
    throw new ValidationError(`Container ${requested} is not part of pod ${pod.metadata.name}`, `Choose one of: ${listed}.`);
  }
  const chosen = defaultContainerName(names, pod.metadata.annotations, serviceName);
  if (chosen !== null) return chosen;
  throw new ValidationError(`Pod ${pod.metadata.name} has several containers`, `Name one with \`--container <name>\`: ${listed}.`);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** `45s`, `12m`, `3h` (below 48 h), `2d`; `-` when unknown, never an age computed from now. */
export function formatAge(fromIso: string | null, now: Date): string {
  if (fromIso === null) return '-';
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return '-';
  const seconds = Math.max(0, Math.floor((now.getTime() - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `-` for an unknown count (Swarm), never `0` */
export function formatRestarts(restarts: number | null): string {
  return restarts === null ? '-' : String(restarts);
}

/** `CrashLoopBackOff (restarts 5, age 12m)`; unknown parts are left out, so Swarm reads `Failed`. */
export function instanceStateText(info: Pick<InstanceInfo, 'status' | 'restarts' | 'startedAt'>, now: Date): string {
  const parts: string[] = [];
  if (info.restarts !== null) parts.push(`restarts ${info.restarts}`);
  if (info.startedAt !== null) parts.push(`age ${formatAge(info.startedAt, now)}`);
  return parts.length > 0 ? `${info.status} (${parts.join(', ')})` : info.status;
}
