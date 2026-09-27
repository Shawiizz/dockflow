// Convergence watcher and internal health check of a deploy receipt (design-03 9.1, 9.2, 9.5, 9.6
// and 10), plus the inventory poll behind the scale, restart and stop waits (18.4-18.6). Every
// verdict comes from the pure evaluator of status/convergence.ts; this module reads the cluster,
// sleeps on the injected clock, enriches failures and reports progress through a WaitReporter.

import { CONVERGENCE_INTERVAL_S } from '../../../../constants';
import { CLIError, OrchestratorUnavailableError } from '../../../../utils/errors';
import { createTimedSpinner, isVerbose, printDebug, printWarning } from '../../../../utils/output';
import type { Redactor } from '../../../../utils/redact';
import type {
  ConvergenceResult,
  DeployReceipt,
  HealthOptions,
  InternalHealthResult,
  ServiceFailure,
  StackRole,
  WaitOptions,
  WorkloadChange,
  WorkloadKind,
} from '../../interfaces';
import { composeServiceOf, type WorkloadObject } from '../apply/snapshot';
import {
  K8S_DEBUG_LOG_LINES,
  K8S_IMPORTED_IMAGE_REGISTRY,
  K8S_POLL_INITIAL_S,
  K8S_TRANSPORT_FAILURES_TOLERATED,
} from '../constants';
import type { Clock } from '../deps';
import type { K8sDistribution } from '../distribution';
import { SEL_POD, SEL_ROLE } from '../labels';
import { nodeNameFor } from '../naming';
import type { ContainerStatus, Event, PersistentVolumeClaim, Pod, Service } from '../resources/core';
import { KubeError, kubeErrorToCliError } from '../runtime/errors';
import type { KubeExecutor } from '../runtime/kubectl';
import {
  classifyPods,
  convergenceStep,
  currentPods,
  type EvaluationContext,
  enrichFailure,
  enrichLoadBalancerFailure,
  evaluateConvergence,
  type FailedVerdict,
  healthStep,
  initialHealthProgress,
  type LbWatchTarget,
  type PollObject,
  type PollSnapshot,
  podStateText,
  pollSnapshot,
  progressLine,
  redactFailure,
  type WatchState,
  type WatchTarget,
  watchTarget,
} from '../status/convergence';
import { latestCrashIsPreviousRun } from '../status/pods';
import type { ReceiptState } from './stack-state';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Where a wait reports its progress. The default drives a timed spinner. */
export interface WaitReporter {
  start(text: string): void;
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  /** warnings that do not change the outcome (unhealthy unchanged workloads) */
  warn(message: string): void;
  /** `--debug` lines, already redacted */
  debug(line: string): void;
}

export function spinnerReporter(): WaitReporter {
  const spinner = createTimedSpinner();
  return {
    start: (text) => spinner.start(text),
    update: (text) => spinner.update(text),
    succeed: (text) => spinner.succeed(text),
    fail: (text) => spinner.fail(text),
    warn: (message) => printWarning(message),
    debug: (line) => printDebug(line),
  };
}

export interface StackWaitDeps {
  /** bound to the control plane */
  kubectl: KubeExecutor;
  clock: Clock;
  /** the bundle Redactor: every failure message and debug line goes through it */
  redactor: Redactor;
  distribution: K8sDistribution;
  /** Kubernetes node name -> servers.yml key (see nodeNameMap) */
  nodeNames: Readonly<Record<string, string>>;
  /** a fresh spinnerReporter() per wait when absent */
  reporter?: WaitReporter;
  /** `--debug`: failing pods' last log lines are read and reported; default isVerbose() */
  debug?: boolean;
}

/** A receipt and the bundle's private state of it; `state` is undefined for a receipt this bundle did not produce. */
export interface WaitSubject {
  receipt: DeployReceipt;
  state: ReceiptState | undefined;
}

