// VolumeBackend on Kubernetes (design-06 3.17) and the one volume-deletion protocol of DESIGN-CORE
// C13 (PD-15). `volumes rm`, `stack.remove(..., {volumes: 'delete'})` and the chart `--volumes`
// flows delete data through removeVolumesByProtocol and nothing else: D7's guarantee is a Retain
// class, so the only way data goes is one PersistentVolume at a time switched to Delete after its
// claim is gone, with the original policy recorded on the PV and put back in a finally.

import { DeployError, ErrorCode, ValidationError } from '../../../../utils/errors';
import type { StackRole, VolumeBackend, VolumeInfo, VolumeRemovalReport, VolumeScope } from '../../interfaces';
import { ANNOTATIONS, deleteWaitS, K8S_SYSTEM_NAMESPACE, KUBE_KEYS, LABELS, PARTS } from '../constants';
import type { KubernetesBundleDeps } from '../deps';
import { namespaceFor, nodeNameFor } from '../naming';
import type { Node, PersistentVolume, PersistentVolumeClaim, PersistentVolumeReclaimPolicy, Pod } from '../resources/core';
import { KubeError, kubeErrorToCliError, NO_EXIT_CODE } from '../runtime/errors';
import type { KubeExecutor } from '../runtime/kubectl';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Backends never print (DESIGN-CORE 1.1): the repair of C13 step 5 reaches the CLI through this. */
export interface VolumeNotices {
  warn(message: string, suggestion?: string): void;
}

export interface VolumeBackendOptions {
  /** servers.yml keys of the environment: a PV's node is shown as the key its node name came from */
  serverKeys: readonly string[];
  notices: VolumeNotices;
}

/** One volume to delete. A claim that no longer exists falls back to `volume`. */
export interface VolumeTarget {
  /** PVC name in the protocol namespace */
  claim: string | null;
  /** bound PV, when known: a claim deleted earlier (a chart uninstall) no longer names it */
  volume: string | null;
}

export interface VolumeProtocolOptions {
  namespace: string;
  /** environment name, for the messages */
  env: string;
  /** each PVC delete and PV wait; derived by the caller from the grace periods involved (DESIGN-CORE 8.6) */
  waitS?: number;
  /** Ctrl+C: the volume in progress is finished, the next one is not started */
  signal?: AbortSignal;
}

export interface VolumeProtocolReport extends VolumeRemovalReport {
  /**
   * Claims deleted whose PV stays Released with its policy untouched because its node left the
   * cluster (design-04 3.10): no reclaim can run there, and a Delete PV would stay Delete forever.
   */
  keptOnLostNode: { claim: string; volume: string; node: string }[];
}

