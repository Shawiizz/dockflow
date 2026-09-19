// Prune plan of a full deploy (design-03 8.2, DESIGN-CORE C11, C12), the references that keep
// content-hashed objects alive (8.3) and the counts the zero-workload guard reads (5.4.1).
// PVCs and the Namespace are never candidates (D7): claims only ever surface as orphan warnings.
// Pure: no I/O, no clock.

import type { StackRole } from '../../interfaces';
import { ANNOTATIONS, LABELS, PARTS } from '../constants';
import type { ControllerRevision, ReplicaSet } from '../resources/apps';
import type { Job } from '../resources/batch';
import type { PersistentVolumeClaim, Pod, PodSpec } from '../resources/core';
import type { ObjectMeta } from '../resources/meta';
import { isManifestKind, KIND_REGISTRY, type ManifestKind, type ManifestObject } from '../resources/registry';
import { compareCodeUnits, isWorkload, type Snapshot, templateRefs, type WorkloadObject } from './snapshot';

export interface LiveObjectRef {
  kind: ManifestKind;
  name: string;
  /** P/compose-service annotation */
  service: string | null;
  /** Jobs only: status.active > 0 */
  jobActive?: boolean;
}

export type HashedRef = { kind: 'Secret' | 'ConfigMap'; name: string };

export interface PrunePlanInput {
  /** full render (or full stored artifact) of the role */
  rendered: ManifestObject[];
  /** K17 with SEL_ROLE(role), through `toLiveRefs` */
  live: LiveObjectRef[];
  /** K15 */
  liveHashed: HashedRef[];
  /** `${kind}/${name}` collected from K16 */
  references: Set<string>;
  /** K09 filtered by SEL_ROLE(role); `volume` is the P/volume label value */
  livePvcs: { name: string; volume: string | null }[];
  /** live StatefulSets of the role (K07): name + the claim-template names they own */
  liveStatefulSets: { name: string; claimTemplates: string[] }[];
}

export interface PrunePlan {
  /** rank descending: IngressRoute, Middleware, Job, DaemonSet, StatefulSet, Deployment, Service */
  delete: LiveObjectRef[];
  deleteHashed: HashedRef[];
  keptHashed: (HashedRef & { reason: 'rendered' | 'referenced' })[];
  orphanPvcs: { name: string; volume: string | null }[];
  /** Jobs still running that a full deploy would otherwise have deleted (5.4.4) */
  keptJobs: LiveObjectRef[];
}

function keyOf(kind: string, name: string): string {
  return `${kind}/${name}`;
}

function byKindThenName(a: HashedRef, b: HashedRef): number {
  return compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.name, b.name);
}

export function planPrune(input: PrunePlanInput): PrunePlan {
  const rendered = new Set(input.rendered.map((o) => keyOf(o.kind, o.metadata.name)));
  // an unknown kind (Namespace, anything K17 should never have listed) is never a candidate
  const candidates = input.live.filter(
    (o) => isManifestKind(o.kind) && KIND_REGISTRY[o.kind].prune === 'prune' && !rendered.has(keyOf(o.kind, o.name)),
  );
  const keptJobs = candidates.filter((o) => o.kind === 'Job' && o.jobActive === true);
  const del = candidates
    .filter((o) => !keptJobs.includes(o))
    .sort((a, b) => KIND_REGISTRY[b.kind].rank - KIND_REGISTRY[a.kind].rank || compareCodeUnits(a.name, b.name));

  const deleteHashed: HashedRef[] = [];
  const keptHashed: PrunePlan['keptHashed'] = [];
  for (const h of [...input.liveHashed].sort(byKindThenName)) {
    const key = keyOf(h.kind, h.name);
    if (rendered.has(key)) keptHashed.push({ kind: h.kind, name: h.name, reason: 'rendered' });
    else if (input.references.has(key)) keptHashed.push({ kind: h.kind, name: h.name, reason: 'referenced' });
    else deleteHashed.push({ kind: h.kind, name: h.name });
  }

  const claimed = perReplicaClaimNames(input.rendered, input.liveStatefulSets);
  const orphanPvcs = input.livePvcs
    .filter((p) => !rendered.has(keyOf('PersistentVolumeClaim', p.name)) && !claimed.has(p.name))
    .map((p) => ({ name: p.name, volume: p.volume }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));

  return {
    delete: del,
    deleteHashed,
    keptHashed,
    orphanPvcs,
    keptJobs: keptJobs.sort((a, b) => compareCodeUnits(a.name, b.name)),
  };
}

/** Membership test over the PVC names the StatefulSet controller owns. */
export interface ClaimNameMatcher {
  /** `<template>-<statefulset>-` prefixes, sorted */
  prefixes: string[];
  has(name: string): boolean;
}

