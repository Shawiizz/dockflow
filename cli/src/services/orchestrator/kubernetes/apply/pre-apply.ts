// Pure planners of the pre-apply checks (design-03 5.4.3-5.4.5): workload kind switches (K15), the
// Job rules under server-side apply (K43) and the foreign-ownership classification (K74). The
// engine performs the reads and the deletes they plan; refusals are thrown here, before anything
// is mutated. One signature serves deploy() (facts from the canonical stack) and apply() (facts
// rebuilt from stored objects).
// Pure: no I/O, no clock.

import { DeployError, ErrorCode } from '../../../../utils/errors';
import type { StackRef, WorkloadKind } from '../../interfaces';
import {
  ANNOTATIONS,
  K8S_FIELD_MANAGER,
  K8S_FIELD_MANAGER_ACCESSORIES_STATE,
  K8S_FIELD_MANAGER_RELEASE_STATE,
  K8S_MANAGED_BY,
  LABELS,
} from '../constants';
import type { CanonicalService, CanonicalStack } from '../model/types';
import type { ObjectMeta } from '../resources/meta';
import { isManifestKind, KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import type { LiveObjectRef } from './prune-plan';
import {
  compareCodeUnits,
  composeServiceOf,
  isWorkload,
  type LiveWorkload,
  podSpecOf,
  type Snapshot,
  type WorkloadObject,
} from './snapshot';

// ---------------------------------------------------------------------------
// Kind switches (5.4.3, K15)
// ---------------------------------------------------------------------------

/** Per-service facts the switch rules need, about the definition being applied. */
export interface SwitchFacts {
  /** standalone claim names mounted + claim-template names (the "base" names), sorted */
  claimBases(service: string): string[];
  /** mounts any PVC, publishes a host port (host-mode `ports`, `x-dockflow.publish: hostport`) or uses hostNetwork */
  exclusive(service: string): boolean;
}

/** A live workload deleted (foreground, waited) before the apply, and what replaces it. */
export interface KindReplacement extends LiveObjectRef {
  kind: WorkloadKind;
  service: string;
  to: { kind: WorkloadKind; name: string };
}

export interface KindOverlap {
  service: string;
  from: WorkloadKind;
  to: WorkloadKind;
}

export interface KindSwitchPlan {
  /** old workloads to delete (foreground, waited) before the apply */
  replace: KindReplacement[];
  /** compose names whose switch is only an overlap, not a conflict */
  overlap: KindOverlap[];
}

/** A service whose live workload the deploy deleted before the apply (kind switch, failed Job). */
export interface DisruptiveSwitch {
  service: string;
  /** null when the old object was a Job recreated under the same name */
  from: WorkloadKind | null;
  to: WorkloadKind;
  /** live object that was deleted */
  deleted: { kind: WorkloadKind; name: string };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function bindsHostPort(service: CanonicalService): boolean {
  return service.ports.some((p) => p.published !== null && (p.mode === 'host' || service.extension.publish === 'hostport'));
}

/** deploy(): facts of the canonical stack being rendered. */
export function factsFromStack(stack: CanonicalStack): SwitchFacts {
  const services = new Map(stack.services.map((s) => [s.composeName, s]));
  const claimNames = new Map(stack.volumes.map((v) => [v.key, v.name]));
  const claimBases = (name: string): string[] => {
    const names: string[] = [];
    for (const mount of services.get(name)?.mounts ?? []) {
      const claim = mount.type === 'volume' ? claimNames.get(mount.volume) : undefined;
      if (claim !== undefined) names.push(claim);
    }
    return sortedUnique(names);
  };
  return {
    claimBases,
    exclusive: (name) => {
      const service = services.get(name);
      if (!service) return false;
      return service.mounts.some((m) => m.type === 'volume') || service.network.hostNetwork || bindsHostPort(service);
    },
  };
}

function objectClaimBases(workload: WorkloadObject): string[] {
  const spec = podSpecOf(workload);
  const claims = (spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : []));
  const templates = workload.kind === 'StatefulSet' ? (workload.spec.volumeClaimTemplates ?? []).map((t) => t.metadata.name) : [];
  return sortedUnique([...claims, ...templates]);
}

function objectExclusive(workload: WorkloadObject): boolean {
  const spec = podSpecOf(workload);
  const containers = [...spec.containers, ...(spec.initContainers ?? [])];
  return (
    objectClaimBases(workload).length > 0 ||
    spec.hostNetwork === true ||
    containers.some((c) => (c.ports ?? []).some((p) => p.hostPort !== undefined))
  );
}

/** apply(): the same facts rebuilt from stored objects, which carry no canonical stack (16.2). */
export function factsFromObjects(objects: readonly ManifestObject[]): SwitchFacts {
  const workloads = new Map<string, WorkloadObject[]>();
  for (const o of objects.filter(isWorkload)) {
    const service = composeServiceOf(o);
    if (service === null) continue;
    workloads.set(service, [...(workloads.get(service) ?? []), o]);
  }
  return {
    claimBases: (name) => sortedUnique((workloads.get(name) ?? []).flatMap(objectClaimBases)),
    exclusive: (name) => (workloads.get(name) ?? []).some(objectExclusive),
  };
}

function strandedClaimError(service: string, from: WorkloadKind, to: WorkloadKind, claims: string[], ref: StackRef): DeployError {
  const volumes = claims.length === 1 ? `volume ${claims[0]}` : `volumes ${claims.join(', ')}`;
  return new DeployError(
    `Service ${service} changes from ${from} to ${to} and would stop using ${volumes}, whose data is kept but no longer mounted`,
    ErrorCode.DEPLOY_FAILED,
    `Keep the volume in the new definition, or move the data and remove it with \`dockflow volumes rm ${ref.env} ${claims[0]}\`.`,
  );
}

function runningJobSwitchError(service: string, to: WorkloadKind, ref: StackRef): DeployError {
  return new DeployError(
    `Service ${service} changes from Job to ${to} while its job is still running`,
    ErrorCode.DEPLOY_FAILED,
    `Wait for it to finish (\`dockflow ps ${ref.env}\`), then deploy again.`,
  );
}

/**
 * Live workloads of another kind carrying the same compose service as an applied workload. A
 * switch that would strand a claim, or leave an active Job, is refused; otherwise the old workload
 * is deleted first when the two cannot coexist (an exclusive resource, or a Job on either side) and
 * overlaps until finalize prunes it when they can. Job -> Job under another name is not a switch:
 * Jobs are content-named (5.4.4).
 */
export function planKindSwitches(
  applied: readonly ManifestObject[],
  before: Snapshot,
  facts: SwitchFacts,
  ref: StackRef,
): KindSwitchPlan {
  const plan: KindSwitchPlan = { replace: [], overlap: [] };
  for (const workload of applied.filter(isWorkload)) {
    const service = composeServiceOf(workload);
    if (service === null) continue;
    for (const old of before.workloads.filter((l) => l.service === service && l.kind !== workload.kind)) {
      // compared by BASE claim name, so a volume still mounted under the other claim shape is the
      // claim-shape rule's case (5.4.2, K14), never this one
      const newBases = new Set(facts.claimBases(service));
      const stranded = sortedUnique([...old.refs.claims, ...old.claimTemplates.map((t) => t.name)]).filter((c) => !newBases.has(c));
      if (stranded.length > 0) throw strandedClaimError(service, old.kind, workload.kind, stranded, ref);
      if (old.kind === 'Job' && (old.job?.active ?? 0) > 0) throw runningJobSwitchError(service, workload.kind, ref);

      if (facts.exclusive(service) || old.kind === 'Job' || workload.kind === 'Job') {
        plan.replace.push({
          kind: old.kind,
          name: old.name,
          service,
          to: { kind: workload.kind, name: workload.metadata.name },
        });
      } else {
        plan.overlap.push({ service, from: old.kind, to: workload.kind });
      }
    }
  }
  plan.replace.sort((a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.name, b.name));
  plan.overlap.sort((a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.from, b.from));
  return plan;
}

// ---------------------------------------------------------------------------
// Jobs (5.4.4, K43)
// ---------------------------------------------------------------------------

function liveJob(before: Snapshot, name: string): LiveWorkload | undefined {
  return before.workloads.find((w) => w.kind === 'Job' && w.name === name);
}

/** Live Jobs with a rendered name whose run failed: deleted (foreground) and applied again. */
export function planJobRecreations(applied: readonly ManifestObject[], before: Snapshot): LiveObjectRef[] {
  const out: LiveObjectRef[] = [];
  for (const o of applied) {
    if (o.kind !== 'Job') continue;
    const live = liveJob(before, o.metadata.name);
    if (live?.job?.finished === 'failed') out.push({ kind: 'Job', name: live.name, service: live.service });
  }
  return out.sort((a, b) => compareCodeUnits(a.name, b.name));
}

/**
 * Removes every Job that already exists and is not being recreated. A Job's name is the checksum
 * of its whole spec, so an existing one already has the rendered spec, and re-applying it under
 * server-side apply fails on the generated selector (kubernetes#118645). Objects are passed through
 * untouched: no selector and no `manualSelector` is ever added.
 */
export function dropUnchangedJobs(
  objects: readonly ManifestObject[],
  before: Snapshot,
  recreate: readonly LiveObjectRef[],
): ManifestObject[] {
  const recreated = new Set(recreate.filter((r) => r.kind === 'Job').map((r) => r.name));
  return objects.filter((o) => o.kind !== 'Job' || recreated.has(o.metadata.name) || !liveJob(before, o.metadata.name));
}

/** Applied Jobs whose live namesake is still running: left alone and not waited on (warning of 5.4.4). */
export function runningJobs(applied: readonly ManifestObject[], before: Snapshot): LiveWorkload[] {
  const out: LiveWorkload[] = [];
  for (const o of applied) {
    if (o.kind !== 'Job') continue;
    const live = liveJob(before, o.metadata.name);
    if (live?.job && live.job.finished === null && live.job.active > 0) out.push(live);
  }
  return out.sort((a, b) => compareCodeUnits(a.name, b.name));
}

/** `ReceiptState.disruptive` of a deploy or apply: kind replacements and re-run Jobs. */
export function describeSwitches(switches: KindSwitchPlan, staleJobs: readonly LiveObjectRef[]): DisruptiveSwitch[] {
  const out: DisruptiveSwitch[] = switches.replace.map((r) => ({
    service: r.service,
    from: r.kind,
    to: r.to.kind,
    deleted: { kind: r.kind, name: r.name },
  }));
  for (const job of staleJobs) {
    out.push({ service: job.service ?? job.name, from: null, to: 'Job', deleted: { kind: 'Job', name: job.name } });
  }
  return out.sort((a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.deleted.name, b.deleted.name));
}

// ---------------------------------------------------------------------------
// Foreign ownership (5.4.5, K74)
// ---------------------------------------------------------------------------

/** The field managers Dockflow writes with (design-03 section 0). */
export const DOCKFLOW_FIELD_MANAGERS: readonly string[] = [
  K8S_FIELD_MANAGER,
  K8S_FIELD_MANAGER_RELEASE_STATE,
  K8S_FIELD_MANAGER_ACCESSORIES_STATE,
];

/** Managers that may write to a Dockflow object without making it foreign (`dockflow restart`, legacy kubectl). */
const TOLERATED_FIELD_MANAGERS: readonly string[] = [...DOCKFLOW_FIELD_MANAGERS, 'kubectl-rollout', 'kubectl-client-side-apply'];

export type Ownership = { foreign: false } | { foreign: true; manager: string };

/**
 * An existing object is foreign when its `app.kubernetes.io/managed-by` label names someone else,
 * or when another field manager wrote to it and Dockflow never did. An object Dockflow already
 * owns is not foreign, whatever else wrote to it. Needs `--show-managed-fields` (K49).
 */
export function classifyOwnership(metadata: ObjectMeta): Ownership {
  const managers = (metadata.managedFields ?? []).flatMap((f) => (f.manager ? [f.manager] : []));
  const other = managers.find((m) => !TOLERATED_FIELD_MANAGERS.includes(m));
  const label = metadata.labels?.[LABELS.managedBy];
  if (label !== undefined && label !== K8S_MANAGED_BY) return { foreign: true, manager: other ?? label };
  if (other !== undefined && !managers.some((m) => DOCKFLOW_FIELD_MANAGERS.includes(m))) return { foreign: true, manager: other };
  return { foreign: false };
}

export interface ForeignObject {
  kind: string;
  name: string;
  manager: string;
  /** who would take it over, as the user knows it: `service web`, `volume pgdata`, or `this deploy` */
  claimant: string;
}

function claimantOf(object: ManifestObject): string {
  const service = composeServiceOf(object);
  if (service !== null) return `service ${service}`;
  const volume = object.metadata.annotations?.[ANNOTATIONS.composeVolume];
  return volume !== undefined ? `volume ${volume}` : 'this deploy';
}

/** Objects of `toApply` that K49 found and that someone else owns, in emission order. */
export function foreignObjects(
  toApply: readonly ManifestObject[],
  live: readonly { kind: string; metadata: ObjectMeta }[],
): ForeignObject[] {
  const out: ForeignObject[] = [];
  for (const object of toApply) {
    const found = live.find((l) => l.kind === object.kind && l.metadata.name === object.metadata.name);
    if (!found) continue;
    const ownership = classifyOwnership(found.metadata);
    if (ownership.foreign) {
      out.push({ kind: object.kind, name: object.metadata.name, manager: ownership.manager, claimant: claimantOf(object) });
    }
  }
  const rank = (kind: string) => (isManifestKind(kind) ? KIND_REGISTRY[kind].rank : Number.MAX_SAFE_INTEGER);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind) || compareCodeUnits(a.name, b.name));
}

export function foreignOwnerError(object: ForeignObject, namespace: string): DeployError {
  return new DeployError(
    `${object.kind} ${object.name} in namespace ${namespace} is owned by ${object.manager} and would be taken over by ${object.claimant}`,
    ErrorCode.DEPLOY_FAILED,
    'Rename the service, or move the Helm release that creates it to its own namespace with `helm.releases[].namespace`.',
  );
}
