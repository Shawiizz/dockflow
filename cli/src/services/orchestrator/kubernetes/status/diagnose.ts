// Pure DiagnosticReport builder for `dockflow diagnose` on Kubernetes (design-06 3.10) and the
// error pattern matcher shared with Swarm. The backend performs the reads and passes their outcome
// here; a failed read becomes a warning line of its section, never an exception. No I/O, no clock.

import type { Result } from '../../../../types/result';
import type { Redactor } from '../../../../utils/redact';
import type {
  DiagnosticIssue,
  DiagnosticLineLevel,
  DiagnosticReport,
  HelmReleaseStatus,
  InstanceInfo,
  ProxyStatus,
  ServiceInfo,
} from '../../interfaces';
import { ANNOTATIONS, K8S_IMPORTED_IMAGE_REGISTRY, K8S_SYSTEM_NAMESPACE, KUBE_KEYS, LABELS } from '../constants';
import type { Event, Namespace, Node, PersistentVolumeClaim, Pod } from '../resources/core';
import { timestampKey } from './logs';
import {
  formatAge,
  instanceLabel,
  type InventoryView,
  isHelperPod,
  isUnscheduled,
  latestCrashIsPreviousRun,
  orderInstanceTable,
  podCondition,
  podDisplayStatus,
  podOwner,
  type RevisionIndex,
  toInstanceInfo,
  type WorkloadObject,
} from './pods';
import { toServiceInfos } from './services';

// ---------------------------------------------------------------------------
// Error patterns (shared matcher: Kubernetes rows first, then Swarm's)
// ---------------------------------------------------------------------------

interface ErrorPattern {
  pattern: RegExp;
  /** a second condition the text must also meet */
  requires?: RegExp;
  suggestion: string | ((match: RegExpMatchArray) => string);
}

const IMPORTED_IMAGE = new RegExp(`${K8S_IMPORTED_IMAGE_REGISTRY.replace(/\./g, '\\.')}/`, 'i');

const KUBERNETES_PATTERNS: readonly ErrorPattern[] = [
  {
    pattern: /ErrImageNeverPull|ErrImagePull|ImagePullBackOff/i,
    requires: IMPORTED_IMAGE,
    suggestion: 'The image built by Dockflow is missing on that node; import it again with: `dockflow deploy <env>`.',
  },
  {
    // "not found" alone would shadow the CreateContainerConfigError row below
    pattern: /ErrImagePull|ImagePullBackOff|manifest unknown|\bimage\b.*\bnot found/i,
    suggestion: 'Check the image name and tag; for a private registry, check the registry credentials in config.yml.',
  },
  {
    pattern: /InvalidImageName/i,
    suggestion: 'Fix `image:` in docker-compose.yml; the reference is not a valid image name.',
  },
  {
    pattern: /CreateContainerConfigError.*(secret|configmap).*not found/i,
    suggestion: 'A Secret or ConfigMap Dockflow created is missing; run `dockflow deploy <env>` again.',
  },
  {
    pattern: /OOMKilled/i,
    suggestion: 'Raise `deploy.resources.limits.memory` for this service; the container ran out of memory.',
  },
  {
    pattern: /Insufficient (cpu|memory)/i,
    suggestion: 'Lower `deploy.resources.reservations` or add nodes; the request exceeds the free node capacity.',
  },
  {
    pattern: /didn't match Pod's node affinity\/selector|node\(s\) didn't match/i,
    suggestion: 'Check the placement constraints (`node.hostname`, `node.labels`, `x-dockflow.node_selector`); no node matches them.',
  },
  {
    pattern: /volume node affinity conflict/i,
    suggestion: 'Start or uncordon the node holding the volume; local volumes cannot move between nodes.',
  },
  {
    pattern: /untolerated taint/i,
    suggestion: 'Add workers, or declare `x-dockflow.tolerations` for the tainted nodes.',
  },
  {
    pattern: /Liveness probe failed|Readiness probe failed|Startup probe failed/i,
    suggestion: 'Run the healthcheck yourself with: `dockflow exec <env> <service> -- <command>`.',
  },
  {
    pattern: /ProgressDeadlineExceeded/i,
    suggestion: 'Read the Pod Errors section above; the rollout did not progress.',
  },
  {
    pattern: /exec format error/i,
    suggestion: 'Image architecture mismatch. Rebuild for the correct platform (linux/amd64 or linux/arm64).',
  },
  {
    pattern: /permission denied/i,
    suggestion: 'Check file ownership on volumes and bind mounts; set `user:` or `x-dockflow.fs_group`.',
  },
  {
    pattern: /no space left on device/i,
    suggestion: 'Free disk space with: `dockflow prune <env> --images --all`.',
  },
  {
    pattern: /cannot re-use a name that is still in use/i,
    suggestion: 'Check the release with: `dockflow helm status <env> <release>`; a previous Helm operation did not finish.',
  },
];

