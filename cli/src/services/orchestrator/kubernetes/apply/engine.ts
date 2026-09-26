// Apply engine (design-03 5.1-5.9): the stack namespace and its ownership guard, role snapshots,
// the pre-apply checks that run before any mutation, server dry-run and server-side apply over
// stdin, the deletes a kind switch or a failed Job needs, the partial-apply path and change
// detection. The pure planners live in pre-apply.ts, prune-plan.ts and snapshot.ts; this module
// performs the reads and writes they plan. kubectl failures surface as KubeError (callers map them
// with their own operation and code); the engine's own refusals are DeployErrors. Nothing here
// prints: progress and warnings go to the injected ApplyEventSink.

import { DeployError, ErrorCode } from '../../../../utils/errors';
import type { RevertResult, StackDeployInput, StackRef, StackRole, WorkloadChange } from '../../interfaces';
import { ANNOTATIONS, deleteWaitS, K8S_MANAGED_BY, KUBE_KEYS, LABELS } from '../constants';
import { type Clock, memoize, type SharedMemo } from '../deps';
import type { K8sDistribution } from '../distribution';
import { SEL_POD, SEL_ROLE } from '../labels';
import { canonicalQuantity, parseQuantity } from '../model/units';
import { namespaceFor } from '../naming';
import type { ControllerRevision } from '../resources/apps';
import type { Namespace, PersistentVolumeClaim, Pod } from '../resources/core';
import type { ObjectMeta } from '../resources/meta';
import { KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import type { StorageClass } from '../resources/storage';
import { KubeError, kubeErrorToCliError } from '../runtime/errors';
import { type KubeExecutor, parseJsonItems } from '../runtime/kubectl';
import { namespaceObject } from '../translate/namespace';
import {
  claimShapeConflicts,
  claimShapeError,
  claimShapeRebindNotice,
  liveClaimShapes,
  renderedClaimShapes,
} from '../translate/storage';
import { type ArtifactHeader, emitManifests, emitObject } from '../yaml';
import {
  type DisruptiveSwitch,
  describeSwitches,
  dropUnchangedJobs,
  factsFromObjects,
  foreignObjects,
  foreignOwnerError,
  type KindSwitchPlan,
  planJobRecreations,
  planKindSwitches,
  runningJobs,
  type SwitchFacts,
} from './pre-apply';
import { type LiveObjectRef, pruneGuard } from './prune-plan';
import {
  compareCodeUnits,
  composeServiceOf,
  diffSnapshots,
  type LbWatchTarget,
  type LiveService,
  type Snapshot,
  type SnapshotItem,
  toSnapshot,
} from './snapshot';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Where the engine reports progress; a HelmEventSink fits. The CLI decides how to print it. */
export interface ApplyEventSink {
  /** replacements, re-run Jobs, re-created Services */
  step(text: string): void;
  warn(message: string): void;
}

const SILENT: ApplyEventSink = { step: () => {}, warn: () => {} };

export interface ApplyEngineDeps {
  /** bound to the control plane of the bundle */
  kubectl: KubeExecutor;
  /** stamps the snapshots */
  clock: Clock;
  distribution: K8sDistribution;
  /** per-bundle memo: one namespace ensure per namespace */
  memo: SharedMemo;
  /** default: silent */
  events?: ApplyEventSink;
}

/** `deploy` checks every volume change; `restore` (revert, rollback) never re-applies an existing PVC. */
export type VolumeCheckMode = 'deploy' | 'restore';

export interface ApplyRequest {
  ref: StackRef;
  /** version the objects belong to; written in the manifest header */
  version: string;
  /** the full render of the role, or the full stored artifact */
  objects: readonly ManifestObject[];
  /** what this call sends: the closure under `--only` or `rollback <service>`; default `objects` */
  applied?: readonly ManifestObject[];
  /** facts of the definition being applied (`factsFromStack` in deploy); default `factsFromObjects(objects)` */
  facts?: SwitchFacts;
  mode: VolumeCheckMode;
  /** a full deploy of the role (no `--only`): runs the zero-workload prune guard (C11) */
  full: boolean;
  /** `--rebind-volumes`: accept a claim-shape change for this deploy only (K14) */
  rebindVolumes?: boolean;
  /** the snapshot the caller already read (accessory change detection); read here when absent */
  before?: Snapshot;
}

/** Every check passed and the server dry-run accepted `toApply`; nothing was mutated but the namespace. */
export interface PreparedApply {
  ref: StackRef;
  namespace: string;
  header: ArtifactHeader;
  before: Snapshot;
  /** sent by the apply: existing PVCs dropped in restore mode, existing Jobs dropped unless re-run */
  toApply: ManifestObject[];
  switches: KindSwitchPlan;
  /** failed Jobs deleted and re-applied under the same name (K43) */
  staleJobs: LiveObjectRef[];
  /** `ReceiptState.disruptive` */
  disruptive: DisruptiveSwitch[];
  /** Services whose clusterIP shape changes: deleted right before the apply (5.5) */
  recreate: string[];
}

/** What a failed apply (after a successful dry-run) left, for the revert of 5.8. */
export interface PartialApply {
  before: Snapshot;
  /** best effort: `before` when the snapshot itself failed */
  after: Snapshot;
  toApply: ManifestObject[];
  changes: WorkloadChange[];
  disruptive: DisruptiveSwitch[];
  error: unknown;
}

export interface ExecuteOptions {
  onApplyProgress?: StackDeployInput['onApplyProgress'];
  /** reverts what a failed apply left (5.8); absent, the apply error is rethrown as is (rollbacks) */
  revert?: (partial: PartialApply) => Promise<RevertResult>;
}

export interface ApplyOutcome {
  before: Snapshot;
  after: Snapshot;
  /** what the apply sent */
  applied: ManifestObject[];
  changes: WorkloadChange[];
  /** `-lb` Services convergence must see bound (K19) */
  lbWatch: LbWatchTarget[];
  disruptive: DisruptiveSwitch[];
}

/** K07: the role's workloads and Services in one read (R5) */
export const SNAPSHOT_RESOURCES: readonly string[] = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'services',
];