/** servers.yml key of each Kubernetes node name, through the one naming rule of setup */
export function nodeNameMap(serverKeys: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of serverKeys) map[nodeNameFor(key)] = key;
  return map;
}

/**
 * A connectivity problem worth another poll: the API or the SSH connection did not answer. A
 * refused identity, a missing kubeconfig or a certificate mismatch never heal by waiting.
 */
export function isTransient(error: unknown): boolean {
  const kube = error instanceof OrchestratorUnavailableError && error.cause instanceof KubeError ? error.cause : error;
  return kube instanceof KubeError && (kube.reason === 'Unreachable' || kube.reason === 'Timeout');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const POLL_RESOURCES = ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps', 'replicasets.apps', 'jobs.batch', 'pods'];
const REVISIONS = 'controllerrevisions.apps';
const LB_SUFFIX = '-lb';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function namesOf(targets: readonly { service: string }[]): string {
  return unique(targets.map((t) => t.service)).join(', ');
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function uidOf(object: { kind: string; metadata: { name: string; uid?: string } }): string {
  return object.metadata.uid ?? `${object.kind}/${object.metadata.name}`;
}

function byName(a: { metadata: { name: string } }, b: { metadata: { name: string } }): number {
  return a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0;
}

/** `P/service` label value of a `-lb` target: the Service is `<label>-lb` */
function lbServiceLabel(target: LbWatchTarget): string {
  return target.name.endsWith(LB_SUFFIX) ? target.name.slice(0, -LB_SUFFIX.length) : target.name;
}

function evaluationContext(deps: StackWaitDeps, role: StackRole, env: string, namespace: string, timeoutS: number): EvaluationContext {
  return {
    importedPrefix: `${K8S_IMPORTED_IMAGE_REGISTRY}/`,
    nodeNames: { ...deps.nodeNames },
    role,
    env,
    namespace,
    timeoutS,
  };
}

/** A refused read: what the error maps to. Errors that are neither a KubeError nor a CLIError propagate. */
function refusedRead(error: unknown, deps: StackWaitDeps, env: string, operation: string): CLIError {
  if (error instanceof KubeError) {
    return kubeErrorToCliError(error, { env, operation, mutating: false, distribution: deps.distribution.traits.name });
  }
  if (error instanceof CLIError) return error;
  throw error;
}

function lostContactMessage(error: unknown, deps: StackWaitDeps, activity: string): string {
  return `Lost contact with the Kubernetes API on ${deps.kubectl.node.name} while ${activity}: ${deps.redactor.redact(errorText(error))}`;
}

function statusSuggestion(env: string): string {
  return `Run \`dockflow status ${env}\`.`;
}

interface PollStop {
  message: string;
  suggestion: string | undefined;
  /** what the spinner shows */
  headline: string;
}

/**
 * One failed read of a polling loop (R7): a non-transient error ends the loop with its own message,
 * a transient one is absorbed up to K8S_TRANSPORT_FAILURES_TOLERATED consecutive times (null).
 */
function pollFailure(error: unknown, consecutive: number, deps: StackWaitDeps, env: string, operation: string, activity: string): PollStop | null {
  if (!isTransient(error)) {
    const cli = refusedRead(error, deps, env, operation);
    const message = deps.redactor.redact(cli.message);
    return { message, suggestion: cli.suggestion, headline: message };
  }
  if (consecutive <= K8S_TRANSPORT_FAILURES_TOLERATED) return null;
  return { message: lostContactMessage(error, deps, activity), suggestion: statusSuggestion(env), headline: 'Lost contact with the Kubernetes API' };
}

/** Polling cadence of design-03 9.6: 2 s, then one second more per poll up to the interval. */
class Cadence {
  private delayS: number;
  private readonly ceilingS: number;

  constructor(intervalS: number) {
    this.ceilingS = Math.max(1, intervalS);
    this.delayS = Math.min(K8S_POLL_INITIAL_S, this.ceilingS);
  }

  get currentMs(): number {
    return this.delayS * 1000;
  }

  grow(): void {
    this.delayS = Math.min(this.delayS + 1, this.ceilingS);
  }
}

// ---------------------------------------------------------------------------
// Reads (K12, K09, K13, K13b, K14)
// ---------------------------------------------------------------------------

function pollResources(kinds: readonly WorkloadKind[], withServices: boolean): string[] {
  const resources = [...POLL_RESOURCES];
  if (kinds.some((kind) => kind === 'StatefulSet' || kind === 'DaemonSet')) resources.push(REVISIONS);
  if (withServices) resources.push('services');
  return resources;
}

/** K12 (+ K09 when a Pending pod waits for a claim): one namespace read per poll (R5). */
async function poll(
  deps: StackWaitDeps,
  namespace: string,
  role: StackRole,
  targets: readonly WatchTarget[],
  lb: readonly LbWatchTarget[],
  wantPvcs: boolean,
): Promise<PollSnapshot> {
  const services = unique([...targets.map((t) => t.serviceLabel), ...lb.map(lbServiceLabel)]);
  const items = await deps.kubectl.getJson<PollObject>(pollResources(targets.map((t) => t.kind), lb.length > 0), {
    namespace,
    selector: SEL_POD(namespace, role, services),
  });
  const pvcs = wantPvcs
    ? await deps.kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace, selector: SEL_ROLE(namespace, role) })
    : null;
  return pollSnapshot(items, pvcs);
}