// Swarm's table as it was; its permission, disk and architecture rows are shadowed by the rows above.
const SWARM_PATTERNS: readonly ErrorPattern[] = [
  {
    pattern: /bind source path does not exist:\s*(\S+)/i,
    suggestion: (m) => `Create the directory on the server: mkdir -p ${m[1]}`,
  },
  {
    pattern: /no such image|image not found/i,
    suggestion: 'The Docker image may not have been pushed. Try redeploying.',
  },
  {
    pattern: /port is already allocated|address already in use/i,
    suggestion: 'Another service is using this port. Check running containers with: docker ps',
  },
  {
    pattern: /\boom\b|out of memory/i,
    suggestion: 'Container ran out of memory. Increase memory limits or reduce memory usage.',
  },
  {
    pattern: /network .+ not found/i,
    suggestion: 'Docker network may have been removed. Try redeploying the stack.',
  },
];

export const ERROR_PATTERNS: readonly ErrorPattern[] = [...KUBERNETES_PATTERNS, ...SWARM_PATTERNS];

export const KUBERNETES_FALLBACK_SUGGESTION =
  'Inspect it with `dockflow logs <env> <service> --all-tasks` and `dockflow diagnose <env> --verbose`.';
export const SWARM_FALLBACK_SUGGESTION = 'Check Docker logs for more details: docker service logs <service_name>';

export interface ErrorContext {
  /** which fallback applies when no row matches */
  source: 'swarm' | 'kubernetes';
  env: string;
  /** compose service or Helm release the text is about; placeholders stay when unknown */
  service?: string;
}

function fillPlaceholders(text: string, context: ErrorContext): string {
  const withEnv = text.replaceAll('<env>', context.env);
  if (context.service === undefined) return withEnv;
  return withEnv.replaceAll('<service>', context.service).replaceAll('<release>', context.service);
}

/** Suggestion for an error text: the first matching row, else the orchestrator's fallback. */
export function analyzeError(text: string, context: ErrorContext): string {
  for (const row of ERROR_PATTERNS) {
    const match = text.match(row.pattern);
    if (!match || (row.requires && !row.requires.test(text))) continue;
    return fillPlaceholders(typeof row.suggestion === 'function' ? row.suggestion(match) : row.suggestion, context);
  }
  const fallback = context.source === 'swarm' ? SWARM_FALLBACK_SUGGESTION : KUBERNETES_FALLBACK_SUGGESTION;
  return fillPlaceholders(fallback, context);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface DiagnoseHelmRelease extends HelmReleaseStatus {
  /** description of the last revision (`helm history`), when read */
  description?: string | null;
}

export interface DiagnoseHostFacts {
  /** `df -P / | tail -1` */
  rootDisk: Result<string, string>;
  /** `df -P <volume root> 2>/dev/null | tail -1`; empty when the directory does not exist */
  volumeDisk: Result<string, string> | null;
  /** `free -m | awk ...`: the used memory percentage */
  memory: Result<string, string>;
}

export interface CrashLogExcerpt {
  /** instance label */
  label: string;
  container: string;
  previous: boolean;
  /** container output; user-requested, not redacted */
  lines: string[];
}

export interface PodDescription {
  label: string;
  /** `describe pod` text, redacted here */
  text: string;
}

export interface DiagnoseInput {
  env: string;
  namespace: string;
  /** step 1: null when the namespace does not exist */
  namespaceObject: Namespace | null;
  /** current app release, when known */
  currentRelease: string | null;
  verbose: boolean;
  inventory: Result<InventoryView, string>;
  /** revisions read; null when it was not read */
  revisions: RevisionIndex | null;
  helmReleases: Result<DiagnoseHelmRelease[], string>;
  /** Warning events of the namespace */
  events: Result<Event[], string>;
  nodes: Result<Node[], string>;
  /** null when the proxy is disabled */
  proxy: Result<ProxyStatus, string> | null;
  crashLogs: CrashLogExcerpt[];
  descriptions: PodDescription[];
  host: DiagnoseHostFacts;
  nodeToServer: ReadonlyMap<string, string>;
  redactor: Redactor;
}

// ---------------------------------------------------------------------------
// Verbose targets (step 7)
// ---------------------------------------------------------------------------

export const CRASH_LOG_CONTAINERS = 5;
export const CRASH_LOG_LINES = 20;
export const DESCRIBED_PODS = 3;

export interface CrashLogTarget {
  pod: string;
  container: string;
  label: string;
  /** read `--previous` first (the container restarted and runs again) */
  previous: boolean;
}

function sortedPods(inventory: InventoryView): Pod[] {
  return [...inventory.pods].sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0));
}

