// Prune execution of a full deploy's `finalize()` (design-03 8.4, DESIGN-CORE C11, C12): the ordered
// deletes of live objects absent from the render, the orphan PVC and kept-Job warnings, and the
// hashed-object GC that runs after the deploy converged. The pure plan comes from prune-plan.ts;
// this module performs the K09/K15/K16/K17 reads and the K18-K20 deletes design-03 8.4 spells out.
// Both steps are independently guarded (never throws, C11/C12's "finalize never throws" extends to
// its own two sub-steps): a failed read or delete is reported through `notices.warn` and the other
// step still runs, so a forbidden prune read never blocks the hashed-object GC or vice versa.

import type { StackRef, StackRole } from '../../interfaces';
import { deleteWaitS } from '../constants';
import { SEL_HASHED, SEL_ROLE } from '../labels';
import type { PersistentVolumeClaim } from '../resources/core';
import { KIND_REGISTRY, type ManifestKind, type ManifestObject } from '../resources/registry';
import type { KubeExecutor } from '../runtime/kubectl';
import type { ApplyEngine } from './engine';
import {
  collectReferences,
  type HashedRef,
  type LiveItem,
  type LiveObjectRef,
  parseHashedNames,
  planPrune,
  type ReferenceItem,
  toLiveRefs,
  toPvcRefs,
} from './prune-plan';
import { claimTemplatesOf, isWorkloadKind } from './snapshot';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Backends never print (DESIGN-CORE 1.1): the two prune steps reach the CLI through this. */
export interface PruneNotices {
  /** "Pruned N object(s) no longer in docker-compose.yml: ..." */
  info(message: string): void;
  /** kept Job, orphan PVC, and step-failure warnings */
  warn(message: string): void;
}

const SILENT: PruneNotices = { info: () => {}, warn: () => {} };

export interface PruneDeps {
  kubectl: KubeExecutor;
  /** only `snapshot` is used: grace periods and live StatefulSet claim templates for the plan */
  engine: Pick<ApplyEngine, 'snapshot'>;
  /** default: silent */
  notices?: PruneNotices;
}

export interface PruneRequest {
  ref: StackRef;
  namespace: string;
  /** full render (or full stored artifact) of the role */
  rendered: readonly ManifestObject[];
  /** the bundle's cached CRD probe (`SharedMemo.crds`), resolved by the caller */
  routes: boolean;
}

export interface PruneOutcome {
  deleted: LiveObjectRef[];
  deletedHashed: HashedRef[];
  keptJobs: LiveObjectRef[];
  orphanPvcs: { name: string; volume: string | null }[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const PRUNE_KINDS: readonly ManifestKind[] = ['Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job'];
const PRUNE_ROUTE_KINDS: readonly ManifestKind[] = ['Middleware', 'IngressRoute'];

/** design-03 8.4: services,deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch, plus the traefik kinds when the CRDs exist. */
export function pruneKinds(routes: boolean): string[] {
  const kinds = routes ? [...PRUNE_KINDS, ...PRUNE_ROUTE_KINDS] : PRUNE_KINDS;
  return kinds.map((kind) => KIND_REGISTRY[kind].resource);
}

/** every object a pod template can still reference and bring back an older revision (design-03 8.3) */
const REFERENCE_KINDS: readonly string[] = [
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'replicasets.apps',
  'controllerrevisions.apps',
];

function resourceSlashName(ref: LiveObjectRef | HashedRef): string {
  return `${KIND_REGISTRY[ref.kind].resource}/${ref.name}`;
}

function kindSlashName(ref: LiveObjectRef): string {
  return `${ref.kind.toLowerCase()}/${ref.name}`;
}

/** docker-compose.yml / accessories.yml, as the messages of design-03 8.4 name the source file. */
function fileOf(role: StackRole): string {
  return role === 'app' ? 'docker-compose.yml' : 'accessories.yml';
}

/**
 * The single delete ordering of design-03 8.4: routes with `--wait=false` first (traffic stops
 * before pods go away), then workloads with `--cascade=foreground --wait=true` and the derived
 * delete budget, then Services `--wait=false`. Shared by `revert.ts` (`plan.remove`).
 */
export async function executeDeletes(
  kubectl: KubeExecutor,
  namespace: string,
  refs: readonly LiveObjectRef[],
  waitS: number,
): Promise<void> {
  const routes = refs.filter((r) => r.kind === 'IngressRoute' || r.kind === 'Middleware');
  const workloads = refs.filter((r) => isWorkloadKind(r.kind));
  const services = refs.filter((r) => r.kind === 'Service');
  if (routes.length > 0) {
    await kubectl.delete(routes.map(resourceSlashName), { namespace, wait: false, ignoreNotFound: true });
  }
  if (workloads.length > 0) {
    await kubectl.delete(workloads.map(resourceSlashName), {
      namespace,
      wait: true,
      timeoutS: waitS,
      ignoreNotFound: true,
      cascade: 'foreground',
    });
  }
  if (services.length > 0) {
    await kubectl.delete(services.map(resourceSlashName), { namespace, wait: false, ignoreNotFound: true });
  }
}

// ---------------------------------------------------------------------------
// The two finalize() steps
// ---------------------------------------------------------------------------

/** K17 + K07 + K09, `planPrune`, the ordered deletes and the kept-Job / orphan-PVC warnings. */
async function pruneObjects(
  deps: PruneDeps,
  request: PruneRequest,
): Promise<Pick<PruneOutcome, 'deleted' | 'keptJobs' | 'orphanPvcs'>> {
  const { kubectl, engine, notices = SILENT } = deps;
  const { namespace, ref } = request;
  const selector = SEL_ROLE(namespace, ref.role);
  const liveItems = await kubectl.getJson<LiveItem>(pruneKinds(request.routes), { namespace, selector });
  const live = toLiveRefs(liveItems, ref.role);
  const now = await engine.snapshot(namespace, ref.role);
  const pvcs = await kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace, selector });