/** K13: the Warning events of the namespace; enrichment is best effort, so a failed read attaches nothing. */
async function warningEvents(deps: StackWaitDeps, namespace: string): Promise<Event[]> {
  try {
    const result = await deps.kubectl.run({
      args: ['get', 'events', '--field-selector=type=Warning', '-o', 'json'],
      namespace,
      mutating: false,
    });
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
      return (parsed as { items: Event[] }).items;
    }
    return [];
  } catch {
    return [];
  }
}

/** K13b: every Service of the cluster, reduced in pure code to the owner of a published port */
async function clusterServices(deps: StackWaitDeps): Promise<Service[]> {
  try {
    return await deps.kubectl.getJson<Service>(['services'], { allNamespaces: true });
  } catch {
    return [];
  }
}

function statusesOf(pod: Pod): ContainerStatus[] {
  return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
}

/** K14 with `--debug` only: the last lines of each failing container, redacted; a failed read is skipped. */
async function debugLogs(failed: readonly FailedVerdict[], snap: PollSnapshot, namespace: string, deps: StackWaitDeps, reporter: WaitReporter): Promise<void> {
  const uids = new Set(failed.flatMap((v) => v.podUids));
  for (const pod of snap.pods.filter((p) => uids.has(uidOf(p))).sort(byName)) {
    const failing = statusesOf(pod).filter((s) => !s.ready && s.state?.terminated?.exitCode !== 0);
    for (const status of failing) {
      const args = ['logs', pod.metadata.name, '-c', status.name, `--tail=${K8S_DEBUG_LOG_LINES}`];
      if (latestCrashIsPreviousRun(status)) args.push('--previous');
      try {
        const result = await deps.kubectl.run({ args, namespace, mutating: false, allowFailure: true });
        if (result.exitCode !== 0) continue;
        reporter.debug(`Last log lines of ${pod.metadata.name}/${status.name}:`);
        for (const line of result.stdout.split(/\r?\n/)) {
          if (line.trim() !== '') reporter.debug(`  ${deps.redactor.redact(line)}`);
        }
      } catch {
        // logs are a debugging aid; the failure stands without them
      }
    }
  }
}