function labelOf(pod: Pod, inventory: InventoryView): string | null {
  const owner = podOwner(pod, inventory);
  return owner ? instanceLabel({ id: pod.metadata.name, service: owner.service }, owner.name) : null;
}

/** Up to 5 containers that restarted or crash-loop, for the Crash Logs section. */
export function crashLogTargets(inventory: InventoryView): CrashLogTarget[] {
  const targets: CrashLogTarget[] = [];
  for (const pod of sortedPods(inventory)) {
    const label = labelOf(pod, inventory);
    if (label === null) continue;
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    for (const c of statuses) {
      if (c.restartCount === 0 && c.state?.waiting?.reason !== 'CrashLoopBackOff') continue;
      targets.push({ pod: pod.metadata.name, container: c.name, label, previous: latestCrashIsPreviousRun(c) });
      if (targets.length === CRASH_LOG_CONTAINERS) return targets;
    }
  }
  return targets;
}

/** Up to 3 pods of severity error, for the Describe section. */
export function describeTargets(inventory: InventoryView): { pod: string; label: string }[] {
  const targets: { pod: string; label: string }[] = [];
  for (const pod of sortedPods(inventory)) {
    const label = labelOf(pod, inventory);
    if (label === null || podDisplayStatus(pod).severity !== 'error') continue;
    targets.push({ pod: pod.metadata.name, label });
    if (targets.length === DESCRIBED_PODS) break;
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const MAX_POD_ERRORS = 10;
export const MAX_RECENT_EVENTS = 15;
export const RECENT_EVENTS_WINDOW_S = 15 * 60;

const SELECTED_NODE_ANNOTATION = 'volume.kubernetes.io/selected-node';
const CONTROL_PLANE_ROLE_LABEL = 'node-role.kubernetes.io/control-plane';
const NODE_PRESSURES = ['DiskPressure', 'MemoryPressure', 'PIDPressure'] as const;
const VOLUME_EVENT_REASONS = new Set(['FailedMount', 'FailedAttachVolume', 'ProvisioningFailed']);
const DISK_ERROR_PERCENT = 90;
const DISK_WARNING_PERCENT = 80;
const MEMORY_WARNING_PERCENT = 80;
const MEMORY_ISSUE_PERCENT = 90;

type ReportLine = DiagnosticReport['sections'][number]['lines'][number];

class Section {
  readonly lines: ReportLine[] = [];

  constructor(readonly title: string) {}

  add(level: DiagnosticLineLevel, text: string): void {
    this.lines.push({ text, level });
  }
}

class ReportBuilder {
  private readonly sections: Section[] = [];
  readonly issues: DiagnosticIssue[] = [];

  section(title: string): Section {
    const section = new Section(title);
    this.sections.push(section);
    return section;
  }

  issue(severity: DiagnosticIssue['severity'], category: string, message: string, suggestion?: string): void {
    this.issues.push(suggestion === undefined ? { severity, category, message } : { severity, category, message, suggestion });
  }

  build(): DiagnosticReport {
    return { sections: this.sections.map((s) => ({ title: s.title, lines: s.lines })), issues: this.issues };
  }
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function eventTimestamp(event: Event): string | null {
  return event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? null;
}

function eventSeconds(event: Event): number | null {
  const ts = eventTimestamp(event);
  const key = ts === null ? null : timestampKey(ts);
  return key === null ? null : key[0] + key[1] / 1e9;
}

function eventsAbout(events: readonly Event[], kind: string, name: string): Event[] {
  return events.filter((e) => e.involvedObject?.kind === kind && e.involvedObject.name === name);
}

interface Context {
  input: DiagnoseInput;
  now: Date;
  report: ReportBuilder;
  events: readonly Event[];
  errorContext(service?: string): ErrorContext;
  redact(text: string): string;
}

function podAnalysisText(pod: Pod, info: InstanceInfo, ctx: Context): string {
  const parts: string[] = [info.status, info.error ?? ''];
  for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    parts.push(c.state?.waiting?.reason ?? '', c.state?.waiting?.message ?? '');
    parts.push(c.state?.terminated?.reason ?? '', c.lastState?.terminated?.reason ?? '');
  }
  parts.push(podCondition(pod, 'PodScheduled')?.message ?? '');
  for (const e of eventsAbout(ctx.events, 'Pod', pod.metadata.name)) parts.push(e.reason ?? '', e.message ?? '');
  return ctx.redact(parts.filter((p) => p !== '').join(' '));
}

// --- Stack Status ------------------------------------------------------------

/** false when the report ends here */
function stackStatus(ctx: Context): boolean {
  const { input, report } = ctx;
  const section = report.section('Stack Status');
  const ns = input.namespaceObject;
  if (ns === null) {
    section.add('error', `Namespace ${input.namespace} does not exist`);
    report.issue('error', 'Stack', 'Stack not found', `Deploy the stack with: \`dockflow deploy ${input.env}\`.`);
    return false;
  }
  if (ns.status?.phase === 'Terminating') {
    section.add('error', `Namespace ${input.namespace} is being deleted`);
    const finalizers = [...new Set([...(ns.spec?.finalizers ?? []), ...(ns.metadata.finalizers ?? [])])];
    if (finalizers.length > 0) section.add('plain', `  Finalizers: ${finalizers.join(', ')}`);
    report.issue(
      'error',
      'Stack',
      `Namespace ${input.namespace} is being deleted`,
      `Wait for the deletion to finish, then deploy again with: \`dockflow deploy ${input.env}\`.`,
    );
    return true;
  }
  const release = input.currentRelease ? ` (app release ${input.currentRelease})` : '';
  section.add('ok', `Namespace ${input.namespace} exists${release}`);
  return true;
}

// --- Services and rollouts ---------------------------------------------------

function serviceDisplay(s: ServiceInfo): string {
  const tags = [s.role === 'accessory' ? 'accessory' : null, s.kind === 'helm' ? 'helm' : null].filter((t) => t !== null);
  return tags.length > 0 ? `${s.name} (${tags.join(', ')})` : s.name;
}

function servicesSection(ctx: Context, inventory: InventoryView, helm: readonly HelmReleaseStatus[]): void {
  const { report } = ctx;
  const section = report.section('Services');
  const rows = [...toServiceInfos(inventory, 'app', helm), ...toServiceInfos(inventory, 'accessory', helm)];
  if (rows.length === 0) {
    section.add('plain', 'No services');
    return;
  }
  for (const s of rows) {
    const { running, desired } = s.replicas;
    const name = serviceDisplay(s);
    const subject = s.kind === 'helm' ? `Helm release '${s.name}'` : `Service '${s.name}'`;
    if (s.mode === 'job') {
      const text = `${name}: ${running}/${desired} completions`;
      if (s.state === 'degraded') {
        section.add('error', text);
        report.issue('error', 'Replicas', `${subject} has ${running}/${desired} completions`, 'Check the pod errors below.');
      } else {
        section.add(s.state === 'running' ? 'ok' : 'pending', text);
      }
      continue;
    }
    const text = `${name}: ${running}/${desired} replicas`;
    if (running === 0 && desired > 0) {
      section.add('error', text);
      report.issue('error', 'Replicas', `${subject} has ${running}/${desired} replicas`, 'Check the pod errors below.');
    } else if (running < desired) {
      section.add('warning', text);
      report.issue('warning', 'Replicas', `${subject} has ${running}/${desired} replicas`);
    } else {
      section.add('ok', text);
    }
  }
}

function workloadSubject(object: WorkloadObject, inventory: InventoryView): { name: string; subject: string; service?: string } {
  for (const record of inventory.composeWorkloads.values()) {
    if (record.object === object) return { name: record.service, subject: `Service ${record.service}`, service: record.service };
  }
  const ref = `${object.kind.toLowerCase()}/${object.metadata.name}`;
  const release = inventory.helm.find((h) => h.workloads.some((w) => w.kind === object.kind && w.name === object.metadata.name));
  if (release) return { name: `${release.release} (${ref})`, subject: `Helm release ${release.release} (${ref})`, service: release.release };
  return { name: ref, subject: `Deployment ${object.metadata.name}` };
}

function rolloutsSection(ctx: Context, inventory: InventoryView): void {
  const { report } = ctx;
  const section = report.section('Rollouts');
  const deployments = inventory.workloads.filter((w) => w.kind === 'Deployment');
  if (deployments.length === 0) {
    section.add('plain', 'No Deployments');
    return;
  }
  const named = deployments.map((d) => ({ object: d, ...workloadSubject(d, inventory) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { object, name, subject, service } of named) {
    if (object.kind !== 'Deployment') continue;
    const conditions = object.status?.conditions ?? [];
    const stalled = conditions.find((c) => c.type === 'Progressing' && c.status === 'False');
    const replicaFailure = conditions.find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
    const deadline = object.spec.progressDeadlineSeconds ?? 600;
    if (stalled) {
      section.add('error', `${name}: ${stalled.reason ?? 'rollout stalled'} (${deadline}s)`);
      report.issue(
        'error',
        'Rollout',
        `${subject} did not finish its rollout within ${deadline}s`,
        analyzeError(ctx.redact(`${stalled.reason ?? ''} ${stalled.message ?? ''}`), ctx.errorContext(service)),
      );
    }
    if (replicaFailure) {
      const message = ctx.redact(oneLine(replicaFailure.message ?? replicaFailure.reason ?? 'ReplicaFailure'));
      section.add('error', `${name}: ReplicaFailure: ${message}`);
      report.issue('error', 'Rollout', `${subject}: ${message}`, analyzeError(message, ctx.errorContext(service)));
    }
    if (stalled || replicaFailure) continue;
    const desired = object.spec.replicas ?? 1;
    const updated = object.status?.updatedReplicas ?? 0;
    const observed = (object.status?.observedGeneration ?? 0) >= (object.metadata.generation ?? 0);
    const revision = object.metadata.annotations?.[KUBE_KEYS.deploymentRevision];
    if (!observed || updated < desired || (object.status?.replicas ?? 0) > updated) {
      section.add('pending', `${name}: rolling out (${updated}/${desired} updated)`);
    } else {
      section.add('ok', `${name}: rolled out${revision ? ` (revision ${revision})` : ''}`);
    }
  }
}

// --- Pods --------------------------------------------------------------------

interface PodEntry {
  pod: Pod;
  info: InstanceInfo;
}

function podEntries(ctx: Context, inventory: InventoryView): PodEntry[] {
  const byId = new Map<string, Pod>();
  const infos: InstanceInfo[] = [];
  for (const pod of inventory.pods) {
    const info = toInstanceInfo(pod, inventory, ctx.input.revisions, ctx.input.nodeToServer, ctx.input.redactor);
    if (!info) continue;
    byId.set(info.id, pod);
    infos.push(info);
  }
  return orderInstanceTable(infos).flatMap((info) => {
    const pod = byId.get(info.id);
    return pod ? [{ pod, info }] : [];
  });
}

function podErrorsSection(ctx: Context, entries: readonly PodEntry[]): void {
  const { report } = ctx;
  const section = report.section('Pod Errors');
  // unscheduled pods belong to Pending Pods
  const failing = entries.filter((e) => e.info.severity === 'error' && !isUnscheduled(e.pod));
  if (failing.length === 0) {
    section.add('ok', 'No pod errors found');
    return;
  }
  for (const { pod, info } of failing.slice(0, MAX_POD_ERRORS)) {
    section.add('error', `${info.label} (pod ${info.id}${info.node ? ` on ${info.node}` : ''})`);
    section.add('plain', `  State: ${info.status}${info.restarts === null ? '' : ` (restarts ${info.restarts})`}`);
    if (info.error) section.add('plain', `  Error: ${oneLine(info.error)}`);
    report.issue(
      'error',
      'Pod',
      `${info.label}: ${oneLine(info.error ?? info.status)}`,
      analyzeError(podAnalysisText(pod, info, ctx), ctx.errorContext(info.service)),
    );
  }
  if (failing.length > MAX_POD_ERRORS) section.add('dim', `... and ${failing.length - MAX_POD_ERRORS} more`);
}

function pendingPodsSection(ctx: Context, entries: readonly PodEntry[]): void {
  const { report } = ctx;
  const section = report.section('Pending Pods');
  const pending = entries.filter((e) => isUnscheduled(e.pod) || (e.pod.status?.phase === 'Pending' && e.info.severity !== 'error'));
  if (pending.length === 0) {
    section.add('plain', 'No pending pods');
    return;
  }
  const texts: string[] = [];
  for (const { pod, info } of pending) {
    const message = podCondition(pod, 'PodScheduled')?.message;
    section.add('pending', `${info.label}: ${message ? ctx.redact(oneLine(message)) : info.status}`);
    if (isUnscheduled(pod)) texts.push(podAnalysisText(pod, info, ctx));
  }
  if (texts.length > 0) {
    report.issue('warning', 'Scheduling', 'Some pods cannot be scheduled', analyzeError(texts.join(' '), ctx.errorContext(pending[0].info.service)));
  }
}

function helperPodsSection(ctx: Context, inventory: InventoryView): void {
  const helpers = sortedPods(inventory).filter(isHelperPod);
  if (helpers.length === 0) return;
  const section = ctx.report.section('Helper Pods');
  for (const pod of helpers) {
    const view = podDisplayStatus(pod);
    section.add(view.severity === 'ok' ? 'dim' : view.severity, `${pod.metadata.name}: ${view.status}`);
  }
}

// --- Volumes -----------------------------------------------------------------

/** Compose volume name first (K77), with the claim name when they differ: `db_data (pvc/db-data)`. */
function claimDisplay(claim: PersistentVolumeClaim): string {
  const name = claim.metadata.name;
  const compose = claim.metadata.annotations?.[ANNOTATIONS.composeVolume];
  return compose && compose !== name ? `${compose} (pvc/${name})` : name;
}

function claimLine(claim: PersistentVolumeClaim, ctx: Context): { level: DiagnosticLineLevel; text: string } {
  const name = claimDisplay(claim);
  const phase = claim.status?.phase;
  if (phase === 'Bound') {
    const capacity = claim.status?.capacity?.storage ?? claim.spec.resources.requests.storage;
    const node = claim.metadata.annotations?.[SELECTED_NODE_ANNOTATION];
    const on = node ? ` on ${ctx.input.nodeToServer.get(node) ?? node}` : '';
    return { level: 'ok', text: `${name} Bound ${capacity}${on}` };
  }
  if (phase === 'Lost') return { level: 'error', text: `${name} Lost` };
  return { level: 'warning', text: `${name} ${phase ?? 'Pending'}` };
}

/**
 * Compose service of a claim, so suggestions can name it: the `P/service` label a StatefulSet
 * claim gets from its selector, else the one service whose pods mount it (a top-level volume
 * carries no service label, as several services may share it).
 */
function claimService(claim: PersistentVolumeClaim, inventory: InventoryView): string | undefined {
  const serviceName = claim.metadata.labels?.[LABELS.service];
  if (serviceName !== undefined) {
    for (const record of inventory.composeWorkloads.values()) {
      if (record.serviceName === serviceName) return record.service;
    }
    return undefined;
  }
  const services = new Set<string>();
  for (const pod of inventory.pods) {
    if (!(pod.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === claim.metadata.name)) continue;
    const owner = podOwner(pod, inventory);
    if (owner) services.add(owner.service);
  }
  return services.size === 1 ? [...services][0] : undefined;
}

function volumesSection(ctx: Context, inventory: InventoryView, entries: readonly PodEntry[]): void {
  const { report } = ctx;
  const section = report.section('Volumes');
  const claims = [...inventory.claims].sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0));
  if (claims.length === 0) section.add('plain', 'No volumes');
  for (const claim of claims) {
    const line = claimLine(claim, ctx);
    section.add(line.level, line.text);
    if (claim.status?.phase === 'Bound') continue;
    const about = eventsAbout(ctx.events, 'PersistentVolumeClaim', claim.metadata.name);
    const text = ctx.redact(about.map((e) => `${e.reason ?? ''} ${e.message ?? ''}`).join(' '));
    const suggestion = analyzeError(text, ctx.errorContext(claimService(claim, inventory)));
    report.issue('warning', 'Volume', `Volume ${claimDisplay(claim)} is not bound`, suggestion);
  }
  const pods = new Map(entries.map((e) => [e.info.id, e.info]));
  const byName = new Map(claims.map((c) => [c.metadata.name, c]));
  const seen = new Set<string>();
  for (const event of ctx.events) {
    const target = event.involvedObject;
    if (!event.reason || !VOLUME_EVENT_REASONS.has(event.reason) || !target?.name) continue;
    const key = `${event.reason}/${target.kind}/${target.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const message = ctx.redact(oneLine(event.message ?? event.reason));
    const pod = target.kind === 'Pod' ? pods.get(target.name) : undefined;
    const claim = target.kind === 'Pod' ? undefined : byName.get(target.name);
    const subject = target.kind === 'Pod' ? (pod?.label ?? target.name) : `Volume ${claim ? claimDisplay(claim) : target.name}`;
    const service = pod?.service ?? (claim ? claimService(claim, inventory) : undefined);
    report.issue('error', 'Volume', `${subject}: ${message}`, analyzeError(message, ctx.errorContext(service)));
  }
}

// --- Helm, proxy, events -----------------------------------------------------

function helmSection(ctx: Context): void {
  const { input, report } = ctx;
  const releases = input.helmReleases;
  if (releases.success && releases.data.length === 0) return;
  const section = report.section('Helm Releases');
  if (!releases.success) {
    section.add('warning', `Could not list Helm releases: ${ctx.redact(releases.error)}`);
    return;
  }
  const sorted = [...releases.data].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const r of sorted) {
    const text = `${r.name}: ${r.status} (revision ${r.revision})`;
    const check = `Check it with: \`dockflow helm status ${input.env} ${r.name}\`.`;
    if (r.status === 'deployed') {
      section.add('ok', text);
    } else if (r.status === 'failed') {
      section.add('error', text);
      const description = r.description ? `: ${ctx.redact(oneLine(r.description))}` : '';
      report.issue('error', 'Helm', `Helm release ${r.name} failed${description}`, check);
    } else if (r.status.startsWith('pending-')) {
      section.add('error', text);
      report.issue('error', 'Helm', `Helm release ${r.name} is stuck in ${r.status}`, check);
    } else if (r.status === 'superseded' || r.status === 'uninstalled') {
      section.add('dim', text);
    } else {
      section.add('warning', text);
    }
  }
}

function proxySection(ctx: Context): void {
  const { input, report } = ctx;
  if (input.proxy === null) return;
  const section = report.section('Proxy');
  if (!input.proxy.success) {
    section.add('warning', `Could not read the proxy status: ${ctx.redact(input.proxy.error)}`);
    return;
  }
  const status = input.proxy.data;
  if (status.installed && status.ready) {
    section.add('ok', `Traefik ${status.version ? `${status.version} ` : ''}ready`);
  } else {
    const message = `Traefik is not ready in ${K8S_SYSTEM_NAMESPACE}`;
    section.add('error', status.detail ? `${message}: ${ctx.redact(status.detail)}` : message);
    report.issue('error', 'Proxy', message, `Reinstall it with: \`dockflow deploy ${input.env}\`.`);
  }
  for (const conflict of status.conflicts ?? []) section.add('warning', conflict);
  for (const step of status.recovery ?? []) section.add('plain', step);
}

function eventsSection(ctx: Context, eventsRead: Result<Event[], string>): void {
  const { input, now } = ctx;
  const section = ctx.report.section('Warning Events');
  if (!eventsRead.success) {
    section.add('warning', `Could not read events: ${ctx.redact(eventsRead.error)}`);
    return;
  }
  const since = now.getTime() / 1000 - RECENT_EVENTS_WINDOW_S;
  const dated = eventsRead.data.map((event) => ({ event, at: eventSeconds(event) }));
  dated.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const shown = input.verbose ? dated : dated.filter((d) => d.at !== null && d.at >= since).slice(0, MAX_RECENT_EVENTS);
  if (shown.length === 0) {
    section.add('plain', input.verbose ? 'No warning events' : 'No warning events in the last 15 minutes');
    return;
  }
  for (const { event } of shown) {
    const target = event.involvedObject;
    const object = `${target?.kind ?? 'Object'}/${target?.name ?? '?'}`;
    const age = formatAge(eventTimestamp(event), now);
    section.add('warning', `${age} ${object} ${event.reason ?? 'Warning'}: ${ctx.redact(oneLine(event.message ?? ''))}`);
  }
}

// --- Verbose sections --------------------------------------------------------

function crashLogsSection(ctx: Context): void {
  const section = ctx.report.section('Crash Logs');
  if (ctx.input.crashLogs.length === 0) {
    section.add('plain', 'No crashed containers');
    return;
  }
  section.add('dim', '(container output, may contain sensitive data)');
  for (const excerpt of ctx.input.crashLogs) {
    section.add('dim', `${excerpt.label} (${excerpt.previous ? 'previous run' : 'current run'}):`);
    for (const line of excerpt.lines.slice(-CRASH_LOG_LINES)) section.add('dim', `    ${line}`);
  }
}

function describeSection(ctx: Context): void {
  if (ctx.input.descriptions.length === 0) return;
  const section = ctx.report.section('Describe');
  for (const d of ctx.input.descriptions) {
    section.add('dim', `${d.label}:`);
    for (const line of ctx.redact(d.text).replace(/\n+$/, '').split('\n')) section.add('plain', `    ${line}`);
  }
}

// --- Nodes and host ----------------------------------------------------------

function nodesSection(ctx: Context, nodesRead: Result<Node[], string>): void {
  const { report } = ctx;
  const section = report.section('Cluster Nodes');
  if (!nodesRead.success) {
    section.add('warning', `Could not read nodes: ${ctx.redact(nodesRead.error)}`);
    return;
  }
  const nodes = [...nodesRead.data].sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0));
  for (const node of nodes) {
    const name = ctx.input.nodeToServer.get(node.metadata.name) ?? node.metadata.name;
    const conditions = node.status?.conditions ?? [];
    const ready = conditions.find((c) => c.type === 'Ready')?.status === 'True';
    const pressures = NODE_PRESSURES.filter((p) => conditions.find((c) => c.type === p)?.status === 'True');
    const cordoned = node.spec?.unschedulable === true;
    const role = node.metadata.labels?.[CONTROL_PLANE_ROLE_LABEL] !== undefined ? 'manager' : 'worker';
    const version = node.status?.nodeInfo?.kubeletVersion;
    const state = `${ready ? 'Ready' : 'NotReady'}${cordoned ? ',SchedulingDisabled' : ''}`;
    const extra = [version ?? '', ...pressures].filter((p) => p !== '').join(' ');
    const level: DiagnosticLineLevel = !ready ? 'error' : pressures.length > 0 || cordoned ? 'warning' : 'ok';
    section.add(level, `${name} ${state} (${role})${extra ? ` ${extra}` : ''}`);
    if (!ready) report.issue('error', 'Node', `Node ${name} is not ready`);
    for (const p of pressures) report.issue('warning', 'Node', `Node ${name} reports ${p}`);
    if (cordoned) report.issue('warning', 'Node', `Node ${name} is cordoned`);
  }
}

