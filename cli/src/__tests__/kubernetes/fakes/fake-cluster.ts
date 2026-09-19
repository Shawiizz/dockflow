// FakeCluster (design-07 3.4): the in-memory API server behind FakeKubeExecutor in cluster mode
// (PD-13). It serves the kubectl verbs Dockflow issues against a store of plain objects, runs
// simplified controllers on ticks derived from the injected clock (or `tick()`), and exposes the
// fault injection and inspection hooks convergence, store, day-2 and lifecycle tests need.
//
// Fidelity limits: field ownership is tracked per manager for server-side apply only (no
// conflicts except injected ones); no admission defaulting (the only server-written fields are the
// ones allocation and the controllers own); quantities are not canonicalised; garbage collection
// only follows the ownerReferences the fake's own controllers set (workload -> ReplicaSet or
// ControllerRevision -> Pod, Job -> Pod).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { ANNOTATIONS, K8S_STORAGE_CLASS, K8S_SYSTEM_NAMESPACE, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';
import type { KubectlResult } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import type { PersistentVolumeView } from '../support/invariants';
import { formatCompactJson, formatKubectlJson } from '../support/kubectl-fixtures';
import { formatIssue, validateObject } from '../support/schema/validate';
import { FAKE_CLOCK_START } from './fake-clock';
import { fakeNode, type KubeCallHandler, type KubeRequest, kubectlStderrSample } from './fake-kube-executor';
import { shellTokens } from './fake-node-shell';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PodBehavior =
  | { kind: 'ready'; afterTicks: number }
  | { kind: 'never-ready' }
  | { kind: 'crashloop'; exitCode: number; message?: string }
  | {
      kind: 'waiting';
      reason: 'ImagePullBackOff' | 'ErrImagePull' | 'ErrImageNeverPull' | 'InvalidImageName' | 'CreateContainerConfigError';
      message: string;
    }
  | { kind: 'unschedulable'; message: string }
  | { kind: 'oom'; afterTicks: number }
  | { kind: 'restarts-after-ready'; everyTicks: number };

export const DEFAULT_POD_BEHAVIOR: PodBehavior = { kind: 'ready', afterTicks: 1 };

export type RejectReason =
  | 'Invalid'
  | 'Forbidden'
  | 'AdmissionDenied'
  | 'Immutable'
  | 'Conflict'
  | 'NoKindMatch'
  | 'Unauthorized'
  | 'Unreachable';

/**
 * Which calls a rejection applies to. `Unauthorized` and `Unreachable` fail whole calls before
 * anything happens and match on `verb` only; the other reasons reject one object at a time, so the
 * other documents of a multi-document apply still go through (as kubectl does).
 */
export interface RejectMatch {
  /** kubectl verb (`apply`, `create`, `get`, `rollout`, ...); absent or `*`: every verb */
  verb?: string;
  /** object kind (`Deployment`); absent: every kind */
  kind?: string;
  name?: string | RegExp;
  namespace?: string;
}

export interface RejectOptions {
  /** how many objects (or calls) the rule rejects; default: all of them */
  times?: number;
  /** false: `apply --dry-run=server` passes and only the real apply is rejected; default true */
  dryRun?: boolean;
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface KubeObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  deletionGracePeriodSeconds?: number;
  generateName?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
  finalizers?: string[];
  [key: string]: unknown;
}

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: KubeObjectMeta;
  [key: string]: unknown;
}

export interface ExecRequest {
  namespace: string;
  pod: string;
  container: string;
  /** the argv after `--` */
  argv: string[];
  stdin: string;
  interactive: boolean;
  tty: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type ExecHandler = (request: ExecRequest) => ExecResult | Promise<ExecResult>;

/** a pod name, a RegExp on the pod name, a label selector (a string with `=`, `!` or `in (`), or a structured match */
export type PodMatcher =
  | string
  | RegExp
  | { namespace?: string; name?: string | RegExp; selector?: string; container?: string };

export interface PvRecord {
  name: string;
  claim: string;
  namespace: string;
  /** the reclaim policy the volume was provisioned with (from its StorageClass) */
  originalPolicy: string;
  /** the current policy; null once the volume is gone */
  reclaimPolicy: string | null;
  /** `P/reclaim-policy-before` as currently annotated (C13 step 1), or null */
  recordedPolicy: string | null;
  phase: string | null;
  exists: boolean;
}

export interface FakeNodeOptions {
  role?: 'server' | 'agent';
  labels?: Record<string, string>;
  taints?: { key: string; value?: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' }[];
  ready?: boolean;
}

export interface FakeClusterOptions {
  /** controllers tick as this clock advances (FakeClock.advance); without it only tick() moves them */
  clock?: Clock;
  /** fake time of one controller tick; default 1000 */
  tickMs?: number;
  /** Node names; default server-1 and agent-1 (a `server*` node is a control-plane node) */
  nodes?: readonly string[];
  /** seed the dockflow-system namespace; default true */
  systemNamespace?: boolean;
  /** seed k3s's local-path class and Dockflow's dockflow-local class (Retain, default); default true */
  storageClasses?: boolean;
  /** seed the Traefik IngressRoute and Middleware CRDs; default true */
  traefikCrds?: boolean;
  /** `version -o json` gitVersion and the kubelet version of the nodes; default the pinned k3s */
  serverVersion?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_NODES = ['server-1', 'agent-1'];
const STDERR_FIXTURES = join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr');
const LOCAL_PATH_PROVISIONER = 'rancher.io/local-path';
const LOCAL_PATH_ROOT = '/var/lib/rancher/k3s/storage';
const FOREGROUND = 'foregroundDeletion';
const PVC_PROTECTION = 'kubernetes.io/pvc-protection';
const PV_PROTECTION = 'kubernetes.io/pv-protection';
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';
const STS_HASH_LABEL = 'controller.kubernetes.io/hash';
const JOB_UID_LABELS = ['batch.kubernetes.io/controller-uid', 'controller-uid'];
const JOB_NAME_LABELS = ['batch.kubernetes.io/job-name', 'job-name'];
const SAFE_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';
/** without a clock, a wait with no --timeout gives up after this many ticks */
const MAX_WAIT_TICKS = 3600;
const PREEMPTION = 'Preemption is not helpful for scheduling.';
/** server-owned metadata: never taken from a written object, never part of field ownership */
const METADATA_IDENTITY = new Set([
  'name',
  'namespace',
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'managedFields',
  'selfLink',
]);

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Obj {
  return isObj(value) ? value : {};
}

function child(parent: Obj, key: string): Obj {
  const existing = parent[key];
  if (isObj(existing)) return existing;
  const created: Obj = {};
  parent[key] = created;
  return created;
}

function strOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objList(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter(isObj) : [];
}

function strMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj(value))) if (typeof entry === 'string') out[key] = entry;
  return out;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/** drops the server-owned metadata a client may have sent (uid, resourceVersion, timestamps, ...) */
function stripIdentity(object: KubeObject): void {
  for (const key of METADATA_IDENTITY) if (key !== 'name' && key !== 'namespace') delete object.metadata[key];
}

function without(value: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const [key, entry] of Object.entries(value)) if (!keys.includes(key)) out[key] = entry;
  return out;
}

function mergeInto(target: Obj, source: Obj): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isObj(value) && isObj(current)) mergeInto(current, value);
    else target[key] = clone(value);
  }
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function rfc3339Nano(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
}

/** deterministic stand-in for Kubernetes' safe-encoded hashes (pod-template-hash, name suffixes) */
function safeHash(text: string, length: number): string {
  const hex = sha256Hex(text);
  let out = '';
  for (let i = 0; i < length; i++) out += SAFE_ALPHABET[Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) % SAFE_ALPHABET.length];
  return out;
}

/** Go duration (`30s`, `1m30s`, `500ms`) or bare seconds, in seconds; null when absent or 0 */
function parseDuration(text: string | undefined): number | null {
  if (text === undefined || text === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) || null;
  const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001, ns: 0.000000001 };
  let total = 0;
  let rest = text;
  while (rest !== '') {
    const match = /^(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/.exec(rest);
    if (!match) throw new Error(`invalid duration ${text}`);
    total += Number(match[1]) * units[match[2]];
    rest = rest.slice(match[0].length);
  }
  return total === 0 ? null : total;
}

/** `25%` of `total`, or a number; rounded up for surge, down for unavailability */
function intOrPercent(value: unknown, total: number, fallback: string, roundUp: boolean): number {
  const raw = value ?? fallback;
  if (typeof raw === 'number') return raw;
  const match = /^(\d+)%$/.exec(String(raw));
  if (!match) return Number(raw) || 0;
  const exact = (Number(match[1]) * total) / 100;
  return roundUp ? Math.ceil(exact) : Math.floor(exact);
}

// ---------------------------------------------------------------------------
// Resource registry
// ---------------------------------------------------------------------------

interface KindInfo {
  kind: string;
  apiVersion: string;
  group: string;
  plural: string;
  singular: string;
  short: readonly string[];
  namespaced: boolean;
  /** Deployment-like objects get metadata.generation */
  generation: boolean;
  /** served only while this CRD exists */
  crd?: string;
}

function kindInfo(
  kind: string,
  apiVersion: string,
  plural: string,
  namespaced: boolean,
  extra: { short?: string[]; generation?: boolean; crd?: string } = {},
): KindInfo {
  const slash = apiVersion.indexOf('/');
  return {
    kind,
    apiVersion,
    group: slash === -1 ? '' : apiVersion.slice(0, slash),
    plural,
    singular: kind.toLowerCase(),
    short: extra.short ?? [],
    namespaced,
    generation: extra.generation ?? false,
    ...(extra.crd !== undefined ? { crd: extra.crd } : {}),
  };
}

const KINDS: readonly KindInfo[] = [
  kindInfo('Pod', 'v1', 'pods', true, { short: ['po'], generation: true }),
  kindInfo('Service', 'v1', 'services', true, { short: ['svc'] }),
  kindInfo('Secret', 'v1', 'secrets', true),
  kindInfo('ConfigMap', 'v1', 'configmaps', true, { short: ['cm'] }),
  kindInfo('PersistentVolumeClaim', 'v1', 'persistentvolumeclaims', true, { short: ['pvc'] }),
  kindInfo('PersistentVolume', 'v1', 'persistentvolumes', false, { short: ['pv'] }),
  kindInfo('Namespace', 'v1', 'namespaces', false, { short: ['ns'] }),
  kindInfo('Node', 'v1', 'nodes', false, { short: ['no'] }),
  kindInfo('Event', 'v1', 'events', true, { short: ['ev'] }),
  kindInfo('ServiceAccount', 'v1', 'serviceaccounts', true, { short: ['sa'] }),
  kindInfo('Deployment', 'apps/v1', 'deployments', true, { short: ['deploy'], generation: true }),
  kindInfo('StatefulSet', 'apps/v1', 'statefulsets', true, { short: ['sts'], generation: true }),
  kindInfo('DaemonSet', 'apps/v1', 'daemonsets', true, { short: ['ds'], generation: true }),
  kindInfo('ReplicaSet', 'apps/v1', 'replicasets', true, { short: ['rs'], generation: true }),
  kindInfo('ControllerRevision', 'apps/v1', 'controllerrevisions', true),
  kindInfo('Job', 'batch/v1', 'jobs', true, { generation: true }),
  kindInfo('Lease', 'coordination.k8s.io/v1', 'leases', true),
  kindInfo('StorageClass', 'storage.k8s.io/v1', 'storageclasses', false, { short: ['sc'] }),
  kindInfo('ClusterRole', 'rbac.authorization.k8s.io/v1', 'clusterroles', false),
  kindInfo('ClusterRoleBinding', 'rbac.authorization.k8s.io/v1', 'clusterrolebindings', false),
  kindInfo('Role', 'rbac.authorization.k8s.io/v1', 'roles', true),
  kindInfo('RoleBinding', 'rbac.authorization.k8s.io/v1', 'rolebindings', true),
  kindInfo('CustomResourceDefinition', 'apiextensions.k8s.io/v1', 'customresourcedefinitions', false, {
    short: ['crd', 'crds'],
    generation: true,
  }),
  kindInfo('EndpointSlice', 'discovery.k8s.io/v1', 'endpointslices', true),
  kindInfo('IngressRoute', 'traefik.io/v1alpha1', 'ingressroutes', true, { generation: true, crd: 'ingressroutes.traefik.io' }),
  kindInfo('Middleware', 'traefik.io/v1alpha1', 'middlewares', true, { generation: true, crd: 'middlewares.traefik.io' }),
];

function infoOf(kind: string): KindInfo {
  const info = KINDS.find((candidate) => candidate.kind === kind);
  if (!info) throw new Error(`FakeCluster has no kind ${kind}`);
  return info;
}

/** `deployments`, `deploy`, `Deployment.apps`, `deployments.v1.apps` -> the kind */
function resourceInfo(token: string): KindInfo | null {
  const lower = token.toLowerCase();
  const dot = lower.indexOf('.');
  const head = dot === -1 ? lower : lower.slice(0, dot);
  const group = dot === -1 ? '' : lower.slice(dot + 1);
  for (const info of KINDS) {
    if (![info.plural, info.singular, ...info.short].includes(head)) continue;
    const version = info.apiVersion.split('/').at(-1) ?? '';
    if (group === '' || group === info.group || group === `${version}.${info.group}` || (info.group === '' && group === version)) return info;
  }
  return null;
}

function groupSuffix(info: KindInfo): string {
  return info.group === '' ? '' : `.${info.group}`;
}

/** `deployments.apps`, as the API server names a resource in its messages */
function resourceLabel(info: KindInfo): string {
  return `${info.plural}${groupSuffix(info)}`;
}

/** `deployment.apps/web`, as kubectl prints an object reference */
function objectRef(info: KindInfo, name: string): string {
  return `${info.singular}${groupSuffix(info)}/${name}`;
}

/** `Deployment.apps "web"`, the subject of validation errors */
function kindSubject(info: KindInfo, name: string): string {
  return `${info.kind}${groupSuffix(info)} "${name}"`;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

interface SelectorTerm {
  key: string;
  op: 'eq' | 'ne' | 'exists' | 'absent' | 'in' | 'notin';
  values: string[];
}

class SelectorError extends Error {}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** `k=v`, `k==v`, `k!=v`, `k`, `!k`, `k in (a,b)`, `k notin (a,b)` */
export function parseLabelSelector(text: string): SelectorTerm[] {
  return splitTopLevel(text).map((part) => {
    let match = /^([^\s=!()]+)\s+(in|notin)\s*\(([^)]*)\)$/.exec(part);
    if (match) {
      const values = match[3].split(',').map((value) => value.trim()).filter((value) => value !== '');
      return { key: match[1], op: match[2] === 'in' ? 'in' : 'notin', values };
    }
    match = /^([^\s=!()]+)\s*(==|=|!=)\s*([^\s=!()]*)$/.exec(part);
    if (match) return { key: match[1], op: match[2] === '!=' ? 'ne' : 'eq', values: [match[3]] };
    match = /^!\s*([^\s=!()]+)$/.exec(part);
    if (match) return { key: match[1], op: 'absent', values: [] };
    if (/^[^\s=!()]+$/.test(part)) return { key: part, op: 'exists', values: [] };
    throw new SelectorError(`unable to parse requirement: ${part}`);
  });
}

export function selectorMatches(labels: Record<string, string>, terms: readonly SelectorTerm[]): boolean {
  return terms.every((term) => {
    const has = Object.hasOwn(labels, term.key);
    const value = labels[term.key];
    switch (term.op) {
      case 'eq':
        return has && value === term.values[0];
      case 'ne':
        return !has || value !== term.values[0];
      case 'exists':
        return has;
      case 'absent':
        return !has;
      case 'in':
        return has && term.values.includes(value);
      case 'notin':
        return !has || !term.values.includes(value);
    }
  });
}

/** a LabelSelector object (matchLabels + matchExpressions) */
function labelSelectorMatches(labels: Record<string, string>, selector: Obj): boolean {
  for (const [key, value] of Object.entries(strMap(selector.matchLabels))) if (labels[key] !== value) return false;
  return objList(selector.matchExpressions).every((expression) => expressionMatches(labels, expression));
}

function expressionMatches(values: Record<string, string>, expression: Obj): boolean {
  const key = strOf(expression.key) ?? '';
  const operator = strOf(expression.operator) ?? '';
  const list = Array.isArray(expression.values) ? expression.values.map(String) : [];
  const has = Object.hasOwn(values, key);
  switch (operator) {
    case 'In':
      return has && list.includes(values[key]);
    case 'NotIn':
      return !has || !list.includes(values[key]);
    case 'Exists':
      return has;
    case 'DoesNotExist':
      return !has;
    case 'Gt':
      return has && Number(values[key]) > Number(list[0]);
    case 'Lt':
      return has && Number(values[key]) < Number(list[0]);
    default:
      return false;
  }
}

function fieldValue(object: unknown, path: string): string {
  let current: unknown = object;
  for (const part of path.split('.')) current = obj(current)[part];
  return current === undefined || current === null ? '' : String(current);
}

function fieldSelectorMatches(object: KubeObject, selector: string): boolean {
  return splitTopLevel(selector).every((term) => {
    const match = /^([^=!]+?)\s*(==|=|!=)\s*(.*)$/.exec(term);
    if (!match) throw new SelectorError(`invalid field selector: ${term}`);
    const actual = fieldValue(object, match[1].trim());
    return match[2] === '!=' ? actual !== match[3].trim() : actual === match[3].trim();
  });
}

// ---------------------------------------------------------------------------
// kubectl argv
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '-l',
  '--selector',
  '-o',
  '--output',
  '-f',
  '--filename',
  '-p',
  '--patch',
  '--type',
  '-c',
  '--container',
  '--field-selector',
  '--timeout',
  '--for',
  '--since',
  '--since-time',
  '--tail',
  '--replicas',
  '--to-revision',
  '--grace-period',
  '--cascade',
  '--raw',
  '--field-manager',
  '--api-group',
  '--max-log-requests',
  '--subresource',
  '--namespaced',
]);

interface Argv {
  verb: string;
  positionals: string[];
  flags: Map<string, string[]>;
  /** after `--` (exec) */
  command: string[];
}

function parseArgv(args: readonly string[]): Argv {
  const verb = args[0] ?? '';
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const command: string[] = [];
  const add = (name: string, value: string): void => {
    flags.set(name, [...(flags.get(name) ?? []), value]);
  };
  // `logs -f` and `logs -p` are booleans (follow, previous), not a file and a patch
  const booleanShort = verb === 'logs' ? new Set(['-f', '-p']) : new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      command.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) add(arg.slice(0, eq), arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(arg)) {
        add(arg, args[i + 1] ?? '');
        i += 1;
      } else add(arg, '');
    } else if (arg.startsWith('-') && arg.length > 1) {
      if (arg === '-it' || arg === '-ti') {
        add('-i', '');
        add('-t', '');
        continue;
      }
      const name = arg.slice(0, 2);
      if (booleanShort.has(name) || !VALUE_FLAGS.has(name)) add(name, '');
      else if (arg.length > 2) add(name, arg[2] === '=' ? arg.slice(3) : arg.slice(2));
      else {
        add(name, args[i + 1] ?? '');
        i += 1;
      }
    } else positionals.push(arg);
  }
  return { verb, positionals, flags, command };
}

function flag(argv: Argv, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = argv.flags.get(name);
    if (values !== undefined) return values.at(-1);
  }
  return undefined;
}

function hasFlag(argv: Argv, ...names: string[]): boolean {
  return names.some((name) => argv.flags.has(name));
}

// ---------------------------------------------------------------------------
// Server-side apply field ownership (per manager, leaf paths)
// ---------------------------------------------------------------------------

const SEP = '\u0001';

interface ManagerEntry {
  operation: 'Apply' | 'Update';
  paths: Set<string>;
  time: string;
}

function collectPaths(value: unknown, path: string[], out: Map<string, string>): void {
  if (isObj(value) && Object.keys(value).length > 0) {
    for (const [key, entry] of Object.entries(value)) collectPaths(entry, [...path, key], out);
    return;
  }
  out.set(path.join(SEP), JSON.stringify(value));
}