/** design-03 9.5: K13 for pod and workload failures, K13b for LoadBalancerPending, K14 with --debug. */
async function enrich(
  failed: readonly FailedVerdict[],
  snap: PollSnapshot,
  namespace: string,
  deps: StackWaitDeps,
  reporter: WaitReporter,
): Promise<ServiceFailure[]> {
  const events = failed.some((v) => v.loadBalancer === null) ? await warningEvents(deps, namespace) : [];
  const services = failed.some((v) => v.loadBalancer !== null) ? await clusterServices(deps) : [];
  const failures = failed.map((v) =>
    v.loadBalancer === null ? enrichFailure(v, events, deps.redactor) : enrichLoadBalancerFailure(v, services, deps.redactor),
  );
  if (deps.debug ?? isVerbose()) await debugLogs(failed, snap, namespace, deps, reporter);
  return failures;
}

// ---------------------------------------------------------------------------
// waitConvergence (design-03 9)
// ---------------------------------------------------------------------------

/**
 * Waits until every workload the receipt changed has rolled out and every `-lb` Service it
 * created or changed has an address (K19). Fails fast on the classifier's signals, ends at the
 * deadline with one Timeout failure per pending target, and never throws.
 */
export async function waitConvergence(subject: WaitSubject, options: WaitOptions, deps: StackWaitDeps): Promise<ConvergenceResult> {
  const { receipt, state } = subject;
  let reporter: WaitReporter | null = null;
  try {
    const targets = state === undefined || receipt.skipped ? [] : receipt.changes.map((c) => watchTarget(c, state.applied));
    const lb: LbWatchTarget[] = state === undefined || receipt.skipped ? [] : state.lbWatch;
    if (state === undefined || (targets.length === 0 && lb.length === 0)) return { status: 'converged', failures: [] };

    const { env, role } = receipt.ref;
    const namespace = state.namespace;
    const names = namesOf([...targets, ...lb]);
    const context = evaluationContext(deps, role, env, namespace, options.timeoutS);
    const startMs = deps.clock.now().getTime();
    const deadline = new Date(startMs + options.timeoutS * 1000);
    const cadence = new Cadence(options.intervalS);
    let watch: WatchState = { firstSeen: {} };
    let transportFailures = 0;
    let wantPvcs = false;
    const active = deps.reporter ?? spinnerReporter();
    reporter = active;
    active.start(`Waiting for ${names}...`);

    for (;;) {
      let snap: PollSnapshot;
      try {
        snap = await poll(deps, namespace, role, targets, lb, wantPvcs);
        transportFailures = 0;
      } catch (error) {
        transportFailures += 1;
        const stop = pollFailure(error, transportFailures, deps, env, `watch the rollout of ${names}`, `waiting for ${names}`);
        if (stop !== null) {
          reporter = null;
          active.fail(stop.headline);
          return { status: 'timeout', failures: [], message: stop.message, suggestion: stop.suggestion };
        }
        await deps.clock.sleep(cadence.currentMs);
        continue;
      }

      const now = deps.clock.now();
      const evaluation = evaluateConvergence(targets, lb, snap, watch, now, context);
      watch = evaluation.state;
      const step = convergenceStep(evaluation, targets, lb, now, deadline, context);
      const elapsedS = seconds(now.getTime() - startMs);
      if (step.status === 'failed') {
        const failures = await enrich(step.failed, snap, namespace, deps, active);
        const text = failures.map((f) => f.message).join('; ');
        reporter = null;
        active.fail(text);
        return { status: 'failed', failures, message: text, suggestion: step.failed[0].suggestion };
      }
      if (step.status === 'converged') {
        reporter = null;
        active.succeed(`${names} ready (${elapsedS}s)`);
        return { status: 'converged', failures: [] };
      }
      if (step.status === 'timeout') {
        const failures = await enrich(step.failed, snap, namespace, deps, active);
        reporter = null;
        active.fail(`Timed out after ${options.timeoutS}s`);
        return {
          status: 'timeout',
          failures,
          message: failures.map((f) => f.message).join('; '),
          suggestion: `Run \`dockflow diagnose ${env}\`.`,
        };
      }
      wantPvcs = step.wantPvcs;
      active.update(`Waiting: ${progressLine(targets, lb, evaluation.verdicts)} (${elapsedS}s)`);
      await deps.clock.sleep(Math.min(cadence.currentMs, deadline.getTime() - now.getTime()));
      cadence.grow();
    }
  } catch (error) {
    const message = `Waiting for ${receipt.ref.role} workloads failed: ${deps.redactor.redact(errorText(error))}`;
    reporter?.fail(message);
    return { status: 'failed', failures: [], message };
  }
}