  const plan = planPrune({
    rendered: [...request.rendered],
    live,
    liveHashed: [],
    references: new Set(),
    livePvcs: toPvcRefs(pvcs),
    liveStatefulSets: claimTemplatesOf(now),
  });

  await executeDeletes(kubectl, namespace, plan.delete, deleteWaitS(now.workloads));
  if (plan.delete.length > 0) {
    notices.info(`Pruned ${plan.delete.length} object(s) no longer in ${fileOf(ref.role)}: ${plan.delete.map(kindSlashName).join(', ')}`);
  }
  for (const job of plan.keptJobs) {
    notices.warn(`Job ${job.service ?? job.name} (job/${job.name}) is still running and was not removed; it is no longer in ${fileOf(ref.role)}`);
  }
  for (const p of plan.orphanPvcs) {
    notices.warn(
      `Volume data kept: persistentvolumeclaim/${p.name} is no longer used by ${fileOf(ref.role)}; delete it (and its data) with: dockflow volumes rm ${ref.env} ${p.volume ?? p.name}`,
    );
  }
  return { deleted: plan.delete, keptJobs: plan.keptJobs, orphanPvcs: plan.orphanPvcs };
}

/** K15 + K16, `planPrune` restricted to the hashed set, and the K20 delete (design-03 8.4 second half). */
async function garbageCollectHashed(deps: PruneDeps, request: PruneRequest): Promise<HashedRef[]> {
  const { kubectl } = deps;
  const { namespace, ref } = request;
  const out = await kubectl.run({ args: ['get', 'secrets,configmaps', '-l', SEL_HASHED(namespace, ref.role), '-o', 'name'], namespace, mutating: false });
  const refItems = await kubectl.getJson<ReferenceItem>([...REFERENCE_KINDS], { namespace });
  const plan = planPrune({
    rendered: [...request.rendered],
    live: [],
    liveHashed: parseHashedNames(out.stdout),
    references: collectReferences(refItems),
    livePvcs: [],
    liveStatefulSets: [],
  });
  if (plan.deleteHashed.length > 0) {
    await kubectl.delete(plan.deleteHashed.map(resourceSlashName), { namespace, wait: false, ignoreNotFound: true });
  }
  return plan.deleteHashed;
}

function stepFailureText(step: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Cleanup after deploy failed (${step}): ${message}; the deploy itself succeeded`;
}

/**
 * Both finalize() prune steps (design-03 8.4), each wrapped so the other always runs: a forbidden
 * read or delete becomes a warning through `notices.warn` instead of failing the deploy, which
 * already succeeded by the time `finalize()` runs.
 */
export async function prune(deps: PruneDeps, request: PruneRequest): Promise<PruneOutcome> {
  const notices = deps.notices ?? SILENT;
  let deleted: LiveObjectRef[] = [];
  let keptJobs: LiveObjectRef[] = [];
  let orphanPvcs: { name: string; volume: string | null }[] = [];
  try {
    ({ deleted, keptJobs, orphanPvcs } = await pruneObjects(deps, request));
  } catch (error) {
    notices.warn(stepFailureText('prune', error));
  }

  let deletedHashed: HashedRef[] = [];
  try {
    deletedHashed = await garbageCollectHashed(deps, request);
  } catch (error) {
    notices.warn(stepFailureText('hashed objects', error));
  }

  return { deleted, deletedHashed, keptJobs, orphanPvcs };
}