/** A deletion that stopped part-way; `report` names what was deleted, restored or left. */
export class VolumeRemovalError extends DeployError {
  constructor(
    message: string,
    suggestion: string,
    readonly report: VolumeProtocolReport,
    readonly failure: unknown,
    code: ErrorCode = ErrorCode.DEPLOY_FAILED,
  ) {
    super(message, code, suggestion);
    this.name = 'VolumeRemovalError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Policy = PersistentVolumeReclaimPolicy;

const POLICIES: readonly string[] = ['Retain', 'Delete', 'Recycle'];
const POLICY_BEFORE = ANNOTATIONS.reclaimPolicyBefore;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPolicy(value: string | undefined): value is Policy {
  return value !== undefined && POLICIES.includes(value);
}

/** the API defaults a PV without a policy to Retain */
function policyOf(pv: PersistentVolume): Policy {
  return pv.spec?.persistentVolumeReclaimPolicy ?? 'Retain';
}

/** `P/reclaim-policy-before`, when it holds a policy (anything else is not evidence of ours) */
function recordedAnnotation(pv: PersistentVolume): Policy | null {
  const value = pv.metadata.annotations?.[POLICY_BEFORE];
  return isPolicy(value) ? value : null;
}

/** the node holding a local volume: the `kubernetes.io/hostname In` term of its node affinity */
function nodeOfVolume(pv: PersistentVolume): string | null {
  for (const term of pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? []) {
    for (const expression of term.matchExpressions ?? []) {
      if (expression.key === KUBE_KEYS.hostname && expression.operator === 'In' && expression.values?.[0] !== undefined) {
        return expression.values[0];
      }
    }
  }
  return null;
}

function claimedBy(pv: PersistentVolume, namespace: string, claims: ReadonlyMap<string, PersistentVolumeClaim>): PersistentVolumeClaim | null {
  const ref = pv.spec?.claimRef;
  if (ref?.namespace !== namespace || ref.name === undefined) return null;
  const claim = claims.get(ref.name);
  // a claim re-created under the same name is another claim: the old PV is released
  if (claim === undefined || (ref.uid !== undefined && claim.metadata.uid !== undefined && ref.uid !== claim.metadata.uid)) return null;
  return claim;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof KubeError && error.reason === 'NotFound';
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * The patch that puts a PV back: its recorded policy and no annotation. A recorded Delete is never
 * written back (the PV already has it), so a restore can only strengthen retention.
 */
function restoreBody(recorded: Policy): string {
  const body: Record<string, unknown> = { metadata: { annotations: { [POLICY_BEFORE]: null } } };
  if (recorded !== 'Delete') body.spec = { persistentVolumeReclaimPolicy: recorded };
  return JSON.stringify(body);
}

// Patch payloads are fixed shapes with no user content, so they may travel in argv (DESIGN-CORE 8.4 R2).
async function patchVolume(kubectl: KubeExecutor, volume: string, body: string): Promise<void> {
  await kubectl.run({ args: ['patch', `persistentvolumes/${volume}`, '--type=merge', '-p', body], mutating: true });
}

function emptyReport(): VolumeProtocolReport {
  return { deleted: [], restored: [], restoreFailed: [], keptOnLostNode: [] };
}

// ---------------------------------------------------------------------------
// The protocol (DESIGN-CORE C13)
// ---------------------------------------------------------------------------

type Step = 'record' | 'claim' | 'policy' | 'wait' | 'interrupt';

interface PlannedVolume {
  /** the claim, or the PV when there is none */
  label: string;
  claim: string | null;
  volume: string | null;
  /** what the finally puts back (C13 step 1) */
  recorded: Policy | null;
  current: Policy | null;
  annotation: Policy | null;
  /** node named by the PV's affinity when that node is no longer in the cluster */
  lostNode: string | null;
  annotated: boolean;
  patched: boolean;
  gone: boolean;
}

class StepFailure extends Error {
  constructor(
    readonly step: Step,
    readonly volume: PlannedVolume,
    readonly error: unknown,
  ) {
    super(errorDetail(error));
    this.name = 'StepFailure';
  }
}

/** Step 1 reads: the claims, their PVs and, for local volumes, the nodes of the cluster. Nothing changes here. */
async function planRemoval(kubectl: KubeExecutor, targets: readonly VolumeTarget[], namespace: string): Promise<PlannedVolume[]> {
  const volumes = new Map<string, PersistentVolume>();
  const readVolumes = async (names: string[]): Promise<void> => {
    const missing = unique(names).filter((name) => !volumes.has(name));
    if (missing.length === 0) return;
    for (const pv of await kubectl.getJson<PersistentVolume>(['persistentvolumes'], { names: missing, ignoreNotFound: true })) {
      volumes.set(pv.metadata.name, pv);
    }
  };
  await readVolumes(targets.flatMap((target) => (target.claim === null && target.volume !== null ? [target.volume] : [])));

  // a released PV may still be bound to a claim that is terminating: that claim goes first
  const claimNames = unique([
    ...targets.flatMap((target) => (target.claim !== null ? [target.claim] : [])),
    ...targets.flatMap((target) => {
      const ref = target.claim === null && target.volume !== null ? volumes.get(target.volume)?.spec?.claimRef : undefined;
      return ref?.namespace === namespace && ref.name !== undefined ? [ref.name] : [];
    }),
  ]);
  const claims = new Map<string, PersistentVolumeClaim>();
  if (claimNames.length > 0) {
    for (const pvc of await kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace, names: claimNames, ignoreNotFound: true })) {
      claims.set(pvc.metadata.name, pvc);
    }
  }
  await readVolumes([
    ...[...claims.values()].flatMap((pvc) => (pvc.spec.volumeName !== undefined ? [pvc.spec.volumeName] : [])),
    ...targets.flatMap((target) => (target.claim !== null && !claims.has(target.claim) && target.volume !== null ? [target.volume] : [])),
  ]);

  const plan: PlannedVolume[] = [];
  const seenClaims = new Set<string>();
  const seenVolumes = new Set<string>();
  for (const target of targets) {
    let claim = target.claim !== null ? (claims.get(target.claim) ?? null) : null;
    if (claim === null && target.volume !== null) {
      const pv = volumes.get(target.volume);
      claim = pv ? claimedBy(pv, namespace, claims) : null;
    }
    const volumeName = claim !== null ? (claim.spec.volumeName ?? null) : target.volume;
    const pv = volumeName !== null ? (volumes.get(volumeName) ?? null) : null;
    if (claim === null && pv === null) continue;
    const claimName = claim?.metadata.name ?? null;
    const pvName = pv?.metadata.name ?? null;
    if ((claimName !== null && seenClaims.has(claimName)) || (pvName !== null && seenVolumes.has(pvName))) continue;
    if (claimName !== null) seenClaims.add(claimName);
    if (pvName !== null) seenVolumes.add(pvName);
    const annotation = pv ? recordedAnnotation(pv) : null;
    plan.push({
      label: claimName ?? pvName ?? '',
      claim: claimName,
      volume: pvName,
      recorded: pv ? (annotation ?? policyOf(pv)) : null,
      current: pv ? policyOf(pv) : null,
      annotation,
      lostNode: null,
      annotated: false,
      patched: false,
      gone: false,
    });
  }

  const pinned = new Map<string, string>();
  for (const pv of volumes.values()) {
    const node = nodeOfVolume(pv);
    if (node !== null) pinned.set(pv.metadata.name, node);
  }
  if (plan.some((entry) => entry.volume !== null && pinned.has(entry.volume))) {
    const nodes = new Set((await kubectl.getJson<Node>(['nodes'])).map((node) => node.metadata.name));
    for (const entry of plan) {
      const node = entry.volume !== null ? pinned.get(entry.volume) : undefined;
      if (node !== undefined && !nodes.has(node)) entry.lostNode = node;
    }
  }
  return plan;
}

/** Step 1 writes: the policy each PV must get back, as evidence a killed CLI leaves behind. */
async function record(kubectl: KubeExecutor, entry: PlannedVolume): Promise<void> {
  if (entry.volume === null || entry.recorded === null || entry.lostNode !== null) return;
  // a PV that is Delete from the start has nothing to protect
  if (entry.annotation === null && entry.recorded === 'Delete') return;
  entry.annotated = true;
  if (entry.annotation !== null && entry.current === entry.recorded) return;
  const body: Record<string, unknown> = { metadata: { annotations: { [POLICY_BEFORE]: entry.recorded } } };
  // evidence of an interrupted run: the policy goes back before its claim is touched
  if (entry.current !== entry.recorded) body.spec = { persistentVolumeReclaimPolicy: entry.recorded };
  await patchVolume(kubectl, entry.volume, JSON.stringify(body));
  entry.current = entry.recorded;
}

/** Step 2 for one volume: its claim, then (only then) that PV to Delete, then the PV gone. */
async function removeOne(
  kubectl: KubeExecutor,
  entry: PlannedVolume,
  options: { namespace: string; waitS: number },
  report: VolumeProtocolReport,
): Promise<void> {
  const { namespace, waitS } = options;
  if (entry.claim !== null) {
    try {
      await kubectl.delete([`persistentvolumeclaims/${entry.claim}`], { namespace, wait: true, timeoutS: waitS, ignoreNotFound: true });
    } catch (error) {
      throw new StepFailure('claim', entry, error);
    }
  }
  if (entry.lostNode !== null && entry.volume !== null) {
    report.keptOnLostNode.push({ claim: entry.label, volume: entry.volume, node: entry.lostNode });
    return;
  }
  if (entry.volume === null) {
    report.deleted.push({ claim: entry.label, volume: null });
    return;
  }
  if (entry.recorded !== 'Delete') {
    // set before the call: a lost connection leaves the outcome unknown, and the finally must restore
    entry.patched = true;
    try {
      await patchVolume(kubectl, entry.volume, JSON.stringify({ spec: { persistentVolumeReclaimPolicy: 'Delete' } }));
    } catch (error) {
      throw new StepFailure('policy', entry, error);
    }
  }
  let waited: { exitCode: number };
  try {
    waited = await kubectl.run({
      args: ['wait', '--for=delete', `persistentvolumes/${entry.volume}`, `--timeout=${waitS}s`],
      mutating: false,
      requestTimeoutS: null,
      guardS: waitS + 30,
      allowFailure: true,
    });
  } catch (error) {
    throw new StepFailure('wait', entry, error);
  }
  if (waited.exitCode !== 0) throw new StepFailure('wait', entry, new Error(`the persistent volume still existed after ${waitS}s`));
  entry.gone = true;
  report.deleted.push({ claim: entry.label, volume: entry.volume });
}

/** Step 3: every PV that is still there gets its recorded policy back and loses the annotation. */
async function restoreAll(kubectl: KubeExecutor, plan: readonly PlannedVolume[], report: VolumeProtocolReport): Promise<void> {
  for (const entry of plan) {
    if (entry.volume === null || entry.recorded === null || entry.gone || !(entry.annotated || entry.patched)) continue;
    try {
      await patchVolume(kubectl, entry.volume, restoreBody(entry.recorded));
      report.restored.push(entry.volume);
    } catch (error) {
      if (isNotFound(error)) {
        // it went while we looked away; after our Delete patch that means its data went too
        if (entry.patched) report.deleted.push({ claim: entry.label, volume: entry.volume });
      } else if (entry.patched) {
        report.restoreFailed.push({ volume: entry.volume, policy: 'Delete', error: errorDetail(error) });
      }
      // an unpatched PV kept its recorded policy; only the annotation stays, and the next listing clears it
    }
  }
}

/** `Deleted a, b; kept c, d.` — what an interrupted run did and left, by claim */
function interruptedOutcome(plan: readonly PlannedVolume[], report: VolumeProtocolReport): string {
  const deleted = report.deleted.map((d) => d.claim);
  const kept = plan.filter((entry) => !deleted.includes(entry.label)).map((entry) => entry.label);
  return deleted.length > 0 ? `Deleted ${deleted.join(', ')}; kept ${kept.join(', ')}.` : `Kept ${kept.join(', ')}.`;
}

function failureMessage(failure: StepFailure, waitS: number): string {
  const label = failure.volume.label;
  const cause = failure.error;
  if (failure.step === 'interrupt') return `Volume deletion interrupted before ${label}`;
  if (cause instanceof KubeError && cause.exitCode === NO_EXIT_CODE) {
    return `Deleting volume ${label} was interrupted (${cause.message}); its outcome is unknown`;
  }
  switch (failure.step) {
    case 'record':
      return `Volume ${label} was not deleted: its reclaim policy could not be recorded (${failure.message})`;
    case 'claim':
      return `Volume ${label} was not deleted: its claim could not be deleted (${failure.message})`;
    case 'policy':
      return `Volume ${label} was not deleted: its persistent volume could not be switched to Delete (${failure.message})`;
    case 'wait':
      return `The data of volume ${label} was not removed within ${waitS}s`;
  }
}

function failureSuggestion(failure: StepFailure, plan: readonly PlannedVolume[], report: VolumeProtocolReport, env: string): string {
  const interrupted = failure.step === 'interrupt';
  const lines: string[] = [];
  if (!interrupted && report.deleted.length > 0) lines.push(`Deleted before the failure: ${report.deleted.map((d) => d.claim).join(', ')}.`);
  if (!interrupted && report.restored.length > 0) lines.push(`Kept, with the reclaim policy restored: ${report.restored.join(', ')}.`);
  for (const failed of report.restoreFailed) {
    const recorded = plan.find((entry) => entry.volume === failed.volume)?.recorded ?? 'Retain';
    lines.push(
      `Persistent volume ${failed.volume} is still set to reclaim Delete (${failed.error}); set it back to ${recorded} from \`dockflow ssh ${env}\` before anything releases its claim.`,
    );
  }
  for (const kept of report.keptOnLostNode) lines.push(`${lostNodeLine(kept)}.`);
  if (interrupted) lines.push(`${interruptedOutcome(plan, report)} Run the command again to delete the rest.`);
  else if (failure.step === 'wait') {
    lines.push(`Check the storage provisioner with \`dockflow diagnose ${env}\`, then run the command again to delete the released volume.`);
  } else lines.push(`Check the cluster with \`dockflow diagnose ${env}\`, then run the command again.`);
  return lines.join('\n');
}

/** design-04 3.10 wording, shared with the chart flows */
export function lostNodeLine(kept: VolumeProtocolReport['keptOnLostNode'][number]): string {
  return `Volume ${kept.claim} was on node ${kept.node}, which is no longer in the cluster; its claim was deleted and PersistentVolume ${kept.volume} is kept as Released`;
}

/**
 * DESIGN-CORE C13, the only code that deletes volume data. Read every claim and PV; record each
 * PV's policy (memory and `P/reclaim-policy-before`); then one volume at a time: delete the claim
 * and wait until it is gone, switch that PV alone to Delete, wait for it to go. A finally puts the
 * recorded policy back on every PV still there. Never patches a set of PVs up front.
 *
 * Read failures before anything changed propagate as they are (KubeError); a failure after that is
 * a VolumeRemovalError carrying the report.
 */
export async function removeVolumesByProtocol(
  deps: Pick<KubernetesBundleDeps, 'kubectl'>,
  claims: readonly VolumeTarget[],
  options: VolumeProtocolOptions,
): Promise<VolumeProtocolReport> {
  const report = emptyReport();
  if (claims.length === 0) return report;
  const kubectl = deps.kubectl;
  const waitS = options.waitS ?? deleteWaitS([]);
  const plan = await planRemoval(kubectl, claims, options.namespace);
  let failure: StepFailure | null = null;
  try {
    for (const entry of plan) {
      try {
        await record(kubectl, entry);
      } catch (error) {
        throw new StepFailure('record', entry, error);
      }
    }
    for (const entry of plan) {
      if (options.signal?.aborted) throw new StepFailure('interrupt', entry, new Error('interrupted'));
      await removeOne(kubectl, entry, { namespace: options.namespace, waitS }, report);
    }
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    failure = error;
  } finally {
    await restoreAll(kubectl, plan, report);
  }
  if (failure !== null) {
    const code = failure.step === 'interrupt' ? ErrorCode.INTERRUPTED : ErrorCode.DEPLOY_FAILED;
    throw new VolumeRemovalError(failureMessage(failure, waitS), failureSuggestion(failure, plan, report, options.env), report, failure.error, code);
  }
  return report;
}

// ---------------------------------------------------------------------------
// VolumeBackend
// ---------------------------------------------------------------------------

interface VolumeRow {
  info: VolumeInfo;
  pvc: PersistentVolumeClaim | null;
  pv: PersistentVolume | null;
}

interface NamespaceVolumes {
  namespace: string;
  claims: PersistentVolumeClaim[];
  pods: Pod[];
  /** PVs whose claimRef points into the namespace */
  volumes: PersistentVolume[];
}

const PVC_PHASES: readonly VolumeInfo['phase'][] = ['Pending', 'Bound', 'Lost'];
const PV_PHASES: readonly VolumeInfo['phase'][] = ['Pending', 'Available', 'Bound', 'Released', 'Failed'];

function phaseOf(phase: string | undefined, known: readonly VolumeInfo['phase'][]): VolumeInfo['phase'] {
  return known.find((candidate) => candidate === phase) ?? 'Unknown';
}

function roleOf(labels: Record<string, string> | undefined): StackRole | null {
  const role = labels?.[LABELS.role];
  return role === 'app' || role === 'accessory' ? role : null;
}

function claimsOf(pod: Pod): string[] {
  return (pod.spec.volumes ?? []).flatMap((volume) => (volume.persistentVolumeClaim ? [volume.persistentVolumeClaim.claimName] : []));
}

/** a pod mounts its claims once scheduled; an unschedulable Pending pod mounts nothing, a Terminating one still may */
function mounts(pod: Pod): boolean {
  const phase = pod.status?.phase;
  return pod.spec.nodeName !== undefined && pod.spec.nodeName !== '' && phase !== 'Succeeded' && phase !== 'Failed';
}

function hostPathOf(pv: PersistentVolume | null): string | null {
  return pv?.spec?.hostPath?.path ?? pv?.spec?.local?.path ?? null;
}

export class KubernetesVolumeBackend implements VolumeBackend {
  constructor(
    private readonly deps: Pick<KubernetesBundleDeps, 'kubectl' | 'distribution'>,
    private readonly options: VolumeBackendOptions,
  ) {}

