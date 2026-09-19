// Storage (design-02 7, D7, D8): standalone PVCs, the claim templates of StatefulSets, the access
// mode rules that are decidable on the canonical model, and the pure claim-shape arithmetic the
// apply engine runs against live PVCs before any mutation (7.4.1, K14).
//
// Data-safety invariants (7.4): no PVC carries ownerReferences; every claim names its storage
// class, so none binds to the distribution's default class; nothing here emits a
// PersistentVolume, a StorageClass or a Namespace, or sets a reclaim policy; a claim name depends
// on the compose key only; `P/volume` is the claim name on a standalone PVC and the template name
// on a claim template, which the controller's PVCs inherit (K40).

import type { StackRef } from '../../interfaces';
import { DeployError, ErrorCode } from '../../../../utils/errors';
import { ANNOTATIONS, LABELS, PARTS } from '../constants';
import { volumeClaimLabels } from '../labels';
import type { AccessMode, CanonicalService, CanonicalVolume } from '../model/types';
import { canonicalQuantity } from '../model/units';
import type { PersistentVolumeClaimTemplate } from '../resources/apps';
import type { PersistentVolumeClaim, PersistentVolumeClaimSpec } from '../resources/core';
import type { ObjectMeta } from '../resources/meta';
import type { ManifestObject } from '../resources/registry';
import { type ClaimTemplates, type TranslateContext, translatorBug } from './context';
import { reportTranslator } from './diagnostics';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Access modes whose claim a single node (RWO) or a single pod (RWOP) holds. */
function isExclusive(mode: AccessMode): boolean {
  return mode !== 'ReadWriteMany';
}

function volumeFor(key: string, ctx: TranslateContext, path: string): CanonicalVolume {
  const volume = ctx.volumes.get(key) ?? translatorBug(`${path} mounts volume ${key}, which the canonical stack does not define`);
  assertClaimable(volume);
  return volume;
}

/** The normalizer refuses per_replica on an external volume (design-01 X4): Dockflow cannot template a claim it does not own. */
function assertClaimable(volume: CanonicalVolume): void {
  if (volume.external && volume.perReplica) translatorBug(`External volume ${volume.key} reached the translator with per_replica: true`);
}

function claimSpec(volume: CanonicalVolume): PersistentVolumeClaimSpec {
  const storage = canonicalQuantity(volume.size) ?? translatorBug(`Volume ${volume.key} has size ${volume.size}, which is not a quantity`);
  return {
    accessModes: [volume.accessMode],
    resources: { requests: { storage } },
    storageClassName: volume.storageClass,
  };
}

function claimMetadata(volume: CanonicalVolume, ctx: TranslateContext): ObjectMeta {
  return {
    name: volume.name,
    annotations: { [ANNOTATIONS.composeVolume]: volume.key },
    labels: volumeClaimLabels(ctx.stack.identity, volume.role, volume.name, volume.labels),
  };
}

// ---------------------------------------------------------------------------
// Model checks (design-02 7.3, 4.4)
// ---------------------------------------------------------------------------

function checkVolume(volume: CanonicalVolume, ctx: TranslateContext): void {
  assertClaimable(volume);
  // An external claim is provisioned by its owner, so only Dockflow-provisioned claims are held to the trait.
  if (
    !volume.external &&
    volume.storageClass === ctx.traits.defaultStorageClass &&
    !ctx.traits.defaultStorageClassAccessModes.includes(volume.accessMode)
  ) {
    reportTranslator(ctx.sink, 'volumes.access-mode-unsupported', `${volume.path}.x-dockflow.access_mode`, {
      volume: volume.key,
      accessMode: volume.accessMode,
      storageClass: volume.storageClass,
    });
  }
  if (volume.usedBy.length < 2) return;
  const params = { volume: volume.key, services: volume.usedBy };
  // One code per condition: a claim template shared by two StatefulSets is its own error.
  if (volume.perReplica) {
    reportTranslator(ctx.sink, 'volumes.per-replica-shared', volume.path, params);
  } else if (volume.accessMode === 'ReadWriteOncePod') {
    reportTranslator(ctx.sink, 'volumes.rwop-shared', volume.path, params);
  } else if (volume.accessMode === 'ReadWriteOnce') {
    reportTranslator(ctx.sink, 'volumes.rwo-shared', volume.path, params);
  }
}

/**
 * A global service runs one pod per node, and only the pod on the node holding an RWO/RWOP claim
 * can start; external claims behave the same (K35). Per-replica volumes on a global service are
 * the normalizer's `extension.per-replica-kind`. One report per service, for its first such mount.
 */