/**
 * Names of the PVCs the StatefulSet controller creates, `<template>-<statefulset>-<ordinal>`, which
 * are never in `rendered` (K40). Templates of the live AND the rendered StatefulSets count, so a
 * template removed from the compose file but still on the live StatefulSet keeps its claims out of
 * the orphan list, while claims of a StatefulSet that is gone together with its template are
 * reported.
 */
export function perReplicaClaimNames(
  rendered: readonly ManifestObject[],
  liveStatefulSets: readonly { name: string; claimTemplates: string[] }[],
): ClaimNameMatcher {
  const templates = new Map<string, Set<string>>();
  const addTemplates = (statefulSet: string, names: readonly string[]): void => {
    const set = templates.get(statefulSet) ?? new Set<string>();
    for (const name of names) set.add(name);
    templates.set(statefulSet, set);
  };
  for (const s of liveStatefulSets) addTemplates(s.name, s.claimTemplates);
  for (const o of rendered) {
    if (o.kind === 'StatefulSet') addTemplates(o.metadata.name, (o.spec.volumeClaimTemplates ?? []).map((t) => t.metadata.name));
  }
  const prefixes: string[] = [];
  for (const [statefulSet, names] of templates) {
    for (const template of names) prefixes.push(`${template}-${statefulSet}-`);
  }
  prefixes.sort(compareCodeUnits);
  return {
    prefixes,
    has: (name) => prefixes.some((p) => name.startsWith(p) && /^[0-9]+$/.test(name.slice(p.length))),
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One item of K17 as kubectl returns it. */
export interface LiveItem {
  kind: string;
  metadata: ObjectMeta;
}

/**
 * K17 items as prune candidates. Items of another role or another part are dropped even though
 * the selector already excludes them: the release, state and registry objects and helper pods
 * must never reach a delete list (U-PRUNE-03, U-PRUNE-04).
 */
export function toLiveRefs(items: readonly LiveItem[], role: StackRole): LiveObjectRef[] {
  const refs: LiveObjectRef[] = [];
  for (const item of items) {
    const labels = item.metadata.labels ?? {};
    if (!isManifestKind(item.kind) || labels[LABELS.part] !== PARTS.stack || labels[LABELS.role] !== role) continue;
    const ref: LiveObjectRef = {
      kind: item.kind,
      name: item.metadata.name,
      service: item.metadata.annotations?.[ANNOTATIONS.composeService] ?? null,
    };
    if (item.kind === 'Job') ref.jobActive = ((item as Job).status?.active ?? 0) > 0;
    refs.push(ref);
  }
  return refs;
}

/** K09 items as the orphan scan reads them. */
export function toPvcRefs(pvcs: readonly PersistentVolumeClaim[]): { name: string; volume: string | null }[] {
  return pvcs.map((p) => ({ name: p.metadata.name, volume: p.metadata.labels?.[LABELS.volume] ?? null }));
}

/** K15 output (`-o name`): `secret/<n>` and `configmap/<n>` lines; anything else is ignored. */
export function parseHashedNames(stdout: string): HashedRef[] {
  const refs: HashedRef[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(secret|configmap)\/(\S+)$/.exec(line.trim());
    if (match) refs.push({ kind: match[1] === 'secret' ? 'Secret' : 'ConfigMap', name: match[2] });
  }
  return refs;
}

/** What K16 lists: every object whose pod template can still bring back an older revision. */
export type ReferenceItem = Pod | ReplicaSet | ControllerRevision | WorkloadObject;

function referencedPodSpec(item: ReferenceItem): PodSpec | undefined {
  switch (item.kind) {
    case 'Pod':
      return item.spec;
    case 'ControllerRevision':
      return item.data?.spec?.template?.spec;
    default:
      // ReplicaSet and the four workload kinds
      return item.spec?.template?.spec;
  }
}

/**
 * `${kind}/${name}` of every Secret and ConfigMap referenced by a pod, a workload, a retained
 * ReplicaSet or a ControllerRevision of the namespace (design-03 8.3). Retained revisions keep the
 * hashed objects `rollout undo` needs.
 */
export function collectReferences(items: readonly ReferenceItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const refs = templateRefs(referencedPodSpec(item));
    for (const name of refs.secrets) out.add(keyOf('Secret', name));
    for (const name of refs.configMaps) out.add(keyOf('ConfigMap', name));
  }
  return out;
}

/** Counts the zero-workload guard of C11 reads before any mutation (design-03 5.4.1). */
export interface PruneGuard {
  renderedWorkloads: number;
  liveWorkloads: number;
  /** a render without workloads would prune every live workload of the role */
  refuse: boolean;
}

export function pruneGuard(rendered: readonly ManifestObject[], before: Snapshot): PruneGuard {
  const renderedWorkloads = rendered.filter(isWorkload).length;
  const liveWorkloads = before.workloads.length;
  return { renderedWorkloads, liveWorkloads, refuse: renderedWorkloads === 0 && liveWorkloads > 0 };
}