  async list(scope: VolumeScope): Promise<VolumeInfo[]> {
    const state = await this.read(scope);
    await this.repair(state, scope.env);
    return this.rows(state, scope.role).map((row) => row.info);
  }

  async remove(scope: VolumeScope, names: string[], options: { signal?: AbortSignal } = {}): Promise<VolumeProtocolReport> {
    if (names.length === 0) return emptyReport();
    const state = await this.read(scope);
    await this.repair(state, scope.env);
    const rows = this.rows(state, scope.role);
    const selected = this.resolve(scope, state.namespace, rows, names);
    const inUse = selected.filter((row) => row.info.usedBy.length > 0);
    if (inUse.length > 0) {
      const users = unique(inUse.flatMap((row) => row.info.usedBy)).sort(compareCodeUnits);
      const subject = inUse.length === 1 ? `Volume ${inUse[0].info.name} is` : `Volumes ${inUse.map((row) => row.info.name).join(', ')} are`;
      throw new ValidationError(
        `${subject} in use by ${users.join(', ')}`,
        `Stop the workloads first with \`dockflow stop ${scope.env}\` or \`dockflow accessories stop ${scope.env} <service>\`.`,
      );
    }
    const claimNames = new Set(selected.flatMap((row) => (row.pvc ? [row.pvc.metadata.name] : [])));
    const waitS = deleteWaitS(
      state.pods
        .filter((pod) => claimsOf(pod).some((claim) => claimNames.has(claim)))
        .map((pod) => ({ graceSeconds: pod.spec.terminationGracePeriodSeconds ?? 30 })),
    );
    const targets: VolumeTarget[] = selected.map((row) =>
      row.pvc ? { claim: row.pvc.metadata.name, volume: row.pvc.spec.volumeName ?? null } : { claim: null, volume: row.info.name },
    );
    let report: VolumeProtocolReport;
    try {
      report = await removeVolumesByProtocol(this.deps, targets, { namespace: state.namespace, env: scope.env, waitS, signal: options.signal });
    } catch (error) {
      throw this.cliError(error, scope, 'delete volumes');
    }
    // VolumeRemovalReport has no place for these, and they must not go unsaid
    for (const kept of report.keptOnLostNode) {
      this.options.notices.warn(
        lostNodeLine(kept),
        `Delete persistent volume ${kept.volume} by hand once node ${kept.node} is gone for good; \`${listCommand(scope, state.namespace)}\` shows it until then.`,
      );
    }
    return report;
  }