/** margin between a waiting call's own --timeout and its local guard (design-03 20: wait+30) */
const WAIT_GUARD_MARGIN_S = 30;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sameSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = unique(a ?? []);
  const right = unique(b ?? []);
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function isClaim(object: ManifestObject): object is PersistentVolumeClaim {
  return object.kind === 'PersistentVolumeClaim';
}

/** sign of `a - b` for two quantities; 0 when either is not a quantity (the API server decides) */
export function compareQuantities(a: string, b: string): number {
  const x = parseQuantity(a);
  const y = parseQuantity(b);
  if (x === null || y === null) return 0;
  const scale = Math.min(x.scale, y.scale);
  const value = (q: NonNullable<typeof x>): bigint => (q.negative ? -1n : 1n) * q.mantissa * 10n ** BigInt(q.scale - scale);
  const left = value(x);
  const right = value(y);
  return left > right ? 1 : left < right ? -1 : 0;
}

/**
 * The zero-workload guard (C11, design-03 5.4.1), evaluated before any mutation: a full deploy
 * whose render has no workload would otherwise prune every live workload of the role in finalize.
 */
export function assertPruneGuard(
  rendered: readonly ManifestObject[],
  before: Snapshot,
  namespace: string,
  ref: Pick<StackRef, 'env' | 'role'>,
): void {
  const guard = pruneGuard(rendered, before);
  if (!guard.refuse) return;
  const remove = ref.role === 'accessory' ? `dockflow accessories remove ${ref.env}` : `dockflow stop ${ref.env}`;
  throw new DeployError(
    `Refusing to prune: the rendered stack has no services but ${guard.liveWorkloads} workloads run in ${namespace}`,
    ErrorCode.DEPLOY_FAILED,
    `Remove them with \`${remove}\`, then deploy again.`,
  );
}

/**
 * Claim templates are immutable once their StatefulSet exists, and the per-replica claims they
 * produced are not in the render, so the standalone checks cannot see them (core K29): a changed
 * class, access-mode set or size of a live template is refused before any mutation.
 */
