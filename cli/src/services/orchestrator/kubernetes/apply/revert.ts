// Automatic revert execution (design-03 11.4, DESIGN-CORE DV2): restore-mode apply of the previous
// release's objects for the changed services, StatefulSet stuck-pod cleanup, removal of services the
// failed version created (DV-S2-2), `failure_action` honoured (DV-S2-1), then a wait bounded by the
// derived revert budget (8.6). The pure plan comes from apply/revert-plan.ts; this module performs
// the reads and mutations design-03 11.4 spells out and never throws (RevertResult carries the
// outcome). PVCs are never re-applied when they already exist (restore mode, I-13).

import { CONVERGENCE_INTERVAL_S } from '../../../../constants';
import type {
  DeployReceipt,
  HelmBackend,
  HelmReleaseRecord,
  ResolvedHelmRelease,
  RevertResult,
  StackRole,
  WorkloadChange,
} from '../../interfaces';
import type { Redactor } from '../../../../utils/redact';
import { deleteWaitS, KUBE_KEYS, revertWaitS } from '../constants';
import { SEL_POD } from '../labels';
import type { Pod, PersistentVolumeClaim } from '../resources/core';
import { KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import type { KubeExecutor } from '../runtime/kubectl';
import type { ReceiptState } from '../backends/stack-state';
import { stateFor } from '../backends/stack-state';
import { waitConvergence, type StackWaitDeps } from '../backends/stack-wait';
import type { ApplyEngine } from './engine';
import { executeDeletes } from './prune';
import {
  type FailureAction,
  isEmptyRevertPlan,
  planRevert,
  type RevertPlan,
  type RevertPlanInput,
} from './revert-plan';
import { compareCodeUnits, type Snapshot } from './snapshot';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface RevertDeps {
  kubectl: KubeExecutor;
  /** only these three members are used: the two snapshots, the disruptive deletes and the restore apply */
  engine: Pick<ApplyEngine, 'snapshot' | 'deleteBeforeApply' | 'apply'>;
  /** only `upgradeInstall` is used: restored Helm releases are re-installed from their pinned bytes */
  helm: Pick<HelmBackend, 'upgradeInstall'>;
  /** the bundle Redactor: an unexpected failure is redacted before it reaches `RevertResult.message` */
  redactor: Redactor;
  /** everything the post-revert `waitConvergence` poll needs */
  wait: StackWaitDeps;
}

export interface RevertRequest {
  receipt: DeployReceipt;
  /** the bundle's private state of `receipt`; undefined for a receipt this bundle did not produce (R8) */
  state: ReceiptState | undefined;
  /** design-03 2.5 `max(5, keep_releases + 2)`, computed by the caller: config is outside this package */
  helmHistoryMax: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hasPvcs(objects: readonly ManifestObject[] | undefined): boolean {
  return (objects ?? []).some((o) => o.kind === 'PersistentVolumeClaim');
}

/** `ResolvedHelmRelease` cannot be reconstructed from the stored record alone: auth is never persisted
 * and `declaredDigest` is the already-verified pin, which is the record's own `chartSha256` (the
 * "pinned bytes" the spec asks to re-install from). */
function toResolvedRelease(record: HelmReleaseRecord, auth: ResolvedHelmRelease['auth']): ResolvedHelmRelease {
  const { chartSha256, ...rest } = record;
  return { ...rest, auth, declaredDigest: chartSha256 };
}

function isPodReady(pod: Pod): boolean {
  return (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
}

/** Pods of one StatefulSet stuck on the revision being rolled out: not Ready, on `failedRevision` (K17). */
async function stuckStatefulSetPods(
  kubectl: KubeExecutor,
  namespace: string,
  role: StackRole,
  target: { service: string; failedRevision: string },
): Promise<string[]> {
  const pods = await kubectl.getJson<Pod>(['pods'], { namespace, selector: SEL_POD(namespace, role, [target.service]) });
  return pods
    .filter((p) => p.metadata.labels?.[KUBE_KEYS.controllerRevisionHash] === target.failedRevision && !isPodReady(p))
    .map((p) => p.metadata.name)
    .sort(compareCodeUnits);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** One sentence per `leftInPlace` entry (design-03 11.4's `nothingMessage` table, generalised). */
function leftInPlaceSentence(entry: RevertPlan['leftInPlace'][number], failureActions: Readonly<Record<string, FailureAction>>): string {
  switch (entry.reason) {
    case 'first-deploy':
      return 'nothing to roll back to (first deployment of this stack); workloads were left in place for debugging';
    case 'no-history':
      return `nothing to roll back to (${entry.service} has no previous revision); it was left in place for debugging`;
    case 'failure-action':
      return `${entry.service} was not reverted because its update_config.failure_action is ${failureActions[entry.service] ?? 'pause'}`;
    case 'job':
      return `job ${entry.service} already ran and cannot be reverted`;
  }
}

function describeLeftInPlace(
  leftInPlace: RevertPlan['leftInPlace'],
  failureActions: Readonly<Record<string, FailureAction>>,
): string | null {
  if (leftInPlace.length === 0) return null;
  return dedupe(leftInPlace.map((e) => leftInPlaceSentence(e, failureActions))).join('; ');
}

/** `RevertResult.message` when nothing in the plan needed executing. */
function nothingMessage(leftInPlace: RevertPlan['leftInPlace'], failureActions: Readonly<Record<string, FailureAction>>): string {
  return describeLeftInPlace(leftInPlace, failureActions) ?? 'there is nothing to revert';
}

/** `reverted <restored> to <version>; removed <new services> (new in <failed version>); <left in place>` */
function successMessage(plan: RevertPlan, receipt: DeployReceipt, failureActions: Readonly<Record<string, FailureAction>>): string {
  const removed = dedupe(plan.remove.map((r) => r.service).filter((s): s is string => s !== null));
  const restored = plan.services.filter((s) => !removed.includes(s));
  const to = receipt.previousVersion ?? 'their previous revision';
  const parts: string[] = [];
  if (restored.length > 0) parts.push(`reverted ${restored.join(', ')} to ${to}`);
  if (removed.length > 0) parts.push(`removed ${removed.join(', ')} (new in ${receipt.version})`);
  const left = describeLeftInPlace(plan.leftInPlace, failureActions);
  if (left !== null) parts.push(left);
  return parts.length > 0 ? parts.join('; ') : `reverted to ${to}`;
}

/** A synthetic receipt whose `changes` are the watch targets with their post-revert generation. */
function revertReceipt(receipt: DeployReceipt, watch: RevertPlan['watch'], after: Snapshot): DeployReceipt {
  const changes: WorkloadChange[] = watch.map((w) => ({
    service: w.service,
    kind: w.kind,
    name: w.name,
    created: false,
    previousRevision: null,
    previousRevisionNumber: null,
    previousReplicas: null,
    generation: after.workloads.find((x) => x.kind === w.kind && x.name === w.name)?.generation ?? 0,
  }));
  return { ...receipt, changes, helm: [], helmChanges: [] };
}

/** The bundle state `waitConvergence` needs for the watch above: no `-lb` target (11.4). */
function revertState(state: ReceiptState, applied: ManifestObject[], after: Snapshot): ReceiptState {
  return stateFor({ ref: state.ref, namespace: state.namespace, objects: applied, applied, now: after.takenAt, lbWatch: [] });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Executes the revert of one receipt: restore-mode apply of the previous release's objects for the
 * changed services through the injected `ApplyEngine`, the StatefulSet forced-rollback cleanup, the
 * removal of services the failed version introduced, and a wait bounded by the derived revert
 * budget. Never throws: every outcome, including an unknown receipt or a thrown error, comes back as
 * a `RevertResult`.
 */
export async function revert(deps: RevertDeps, request: RevertRequest): Promise<RevertResult> {
  const { state, receipt } = request;
  if (state === undefined) {
    return { status: 'failed', services: [], message: 'internal error: receipt was not produced by this backend' };
  }
  try {
    const now = await deps.engine.snapshot(state.namespace, state.ref.role);
    const livePvcNames = hasPvcs(state.previous?.objects)
      ? (await deps.kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace: state.namespace })).map(
          (p) => p.metadata.name,
        )
      : [];

    const planInput: RevertPlanInput = {
      role: state.ref.role,
      targets: state.targets,
      changes: receipt.changes,
      applied: state.applied,
      previous: state.previous,
      helmApplied: state.helmApplied,
      failureActions: state.failureActions,
      disruptive: state.disruptive,
      before: state.before,
      now,
      livePvcNames,
    };
    const plan = planRevert(planInput);

    if (isEmptyRevertPlan(plan)) {
      return { status: 'nothing-to-revert', services: [], message: nothingMessage(plan.leftInPlace, state.failureActions) };
    }

    const waitS = revertWaitS(now.workloads);

    for (const record of plan.helm) {
      const auth = state.helmInputs.find((h) => h.name === record.name)?.auth ?? null;
      await deps.helm.upgradeInstall(toResolvedRelease(record, auth), { historyMax: request.helmHistoryMax, stackId: state.namespace });
    }
    if (plan.deleteFirst.length > 0) await deps.engine.deleteBeforeApply(state.ref, plan.deleteFirst, now);
    if (plan.apply.length > 0) await deps.engine.apply(state.namespace, plan.apply);
    if (plan.remove.length > 0) await executeDeletes(deps.kubectl, state.namespace, plan.remove, deleteWaitS(now.workloads));
    for (const u of plan.undo) {
      await deps.kubectl.run({
        args: ['rollout', 'undo', `${KIND_REGISTRY[u.kind].resource}/${u.name}`, `--to-revision=${u.toRevision}`],
        namespace: state.namespace,
        mutating: true,
      });
    }
    for (const s of plan.scale) {
      await deps.kubectl.run({
        args: ['scale', `${KIND_REGISTRY[s.kind].resource}/${s.name}`, `--replicas=${s.replicas}`],
        namespace: state.namespace,
        mutating: true,
      });
    }
    for (const p of plan.statefulSetPods) {
      const stuck = await stuckStatefulSetPods(deps.kubectl, state.namespace, state.ref.role, p);
      if (stuck.length > 0) {
        await deps.kubectl.delete(
          stuck.map((name) => `pods/${name}`),
          { namespace: state.namespace, wait: false, ignoreNotFound: true },
        );
      }
    }

    const after = await deps.engine.snapshot(state.namespace, state.ref.role);
    const watchSubject = { receipt: revertReceipt(receipt, plan.watch, after), state: revertState(state, plan.apply, after) };
    const waited = await waitConvergence(watchSubject, { timeoutS: waitS, intervalS: CONVERGENCE_INTERVAL_S }, deps.wait);
    if (waited.status !== 'converged') {
      return { status: 'failed', services: plan.services, message: waited.message ?? 'the reverted workloads did not become ready' };
    }
    return { status: 'reverted', services: plan.services, message: successMessage(plan, receipt, state.failureActions) };
  } catch (error) {
    return { status: 'failed', services: [], message: deps.redactor.redact(errorText(error)) };
  }
}