  // ---- reads ----------------------------------------------------------------------------------

  private namespaceOf(scope: VolumeScope): string {
    return scope.namespace ?? namespaceFor(scope.project, scope.env);
  }

  private cliError(error: unknown, scope: VolumeScope, operation: string): unknown {
    if (!(error instanceof KubeError)) return error;
    return kubeErrorToCliError(error, { env: scope.env, operation, mutating: false, distribution: this.deps.distribution.traits.name });
  }

  private async read(scope: VolumeScope): Promise<NamespaceVolumes> {
    const namespace = this.namespaceOf(scope);
    const kubectl = this.deps.kubectl;
    try {
      const [objects, volumes] = await Promise.all([
        kubectl.getJson<PersistentVolumeClaim | Pod>(['persistentvolumeclaims', 'pods'], { namespace }),
        kubectl.getJson<PersistentVolume>(['persistentvolumes']),
      ]);
      return {
        namespace,
        claims: objects.filter((object): object is PersistentVolumeClaim => object.kind === 'PersistentVolumeClaim'),
        pods: objects.filter((object): object is Pod => object.kind === 'Pod'),
        volumes: volumes.filter((pv) => pv.spec?.claimRef?.namespace === namespace),
      };
    } catch (error) {
      throw this.cliError(error, scope, 'list volumes');
    }
  }