/** every leaf a writer owns, with its value; identity metadata and status excluded */
function pathValues(object: Obj): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(object)) {
    if (key === 'apiVersion' || key === 'kind' || key === 'status') continue;
    if (key === 'metadata') {
      for (const [metaKey, metaValue] of Object.entries(obj(value))) {
        if (!METADATA_IDENTITY.has(metaKey)) collectPaths(metaValue, ['metadata', metaKey], out);
      }
      continue;
    }
    collectPaths(value, [key], out);
  }
  return out;
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${SEP}`) || b.startsWith(`${a}${SEP}`);
}

function deletePath(object: Obj, path: string): void {
  const parts = path.split(SEP);
  const trail: Obj[] = [object];
  for (const part of parts.slice(0, -1)) {
    const next = trail[trail.length - 1][part];
    if (!isObj(next)) return;
    trail.push(next);
  }
  delete trail[trail.length - 1][parts[parts.length - 1]];
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]).length > 0) break;
    delete trail[i - 1][parts[i - 1]];
  }
}

/**
 * SSA: `manager` now owns exactly the applied leaves. A leaf another manager applied with the same
 * value stays shared; a different value (or a changed structure) moves to the applier, as
 * `--force-conflicts` does.
 */
function claimApplied(managers: Map<string, ManagerEntry>, manager: string, applied: Map<string, string>, before: Map<string, string>, time: string): boolean {
  let changed = false;
  for (const [name, entry] of managers) {
    if (name === manager) continue;
    for (const owned of [...entry.paths]) {
      const conflict = [...applied].some(([path, value]) => related(path, owned) && !(path === owned && before.get(path) === value));
      if (conflict) {
        entry.paths.delete(owned);
        changed = true;
      }
    }
    if (entry.paths.size === 0) managers.delete(name);
  }
  const paths = new Set(applied.keys());
  const previous = managers.get(manager);
  if (!previous || previous.operation !== 'Apply' || !same([...previous.paths].sort(), [...paths].sort())) changed = true;
  managers.set(manager, { operation: 'Apply', paths: new Set(paths), time });
  return changed;
}

/** an Update: `manager` takes the leaves it changed; removed leaves leave every manager */
function claimUpdated(managers: Map<string, ManagerEntry>, manager: string, before: Obj, after: Obj, time: string): boolean {
  const old = pathValues(before);
  const next = pathValues(after);
  const changed = [...next].filter(([path, value]) => old.get(path) !== value).map(([path]) => path);
  const removed = [...old.keys()].filter((path) => !next.has(path));
  if (changed.length === 0 && removed.length === 0) return false;
  for (const [name, entry] of managers) {
    for (const owned of [...entry.paths]) {
      if (removed.includes(owned) || (name !== manager && changed.some((path) => related(path, owned)))) entry.paths.delete(owned);
    }
    if (entry.paths.size === 0 && name !== manager) managers.delete(name);
  }
  const mine = managers.get(manager) ?? { operation: 'Update' as const, paths: new Set<string>(), time };
  for (const path of changed) mine.paths.add(path);
  managers.set(manager, { operation: mine.operation, paths: mine.paths, time });
  return true;
}

/** a FieldsV1-shaped summary of owned leaves (`f:<key>` nesting) for --show-managed-fields */
function fieldsV1(paths: Iterable<string>): Obj {
  const root: Obj = {};
  for (const path of paths) {
    let node = root;
    for (const part of path.split(SEP)) node = child(node, `f:${part}`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// go-template (the release listing of PD-7 and templates of the same shape)
// ---------------------------------------------------------------------------

type TemplateNode = { kind: 'text'; text: string } | { kind: 'action'; expr: string } | { kind: 'range'; expr: string; body: TemplateNode[] };

function parseTemplate(source: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: { body: TemplateNode[] }[] = [{ body: root }];
  let rest = source;
  while (rest !== '') {
    const open = rest.indexOf('{{');
    if (open === -1) {
      stack[stack.length - 1].body.push({ kind: 'text', text: rest });
      break;
    }
    if (open > 0) stack[stack.length - 1].body.push({ kind: 'text', text: rest.slice(0, open) });
    const close = rest.indexOf('}}', open);
    if (close === -1) throw new Error(`unclosed action in template ${source}`);
    const expr = rest.slice(open + 2, close).trim();
    rest = rest.slice(close + 2);
    if (expr.startsWith('range ')) {
      const node: TemplateNode = { kind: 'range', expr: expr.slice(6).trim(), body: [] };
      stack[stack.length - 1].body.push(node);
      stack.push(node);
    } else if (expr === 'end') {
      if (stack.length === 1) throw new Error(`unexpected {{end}} in template ${source}`);
      stack.pop();
    } else stack[stack.length - 1].body.push({ kind: 'action', expr });
  }
  if (stack.length !== 1) throw new Error(`unterminated range in template ${source}`);
  return root;
}

function templateArgs(expr: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|\S+/g;
  for (let match = re.exec(expr); match !== null; match = re.exec(expr)) out.push(match[0]);
  return out;
}

function templateValue(token: string, dot: unknown): unknown {
  if (token.startsWith('"')) return JSON.parse(token) as string;
  if (token === '.') return dot;
  if (!token.startsWith('.')) throw new Error(`template token ${token} is not supported by FakeCluster`);
  let current: unknown = dot;
  for (const part of token.slice(1).split('.')) current = isObj(current) ? current[part] : undefined;
  return current;
}

function evalTemplateExpr(expr: string, dot: unknown): unknown {
  const args = templateArgs(expr);
  if (args[0] === 'index') {
    let current = templateValue(args[1] ?? '.', dot);
    for (const key of args.slice(2)) {
      const name = templateValue(key, dot);
      current = isObj(current) && typeof name === 'string' ? current[name] : undefined;
    }
    return current;
  }
  if (args.length !== 1) throw new Error(`template action {{${expr}}} is not supported by FakeCluster`);
  return templateValue(args[0], dot);
}

function printTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return '<no value>';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function renderTemplate(nodes: readonly TemplateNode[], dot: unknown): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'action') out += printTemplateValue(evalTemplateExpr(node.expr, dot));
    else {
      const over = evalTemplateExpr(node.expr, dot);
      const items = Array.isArray(over) ? over : isObj(over) ? Object.keys(over).sort().map((key) => over[key]) : [];
      for (const item of items) out += renderTemplate(node.body, item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** a kubectl failure raised from deep inside a verb, answered as a result */
class Refusal extends Error {
  constructor(readonly result: KubectlResult) {
    super(result.stderr);
  }
}

function line(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function refuse(stderr: string, exitCode = 1): never {
  throw new Refusal({ exitCode, stdout: '', stderr: line(stderr) });
}

function done(stdout: string[], errors: string[]): KubectlResult {
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    stdout: stdout.map(line).join(''),
    stderr: errors.map(line).join(''),
  };
}

function notFoundText(info: KindInfo, name: string): string {
  return `Error from server (NotFound): ${resourceLabel(info)} "${name}" not found`;
}

function noResourceType(token: string): string {
  return `error: the server doesn't have a resource type "${token}"`;
}

function noKindMatch(name: string, namespace: string | undefined, kind: string, apiVersion: string): string {
  return `error: resource mapping not found for name: "${name}" namespace: "${namespace ?? ''}" from "STDIN": no matches for kind "${kind}" in version "${apiVersion}"\nensure CRDs are installed first`;
}

// ---------------------------------------------------------------------------
// Store entries
// ---------------------------------------------------------------------------

interface EntryState {
  createdTick: number;
  /** seeded with `reconcile: false`: no controller, scheduler or kubelet touches it */
  frozen?: boolean;
  /** workloads: the controller picks up a new generation from this tick on (lag) */
  syncAfterTick?: number;
  observedGeneration?: number;
  /** the spec the controller reconciles; lags behind the stored spec during the controller lag */
  observedSpec?: Obj;
  syncedHash?: string;
  progressAtMs?: number;
  progressKey?: string;
  deadlineExceeded?: boolean;
  jobStarted?: boolean;
  /** pods */
  behaviors?: Record<string, PodBehavior>;
  terminateAtTick?: number;
  scheduledTick?: number;
  readySinceMs?: number | null;
  emitted?: Set<string>;
  failedScheduling?: string;
  /** PersistentVolumes */
  releasedTick?: number;
  policyTick?: number;
  /** Services */
  sliceName?: string;
}

interface Entry {
  info: KindInfo;
  object: KubeObject;
  managers: Map<string, ManagerEntry>;
  state: EntryState;
}

interface RejectRule {
  match: RejectMatch;
  reason: RejectReason;
  stderr: string | null;
  remaining: number;
  dryRun: boolean;
}

interface LogLineRecord {
  timeMs: number;
  text: string;
}

interface Target {
  info: KindInfo;
  namespace: string | undefined;
  name: string;
}

function labelsOf(object: KubeObject): Record<string, string> {
  return strMap(object.metadata.labels);
}

function ownerRefOf(object: KubeObject): OwnerReference {
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    name: object.metadata.name,
    uid: object.metadata.uid ?? '',
    controller: true,
    blockOwnerDeletion: true,
  };
}

function isDeleting(entry: Entry): boolean {
  return entry.object.metadata.deletionTimestamp !== undefined;
}

function podPhase(entry: Entry): string {
  return strOf(obj(entry.object.status).phase) ?? 'Pending';
}

function isTerminal(entry: Entry): boolean {
  const phase = podPhase(entry);
  return phase === 'Succeeded' || phase === 'Failed';
}

function isActivePod(entry: Entry): boolean {
  return !isDeleting(entry) && !isTerminal(entry);
}

function conditionOf(object: KubeObject, type: string): Obj | undefined {
  return objList(obj(object.status).conditions).find((condition) => condition.type === type);
}

function isPodReady(entry: Entry): boolean {
  return conditionOf(entry.object, 'Ready')?.status === 'True';
}

function podClaims(pod: KubeObject): string[] {
  return objList(obj(pod.spec).volumes).flatMap((volume) => {
    const claim = strOf(obj(volume.persistentVolumeClaim).claimName);
    return claim === undefined ? [] : [claim];
  });
}

function containersOf(pod: KubeObject, key: 'containers' | 'initContainers' = 'containers'): Obj[] {
  return objList(obj(pod.spec)[key]);
}

function revisionOf(entry: Entry): number {
  return Number(entry.object.metadata.annotations?.[KUBE_KEYS.deploymentRevision] ?? 0) || 0;
}

function setCondition(status: Obj, type: string, value: string, reason: string | undefined, message: string | undefined, nowIso: string, withUpdateTime: boolean): void {
  const conditions = objList(status.conditions);
  const existing = conditions.find((condition) => condition.type === type);
  const next: Obj = {
    ...(withUpdateTime ? {} : { lastProbeTime: null }),
    lastTransitionTime: existing?.status === value ? existing.lastTransitionTime : nowIso,
    ...(withUpdateTime
      ? { lastUpdateTime: existing?.status === value && existing.reason === reason && existing.message === message ? existing.lastUpdateTime : nowIso }
      : {}),
    ...(message !== undefined ? { message } : {}),
    ...(reason !== undefined ? { reason } : {}),
    status: value,
    type,
  };
  status.conditions = existing ? conditions.map((condition) => (condition === existing ? next : condition)) : [...conditions, next];
}

function putCount(status: Obj, key: string, value: number): void {
  if (value > 0) status[key] = value;
  else delete status[key];
}

