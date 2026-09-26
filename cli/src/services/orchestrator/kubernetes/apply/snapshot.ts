// Snapshots of the live workloads and Services of one role (design-03 2.4) and change detection
// (5.6). The engine reads K07 + K08 and maps them here with `toSnapshot`; the pod-template reference
// walk is shared with the closure and the prune references.
// Pure: no I/O, no clock (time is a parameter).

import type { Protocol, WorkloadChange, WorkloadKind } from '../../interfaces';
import { ANNOTATIONS, KUBE_KEYS, LABELS } from '../constants';
import { canonicalQuantity } from '../model/units';
import type { ControllerRevision, DaemonSet, Deployment, StatefulSet } from '../resources/apps';
import type { Job } from '../resources/batch';
import type { PodSpec, Service, ServiceType } from '../resources/core';
import type { Condition, ObjectMeta } from '../resources/meta';
import { KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import type { LiveObjectRef } from './prune-plan';

export type WorkloadObject = Deployment | StatefulSet | DaemonSet | Job;

const WORKLOAD_KINDS: readonly WorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'];

export function isWorkloadKind(kind: string): kind is WorkloadKind {
  return (WORKLOAD_KINDS as readonly string[]).includes(kind);
}

export function isWorkload(object: ManifestObject): object is WorkloadObject {
  return isWorkloadKind(object.kind);
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compose name of an object: annotation P/compose-service, fallback label P/service. */
export function composeServiceOf(object: { metadata: ObjectMeta }): string | null {
  return object.metadata.annotations?.[ANNOTATIONS.composeService] ?? object.metadata.labels?.[LABELS.service] ?? null;
}

export function podSpecOf(workload: WorkloadObject): PodSpec {
  return workload.spec.template.spec;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateRefs {
  /** envFrom.secretRef, env.valueFrom.secretKeyRef, volumes.secret, projected */
  secrets: string[];
  /** envFrom.configMapRef, env.valueFrom.configMapKeyRef, volumes.configMap, projected */
  configMaps: string[];
  /** volumes.persistentVolumeClaim.claimName */
  claims: string[];
  /** containers + initContainers */
  images: string[];
}

export interface ClaimTemplateSpec {
  name: string;
  /** P/compose-volume annotation of the template */
  volumeKey: string | null;
  storageClassName: string | null;
  accessModes: string[];
  /** resources.requests.storage, canonical quantity */
  storage: string;
}

export interface LiveWorkload {
  kind: WorkloadKind;
  name: string;
  /** compose name: annotation P/compose-service, fallback label P/service */
  service: string;
  uid: string;
  generation: number;
  /** spec.replicas; null for DaemonSet / Job */
  replicas: number | null;
  /**
   * Deployment: annotation deployment.kubernetes.io/revision; StatefulSet: status.currentRevision;
   * DaemonSet: name of the owned ControllerRevision with the highest .revision; Job: null
   */
  revision: string | null;
  /**
   * StatefulSet: status.updateRevision, the revision being rolled out (the pods being replaced carry
   * it in controller-revision-hash); equal to `revision` when no update is in flight. null for every
   * other kind (K17).
   */
  pendingRevision: string | null;
  /** the integer `rollout undo --to-revision` takes (Deployment annotation value, ControllerRevision.revision) */
  revisionNumber: number | null;
  /** spec.template.spec.terminationGracePeriodSeconds ?? 30; feeds deleteWaitS / revertWaitS (K41) */
  graceSeconds: number;
  /** Deployment spec.paused (false for other kinds) */
  paused: boolean;
  /** metadata.deletionTimestamp is set */
  deleting: boolean;
  /** carries P/replicas-before-stop: `stop` scaled it to 0 (absent when not) */
  stopAnnotated?: boolean;
  /** Jobs only: terminal state from conditions, and status.active ?? 0 */
  job: { finished: 'complete' | 'failed' | null; active: number } | null;
  /**
   * StatefulSet: spec.volumeClaimTemplates ([] for other kinds). The controller injects these claims
   * into pods, so they never appear in refs.claims.
   */
  claimTemplates: ClaimTemplateSpec[];
  refs: TemplateRefs;
}

/** Only the Services of the role; `-lb` detection and LoadBalancer convergence (K19). */
export interface LiveService {
  name: string;
  /** compose name: annotation P/compose-service */
  service: string;
  type: ServiceType;
  /** null when absent; a headless Service keeps the literal 'None' */
  clusterIP: string | null;
  ports: { port: number; protocol: Protocol; targetPort: number | string | null }[];
  /** status.loadBalancer.ingress is not empty */
  hasIngress: boolean;
}

export interface Snapshot {
  takenAt: Date;
  workloads: LiveWorkload[];
  services: LiveService[];
}

/** A `-lb` Service a receipt waits on (design-03 5.9, 9.1, K19). */
export interface LbWatchTarget {
  service: string;
  /** Service object name, always `<svc>-lb` */
  name: string;
  /** published (port, protocol) pairs the Service asks the load balancer to bind */
  ports: { port: number; protocol: Protocol }[];
}

/** What K07 returns: the role's workloads and Services. */
export type SnapshotItem = WorkloadObject | Service;

export function emptySnapshot(takenAt: Date): Snapshot {
  return { takenAt, workloads: [], services: [] };
}

// ---------------------------------------------------------------------------
// Pod template references
// ---------------------------------------------------------------------------

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/** Every Secret, ConfigMap, claim and image a pod spec references (design-03 2.4, 8.3). */
export function templateRefs(spec: PodSpec | undefined): TemplateRefs {
  const secrets: string[] = [];
  const configMaps: string[] = [];
  const claims: string[] = [];
  const images: string[] = [];
  for (const container of [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]) {
    if (container.image) images.push(container.image);
    for (const source of container.envFrom ?? []) {
      if (source.secretRef?.name) secrets.push(source.secretRef.name);
      if (source.configMapRef?.name) configMaps.push(source.configMapRef.name);
    }
    for (const variable of container.env ?? []) {
      if (variable.valueFrom?.secretKeyRef?.name) secrets.push(variable.valueFrom.secretKeyRef.name);
      if (variable.valueFrom?.configMapKeyRef?.name) configMaps.push(variable.valueFrom.configMapKeyRef.name);
    }
  }
  for (const volume of spec?.volumes ?? []) {
    if (volume.secret?.secretName) secrets.push(volume.secret.secretName);
    if (volume.configMap?.name) configMaps.push(volume.configMap.name);
    if (volume.persistentVolumeClaim?.claimName) claims.push(volume.persistentVolumeClaim.claimName);
    for (const source of volume.projected?.sources ?? []) {
      if (source.secret?.name) secrets.push(source.secret.name);
      if (source.configMap?.name) configMaps.push(source.configMap.name);
    }
  }
  return {
    secrets: sortedUnique(secrets),
    configMaps: sortedUnique(configMaps),
    claims: sortedUnique(claims),
    images: sortedUnique(images),
  };
}

// ---------------------------------------------------------------------------
// toSnapshot (K07 + K08)
// ---------------------------------------------------------------------------

function isTrue(conditions: Condition[] | undefined, ...types: string[]): boolean {
  return (conditions ?? []).some((c) => types.includes(c.type) && c.status === 'True');
}

/** Terminal state of a Job. The *Target conditions are set once the outcome is decided, before the pods terminate. */
function jobState(job: Job): LiveWorkload['job'] {
  const conditions = job.status?.conditions;
  const finished = isTrue(conditions, 'Failed', 'FailureTarget')
    ? 'failed'
    : isTrue(conditions, 'Complete', 'SuccessCriteriaMet')
      ? 'complete'
      : null;
  return { finished, active: job.status?.active ?? 0 };
}

function ownedRevisions(workload: WorkloadObject, revisions: readonly ControllerRevision[]): ControllerRevision[] {
  const uid = workload.metadata.uid;
  return revisions.filter((r) =>
    (r.metadata.ownerReferences ?? []).some((o) =>
      uid !== undefined && o.uid ? o.uid === uid : o.kind === workload.kind && o.name === workload.metadata.name,
    ),
  );
}

function parseRevisionNumber(value: string | undefined): number | null {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : null;
}

interface Revisions {
  revision: string | null;
  pendingRevision: string | null;
  revisionNumber: number | null;
}

function revisionsOf(workload: WorkloadObject, revisions: readonly ControllerRevision[]): Revisions {
  switch (workload.kind) {
    case 'Deployment': {
      const annotation = workload.metadata.annotations?.[KUBE_KEYS.deploymentRevision];
      return { revision: annotation ?? null, pendingRevision: null, revisionNumber: parseRevisionNumber(annotation) };
    }
    case 'StatefulSet': {
      const revision = workload.status?.currentRevision ?? null;
      const owned = ownedRevisions(workload, revisions).find((r) => r.metadata.name === revision);
      return {
        revision,
        pendingRevision: workload.status?.updateRevision ?? revision,
        revisionNumber: owned?.revision ?? null,
      };
    }
    case 'DaemonSet': {
      const latest = ownedRevisions(workload, revisions)
        .filter((r) => typeof r.revision === 'number')
        .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
      return { revision: latest?.metadata.name ?? null, pendingRevision: null, revisionNumber: latest?.revision ?? null };
    }
    case 'Job':
      return { revision: null, pendingRevision: null, revisionNumber: null };
  }
}

function claimTemplatesOfWorkload(workload: WorkloadObject): ClaimTemplateSpec[] {
  if (workload.kind !== 'StatefulSet') return [];
  return (workload.spec.volumeClaimTemplates ?? []).map((t) => {
    const storage = t.spec?.resources?.requests?.storage ?? '';
    return {
      name: t.metadata.name,
      volumeKey: t.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? null,
      storageClassName: t.spec?.storageClassName ?? null,
      accessModes: [...(t.spec?.accessModes ?? [])],
      storage: canonicalQuantity(storage) ?? storage,
    };
  });
}

function toLiveWorkload(workload: WorkloadObject, revisions: readonly ControllerRevision[]): LiveWorkload {
  const spec = workload.spec?.template?.spec;
  const replicas =
    workload.kind === 'Deployment' || workload.kind === 'StatefulSet' ? (workload.spec.replicas ?? 1) : null;
  return {
    kind: workload.kind,
    name: workload.metadata.name,
    service: composeServiceOf(workload) ?? workload.metadata.name,
    uid: workload.metadata.uid ?? '',
    generation: workload.metadata.generation ?? 0,
    replicas,
    ...revisionsOf(workload, revisions),
    graceSeconds: spec?.terminationGracePeriodSeconds ?? 30,
    paused: workload.kind === 'Deployment' && workload.spec.paused === true,
    deleting: workload.metadata.deletionTimestamp !== undefined,
    ...(workload.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop] !== undefined ? { stopAnnotated: true } : {}),
    job: workload.kind === 'Job' ? jobState(workload) : null,
    claimTemplates: claimTemplatesOfWorkload(workload),
    refs: templateRefs(spec),
  };
}

function toLiveService(service: Service): LiveService {
  return {
    name: service.metadata.name,
    service: composeServiceOf(service) ?? service.metadata.name,
    type: service.spec?.type ?? 'ClusterIP',
    clusterIP: service.spec?.clusterIP ?? null,
    ports: (service.spec?.ports ?? []).map((p) => ({
      port: p.port,
      protocol: p.protocol ?? 'TCP',
      targetPort: p.targetPort ?? null,
    })),
    hasIngress: (service.status?.loadBalancer?.ingress?.length ?? 0) > 0,
  };
}

function byRankThenName(a: { kind: WorkloadKind; name: string }, b: { kind: WorkloadKind; name: string }): number {
  return KIND_REGISTRY[a.kind].rank - KIND_REGISTRY[b.kind].rank || compareCodeUnits(a.name, b.name);
}

/** Maps K07 (workloads and Services of the role) and K08 (their ControllerRevisions). */
export function toSnapshot(
  items: readonly SnapshotItem[],
  revisions: readonly ControllerRevision[],
  takenAt: Date,
): Snapshot {
  const workloads: LiveWorkload[] = [];
  const services: LiveService[] = [];
  for (const item of items) {
    if (item.kind === 'Service') services.push(toLiveService(item));
    else if (isWorkloadKind(item.kind)) workloads.push(toLiveWorkload(item, revisions));
  }
  return {
    takenAt,
    workloads: workloads.sort(byRankThenName),
    services: services.sort((a, b) => compareCodeUnits(a.name, b.name)),
  };
}

/** Live StatefulSets and the claim-template names they own (prune plan input, 8.4). */
export function claimTemplatesOf(snapshot: Snapshot): { name: string; claimTemplates: string[] }[] {
  return snapshot.workloads
    .filter((w) => w.kind === 'StatefulSet')
    .map((w) => ({ name: w.name, claimTemplates: w.claimTemplates.map((t) => t.name) }));
}

// ---------------------------------------------------------------------------
// Change detection (5.6)
// ---------------------------------------------------------------------------

function byServiceThenKindThenName(a: WorkloadChange, b: WorkloadChange): number {
  return compareCodeUnits(a.service, b.service) || compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.name, b.name);
}

/**
 * Workloads of `applied` that were created or whose generation moved. `recreated` lists the Jobs
 * deleted and re-created under the same name (5.4.4), which `before` would report as unchanged.
 */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  applied: readonly ManifestObject[],
  recreated: readonly LiveObjectRef[] = [],
): WorkloadChange[] {
  const changes: WorkloadChange[] = [];
  const same = (w: { kind: string; name: string }, o: ManifestObject) => w.kind === o.kind && w.name === o.metadata.name;
  for (const o of applied.filter(isWorkload)) {
    const a = after.workloads.find((w) => same(w, o));
    // the apply failed before this object
    if (!a) continue;
    const b = recreated.some((r) => same(r, o)) ? undefined : before.workloads.find((w) => same(w, o));
    // a spec change moves the generation (and, on a Deployment, an annotation change: workload
    // metadata carries none that changes between releases)
    if (b && b.generation === a.generation) continue;
    changes.push({
      service: a.service,
      kind: a.kind,
      name: a.name,
      created: !b,
      previousRevision: b?.revision ?? null,
      previousRevisionNumber: b?.revisionNumber ?? null,
      previousReplicas: b?.replicas ?? null,
      generation: a.generation,
    });
  }
  return changes.sort(byServiceThenKindThenName);
}