  /**
   * C13 step 5: a PV still carrying `P/reclaim-policy-before` while its claim exists is what an
   * interrupted deletion leaves; it gets the recorded policy back before anything is shown.
   */
  private async repair(state: NamespaceVolumes, env: string): Promise<void> {
    const claims = new Map(state.claims.map((pvc) => [pvc.metadata.name, pvc]));
    for (const pv of state.volumes) {
      const recorded = recordedAnnotation(pv);
      const claim = recorded !== null ? claimedBy(pv, state.namespace, claims) : null;
      if (recorded === null || claim === null) continue;
      const name = claim.metadata.name;
      try {
        await patchVolume(this.deps.kubectl, pv.metadata.name, restoreBody(recorded));
      } catch (error) {
        if (isNotFound(error)) continue;
        this.options.notices.warn(
          `Volume ${name}: reclaim policy could not be restored to ${recorded} after an interrupted volume deletion (${errorDetail(error)})`,
          `Set persistent volume ${pv.metadata.name} back to ${recorded} from \`dockflow ssh ${env}\`, or run \`dockflow volumes list ${env}\` again.`,
        );
        continue;
      }
      pv.spec = { ...pv.spec, persistentVolumeReclaimPolicy: recorded };
      const annotations = { ...pv.metadata.annotations };
      delete annotations[POLICY_BEFORE];
      pv.metadata.annotations = annotations;
      this.options.notices.warn(`Volume ${name}: reclaim policy restored to ${recorded}; a previous volume deletion was interrupted`);
    }
  }

