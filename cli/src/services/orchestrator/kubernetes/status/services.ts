// Pure ServiceInfo mapping (design-06 2.4): compose workloads and Helm releases of one role, with
// replicas, published and cluster ports, and a state. No I/O and no clock.

import type { HelmReleaseStatus, PortInfo, ServiceInfo, StackRole } from '../../interfaces';
import { K8S_IMPORTED_IMAGE_REGISTRY, LABELS, PARTS } from '../constants';
import type { Protocol } from '../model/types';
import type { DaemonSet, Deployment, StatefulSet } from '../resources/apps';
import type { ContainerPort, Pod, ServicePort } from '../resources/core';
import {
  defaultContainerName,
  type InventoryView,
  podController,
  podDisplayStatus,
  type WorkloadObject,
  type WorkloadRecord,
} from './pods';

type ServiceState = ServiceInfo['state'];

const PROTOCOLS: Readonly<Record<Protocol, PortInfo['protocol']>> = { TCP: 'tcp', UDP: 'udp', SCTP: 'sctp' };

function protocolOf(protocol: Protocol | undefined): PortInfo['protocol'] {
  return (protocol && PROTOCOLS[protocol]) ?? 'tcp';
}

/** The headless Service of a portless service carries this one port (core C9); it is not a port of the service. */
const PLACEHOLDER_PORT_NAME = 'placeholder';

// ---------------------------------------------------------------------------
// Replicas and state
// ---------------------------------------------------------------------------

/** Every `status.*` count may be absent: the API server omits zero values. */
export function workloadReplicas(object: WorkloadObject): ServiceInfo['replicas'] {
  switch (object.kind) {
    case 'Deployment':
    case 'StatefulSet':
      return { running: object.status?.readyReplicas ?? 0, desired: object.spec.replicas ?? 1 };
    case 'DaemonSet':
      return { running: object.status?.numberReady ?? 0, desired: object.status?.desiredNumberScheduled ?? 0 };
    case 'Job':
      return { running: object.status?.succeeded ?? 0, desired: object.spec.completions ?? 1 };
  }
}

function generationObserved(object: Deployment | StatefulSet | DaemonSet): boolean {
  return (object.status?.observedGeneration ?? 0) >= (object.metadata.generation ?? 0);
}

/**
 * Every pod runs the newest template, read from the workload's own status so listings need no
 * revisions read: no Deployment pod outside the updated ReplicaSet, the StatefulSet update
 * revision reached, every DaemonSet node updated.
 */
function rolledOut(object: WorkloadObject): boolean {
  switch (object.kind) {
    case 'Deployment': {
      const updated = object.status?.updatedReplicas ?? 0;
      return generationObserved(object) && updated >= (object.spec.replicas ?? 1) && (object.status?.replicas ?? 0) <= updated;
    }
    case 'StatefulSet': {
      const update = object.status?.updateRevision;
      const current = object.status?.currentRevision;
      return generationObserved(object) && (!update || !current || update === current);
    }
    case 'DaemonSet':
      return generationObserved(object) && (object.status?.updatedNumberScheduled ?? 0) >= (object.status?.desiredNumberScheduled ?? 0);
    case 'Job':
      return true;
  }
}

/** Deployment `Progressing=False` (ProgressDeadlineExceeded) or `ReplicaFailure=True` */
export function rolloutFailing(object: WorkloadObject): boolean {
  if (object.kind !== 'Deployment') return false;
  const conditions = object.status?.conditions ?? [];
  return conditions.some(
    (c) => (c.type === 'Progressing' && c.status === 'False') || (c.type === 'ReplicaFailure' && c.status === 'True'),
  );
}

function jobCondition(object: WorkloadObject, type: 'Complete' | 'Failed'): boolean {
  return object.kind === 'Job' && (object.status?.conditions ?? []).some((c) => c.type === type && c.status === 'True');
}

function isFinished(pod: Pod): boolean {
  return pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed';
}