function imageMatches(pattern: string | RegExp, image: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(image);
  if (pattern.includes('*')) {
    const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escaped.join('.*')}$`).test(image);
  }
  return image === pattern || image.endsWith(`/${pattern}`);
}

// ---------------------------------------------------------------------------
// FakeCluster
// ---------------------------------------------------------------------------

export class FakeCluster implements KubeCallHandler, PersistentVolumeView {
  /** test mistakes the cluster detected (schema issues, commands it cannot serve) */
  readonly problems: string[] = [];
  /** fake time of one tick */
  readonly tickMs: number;
  /** `version -o json` gitVersion */
  serverVersion: string;
  /** metrics.k8s.io answers (k3s runs metrics-server by default) */
  metricsAvailable = true;
  /** `/readyz` answers ok */
  apiReady = true;

  private readonly clock: Clock | null;
  private readonly startMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly byUid = new Map<string, Entry>();
  private readonly behaviors: { pattern: string | RegExp; behavior: PodBehavior }[] = [];
  private readonly rejections: RejectRule[] = [];
  private readonly execHandlers: { matcher: PodMatcher; handler: ExecHandler }[] = [];
  private readonly logs = new Map<string, LogLineRecord[]>();
  private readonly podMetrics = new Map<string, Record<string, { cpu: string; memory: string }>>();
  private readonly pvRecords = new Map<string, { name: string; claim: string; namespace: string; originalPolicy: string }>();
  private ticks = 0;
  private tickTimeMs: number | null = null;
  private lagTicks = 1;
  private uidCounter = 0;
  private rvCounter = 0;
  private suffixCounter = 0;
  private ipCounter = 1;
  private eventCounter = 0;

  constructor(options: FakeClusterOptions = {}) {
    this.clock = options.clock ?? null;
    this.tickMs = options.tickMs ?? 1000;
    if (this.tickMs <= 0) throw new Error('FakeCluster tickMs must be positive');
    this.startMs = (this.clock?.now() ?? new Date(FAKE_CLOCK_START)).getTime();
    this.serverVersion = options.serverVersion ?? K3S_PIN.version;
    const namespaces = ['default', 'kube-system', 'kube-public', 'kube-node-lease'];
    if (options.systemNamespace ?? true) namespaces.push(K8S_SYSTEM_NAMESPACE);
    for (const name of namespaces) this.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } });
    for (const name of options.nodes ?? DEFAULT_NODES) this.addNode(name);
    if (options.storageClasses ?? true) {
      this.seed({
        apiVersion: 'storage.k8s.io/v1',
        kind: 'StorageClass',
        metadata: { name: 'local-path', annotations: { [KUBE_KEYS.defaultStorageClass]: 'false' } },
        provisioner: LOCAL_PATH_PROVISIONER,
        reclaimPolicy: 'Delete',
        volumeBindingMode: 'WaitForFirstConsumer',
      });
      this.seed({
        apiVersion: 'storage.k8s.io/v1',
        kind: 'StorageClass',
        metadata: { name: K8S_STORAGE_CLASS, annotations: { [KUBE_KEYS.defaultStorageClass]: 'true' } },
        provisioner: LOCAL_PATH_PROVISIONER,
        reclaimPolicy: 'Retain',
        volumeBindingMode: 'WaitForFirstConsumer',
      });
    }
    if (options.traefikCrds ?? true) {
      for (const [plural, kind] of [
        ['ingressroutes', 'IngressRoute'],
        ['middlewares', 'Middleware'],
      ]) {
        this.seed({
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: `${plural}.traefik.io` },
          spec: { group: 'traefik.io', names: { kind, plural, singular: kind.toLowerCase() }, scope: 'Namespaced' },
        });
      }
    }
  }

  // ---- time -------------------------------------------------------------------------------------

  /** controller ticks run so far */
  get tickCount(): number {
    return this.ticks;
  }

  /** runs the controllers `n` times */
  tick(n = 1): void {
    this.sync();
    for (let i = 0; i < n; i++) this.runTick();
  }

  /** catches up with the clock: one controller tick per `tickMs` of fake time elapsed */
  sync(): void {
    if (this.clock === null || this.tickTimeMs !== null) return;
    const due = Math.floor((this.clock.now().getTime() - this.startMs) / this.tickMs);
    while (this.ticks < due) this.runTick();
  }

  /** widens the controller lag (1 tick by default) for every later change */
  lag(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(`FakeCluster.lag needs a positive tick count, got ${n}`);
    this.lagTicks = n;
  }

  private nowMs(): number {
    if (this.tickTimeMs !== null) return this.tickTimeMs;
    return this.clock ? this.clock.now().getTime() : this.startMs + this.ticks * this.tickMs;
  }

  private nowIso(): string {
    return isoSeconds(this.nowMs());
  }

  // ---- test API ---------------------------------------------------------------------------------

  /** pods whose container image matches `imagePattern` (glob, RegExp, or a ref suffix) behave like this; later rules win */
  behave(imagePattern: string | RegExp, behavior: PodBehavior): void {
    this.behaviors.push({ pattern: imagePattern, behavior });
  }

  /** the API server rejects matching calls with `reason` and a recorded stderr (fixtures/kubectl-stderr) */
  rejectOn(match: RejectMatch, reason: RejectReason, stderrFixture?: string, options: RejectOptions = {}): void {
    this.rejections.push({
      match,
      reason,
      stderr: stderrFixture ?? null,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
      dryRun: options.dryRun ?? true,
    });
  }

  /**
   * A foreign LoadBalancer Service already holding `port`: created bound, so every later Service asking
   * for the same port and protocol stays without ingress (K19 without a second stack).
   */
  claimHostPort(port: number, protocol: 'TCP' | 'UDP' = 'TCP', owner: string | { namespace: string; name: string } = 'kube-system/foreign'): KubeObject {
    const ref = typeof owner === 'string' ? owner : `${owner.namespace}/${owner.name}`;
    const slash = ref.indexOf('/');
    const namespace = slash === -1 ? 'kube-system' : ref.slice(0, slash);
    const name = slash === -1 ? ref : ref.slice(slash + 1);
    if (!this.find(infoOf('Namespace'), undefined, namespace)) this.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
    const portSpec = { name: `${protocol.toLowerCase()}-${port}`, port, protocol, targetPort: port };
    let service = this.find(infoOf('Service'), namespace, name);
    if (service) {
      this.mutate(service, (object) => {
        const spec = child(object, 'spec');
        spec.ports = [...objList(spec.ports), portSpec];
      });
    } else {
      const [seeded] = this.seed({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace }, spec: { type: 'LoadBalancer', ports: [portSpec] } });
      service = this.entry(seeded);
    }
    if (!service) throw new Error(`FakeCluster could not create the port owner ${namespace}/${name}`);
    this.mutate(service, (object) => this.bindLoadBalancer(object));
    return clone(service.object);
  }

  /** the PV provisioned for a claim, with the policy it was provisioned with (C13 restore assertions) */
  pvFor(claim: string, namespace?: string): PvRecord | null {
    this.sync();
    const record =
      namespace !== undefined
        ? this.pvRecords.get(`${namespace}/${claim}`)
        : [...this.pvRecords.values()].find((candidate) => candidate.claim === claim);
    if (!record) return null;
    const pv = this.find(infoOf('PersistentVolume'), undefined, record.name);
    const spec = obj(pv?.object.spec);
    return {
      ...record,
      reclaimPolicy: pv ? (strOf(spec.persistentVolumeReclaimPolicy) ?? null) : null,
      recordedPolicy: pv?.object.metadata.annotations?.[ANNOTATIONS.reclaimPolicyBefore] ?? null,
      phase: pv ? (strOf(obj(pv.object.status).phase) ?? null) : null,
      exists: pv !== undefined,
    };
  }

  /** PersistentVolumeView (INV-04b): the current policy, or null once the PV is gone */
  reclaimPolicyOf(name: string): string | null {
    this.sync();
    const pv = this.find(infoOf('PersistentVolume'), undefined, name);
    return pv ? (strOf(obj(pv.object.spec).persistentVolumeReclaimPolicy) ?? null) : null;
  }

  /** answers `kubectl exec` into matching pods; later registrations win */
  onExec(pod: PodMatcher, handler: ExecHandler): void {
    this.execHandlers.push({ matcher: pod, handler });
  }

  /** log lines of a container (`<pod>` or `<namespace>/<pod>`); `previous` feeds `logs --previous` */
  appendLogs(pod: string | { namespace?: string; name: string }, container: string, lines: readonly string[], options: { previous?: boolean } = {}): void {
    const ref = typeof pod === 'string' ? pod : pod.namespace !== undefined ? `${pod.namespace}/${pod.name}` : pod.name;
    const slash = ref.indexOf('/');
    const namespace = slash === -1 ? '*' : ref.slice(0, slash);
    const name = slash === -1 ? ref : ref.slice(slash + 1);
    const key = this.logKey(namespace, name, container, options.previous ?? false);
    const stored = this.logs.get(key) ?? [];
    for (const text of lines) stored.push({ timeMs: this.nowMs(), text });
    this.logs.set(key, stored);
  }

  /** metrics.k8s.io usage of one pod (`<pod>` or `<namespace>/<pod>`), per container */
  setPodMetrics(pod: string, usage: Record<string, { cpu: string; memory: string }>): void {
    this.podMetrics.set(pod.includes('/') ? pod : `*/${pod}`, usage);
  }

  /** adds a Node (`server*` names are control-plane nodes unless `role` says otherwise) */
  addNode(name: string, options: FakeNodeOptions = {}): void {
    const server = (options.role ?? (/^(agent|worker)/.test(name) ? 'agent' : 'server')) === 'server';
    const index = this.entriesOf('Node').length;
    const ip = fakeNode(name.replace(/-/g, '_')).host;
    const time = this.nowIso();
    const pressure = (type: string, reason: string, message: string): Obj => ({
      lastHeartbeatTime: time,
      lastTransitionTime: time,
      message,
      reason,
      status: 'False',
      type,
    });
    const ready = options.ready ?? true;
    this.seed({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: {
        name,
        labels: {
          'beta.kubernetes.io/arch': 'amd64',
          'beta.kubernetes.io/instance-type': 'k3s',
          'beta.kubernetes.io/os': 'linux',
          [KUBE_KEYS.arch]: 'amd64',
          [KUBE_KEYS.hostname]: name,
          [KUBE_KEYS.os]: 'linux',
          'node.kubernetes.io/instance-type': 'k3s',
          ...(server ? { 'node-role.kubernetes.io/control-plane': 'true', 'node-role.kubernetes.io/master': 'true' } : {}),
          ...options.labels,
        },
        annotations: { 'k3s.io/hostname': name, 'k3s.io/internal-ip': ip },
      },
      spec: {
        podCIDR: `10.42.${index}.0/24`,
        podCIDRs: [`10.42.${index}.0/24`],
        providerID: `k3s://${name}`,
        ...(options.taints ? { taints: options.taints } : {}),
      },
      status: {
        addresses: [
          { address: ip, type: 'InternalIP' },
          { address: name, type: 'Hostname' },
        ],
        allocatable: { cpu: '4', 'ephemeral-storage': '61255492742', memory: '16261528Ki', pods: '110' },
        capacity: { cpu: '4', 'ephemeral-storage': '62969360Ki', memory: '16261528Ki', pods: '110' },
        conditions: [
          pressure('MemoryPressure', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'),
          pressure('DiskPressure', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'),
          pressure('PIDPressure', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'),
          ready
            ? { lastHeartbeatTime: time, lastTransitionTime: time, message: 'kubelet is posting ready status', reason: 'KubeletReady', status: 'True', type: 'Ready' }
            : { lastHeartbeatTime: time, lastTransitionTime: time, message: 'Kubelet stopped posting node status.', reason: 'NodeStatusUnknown', status: 'Unknown', type: 'Ready' },
        ],
        nodeInfo: {
          architecture: 'amd64',
          containerRuntimeVersion: 'containerd://2.1.4-k3s1',
          kernelVersion: '6.8.0-60-generic',
          kubeProxyVersion: this.serverVersion,
          kubeletVersion: this.serverVersion,
          operatingSystem: 'linux',
          osImage: 'Ubuntu 24.04.2 LTS',
        },
      },
    });
  }

  /** a NotReady node takes no new pods and its pods lose readiness */
  setNodeReady(name: string, ready: boolean): void {
    const node = this.find(infoOf('Node'), undefined, name);
    if (!node) throw new Error(`FakeCluster has no node ${name}`);
    const time = this.nowIso();
    this.mutate(node, (object) => {
      const status = child(object, 'status');
      status.conditions = objList(status.conditions).map((condition) =>
        condition.type !== 'Ready'
          ? condition
          : ready
            ? { lastHeartbeatTime: time, lastTransitionTime: time, message: 'kubelet is posting ready status', reason: 'KubeletReady', status: 'True', type: 'Ready' }
            : { lastHeartbeatTime: time, lastTransitionTime: time, message: 'Kubelet stopped posting node status.', reason: 'NodeStatusUnknown', status: 'Unknown', type: 'Ready' },
      );
    });
  }

  /** Node names, in creation order */
  get nodes(): string[] {
    return this.entriesOf('Node').map((entry) => entry.object.metadata.name);
  }

  /**
   * Stores objects as they are (no validation, no rejection), as if another client had created
   * them; missing namespaces are created. Controllers pick seeded workloads up like applied ones,
   * unless `reconcile: false` freezes them (a recorded fixture loaded as static state).
   */
  seed(objects: KubeObject | readonly KubeObject[] | string, options: { reconcile?: boolean } = {}): KubeObject[] {
    const list: KubeObject[] =
      typeof objects === 'string' ? this.parseDocuments(objects).map((doc) => doc as KubeObject) : Array.isArray(objects) ? [...objects] : [objects as KubeObject];
    return list.map((raw) => {
      const object = clone(raw);
      const info = KINDS.find((candidate) => candidate.apiVersion === object.apiVersion && candidate.kind === object.kind);
      if (!info) throw new Error(`FakeCluster cannot seed ${object.apiVersion} ${object.kind}`);
      if (info.namespaced) {
        object.metadata.namespace ??= 'default';
        const namespace = object.metadata.namespace;
        if (namespace !== undefined && !this.find(infoOf('Namespace'), undefined, namespace)) {
          this.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
        }
      } else delete object.metadata.namespace;
      const existing = this.find(info, object.metadata.namespace, object.metadata.name);
      if (existing) this.removeEntry(existing);
      this.prepareCreate(info, object);
      const entry = this.insert(info, object, 'seed', 'Update', new Set(pathValues(object).keys()), true);
      if (options.reconcile === false) entry.state.frozen = true;
      return clone(entry.object);
    });
  }

  /** a copy of one stored object (`kind` as a Kind or a resource name) */
  get(kind: string, name: string, namespace?: string): KubeObject | undefined {
    this.sync();
    const info = resourceInfo(kind);
    if (!info) throw new Error(`FakeCluster has no resource ${kind}`);
    const found = this.find(info, info.namespaced ? (namespace ?? 'default') : undefined, name);
    return found ? clone(found.object) : undefined;
  }

  /** copies of stored objects of one kind, optionally narrowed to a namespace and a label selector */
  list(kind: string, options: { namespace?: string; selector?: string } = {}): KubeObject[] {
    this.sync();
    const info = resourceInfo(kind);
    if (!info) throw new Error(`FakeCluster has no resource ${kind}`);
    return this.select(info, info.namespaced ? (options.namespace ?? null) : undefined, options.selector).map((entry) => clone(entry.object));
  }

  /** ready endpoint addresses of a Service (from its EndpointSlice) */
  endpointsOf(service: string, namespace = 'default'): string[] {
    this.sync();
    const slices = this.select(infoOf('EndpointSlice'), namespace, `kubernetes.io/service-name=${service}`);
    return slices.flatMap((slice) =>
      objList(slice.object.endpoints)
        .filter((endpoint) => obj(endpoint.conditions).ready === true)
        .flatMap((endpoint) => (Array.isArray(endpoint.addresses) ? endpoint.addresses.map(String) : [])),
    );
  }

  /** throws when the cluster recorded a problem (a test mistake) */
  assertNoProblems(): void {
    if (this.problems.length > 0) throw new Error(`FakeCluster problems:\n${this.problems.join('\n')}`);
  }

  // ---- KubeCallHandler --------------------------------------------------------------------------

  async handle(request: KubeRequest): Promise<KubectlResult> {
    this.sync();
    let args = request.call.args;
    let namespace = request.call.namespace;
    if (request.method === 'shell' || request.method === 'channel' || request.method === 'interactive') {
      const parsed = this.scriptCall(args[0] ?? '');
      args = parsed.args;
      namespace = parsed.namespace;
    }
    const argv = parseArgv(args);
    namespace = flag(argv, '-n', '--namespace') ?? namespace;
    try {
      this.connectionRejection(argv.verb);
      return await this.dispatch(argv, namespace, request);
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      if (error instanceof SelectorError) return { exitCode: 1, stdout: '', stderr: line(`error: ${error.message}`) };
      throw error;
    }
  }

  private async dispatch(argv: Argv, namespace: string | undefined, request: KubeRequest): Promise<KubectlResult> {
    const stdin = request.stdinText;
    switch (argv.verb) {
      case 'apply':
        return this.applyVerb(argv, namespace, stdin);
      case 'create':
        return this.createVerb(argv, namespace, stdin);
      case 'replace':
        return this.replaceVerb(argv, namespace, stdin);
      case 'delete':
        return this.deleteVerb(argv, namespace, stdin);
      case 'get':
        return this.getVerb(argv, namespace);
      case 'api-resources':
        return this.apiResources(argv);
      case 'version':
        return this.versionVerb();
      case 'scale':
        return this.scaleVerb(argv, namespace);
      case 'rollout':
        return this.rolloutVerb(argv, namespace);
      case 'patch':
        return this.patchVerb(argv, namespace);
      case 'label':
      case 'annotate':
        return this.labelVerb(argv, namespace);
      case 'cordon':
      case 'uncordon':
      case 'drain':
        return this.nodeVerb(argv);
      case 'wait':
        return this.waitVerb(argv, namespace);
      case 'exec':
        return this.execVerb(argv, namespace, stdin, request.method === 'interactive');
      case 'logs':
        return this.logsVerb(argv, namespace);
      default:
        return this.problem(`kubectl ${argv.verb} is not served by FakeCluster (${request.commandString}); answer it with a FakeKubeExecutor script row`);
    }
  }

  private problem(message: string): never {
    this.problems.push(message);
    throw new Error(`FakeCluster: ${message}`);
  }

  /** `<kubectl prefix> [global flags] <args>` of a shell/channel/interactive script */
  private scriptCall(script: string): { args: string[]; namespace?: string } {
    let tokens: ReturnType<typeof shellTokens>;
    try {
      tokens = shellTokens(script);
    } catch (error) {
      return this.problem(`cannot parse the script ${script}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const words = tokens.map((token) => token.value);
    const at = words.indexOf('kubectl');
    if (tokens.some((token) => token.kind === 'op') || at === -1) {
      return this.problem(`cannot run the shell script ${script}; answer it with a FakeKubeExecutor script row`);
    }
    let i = at + 1;
    let namespace: string | undefined;
    while (i < words.length) {
      const word = words[i];
      if (word.startsWith('--kubeconfig=') || word.startsWith('--request-timeout=')) i += 1;
      else if (word === '-n' || word === '--namespace') {
        namespace = words[i + 1];
        i += 2;
      } else if (word.startsWith('--namespace=')) {
        namespace = word.slice('--namespace='.length);
        i += 1;
      } else break;
    }
    return { args: words.slice(i), ...(namespace !== undefined ? { namespace } : {}) };
  }

  // ---- fault injection --------------------------------------------------------------------------

  /** the rule's stderr: literal text, a `<Reason>/<n>.txt` fixture, or the first sample of its reason */
  private stderrFor(rule: RejectRule): string {
    if (rule.stderr === null) return kubectlStderrSample(rule.reason);
    if (/^[A-Za-z]+\/[\w.-]+\.txt$/.test(rule.stderr)) {
      const path = join(STDERR_FIXTURES, rule.stderr);
      if (!existsSync(path)) throw new Error(`No kubectl stderr fixture ${rule.stderr} under ${STDERR_FIXTURES}`);
      return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    }
    return rule.stderr;
  }

  /** Unauthorized and Unreachable fail the whole call before anything happens */
  private connectionRejection(verb: string): void {
    for (const rule of this.rejections) {
      if (rule.remaining <= 0 || (rule.reason !== 'Unauthorized' && rule.reason !== 'Unreachable')) continue;
      if (rule.match.verb !== undefined && rule.match.verb !== '*' && rule.match.verb !== verb) continue;
      rule.remaining -= 1;
      refuse(this.stderrFor(rule));
    }
  }

  /** the stderr of the first rule rejecting this object, if any */
  private rejection(verb: string, info: KindInfo, name: string, namespace: string | undefined, dryRun = false): string | null {
    for (const rule of this.rejections) {
      if (rule.remaining <= 0 || rule.reason === 'Unauthorized' || rule.reason === 'Unreachable') continue;
      if (dryRun && !rule.dryRun) continue;
      const match = rule.match;
      if (match.verb !== undefined && match.verb !== '*' && match.verb !== verb) continue;
      if (match.kind !== undefined && match.kind !== info.kind) continue;
      if (match.namespace !== undefined && match.namespace !== namespace) continue;
      if (match.name !== undefined && !(match.name instanceof RegExp ? match.name.test(name) : match.name === name)) continue;
      rule.remaining -= 1;
      return this.stderrFor(rule);
    }
    return null;
  }

  // ---- store primitives -------------------------------------------------------------------------

  private key(kind: string, namespace: string | undefined, name: string): string {
    return `${kind}|${namespace ?? ''}|${name}`;
  }

  private find(info: KindInfo, namespace: string | undefined, name: string): Entry | undefined {
    return this.entries.get(this.key(info.kind, info.namespaced ? namespace : undefined, name));
  }

  private entry(object: KubeObject): Entry | undefined {
    return object.metadata.uid !== undefined ? this.byUid.get(object.metadata.uid) : undefined;
  }

  private entriesOf(kind: string): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.info.kind === kind);
  }

  private served(info: KindInfo): boolean {
    if (info.crd === undefined) return true;
    const crd = this.find(infoOf('CustomResourceDefinition'), undefined, info.crd);
    return crd !== undefined && !isDeleting(crd);
  }

  private resolveServed(token: string): KindInfo {
    const info = resourceInfo(token);
    if (!info || !this.served(info)) refuse(noResourceType(token.split('.')[0]));
    return info;
  }

  private namespaceFor(info: KindInfo, namespace: string | undefined): string | undefined {
    return info.namespaced ? (namespace ?? 'default') : undefined;
  }

  /** `namespace` null: every namespace */
  private select(info: KindInfo, namespace: string | null | undefined, selector?: string, fieldSelector?: string): Entry[] {
    const terms = selector !== undefined ? parseLabelSelector(selector) : null;
    return this.entriesOf(info.kind)
      .filter((entry) => !info.namespaced || namespace === null || entry.object.metadata.namespace === namespace)
      .filter((entry) => terms === null || selectorMatches(labelsOf(entry.object), terms))
      .filter((entry) => fieldSelector === undefined || fieldSelectorMatches(entry.object, fieldSelector))
      .sort((a, b) => {
        const byNamespace = (a.object.metadata.namespace ?? '').localeCompare(b.object.metadata.namespace ?? '');
        return byNamespace !== 0 ? byNamespace : a.object.metadata.name < b.object.metadata.name ? -1 : a.object.metadata.name > b.object.metadata.name ? 1 : 0;
      });
  }

  private nextUid(): string {
    this.uidCounter += 1;
    return `00000000-0000-4000-8000-${this.uidCounter.toString(16).padStart(12, '0')}`;
  }

  private nextResourceVersion(): string {
    this.rvCounter += 1;
    return String(this.rvCounter);
  }

  private nextSuffix(seed: string): string {
    this.suffixCounter += 1;
    return safeHash(`${seed}/${this.suffixCounter}`, 5);
  }

  /** `keepIdentity`: a seeded object keeps the uid, creationTimestamp and generation it came with */
  private insert(info: KindInfo, object: KubeObject, manager: string, operation: 'Apply' | 'Update', paths: Set<string>, keepIdentity = false): Entry {
    const metadata = object.metadata;
    metadata.uid ??= this.nextUid();
    metadata.resourceVersion = this.nextResourceVersion();
    if (!keepIdentity || metadata.creationTimestamp === undefined) metadata.creationTimestamp = this.nowIso();
    if (info.generation && (!keepIdentity || metadata.generation === undefined)) metadata.generation = 1;
    delete metadata.managedFields;
    const entry: Entry = {
      info,
      object,
      managers: new Map([[manager, { operation, paths, time: this.nowIso() }]]),
      state: { createdTick: this.ticks },
    };
    this.entries.set(this.key(info.kind, metadata.namespace, metadata.name), entry);
    this.byUid.set(metadata.uid, entry);
    this.afterInsert(entry);
    return entry;
  }

  /** objects a controller creates: no validation, owned by the controller */
  private insertSystem(object: KubeObject, manager = 'kube-controller-manager'): Entry {
    const info = infoOf(object.kind);
    return this.insert(info, object, manager, 'Update', new Set(pathValues(object).keys()));
  }

  /** a status-style write: bumps resourceVersion only when something changed */
  private mutate(entry: Entry, change: (object: KubeObject) => void): boolean {
    const before = JSON.stringify(entry.object);
    change(entry.object);
    if (JSON.stringify(entry.object) === before) return false;
    entry.object.metadata.resourceVersion = this.nextResourceVersion();
    return true;
  }

  /** an API write of a whole new object (apply, replace, patch, scale, label, ...) */
  private write(entry: Entry, next: KubeObject, manager: string, operation: 'Apply' | 'Update', applied?: Map<string, string>): boolean {
    const before = entry.object;
    const time = this.nowIso();
    const specChanged = entry.info.generation && !same(without(before, ['metadata', 'status']), without(next, ['metadata', 'status']));
    if (before.metadata.generation !== undefined) next.metadata.generation = before.metadata.generation + (specChanged ? 1 : 0);
    next.metadata.resourceVersion = before.metadata.resourceVersion;
    const ownership =
      operation === 'Apply' && applied !== undefined
        ? claimApplied(entry.managers, manager, applied, pathValues(before), time)
        : claimUpdated(entry.managers, manager, before, next, time);
    if (!ownership && same(before, next)) return false;
    next.metadata.resourceVersion = this.nextResourceVersion();
    entry.object = next;
    if (specChanged && ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(entry.info.kind)) entry.state.syncAfterTick = this.ticks + this.lagTicks;
    if (entry.info.kind === 'PersistentVolume' && obj(before.spec).persistentVolumeReclaimPolicy !== obj(next.spec).persistentVolumeReclaimPolicy) {
      entry.state.policyTick = this.ticks;
    }
    if (entry.info.kind === 'Service' && obj(next.spec).type !== 'LoadBalancer') {
      const status = obj(next.status);
      if (isObj(status.loadBalancer)) status.loadBalancer = {};
    }
    return true;
  }

  /** allocation and creation-time fields; returns the paths the creating manager owns on top of its own */
  private prepareCreate(info: KindInfo, object: KubeObject): Set<string> {
    const owned = new Set<string>();
    const metadata = object.metadata;
    if (metadata.name === undefined || metadata.name === '') {
      if (metadata.generateName === undefined) refuse('error: resource name may not be empty');
      metadata.name = `${metadata.generateName}${this.nextSuffix(metadata.generateName)}`;
    }
    if (info.kind === 'Namespace') {
      metadata.labels = { ...metadata.labels, 'kubernetes.io/metadata.name': metadata.name };
      object.spec = { finalizers: ['kubernetes'] };
      if (!isObj(object.status)) object.status = { phase: 'Active' };
    } else if (info.kind === 'Service') {
      const spec = child(object, 'spec');
      if (spec.clusterIP !== 'None' && spec.type !== 'ExternalName' && spec.clusterIP === undefined) {
        this.ipCounter += 1;
        spec.clusterIP = `10.43.${Math.floor(this.ipCounter / 250)}.${(this.ipCounter % 250) + 2}`;
      }
      if (spec.clusterIP !== undefined && spec.clusterIPs === undefined) spec.clusterIPs = [spec.clusterIP];
      if (!isObj(object.status)) object.status = { loadBalancer: {} };
    } else if (info.kind === 'Job') {
      // the registry writes these on create, attributed to the creating manager (kubernetes#118645, K43)
      metadata.uid ??= this.nextUid();
      const uid = metadata.uid;
      const spec = child(object, 'spec');
      const template = child(spec, 'template');
      const templateMeta = child(template, 'metadata');
      const labels = { ...strMap(templateMeta.labels) };
      for (const key of JOB_UID_LABELS) labels[key] = uid;
      for (const key of JOB_NAME_LABELS) labels[key] = metadata.name;
      templateMeta.labels = labels;
      if (spec.selector === undefined) spec.selector = { matchLabels: { [JOB_UID_LABELS[0]]: uid } };
      for (const key of [...JOB_UID_LABELS, ...JOB_NAME_LABELS]) owned.add(['spec', 'template', 'metadata', 'labels', key].join(SEP));
      owned.add(['spec', 'selector', 'matchLabels', JOB_UID_LABELS[0]].join(SEP));
      if (!isObj(object.status)) object.status = {};
    } else if (info.kind === 'PersistentVolumeClaim') {
      metadata.finalizers = [...new Set([...(metadata.finalizers ?? []), PVC_PROTECTION])];
      if (!isObj(object.status)) object.status = { phase: 'Pending' };
    } else if (info.kind === 'PersistentVolume') {
      metadata.finalizers = [...new Set([...(metadata.finalizers ?? []), PV_PROTECTION])];
      if (!isObj(object.status)) object.status = { phase: obj(obj(object.spec).claimRef).name !== undefined ? 'Bound' : 'Available' };
    } else if (info.kind === 'Pod') {
      if (!isObj(object.status)) object.status = { phase: 'Pending', qosClass: this.qosClass(object) };
    } else if (info.kind === 'CustomResourceDefinition' && !isObj(object.status)) {
      const time = this.nowIso();
      object.status = {
        acceptedNames: obj(obj(object.spec).names),
        conditions: [
          { lastTransitionTime: time, message: 'no conflicts found', reason: 'NoConflicts', status: 'True', type: 'NamesAccepted' },
          { lastTransitionTime: time, message: 'the initial names have been accepted', reason: 'InitialNamesAccepted', status: 'True', type: 'Established' },
        ],
      };
    } else if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(info.kind) && !isObj(object.status)) {
      object.status = {};
    }
    return owned;
  }

  private afterInsert(entry: Entry): void {
    const kind = entry.info.kind;
    if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(kind)) entry.state.syncAfterTick = this.ticks + this.lagTicks;
    if (kind === 'Pod') {
      const behaviors: Record<string, PodBehavior> = {};
      for (const container of [...containersOf(entry.object, 'initContainers'), ...containersOf(entry.object)]) {
        behaviors[strOf(container.name) ?? ''] = this.behaviorFor(strOf(container.image) ?? '');
      }
      entry.state.behaviors = behaviors;
      entry.state.emitted = new Set();
    }
    if (kind === 'PersistentVolumeClaim') {
      const storageClass = this.storageClassFor(entry.object);
      if (storageClass && storageClass.volumeBindingMode === 'WaitForFirstConsumer') {
        this.emitEvent(entry.object, 'Normal', 'WaitForFirstConsumer', 'waiting for first consumer to be created before binding', 'persistentvolume-controller');
      }
    }
  }

  private behaviorFor(image: string): PodBehavior {
    for (let i = this.behaviors.length - 1; i >= 0; i--) {
      if (imageMatches(this.behaviors[i].pattern, image)) return this.behaviors[i].behavior;
    }
    return DEFAULT_POD_BEHAVIOR;
  }

  private qosClass(pod: KubeObject): string {
    const resources = containersOf(pod).map((container) => obj(container.resources));
    if (resources.every((r) => Object.keys(obj(r.requests)).length === 0 && Object.keys(obj(r.limits)).length === 0)) return 'BestEffort';
    const guaranteed = resources.every((r) => Object.keys(obj(r.limits)).length > 0 && (Object.keys(obj(r.requests)).length === 0 || same(r.requests, r.limits)));
    return guaranteed ? 'Guaranteed' : 'Burstable';
  }

  /** removes an object now, with the side effects of its disappearance */
  private removeEntry(entry: Entry): void {
    const metadata = entry.object.metadata;
    this.entries.delete(this.key(entry.info.kind, metadata.namespace, metadata.name));
    if (metadata.uid !== undefined) this.byUid.delete(metadata.uid);
    if (entry.info.kind === 'PersistentVolumeClaim') {
      for (const pv of this.entriesOf('PersistentVolume')) {
        const claimRef = obj(obj(pv.object.spec).claimRef);
        if (claimRef.uid !== metadata.uid) continue;
        pv.state.releasedTick = this.ticks;
        this.mutate(pv, (object) => {
          const status = child(object, 'status');
          status.phase = 'Released';
          status.lastPhaseTransitionTime = this.nowIso();
        });
      }
    }
  }

  private dependentsOf(entry: Entry): Entry[] {
    const uid = entry.object.metadata.uid;
    return [...this.entries.values()].filter((candidate) => (candidate.object.metadata.ownerReferences ?? []).some((ref) => ref.uid === uid));
  }

  private ownedBy(owner: Entry, kind: string): Entry[] {
    const uid = owner.object.metadata.uid;
    return this.entriesOf(kind).filter((candidate) =>
      (candidate.object.metadata.ownerReferences ?? []).some((ref) => ref.uid === uid && ref.controller === true),
    );
  }

  /** starts deleting an object; returns false when it was already being deleted */
  private deleteEntry(entry: Entry, options: { cascade?: string; graceSeconds?: number } = {}): void {
    const cascade = options.cascade ?? 'background';
    if (entry.info.kind === 'Pod') {
      const grace = options.graceSeconds ?? numOf(obj(entry.object.spec).terminationGracePeriodSeconds) ?? 30;
      if (isDeleting(entry)) {
        const due = this.ticks + Math.max(0, grace);
        if (entry.state.terminateAtTick === undefined || due < entry.state.terminateAtTick) entry.state.terminateAtTick = due;
        if (grace <= 0) this.removeEntry(entry);
        return;
      }
      if (grace <= 0 || isTerminal(entry) || obj(entry.object.spec).nodeName === undefined) {
        this.removeEntry(entry);
        return;
      }
      entry.state.terminateAtTick = this.ticks + grace;
      this.mutate(entry, (object) => {
        object.metadata.deletionTimestamp = isoSeconds(this.nowMs() + grace * 1000);
        object.metadata.deletionGracePeriodSeconds = grace;
      });
      for (const container of containersOf(entry.object)) {
        this.emitEvent(entry.object, 'Normal', 'Killing', `Stopping container ${strOf(container.name) ?? ''}`, 'kubelet');
      }
      return;
    }
    if (isDeleting(entry)) return;
    const dependents = this.dependentsOf(entry);
    if (cascade === 'orphan') {
      for (const dependent of dependents) {
        this.mutate(dependent, (object) => {
          const refs = (object.metadata.ownerReferences ?? []).filter((ref) => ref.uid !== entry.object.metadata.uid);
          if (refs.length > 0) object.metadata.ownerReferences = refs;
          else delete object.metadata.ownerReferences;
        });
      }
    }
    const foreground = cascade === 'foreground' && dependents.length > 0;
    const finalizers = [...(entry.object.metadata.finalizers ?? []), ...(foreground ? [FOREGROUND] : [])];
    const namespaceFinalizer = entry.info.kind === 'Namespace';
    if (finalizers.length === 0 && !namespaceFinalizer) {
      this.removeEntry(entry);
      return;
    }
    this.mutate(entry, (object) => {
      object.metadata.deletionTimestamp = this.nowIso();
      object.metadata.deletionGracePeriodSeconds = 0;
      if (finalizers.length > 0) object.metadata.finalizers = finalizers;
      if (namespaceFinalizer) child(object, 'status').phase = 'Terminating';
    });
    if (foreground) for (const dependent of dependents) this.deleteEntry(dependent, { cascade: 'foreground' });
    this.settle(entry);
  }

  private finalizerSatisfied(entry: Entry, finalizer: string): boolean {
    switch (finalizer) {
      case PVC_PROTECTION: {
        const namespace = entry.object.metadata.namespace;
        return !this.entriesOf('Pod').some(
          (pod) => pod.object.metadata.namespace === namespace && !isTerminal(pod) && podClaims(pod.object).includes(entry.object.metadata.name),
        );
      }
      case PV_PROTECTION:
        return strOf(obj(entry.object.status).phase) !== 'Bound';
      case FOREGROUND:
        return this.dependentsOf(entry).length === 0;
      default:
        return false;
    }
  }

  /** removes satisfied finalizers of a deleting object and the object once none is left */
  private settle(entry: Entry): void {
    if (!isDeleting(entry) || !this.entries.has(this.key(entry.info.kind, entry.object.metadata.namespace, entry.object.metadata.name))) return;
    if (entry.info.kind === 'Pod') {
      if ((entry.object.metadata.finalizers ?? []).length === 0 && entry.state.terminateAtTick !== undefined && entry.state.terminateAtTick <= this.ticks) {
        this.removeEntry(entry);
      }
      return;
    }
    const finalizers = entry.object.metadata.finalizers ?? [];
    const remaining = finalizers.filter((finalizer) => !this.finalizerSatisfied(entry, finalizer));
    if (remaining.length !== finalizers.length) {
      this.mutate(entry, (object) => {
        if (remaining.length > 0) object.metadata.finalizers = remaining;
        else delete object.metadata.finalizers;
      });
    }
    if (remaining.length > 0) return;
    if (entry.info.kind === 'Namespace') {
      const contents = [...this.entries.values()].filter((candidate) => candidate.info.namespaced && candidate.object.metadata.namespace === entry.object.metadata.name);
      for (const content of contents) this.deleteEntry(content);
      if (contents.some((content) => this.byUid.has(content.object.metadata.uid ?? ''))) return;
    }
    this.removeEntry(entry);
  }

  // ---- documents --------------------------------------------------------------------------------

  private parseDocuments(text: string): Obj[] {
    const out: Obj[] = [];
    for (const doc of parseAllDocuments(text)) {
      const error = doc.errors[0];
      if (error) refuse(`error: error parsing STDIN: ${error.message.split('\n')[0]}`);
      const value: unknown = doc.toJS();
      if (value === null || value === undefined) continue;
      if (!isObj(value)) refuse('error: error parsing STDIN: document is not an object');
      if (value.kind === 'List' && Array.isArray(value.items)) out.push(...value.items.filter(isObj));
      else out.push(value);
    }
    return out;
  }

  /** kind, namespace and name of a stdin document, or the kubectl error for it */
  private documentTarget(doc: Obj, namespace: string | undefined): { info: KindInfo; object: KubeObject } | { error: string } {
    const apiVersion = strOf(doc.apiVersion) ?? '';
    const kind = strOf(doc.kind) ?? '';
    const metadata = obj(doc.metadata);
    const name = strOf(metadata.name) ?? '';
    const info = KINDS.find((candidate) => candidate.apiVersion === apiVersion && candidate.kind === kind);
    if (!info || !this.served(info)) return { error: noKindMatch(name, strOf(metadata.namespace) ?? namespace, kind, apiVersion) };
    const object = clone(doc) as KubeObject;
    object.metadata = { ...clone(metadata), name } as KubeObjectMeta;
    if (info.namespaced) {
      const own = strOf(metadata.namespace);
      if (own !== undefined && namespace !== undefined && own !== namespace) {
        return {
          error: `error: the namespace from the provided object "${own}" does not match the namespace "${namespace}". You must pass '--namespace=${own}' to perform this operation.`,
        };
      }
      object.metadata.namespace = own ?? namespace ?? 'default';
    } else delete object.metadata.namespace;
    return { info, object };
  }

  /** schema validation (design-07 7.4): a failure is a test mistake, not an API answer */
  private validate(object: Obj, verb: string): void {
    const issues = validateObject(object).filter((issue) => issue.severity !== 'warning');
    if (issues.length === 0) return;
    this.problem(`${verb} received an object that fails schema validation:\n${issues.map((issue) => `  ${formatIssue(object, issue)}`).join('\n')}`);
  }

  private namespaceProblem(info: KindInfo, object: KubeObject, creating: boolean): string | null {
    if (!info.namespaced) return null;
    const namespace = object.metadata.namespace ?? 'default';
    const ns = this.find(infoOf('Namespace'), undefined, namespace);
    if (!ns) return `Error from server (NotFound): error when creating "STDIN": namespaces "${namespace}" not found`;
    if (creating && isDeleting(ns)) {
      return `Error from server (Forbidden): error when creating "STDIN": ${resourceLabel(info)} "${object.metadata.name}" is forbidden: unable to create new content in namespace ${namespace} because it is being terminated`;
    }
    return null;
  }

  // ---- apply / create / replace -----------------------------------------------------------------

  private applyVerb(argv: Argv, namespace: string | undefined, stdin: string): KubectlResult {
    if (!hasFlag(argv, '--server-side')) return this.problem('client-side kubectl apply is not served by FakeCluster');
    const manager = flag(argv, '--field-manager') ?? 'kubectl';
    const dryRun = flag(argv, '--dry-run') === 'server';
    const out: string[] = [];
    const errors: string[] = [];
    for (const doc of this.parseDocuments(stdin)) {
      const result = this.applyOne(doc, namespace, manager, dryRun);
      if ('error' in result) errors.push(result.error);
      else out.push(result.line);
    }
    return done(out, errors);
  }

  private applyOne(doc: Obj, namespace: string | undefined, manager: string, dryRun: boolean): { line: string } | { error: string } {
    const target = this.documentTarget(doc, namespace);
    if ('error' in target) return target;
    const { info, object } = target;
    const name = object.metadata.name;
    if (name === '') return { error: 'error: resource name may not be empty' };
    const rejected = this.rejection('apply', info, name, object.metadata.namespace, dryRun);
    if (rejected !== null) return { error: rejected };
    this.validate(doc, 'apply');
    const incoming = without(object, ['status']) as KubeObject;
    stripIdentity(incoming);
    const applied = pathValues(incoming);
    const paths = new Set(applied.keys());
    const suffix = dryRun ? ' (server dry run)' : '';
    const existing = this.find(info, object.metadata.namespace, name);
    if (!existing) {
      const nsProblem = this.namespaceProblem(info, incoming, true);
      if (nsProblem !== null) return { error: nsProblem };
      const created = clone(incoming);
      const generated = this.prepareCreate(info, created);
      if (!dryRun) this.insert(info, created, manager, 'Apply', new Set([...paths, ...generated]));
      return { line: `${objectRef(info, name)} serverside-applied${suffix}` };
    }
    const next = clone(existing.object);
    const previous = existing.managers.get(manager)?.paths ?? new Set<string>();
    for (const path of previous) {
      if (paths.has(path)) continue;
      const others = [...existing.managers].some(([other, entry]) => other !== manager && [...entry.paths].some((owned) => related(owned, path)));
      if (!others) deletePath(next, path);
    }
    mergeInto(next, without(incoming, ['apiVersion', 'kind']));
    this.preserveAllocated(info, existing.object, next);
    const violation = this.immutableViolation(info, existing.object, next);
    if (violation !== null) return { error: violation };
    if (!dryRun) this.write(existing, next, manager, 'Apply', applied);
    return { line: `${objectRef(info, name)} serverside-applied${suffix}` };
  }

  /** a Service keeps its allocated cluster IP when a write omits it (the registry copies it over) */
  private preserveAllocated(info: KindInfo, before: KubeObject, next: KubeObject): void {
    if (info.kind !== 'Service') return;
    const old = obj(before.spec);
    const spec = child(next, 'spec');
    if (spec.clusterIP === undefined && old.clusterIP !== undefined) spec.clusterIP = old.clusterIP;
    if (spec.clusterIPs === undefined && old.clusterIPs !== undefined) spec.clusterIPs = old.clusterIPs;
  }

  private createVerb(argv: Argv, namespace: string | undefined, stdin: string): KubectlResult {
    if (flag(argv, '-f', '--filename') !== '-') return this.problem(`kubectl create ${argv.positionals.join(' ')} is not served by FakeCluster; create from stdin`);
    const output = flag(argv, '-o', '--output');
    const created: KubeObject[] = [];
    const out: string[] = [];
    const errors: string[] = [];
    for (const doc of this.parseDocuments(stdin)) {
      const target = this.documentTarget(doc, namespace);
      if ('error' in target) {
        errors.push(target.error);
        continue;
      }
      const { info, object } = target;
      const rejected = this.rejection('create', info, object.metadata.name, object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      this.validate(doc, 'create');
      if (object.metadata.resourceVersion !== undefined) {
        errors.push('Error from server (BadRequest): error when creating "STDIN": resourceVersion should not be set on objects to be created');
        continue;
      }
      const nsProblem = this.namespaceProblem(info, object, true);
      if (nsProblem !== null) {
        errors.push(nsProblem);
        continue;
      }
      if (object.metadata.name !== '' && this.find(info, object.metadata.namespace, object.metadata.name)) {
        errors.push(`Error from server (AlreadyExists): error when creating "STDIN": ${resourceLabel(info)} "${object.metadata.name}" already exists`);
        continue;
      }
      const incoming = without(object, ['status']) as KubeObject;
      stripIdentity(incoming);
      const paths = new Set(pathValues(incoming).keys());
      const generated = this.prepareCreate(info, incoming);
      const entry = this.insert(info, incoming, 'kubectl-create', 'Update', new Set([...paths, ...generated]));
      created.push(clone(entry.object));
      out.push(output === 'name' ? objectRef(info, entry.object.metadata.name) : `${objectRef(info, entry.object.metadata.name)} created`);
    }
    if (output === 'json') {
      const stdout =
        created.length === 1 ? formatKubectlJson(created[0]) : created.length > 1 ? formatKubectlJson({ apiVersion: 'v1', items: created, kind: 'List', metadata: { resourceVersion: '' } }) : '';
      return { exitCode: errors.length > 0 ? 1 : 0, stdout, stderr: errors.map(line).join('') };
    }
    return done(out, errors);
  }

  private replaceVerb(argv: Argv, namespace: string | undefined, stdin: string): KubectlResult {
    if (flag(argv, '-f', '--filename') !== '-') return this.problem('kubectl replace without -f - is not served by FakeCluster');
    const output = flag(argv, '-o', '--output');
    const replaced: KubeObject[] = [];
    const out: string[] = [];
    const errors: string[] = [];
    for (const doc of this.parseDocuments(stdin)) {
      const target = this.documentTarget(doc, namespace);
      if ('error' in target) {
        errors.push(target.error);
        continue;
      }
      const { info, object } = target;
      const name = object.metadata.name;
      const rejected = this.rejection('replace', info, name, object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      this.validate(doc, 'replace');
      const existing = this.find(info, object.metadata.namespace, name);
      if (!existing) {
        errors.push(`Error from server (NotFound): error when replacing "STDIN": ${resourceLabel(info)} "${name}" not found`);
        continue;
      }
      const expected = object.metadata.resourceVersion;
      if (expected !== undefined && expected !== existing.object.metadata.resourceVersion) {
        errors.push(
          `Error from server (Conflict): error when replacing "STDIN": Operation cannot be fulfilled on ${resourceLabel(info)} "${name}": the object has been modified; please apply your changes to the latest version and try again`,
        );
        continue;
      }
      const next = without(object, ['status']) as KubeObject;
      stripIdentity(next);
      for (const key of ['uid', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds']) {
        if (existing.object.metadata[key] !== undefined) next.metadata[key] = existing.object.metadata[key];
      }
      if (existing.object.status !== undefined) next.status = clone(existing.object.status);
      this.preserveAllocated(info, existing.object, next);
      const violation = this.immutableViolation(info, existing.object, next);
      if (violation !== null) {
        errors.push(violation);
        continue;
      }
      this.write(existing, next, 'kubectl-replace', 'Update');
      replaced.push(clone(existing.object));
      out.push(`${objectRef(info, name)} replaced`);
    }
    if (output === 'json') {
      return {
        exitCode: errors.length > 0 ? 1 : 0,
        stdout: replaced.length === 1 ? formatKubectlJson(replaced[0]) : replaced.length > 1 ? formatKubectlJson({ apiVersion: 'v1', items: replaced, kind: 'List', metadata: { resourceVersion: '' } }) : '',
        stderr: errors.map(line).join(''),
      };
    }
    return done(out, errors);
  }

  // ---- immutability -----------------------------------------------------------------------------

  private immutableViolation(info: KindInfo, before: KubeObject, next: KubeObject): string | null {
    const subject = kindSubject(info, before.metadata.name);
    const old = obj(before.spec);
    const spec = obj(next.spec);
    const invalid = (field: string, value: unknown, detail: string): string =>
      `Error from server (Invalid): ${subject} is invalid: ${field}: Invalid value: ${JSON.stringify(value ?? null)}: ${detail}`;
    switch (info.kind) {
      case 'Deployment':
      case 'DaemonSet':
      case 'StatefulSet': {
        if (!same(old.selector, spec.selector)) return invalid('spec.selector', spec.selector, 'field is immutable');
        const allowed = ['replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy', 'minReadySeconds'];
        if (info.kind === 'StatefulSet' && !same(without(old, allowed), without(spec, allowed))) {
          return `Error from server (Invalid): ${subject} is invalid: spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden`;
        }
        return null;
      }
      case 'Job':
        if (!same(old.selector, spec.selector)) return invalid('spec.selector', spec.selector, 'field is immutable');
        if (!same(old.template, spec.template)) return invalid('spec.template', spec.template, 'field is immutable');
        return null;
      case 'Secret':
      case 'ConfigMap':
        if (before.immutable !== true) return null;
        if (next.immutable !== true) return `Error from server (Invalid): ${subject} is invalid: immutable: Forbidden: field is immutable when \`immutable\` is set`;
        for (const field of ['data', 'binaryData', 'stringData']) {
          if (!same(before[field], next[field])) return `Error from server (Invalid): ${subject} is invalid: ${field}: Forbidden: field is immutable when \`immutable\` is set`;
        }
        return null;
      case 'PersistentVolumeClaim': {
        // resources.requests may only change on a bound claim (and then only grow, if the class allows it)
        const bound = strOf(obj(before.status).phase) === 'Bound';
        const strip = (value: Obj): Obj => {
          const copy = clone(value);
          if (bound) delete child(copy, 'resources').requests;
          if (Object.keys(obj(copy.resources)).length === 0) delete copy.resources;
          return copy;
        };
        if (!same(strip(old), strip(spec))) {
          return `Error from server (Invalid): ${subject} is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`;
        }
        const was = strOf(obj(obj(old.resources).requests).storage);
        const now = strOf(obj(obj(spec.resources).requests).storage);
        if (was !== now && was !== undefined && now !== undefined) {
          const bytes = (text: string): number => {
            const match = /^(\d+(?:\.\d+)?)([KMGTPE]i?|[kmgtpe])?$/.exec(text);
            if (!match) return Number.NaN;
            const powers: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
            return Number(match[1]) * (match[2] === undefined ? 1 : (powers[match[2]] ?? 1));
          };
          if (bytes(now) < bytes(was)) {
            return `Error from server (Invalid): ${subject} is invalid: spec.resources.requests.storage: Forbidden: field can not be less than status.capacity`;
          }
          if (this.storageClassFor(before)?.allowVolumeExpansion !== true) {
            return `Error from server (Forbidden): ${resourceLabel(info)} "${before.metadata.name}" is forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize`;
          }
        }
        return null;
      }
      case 'Service':
        if (old.clusterIP !== undefined && spec.clusterIP !== old.clusterIP) {
          return `Error from server (Invalid): ${subject} is invalid: spec.clusterIPs[0]: Invalid value: ${JSON.stringify([spec.clusterIP ?? ''])}: may not change once set`;
        }
        return null;
      default:
        return null;
    }
  }

  // ---- delete -----------------------------------------------------------------------------------

  private async deleteVerb(argv: Argv, namespace: string | undefined, stdin: string): Promise<KubectlResult> {
    const raw = flag(argv, '--raw');
    if (raw !== undefined) return this.deleteRaw(raw, stdin);
    const ignoreNotFound = hasFlag(argv, '--ignore-not-found');
    const cascade = flag(argv, '--cascade') ?? 'background';
    const wait = flag(argv, '--wait') !== 'false';
    const timeoutS = parseDuration(flag(argv, '--timeout'));
    const graceFlag = flag(argv, '--grace-period');
    const graceSeconds = hasFlag(argv, '--now') ? 1 : graceFlag !== undefined && Number(graceFlag) >= 0 ? Number(graceFlag) : undefined;
    const out: string[] = [];
    const errors: string[] = [];
    const pending: { entry: Entry; ref: string }[] = [];
    const { targets, selected } = this.targets(argv, namespace, stdin);
    const entries: Entry[] = [];
    for (const target of targets) {
      const entry = this.find(target.info, target.namespace, target.name);
      if (entry) entries.push(entry);
      else if (!ignoreNotFound) errors.push(notFoundText(target.info, target.name));
    }
    entries.push(...selected);
    for (const entry of entries) {
      const rejected = this.rejection('delete', entry.info, entry.object.metadata.name, entry.object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      this.deleteEntry(entry, { cascade, ...(graceSeconds !== undefined ? { graceSeconds } : {}) });
      out.push(`${entry.info.singular}${groupSuffix(entry.info)} "${entry.object.metadata.name}" deleted`);
      pending.push({ entry, ref: `${resourceLabel(entry.info)}/${entry.object.metadata.name}` });
    }
    if (entries.length === 0 && errors.length === 0 && targets.length === 0) out.push('No resources found');
    if (wait && pending.length > 0) {
      const gone = (): boolean => pending.every(({ entry }) => !this.byUid.has(entry.object.metadata.uid ?? ''));
      if (!(await this.waitFor(gone, timeoutS))) {
        const left = pending.find(({ entry }) => this.byUid.has(entry.object.metadata.uid ?? ''));
        errors.push(`error: timed out waiting for the condition on ${left?.ref ?? 'resources'}`);
      }
    }
    return done(out, errors);
  }

  /** `delete --raw=<uri> -f -` with a DeleteOptions body (design-03 14.2, K30) */
  private deleteRaw(uri: string, stdin: string): KubectlResult {
    const target = this.rawTarget(uri);
    if (!target || target.name === undefined) refuse('Error from server (NotFound): the server could not find the requested resource');
    const { info, namespace, name } = target;
    let body: Obj = {};
    if (stdin.trim() !== '') {
      try {
        body = obj(JSON.parse(stdin));
      } catch {
        refuse('error: unable to decode the DeleteOptions body');
      }
    }
    const entry = this.find(info, namespace, name);
    if (!entry) refuse(notFoundText(info, name));
    const rejected = this.rejection('delete', info, name, namespace);
    if (rejected !== null) refuse(rejected);
    const preconditions = obj(body.preconditions);
    const uid = strOf(preconditions.uid);
    const rv = strOf(preconditions.resourceVersion);
    const failed = `Error from server (Conflict): Operation cannot be fulfilled on ${resourceLabel(info)} "${name}": Precondition failed:`;
    if (uid !== undefined && uid !== entry.object.metadata.uid) refuse(`${failed} UID in precondition: ${uid}, UID in object meta: ${entry.object.metadata.uid}`);
    if (rv !== undefined && rv !== entry.object.metadata.resourceVersion) {
      refuse(`${failed} ResourceVersion in precondition: ${rv}, ResourceVersion in object meta: ${entry.object.metadata.resourceVersion}`);
    }
    const policy = strOf(body.propagationPolicy);
    const grace = numOf(body.gracePeriodSeconds);
    this.deleteEntry(entry, {
      cascade: policy === 'Foreground' ? 'foreground' : policy === 'Orphan' ? 'orphan' : 'background',
      ...(grace !== undefined ? { graceSeconds: grace } : {}),
    });
    const status = { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success', details: { name, group: info.group, kind: info.plural, uid: entry.object.metadata.uid } };
    return { exitCode: 0, stdout: formatCompactJson(status), stderr: '' };
  }

  /** `/api/v1/namespaces/<ns>/<resource>/<name>`, `/apis/<group>/<version>/...`, cluster-scoped forms */
  private rawTarget(uri: string): { info: KindInfo; namespace: string | undefined; name: string | undefined } | null {
    const segments = uri.split('?')[0].split('/').filter((segment) => segment !== '');
    let group: string;
    let rest: string[];
    if (segments[0] === 'api' && segments.length >= 2) {
      group = '';
      rest = segments.slice(2);
    } else if (segments[0] === 'apis' && segments.length >= 3) {
      group = segments[1];
      rest = segments.slice(3);
    } else return null;
    let namespace: string | undefined;
    if (rest[0] === 'namespaces' && rest.length >= 3) {
      namespace = rest[1];
      rest = rest.slice(2);
    }
    const info = KINDS.find((candidate) => candidate.plural === rest[0] && candidate.group === group);
    if (!info || !this.served(info)) return null;
    return { info, namespace: info.namespaced ? (namespace ?? 'default') : undefined, name: rest[1] };
  }

  /**
   * Objects a verb names: `<res>/<name>...`, `<res>[,<res>] <name>...`, `<res> -l <selector>`,
   * `<res> --all` or `-f -`. Missing named objects are returned as targets for the caller to report.
   */
  private targets(argv: Argv, namespace: string | undefined, stdin = '', positionals = argv.positionals): { targets: Target[]; selected: Entry[] } {
    const targets: Target[] = [];
    const selected: Entry[] = [];
    if (flag(argv, '-f', '--filename') === '-') {
      for (const doc of this.parseDocuments(stdin)) {
        const found = this.documentTarget(doc, namespace);
        if ('error' in found) refuse(found.error);
        targets.push({ info: found.info, namespace: found.object.metadata.namespace, name: found.object.metadata.name });
      }
      return { targets, selected };
    }
    const [first, ...rest] = positionals;
    if (first === undefined) refuse(`error: You must provide one or more resources by argument or filename.`);
    if (first.includes('/')) {
      for (const positional of positionals) {
        const slash = positional.indexOf('/');
        if (slash === -1) refuse(`error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form`);
        const info = this.resolveServed(positional.slice(0, slash));
        targets.push({ info, namespace: this.namespaceFor(info, namespace), name: positional.slice(slash + 1) });
      }
      return { targets, selected };
    }
    const infos = first.split(',').map((token) => this.resolveServed(token));
    const selector = flag(argv, '-l', '--selector');
    if (rest.length > 0) {
      for (const info of infos) for (const name of rest) targets.push({ info, namespace: this.namespaceFor(info, namespace), name });
    } else if (selector !== undefined || hasFlag(argv, '--all')) {
      for (const info of infos) selected.push(...this.select(info, info.namespaced ? this.namespaceFor(info, namespace) : undefined, selector));
    } else refuse(`error: resource(s) were provided, but no name was specified`);
    return { targets, selected };
  }

  /** polls `check` once per tick: on the clock when there is one, else by running ticks */
  private async waitFor(check: () => boolean, timeoutS: number | null): Promise<boolean> {
    if (check()) return true;
    if (this.clock) {
      const start = this.clock.now().getTime();
      for (;;) {
        const remaining = timeoutS === null ? this.tickMs : Math.min(this.tickMs, start + timeoutS * 1000 - this.clock.now().getTime());
        if (remaining <= 0) return false;
        await this.clock.sleep(remaining);
        this.sync();
        if (check()) return true;
      }
    }
    const limit = timeoutS === null ? MAX_WAIT_TICKS : Math.ceil((timeoutS * 1000) / this.tickMs);
    for (let i = 0; i < limit; i++) {
      this.runTick();
      if (check()) return true;
    }
    return false;
  }

  // ---- get --------------------------------------------------------------------------------------

  private getVerb(argv: Argv, namespace: string | undefined): KubectlResult {
    const raw = flag(argv, '--raw') ?? (argv.positionals[0]?.startsWith('/') ? argv.positionals[0] : undefined);
    if (raw !== undefined) return this.getRaw(raw);
    if (hasFlag(argv, '-w', '--watch')) return this.problem('kubectl get --watch is not served by FakeCluster');
    const output = flag(argv, '-o', '--output') ?? '';
    const allNamespaces = hasFlag(argv, '-A', '--all-namespaces');
    const ignoreNotFound = hasFlag(argv, '--ignore-not-found');
    const selector = flag(argv, '-l', '--selector');
    const fieldSelector = flag(argv, '--field-selector');
    const showManaged = hasFlag(argv, '--show-managed-fields');
    const [first, ...rest] = argv.positionals;
    if (first === undefined) refuse('error: You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
    const items: Entry[] = [];
    const errors: string[] = [];
    let single = false;
    const requested: { info: KindInfo; names: string[] | null }[] = [];
    if (first.includes('/')) {
      for (const positional of argv.positionals) {
        const slash = positional.indexOf('/');
        const info = this.resolveServed(positional.slice(0, slash));
        requested.push({ info, names: [positional.slice(slash + 1)] });
      }
      single = requested.length === 1;
    } else {
      const infos = first.split(',').map((token) => this.resolveServed(token));
      for (const info of infos) requested.push({ info, names: rest.length > 0 ? rest : null });
      single = infos.length === 1 && rest.length === 1;
    }
    for (const { info, names } of requested) {
      const rejected = this.rejection('get', info, names?.[0] ?? '', this.namespaceFor(info, namespace));
      if (rejected !== null) refuse(rejected);
      if (names !== null) {
        for (const name of names) {
          const entry = this.find(info, this.namespaceFor(info, namespace), name);
          if (entry) items.push(entry);
          else if (!ignoreNotFound) errors.push(notFoundText(info, name));
        }
      } else {
        items.push(...this.select(info, !info.namespaced ? undefined : allNamespaces ? null : this.namespaceFor(info, namespace), selector, fieldSelector));
      }
    }
    const views = items.map((entry) => this.view(entry, showManaged));
    const list = { apiVersion: 'v1', items: views, kind: 'List', metadata: { resourceVersion: '' } };
    let stdout: string;
    if (output === 'json') stdout = single ? (views.length === 1 ? formatKubectlJson(views[0]) : '') : formatKubectlJson(list);
    else if (output === 'name') stdout = items.map((entry) => `${objectRef(entry.info, entry.object.metadata.name)}\n`).join('');
    else if (output.startsWith('go-template=')) {
      let nodes: TemplateNode[];
      try {
        nodes = parseTemplate(output.slice('go-template='.length));
      } catch (error) {
        return this.problem(error instanceof Error ? error.message : String(error));
      }
      stdout = renderTemplate(nodes, single && views.length === 1 ? views[0] : list);
    } else return this.problem(`kubectl get -o ${output || '(table)'} is not served by FakeCluster`);
    return { exitCode: errors.length > 0 ? 1 : 0, stdout, stderr: errors.map(line).join('') };
  }

  private view(entry: Entry, showManaged: boolean): KubeObject {
    const copy = clone(entry.object);
    if (showManaged) {
      copy.metadata.managedFields = [...entry.managers].map(([manager, owned]) => ({
        apiVersion: entry.object.apiVersion,
        fieldsType: 'FieldsV1',
        fieldsV1: fieldsV1(owned.paths),
        manager,
        operation: owned.operation,
        time: owned.time,
      }));
    }
    return copy;
  }

  private getRaw(uri: string): KubectlResult {
    const path = uri.split('?')[0];
    if (path === '/readyz' || path === '/livez' || path === '/healthz') {
      if (!this.apiReady) {
        refuse('Error from server (InternalError): an error on the server ("[+]ping ok\\n[-]etcd failed: reason withheld\\nreadyz check failed") has prevented the request from succeeding');
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    }
    if (path === '/version') return { exitCode: 0, stdout: formatCompactJson(this.versionInfo()), stderr: '' };
    if (path.startsWith('/apis/metrics.k8s.io/')) return this.metrics(path);
    const target = this.rawTarget(path);
    if (!target) refuse('Error from server (NotFound): the server could not find the requested resource');
    if (target.name !== undefined) {
      const entry = this.find(target.info, target.namespace, target.name);
      if (!entry) refuse(notFoundText(target.info, target.name));
      return { exitCode: 0, stdout: formatCompactJson(entry.object), stderr: '' };
    }
    const items = this.select(target.info, target.info.namespaced ? (target.namespace ?? null) : undefined).map((entry) => entry.object);
    return { exitCode: 0, stdout: formatCompactJson({ kind: `${target.info.kind}List`, apiVersion: target.info.apiVersion, metadata: { resourceVersion: String(this.rvCounter) }, items }), stderr: '' };
  }

  private metrics(path: string): KubectlResult {
    if (!this.metricsAvailable) {
      refuse('Error from server (ServiceUnavailable): the server is currently unable to handle the request (get pods.metrics.k8s.io)');
    }
    const segments = path.split('/').filter((segment) => segment !== '').slice(3);
    const time = this.nowIso();
    if (segments[0] === 'nodes') {
      const items = this.entriesOf('Node').map((node) => ({
        metadata: { name: node.object.metadata.name, creationTimestamp: time, labels: labelsOf(node.object) },
        timestamp: time,
        window: '20.041s',
        usage: { cpu: '152000000n', memory: '1843200Ki' },
      }));
      return { exitCode: 0, stdout: formatCompactJson({ kind: 'NodeMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {}, items }), stderr: '' };
    }
    let namespace: string | null = null;
    let rest = segments;
    if (rest[0] === 'namespaces') {
      namespace = rest[1] ?? null;
      rest = rest.slice(2);
    }
    if (rest[0] !== 'pods') refuse('Error from server (NotFound): the server could not find the requested resource');
    const pods = this.select(infoOf('Pod'), namespace)
      .filter((pod) => podPhase(pod) === 'Running' && !isDeleting(pod))
      .filter((pod) => rest[1] === undefined || pod.object.metadata.name === rest[1]);
    const items = pods.map((pod) => {
      const usage =
        this.podMetrics.get(`${pod.object.metadata.namespace}/${pod.object.metadata.name}`) ?? this.podMetrics.get(`*/${pod.object.metadata.name}`) ?? {};
      return {
        metadata: { name: pod.object.metadata.name, namespace: pod.object.metadata.namespace, creationTimestamp: time, labels: labelsOf(pod.object) },
        timestamp: time,
        window: '15.013s',
        containers: containersOf(pod.object).map((container) => {
          const name = strOf(container.name) ?? '';
          return { name, usage: usage[name] ?? { cpu: '1000000n', memory: '10240Ki' } };
        }),
      };
    });
    if (rest[1] !== undefined) {
      if (items.length === 0) refuse(`Error from server (NotFound): podmetrics.metrics.k8s.io "${namespace ?? 'default'}/${rest[1]}" not found`);
      return { exitCode: 0, stdout: formatCompactJson({ kind: 'PodMetrics', apiVersion: 'metrics.k8s.io/v1beta1', ...items[0] }), stderr: '' };
    }
    return { exitCode: 0, stdout: formatCompactJson({ kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {}, items }), stderr: '' };
  }

  private apiResources(argv: Argv): KubectlResult {
    if ((flag(argv, '-o', '--output') ?? '') !== 'name') return this.problem('kubectl api-resources is served with -o name only');
    const group = flag(argv, '--api-group');
    const namespaced = flag(argv, '--namespaced');
    const names = KINDS.filter((info) => this.served(info))
      .filter((info) => group === undefined || info.group === group)
      .filter((info) => namespaced === undefined || String(info.namespaced) === namespaced)
      .map((info) => resourceLabel(info));
    if (this.metricsAvailable && (group === undefined || group === 'metrics.k8s.io')) {
      if (namespaced !== 'true') names.push('nodes.metrics.k8s.io');
      if (namespaced !== 'false') names.push('pods.metrics.k8s.io');
    }
    return { exitCode: 0, stdout: names.sort().map(line).join(''), stderr: '' };
  }

  private versionInfo(): Obj {
    const match = /^v(\d+)\.(\d+)/.exec(this.serverVersion);
    return {
      major: match?.[1] ?? '1',
      minor: match?.[2] ?? '0',
      gitVersion: this.serverVersion,
      gitCommit: '0000000000000000000000000000000000000000',
      gitTreeState: 'clean',
      buildDate: '2026-01-01T00:00:00Z',
      goVersion: 'go1.25.1',
      compiler: 'gc',
      platform: 'linux/amd64',
    };
  }

  private versionVerb(): KubectlResult {
    const info = this.versionInfo();
    return { exitCode: 0, stdout: formatKubectlJson({ clientVersion: info, kustomizeVersion: 'v5.7.1', serverVersion: info }), stderr: '' };
  }

  // ---- workload verbs ---------------------------------------------------------------------------

  private scaleVerb(argv: Argv, namespace: string | undefined): KubectlResult {
    const replicas = Number(flag(argv, '--replicas'));
    if (!Number.isInteger(replicas) || replicas < 0) refuse('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
    const out: string[] = [];
    const errors: string[] = [];
    const { targets, selected } = this.targets(argv, namespace);
    for (const entry of this.existing(targets, errors).concat(selected)) {
      if (!['Deployment', 'StatefulSet', 'ReplicaSet'].includes(entry.info.kind)) {
        errors.push('Error from server (NotFound): the server could not find the requested resource');
        continue;
      }
      const rejected = this.rejection('scale', entry.info, entry.object.metadata.name, entry.object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      const next = clone(entry.object);
      child(next, 'spec').replicas = replicas;
      this.write(entry, next, 'kubectl-scale', 'Update');
      out.push(`${objectRef(entry.info, entry.object.metadata.name)} scaled`);
    }
    return done(out, errors);
  }

  private existing(targets: readonly Target[], errors: string[]): Entry[] {
    const found: Entry[] = [];
    for (const target of targets) {
      const entry = this.find(target.info, target.namespace, target.name);
      if (entry) found.push(entry);
      else errors.push(notFoundText(target.info, target.name));
    }
    return found;
  }

  private rolloutVerb(argv: Argv, namespace: string | undefined): KubectlResult {
    const action = argv.positionals[0];
    const positionals = argv.positionals.slice(1);
    const out: string[] = [];
    const errors: string[] = [];
    const { targets, selected } = this.targets(argv, namespace, '', positionals);
    const entries = this.existing(targets, errors).concat(selected);
    for (const entry of entries) {
      const name = entry.object.metadata.name;
      const rejected = this.rejection(`rollout`, entry.info, name, entry.object.metadata.namespace) ?? this.rejection(`rollout ${action}`, entry.info, name, entry.object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(entry.info.kind)) {
        errors.push(`error: ${objectRef(entry.info, name)}: not a rollout-able resource`);
        continue;
      }
      if (action === 'restart') {
        const next = clone(entry.object);
        const templateMeta = child(child(child(next, 'spec'), 'template'), 'metadata');
        templateMeta.annotations = { ...strMap(templateMeta.annotations), [RESTARTED_AT]: this.nowIso() };
        this.write(entry, next, 'kubectl-rollout', 'Update');
        out.push(`${objectRef(entry.info, name)} restarted`);
      } else if (action === 'undo') {
        const template = this.revisionTemplate(entry, flag(argv, '--to-revision'));
        if (typeof template === 'string') {
          errors.push(template);
          continue;
        }
        const next = clone(entry.object);
        child(next, 'spec').template = template;
        if (!this.write(entry, next, 'kubectl-rollout', 'Update')) out.push(`${objectRef(entry.info, name)} skipped rollback (current template already matches revision)`);
        else out.push(`${objectRef(entry.info, name)} rolled back`);
      } else return this.problem(`kubectl rollout ${action ?? ''} is not served by FakeCluster`);
    }
    return done(out, errors);
  }

  /** the pod template of a stored revision (`--to-revision`, default the previous one), or an error */
  private revisionTemplate(entry: Entry, toRevision: string | undefined): Obj | string {
    const wanted = toRevision !== undefined ? Number(toRevision) : 0;
    if (entry.info.kind === 'Deployment') {
      const sets = this.ownedBy(entry, 'ReplicaSet').sort((a, b) => revisionOf(b) - revisionOf(a));
      const found = wanted > 0 ? sets.find((rs) => revisionOf(rs) === wanted) : sets[1];
      if (!found) return wanted > 0 ? `error: unable to find specified revision ${wanted} in history` : `error: no rollout history found for ${objectRef(entry.info, entry.object.metadata.name)}`;
      const template = clone(obj(obj(found.object.spec).template));
      const templateMeta = child(template, 'metadata');
      const labels = strMap(templateMeta.labels);
      delete labels[KUBE_KEYS.podTemplateHash];
      templateMeta.labels = labels;
      return template;
    }
    const revisions = this.ownedBy(entry, 'ControllerRevision').sort((a, b) => (numOf(b.object.revision) ?? 0) - (numOf(a.object.revision) ?? 0));
    const found = wanted > 0 ? revisions.find((revision) => numOf(revision.object.revision) === wanted) : revisions[1];
    if (!found) return wanted > 0 ? `error: unable to find specified revision ${wanted} in history` : `error: no rollout history found for ${objectRef(entry.info, entry.object.metadata.name)}`;
    const template = clone(obj(obj(obj(found.object.data).spec).template));
    delete template.$patch;
    return template;
  }

  private patchVerb(argv: Argv, namespace: string | undefined): KubectlResult {
    const body = flag(argv, '-p', '--patch');
    if (body === undefined) return this.problem('kubectl patch without -p is not served by FakeCluster');
    const type = flag(argv, '--type') ?? 'strategic';
    const subresource = flag(argv, '--subresource');
    let patch: unknown;
    try {
      patch = JSON.parse(body);
    } catch {
      refuse(`error: unable to parse "${body}": yaml: did not find expected node content`);
    }
    const out: string[] = [];
    const errors: string[] = [];
    const { targets, selected } = this.targets(argv, namespace);
    for (const entry of this.existing(targets, errors).concat(selected)) {
      const name = entry.object.metadata.name;
      const rejected = this.rejection('patch', entry.info, name, entry.object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      let next: KubeObject;
      try {
        next = type === 'json' ? this.jsonPatch(entry.object, patch) : this.mergePatch(entry.object, patch, subresource === 'status');
      } catch (error) {
        errors.push(`The request is invalid: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (subresource !== 'status') {
        if (entry.object.status !== undefined) next.status = clone(entry.object.status);
        else delete next.status;
      }
      stripIdentity(next);
      for (const key of ['uid', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds']) {
        if (entry.object.metadata[key] !== undefined) next.metadata[key] = entry.object.metadata[key];
      }
      this.preserveAllocated(entry.info, entry.object, next);
      const violation = this.immutableViolation(entry.info, entry.object, next);
      if (violation !== null) {
        errors.push(violation);
        continue;
      }
      const changed = this.write(entry, next, 'kubectl-patch', 'Update');
      out.push(`${objectRef(entry.info, name)} patched${changed ? '' : ' (no change)'}`);
    }
    return done(out, errors);
  }

  /** RFC 7386 merge patch; strategic merge patches are applied the same way (lists replaced) */
  private mergePatch(object: KubeObject, patch: unknown, status: boolean): KubeObject {
    if (!isObj(patch)) throw new Error('a merge patch must be a JSON object');
    const apply = (target: Obj, source: Obj): void => {
      for (const [key, value] of Object.entries(source)) {
        if (key === '$patch') continue;
        if (value === null) delete target[key];
        else if (isObj(value)) apply(child(target, key), value);
        else target[key] = clone(value);
      }
    };
    const next = clone(object);
    apply(next, status ? { status: patch.status } : without(patch, ['status']));
    return next;
  }

  private jsonPatch(object: KubeObject, patch: unknown): KubeObject {
    if (!Array.isArray(patch)) throw new Error('a json patch must be an array of operations');
    const next = clone(object) as Obj;
    for (const raw of patch) {
      const op = obj(raw);
      const parts = String(op.path ?? '')
        .split('/')
        .slice(1)
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      const leaf = parts.pop();
      if (leaf === undefined) throw new Error('empty json patch path');
      let parent: unknown = next;
      for (const part of parts) parent = Array.isArray(parent) ? parent[Number(part)] : obj(parent)[part];
      if (Array.isArray(parent)) {
        const index = leaf === '-' ? parent.length : Number(leaf);
        if (op.op === 'remove') parent.splice(index, 1);
        else if (op.op === 'add') parent.splice(index, 0, clone(op.value));
        else if (op.op === 'replace') parent[index] = clone(op.value);
        else throw new Error(`json patch op ${String(op.op)} is not supported`);
      } else if (isObj(parent)) {
        if (op.op === 'remove') {
          if (!Object.hasOwn(parent, leaf)) throw new Error(`the path ${String(op.path)} does not exist`);
          delete parent[leaf];
        } else if (op.op === 'add' || op.op === 'replace') parent[leaf] = clone(op.value);
        else throw new Error(`json patch op ${String(op.op)} is not supported`);
      } else throw new Error(`the path ${String(op.path)} does not exist`);
    }
    return next as KubeObject;
  }

  private labelVerb(argv: Argv, namespace: string | undefined): KubectlResult {
    const annotate = argv.verb === 'annotate';
    const overwrite = hasFlag(argv, '--overwrite');
    // object names never end with `-`, so a trailing `-` is always a key removal (`prefix/key-` included)
    const ops = argv.positionals.filter((positional, index) => index > 0 && (positional.includes('=') || positional.endsWith('-')));
    const objects = argv.positionals.filter((positional) => !ops.includes(positional));
    const out: string[] = [];
    const errors: string[] = [];
    const { targets, selected } = this.targets(argv, namespace, '', objects);
    for (const entry of this.existing(targets, errors).concat(selected)) {
      const name = entry.object.metadata.name;
      const rejected = this.rejection(argv.verb, entry.info, name, entry.object.metadata.namespace);
      if (rejected !== null) {
        errors.push(rejected);
        continue;
      }
      const next = clone(entry.object);
      const map: Record<string, string> = { ...(annotate ? next.metadata.annotations : next.metadata.labels) };
      let error: string | null = null;
      for (const op of ops) {
        if (!op.includes('=') && op.endsWith('-')) {
          delete map[op.slice(0, -1)];
          continue;
        }
        const eq = op.indexOf('=');
        const key = op.slice(0, eq);
        const value = op.slice(eq + 1);
        if (!overwrite && map[key] !== undefined && map[key] !== value) {
          error = `error: '${key}' already has a value (${map[key]}), and --overwrite is false`;
          break;
        }
        map[key] = value;
      }
      if (error !== null) {
        errors.push(error);
        continue;
      }
      if (annotate) next.metadata.annotations = map;
      else next.metadata.labels = map;
      if (Object.keys(map).length === 0) delete next.metadata[annotate ? 'annotations' : 'labels'];
      const changed = this.write(entry, next, annotate ? 'kubectl-annotate' : 'kubectl-label', 'Update');
      out.push(`${objectRef(entry.info, name)} ${changed ? (annotate ? 'annotated' : 'labeled') : 'not labeled'}`);
    }
    return done(out, errors);
  }

  private async nodeVerb(argv: Argv): Promise<KubectlResult> {
    const out: string[] = [];
    const errors: string[] = [];
    const nodeInfo = infoOf('Node');
    const names = argv.positionals.map((positional) => positional.replace(/^(nodes?|no)\//, ''));
    for (const name of names) {
      const node = this.find(nodeInfo, undefined, name);
      if (!node) {
        errors.push(notFoundText(nodeInfo, name));
        continue;
      }
      const next = clone(node.object);
      if (argv.verb === 'uncordon') delete child(next, 'spec').unschedulable;
      else child(next, 'spec').unschedulable = true;
      const changed = this.write(node, next, 'kubectl-cordon', 'Update');
      out.push(`node/${name} ${argv.verb === 'uncordon' ? 'uncordoned' : changed ? 'cordoned' : 'already cordoned'}`);
      if (argv.verb !== 'drain') continue;
      const pods = this.entriesOf('Pod').filter((pod) => obj(pod.object.spec).nodeName === name && !isDeleting(pod));
      const daemon = pods.filter((pod) => (pod.object.metadata.ownerReferences ?? []).some((ref) => ref.kind === 'DaemonSet'));
      if (daemon.length > 0 && !hasFlag(argv, '--ignore-daemonsets')) {
        errors.push(`error: unable to drain node "${name}" due to error: cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore)`);
        continue;
      }
      const evicted = pods.filter((pod) => !daemon.includes(pod));
      for (const pod of evicted) {
        out.push(`evicting pod ${pod.object.metadata.namespace}/${pod.object.metadata.name}`);
        this.deleteEntry(pod);
      }
      const gone = (): boolean => evicted.every((pod) => !this.byUid.has(pod.object.metadata.uid ?? ''));
      if (!(await this.waitFor(gone, parseDuration(flag(argv, '--timeout'))))) {
        errors.push(`error: unable to drain node "${name}" due to error: global timeout reached`);
        continue;
      }
      out.push(`node/${name} drained`);
    }
    return done(out, errors);
  }

  private async waitVerb(argv: Argv, namespace: string | undefined): Promise<KubectlResult> {
    const condition = flag(argv, '--for') ?? '';
    const timeoutS = parseDuration(flag(argv, '--timeout') ?? '30s');
    const errors: string[] = [];
    const { targets, selected } = this.targets(argv, namespace);
    const entries = targets.flatMap((target) => this.find(target.info, target.namespace, target.name) ?? []).concat(selected);
    if (condition === 'delete') {
      const gone = (): boolean => entries.every((entry) => !this.byUid.has(entry.object.metadata.uid ?? ''));
      if (!(await this.waitFor(gone, timeoutS))) {
        const left = entries.find((entry) => this.byUid.has(entry.object.metadata.uid ?? ''));
        return done([], [`error: timed out waiting for the condition on ${left ? `${resourceLabel(left.info)}/${left.object.metadata.name}` : 'resources'}`]);
      }
      return done(entries.map((entry) => `${objectRef(entry.info, entry.object.metadata.name)} condition met`), errors);
    }
    const match = /^condition=([^=]+)(?:=(.*))?$/.exec(condition);
    if (!match) return this.problem(`kubectl wait --for=${condition} is not served by FakeCluster`);
    if (entries.length === 0) {
      const missing = targets.map((target) => notFoundText(target.info, target.name));
      return done([], missing.length > 0 ? missing : ['error: no matching resources found']);
    }
    const wanted = (match[2] ?? 'True').toLowerCase();
    const current = (): Entry[] => entries.map((entry) => this.byUid.get(entry.object.metadata.uid ?? '') ?? entry);
    const met = (): boolean => current().every((entry) => (strOf(conditionOf(entry.object, match[1])?.status) ?? '').toLowerCase() === wanted);
    if (!(await this.waitFor(met, timeoutS))) {
      const left = current().find((entry) => (strOf(conditionOf(entry.object, match[1])?.status) ?? '').toLowerCase() !== wanted);
      return done([], [`error: timed out waiting for the condition on ${left ? `${resourceLabel(left.info)}/${left.object.metadata.name}` : 'resources'}`]);
    }
    return done(entries.map((entry) => `${objectRef(entry.info, entry.object.metadata.name)} condition met`), errors);
  }

  // ---- exec / logs ------------------------------------------------------------------------------

  /** a pod by name, or the first running pod of `<workload>/<name>` */
  private podTarget(ref: string, namespace: string): Entry {
    const podInfo = infoOf('Pod');
    const slash = ref.indexOf('/');
    if (slash === -1 || resourceInfo(ref.slice(0, slash))?.kind === 'Pod') {
      const name = slash === -1 ? ref : ref.slice(slash + 1);
      const pod = this.find(podInfo, namespace, name);
      if (!pod) refuse(notFoundText(podInfo, name));
      return pod;
    }
    const info = this.resolveServed(ref.slice(0, slash));
    const name = ref.slice(slash + 1);
    const owner = this.find(info, namespace, name);
    if (!owner) refuse(notFoundText(info, name));
    const selector = obj(obj(owner.object.spec).selector);
    const pods = this.select(podInfo, namespace).filter((pod) => labelSelectorMatches(labelsOf(pod.object), selector) && !isDeleting(pod));
    const pod = pods.find((candidate) => podPhase(candidate) === 'Running') ?? pods[0];
    if (!pod) refuse(`error: no pods found for ${objectRef(info, name)}`);
    return pod;
  }

  private containerOf(pod: Entry, requested: string | undefined): string {
    const names = [...containersOf(pod.object), ...containersOf(pod.object, 'initContainers')].map((container) => strOf(container.name) ?? '');
    if (requested !== undefined) {
      if (!names.includes(requested)) refuse(`error: container ${requested} is not valid for pod ${pod.object.metadata.name}`);
      return requested;
    }
    return pod.object.metadata.annotations?.[ANNOTATIONS.defaultContainer] ?? names[0] ?? '';
  }

  private matchesPod(matcher: PodMatcher, pod: Entry, container: string): boolean {
    const name = pod.object.metadata.name;
    if (typeof matcher === 'string') {
      if (/[=!]|\sin\s*\(/.test(matcher)) return selectorMatches(labelsOf(pod.object), parseLabelSelector(matcher));
      return matcher === name;
    }
    if (matcher instanceof RegExp) return matcher.test(name);
    if (matcher.namespace !== undefined && matcher.namespace !== pod.object.metadata.namespace) return false;
    if (matcher.name !== undefined && !(matcher.name instanceof RegExp ? matcher.name.test(name) : matcher.name === name)) return false;
    if (matcher.selector !== undefined && !selectorMatches(labelsOf(pod.object), parseLabelSelector(matcher.selector))) return false;
    return matcher.container === undefined || matcher.container === container;
  }

  private async execVerb(argv: Argv, namespace: string | undefined, stdin: string, interactive: boolean): Promise<KubectlResult> {
    const ref = argv.positionals[0];
    if (ref === undefined) refuse('error: pod, type/name or --filename must be specified');
    const pod = this.podTarget(ref, namespace ?? 'default');
    const container = this.containerOf(pod, flag(argv, '-c', '--container'));
    const rejected = this.rejection('exec', pod.info, pod.object.metadata.name, pod.object.metadata.namespace);
    if (rejected !== null) refuse(rejected);
    const phase = podPhase(pod);
    if (phase === 'Succeeded' || phase === 'Failed') refuse(`error: cannot exec into a container in a completed pod; current phase is ${phase}`);
    const status = objList(obj(pod.object.status).containerStatuses).find((candidate) => candidate.name === container);
    if (phase !== 'Running' || !isObj(obj(status?.state).running)) refuse(`error: unable to upgrade connection: container not found ("${container}")`);
    const handler = [...this.execHandlers].reverse().find((candidate) => this.matchesPod(candidate.matcher, pod, container));
    if (!handler) {
      return this.problem(`no exec handler for pod ${pod.object.metadata.name} container ${container}: ${argv.command.join(' ')}; register one with cluster.onExec()`);
    }
    const result = await handler.handler({
      namespace: pod.object.metadata.namespace ?? 'default',
      pod: pod.object.metadata.name,
      container,
      argv: [...argv.command],
      stdin,
      interactive: interactive || hasFlag(argv, '-i', '--stdin'),
      tty: hasFlag(argv, '-t', '--tty'),
    });
    return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  private logKey(namespace: string, pod: string, container: string, previous: boolean): string {
    return `${namespace}|${pod}|${container}|${previous ? 'previous' : 'current'}`;
  }

  private logsVerb(argv: Argv, namespace: string | undefined): KubectlResult {
    const ns = namespace ?? 'default';
    const selector = flag(argv, '-l', '--selector');
    const follow = hasFlag(argv, '-f', '--follow');
    const previous = hasFlag(argv, '-p', '--previous');
    const timestamps = hasFlag(argv, '--timestamps');
    const allContainers = hasFlag(argv, '--all-containers');
    const tailFlag = flag(argv, '--tail');
    const tail = tailFlag !== undefined && Number(tailFlag) >= 0 ? Number(tailFlag) : selector !== undefined ? 10 : -1;
    const sinceS = parseDuration(flag(argv, '--since'));
    const sinceTime = flag(argv, '--since-time');
    const requested = flag(argv, '-c', '--container');
    let pods: Entry[];
    if (selector !== undefined) pods = this.select(infoOf('Pod'), ns, selector);
    else {
      const ref = argv.positionals[0];
      if (ref === undefined) refuse('error: expected POD or TYPE/NAME is a required argument for the logs command');
      pods = [this.podTarget(ref, ns)];
    }
    const prefix = hasFlag(argv, '--prefix');
    const streams = pods.flatMap((pod) => {
      const names = allContainers ? containersOf(pod.object).map((container) => strOf(container.name) ?? '') : [this.containerOf(pod, requested)];
      return names.map((container) => ({ pod, container }));
    });
    const maxRequests = Number(flag(argv, '--max-log-requests') ?? '5');
    if (follow && streams.length > maxRequests) {
      refuse(`error: you are attempting to follow ${streams.length} log streams, but maximum allowed concurrency is ${maxRequests}, use --max-log-requests to increase the limit`);
    }
    const rejected = pods.length > 0 ? this.rejection('logs', infoOf('Pod'), pods[0].object.metadata.name, ns) : null;
    if (rejected !== null) refuse(rejected);
    let stdout = '';
    const errors: string[] = [];
    const floorMs = sinceTime !== undefined ? Date.parse(sinceTime) : sinceS !== null ? this.nowMs() - sinceS * 1000 : Number.NEGATIVE_INFINITY;
    for (const { pod, container } of streams) {
      const podName = pod.object.metadata.name;
      const status = objList(obj(pod.object.status).containerStatuses).find((candidate) => candidate.name === container);
      const waiting = obj(obj(status?.state).waiting);
      if (previous && numOf(status?.restartCount) === 0 && !this.logs.has(this.logKey(ns, podName, container, true)) && !this.logs.has(this.logKey('*', podName, container, true))) {
        errors.push(`Error from server (BadRequest): previous terminated container "${container}" in pod "${podName}" not found`);
        continue;
      }
      if (!previous && status === undefined) {
        errors.push(`Error from server (BadRequest): container "${container}" in pod "${podName}" is waiting to start: ContainerCreating`);
        continue;
      }
      if (!previous && strOf(waiting.reason) !== undefined && strOf(waiting.reason) !== 'CrashLoopBackOff') {
        errors.push(`Error from server (BadRequest): container "${container}" in pod "${podName}" is waiting to start: ${strOf(waiting.message) ?? strOf(waiting.reason)}`);
        continue;
      }
      let lines = [...(this.logs.get(this.logKey(ns, podName, container, previous)) ?? []), ...(this.logs.get(this.logKey('*', podName, container, previous)) ?? [])]
        .sort((a, b) => a.timeMs - b.timeMs)
        .filter((record) => record.timeMs >= floorMs);
      if (tail >= 0) lines = lines.slice(Math.max(0, lines.length - tail));
      for (const record of lines) {
        stdout += `${prefix ? `[pod/${podName}/${container}] ` : ''}${timestamps ? `${rfc3339Nano(record.timeMs)} ` : ''}${record.text}\n`;
      }
    }
    return { exitCode: errors.length > 0 && stdout === '' ? 1 : 0, stdout, stderr: errors.map(line).join('') };
  }

  // ---- events -----------------------------------------------------------------------------------

  private emitEvent(involved: KubeObject, type: 'Normal' | 'Warning', reason: string, message: string, component: string): void {
    const namespace = involved.metadata.namespace ?? 'default';
    const existing = this.entriesOf('Event').find((event) => {
      const ref = obj(event.object.involvedObject);
      return ref.uid === involved.metadata.uid && event.object.reason === reason && event.object.message === message;
    });
    const time = this.nowIso();
    if (existing) {
      this.mutate(existing, (event) => {
        event.count = (numOf(event.count) ?? 1) + 1;
        event.lastTimestamp = time;
      });
      return;
    }
    this.eventCounter += 1;
    this.insertSystem(
      {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: { name: `${involved.metadata.name}.${sha256Hex(`event/${this.eventCounter}`).slice(0, 16)}`, namespace },
        count: 1,
        eventTime: null,
        firstTimestamp: time,
        involvedObject: {
          apiVersion: involved.apiVersion,
          kind: involved.kind,
          name: involved.metadata.name,
          ...(involved.metadata.namespace !== undefined ? { namespace: involved.metadata.namespace } : {}),
          resourceVersion: involved.metadata.resourceVersion,
          uid: involved.metadata.uid,
        },
        lastTimestamp: time,
        message,
        reason,
        reportingComponent: component,
        reportingInstance: '',
        source: { component },
        type,
      },
      component,
    );
  }

  /** a pod event emitted once per key (a state transition, not a poll) */
  private emitOnce(pod: Entry, key: string, type: 'Normal' | 'Warning', reason: string, message: string, component = 'kubelet'): void {
    const emitted = pod.state.emitted ?? new Set<string>();
    pod.state.emitted = emitted;
    if (emitted.has(key)) return;
    emitted.add(key);
    this.emitEvent(pod.object, type, reason, message, component);
  }

  // ---- controllers ------------------------------------------------------------------------------

  private runTick(): void {
    this.ticks += 1;
    this.tickTimeMs = this.startMs + this.ticks * this.tickMs;
    try {
      for (const pod of this.entriesOf('Pod')) {
        if (isDeleting(pod) && pod.state.terminateAtTick !== undefined && pod.state.terminateAtTick <= this.ticks) this.settle(pod);
      }
      this.settleAll();
      this.collectGarbage();
      this.reclaimVolumes();
      for (const entry of this.entriesOf('Deployment')) this.syncDeployment(entry);
      for (const entry of this.entriesOf('StatefulSet')) this.syncStatefulSet(entry);
      for (const entry of this.entriesOf('DaemonSet')) this.syncDaemonSet(entry);
      for (const entry of this.entriesOf('Job')) this.syncJob(entry);
      for (const entry of this.entriesOf('ReplicaSet')) this.syncReplicaSet(entry);
      this.schedulePods();
      this.bindClaims();
      this.runKubelet();
      for (const entry of this.entriesOf('ReplicaSet')) this.replicaSetStatus(entry);
      for (const entry of this.entriesOf('Deployment')) this.deploymentStatus(entry);
      for (const entry of this.entriesOf('StatefulSet')) this.statefulSetStatus(entry);
      for (const entry of this.entriesOf('DaemonSet')) this.daemonSetStatus(entry);
      for (const entry of this.entriesOf('Job')) this.jobStatus(entry);
      this.assignLoadBalancers();
      this.syncEndpointSlices();
      this.settleAll();
    } finally {
      this.tickTimeMs = null;
    }
  }

  private settleAll(): void {
    for (let round = 0; round < 5; round++) {
      const before = this.entries.size;
      for (const entry of [...this.entries.values()]) if (isDeleting(entry)) this.settle(entry);
      if (this.entries.size === before) break;
    }
  }

  /** dependents whose every owner is gone are deleted in the background */
  private collectGarbage(): void {
    for (const entry of [...this.entries.values()]) {
      const refs = entry.object.metadata.ownerReferences ?? [];
      if (refs.length === 0 || entry.state.frozen || isDeleting(entry)) continue;
      if (refs.every((ref) => !this.byUid.has(ref.uid))) this.deleteEntry(entry);
    }
  }

  /** the spec the controller works from: the stored one once the lag has passed */
  private observe(entry: Entry): Obj | undefined {
    if (entry.state.frozen) return undefined;
    const generation = entry.object.metadata.generation ?? 1;
    if (entry.state.observedGeneration !== generation && this.ticks >= (entry.state.syncAfterTick ?? 0)) {
      entry.state.observedGeneration = generation;
      entry.state.observedSpec = clone(obj(entry.object.spec));
      entry.state.progressAtMs = this.nowMs();
      entry.state.deadlineExceeded = false;
      if (entry.info.kind !== 'Job') this.mutate(entry, (object) => void (child(object, 'status').observedGeneration = generation));
    }
    return entry.state.observedSpec;
  }

  private createPod(owner: Entry, template: Obj, name: string, extraLabels: Record<string, string>, tune?: (spec: Obj) => void): Entry {
    const templateMeta = obj(template.metadata);
    const annotations = strMap(templateMeta.annotations);
    const spec = clone(obj(template.spec));
    tune?.(spec);
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: owner.object.metadata.namespace,
        labels: { ...strMap(templateMeta.labels), ...extraLabels },
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        ownerReferences: [ownerRefOf(owner.object)],
      },
      spec,
      status: { phase: 'Pending' },
    };
    const podStatus = obj(pod.status);
    podStatus.qosClass = this.qosClass(pod);
    return this.insertSystem(pod);
  }

  // Deployment -> ReplicaSet

  private syncDeployment(entry: Entry): void {
    if (isDeleting(entry)) return;
    const spec = this.observe(entry);
    if (spec === undefined || spec.paused === true) return;
    const deployment = entry.object;
    const template = obj(spec.template);
    const hash = safeHash(canonicalJson(template), 10);
    const owned = this.ownedBy(entry, 'ReplicaSet');
    const maxRevision = owned.reduce((max, rs) => Math.max(max, revisionOf(rs)), 0);
    const desired = numOf(spec.replicas) ?? 1;
    const strategy = obj(spec.strategy);
    const type = strOf(strategy.type) ?? 'RollingUpdate';
    const surge = type === 'RollingUpdate' ? intOrPercent(obj(strategy.rollingUpdate).maxSurge, desired, '25%', true) : 0;
    let current = owned.find((rs) => labelsOf(rs.object)[KUBE_KEYS.podTemplateHash] === hash);
    if (!current) {
      const templateMeta = obj(template.metadata);
      const labels = { ...strMap(templateMeta.labels), [KUBE_KEYS.podTemplateHash]: hash };
      current = this.insertSystem({
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: {
          name: `${deployment.metadata.name}-${hash}`,
          namespace: deployment.metadata.namespace,
          labels,
          annotations: {
            'deployment.kubernetes.io/desired-replicas': String(desired),
            'deployment.kubernetes.io/max-replicas': String(desired + surge),
            [KUBE_KEYS.deploymentRevision]: String(maxRevision + 1),
          },
          ownerReferences: [ownerRefOf(deployment)],
        },
        spec: {
          replicas: 0,
          selector: { matchLabels: { ...strMap(obj(obj(spec.selector).matchLabels)), [KUBE_KEYS.podTemplateHash]: hash } },
          template: { metadata: { ...clone(templateMeta), labels }, spec: clone(obj(template.spec)) },
        },
        status: { replicas: 0 },
      });
    } else if (entry.state.syncedHash !== hash && revisionOf(current) < maxRevision) {
      this.mutate(current, (rs) => {
        rs.metadata.annotations = { ...rs.metadata.annotations, [KUBE_KEYS.deploymentRevision]: String(maxRevision + 1) };
      });
    }
    entry.state.syncedHash = hash;
    const revision = String(revisionOf(current));
    if (deployment.metadata.annotations?.[KUBE_KEYS.deploymentRevision] !== revision) {
      this.mutate(entry, (object) => {
        object.metadata.annotations = { ...object.metadata.annotations, [KUBE_KEYS.deploymentRevision]: revision };
      });
    }
    const newSet = current;
    const olds = owned.filter((rs) => rs !== newSet);
    const minReady = numOf(spec.minReadySeconds) ?? 0;
    if (type === 'Recreate' || surge === 0) {
      for (const old of olds) this.scaleReplicaSet(entry, old, 0);
      const oldPods = olds.flatMap((old) => this.ownedBy(old, 'Pod'));
      if (oldPods.length === 0) this.scaleReplicaSet(entry, newSet, desired);
    } else {
      this.scaleReplicaSet(entry, newSet, desired);
      const available = this.ownedBy(newSet, 'Pod').filter((pod) => isActivePod(pod) && this.isAvailable(pod, minReady)).length;
      if (available >= desired) for (const old of olds) this.scaleReplicaSet(entry, old, 0);
    }
    const limit = numOf(spec.revisionHistoryLimit) ?? 10;
    const retired = olds
      .filter((rs) => (numOf(obj(rs.object.spec).replicas) ?? 0) === 0 && this.ownedBy(rs, 'Pod').length === 0)
      .sort((a, b) => revisionOf(b) - revisionOf(a));
    for (const rs of retired.slice(limit)) this.removeEntry(rs);
  }

  private scaleReplicaSet(deployment: Entry, rs: Entry, replicas: number): void {
    const from = numOf(obj(rs.object.spec).replicas) ?? 0;
    if (from === replicas) return;
    this.mutate(rs, (object) => {
      child(object, 'spec').replicas = replicas;
    });
    this.emitEvent(
      deployment.object,
      'Normal',
      'ScalingReplicaSet',
      `Scaled ${replicas > from ? 'up' : 'down'} replica set ${rs.object.metadata.name} from ${from} to ${replicas}`,
      'deployment-controller',
    );
  }

  private isAvailable(pod: Entry, minReadySeconds: number): boolean {
    const since = pod.state.readySinceMs;
    return isPodReady(pod) && since !== undefined && since !== null && since + minReadySeconds * 1000 <= this.nowMs();
  }

  private syncReplicaSet(entry: Entry): void {
    if (entry.state.frozen || isDeleting(entry)) return;
    const spec = obj(entry.object.spec);
    const desired = numOf(spec.replicas) ?? 1;
    const active = this.ownedBy(entry, 'Pod').filter(isActivePod);
    const name = entry.object.metadata.name;
    for (let i = active.length; i < desired; i++) {
      const pod = this.createPod(entry, obj(spec.template), `${name}-${this.nextSuffix(name)}`, {});
      this.emitEvent(entry.object, 'Normal', 'SuccessfulCreate', `Created pod: ${pod.object.metadata.name}`, 'replicaset-controller');
    }
    if (active.length > desired) {
      const rank = (pod: Entry): number => (obj(pod.object.spec).nodeName === undefined ? 0 : !isPodReady(pod) ? 1 : 2);
      const victims = [...active].sort((a, b) => rank(a) - rank(b) || b.state.createdTick - a.state.createdTick).slice(0, active.length - desired);
      for (const pod of victims) {
        this.deleteEntry(pod);
        this.emitEvent(entry.object, 'Normal', 'SuccessfulDelete', `Deleted pod: ${pod.object.metadata.name}`, 'replicaset-controller');
      }
    }
  }

  private replicaSetStatus(entry: Entry): void {
    if (entry.state.frozen) return;
    const active = this.ownedBy(entry, 'Pod').filter(isActivePod);
    const minReady = numOf(obj(entry.object.spec).minReadySeconds) ?? 0;
    this.mutate(entry, (object) => {
      const status = child(object, 'status');
      status.replicas = active.length;
      putCount(status, 'fullyLabeledReplicas', active.length);
      putCount(status, 'readyReplicas', active.filter(isPodReady).length);
      putCount(status, 'availableReplicas', active.filter((pod) => this.isAvailable(pod, minReady)).length);
      status.observedGeneration = object.metadata.generation ?? 1;
    });
  }

  private deploymentStatus(entry: Entry): void {
    const spec = entry.state.observedSpec;
    if (spec === undefined) return;
    const desired = numOf(spec.replicas) ?? 1;
    const minReady = numOf(spec.minReadySeconds) ?? 0;
    const owned = this.ownedBy(entry, 'ReplicaSet');
    const newSet = owned.find((rs) => labelsOf(rs.object)[KUBE_KEYS.podTemplateHash] === entry.state.syncedHash);
    const pods = owned.flatMap((rs) => this.ownedBy(rs, 'Pod')).filter(isActivePod);
    const updated = newSet ? this.ownedBy(newSet, 'Pod').filter(isActivePod).length : 0;
    const ready = pods.filter(isPodReady).length;
    const available = pods.filter((pod) => this.isAvailable(pod, minReady)).length;
    const paused = spec.paused === true;
    const complete = !paused && newSet !== undefined && updated === desired && pods.length === desired && available === desired;
    const key = `${updated}/${ready}/${available}/${pods.length}`;
    if (entry.state.progressKey !== key) {
      entry.state.progressKey = key;
      entry.state.progressAtMs = this.nowMs();
    }
    const deadline = numOf(spec.progressDeadlineSeconds) ?? 600;
    if (complete) entry.state.deadlineExceeded = false;
    else if (!paused && this.nowMs() - (entry.state.progressAtMs ?? this.nowMs()) > deadline * 1000) entry.state.deadlineExceeded = true;
    const strategy = obj(spec.strategy);
    const maxUnavailable = strOf(strategy.type) === 'Recreate' ? 0 : intOrPercent(obj(strategy.rollingUpdate).maxUnavailable, desired, '25%', false);
    const time = this.nowIso();
    const rsName = newSet?.object.metadata.name ?? '';
    this.mutate(entry, (object) => {
      const status = child(object, 'status');
      status.observedGeneration = entry.state.observedGeneration;
      putCount(status, 'replicas', pods.length);
      putCount(status, 'updatedReplicas', updated);
      putCount(status, 'readyReplicas', ready);
      putCount(status, 'availableReplicas', available);
      putCount(status, 'unavailableReplicas', Math.max(0, desired - available));
      if (available >= desired - maxUnavailable) setCondition(status, 'Available', 'True', 'MinimumReplicasAvailable', 'Deployment has minimum availability.', time, true);
      else setCondition(status, 'Available', 'False', 'MinimumReplicasUnavailable', 'Deployment does not have minimum availability.', time, true);
      if (paused) setCondition(status, 'Progressing', 'Unknown', 'DeploymentPaused', 'Deployment is paused', time, true);
      else if (complete) setCondition(status, 'Progressing', 'True', 'NewReplicaSetAvailable', `ReplicaSet "${rsName}" has successfully progressed.`, time, true);
      else if (entry.state.deadlineExceeded) setCondition(status, 'Progressing', 'False', 'ProgressDeadlineExceeded', `ReplicaSet "${rsName}" has timed out progressing.`, time, true);
      else setCondition(status, 'Progressing', 'True', 'ReplicaSetUpdated', `ReplicaSet "${rsName}" is progressing.`, time, true);
    });
  }

  // ControllerRevisions (StatefulSet, DaemonSet)

  /** the revision of the observed template: created, or renumbered when an older one comes back */
  private ensureRevision(entry: Entry, template: Obj, hash: string, hashLabel: string): Entry {
    const name = `${entry.object.metadata.name}-${hash}`;
    const owned = this.ownedBy(entry, 'ControllerRevision');
    const maxRevision = owned.reduce((max, revision) => Math.max(max, numOf(revision.object.revision) ?? 0), 0);
    const found = owned.find((revision) => revision.object.metadata.name === name);
    if (found) {
      if (entry.state.syncedHash !== hash && (numOf(found.object.revision) ?? 0) < maxRevision) {
        this.mutate(found, (revision) => {
          revision.revision = maxRevision + 1;
        });
      }
      return found;
    }
    return this.insertSystem({
      apiVersion: 'apps/v1',
      kind: 'ControllerRevision',
      metadata: {
        name,
        namespace: entry.object.metadata.namespace,
        labels: { ...strMap(obj(template.metadata).labels), [hashLabel]: hash },
        ownerReferences: [ownerRefOf(entry.object)],
      },
      data: { spec: { template: { $patch: 'replace', ...clone(template) } } },
      revision: maxRevision + 1,
    });
  }

  // StatefulSet

  private syncStatefulSet(entry: Entry): void {
    if (isDeleting(entry)) return;
    const spec = this.observe(entry);
    if (spec === undefined) return;
    const set = entry.object;
    const name = set.metadata.name;
    const template = obj(spec.template);
    const hash = safeHash(canonicalJson(template), 10);
    const revisionName = this.ensureRevision(entry, template, hash, STS_HASH_LABEL).object.metadata.name;
    entry.state.syncedHash = hash;
    this.mutate(entry, (object) => {
      const status = child(object, 'status');
      status.updateRevision = revisionName;
      if (status.currentRevision === undefined) status.currentRevision = revisionName;
    });
    const replicas = numOf(spec.replicas) ?? 1;
    const parallel = spec.podManagementPolicy === 'Parallel';
    const claimTemplates = objList(spec.volumeClaimTemplates);
    const pods = this.ownedBy(entry, 'Pod');
    const byOrdinal = new Map<number, Entry>();
    for (const pod of pods) byOrdinal.set(Number(pod.object.metadata.name.slice(name.length + 1)), pod);
    for (const [ordinal, pod] of byOrdinal) {
      if (podPhase(pod) === 'Failed' && !isDeleting(pod)) {
        this.deleteEntry(pod, { graceSeconds: 0 });
        byOrdinal.delete(ordinal);
      }
    }
    const healthy = (ordinal: number): boolean => {
      const pod = byOrdinal.get(ordinal);
      return pod !== undefined && !isDeleting(pod) && podPhase(pod) === 'Running' && isPodReady(pod);
    };
    for (let ordinal = 0; ordinal < replicas; ordinal++) {
      if (byOrdinal.has(ordinal)) {
        if (!parallel && !healthy(ordinal)) break;
        continue;
      }
      const podName = `${name}-${ordinal}`;
      for (const claimTemplate of claimTemplates) this.ensureClaim(entry, spec, claimTemplate, podName);
      const pod = this.createPod(
        entry,
        template,
        podName,
        {
          [KUBE_KEYS.controllerRevisionHash]: revisionName,
          'statefulset.kubernetes.io/pod-name': podName,
          'apps.kubernetes.io/pod-index': String(ordinal),
        },
        (podSpec) => {
          const volumes = objList(podSpec.volumes);
          for (const claimTemplate of claimTemplates) {
            const claimName = strOf(obj(claimTemplate.metadata).name) ?? '';
            if (volumes.some((volume) => volume.name === claimName)) continue;
            volumes.push({ name: claimName, persistentVolumeClaim: { claimName: `${claimName}-${podName}` } });
          }
          if (volumes.length > 0) podSpec.volumes = volumes;
          podSpec.hostname = podName;
          if (spec.serviceName !== undefined) podSpec.subdomain = spec.serviceName;
        },
      );
      byOrdinal.set(ordinal, pod);
      this.emitEvent(set, 'Normal', 'SuccessfulCreate', `create Pod ${podName} in StatefulSet ${name} successful`, 'statefulset-controller');
      if (!parallel) break;
    }
    const allHealthy = [...Array(replicas).keys()].every(healthy);
    for (const [ordinal, pod] of [...byOrdinal].sort((a, b) => b[0] - a[0])) {
      if (ordinal < replicas || isDeleting(pod)) continue;
      if (!parallel && !allHealthy) break;
      this.deleteEntry(pod);
      if (!parallel) break;
    }
    const updateType = strOf(obj(spec.updateStrategy).type) ?? 'RollingUpdate';
    if (updateType === 'RollingUpdate' && allHealthy) {
      // no automatic replacement of broken pods: a rollout only moves while every pod is ready
      const stale = [...byOrdinal]
        .filter(([ordinal, pod]) => ordinal < replicas && labelsOf(pod.object)[KUBE_KEYS.controllerRevisionHash] !== revisionName)
        .sort((a, b) => b[0] - a[0]);
      if (stale.length > 0) this.deleteEntry(stale[0][1]);
    }
  }

  private ensureClaim(set: Entry, spec: Obj, claimTemplate: Obj, podName: string): void {
    const templateMeta = obj(claimTemplate.metadata);
    const claimName = `${strOf(templateMeta.name) ?? ''}-${podName}`;
    const namespace = set.object.metadata.namespace;
    if (this.find(infoOf('PersistentVolumeClaim'), namespace, claimName)) return;
    const claim: KubeObject = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: claimName,
        namespace,
        labels: { ...strMap(templateMeta.labels), ...strMap(obj(obj(spec.selector).matchLabels)) },
        ...(Object.keys(strMap(templateMeta.annotations)).length > 0 ? { annotations: strMap(templateMeta.annotations) } : {}),
      },
      spec: clone(obj(claimTemplate.spec)),
    };
    this.prepareCreate(infoOf('PersistentVolumeClaim'), claim);
    this.insertSystem(claim);
    this.emitEvent(set.object, 'Normal', 'SuccessfulCreate', `create Claim ${claimName} Pod ${podName} in StatefulSet ${set.object.metadata.name} success`, 'statefulset-controller');
  }

  private statefulSetStatus(entry: Entry): void {
    const spec = entry.state.observedSpec;
    if (spec === undefined) return;
    const replicas = numOf(spec.replicas) ?? 1;
    const minReady = numOf(spec.minReadySeconds) ?? 0;
    const pods = this.ownedBy(entry, 'Pod').filter((pod) => !isDeleting(pod));
    const status = obj(entry.object.status);
    const updateRevision = strOf(status.updateRevision) ?? '';
    const updated = pods.filter((pod) => labelsOf(pod.object)[KUBE_KEYS.controllerRevisionHash] === updateRevision);
    const ready = pods.filter(isPodReady);
    let currentRevision = strOf(status.currentRevision) ?? updateRevision;
    if (updated.length === replicas && pods.length === replicas && updated.every(isPodReady)) currentRevision = updateRevision;
    const current = pods.filter((pod) => labelsOf(pod.object)[KUBE_KEYS.controllerRevisionHash] === currentRevision);
    this.mutate(entry, (object) => {
      const next = child(object, 'status');
      next.observedGeneration = entry.state.observedGeneration;
      next.replicas = pods.length;
      putCount(next, 'readyReplicas', ready.length);
      putCount(next, 'currentReplicas', current.length);
      putCount(next, 'updatedReplicas', updated.length);
      putCount(next, 'availableReplicas', pods.filter((pod) => this.isAvailable(pod, minReady)).length);
      next.currentRevision = currentRevision;
      next.updateRevision = updateRevision;
      next.collisionCount = 0;
    });
  }

  // DaemonSet

  private syncDaemonSet(entry: Entry): void {
    if (isDeleting(entry)) return;
    const spec = this.observe(entry);
    if (spec === undefined) return;
    const set = entry.object;
    const template = obj(spec.template);
    const hash = safeHash(canonicalJson(template), 10);
    this.ensureRevision(entry, template, hash, KUBE_KEYS.controllerRevisionHash);
    entry.state.syncedHash = hash;
    const eligible = this.daemonNodes(template);
    const pods = this.ownedBy(entry, 'Pod').filter((pod) => !isDeleting(pod));
    for (const pod of pods) {
      if (!eligible.includes(strOf(obj(pod.object.spec).nodeName) ?? '')) this.deleteEntry(pod);
    }
    for (const node of eligible) {
      if (pods.some((pod) => obj(pod.object.spec).nodeName === node)) continue;
      const name = `${set.metadata.name}-${this.nextSuffix(set.metadata.name)}`;
      this.createPod(entry, template, name, { [KUBE_KEYS.controllerRevisionHash]: hash, 'pod-template-generation': String(entry.state.observedGeneration ?? 1) }, (podSpec) => {
        podSpec.nodeName = node;
        podSpec.affinity = {
          ...obj(podSpec.affinity),
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [node] }] }] },
          },
        };
      });
      this.emitEvent(set, 'Normal', 'SuccessfulCreate', `Created pod: ${name}`, 'daemonset-controller');
    }
    const updateType = strOf(obj(spec.updateStrategy).type) ?? 'RollingUpdate';
    const live = this.ownedBy(entry, 'Pod').filter((pod) => !isDeleting(pod));
    if (updateType === 'RollingUpdate' && live.every(isPodReady) && this.ownedBy(entry, 'Pod').every((pod) => !isDeleting(pod))) {
      const stale = live.find((pod) => labelsOf(pod.object)[KUBE_KEYS.controllerRevisionHash] !== hash);
      if (stale) this.deleteEntry(stale);
    }
  }

  /** nodes a DaemonSet pod may run on: node selector, required node affinity and NoSchedule taints */
  private daemonNodes(template: Obj): string[] {
    const pod: KubeObject = { apiVersion: 'v1', kind: 'Pod', metadata: { name: '' }, spec: obj(template.spec) };
    return this.entriesOf('Node')
      .filter((node) => this.nodeRejection(pod, node, { daemon: true }) === null)
      .map((node) => node.object.metadata.name);
  }

  private daemonSetStatus(entry: Entry): void {
    const spec = entry.state.observedSpec;
    if (spec === undefined) return;
    const minReady = numOf(spec.minReadySeconds) ?? 0;
    const desired = this.daemonNodes(obj(spec.template));
    const pods = this.ownedBy(entry, 'Pod').filter((pod) => !isDeleting(pod));
    const hash = entry.state.syncedHash ?? '';
    const available = pods.filter((pod) => this.isAvailable(pod, minReady)).length;
    this.mutate(entry, (object) => {
      const status = child(object, 'status');
      status.observedGeneration = entry.state.observedGeneration;
      status.desiredNumberScheduled = desired.length;
      status.currentNumberScheduled = pods.filter((pod) => desired.includes(strOf(obj(pod.object.spec).nodeName) ?? '')).length;
      status.numberMisscheduled = pods.filter((pod) => !desired.includes(strOf(obj(pod.object.spec).nodeName) ?? '')).length;
      status.numberReady = pods.filter(isPodReady).length;
      putCount(status, 'numberAvailable', available);
      putCount(status, 'numberUnavailable', Math.max(0, desired.length - available));
      putCount(status, 'updatedNumberScheduled', pods.filter((pod) => labelsOf(pod.object)[KUBE_KEYS.controllerRevisionHash] === hash).length);
    });
  }

  // Job

  private jobFinished(entry: Entry): 'complete' | 'failed' | null {
    if (conditionOf(entry.object, 'Complete')?.status === 'True') return 'complete';
    if (conditionOf(entry.object, 'Failed')?.status === 'True') return 'failed';
    return null;
  }

  private syncJob(entry: Entry): void {
    if (isDeleting(entry) || this.jobFinished(entry) !== null) return;
    const spec = this.observe(entry);
    if (spec === undefined) return;
    const job = entry.object;
    const name = job.metadata.name;
    if (!entry.state.jobStarted) {
      entry.state.jobStarted = true;
      this.mutate(entry, (object) => void (child(object, 'status').startTime = this.nowIso()));
    }
    const pods = this.ownedBy(entry, 'Pod');
    const active = pods.filter(isActivePod);
    const succeeded = pods.filter((pod) => podPhase(pod) === 'Succeeded').length;
    const failed = pods.filter((pod) => podPhase(pod) === 'Failed').length;
    const completions = numOf(spec.completions) ?? 1;
    const parallelism = numOf(spec.parallelism) ?? 1;
    const backoffLimit = numOf(spec.backoffLimit) ?? 6;
    const time = this.nowIso();
    if (succeeded >= completions) {
      this.mutate(entry, (object) => {
        const status = child(object, 'status');
        setCondition(status, 'SuccessCriteriaMet', 'True', 'CompletionsReached', 'Reached expected number of succeeded pods', time, false);
        setCondition(status, 'Complete', 'True', 'CompletionsReached', 'Reached expected number of succeeded pods', time, false);
        status.completionTime = time;
      });
      this.emitEvent(job, 'Normal', 'Completed', 'Job completed', 'job-controller');
      return;
    }
    if (failed > backoffLimit) {
      for (const pod of active) this.deleteEntry(pod);
      this.mutate(entry, (object) => {
        const status = child(object, 'status');
        setCondition(status, 'FailureTarget', 'True', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit', time, false);
        setCondition(status, 'Failed', 'True', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit', time, false);
      });
      this.emitEvent(job, 'Warning', 'BackoffLimitExceeded', 'Job has reached the specified backoff limit', 'job-controller');
      return;
    }
    const wanted = Math.min(parallelism, completions - succeeded) - active.length;
    const templateLabels = strMap(obj(obj(spec.template).metadata).labels);
    const uid = job.metadata.uid ?? '';
    for (let i = 0; i < wanted; i++) {
      const podName = `${name}-${this.nextSuffix(name)}`;
      this.createPod(entry, obj(spec.template), podName, {
        ...templateLabels,
        [JOB_UID_LABELS[0]]: uid,
        [JOB_UID_LABELS[1]]: uid,
        [JOB_NAME_LABELS[0]]: name,
        [JOB_NAME_LABELS[1]]: name,
      });
      this.emitEvent(job, 'Normal', 'SuccessfulCreate', `Created pod: ${podName}`, 'job-controller');
    }
  }

  private jobStatus(entry: Entry): void {
    if (entry.state.observedSpec === undefined) return;
    const pods = this.ownedBy(entry, 'Pod');
    this.mutate(entry, (object) => {
      const status = child(object, 'status');
      putCount(status, 'active', pods.filter(isActivePod).length);
      putCount(status, 'succeeded', pods.filter((pod) => podPhase(pod) === 'Succeeded').length);
      putCount(status, 'failed', pods.filter((pod) => podPhase(pod) === 'Failed').length);
      status.ready = pods.filter((pod) => isActivePod(pod) && isPodReady(pod)).length;
      status.terminating = pods.filter(isDeleting).length;
      status.uncountedTerminatedPods = {};
    });
  }

  // Scheduler

  private storageClassFor(claim: KubeObject): Obj | undefined {
    const name = strOf(obj(claim.spec).storageClassName);
    const classes = this.entriesOf('StorageClass');
    const found =
      name !== undefined
        ? classes.find((entry) => entry.object.metadata.name === name)
        : classes.find((entry) => entry.object.metadata.annotations?.[KUBE_KEYS.defaultStorageClass] === 'true');
    return found?.object;
  }

  /** why a pod cannot run on a node, or null */
  private nodeRejection(pod: KubeObject, node: Entry, options: { daemon?: boolean } = {}): string | null {
    const spec = obj(pod.spec);
    const nodeObject = node.object;
    const nodeName = nodeObject.metadata.name;
    const labels = labelsOf(nodeObject);
    if (!options.daemon && conditionOf(nodeObject, 'Ready')?.status !== 'True') return 'node(s) had untolerated taint {node.kubernetes.io/not-ready: }';
    if (!options.daemon && obj(nodeObject.spec).unschedulable === true) return 'node(s) were unschedulable';
    for (const [key, value] of Object.entries(strMap(spec.nodeSelector))) if (labels[key] !== value) return "node(s) didn't match Pod's node affinity/selector";
    const terms = objList(obj(obj(obj(spec.affinity).nodeAffinity).requiredDuringSchedulingIgnoredDuringExecution).nodeSelectorTerms);
    if (terms.length > 0) {
      const fits = terms.some(
        (term) =>
          objList(term.matchExpressions).every((expression) => expressionMatches(labels, expression)) &&
          objList(term.matchFields).every((expression) => expressionMatches({ 'metadata.name': nodeName }, expression)),
      );
      if (!fits) return "node(s) didn't match Pod's node affinity/selector";
    }
    const tolerations = objList(spec.tolerations);
    for (const taint of objList(obj(nodeObject.spec).taints)) {
      if (taint.effect === 'PreferNoSchedule') continue;
      const tolerated = tolerations.some(
        (toleration) =>
          (toleration.key === undefined || toleration.key === taint.key) &&
          (toleration.operator === 'Exists' || toleration.value === taint.value || (toleration.value === undefined && taint.value === undefined)) &&
          (toleration.effect === undefined || toleration.effect === taint.effect),
      );
      if (!tolerated) return `node(s) had untolerated taint {${String(taint.key)}: ${String(taint.value ?? '')}}`;
    }
    if (options.daemon) return null;
    for (const claimName of podClaims(pod)) {
      const claim = this.find(infoOf('PersistentVolumeClaim'), pod.metadata.namespace, claimName);
      const volumeName = strOf(obj(claim?.object.spec).volumeName);
      if (volumeName === undefined) continue;
      const pv = this.find(infoOf('PersistentVolume'), undefined, volumeName);
      const pvTerms = objList(obj(obj(obj(pv?.object.spec).nodeAffinity).required).nodeSelectorTerms);
      if (pvTerms.length > 0 && !pvTerms.some((term) => objList(term.matchExpressions).every((expression) => expressionMatches(labels, expression)))) {
        return 'node(s) had volume node affinity conflict';
      }
    }
    const hostPorts = containersOf(pod).flatMap((container) =>
      objList(container.ports).flatMap((port) => (numOf(port.hostPort) !== undefined ? [`${port.hostPort}/${port.protocol ?? 'TCP'}`] : [])),
    );
    if (hostPorts.length > 0) {
      const used = this.entriesOf('Pod')
        .filter((other) => other.object !== pod && obj(other.object.spec).nodeName === nodeName && !isTerminal(other))
        .flatMap((other) =>
          containersOf(other.object).flatMap((container) =>
            objList(container.ports).flatMap((port) => (numOf(port.hostPort) !== undefined ? [`${port.hostPort}/${port.protocol ?? 'TCP'}`] : [])),
          ),
        );
      if (hostPorts.some((port) => used.includes(port))) return "node(s) didn't have free ports for the requested pod ports";
    }
    return null;
  }

  private candidateNodes(pod: KubeObject): { nodes: string[]; reasons: string[] } {
    const nodes: string[] = [];
    const reasons: string[] = [];
    for (const node of this.entriesOf('Node')) {
      const reason = this.nodeRejection(pod, node);
      if (reason === null) nodes.push(node.object.metadata.name);
      else reasons.push(reason);
    }
    const load = (name: string): number => this.entriesOf('Pod').filter((other) => obj(other.object.spec).nodeName === name && !isTerminal(other)).length;
    nodes.sort((a, b) => load(a) - load(b));
    return { nodes, reasons };
  }

  private unschedulable(pod: Entry, message: string): void {
    const time = this.nowIso();
    this.mutate(pod, (object) => {
      const status = child(object, 'status');
      status.phase = 'Pending';
      setCondition(status, 'PodScheduled', 'False', 'Unschedulable', message, time, false);
    });
    if (pod.state.failedScheduling !== message) {
      pod.state.failedScheduling = message;
      this.emitEvent(pod.object, 'Warning', 'FailedScheduling', message, 'default-scheduler');
    }
  }

  private unprovisionable(claim: KubeObject): boolean {
    const modes = Array.isArray(obj(claim.spec).accessModes) ? (obj(claim.spec).accessModes as unknown[]) : [];
    return modes.includes('ReadWriteMany') && this.storageClassFor(claim)?.provisioner === LOCAL_PATH_PROVISIONER;
  }

  private schedulePods(): void {
    const claimInfo = infoOf('PersistentVolumeClaim');
    const total = this.entriesOf('Node').length;
    for (const pod of this.entriesOf('Pod')) {
      if (pod.state.frozen || pod.state.scheduledTick !== undefined || isDeleting(pod) || isTerminal(pod)) continue;
      const preset = strOf(obj(pod.object.spec).nodeName);
      if (preset !== undefined) {
        if (this.find(infoOf('Node'), undefined, preset)) this.bindPod(pod, preset);
        continue;
      }
      const forced = Object.values(pod.state.behaviors ?? {}).find((behavior) => behavior.kind === 'unschedulable');
      if (forced && forced.kind === 'unschedulable') {
        this.unschedulable(pod, forced.message);
        continue;
      }
      let blocked: string | null = null;
      let waitingOnProvisioning = false;
      for (const claimName of podClaims(pod.object)) {
        const claim = this.find(claimInfo, pod.object.metadata.namespace, claimName);
        if (!claim) blocked = `persistentvolumeclaim "${claimName}" not found`;
        else if (isDeleting(claim)) blocked = `persistentvolumeclaim "${claimName}" is being deleted`;
        else if (strOf(obj(claim.object.status).phase) !== 'Bound' && this.unprovisionable(claim.object)) waitingOnProvisioning = true;
      }
      if (blocked !== null) {
        this.unschedulable(pod, `0/${total} nodes are available: ${blocked}. preemption: 0/${total} nodes are available: ${total} ${PREEMPTION}`);
        continue;
      }
      // the scheduler keeps the pod unbound while its volume cannot be provisioned (no condition yet)
      if (waitingOnProvisioning) continue;
      const { nodes, reasons } = this.candidateNodes(pod.object);
      if (nodes.length === 0) {
        const counts = new Map<string, number>();
        for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
        const parts = [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([reason, count]) => `${count} ${reason}`);
        this.unschedulable(pod, `0/${total} nodes are available: ${parts.join(', ')}. preemption: 0/${total} nodes are available: ${total} ${PREEMPTION}`);
        continue;
      }
      this.bindPod(pod, nodes[0]);
    }
  }

  private bindPod(pod: Entry, node: string): void {
    const nodeEntry = this.find(infoOf('Node'), undefined, node);
    const hostIp = strOf(objList(obj(nodeEntry?.object.status).addresses).find((address) => address.type === 'InternalIP')?.address) ?? '';
    const nodeIndex = Math.max(0, this.entriesOf('Node').findIndex((candidate) => candidate.object.metadata.name === node));
    this.ipCounter += 1;
    const podIp = `10.42.${nodeIndex}.${(this.ipCounter % 250) + 2}`;
    const time = this.nowIso();
    pod.state.scheduledTick = this.ticks;
    this.mutate(pod, (object) => {
      child(object, 'spec').nodeName = node;
      const status = child(object, 'status');
      status.hostIP = hostIp;
      status.hostIPs = [{ ip: hostIp }];
      status.podIP = podIp;
      status.podIPs = [{ ip: podIp }];
      status.startTime = time;
      setCondition(status, 'PodScheduled', 'True', undefined, undefined, time, false);
    });
    this.emitEvent(pod.object, 'Normal', 'Scheduled', `Successfully assigned ${pod.object.metadata.namespace}/${pod.object.metadata.name} to ${node}`, 'default-scheduler');
  }

  // PersistentVolumeClaims and PersistentVolumes

  private bindClaims(): void {
    for (const claim of this.entriesOf('PersistentVolumeClaim')) {
      if (claim.state.frozen || isDeleting(claim) || strOf(obj(claim.object.status).phase) !== 'Pending') continue;
      const storageClass = this.storageClassFor(claim.object);
      if (!storageClass) continue;
      const namespace = claim.object.metadata.namespace;
      const consumers = this.entriesOf('Pod').filter(
        (pod) => pod.object.metadata.namespace === namespace && !isTerminal(pod) && !isDeleting(pod) && podClaims(pod.object).includes(claim.object.metadata.name),
      );
      let node: string | undefined;
      if (storageClass.volumeBindingMode === 'WaitForFirstConsumer') {
        node = consumers.map((pod) => strOf(obj(pod.object.spec).nodeName)).find((name) => name !== undefined);
        if (node === undefined && this.unprovisionable(claim.object) && consumers.length > 0) node = this.candidateNodes(consumers[0].object).nodes[0];
      } else node = this.entriesOf('Node').find((candidate) => conditionOf(candidate.object, 'Ready')?.status === 'True')?.object.metadata.name;
      if (node === undefined) continue;
      const provisioner = strOf(storageClass.provisioner) ?? LOCAL_PATH_PROVISIONER;
      const selectedNode = node;
      if (this.unprovisionable(claim.object)) {
        this.mutate(claim, (object) => {
          object.metadata.annotations = {
            ...object.metadata.annotations,
            'volume.beta.kubernetes.io/storage-provisioner': provisioner,
            'volume.kubernetes.io/selected-node': selectedNode,
            'volume.kubernetes.io/storage-provisioner': provisioner,
          };
        });
        const component = `${provisioner}_local-path-provisioner`;
        this.emitEvent(
          claim.object,
          'Normal',
          'ExternalProvisioning',
          `Waiting for a volume to be created either by the external provisioner '${provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.`,
          'persistentvolume-controller',
        );
        this.emitEvent(claim.object, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${namespace}/${claim.object.metadata.name}"`, component);
        this.emitEvent(
          claim.object,
          'Warning',
          'ProvisioningFailed',
          `failed to provision volume with StorageClass "${strOf(obj(storageClass.metadata).name) ?? ''}": NodePath only supports ReadWriteOnce and ReadWriteOncePod (1.22+) access modes`,
          component,
        );
        continue;
      }
      this.provision(claim, storageClass, node);
    }
  }

  private provision(claim: Entry, storageClass: Obj, node: string): void {
    const claimObject = claim.object;
    const spec = obj(claimObject.spec);
    const namespace = claimObject.metadata.namespace ?? 'default';
    const pvName = `pvc-${claimObject.metadata.uid}`;
    const storage = strOf(obj(obj(spec.resources).requests).storage) ?? '1Gi';
    const policy = strOf(storageClass.reclaimPolicy) ?? 'Delete';
    const provisioner = strOf(storageClass.provisioner) ?? LOCAL_PATH_PROVISIONER;
    const className = strOf(obj(storageClass.metadata).name) ?? '';
    const time = this.nowIso();
    const pv: KubeObject = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: {
        name: pvName,
        annotations: { 'local.path.provisioner/selected-node': node, 'pv.kubernetes.io/provisioned-by': provisioner },
        finalizers: [PV_PROTECTION],
      },
      spec: {
        accessModes: clone(spec.accessModes ?? ['ReadWriteOnce']),
        capacity: { storage },
        claimRef: {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          name: claimObject.metadata.name,
          namespace,
          resourceVersion: claimObject.metadata.resourceVersion,
          uid: claimObject.metadata.uid,
        },
        hostPath: { path: `${LOCAL_PATH_ROOT}/${pvName}_${namespace}_${claimObject.metadata.name}`, type: 'DirectoryOrCreate' },
        nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: KUBE_KEYS.hostname, operator: 'In', values: [node] }] }] } },
        persistentVolumeReclaimPolicy: policy,
        storageClassName: className,
        volumeMode: 'Filesystem',
      },
      status: { lastPhaseTransitionTime: time, phase: 'Bound' },
    };
    this.insertSystem(pv, provisioner);
    this.pvRecords.set(`${namespace}/${claimObject.metadata.name}`, { name: pvName, claim: claimObject.metadata.name, namespace, originalPolicy: policy });
    this.mutate(claim, (object) => {
      object.metadata.annotations = {
        ...object.metadata.annotations,
        'pv.kubernetes.io/bind-completed': 'yes',
        'pv.kubernetes.io/bound-by-controller': 'yes',
        'volume.beta.kubernetes.io/storage-provisioner': provisioner,
        'volume.kubernetes.io/selected-node': node,
        'volume.kubernetes.io/storage-provisioner': provisioner,
      };
      child(object, 'spec').volumeName = pvName;
      object.status = { accessModes: clone(spec.accessModes ?? ['ReadWriteOnce']), capacity: { storage }, phase: 'Bound' };
    });
    this.emitEvent(claimObject, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${pvName}`, `${provisioner}_local-path-provisioner`);
  }

  /** a Released volume with Delete goes one tick later; Retain keeps it Released */
  private reclaimVolumes(): void {
    for (const pv of this.entriesOf('PersistentVolume')) {
      if (pv.state.frozen) continue;
      const spec = obj(pv.object.spec);
      const claimRef = obj(spec.claimRef);
      const phase = strOf(obj(pv.object.status).phase);
      if (phase === 'Bound' && strOf(claimRef.uid) !== undefined && !this.byUid.has(strOf(claimRef.uid) ?? '')) {
        pv.state.releasedTick = this.ticks;
        this.mutate(pv, (object) => {
          const status = child(object, 'status');
          status.phase = 'Released';
          status.lastPhaseTransitionTime = this.nowIso();
        });
        continue;
      }
      if (phase !== 'Released' || spec.persistentVolumeReclaimPolicy !== 'Delete') continue;
      if (this.ticks - Math.max(pv.state.releasedTick ?? 0, pv.state.policyTick ?? 0) >= 1) this.removeEntry(pv);
    }
  }

  // Kubelet

  private runKubelet(): void {
    for (const pod of this.entriesOf('Pod')) {
      const nodeName = strOf(obj(pod.object.spec).nodeName);
      if (nodeName === undefined || pod.state.frozen || pod.state.scheduledTick === undefined || isDeleting(pod) || isTerminal(pod)) continue;
      this.podStatus(pod, nodeName);
    }
  }

  private podStatus(pod: Entry, nodeName: string): void {
    const object = pod.object;
    const spec = obj(object.spec);
    const age = this.ticks - (pod.state.scheduledTick ?? pod.state.createdTick);
    const restartPolicy = strOf(spec.restartPolicy) ?? 'Always';
    const jobPod = (object.metadata.ownerReferences ?? []).some((ref) => ref.kind === 'Job');
    const node = this.find(infoOf('Node'), undefined, nodeName);
    const nodeReady = node !== undefined && conditionOf(node.object, 'Ready')?.status === 'True';
    const namespace = object.metadata.namespace ?? 'default';
    const claimsBound = podClaims(object).every(
      (claim) => strOf(obj(this.find(infoOf('PersistentVolumeClaim'), namespace, claim)?.object.status).phase) === 'Bound',
    );
    const time = this.nowIso();
    const startedAt = strOf(obj(object.status).startTime) ?? time;
    const identity = `${object.metadata.name}_${namespace}(${object.metadata.uid})`;
    const views: ContainerView[] = [];
    const initViews: ContainerView[] = [];
    let initBlocked: string | null = null;
    for (const container of containersOf(object, 'initContainers')) {
      const name = strOf(container.name) ?? '';
      const behavior = pod.state.behaviors?.[name] ?? DEFAULT_POD_BEHAVIOR;
      if (initBlocked !== null || !claimsBound) {
        initViews.push(waitingView(container, 'PodInitializing', undefined));
        continue;
      }
      const view = behavior.kind === 'ready' || behavior.kind === 'restarts-after-ready'
        ? completedView(container, startedAt)
        : containerView(container, behavior, age, restartPolicy === 'Always' ? 'OnFailure' : restartPolicy, false, startedAt, identity);
      initViews.push(view);
      if (view.terminal !== 'succeeded') initBlocked = name;
    }
    for (const container of containersOf(object)) {
      const name = strOf(container.name) ?? '';
      if (!claimsBound) views.push(waitingView(container, 'ContainerCreating', undefined));
      else if (initBlocked !== null) views.push(waitingView(container, 'PodInitializing', undefined));
      else views.push(containerView(container, pod.state.behaviors?.[name] ?? DEFAULT_POD_BEHAVIOR, age, restartPolicy, jobPod, startedAt, identity));
    }
    const failedInit = initViews.some((view) => view.terminal === 'failed') && restartPolicy === 'Never';
    let phase: string;
    if (failedInit || (restartPolicy !== 'Always' && views.some((view) => view.terminal === 'failed'))) phase = 'Failed';
    else if (restartPolicy !== 'Always' && views.length > 0 && views.every((view) => view.terminal === 'succeeded')) phase = 'Succeeded';
    else if (!claimsBound || initBlocked !== null || views.some((view) => view.pending)) phase = 'Pending';
    else phase = 'Running';
    const containersReady = views.length > 0 && views.every((view) => view.ready);
    const ready = containersReady && nodeReady && phase === 'Running';
    const unready = views.filter((view) => !view.ready).map((view) => view.name);
    if (ready && (pod.state.readySinceMs === undefined || pod.state.readySinceMs === null)) pod.state.readySinceMs = this.nowMs();
    if (!ready) pod.state.readySinceMs = null;
    this.mutate(pod, (target) => {
      const status = child(target, 'status');
      status.phase = phase;
      setCondition(status, 'PodReadyToStartContainers', 'True', undefined, undefined, time, false);
      if (initBlocked !== null) setCondition(status, 'Initialized', 'False', 'ContainersNotInitialized', `containers with incomplete status: [${initBlocked}]`, time, false);
      else setCondition(status, 'Initialized', 'True', undefined, undefined, time, false);
      const terminalReason = phase === 'Succeeded' || phase === 'Failed' ? 'PodCompleted' : undefined;
      if (ready) setCondition(status, 'Ready', 'True', undefined, undefined, time, false);
      else setCondition(status, 'Ready', 'False', terminalReason ?? 'ContainersNotReady', terminalReason ? undefined : `containers with unready status: [${unready.join(' ')}]`, time, false);
      if (containersReady) setCondition(status, 'ContainersReady', 'True', undefined, undefined, time, false);
      else setCondition(status, 'ContainersReady', 'False', terminalReason ?? 'ContainersNotReady', terminalReason ? undefined : `containers with unready status: [${unready.join(' ')}]`, time, false);
      setCondition(status, 'PodScheduled', 'True', undefined, undefined, time, false);
      status.containerStatuses = views.map((view) => view.status);
      if (initViews.length > 0) status.initContainerStatuses = initViews.map((view) => view.status);
    });
    for (const view of [...initViews, ...views]) {
      const image = strOf(obj(view.status).image) ?? '';
      if (view.started) {
        this.emitOnce(pod, `pulled/${view.name}`, 'Normal', 'Pulled', `Container image "${image}" already present on machine`);
        this.emitOnce(pod, `created/${view.name}`, 'Normal', 'Created', `Created container: ${view.name}`);
        this.emitOnce(pod, `started/${view.name}`, 'Normal', 'Started', `Started container ${view.name}`);
      }
      const reason = view.waitingReason;
      if (reason === 'CrashLoopBackOff') {
        this.emitOnce(pod, `backoff/${view.name}`, 'Warning', 'BackOff', `Back-off restarting failed container ${view.name} in pod ${identity}`);
      } else if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') {
        this.emitOnce(pod, `pulling/${view.name}`, 'Normal', 'Pulling', `Pulling image "${image}"`);
        this.emitOnce(pod, `pull-failed/${view.name}`, 'Warning', 'Failed', `Failed to pull image "${image}": ${view.waitingMessage ?? ''}`);
        this.emitOnce(pod, `pull-error/${view.name}`, 'Warning', 'Failed', `Error: ${reason}`);
        if (reason === 'ImagePullBackOff') this.emitOnce(pod, `pull-backoff/${view.name}`, 'Normal', 'BackOff', `Back-off pulling image "${image}"`);
      } else if (reason === 'ErrImageNeverPull') {
        this.emitOnce(pod, `never-pull/${view.name}`, 'Warning', 'ErrImageNeverPull', `Container image "${image}" is not present with pull policy of Never`);
        this.emitOnce(pod, `never-pull-error/${view.name}`, 'Warning', 'Failed', 'Error: ErrImageNeverPull');
      } else if (reason === 'InvalidImageName') {
        this.emitOnce(pod, `invalid/${view.name}`, 'Warning', 'InspectFailed', `Failed to apply default image tag "${image}": couldn't parse image name "${image}": invalid reference format`);
        this.emitOnce(pod, `invalid-error/${view.name}`, 'Warning', 'Failed', 'Error: InvalidImageName');
      } else if (reason === 'CreateContainerConfigError') {
        this.emitOnce(pod, `config/${view.name}`, 'Warning', 'Failed', `Error: ${view.waitingMessage ?? reason}`);
      }
    }
  }

  // Services

  private bindLoadBalancer(service: KubeObject): void {
    const ingress = this.entriesOf('Node')
      .filter((node) => conditionOf(node.object, 'Ready')?.status === 'True')
      .map((node) => ({
        ip: strOf(objList(obj(node.object.status).addresses).find((address) => address.type === 'InternalIP')?.address) ?? '',
        ipMode: 'VIP',
      }));
    child(child(service, 'status'), 'loadBalancer').ingress = ingress;
  }

  private portKeys(service: KubeObject): string[] {
    return objList(obj(service.spec).ports).map((port) => `${numOf(port.port) ?? 0}/${strOf(port.protocol) ?? 'TCP'}`);
  }

  /** ServiceLB: the first Service to bind a host port keeps it; later ones stay without ingress */
  private assignLoadBalancers(): void {
    const holders = new Map<string, string>();
    const services = this.entriesOf('Service').filter((service) => !isDeleting(service));
    const bound = (service: Entry): boolean => objList(obj(obj(service.object.status).loadBalancer).ingress).length > 0;
    for (const service of services) {
      if (obj(service.object.spec).type !== 'LoadBalancer' || !bound(service)) continue;
      for (const port of this.portKeys(service.object)) if (!holders.has(port)) holders.set(port, service.object.metadata.uid ?? '');
    }
    for (const service of services) {
      if (service.state.frozen || obj(service.object.spec).type !== 'LoadBalancer' || bound(service)) continue;
      if (this.ticks - service.state.createdTick < 1) continue;
      const ports = this.portKeys(service.object);
      if (ports.some((port) => holders.has(port) && holders.get(port) !== service.object.metadata.uid)) continue;
      this.mutate(service, (object) => this.bindLoadBalancer(object));
      for (const port of ports) holders.set(port, service.object.metadata.uid ?? '');
    }
  }

  private syncEndpointSlices(): void {
    const sliceInfo = infoOf('EndpointSlice');
    for (const service of this.entriesOf('Service')) {
      if (service.state.frozen || isDeleting(service)) continue;
      const spec = obj(service.object.spec);
      const selector = strMap(spec.selector);
      if (Object.keys(selector).length === 0) continue;
      const namespace = service.object.metadata.namespace;
      const pods = this.select(infoOf('Pod'), namespace ?? 'default').filter(
        (pod) => !isTerminal(pod) && strOf(obj(pod.object.status).podIP) !== undefined && Object.entries(selector).every(([key, value]) => labelsOf(pod.object)[key] === value),
      );
      const endpoints = pods.map((pod) => ({
        addresses: [strOf(obj(pod.object.status).podIP) ?? ''],
        conditions: { ready: isPodReady(pod) && !isDeleting(pod), serving: isPodReady(pod), terminating: isDeleting(pod) },
        nodeName: strOf(obj(pod.object.spec).nodeName),
        targetRef: { kind: 'Pod', name: pod.object.metadata.name, namespace, uid: pod.object.metadata.uid },
      }));
      const first = pods[0];
      const ports = objList(spec.ports).flatMap((port) => {
        let target: unknown = port.targetPort ?? port.port;
        if (typeof target === 'string' && first) {
          target = containersOf(first.object)
            .flatMap((container) => objList(container.ports))
            .find((containerPort) => containerPort.name === target)?.containerPort;
        }
        if (typeof target !== 'number') return [];
        return [{ ...(port.name !== undefined ? { name: port.name } : {}), port: target, protocol: strOf(port.protocol) ?? 'TCP' }];
      });
      const name = service.state.sliceName ?? `${service.object.metadata.name}-${safeHash(service.object.metadata.uid ?? '', 5)}`;
      service.state.sliceName = name;
      const existing = this.find(sliceInfo, namespace, name);
      if (existing) {
        this.mutate(existing, (slice) => {
          slice.endpoints = endpoints;
          slice.ports = ports;
        });
      } else {
        this.insertSystem(
          {
            apiVersion: 'discovery.k8s.io/v1',
            kind: 'EndpointSlice',
            metadata: {
              name,
              namespace,
              labels: {
                'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io',
                'kubernetes.io/service-name': service.object.metadata.name,
              },
              ownerReferences: [ownerRefOf(service.object)],
            },
            addressType: 'IPv4',
            endpoints,
            ports,
          },
          'endpointslice-controller',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Container status (pure)
// ---------------------------------------------------------------------------

interface ContainerView {
  name: string;
  status: Obj;
  ready: boolean;
  started: boolean;
  /** keeps the pod Pending (image pull, config errors) */
  pending: boolean;
  terminal: 'succeeded' | 'failed' | null;
  waitingReason?: string;
  waitingMessage?: string;
}

function containerBase(container: Obj): Obj {
  const name = strOf(container.name) ?? '';
  const image = strOf(container.image) ?? '';
  return {
    containerID: `containerd://${sha256Hex(`${name}/${image}`).slice(0, 12)}`,
    image,
    imageID: `sha256:${sha256Hex(image)}`,
    name,
  };
}

function terminatedState(exitCode: number, reason: string, startedAt: string, message?: string): Obj {
  return { exitCode, finishedAt: startedAt, ...(message !== undefined ? { message } : {}), reason, startedAt };
}

function waitingView(container: Obj, reason: string, message: string | undefined): ContainerView {
  return {
    name: strOf(container.name) ?? '',
    status: { ...containerBase(container), lastState: {}, ready: false, restartCount: 0, started: false, state: { waiting: { ...(message !== undefined ? { message } : {}), reason } } },
    ready: false,
    started: false,
    pending: true,
    terminal: null,
    waitingReason: reason,
    ...(message !== undefined ? { waitingMessage: message } : {}),
  };
}

function completedView(container: Obj, startedAt: string): ContainerView {
  return {
    name: strOf(container.name) ?? '',
    status: { ...containerBase(container), lastState: {}, ready: false, restartCount: 0, started: false, state: { terminated: terminatedState(0, 'Completed', startedAt) } },
    ready: false,
    started: true,
    pending: false,
    terminal: 'succeeded',
  };
}

function containerView(container: Obj, behavior: PodBehavior, age: number, restartPolicy: string, jobPod: boolean, startedAt: string, identity: string): ContainerView {
  const name = strOf(container.name) ?? '';
  const base = containerBase(container);
  const running = (ready: boolean, restarts = 0, last?: Obj): ContainerView => ({
    name,
    status: { ...base, lastState: last ? { terminated: last } : {}, ready, restartCount: restarts, started: true, state: { running: { startedAt } } },
    ready,
    started: true,
    pending: false,
    terminal: null,
  });
  const terminated = (exitCode: number, reason: string, message?: string): ContainerView => ({
    name,
    status: { ...base, lastState: {}, ready: false, restartCount: 0, started: false, state: { terminated: terminatedState(exitCode, reason, startedAt, message) } },
    ready: false,
    started: true,
    pending: false,
    terminal: exitCode === 0 ? 'succeeded' : 'failed',
  });
  const backOff = (restarts: number, last: Obj): ContainerView => {
    const seconds = Math.min(300, 10 * 2 ** Math.max(0, restarts - 1));
    const message = `back-off ${seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60 === 0 ? '' : `${seconds % 60}s`}` : `${seconds}s`} restarting failed container=${name} pod=${identity}`;
    return {
      name,
      status: { ...base, lastState: { terminated: last }, ready: false, restartCount: restarts, started: false, state: { waiting: { message, reason: 'CrashLoopBackOff' } } },
      ready: false,
      started: true,
      pending: false,
      terminal: null,
      waitingReason: 'CrashLoopBackOff',
      waitingMessage: message,
    };
  };
  switch (behavior.kind) {
    case 'ready':
      if (jobPod && restartPolicy !== 'Always') return age >= behavior.afterTicks ? terminated(0, 'Completed') : running(false);
      return running(age >= behavior.afterTicks);
    case 'never-ready':
      return running(false);
    case 'crashloop':
      if (age < 1) return running(false);
      if (restartPolicy === 'Never') return terminated(behavior.exitCode, 'Error', behavior.message);
      return backOff(age, terminatedState(behavior.exitCode, 'Error', startedAt, behavior.message));
    case 'waiting':
      return waitingView(container, behavior.reason, behavior.message);
    case 'unschedulable':
      return waitingView(container, 'ContainerCreating', undefined);
    case 'oom':
      if (age < behavior.afterTicks) return running(age >= 1);
      if (restartPolicy === 'Never') return terminated(137, 'OOMKilled');
      return backOff(age - behavior.afterTicks + 1, terminatedState(137, 'OOMKilled', startedAt));
    case 'restarts-after-ready': {
      const restarts = age >= 1 ? Math.floor(age / Math.max(1, behavior.everyTicks)) : 0;
      return running(age >= 1, restarts, restarts > 0 ? terminatedState(1, 'Error', startedAt) : undefined);
    }
  }
}