  private nodeLabel(pv: PersistentVolume | null): string | null {
    const node = pv ? nodeOfVolume(pv) : null;
    if (node === null) return null;
    return this.options.serverKeys.find((key) => nodeNameFor(key) === node) ?? node;
  }

  /** design-06 3.17 steps 3-5: one row per claim, one per PV whose claim is gone, role filter, sort */
  private rows(state: NamespaceVolumes, role: StackRole | null): VolumeRow[] {
    const users = new Map<string, Set<string>>();
    for (const pod of state.pods) {
      if (!mounts(pod)) continue;
      const user = pod.metadata.annotations?.[ANNOTATIONS.composeService] ?? pod.metadata.name;
      for (const claim of claimsOf(pod)) {
        const set = users.get(claim) ?? new Set<string>();
        set.add(user);
        users.set(claim, set);
      }
    }
    const claims = new Map(state.claims.map((pvc) => [pvc.metadata.name, pvc]));
    const volumes = new Map(state.volumes.map((pv) => [pv.metadata.name, pv]));
    const rows: VolumeRow[] = state.claims.map((pvc) => {
      const pv = pvc.spec.volumeName !== undefined ? (volumes.get(pvc.spec.volumeName) ?? null) : null;
      return {
        pvc,
        pv,
        info: {
          name: pvc.metadata.name,
          composeName: pvc.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? null,
          role: roleOf(pvc.metadata.labels),
          phase: phaseOf(pvc.status?.phase, PVC_PHASES),
          capacity: pvc.status?.capacity?.storage ?? null,
          storageClass: pvc.spec.storageClassName ?? null,
          node: this.nodeLabel(pv),
          reclaimPolicy: pv ? policyOf(pv) : null,
          usedBy: [...(users.get(pvc.metadata.name) ?? [])].sort(compareCodeUnits),
          hostPath: hostPathOf(pv),
          // read while the claim still exists, so a Helm uninstall can find this PV again by name
          // once it has deleted the claim (design-04 3.10 deleteVolumes/keepVolumes)
          boundVolume: pv ? pv.metadata.name : null,
        },
      };
    });
    for (const pv of state.volumes) {
      if (claimedBy(pv, state.namespace, claims) !== null) continue;
      rows.push({
        pvc: null,
        pv,
        info: {
          name: pv.metadata.name,
          composeName: null,
          role: null,
          phase: phaseOf(pv.status?.phase, PV_PHASES),
          capacity: pv.spec?.capacity?.storage ?? null,
          storageClass: pv.spec?.storageClassName ?? null,
          node: this.nodeLabel(pv),
          reclaimPolicy: policyOf(pv),
          usedBy: [],
          hostPath: hostPathOf(pv),
          boundVolume: null,
        },
      });
    }
    return rows
      .filter((row) => role === null || row.info.role === role)
      .sort((a, b) => compareCodeUnits(a.info.role ?? '~', b.info.role ?? '~') || compareCodeUnits(a.info.name, b.info.name));
  }