// ---------------------------------------------------------------------------
// checkHealth (design-03 10)
// ---------------------------------------------------------------------------

function readyOf(w: WorkloadObject): { ready: number; desired: number } | null {
  switch (w.kind) {
    case 'Deployment':
    case 'StatefulSet':
      return { ready: w.status?.readyReplicas ?? 0, desired: w.spec.replicas ?? 1 };
    case 'DaemonSet':
      return { ready: w.status?.numberReady ?? 0, desired: w.status?.desiredNumberScheduled ?? 0 };
    case 'Job':
      return null;
  }
}

/** One read of the whole role (K12 without the service term); warnings only, a failed read is ignored. */
async function warnUnhealthyUnchanged(
  deps: StackWaitDeps,
  namespace: string,
  role: StackRole,
  env: string,
  changes: readonly WorkloadChange[],
  reporter: WaitReporter,
): Promise<void> {
  let items: PollObject[];
  try {
    items = await deps.kubectl.getJson<PollObject>(POLL_RESOURCES, { namespace, selector: SEL_POD(namespace, role) });
  } catch {
    return;
  }
  const changed = new Set(changes.map((c) => `${c.kind}/${c.name}`));
  const workloads = items.filter(
    (o): o is WorkloadObject => o.kind === 'Deployment' || o.kind === 'StatefulSet' || o.kind === 'DaemonSet',
  );
  for (const w of workloads.sort(byName)) {
    if (changed.has(`${w.kind}/${w.metadata.name}`)) continue;
    const counts = readyOf(w);
    if (counts === null || counts.ready >= counts.desired) continue;
    const service = composeServiceOf(w) ?? w.metadata.name;
    reporter.warn(`Service ${service} (unchanged by this deploy) has ${counts.ready}/${counts.desired} ready pod(s); run dockflow diagnose ${env}`);
  }
}

/**
 * Proves the changed workloads stay Ready with unchanged restart counts for `stabilityS` after
 * convergence. A failed read neither fails the check nor resets the stability window (R7).
 * Never throws; `rolledBack` is always false here.
 */