/** `<filesystem> <blocks> <used> <available> <capacity>% <mount>` of `df -P` */
export function parseDfLine(output: string): { percent: number; mount: string } | null {
  const line = output.trim().split('\n').at(-1) ?? '';
  const match = /\s(\d{1,3})%\s+(\S.*)$/.exec(line);
  return match ? { percent: Number(match[1]), mount: match[2].trim() } : null;
}

export function parsePercent(output: string): number | null {
  const text = output.trim();
  return /^\d{1,3}$/.test(text) ? Number(text) : null;
}

function diskLevel(percent: number): DiagnosticLineLevel {
  if (percent >= DISK_ERROR_PERCENT) return 'error';
  return percent >= DISK_WARNING_PERCENT ? 'warning' : 'ok';
}

function systemSection(ctx: Context): void {
  const { input, report } = ctx;
  const section = report.section('System Resources');
  const disks: { percent: number; mount: string }[] = [];
  const root = input.host.rootDisk.success ? parseDfLine(input.host.rootDisk.data) : null;
  if (root === null) {
    section.add('plain', 'Could not check disk space');
  } else {
    disks.push(root);
  }
  const volumes = input.host.volumeDisk?.success ? parseDfLine(input.host.volumeDisk.data) : null;
  if (volumes !== null && volumes.mount !== root?.mount) disks.push(volumes);
  for (const disk of disks) {
    section.add(diskLevel(disk.percent), `Disk usage (${disk.mount}): ${disk.percent}%`);
    const message = `Disk at ${disk.percent}% on ${disk.mount}`;
    if (disk.percent >= DISK_ERROR_PERCENT) {
      report.issue('error', 'System', message, `Free disk space with: \`dockflow prune ${input.env} --images --all\`.`);
    } else if (disk.percent >= DISK_WARNING_PERCENT) {
      report.issue('warning', 'System', message);
    }
  }
  const memory = input.host.memory.success ? parsePercent(input.host.memory.data) : null;
  if (memory === null) {
    section.add('plain', 'Could not check memory usage');
    return;
  }
  if (memory >= MEMORY_ISSUE_PERCENT) {
    section.add('error', `Memory usage: ${memory}%`);
    report.issue('warning', 'System', `Memory at ${memory}%`, 'Free memory or add nodes; high usage may prevent containers from starting.');
  } else {
    section.add(memory >= MEMORY_WARNING_PERCENT ? 'warning' : 'ok', `Memory usage: ${memory}%`);
  }
}

