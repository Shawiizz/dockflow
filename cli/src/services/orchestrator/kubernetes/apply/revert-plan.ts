// Plan of the automatic revert (design-03 11.2, DESIGN-CORE DV2): re-apply the previous release's
// objects of the changed services, `rollout undo` only when no previous artifact exists, remove
// what the failed version added, restore Helm releases it upgraded, and clean up StatefulSet pods
// stuck on the failed revision (K17). PVCs are never re-applied when they exist (restore mode).
// Pure: no I/O, no clock.

import { canonicalJson } from '../../../../utils/hash';
import type { HelmReleaseRecord, StackRole, WorkloadChange, WorkloadKind } from '../../interfaces';
import { ANNOTATIONS } from '../constants';
import type { Middleware } from '../resources/traefik';
import { KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import { closeOver, closure, sortForEmission } from './closure';
import type { DisruptiveSwitch } from './pre-apply';
import type { LiveObjectRef } from './prune-plan';
import { compareCodeUnits, composeServiceOf, isWorkload, type LiveWorkload, type Snapshot } from './snapshot';

/** `update_config.failure_action` per compose service (the canonical stack's UpdateSpec). */
export type FailureAction = 'rollback' | 'pause' | 'continue';

export interface PreviousRelease {
  version: string;
  objects: ManifestObject[];
  helm: HelmReleaseRecord[];
}

export interface RevertPlanInput {
  role: StackRole;
  /** receipt targets (compose names); null = whole role */
  targets: string[] | null;
  changes: WorkloadChange[];
  /** objects applied by the failed receipt */
  applied: ManifestObject[];
  previous: PreviousRelease | null;
  /** Helm releases upgraded by the failed receipt */
  helmApplied: { release: HelmReleaseRecord; replaced: HelmReleaseRecord | null }[];
  failureActions: Record<string, FailureAction>;
  /** services whose live workload this deploy deleted and re-created (5.4.3, 5.4.4) */
  disruptive: DisruptiveSwitch[];
  before: Snapshot;
  /** snapshot taken by revert() */
  now: Snapshot;
  livePvcNames: string[];
}

export type LeftInPlaceReason = 'first-deploy' | 'no-history' | 'failure-action' | 'job';

export type RolloutKind = Exclude<WorkloadKind, 'Job'>;

export interface RevertPlan {
  /** compose names whose previous definition is restored or whose new objects are removed */
  services: string[];
  /**
   * live workloads to delete (foreground, waited) BEFORE `apply`: the previous artifact carries
   * another kind for these services, so applying it would leave two workloads (K15)
   */
  deleteFirst: LiveObjectRef[];
  apply: ManifestObject[];
  /** rank descending, like a prune */
  remove: LiveObjectRef[];
  undo: { service: string; kind: RolloutKind; name: string; toRevision: number }[];
  scale: { service: string; kind: 'Deployment' | 'StatefulSet'; name: string; replicas: number }[];
  /** StatefulSet pods stuck on the failed revision (forced rollback) */
  statefulSetPods: { service: string; statefulSet: string; failedRevision: string }[];
  helm: HelmReleaseRecord[];
  leftInPlace: { service: string; reason: LeftInPlaceReason }[];
  /** workloads to wait for after execution */
  watch: { service: string; kind: WorkloadKind; name: string }[];
}

function keyOf(kind: string, name: string): string {
  return `${kind}/${name}`;
}

function composeAnnotation(object: ManifestObject): string | undefined {
  return object.metadata.annotations?.[ANNOTATIONS.composeService];
}

function fingerprint(objects: readonly ManifestObject[], service: string): string {
  return canonicalJson(closure(objects, [service], { excludePvcs: true }).objects);
}

/**
 * A StatefulSet's currentRevision does not move while an update is stuck (K17), so the revision
 * being rolled out is what tells a template change apart from a replicas-only change.
 */
function templateChanged(before: LiveWorkload, now: LiveWorkload): boolean {
  return before.revision !== (now.pendingRevision ?? now.revision);
}

function helmDiffers(a: HelmReleaseRecord, b: HelmReleaseRecord): boolean {
  return canonicalJson(a.chart) !== canonicalJson(b.chart) || a.version !== b.version || a.valuesSha256 !== b.valuesSha256;
}

function refOf(object: ManifestObject, service: string | null): LiveObjectRef {
  return { kind: object.kind, name: object.metadata.name, service };
}

function byRankDescending(a: LiveObjectRef, b: LiveObjectRef): number {
  return KIND_REGISTRY[b.kind].rank - KIND_REGISTRY[a.kind].rank || compareCodeUnits(a.name, b.name);
}

function byService<T extends { service: string; name: string }>(a: T, b: T): number {
  return compareCodeUnits(a.service, b.service) || compareCodeUnits(a.name, b.name);
}

export function planRevert(input: RevertPlanInput): RevertPlan {
  const { previous, targets, now } = input;
  const inScope = (service: string) => targets === null || targets.includes(service);
  const find = (snapshot: Snapshot, kind: string, name: string) => snapshot.workloads.find((w) => w.kind === kind && w.name === name);

  // services of the failed receipt whose objects differ from the previous release (a service only
  // in `previous` was not touched: prune has not run, so it still runs unchanged)
  const appliedServices = [...new Set(input.applied.map(composeAnnotation).filter((s): s is string => s !== undefined))];
  const changedByArtifact = new Set(
    previous === null
      ? []
      : appliedServices.filter(inScope).filter((s) => fingerprint(input.applied, s) !== fingerprint(previous.objects, s)),
  );
  const changedServices = [...new Set([...input.changes.map((c) => c.service), ...changedByArtifact])]
    .filter(inScope)
    .sort(compareCodeUnits);

  const services = new Set<string>();
  const restore: string[] = [];
  const remove = new Map<string, LiveObjectRef>();
  const undo: RevertPlan['undo'] = [];
  const scale: RevertPlan['scale'] = [];
  const leftInPlace: RevertPlan['leftInPlace'] = [];

  for (const service of changedServices) {
    const serviceChanges = input.changes.filter((c) => c.service === service);
    if (serviceChanges.length > 0 && serviceChanges.every((c) => c.kind === 'Job') && !changedByArtifact.has(service)) {
      // a Job run cannot be undone
      leftInPlace.push({ service, reason: 'job' });
      continue;
    }
    if ((input.failureActions[service] ?? 'rollback') !== 'rollback') {
      leftInPlace.push({ service, reason: 'failure-action' });
      continue;
    }
    if (previous !== null) {
      if (previous.objects.some((o) => composeAnnotation(o) === service)) {
        restore.push(service);
      } else {
        // created by the failed deploy: workloads, Services and routes go; claims and hashed objects never
        for (const o of input.applied) {
          if (composeAnnotation(o) === service && KIND_REGISTRY[o.kind].prune === 'prune') {
            remove.set(keyOf(o.kind, o.metadata.name), refOf(o, service));
          }
        }
      }
      services.add(service);
      continue;
    }
    const change = serviceChanges.find((c) => c.kind !== 'Job');
    if (!change || change.created) {
      leftInPlace.push({ service, reason: input.role === 'app' ? 'first-deploy' : 'no-history' });
      continue;
    }
    const b = find(input.before, change.kind, change.name);
    const n = find(now, change.kind, change.name);
    if (b && n && change.kind !== 'Job') {
      if (b.revisionNumber !== null && templateChanged(b, n)) {
        undo.push({ service, kind: change.kind, name: change.name, toRevision: b.revisionNumber });
      }
      if (
        change.previousReplicas !== null &&
        (change.kind === 'Deployment' || change.kind === 'StatefulSet') &&
        n.replicas !== change.previousReplicas
      ) {
        scale.push({ service, kind: change.kind, name: change.name, replicas: change.previousReplicas });
      }
    }
    services.add(service);
  }

  const apply = new Map<string, ManifestObject>();
  const addApply = (o: ManifestObject) => apply.set(keyOf(o.kind, o.metadata.name), o);

  // Middlewares are stack objects: each one the failed receipt changed is restored together with
  // what it points at (auth Secret, K46); one it added is removed
  if (previous !== null) {
    const previousMiddlewares = new Map(
      previous.objects.filter((o): o is Middleware => o.kind === 'Middleware').map((m) => [m.metadata.name, m]),
    );
    const restored: Middleware[] = [];
    for (const m of input.applied) {
      if (m.kind !== 'Middleware') continue;
      const p = previousMiddlewares.get(m.metadata.name);
      if (!p) remove.set(keyOf(m.kind, m.metadata.name), refOf(m, null));
      else if (canonicalJson(p) !== canonicalJson(m)) restored.push(p);
    }
    for (const o of closeOver(previous.objects, restored, { excludePvcs: true })) addApply(o);
  }

  // the previous definition of the restored services; an existing claim is never re-applied (a
  // failed version may have grown it, I-13) but one that is gone comes back
  const livePvcs = new Set(input.livePvcNames);
  if (previous !== null && restore.length > 0) {
    for (const o of closure(previous.objects, restore).objects) {
      if (o.kind !== 'PersistentVolumeClaim' || !livePvcs.has(o.metadata.name)) addApply(o);
    }
  }

  const disruptive = new Set(input.disruptive.map((d) => d.service));
  const deleteFirst: LiveObjectRef[] = [];
  for (const service of restore) {
    const restored = [...apply.values()].filter((o) => isWorkload(o) && composeServiceOf(o) === service);
    for (const live of now.workloads.filter((w) => w.service === service)) {
      if (restored.some((r) => r.kind === live.kind && r.metadata.name === live.name)) continue;
      if (disruptive.has(service) || restored.some((r) => r.kind !== live.kind)) {
        deleteFirst.push({ kind: live.kind, name: live.name, service });
      }
    }
  }
  deleteFirst.sort((a, b) => compareCodeUnits(a.service ?? '', b.service ?? '') || compareCodeUnits(a.name, b.name));
  const deletedFirst = new Set(deleteFirst.map((d) => keyOf(d.kind, d.name)));

  // an existing Job is never re-applied (K43): server-side apply would fail on its generated selector
  for (const [key, o] of apply) {
    if (o.kind === 'Job' && find(now, 'Job', o.metadata.name) && !deletedFirst.has(key)) apply.delete(key);
  }

  const removed = new Set(remove.keys());
  // keyed on the live revision pair, so a StatefulSet an earlier failed attempt left mid-update is
  // cleaned up too, whatever `before` says (K17)
  const statefulSetPods: RevertPlan['statefulSetPods'] = now.workloads
    .flatMap((w) => {
      const key = keyOf(w.kind, w.name);
      if (w.kind !== 'StatefulSet' || !services.has(w.service) || deletedFirst.has(key) || removed.has(key)) return [];
      if (w.pendingRevision === null || w.pendingRevision === w.revision) return [];
      return [{ service: w.service, statefulSet: w.name, failedRevision: w.pendingRevision }];
    })
    .sort((a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.statefulSet, b.statefulSet));

  // releases installed for the first time by the failed deploy stay: an uninstall could delete PVCs (DV3)
  const helm = input.helmApplied.flatMap((h) => (h.replaced !== null && helmDiffers(h.replaced, h.release) ? [h.replaced] : []));

  const applyList = sortForEmission([...apply.values()]);
  const watch = new Map<string, RevertPlan['watch'][number]>();
  for (const o of applyList) {
    if (isWorkload(o) && o.kind !== 'Job') {
      watch.set(keyOf(o.kind, o.metadata.name), { service: composeServiceOf(o) ?? o.metadata.name, kind: o.kind, name: o.metadata.name });
    }
  }
  for (const u of [...undo, ...scale]) watch.set(keyOf(u.kind, u.name), { service: u.service, kind: u.kind, name: u.name });

  return {
    services: [...services].sort(compareCodeUnits),
    deleteFirst,
    apply: applyList,
    remove: [...remove.values()].sort(byRankDescending),
    undo: undo.sort(byService),
    scale: scale.sort(byService),
    statefulSetPods,
    helm,
    leftInPlace: leftInPlace.sort((a, b) => compareCodeUnits(a.service, b.service)),
    watch: [...watch.values()].sort(
      (a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.name, b.name),
    ),
  };
}

/** Nothing to execute: the revert reports `nothing-to-revert` with the left-in-place reasons. */
export function isEmptyRevertPlan(plan: RevertPlan): boolean {
  return (
    plan.helm.length === 0 &&
    plan.deleteFirst.length === 0 &&
    plan.apply.length === 0 &&
    plan.remove.length === 0 &&
    plan.undo.length === 0 &&
    plan.scale.length === 0 &&
    plan.statefulSetPods.length === 0
  );
}