export async function checkHealth(subject: WaitSubject, options: HealthOptions, deps: StackWaitDeps): Promise<InternalHealthResult> {
  const { receipt, state } = subject;
  let reporter: WaitReporter | null = null;
  try {
    if (state === undefined || receipt.skipped) return { healthy: true, rolledBack: false, failures: [] };
    const changes = receipt.changes;
    const targets = changes.filter((c) => c.kind !== 'Job').map((c) => watchTarget(c, state.applied));
    if (targets.length === 0) return { healthy: true, rolledBack: false, failures: [] };

    const { env, role } = receipt.ref;
    const namespace = state.namespace;
    const names = namesOf(targets);
    const context = evaluationContext(deps, role, env, namespace, options.timeoutS);
    const deadline = new Date(deps.clock.now().getTime() + options.timeoutS * 1000);
    // at least three observations inside the window: t, t + window/2, t + window
    const pollEveryMs = Math.min(options.intervalS, Math.max(1, Math.floor(options.stabilityS / 2))) * 1000;
    let progress = initialHealthProgress();
    let transportFailures = 0;
    const active = deps.reporter ?? spinnerReporter();
    reporter = active;
    active.start(`Checking that ${names} stay healthy for ${options.stabilityS}s...`);
    await warnUnhealthyUnchanged(deps, namespace, role, env, changes, active);

    for (;;) {
      let snap: PollSnapshot;
      try {
        snap = await poll(deps, namespace, role, targets, [], false);
        transportFailures = 0;
      } catch (error) {
        transportFailures += 1;
        const stop = pollFailure(error, transportFailures, deps, env, `check the health of ${names}`, `checking ${names}`);
        if (stop !== null) {
          reporter = null;
          active.fail(stop.headline);
          return { healthy: false, rolledBack: false, failures: [], message: stop.message, suggestion: stop.suggestion };
        }
        await deps.clock.sleep(pollEveryMs);
        continue;
      }

      const now = deps.clock.now();
      const step = healthStep(targets, snap, progress, now, deadline, options.stabilityS, context);
      progress = step.progress;
      if (step.status === 'unhealthy') {
        const failures = await enrich(step.failed, snap, namespace, deps, active);
        const text = failures.map((f) => f.message).join('; ');
        reporter = null;
        active.fail(text);
        return { healthy: false, rolledBack: false, failures, message: text };
      }
      if (step.status === 'healthy') {
        reporter = null;
        active.succeed(`${names} stayed healthy for ${options.stabilityS}s`);
        return { healthy: true, rolledBack: false, failures: [] };
      }
      if (step.status === 'timeout') {
        const failures = await enrich(step.failed, snap, namespace, deps, active);
        reporter = null;
        active.fail(`Health check timed out after ${options.timeoutS}s`);
        return { healthy: false, rolledBack: false, failures, message: failures.map((f) => f.message).join('; ') };
      }
      await deps.clock.sleep(pollEveryMs);
    }
  } catch (error) {
    const message = `Health check failed: ${deps.redactor.redact(errorText(error))}`;
    reporter?.fail(message);
    return { healthy: false, rolledBack: false, failures: [], message };
  }
}

// ---------------------------------------------------------------------------
// Inventory poll (design-03 18.4-18.6): scale, restart and stop waits
// ---------------------------------------------------------------------------

export interface InventoryTarget {
  /** compose or Helm release name, as messages show it */
  service: string;
  kind: WorkloadKind;
  name: string;
  namespace: string;
}

export interface InventoryObservation {
  target: InventoryTarget;
  /** null while the workload is not found */
  workload: WorkloadObject | null;
  /**
   * Pods of the revision being rolled out, the ones the fail-fast classifier reads; null until the
   * controller observed the latest generation and produced that revision (K16)
   */
  currentPods: Pod[] | null;
  /** every pod owned by the workload (through its ReplicaSets for a Deployment), terminating ones included */
  pods: Pod[];
}

export type InventoryPredicate = (observation: InventoryObservation) => boolean;

export interface InventoryPollOptions {
  env: string;
  role: StackRole;
  timeoutS: number;
  /** ceiling of the 2 s growing cadence; default CONVERGENCE_INTERVAL_S */
  intervalS?: number;
  /** label selector of each namespace's read; a namespace without one is read whole */
  selectors?: Readonly<Record<string, string>>;
  /** end the wait on the classifier's signals (F1..F10) of the current pods; default true */
  failFast?: boolean;
}

export type InventoryPollResult =
  | { status: 'done'; observations: InventoryObservation[] }
  /** failure redacted; the classifier's suggestion */
  | { status: 'failed'; failure: ServiceFailure; suggestion: string; observations: InventoryObservation[] }
  /** `pending`: the targets the predicate still refused at the deadline */
  | { status: 'timeout'; pending: InventoryObservation[]; observations: InventoryObservation[] };

function generationObserved(w: WorkloadObject): boolean {
  return w.kind === 'Job' || (w.status?.observedGeneration ?? 0) >= (w.metadata.generation ?? 0);
}

function ownedBy(object: { metadata: { ownerReferences?: { uid: string }[] } }, uids: ReadonlySet<string>): boolean {
  return (object.metadata.ownerReferences ?? []).some((r) => uids.has(r.uid));
}