/**
 * `stopped` when nothing is desired, `degraded` on a failing pod or rollout, `running` once every
 * replica is ready on the newest template, else `converging`. A finished pod of a long-running
 * workload (an evicted one the kubelet keeps) was already replaced, so it does not count; a Job's
 * own conditions decide once it has finished.
 */
export function workloadState(object: WorkloadObject, pods: readonly Pod[]): ServiceState {
  const replicas = workloadReplicas(object);
  if (replicas.desired === 0) return 'stopped';
  if (jobCondition(object, 'Complete')) return 'running';
  if (jobCondition(object, 'Failed')) return 'degraded';
  const live = object.kind === 'Job' ? pods : pods.filter((p) => !isFinished(p));
  if (live.some((p) => podDisplayStatus(p).severity === 'error') || rolloutFailing(object)) return 'degraded';
  if (replicas.running === replicas.desired && rolledOut(object)) return 'running';
  return 'converging';
}

const STATE_WEIGHT: Readonly<Record<ServiceState, number>> = { running: 0, stopped: 1, converging: 2, degraded: 3 };

function worstState(states: readonly ServiceState[]): ServiceState {
  let worst: ServiceState = 'running';
  for (const s of states) if (STATE_WEIGHT[s] > STATE_WEIGHT[worst]) worst = s;
  return worst;
}

/** Pods of the namespace grouped by `<kind>/<name>` of their controlling workload. */
export function podsByWorkload(pods: readonly Pod[]): Map<string, Pod[]> {
  const index = new Map<string, Pod[]>();
  for (const pod of pods) {
    const ref = podController(pod);
    if (!ref) continue;
    const key = `${ref.kind}/${ref.name}`;
    const list = index.get(key) ?? [];
    list.push(pod);
    index.set(key, list);
  }
  return index;
}