/**
 * The `diagnose` report of one namespace (both roles: they share it). The namespace check ends the
 * report when the namespace is missing; every other failed read is a warning line of its section.
 */
export function buildDiagnosticReport(input: DiagnoseInput, now: Date): DiagnosticReport {
  const report = new ReportBuilder();
  const ctx: Context = {
    input,
    now,
    report,
    events: input.events.success ? input.events.data : [],
    errorContext: (service) => (service === undefined ? { source: 'kubernetes', env: input.env } : { source: 'kubernetes', env: input.env, service }),
    redact: (text) => input.redactor.redact(text),
  };
  if (!stackStatus(ctx)) return report.build();

  const helm = input.helmReleases.success ? input.helmReleases.data : [];
  if (input.inventory.success) {
    const inventory = input.inventory.data;
    const entries = podEntries(ctx, inventory);
    servicesSection(ctx, inventory, helm);
    rolloutsSection(ctx, inventory);
    podErrorsSection(ctx, entries);
    pendingPodsSection(ctx, entries);
    helperPodsSection(ctx, inventory);
    volumesSection(ctx, inventory, entries);
  } else {
    report.section('Services').add('warning', `Could not read the namespace: ${ctx.redact(input.inventory.error)}`);
  }
  helmSection(ctx);
  proxySection(ctx);
  eventsSection(ctx, input.events);
  if (input.verbose) {
    crashLogsSection(ctx);
    describeSection(ctx);
  }
  nodesSection(ctx, input.nodes);
  systemSection(ctx);
  return report.build();
}