export function checkClaimTemplates(objects: readonly ManifestObject[], before: Snapshot, ref: Pick<StackRef, 'env'>): void {
  for (const object of objects) {
    if (object.kind !== 'StatefulSet') continue;
    const live = before.workloads.find((w) => w.kind === 'StatefulSet' && w.name === object.metadata.name);
    if (!live) continue;
    for (const template of object.spec.volumeClaimTemplates ?? []) {
      const current = live.claimTemplates.find((t) => t.name === template.metadata.name);
      if (!current) continue;
      const requested = template.spec.resources.requests.storage;
      const storage = canonicalQuantity(requested) ?? requested;
      if (
        (template.spec.storageClassName ?? null) === current.storageClassName &&
        sameSet(template.spec.accessModes, current.accessModes) &&
        storage === current.storage
      ) {
        continue;
      }
      const key = template.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? current.volumeKey ?? template.metadata.name;
      throw new DeployError(
        `Volume ${key} cannot change size, storage class or access mode after creation; its data is kept`,
        ErrorCode.DEPLOY_FAILED,
        `Create a new volume and copy the data, or remove this one with \`dockflow volumes rm ${ref.env} ${template.metadata.name}-${object.metadata.name}-<ordinal>\` after taking a backup.`,
      );
    }
  }
}

/** Same published (port, protocol) pairs, whatever the order. */
export function samePorts(a: readonly LiveService['ports'][number][], b: readonly LiveService['ports'][number][]): boolean {
  return sameSet(
    a.map((p) => `${p.port}/${p.protocol}`),
    b.map((p) => `${p.port}/${p.protocol}`),
  );
}

/**
 * `-lb` Services convergence waits on (design-03 5.9, K19): created by this apply, with changed
 * published ports, or still without `status.loadBalancer.ingress`, so a retry of a failed deploy
 * reports the same problem instead of silently succeeding.
 */
export function planLbWatch(applied: readonly ManifestObject[], before: Snapshot, after: Snapshot): LbWatchTarget[] {
  const out: LbWatchTarget[] = [];
  for (const object of applied) {
    if (object.kind !== 'Service' || object.spec.type !== 'LoadBalancer') continue;
    const was = before.services.find((s) => s.name === object.metadata.name);
    const now = after.services.find((s) => s.name === object.metadata.name);
    if (!now) continue;
    const changed = !was || !samePorts(was.ports, now.ports);
    if (!changed && now.hasIngress) continue;
    out.push({
      service: composeServiceOf(object) ?? now.service,
      name: now.name,
      ports: now.ports.map(({ port, protocol }) => ({ port, protocol })),
    });
  }
  return out.sort((a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.name, b.name));
}

const CLUSTER_IP_FLIP = /Service "([^"]+)" is invalid: spec\.clusterIPs?(?:\[\d+\])?: .*(?:may not change once set|field is immutable)/;

/**
 * Services of `objects` an apply refused only because their clusterIP shape flips between `None`
 * and an allocated address (core K29). Empty when the failure holds anything else: re-creating
 * Services would not fix it.
 */
export function clusterIpFlips(error: unknown, objects: readonly ManifestObject[]): string[] {
  if (!(error instanceof KubeError) || error.reason !== 'Immutable') return [];
  const services = new Set(objects.filter((o) => o.kind === 'Service').map((o) => o.metadata.name));
  const names: string[] = [];
  for (const line of error.stderr.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = CLUSTER_IP_FLIP.exec(line);
    if (!match || !services.has(match[1])) return [];
    names.push(match[1]);
  }
  return unique(names);
}

function applyFailureDetail(error: unknown, namespace: string, context: { env: string; distribution: string }): string {
  if (error instanceof KubeError) {
    const mapped = kubeErrorToCliError(error, {
      env: context.env,
      operation: `apply namespace ${namespace}`,
      mutating: true,
      distribution: context.distribution,
    });
    // a prefix of the documents may be live: the mapping's "nothing was changed" is not true here
    return mapped.message.replace(/; nothing was changed$/, '');
  }
  return error instanceof Error ? error.message : String(error);
}