  /**
   * A name is a claim, a compose volume key (every claim of a claim template shares it), the
   * `P/volume` label of a claim template, or a PV whose claim is gone.
   */
  private resolve(scope: VolumeScope, namespace: string, rows: readonly VolumeRow[], names: readonly string[]): VolumeRow[] {
    const selected: VolumeRow[] = [];
    const unknown: string[] = [];
    for (const name of unique(names)) {
      const matches = rows.filter((row) => {
        const labels = row.pvc?.metadata.labels;
        const templateName = labels?.[LABELS.part] === PARTS.stack ? labels[LABELS.volume] : undefined;
        return row.info.name === name || row.info.composeName === name || templateName === name;
      });
      if (matches.length === 0) unknown.push(name);
      for (const row of matches) if (!selected.includes(row)) selected.push(row);
    }
    if (unknown.length > 0) {
      const subject = unknown.length === 1 ? `Volume ${unknown[0]}` : `Volumes ${unknown.join(', ')}`;
      const existing = rows.length > 0 ? `Volumes in ${namespace}: ${rows.map((row) => row.info.name).join(', ')}. ` : '';
      throw new ValidationError(`${subject} not found in ${namespace}`, `${existing}List the volumes with \`${listCommand(scope, namespace)}\`.`);
    }
    return selected;
  }
}

/** `dockflow volumes list` with the flag that selects `namespace` (design-06 3.17) */
function listCommand(scope: VolumeScope, namespace: string): string {
  const flags =
    namespace === K8S_SYSTEM_NAMESPACE
      ? ' --system'
      : scope.namespace !== undefined && namespace !== namespaceFor(scope.project, scope.env)
        ? ` --namespace ${namespace}`
        : '';
  return `dockflow volumes list ${scope.env}${flags}`;
}
