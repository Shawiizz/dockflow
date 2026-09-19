// Label sets and label selectors of every object Dockflow creates (DESIGN-CORE 5.2, 5.5; design-02
// 1.3; design-03 0). Builders return fresh plain maps; key order is irrelevant because the emitter
// sorts. Selector strings spell every key in full.
// Pure: no I/O, no clock.

import { K8S_MANAGED_BY, LABELS, type ObjectPart, PARTS } from './constants';
import type { StackIdentity, StackRole } from './model/types';
import { releaseSlug } from './naming';

export type LabelMap = Record<string, string>;

/** The identity fields labels read: `project` (part-of) and `namespace` (instance, P/stack = stackId). */
export type LabelIdentity = Pick<StackIdentity, 'project' | 'namespace'>;

/** Every object Dockflow creates in a stack namespace, and the namespace itself. */
function stackNamespaceLabels(id: LabelIdentity): LabelMap {
  return {
    [LABELS.managedBy]: K8S_MANAGED_BY,
    [LABELS.partOf]: id.project,
    [LABELS.instance]: id.namespace,
    [LABELS.stack]: id.namespace,
  };
}

/** Stack namespace (5.5): no part, no role; never pruned or deleted by Dockflow. */
export function namespaceLabels(id: LabelIdentity): LabelMap {
  return stackNamespaceLabels(id);
}

/** Artifact objects that belong to no single service: PVCs, compose secret/config objects, Middlewares, auth Secrets. */
export function stackObjectLabels(id: LabelIdentity, role: StackRole): LabelMap {
  return { ...stackNamespaceLabels(id), [LABELS.role]: role, [LABELS.part]: PARTS.stack };
}

/** Per-service artifact objects: workloads, Services of every shape, env Secrets, IngressRoutes. */
export function serviceObjectLabels(id: LabelIdentity, role: StackRole, service: string): LabelMap {
  return { ...stackObjectLabels(id, role), [LABELS.name]: service, [LABELS.service]: service };
}

/**
 * Content-hashed Secrets and ConfigMaps (5.6): the env Secret of `service`, or a compose secret or
 * config object (`service` null), plus `P/hashed`.
 */
export function hashedObjectLabels(id: LabelIdentity, role: StackRole, service: string | null): LabelMap {
  const base = service === null ? stackObjectLabels(id, role) : serviceObjectLabels(id, role, service);
  return { ...base, [LABELS.hashed]: 'true' };
}

/**
 * Standalone PVCs and claim templates (the controller's PVCs inherit the template labels).
 * Top-level volume labels merge under the Dockflow labels: Dockflow keys win.
 */
export function volumeClaimLabels(id: LabelIdentity, role: StackRole, claimName: string, volumeLabels: LabelMap = {}): LabelMap {
  return { ...volumeLabels, ...stackObjectLabels(id, role), [LABELS.volume]: claimName };
}

/** Workload `selector.matchLabels`, Service `selector`, anti-affinity and spread selectors; immutable. */
export function selectorLabels(id: Pick<StackIdentity, 'namespace'>, service: string): LabelMap {
  return { [LABELS.stack]: id.namespace, [LABELS.service]: service };
}

/**
 * Pod template labels: exactly the selector labels, `app.kubernetes.io/name`, `app.kubernetes.io/instance`,
 * `P/role` and `x-dockflow.pod_labels`. No release version, so an unchanged service never rolls.
 */
export function podTemplateLabels(id: LabelIdentity, role: StackRole, service: string, podLabels: LabelMap = {}): LabelMap {
  return {
    ...podLabels,
    ...selectorLabels(id, service),
    [LABELS.name]: service,
    [LABELS.instance]: id.namespace,
    [LABELS.role]: role,
  };
}

function partLabels(id: LabelIdentity, part: ObjectPart): LabelMap {
  return { ...stackNamespaceLabels(id), [LABELS.part]: part };
}

/** Release Secret `dockflow-release-<slug>` (6.7). */
export function releaseSecretLabels(id: LabelIdentity, version: string): LabelMap {
  return { ...partLabels(id, PARTS.release), [LABELS.releaseVersion]: releaseSlug(version) };
}

/** In-cluster copy kept while a same-version redeploy replaces a release (design-03 13.4). */
export function releaseBackupSecretLabels(id: LabelIdentity, version: string): LabelMap {
  return { ...partLabels(id, PARTS.releaseBackup), [LABELS.releaseVersion]: releaseSlug(version) };
}

/** `dockflow-state` ConfigMap */
export function stateConfigMapLabels(id: LabelIdentity): LabelMap {
  return partLabels(id, PARTS.state);
}

/** `dockflow-registry` pull Secret */
export function registrySecretLabels(id: LabelIdentity): LabelMap {
  return partLabels(id, PARTS.registry);
}

/** Backup and restore helper pods, always deleted in `finally`. */
export function helperPodLabels(id: LabelIdentity): LabelMap {
  return partLabels(id, PARTS.helper);
}

/** Objects in dockflow-system or cluster-scoped (StorageClass, deployer identity, proxy ConfigMap and Lease). */
export function systemObjectLabels(): LabelMap {
  return { [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.part]: PARTS.system };
}

/** Lease in dockflow-system: the deploy lock of a stack carries `P/stack`; the proxy lock (`stackId` null) does not. */
export function leaseLabels(stackId: string | null): LabelMap {
  return stackId === null ? systemObjectLabels() : { ...systemObjectLabels(), [LABELS.stack]: stackId };
}

// ---------------------------------------------------------------------------
// Selector strings (`-l` arguments)
// ---------------------------------------------------------------------------

const MANAGED = `${LABELS.managedBy}=${K8S_MANAGED_BY}`;

/** whole stack */
export function stackSelector(stackId: string): string {
  return `${MANAGED},${LABELS.stack}=${stackId}`;
}

/** artifact objects of one role: apply, prune, stop, remove (SEL_ROLE) */
export function SEL_ROLE(stackId: string, role: StackRole): string {
  return `${stackSelector(stackId)},${LABELS.role}=${role},${LABELS.part}=${PARTS.stack}`;
}

/** one service */
export function serviceSelector(stackId: string, service: string): string {
  return `${LABELS.stack}=${stackId},${LABELS.service}=${service}`;
}

/**
 * Pods, ReplicaSets, ControllerRevisions and workloads of one role, optionally narrowed to some
 * services. Pods carry only pod-template labels, so no managed-by or part term (PD-9).
 */
export function SEL_POD(stackId: string, role: StackRole, services?: readonly string[]): string {
  const base = `${LABELS.stack}=${stackId},${LABELS.role}=${role}`;
  if (services === undefined) return base;
  if (services.length === 0) throw new Error('SEL_POD needs at least one service when a service list is given');
  const sorted = [...new Set(services)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${base},${LABELS.service} in (${sorted.join(',')})`;
}

/** content-hashed Secrets and ConfigMaps of one role */
export function SEL_HASHED(stackId: string, role: StackRole): string {
  return `${SEL_ROLE(stackId, role)},${LABELS.hashed}=true`;
}

/** release Secrets */
export function SEL_RELEASE(stackId: string): string {
  return `${stackSelector(stackId)},${LABELS.part}=${PARTS.release}`;
}

/** release backups of a same-version redeploy */
export function SEL_RELEASE_BACKUP(stackId: string): string {
  return `${stackSelector(stackId)},${LABELS.part}=${PARTS.releaseBackup}`;
}