/** The error of an apply that failed after a successful dry-run, once the revert concluded (design-03 5.8). */
export function partialApplyError(
  namespace: string,
  error: unknown,
  revert: RevertResult,
  context: { env: string; distribution: string },
): DeployError {
  const detail = applyFailureDetail(error, namespace, context);
  const outcome = revert.message ?? (revert.services.length > 0 ? `reverted ${revert.services.join(', ')}` : revert.status);
  if (revert.status === 'failed') {
    return new DeployError(
      `Applying namespace ${namespace} failed after validation (${detail}) and the automatic revert did not converge (${outcome})`,
      ErrorCode.ROLLBACK_FAILED,
      `Run \`dockflow status ${context.env}\`, then \`dockflow rollback ${context.env}\`.`,
    );
  }
  return new DeployError(`Applying namespace ${namespace} failed after validation: ${detail}; ${outcome}`, ErrorCode.DEPLOY_FAILED);
}

/** the header of a subset applied without one: comments only, kubectl ignores them */
function fallbackHeader(namespace: string, objects: readonly ManifestObject[]): ArtifactHeader {
  const role: StackRole = objects[0]?.metadata.labels?.[LABELS.role] === 'accessory' ? 'accessory' : 'app';
  return { format: 'k8s-manifests/1', stackName: namespace, role, version: '-' };
}

function headerFor(ref: StackRef, version: string): ArtifactHeader {
  return { format: 'k8s-manifests/1', stackName: `${ref.project}-${ref.env}`, role: ref.role, version };
}

function serviceOfTarget(target: LiveObjectRef, before: Snapshot): string {
  return target.service ?? before.workloads.find((w) => w.kind === target.kind && w.name === target.name)?.service ?? target.name;
}

// ---------------------------------------------------------------------------
// ApplyEngine
// ---------------------------------------------------------------------------

export class ApplyEngine {
  private readonly kubectl: KubeExecutor;
  private readonly clock: Clock;
  private readonly distribution: K8sDistribution;
  private readonly memo: SharedMemo;
  private readonly events: ApplyEventSink;
  /** K06 answers of this bundle; null = the class does not exist */
  private readonly classes = new Map<string, StorageClass | null>();

  constructor(deps: ApplyEngineDeps) {
    this.kubectl = deps.kubectl;
    this.clock = deps.clock;
    this.distribution = deps.distribution;
    this.memo = deps.memo;
    this.events = deps.events ?? SILENT;
  }

  // ---- namespace (5.2) ---------------------------------------------------------------------------

  /** K01, then K02 when the namespace is missing; once per namespace and bundle. */
  ensureNamespace(ref: Pick<StackRef, 'project' | 'env'>): Promise<void> {
    const namespace = namespaceFor(ref.project, ref.env);
    return memoize(this.memo.namespaces, namespace, async () => {
      if ((await this.assertNamespaceOwner(ref)) === 'owned') return;
      await this.kubectl.apply(emitObject(namespaceObject(ref)), { dryRun: false });
    });
  }

  /**
   * Read-only ownership guard (K01): a namespace with the same (hash-truncated) name that another
   * stack or nobody owns is never interpreted as this stack.
   */
  async assertNamespaceOwner(ref: Pick<StackRef, 'project' | 'env'>): Promise<'owned' | 'missing'> {
    const namespace = namespaceFor(ref.project, ref.env);
    const [live] = await this.kubectl.getJson<Namespace>(['namespaces'], { name: namespace, allowNotFound: true });
    if (!live) return 'missing';
    if (live.metadata.deletionTimestamp !== undefined) {
      throw new DeployError(
        `Namespace ${namespace} is being deleted`,
        ErrorCode.DEPLOY_FAILED,
        `Wait until it is gone, then run \`dockflow deploy ${ref.env}\` again.`,
      );
    }
    const managed = live.metadata.labels?.[LABELS.managedBy] === K8S_MANAGED_BY;
    const owner = live.metadata.annotations?.[ANNOTATIONS.stackName];
    if (!managed || owner !== `${ref.project}-${ref.env}`) {
      const other = managed && owner !== undefined ? owner : 'no Dockflow stack';
      throw new DeployError(`Namespace ${namespace} exists and belongs to ${other}; rename project_name or env`, ErrorCode.DEPLOY_FAILED);
    }
    return 'owned';
  }

  // ---- snapshots (2.4) ---------------------------------------------------------------------------