function workloadKey(object: WorkloadObject): string {
  return `${object.kind}/${object.metadata.name}`;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function containerPortsOf(object: WorkloadObject): ContainerPort[] {
  return object.spec.template.spec.containers.flatMap((c) => c.ports ?? []);
}

function resolveTarget(port: ServicePort, containerPorts: readonly ContainerPort[]): number | null {
  const target = port.targetPort;
  if (target === undefined) return port.port;
  if (typeof target === 'number') return target;
  if (/^\d+$/.test(target)) return Number(target);
  const named = containerPorts.find((c) => c.name === target && c.protocol === port.protocol) ?? containerPorts.find((c) => c.name === target);
  return named ? named.containerPort : null;
}

function comparePorts(a: PortInfo, b: PortInfo): number {
  if (a.target !== b.target) return a.target - b.target;
  if (a.protocol !== b.protocol) return a.protocol < b.protocol ? -1 : 1;
  return (a.published ?? -1) - (b.published ?? -1);
}

/**
 * Ports of one compose workload: its ClusterIP and headless Services (`cluster`), its `-lb`
 * LoadBalancer Service (`ingress`) and template `hostPort`s (`host`). Deduplicated on
 * (target, protocol, published) and sorted.
 */
export function servicePorts(inventory: InventoryView, record: WorkloadRecord): PortInfo[] {
  const containerPorts = containerPortsOf(record.object);
  const found: PortInfo[] = [];
  for (const service of inventory.services) {
    const labels = service.metadata.labels ?? {};
    if (labels[LABELS.service] !== record.serviceName || labels[LABELS.part] !== PARTS.stack) continue;
    const loadBalancer = service.spec.type === 'LoadBalancer';
    const headless = service.spec.clusterIP === 'None';
    for (const port of service.spec.ports ?? []) {
      if (headless && port.name === PLACEHOLDER_PORT_NAME) continue;
      const target = resolveTarget(port, containerPorts);
      if (target === null) continue;
      const protocol = protocolOf(port.protocol);
      found.push(
        loadBalancer
          ? { target, published: port.port, protocol, mode: 'ingress' }
          : { target, published: null, protocol, mode: 'cluster' },
      );
    }
  }
  for (const port of containerPorts) {
    if (port.hostPort === undefined) continue;
    found.push({ target: port.containerPort, published: port.hostPort, protocol: protocolOf(port.protocol), mode: 'host' });
  }
  const seen = new Set<string>();
  const unique: PortInfo[] = [];
  for (const port of found) {
    const key = `${port.target}/${port.protocol}/${port.published ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(port);
  }
  return unique.sort(comparePorts);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMPORTED_PREFIX = `${K8S_IMPORTED_IMAGE_REGISTRY}/`;

/** Image of the container a command would target, without the imported-image registry. */
export function workloadImage(record: Pick<WorkloadRecord, 'object' | 'serviceName'>): string {
  const template = record.object.spec.template;
  const containers = template.spec.containers;
  const name = defaultContainerName(
    containers.map((c) => c.name),
    template.metadata.annotations,
    record.serviceName,
  );
  const image = (containers.find((c) => c.name === name) ?? containers[0])?.image ?? '';
  return image.startsWith(IMPORTED_PREFIX) ? image.slice(IMPORTED_PREFIX.length) : image;
}

/** Helm's `<chart>-<version>` as `chart <chart>@<version>` */
export function helmChartDisplay(chart: string): string {
  const match = /^(.+?)-(v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(chart);
  return match ? `chart ${match[1]}@${match[2]}` : `chart ${chart}`;
}

// ---------------------------------------------------------------------------
// ServiceInfo
// ---------------------------------------------------------------------------

function compareByName(a: ServiceInfo, b: ServiceInfo): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function modeOf(object: WorkloadObject): ServiceInfo['mode'] {
  if (object.kind === 'DaemonSet') return 'global';
  if (object.kind === 'Job') return 'job';
  return 'replicated';
}

/**
 * ServiceInfo rows of one role: compose services by name, then Helm releases by name. Helm rows
 * without a `P/role` label are skipped; their image is `chart <chart>@<version>` from `helm`.
 */
export function toServiceInfos(inventory: InventoryView, role: StackRole, helm: readonly HelmReleaseStatus[]): ServiceInfo[] {
  const pods = podsByWorkload(inventory.pods);
  const compose: ServiceInfo[] = [];
  for (const record of inventory.composeWorkloads.values()) {
    if (record.role !== role) continue;
    compose.push({
      name: record.service,
      // P/service rather than metadata.name: a Job's object name carries its template checksum
      nativeName: record.serviceName,
      kind: 'service',
      role: record.role,
      mode: modeOf(record.object),
      image: workloadImage(record),
      replicas: workloadReplicas(record.object),
      ports: servicePorts(inventory, record),
      state: workloadState(record.object, pods.get(workloadKey(record.object)) ?? []),
    });
  }
  const releases: ServiceInfo[] = [];
  for (const release of inventory.helm) {
    const status = helm.find((h) => h.name === release.release && h.namespace === release.namespace);
    const releaseRole = release.role ?? status?.role ?? null;
    if (releaseRole !== role) continue;
    const objects = release.workloads
      .map((w) => inventory.workloads.find((o) => o.kind === w.kind && o.metadata.name === w.name))
      .filter((o): o is WorkloadObject => o !== undefined);
    const replicas = { running: 0, desired: 0 };
    for (const object of objects) {
      const r = workloadReplicas(object);
      replicas.running += r.running;
      replicas.desired += r.desired;
    }
    releases.push({
      name: release.release,
      nativeName: release.release,
      kind: 'helm',
      role: releaseRole,
      mode: 'replicated',
      image: status ? helmChartDisplay(status.chart) : 'chart unknown',
      replicas,
      ports: [],
      state: worstState(objects.map((o) => workloadState(o, pods.get(workloadKey(o)) ?? []))),
    });
  }
  return [...compose.sort(compareByName), ...releases.sort(compareByName)];
}