function findWorkload(target: InventoryTarget, snap: PollSnapshot): WorkloadObject | null {
  const named = <T extends { metadata: { name: string } }>(list: readonly T[]): T | null =>
    list.find((w) => w.metadata.name === target.name) ?? null;
  switch (target.kind) {
    case 'Deployment':
      return named(snap.deployments);
    case 'StatefulSet':
      return named(snap.statefulSets);
    case 'DaemonSet':
      return named(snap.daemonSets);
    case 'Job':
      return named(snap.jobs);
  }
}

function observe(target: InventoryTarget, snap: PollSnapshot): InventoryObservation {
  const workload = findWorkload(target, snap);
  if (workload === null) return { target, workload: null, currentPods: null, pods: [] };
  const owners = new Set([uidOf(workload)]);
  if (workload.kind === 'Deployment') {
    for (const rs of snap.replicaSets) if (ownedBy(rs, owners)) owners.add(uidOf(rs));
  }
  const pods = snap.pods.filter((p) => ownedBy(p, owners)).sort(byName);
  const current = generationObserved(workload) && workload.metadata.deletionTimestamp === undefined ? currentPods(workload, snap) : null;
  return { target, workload, currentPods: current, pods };
}

async function readInventory(
  deps: StackWaitDeps,
  targets: readonly InventoryTarget[],
  selectors: Readonly<Record<string, string>>,
): Promise<Map<string, PollSnapshot>> {
  const snaps = new Map<string, PollSnapshot>();
  for (const namespace of unique(targets.map((t) => t.namespace)).sort()) {
    const kinds = targets.filter((t) => t.namespace === namespace).map((t) => t.kind);
    const selector = Object.hasOwn(selectors, namespace) ? selectors[namespace] : undefined;
    const items = await deps.kubectl.getJson<PollObject>(pollResources(kinds, false), {
      namespace,
      ...(selector !== undefined ? { selector } : {}),
    });
    snaps.set(namespace, pollSnapshot(items));
  }
  return snaps;
}

/**
 * Polls the targets' namespaces (one read each per poll) on the 2 s growing cadence until
 * `predicate` holds for every target, the classifier finds a fatal signal on a current pod, or the
 * deadline passes. Throws what a refused read maps to (`kubeErrorToCliError`), or
 * OrchestratorUnavailableError once more than K8S_TRANSPORT_FAILURES_TOLERATED consecutive reads
 * lost the API.
 */
export async function pollInventoryUntil(
  targets: readonly InventoryTarget[],
  predicate: InventoryPredicate,
  options: InventoryPollOptions,
  deps: StackWaitDeps,
): Promise<InventoryPollResult> {
  if (targets.length === 0) return { status: 'done', observations: [] };
  const names = namesOf(targets);
  const startMs = deps.clock.now().getTime();
  const deadlineMs = startMs + options.timeoutS * 1000;
  const cadence = new Cadence(options.intervalS ?? CONVERGENCE_INTERVAL_S);
  const failFast = options.failFast ?? true;
  let watch: WatchState = { firstSeen: {} };
  let transportFailures = 0;

  for (;;) {
    let snaps: Map<string, PollSnapshot>;
    try {
      snaps = await readInventory(deps, targets, options.selectors ?? {});
      transportFailures = 0;
    } catch (error) {
      if (!isTransient(error)) throw refusedRead(error, deps, options.env, `wait for ${names}`);
      transportFailures += 1;
      if (transportFailures > K8S_TRANSPORT_FAILURES_TOLERATED) {
        throw new OrchestratorUnavailableError(
          lostContactMessage(error, deps, `waiting for ${names}`),
          statusSuggestion(options.env),
          error instanceof Error ? error : undefined,
        );
      }
      await deps.clock.sleep(cadence.currentMs);
      continue;
    }

    const now = deps.clock.now();
    const observations = targets.map((t) => observe(t, snaps.get(t.namespace) ?? pollSnapshot([])));
    if (failFast) {
      const seen: Record<string, string> = {};
      let failed: FailedVerdict | null = null;
      for (const observation of observations) {
        if (observation.currentPods === null) continue;
        const { target } = observation;
        const snap = snaps.get(target.namespace) ?? pollSnapshot([]);
        const context = evaluationContext(deps, options.role, options.env, target.namespace, options.timeoutS);
        const classified = classifyPods(target.service, observation.currentPods, snap, watch, now, context);
        Object.assign(seen, classified.firstSeen);
        failed ??= classified.failed;
      }
      watch = { firstSeen: seen };
      if (failed !== null) {
        return { status: 'failed', failure: redactFailure(failed.failure, deps.redactor), suggestion: failed.suggestion, observations };
      }
    }
    if (observations.every(predicate)) return { status: 'done', observations };
    if (now.getTime() >= deadlineMs) return { status: 'timeout', pending: observations.filter((o) => !predicate(o)), observations };
    await deps.clock.sleep(Math.min(cadence.currentMs, deadlineMs - now.getTime()));
    cadence.grow();
  }
}