  /** K07, plus K08 only when a StatefulSet or DaemonSet needs its ControllerRevisions. */
  async snapshot(namespace: string, role: StackRole): Promise<Snapshot> {
    const items = await this.kubectl.getJson<SnapshotItem>([...SNAPSHOT_RESOURCES], { namespace, selector: SEL_ROLE(namespace, role) });
    const revisioned = items.some((item) => item.kind === 'StatefulSet' || item.kind === 'DaemonSet');
    const revisions = revisioned
      ? await this.kubectl.getJson<ControllerRevision>(['controllerrevisions.apps'], { namespace, selector: SEL_POD(namespace, role) })
      : [];
    return toSnapshot(items, revisions, this.clock.now());
  }

  // ---- pre-apply checks (5.4) --------------------------------------------------------------------

  /**
   * Volume compatibility (design-03 5.4.2) against the live claims (K09), before any mutation.
   * Deploy mode refuses claim-shape changes unless `rebindVolumes` (design-02 7.4.1), and storage
   * class, access-mode, shrink and non-expandable growth of standalone claims; restore mode drops
   * every claim that already exists, so a rollback never shrinks a volume the failed version grew.
   */
  async checkVolumes(
    ref: StackRef,
    objects: readonly ManifestObject[],
    mode: VolumeCheckMode,
    options: { rebindVolumes?: boolean } = {},
  ): Promise<ManifestObject[]> {
    const namespace = namespaceFor(ref.project, ref.env);
    const claims = objects.filter(isClaim);
    const templated = objects.some((o) => o.kind === 'StatefulSet' && (o.spec.volumeClaimTemplates?.length ?? 0) > 0);
    if (claims.length === 0 && !templated) return [...objects];
    const livePvcs = await this.kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace });
    const live = new Map(livePvcs.map((p) => [p.metadata.name, p]));
    if (mode === 'restore') return objects.filter((o) => !isClaim(o) || !live.has(o.metadata.name));

    for (const conflict of claimShapeConflicts(renderedClaimShapes(objects), liveClaimShapes(livePvcs))) {
      if (!options.rebindVolumes) throw claimShapeError(conflict, ref);
      this.events.warn(claimShapeRebindNotice(conflict));
    }

    const classes = await this.storageClasses(claims.flatMap((c) => (c.spec.storageClassName === undefined ? [] : [c.spec.storageClassName])));
    for (const claim of claims) this.checkClaim(ref, claim, live.get(claim.metadata.name), classes);
    return [...objects];
  }

  private checkClaim(
    ref: StackRef,
    claim: PersistentVolumeClaim,
    current: PersistentVolumeClaim | undefined,
    classes: Map<string, StorageClass>,
  ): void {
    const key = claim.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? claim.metadata.name;
    const subject = `Volume ${key} (persistentvolumeclaim/${claim.metadata.name})`;
    const className = claim.spec.storageClassName;
    if (className !== undefined && !classes.has(className)) {
      throw new DeployError(
        `StorageClass ${className} does not exist on the cluster (used by volumes.${key})`,
        ErrorCode.DEPLOY_FAILED,
        `Set \`x-dockflow.storage_class\` to an existing class, or re-run \`dockflow setup ${this.distribution.traits.name} ${ref.env}\`.`,
      );
    }
    if (!current) return;
    const currentClass = current.spec.storageClassName;
    if ((currentClass ?? null) !== (className ?? null)) {
      throw new DeployError(
        `${subject} cannot change storage class from ${currentClass ?? 'none'} to ${className ?? 'none'}`,
        ErrorCode.DEPLOY_FAILED,
        'Keep the previous x-dockflow.storage_class, or declare a new volume key and migrate the data.',
      );
    }
    if (!sameSet(current.spec.accessModes, claim.spec.accessModes)) {
      throw new DeployError(
        `${subject} cannot change access mode from ${current.spec.accessModes.join(',')} to ${claim.spec.accessModes.join(',')}`,
        ErrorCode.DEPLOY_FAILED,
        'Keep the previous x-dockflow.access_mode, or declare a new volume key and migrate the data.',
      );
    }
    const from = current.spec.resources.requests.storage;
    const to = claim.spec.resources.requests.storage;
    const delta = compareQuantities(to, from);
    if (delta < 0) {
      throw new DeployError(`${subject} cannot shrink from ${from} to ${to}`, ErrorCode.DEPLOY_FAILED, `Set x-dockflow.size back to ${from}.`);
    }
    if (delta > 0 && (className === undefined || classes.get(className)?.allowVolumeExpansion !== true)) {
      throw new DeployError(
        `${subject} cannot grow from ${from} to ${to}: storage class ${className ?? 'none'} does not allow volume expansion`,
        ErrorCode.DEPLOY_FAILED,
        `Set x-dockflow.size back to ${from}.`,
      );
    }
  }

  /** K06 for the classes not read yet by this bundle; returns the ones that exist. */
  private async storageClasses(names: readonly string[]): Promise<Map<string, StorageClass>> {
    const wanted = unique(names);
    const unknown = wanted.filter((name) => !this.classes.has(name));
    if (unknown.length > 0) {
      const found = await this.kubectl.getJson<StorageClass>(['storageclasses.storage.k8s.io'], { names: unknown, ignoreNotFound: true });
      for (const name of unknown) this.classes.set(name, found.find((c) => c.metadata.name === name) ?? null);
    }
    const out = new Map<string, StorageClass>();
    for (const name of wanted) {
      const found = this.classes.get(name);
      if (found) out.set(name, found);
    }
    return out;
  }

  /**
   * K49 (design-03 5.4.5, K74): an object of `objects` that exists and is owned by someone else
   * (typically a Helm chart in the stack namespace) would be taken over by the forced apply and
   * taken back by the next `helm upgrade`. Refused before any mutation.
   */
  async assertNoForeignOwner(namespace: string, objects: readonly ManifestObject[]): Promise<void> {
    if (objects.length === 0) return;
    const targets = objects.map((o) => `${KIND_REGISTRY[o.kind].resource}/${o.metadata.name}`);
    const result = await this.kubectl.run({
      args: ['get', ...targets, '--ignore-not-found', '--show-managed-fields', '-o', 'json'],
      namespace,
      mutating: false,
    });
    let live: { kind: string; metadata: ObjectMeta }[];
    try {
      live = parseJsonItems<{ kind: string; metadata: ObjectMeta }>(result.stdout);
    } catch {
      const node = this.kubectl.node.name;
      throw new KubeError('Unknown', `The ownership read returned output that is not JSON on ${node}`, node, 0, '');
    }
    const [first] = foreignObjects(objects, live);
    if (first) throw foreignOwnerError(first, namespace);
  }

  // ---- dry-run and apply (5.5) -------------------------------------------------------------------

  /**
   * K10. A refusal caused only by a Service's clusterIP shape flip (core K29) is not an error:
   * those Services are returned for `apply` to re-create, and the rest is validated again so any
   * other problem still surfaces before a mutation.
   */
  async validate(
    namespace: string,
    objects: readonly ManifestObject[],
    options: { header?: ArtifactHeader } = {},
  ): Promise<{ recreate: string[] }> {
    if (objects.length === 0) return { recreate: [] };
    const header = options.header ?? fallbackHeader(namespace, objects);
    try {
      await this.kubectl.apply(emitManifests([...objects], header), { namespace, dryRun: true });
      return { recreate: [] };
    } catch (error) {
      const recreate = clusterIpFlips(error, objects);
      if (recreate.length === 0) throw error;
      const rest = objects.filter((o) => o.kind !== 'Service' || !recreate.includes(o.metadata.name));
      if (rest.length > 0) await this.kubectl.apply(emitManifests(rest, header), { namespace, dryRun: true });
      return { recreate };
    }
  }

  /**
   * K11 over stdin. Services in `recreate` are deleted first (K20); a clusterIP flip met here
   * instead deletes the offending Services and retries once with the full set. A Service keeps
   * its name and selector, so the only effect is a few seconds without a cluster IP.
   */
  async apply(
    namespace: string,
    objects: readonly ManifestObject[],
    options: { header?: ArtifactHeader; recreate?: readonly string[] } = {},
  ): Promise<void> {
    if (objects.length === 0) return;
    const manifests = emitManifests([...objects], options.header ?? fallbackHeader(namespace, objects));
    let recreated = unique(options.recreate ?? []);
    if (recreated.length > 0) await this.deleteServices(namespace, recreated);
    try {
      await this.kubectl.apply(manifests, { namespace, dryRun: false });
    } catch (error) {
      const flips = recreated.length === 0 ? clusterIpFlips(error, objects) : [];
      if (flips.length === 0) throw error;
      await this.deleteServices(namespace, flips);
      await this.kubectl.apply(manifests, { namespace, dryRun: false });
      recreated = flips;
    }
    for (const name of recreated) {
      const service = objects.find((o) => o.kind === 'Service' && o.metadata.name === name);
      this.events.step(`Service ${(service && composeServiceOf(service)) ?? name} changed its addressing mode and was re-created`);
    }
  }

  private async deleteServices(namespace: string, names: readonly string[]): Promise<void> {
    await this.kubectl.delete(
      names.map((name) => `services/${name}`),
      { namespace, wait: true, timeoutS: deleteWaitS([]), ignoreNotFound: true },
    );
  }

  // ---- disruptive deletes (5.4.3, 5.4.4) ---------------------------------------------------------

  /**
   * K19 foreground delete of the live workloads a kind switch or a Job re-run replaces, then K38
   * as the proof that their pods are gone (it also covers pods orphaned by hand). Both wait
   * `deleteWaitS` of the deleted workloads. A timeout stops the deploy before the apply.
   */
  async deleteBeforeApply(ref: StackRef, targets: readonly LiveObjectRef[], before: Snapshot): Promise<void> {
    if (targets.length === 0) return;
    const namespace = namespaceFor(ref.project, ref.env);
    const live = targets.flatMap((t) => before.workloads.filter((w) => w.kind === t.kind && w.name === t.name));
    const waitS = deleteWaitS(live);
    const others = targets.filter((t) => t.kind !== 'Job');
    const jobs = targets.filter((t) => t.kind === 'Job').map((t) => t.name);
    const selectors = [
      ...(others.length > 0 ? [SEL_POD(namespace, ref.role, unique(others.map((t) => serviceOfTarget(t, before))))] : []),
      // the service's other Jobs keep their finished pods until prune: only the replaced Job's are awaited
      ...(jobs.length > 0 ? [`${KUBE_KEYS.jobName} in (${[...jobs].sort().join(',')})`] : []),
    ];
    let selector = selectors[0];
    try {
      await this.kubectl.delete(
        targets.map((t) => `${KIND_REGISTRY[t.kind].resource}/${t.name}`),
        { namespace, wait: true, timeoutS: waitS, ignoreNotFound: true, cascade: 'foreground' },
      );
      for (const next of selectors) {
        selector = next;
        await this.kubectl.run({
          args: ['wait', '--for=delete', 'pods', '-l', selector, `--timeout=${waitS}s`],
          namespace,
          mutating: false,
          requestTimeoutS: null,
          guardS: waitS + WAIT_GUARD_MARGIN_S,
        });
      }
    } catch (error) {
      if (!(error instanceof KubeError) || error.reason !== 'Timeout') throw error;
      throw await this.replaceTimeout(ref, namespace, targets, before, selector, waitS);
    }
  }

  private async replaceTimeout(
    ref: StackRef,
    namespace: string,
    targets: readonly LiveObjectRef[],
    before: Snapshot,
    selector: string,
    waitS: number,
  ): Promise<DeployError> {
    const pods = await this.kubectl.getJson<Pod>(['pods'], { namespace, selector }).catch(() => null);
    const lingering = pods?.[0]?.metadata.labels?.[LABELS.service];
    const target = targets.find((t) => serviceOfTarget(t, before) === lingering) ?? targets[0];
    return new DeployError(
      `Replacing ${target.kind} ${serviceOfTarget(target, before)} timed out after ${waitS}s: ${pods === null ? 'some' : pods.length} pod(s) still terminating`,
      ErrorCode.DEPLOY_FAILED,
      `Run \`dockflow diagnose ${ref.env}\`.`,
    );
  }

  // ---- the whole apply (5.1) ---------------------------------------------------------------------

  /**
   * Everything before the first mutation of the role, in design-03 5.1 order: namespace, snapshot,
   * zero-workload guard, kind switches and Job re-runs (refusals thrown), claim templates, volumes,
   * foreign ownership, existing Jobs dropped, running Jobs warned about, server dry-run. The
   * caller runs its Helm releases between this and `execute`.
   */
  async prepare(request: ApplyRequest): Promise<PreparedApply> {
    const { ref } = request;
    const namespace = namespaceFor(ref.project, ref.env);
    const applied = [...(request.applied ?? request.objects)];
    await this.ensureNamespace(ref);
    const before = request.before ?? (await this.snapshot(namespace, ref.role));
    if (request.full) assertPruneGuard(request.objects, before, namespace, ref);
    const switches = planKindSwitches(applied, before, request.facts ?? factsFromObjects(request.objects), ref);
    const staleJobs = planJobRecreations(applied, before);
    if (request.mode === 'deploy') checkClaimTemplates(applied, before, ref);
    let toApply = await this.checkVolumes(ref, applied, request.mode, { rebindVolumes: request.rebindVolumes ?? false });
    await this.assertNoForeignOwner(namespace, toApply);
    toApply = dropUnchangedJobs(toApply, before, staleJobs);
    for (const job of runningJobs(applied, before)) {
      this.events.warn(`Job ${job.service} from an earlier deploy is still running; this deploy does not wait for it`);
    }
    const header = headerFor(ref, request.version);
    // A re-run Job is dry-run neither: over the live Job of the same name the dry-run fails on the
    // generated selector (K43), and that content name proves the server accepted this exact spec.
    const rerun = new Set(staleJobs.map((j) => j.name));
    const validated = toApply.filter((o) => o.kind !== 'Job' || !rerun.has(o.metadata.name));
    const { recreate } = await this.validate(namespace, validated, { header });
    return {
      ref,
      namespace,
      header,
      before,
      toApply,
      switches,
      staleJobs,
      disruptive: describeSwitches(switches, staleJobs),
      recreate,
    };
  }

  /**
   * The mutations: disruptive deletes, then the apply (`onApplyProgress` `started` right before
   * it), then the after snapshot, change detection and the `-lb` Services to watch. An apply that
   * fails after the dry-run (5.8) is handed to `options.revert` with what it left, the revert
   * outcome is reported through `onApplyProgress`, and the partial-apply error is thrown.
   */
  async execute(prepared: PreparedApply, options: ExecuteOptions = {}): Promise<ApplyOutcome> {
    const { ref, namespace, before, toApply, switches, staleJobs, disruptive } = prepared;
    const targets: LiveObjectRef[] = [...switches.replace, ...staleJobs];
    if (targets.length > 0) {
      for (const r of switches.replace) {
        this.events.step(`Replacing ${r.kind}/${r.name} with ${r.to.kind}/${r.to.name} for service ${r.service}; its pods restart`);
      }
      for (const job of staleJobs) this.events.step(`Job ${serviceOfTarget(job, before)} failed in a previous deploy and is run again`);
      await this.deleteBeforeApply(ref, targets, before);
    }

    if (toApply.length > 0) {
      options.onApplyProgress?.({ kind: 'started' });
      try {
        await this.apply(namespace, toApply, { header: prepared.header, recreate: prepared.recreate });
      } catch (error) {
        const revert = options.revert;
        if (!revert) throw error;
        const after = await this.snapshot(namespace, ref.role).catch(() => before);
        const changes = diffSnapshots(before, after, toApply, staleJobs);
        const reverted = await revert({ before, after, toApply, changes, disruptive, error }).catch(
          (failure: unknown): RevertResult => ({
            status: 'failed',
            services: [],
            message: `internal error: the revert threw: ${failure instanceof Error ? failure.message : String(failure)}`,
          }),
        );
        options.onApplyProgress?.({ kind: 'reverted', revert: reverted });
        throw partialApplyError(namespace, error, reverted, { env: ref.env, distribution: this.distribution.traits.name });
      }
    }

    const after = await this.snapshot(namespace, ref.role);
    return {
      before,
      after,
      applied: toApply,
      changes: diffSnapshots(before, after, toApply, staleJobs),
      lbWatch: planLbWatch(toApply, before, after),
      disruptive,
    };
  }
}