function checkGlobalService(svc: CanonicalService, ctx: TranslateContext): void {
  if (svc.mode !== 'global') return;
  for (const mount of svc.mounts) {
    if (mount.type !== 'volume') continue;
    const volume = volumeFor(mount.volume, ctx, mount.path);
    if (volume.perReplica || !isExclusive(volume.accessMode)) continue;
    reportTranslator(ctx.sink, 'volumes.rwo-global', `${svc.path}.deploy.mode`, {
      service: svc.composeName,
      volume: volume.key,
      accessMode: volume.accessMode,
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Claims (design-02 7.1, 7.2, 4.3)
// ---------------------------------------------------------------------------

/**
 * One standalone PVC per volume that is neither external (pods reference the external name, no
 * object) nor per-replica (claim templates), after the render-wide access-mode checks.
 */
export function buildClaims(ctx: TranslateContext): PersistentVolumeClaim[] {
  for (const volume of ctx.stack.volumes) checkVolume(volume, ctx);
  for (const svc of ctx.stack.services) checkGlobalService(svc, ctx);
  return ctx.stack.volumes
    .filter((volume) => !volume.external && !volume.perReplica)
    .map((volume) => ({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { ...claimMetadata(volume, ctx), namespace: ctx.namespace },
      spec: claimSpec(volume),
    }));
}

/**
 * The `volumeClaimTemplates` of a StatefulSet service: one per mounted per-replica volume, named
 * after the volume's claim name and sorted by name. The controller creates
 * `<template>-<statefulset>-<ordinal>` claims carrying these labels. [] for every other kind.
 */
export function buildClaimTemplates(svc: CanonicalService, ctx: TranslateContext): ClaimTemplates {
  if (svc.workloadKind !== 'StatefulSet') return [];
  const templates = new Map<string, PersistentVolumeClaimTemplate>();
  for (const mount of svc.mounts) {
    if (mount.type !== 'volume') continue;
    const volume = volumeFor(mount.volume, ctx, mount.path);
    if (!volume.perReplica || templates.has(volume.name)) continue;
    templates.set(volume.name, { metadata: claimMetadata(volume, ctx), spec: claimSpec(volume) });
  }
  return [...templates.values()].sort((a, b) => compareCodeUnits(a.metadata.name, b.metadata.name));
}

// ---------------------------------------------------------------------------
// Claim shape and rebinding (design-02 7.4.1, K14)
// ---------------------------------------------------------------------------

/** Which claims the pods of a volume mount: one standalone claim, or one claim per StatefulSet ordinal. */
export type ClaimShape = { shape: 'shared'; claim: string } | { shape: 'per-replica'; template: string; statefulSet: string };

export interface ClaimShapeConflict {
  /** compose volume key */
  key: string;
  /** the live shape, whose claims hold the data */
  live: ClaimShape;
  /** the rendered shape, whose claims do not exist yet */
  rendered: ClaimShape;
  /** claim name(s) left behind, e.g. `postgres-data` or `postgres-data-db-<ordinal>` */
  from: string;
  /** claim name(s) the pods would mount */
  to: string;
  /** DeployError message: both claim names, generated names next to the compose key on purpose */
  message: string;
}

function claimNames(shape: ClaimShape): string {
  return shape.shape === 'shared' ? shape.claim : `${shape.template}-${shape.statefulSet}-<ordinal>`;
}

function sameShape(a: ClaimShape, b: ClaimShape): boolean {
  if (a.shape === 'shared') return b.shape === 'shared' && a.claim === b.claim;
  return b.shape === 'per-replica' && a.template === b.template && a.statefulSet === b.statefulSet;
}

function shapeOrder(shape: ClaimShape): string {
  return shape.shape === 'shared' ? `0 ${shape.claim}` : `1 ${shape.template} ${shape.statefulSet}`;
}

/** Shapes the render gives each compose volume key, read from `P/compose-volume` on PVCs and claim templates. */
export function renderedClaimShapes(objects: readonly ManifestObject[]): Map<string, ClaimShape> {
  const shapes = new Map<string, ClaimShape>();
  const record = (key: string | undefined, shape: ClaimShape): void => {
    if (key !== undefined && !shapes.has(key)) shapes.set(key, shape);
  };
  for (const object of objects) {
    if (object.kind === 'PersistentVolumeClaim') {
      record(object.metadata.annotations?.[ANNOTATIONS.composeVolume], { shape: 'shared', claim: object.metadata.name });
    } else if (object.kind === 'StatefulSet') {
      for (const template of object.spec.volumeClaimTemplates ?? []) {
        record(template.metadata.annotations?.[ANNOTATIONS.composeVolume], {
          shape: 'per-replica',
          template: template.metadata.name,
          statefulSet: object.metadata.name,
        });
      }
    }
  }
  return shapes;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shapes the live stack PVCs hold, per compose volume key: a claim named like its `P/volume` label
 * is shared; `<P/volume>-<statefulset>-<ordinal>` is per-replica (`(.+)` is greedy up to the last
 * `-<digits>`, so names containing `-` split correctly). Claims of other parts or without the
 * Dockflow metadata are not Dockflow's to compare.
 */
export function liveClaimShapes(pvcs: readonly PersistentVolumeClaim[]): Map<string, ClaimShape[]> {
  const shapes = new Map<string, ClaimShape[]>();
  for (const pvc of pvcs) {
    const found = liveShape(pvc);
    if (found === null) continue;
    const known = shapes.get(found.key) ?? [];
    if (!known.some((existing) => sameShape(existing, found.shape))) known.push(found.shape);
    shapes.set(found.key, known);
  }
  for (const list of shapes.values()) list.sort((a, b) => compareCodeUnits(shapeOrder(a), shapeOrder(b)));
  return shapes;
}

function liveShape(pvc: PersistentVolumeClaim): { key: string; shape: ClaimShape } | null {
  const labels = pvc.metadata.labels ?? {};
  const key = pvc.metadata.annotations?.[ANNOTATIONS.composeVolume];
  const volume = labels[LABELS.volume];
  if (labels[LABELS.part] !== PARTS.stack || key === undefined || volume === undefined) return null;
  const name = pvc.metadata.name;
  if (name === volume) return { key, shape: { shape: 'shared', claim: name } };
  const match = new RegExp(`^${escapeRegExp(volume)}-(.+)-(\\d+)$`).exec(name);
  return match === null ? null : { key, shape: { shape: 'per-replica', template: volume, statefulSet: match[1] } };
}

function conflictMessage(key: string, live: ClaimShape, rendered: ClaimShape): string {
  const fromClaims = live.shape === 'shared' ? `the claim ${claimNames(live)}` : `the per-replica claims ${claimNames(live)}`;
  const toClaims =
    rendered.shape === 'shared'
      ? `the new claim ${claimNames(rendered)}, which starts empty`
      : `the new per-replica claims ${claimNames(rendered)}, which start empty`;
  const kept = live.shape === 'shared' ? 'and its data are kept' : 'and their data are kept';
  return `Volume ${key} would move from ${fromClaims} to ${toClaims}; ${claimNames(live)} ${kept}`;
}

/**
 * Mounted volumes whose rendered claims do not exist yet while claims of another shape (or of
 * another StatefulSet) hold the volume's data: the pods would come back on empty storage. A key
 * without live claims is a first deploy; a key whose rendered claims already exist passes, so the
 * claims a `--rebind-volumes` deploy left behind never block later deploys. External volumes have
 * no rendered claim and are never compared.
 */
export function claimShapeConflicts(rendered: Map<string, ClaimShape>, live: Map<string, ClaimShape[]>): ClaimShapeConflict[] {
  const conflicts: ClaimShapeConflict[] = [];
  for (const key of [...rendered.keys()].sort(compareCodeUnits)) {
    const target = rendered.get(key);
    const existing = live.get(key) ?? [];
    if (target === undefined || existing.length === 0 || existing.some((shape) => sameShape(shape, target))) continue;
    const from = existing[0];
    conflicts.push({ key, live: from, rendered: target, from: claimNames(from), to: claimNames(target), message: conflictMessage(key, from, target) });
  }
  return conflicts;
}

function conflictCause(conflict: ClaimShapeConflict): string {
  if (conflict.live.shape === 'shared') return 'the x-dockflow.per_replica change';
  if (conflict.rendered.shape === 'shared') return 'the x-dockflow.per_replica, x-dockflow.kind or deploy.mode change';
  return `the rename of the service that ran StatefulSet ${conflict.live.statefulSet}`;
}

/** Suggestion of the refusal: undo the key that caused it, or accept the new claims for this deploy only. */
export function claimShapeSuggestion(conflict: ClaimShapeConflict, target: Pick<StackRef, 'env' | 'role'>): string {
  const deploy = target.role === 'accessory' ? `dockflow accessories deploy ${target.env}` : `dockflow deploy ${target.env}`;
  return (
    `Revert ${conflictCause(conflict)} to keep using ${conflict.from}, or run \`${deploy} --rebind-volumes\` ` +
    `and copy the data across (\`dockflow volumes list ${target.env}\` shows both claims).`
  );
}

/** The refusal `engine.checkVolumes` throws before any mutation when the deploy does not pass `--rebind-volumes`. */
export function claimShapeError(conflict: ClaimShapeConflict, target: Pick<StackRef, 'env' | 'role'>): DeployError {
  return new DeployError(conflict.message, ErrorCode.DEPLOY_FAILED, claimShapeSuggestion(conflict, target));
}

/** The line a `--rebind-volumes` deploy prints per rebound volume: nothing is deleted, the old claims stay listed. */
export function claimShapeRebindNotice(conflict: ClaimShapeConflict): string {
  const verb = conflict.live.shape === 'shared' ? 'is' : 'are';
  return `Volume ${conflict.key} now uses ${conflict.to}; ${conflict.from} ${verb} kept and listed by dockflow volumes list`;
}