function liveCount(pods: readonly Pod[]): number {
  return pods.filter((p) => p.metadata.deletionTimestamp === undefined && p.status?.phase !== 'Failed' && p.status?.phase !== 'Succeeded')
    .length;
}

/**
 * scale (18.5): the controller observed the change, `readyReplicas` (omitted when 0) equals the
 * target and exactly that many pods are not terminating. DaemonSets and Jobs never scale.
 */
export function scaledTo(replicas: number): InventoryPredicate {
  return ({ workload, pods }) => {
    if (workload === null || (workload.kind !== 'Deployment' && workload.kind !== 'StatefulSet')) return false;
    return generationObserved(workload) && (workload.status?.readyReplicas ?? 0) === replicas && liveCount(pods) === replicas;
  };
}

/** restart (18.6): the latest template is rolled out on every replica; every counter read with `?? 0`. */
export function rolledOut(): InventoryPredicate {
  return ({ workload }) => {
    if (workload === null) return false;
    if (!generationObserved(workload)) return false;
    switch (workload.kind) {
      case 'Deployment': {
        const desired = workload.spec.replicas ?? 1;
        const status = workload.status;
        return (
          (status?.updatedReplicas ?? 0) === desired && (status?.readyReplicas ?? 0) === desired && (status?.replicas ?? 0) === desired
        );
      }
      case 'StatefulSet': {
        const status = workload.status;
        return status?.currentRevision === status?.updateRevision && (status?.readyReplicas ?? 0) === (workload.spec.replicas ?? 1);
      }
      case 'DaemonSet': {
        const desired = workload.status?.desiredNumberScheduled ?? 0;
        return (workload.status?.updatedNumberScheduled ?? 0) === desired && (workload.status?.numberReady ?? 0) === desired;
      }
      case 'Job':
        return true;
    }
  };
}

/** stop (18.4): no pod of the target remains, terminating ones included. */
export function podsGone(): InventoryPredicate {
  return ({ pods }) => pods.length === 0;
}

/** Where a target that did not reach its state stands, for the timeout messages of 18.4-18.6. */
export function inventorySummary(observation: InventoryObservation): string {
  const { workload, target } = observation;
  if (workload === null) return `${target.kind.toLowerCase()}/${target.name} was not found`;
  if (!generationObserved(workload)) return 'waiting for the controller';
  if (observation.currentPods === null) return 'waiting for the new revision';
  const unready = observation.currentPods.find(
    (p) => !(p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
  );
  if (unready !== undefined) return `pod ${unready.metadata.name} is ${podStateText(unready)}`;
  const counts = readyOf(workload);
  if (counts === null) return `${liveCount(observation.pods)} pod(s) running`;
  return `${counts.ready}/${counts.desired} ready`;
}
