// Recorded kubectl, helm and metrics output of design-07 3.11, read only through this module (3.0
// rule 5). Until the test machine re-records them (PD-12) the scenarios are synthetic: authored in
// the exact layout kubectl v1.36 prints and already scrubbed. Every read validates the whole file
// set of its scenario against the scrub rules first and refuses content that breaks them.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { KubeList } from '../../../services/orchestrator/kubernetes/resources/meta';

export const FIXTURES_ROOT = join(import.meta.dir, '..', 'fixtures');

/** Namespaced resources the recorder captures, in the order of its kubectl call. */
export const NAMESPACED_RESOURCES = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'controllerrevisions.apps',
  'jobs.batch',
  'pods',
  'events',
  'persistentvolumeclaims',
  'services',
  'endpointslices',
] as const;

export const CLUSTER_RESOURCES = ['nodes', 'persistentvolumes'] as const;

/** One `<resource>.json` List per entry exists in every capture directory. */
export const CAPTURED_RESOURCES = [...NAMESPACED_RESOURCES, ...CLUSTER_RESOURCES] as const;

export type CapturedResource = (typeof CAPTURED_RESOURCES)[number];

export const RESOURCE_KINDS: Readonly<Record<CapturedResource, { apiVersion: string; kind: string }>> = {
  'deployments.apps': { apiVersion: 'apps/v1', kind: 'Deployment' },
  'statefulsets.apps': { apiVersion: 'apps/v1', kind: 'StatefulSet' },
  'daemonsets.apps': { apiVersion: 'apps/v1', kind: 'DaemonSet' },
  'replicasets.apps': { apiVersion: 'apps/v1', kind: 'ReplicaSet' },
  'controllerrevisions.apps': { apiVersion: 'apps/v1', kind: 'ControllerRevision' },
  'jobs.batch': { apiVersion: 'batch/v1', kind: 'Job' },
  pods: { apiVersion: 'v1', kind: 'Pod' },
  events: { apiVersion: 'v1', kind: 'Event' },
  persistentvolumeclaims: { apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
  services: { apiVersion: 'v1', kind: 'Service' },
  endpointslices: { apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice' },
  nodes: { apiVersion: 'v1', kind: 'Node' },
  persistentvolumes: { apiVersion: 'v1', kind: 'PersistentVolume' },
};

/** Scenario names of design-07 3.11, per fixture directory. */
export const DESIGN_SCENARIOS = {
  kubectl: [
    'rollout-progressing',
    'rollout-complete',
    'crashloop',
    'image-pull-backoff',
    'err-image-never-pull',
    'invalid-image-name',
    'create-container-config-error',
    'oom-killed',
    'unschedulable-resources',
    'unschedulable-node-selector',
    'pvc-pending-rwx',
    'progress-deadline-exceeded',
    'replica-failure-quota',
    'statefulset-stuck',
    'daemonset-rolling',
    'job-complete',
    'job-failed',
    'init-container-crash',
    'multi-container',
    'terminating-pods',
    'evicted-pod',
    'node-not-ready',
    'headless-no-ports',
    'metrics-top',
  ],
  helm: ['helm-list', 'helm-status-failed', 'helm-history-rollback'],
  metrics: ['metrics-top'],
} as const;

/** Scrubbed node names of the recording lane (duo) and the servers.yml keys they stand for. */
export const FIXTURE_SERVERS: Readonly<Record<string, string>> = { 'server-1': 'server_1', 'agent-1': 'agent_1' };

/** `app.kubernetes.io/part-of` and `P/release` values the scenarios carry. */
export const FIXTURE_PROJECT = 'shop';
export const FIXTURE_RELEASE = '1.4.2';

export function fixtureNamespace(scenario: string): string {
  return `fixture-${scenario}`;
}

export type FixtureKind = 'kubectl' | 'helm';

export interface FixtureMeta {
  /** authored by hand in the recorder's output format; replaced by a recording on the test machine */
  synthetic?: true;
  /** date of the recording (YYYY-MM-DD) */
  recordedOn?: string;
  k3sVersion: string;
  /** helm scenarios only */
  helmVersion?: string;
  /** how the recorder reproduces the condition; helm scenarios name each file they capture */
  steps: string[];
}

// ---------------------------------------------------------------------------
// Serialization of the recorded tools
// ---------------------------------------------------------------------------

// Go's encoder escapes <, >, & and the two JavaScript line separators (U+2028, U+2029).
const GO_ESCAPED = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

function goEscape(json: string): string {
  return json.replace(GO_ESCAPED, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** `kubectl get -o json`: unstructured objects (keys sorted), json.MarshalIndent with 4 spaces, Go's HTML-safe escapes. */
export function formatKubectlJson(value: unknown): string {
  return `${goEscape(JSON.stringify(sortKeysDeep(value), null, 4))}\n`;
}

/** json.Encoder output (helm `-o json`, `kubectl get --raw`): compact, field order kept, trailing newline. */
export function formatCompactJson(value: unknown): string {
  return `${goEscape(JSON.stringify(value))}\n`;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const META_KEYS = new Set(['synthetic', 'recordedOn', 'k3sVersion', 'helmVersion', 'steps']);

export function metaErrors(value: unknown, kind: FixtureKind): string[] {
  if (!isRecord(value)) return ['meta.json is not an object'];
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!META_KEYS.has(key)) errors.push(`unknown key ${key}`);
  }
  if (typeof value.k3sVersion !== 'string' || !/^v\d+\.\d+\.\d+\+k3s\d+$/.test(value.k3sVersion)) {
    errors.push('k3sVersion must look like v1.36.4+k3s1');
  }
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => typeof s === 'string' && s.trim() !== '')) {
    errors.push('steps must be a non-empty list of non-empty strings');
  }
  const synthetic = value.synthetic;
  const recordedOn = value.recordedOn;
  if (synthetic !== undefined && synthetic !== true) errors.push('synthetic must be true when present');
  if (recordedOn !== undefined && (typeof recordedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recordedOn))) {
    errors.push('recordedOn must be a YYYY-MM-DD date');
  }
  if ((synthetic === undefined) === (recordedOn === undefined)) {
    errors.push('exactly one of synthetic and recordedOn must be set');
  }
  if (kind === 'helm') {
    if (typeof value.helmVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(value.helmVersion)) {
      errors.push('helmVersion must look like v4.3.0');
    }
  } else if (value.helmVersion !== undefined) {
    errors.push('helmVersion belongs to helm scenarios only');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Scrub rules (design-07 3.11)
// ---------------------------------------------------------------------------

/** One file of a scenario's file set; `json` is absent for text files (stderr, manifests). */
export interface FixtureFile {
  path: string;
  text: string;
  json?: unknown;
}

const SCRUBBED_UID = /^00000000-0000-4000-8000-\d{12}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const RFC3339 = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const GO_TIME = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-]\d{4} [A-Z]+)/g;
const NODE_NAME = /^(server|agent)-\d+$/;
const RUNTIME_ID = /^containerd:\/\/[0-9a-f]{12}$/;
const POD_IP = /^10\.42\.\d{1,3}\.\d{1,3}$/;
const HOST_IP = /^192\.0\.2\.\d{1,3}$/;
const SECRET_MARKER = 'E2E_SECRET_';
const SCRUBBED_DAY = '2026-01-01';
const SCRUBBED_START = `${SCRUBBED_DAY}T00:00:00Z`;
/** annotation and label keys whose value is a node name */
const NODE_NAME_KEYS = new Set([
  'kubernetes.io/hostname',
  'k3s.io/hostname',
  'volume.kubernetes.io/selected-node',
  'local.path.provisioner/selected-node',
]);
const CLUSTER_KINDS = new Set(['Node', 'PersistentVolume', 'Namespace', 'StorageClass']);

/** pod and service CIDRs of k3s, the documentation range for hosts, loopback and the unspecified address */
function allowedIp(a: number, b: number, c: number, d: number): boolean {
  if (a === 10 && (b === 42 || b === 43)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  return (a === 127 && b === 0 && c === 0 && d === 1) || (a === 0 && b === 0 && c === 0 && d === 0);
}

interface ObjectKey {
  kind: string;
  namespace: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function metadataOf(item: Record<string, unknown>): Record<string, unknown> {
  return isRecord(item.metadata) ? item.metadata : {};
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function objectKey(item: Record<string, unknown>): ObjectKey | null {
  const meta = metadataOf(item);
  if (typeof item.kind !== 'string' || typeof meta.name !== 'string') return null;
  return { kind: item.kind, namespace: stringOf(meta.namespace), name: meta.name };
}

function refKey(key: ObjectKey): string {
  return `${key.kind}/${key.namespace}/${key.name}`;
}

function listItems(value: unknown): Record<string, unknown>[] {
  return isRecord(value) && value.kind === 'List' ? arrayOf(value.items) : [];
}

class ScrubCheck {
  readonly violations: string[] = [];
  private readonly resourceVersions: number[] = [];
  private earliest: { key: string; at: string } | null = null;
  private readonly uidOwners = new Map<string, string>();

  report(where: string, message: string): void {
    this.violations.push(`${where}: ${message}`);
  }

  text(where: string, value: string): void {
    if (value.includes(SECRET_MARKER)) this.report(where, `contains ${SECRET_MARKER}`);
    for (const match of value.matchAll(UUID)) {
      if (!SCRUBBED_UID.test(match[0])) this.report(where, `uid ${match[0]} is not scrubbed`);
    }
    for (const match of value.matchAll(IPV4)) {
      const [a, b, c, d] = match.slice(1, 5).map(Number);
      if (!allowedIp(a, b, c, d)) this.report(where, `IP address ${match[0]} is not scrubbed`);
    }
    for (const match of value.matchAll(RFC3339)) {
      this.timestamp(where, match[0], match[1], match[2], match[3] ?? '', match[4] === 'Z');
    }
    for (const match of value.matchAll(GO_TIME)) {
      this.timestamp(where, match[0], match[1], match[2], match[3] ?? '', match[4] === '+0000 UTC');
    }
  }

  private timestamp(where: string, raw: string, day: string, time: string, fraction: string, utc: boolean): void {
    if (day !== SCRUBBED_DAY || !utc) {
      this.report(where, `timestamp ${raw} is not shifted to ${SCRUBBED_DAY} UTC`);
      return;
    }
    const key = `${time}.${fraction.slice(1).padEnd(9, '0')}`;
    if (!this.earliest || key < this.earliest.key) this.earliest = { key, at: raw };
  }

  /** `key` is the property holding `value`; array items carry the key of their array (`podIPs`, `matchExpressions`). */
  json(where: string, value: unknown, key: string | null, parentKey: string | null): void {
    if (typeof value === 'string') {
      this.text(where, value);
      this.field(where, key, parentKey, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        this.json(`${where}[${i}]`, item, key, parentKey);
      });
      return;
    }
    if (!isRecord(value)) return;
    this.affinityTerm(where, value, key);
    for (const [k, v] of Object.entries(value)) {
      const path = `${where}.${k}`;
      if (k === 'managedFields') this.report(path, 'managedFields must be removed');
      // containerStatuses[].user.linux.uid is the numeric Linux uid (Kubernetes 1.36), not an object uid
      if (k === 'uid' && typeof v !== 'string' && key !== 'linux') this.report(path, 'uid is not a string');
      if (k === 'resourceVersion' && typeof v !== 'string') this.report(path, 'resourceVersion is not a string');
      this.json(path, v, k, key);
    }
  }

  private field(where: string, key: string | null, parentKey: string | null, value: string): void {
    if (key === null) return;
    if (key === 'uid' && !SCRUBBED_UID.test(value)) this.report(where, `uid ${value} is not scrubbed`);
    if (key === 'resourceVersion' && value !== '') {
      if (/^[1-9]\d*$/.test(value)) this.resourceVersions.push(Number(value));
      else this.report(where, `resourceVersion ${value} is not a sequential number`);
    }
    if ((key === 'containerID' || key === 'imageID') && value !== '' && !RUNTIME_ID.test(value)) {
      this.report(where, `${key} ${value} is not containerd://<12 hex>`);
    }
    const nodeField =
      key === 'nodeName' ||
      (key === 'host' && parentKey === 'source') ||
      ((parentKey === 'labels' || parentKey === 'annotations') && NODE_NAME_KEYS.has(key));
    if (nodeField && !NODE_NAME.test(value)) this.report(where, `node name ${value} is not scrubbed`);
    const podIp = key === 'podIP' || (key === 'ip' && parentKey === 'podIPs');
    if (podIp && !POD_IP.test(value)) this.report(where, `pod IP ${value} is not 10.42.<n>.<m>`);
    const hostIp = key === 'hostIP' || (key === 'ip' && (parentKey === 'hostIPs' || parentKey === 'ingress'));
    if (hostIp && !HOST_IP.test(value)) this.report(where, `host IP ${value} is not 192.0.2.<n>`);
  }

  /** hostname node affinity (PersistentVolumes) and DaemonSet pod pinning name nodes in `values` */
  private affinityTerm(where: string, value: Record<string, unknown>, ownKey: string | null): void {
    if (ownKey !== 'matchExpressions' && ownKey !== 'matchFields') return;
    if (value.key !== 'kubernetes.io/hostname' && value.key !== 'metadata.name') return;
    if (!Array.isArray(value.values)) return;
    for (const node of value.values) {
      if (typeof node !== 'string' || !NODE_NAME.test(node)) this.report(`${where}.values`, `node name ${String(node)} is not scrubbed`);
    }
  }

  /** item-level rules of one capture: node objects, endpoint addresses, references, uid reuse */
  capture(where: string, items: readonly { file: string; item: Record<string, unknown> }[]): void {
    const uids = new Map<string, string>();
    for (const { item } of items) {
      const key = objectKey(item);
      const uid = metadataOf(item).uid;
      if (key && typeof uid === 'string') uids.set(refKey(key), uid);
    }
    for (const { file, item } of items) {
      const key = objectKey(item);
      const at = `${where}${file} ${key ? `${key.kind}/${key.name}` : '?'}`;
      const uid = metadataOf(item).uid;
      if (key && typeof uid === 'string') {
        const owner = refKey(key);
        const previous = this.uidOwners.get(uid);
        if (previous && previous !== owner) this.report(at, `uid ${uid} is also the uid of ${previous}`);
        else this.uidOwners.set(uid, owner);
      }
      if (item.kind === 'Node') this.node(at, item);
      if (item.kind === 'EndpointSlice') this.endpoints(at, item);
      const namespace = key?.namespace ?? '';
      for (const ref of arrayOf(metadataOf(item).ownerReferences)) {
        this.reference(at, 'ownerReferences', ref, namespace, uids);
      }
      if (isRecord(item.involvedObject)) {
        const target = item.involvedObject;
        if (target.kind === 'Node' && !NODE_NAME.test(stringOf(target.name))) {
          this.report(at, `node name ${stringOf(target.name)} is not scrubbed`);
        }
        this.reference(at, 'involvedObject', target, stringOf(target.namespace), uids);
      }
      const spec = isRecord(item.spec) ? item.spec : {};
      if (isRecord(spec.claimRef)) this.reference(at, 'claimRef', spec.claimRef, stringOf(spec.claimRef.namespace), uids);
      for (const endpoint of arrayOf(item.endpoints)) {
        if (isRecord(endpoint.targetRef)) {
          this.reference(at, 'targetRef', endpoint.targetRef, stringOf(endpoint.targetRef.namespace), uids);
        }
      }
    }
  }

  private node(at: string, item: Record<string, unknown>): void {
    const name = stringOf(metadataOf(item).name);
    if (!NODE_NAME.test(name)) this.report(at, `node name ${name} is not scrubbed`);
    const status = isRecord(item.status) ? item.status : {};
    for (const address of arrayOf(status.addresses)) {
      const value = stringOf(address.address);
      if (address.type === 'Hostname' && !NODE_NAME.test(value)) this.report(at, `node name ${value} is not scrubbed`);
      if ((address.type === 'InternalIP' || address.type === 'ExternalIP') && !HOST_IP.test(value)) {
        this.report(at, `host IP ${value} is not 192.0.2.<n>`);
      }
    }
  }

  private endpoints(at: string, item: Record<string, unknown>): void {
    for (const endpoint of arrayOf(item.endpoints)) {
      const addresses: unknown[] = Array.isArray(endpoint.addresses) ? endpoint.addresses : [];
      for (const address of addresses) {
        if (typeof address !== 'string' || !POD_IP.test(address)) {
          this.report(at, `endpoint address ${String(address)} is not 10.42.<n>.<m>`);
        }
      }
    }
  }

  private reference(at: string, field: string, ref: Record<string, unknown>, namespace: string, uids: Map<string, string>): void {
    const kind = stringOf(ref.kind);
    const name = stringOf(ref.name);
    const target = uids.get(refKey({ kind, namespace: CLUSTER_KINDS.has(kind) ? '' : namespace, name }));
    if (target !== undefined && ref.uid !== target) {
      this.report(at, `${field} ${kind}/${name} has uid ${String(ref.uid)}, but that object's uid is ${target}`);
    }
  }

  finish(scope: string): string[] {
    const occurrences = this.resourceVersions.length;
    const beyond = this.resourceVersions.find((rv) => rv > occurrences);
    if (beyond !== undefined) {
      this.report(scope, `resourceVersion ${beyond} exceeds the ${occurrences} resourceVersions of the file set, so it is not sequential`);
    }
    if (this.earliest && this.earliest.key !== '00:00:00.000000000') {
      this.report(scope, `earliest timestamp ${this.earliest.at} is not ${SCRUBBED_START}`);
    }
    return this.violations;
  }
}

/** Every scrub-rule violation of one scenario's file set (all captures, plus its metrics read). */
export function scrubViolations(files: readonly FixtureFile[]): string[] {
  const check = new ScrubCheck();
  const captures = new Map<string, { file: string; item: Record<string, unknown> }[]>();
  for (const file of files) {
    if (file.json === undefined) {
      check.text(file.path, file.text);
      continue;
    }
    check.json(file.path, file.json, null, null);
    const slash = file.path.lastIndexOf('/');
    const capture = slash === -1 ? '' : file.path.slice(0, slash + 1);
    const items = captures.get(capture) ?? [];
    for (const item of listItems(file.json)) items.push({ file: file.path.slice(slash + 1), item });
    captures.set(capture, items);
  }
  for (const [capture, items] of captures) check.capture(capture, items);
  return check.finish('file set');
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function safeSegments(relative: string): string {
  const parts = relative.split(/[\\/]/);
  if (isAbsolute(relative) || parts.some((p) => p === '..' || p === '' || p === '.')) {
    throw new Error(`Fixture path ${relative} must be relative and stay inside its scenario`);
  }
  return parts.join('/');
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    else out.push(`${prefix}${entry.name}`);
  }
  return out.sort();
}

function listDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** `crashloop/pods` or `daemonset-rolling/completed/pods` (the `{fixture}` form of FakeKubeExecutor) */
export function splitFixtureRef(ref: string): { scenario: string; file: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`Fixture reference ${ref} is not <scenario>/<file>`);
  return { scenario: ref.slice(0, slash), file: ref.slice(slash + 1) };
}

function unscrubbed(scope: string, violations: readonly string[]): Error {
  const shown = violations.slice(0, 20).map((v) => `  - ${v}`);
  const more = violations.length > shown.length ? [`  ... ${violations.length - shown.length} more`] : [];
  return new Error([`Fixture ${scope} is not scrubbed (design-07 3.11):`, ...shown, ...more].join('\n'));
}

/** Fixture reads under one root; the module-level functions use FIXTURES_ROOT. */
export class FixtureStore {
  private readonly verified = new Map<string, string[]>();

  constructor(readonly root: string = FIXTURES_ROOT) {}

  kubectlScenarios(): string[] {
    return listDirectories(join(this.root, 'kubectl'));
  }

  helmScenarios(): string[] {
    return listDirectories(join(this.root, 'helm'));
  }

  metricsScenarios(): string[] {
    const dir = join(this.root, 'metrics');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }

  /** '' for the scenario directory, then each capture subdirectory (e.g. `completed`) */
  captures(scenario: string): string[] {
    return ['', ...listDirectories(this.scenarioDir('kubectl', scenario))];
  }

  meta(kind: FixtureKind, scenario: string): FixtureMeta {
    const value: unknown = JSON.parse(this.read(join(this.scenarioDir(kind, scenario), 'meta.json')));
    const errors = metaErrors(value, kind);
    if (errors.length > 0) throw new Error(`${kind}/${scenario}/meta.json is invalid: ${errors.join('; ')}`);
    return value as FixtureMeta;
  }

  /** The file set the scrub rules apply to: every file of the scenario, and for kubectl its metrics read. */
  fileSet(kind: FixtureKind, scenario: string): FixtureFile[] {
    const dir = this.scenarioDir(kind, scenario);
    const files = listFiles(dir)
      .filter((f) => f !== 'meta.json')
      .map((f) => this.fixtureFile(join(dir, f), f));
    const metrics = join(this.root, 'metrics', `${scenario}.json`);
    if (kind === 'kubectl' && existsSync(metrics)) files.push(this.fixtureFile(metrics, `metrics/${scenario}.json`));
    return files;
  }

  violations(kind: FixtureKind, scenario: string): string[] {
    return this.memo(`${kind}/${scenario}`, () => this.fileSet(kind, scenario));
  }

  kubectlText(scenario: string, file: string): string {
    this.assertScrubbed(`kubectl/${scenario}`, () => this.fileSet('kubectl', scenario));
    const relative = safeSegments(file.endsWith('.json') ? file : `${file}.json`);
    return this.read(join(this.scenarioDir('kubectl', scenario), relative));
  }

  kubectl<T = unknown>(scenario: string, file: string): T {
    return JSON.parse(this.kubectlText(scenario, file)) as T;
  }

  list<T = unknown>(scenario: string, resource: CapturedResource, capture = ''): KubeList<T> {
    return this.kubectl<KubeList<T>>(scenario, capture ? `${capture}/${resource}` : resource);
  }

  /** One List with the items of several resources in the given order, as one multi-resource `kubectl get` prints it. */
  resources<T = unknown>(scenario: string, resources: readonly CapturedResource[], capture = ''): KubeList<T> {
    const items = resources.flatMap((r) => this.list<T>(scenario, r, capture).items);
    const combined = { apiVersion: 'v1' as const, items, kind: 'List' as const, metadata: { resourceVersion: '' } };
    return combined;
  }

  helmText(scenario: string, file: string): string {
    this.assertScrubbed(`helm/${scenario}`, () => this.fileSet('helm', scenario));
    return this.read(join(this.scenarioDir('helm', scenario), safeSegments(file)));
  }

  helmJson<T = unknown>(scenario: string, file: string): T {
    return JSON.parse(this.helmText(scenario, file.endsWith('.json') ? file : `${file}.json`)) as T;
  }

  metricsText(scenario: string): string {
    const path = join(this.root, 'metrics', `${safeSegments(scenario)}.json`);
    if (existsSync(join(this.root, 'kubectl', scenario))) {
      this.assertScrubbed(`kubectl/${scenario}`, () => this.fileSet('kubectl', scenario));
    } else {
      this.assertScrubbed(`metrics/${scenario}`, () => [this.fixtureFile(path, `metrics/${scenario}.json`)]);
    }
    return this.read(path);
  }

  metrics<T = unknown>(scenario: string): T {
    return JSON.parse(this.metricsText(scenario)) as T;
  }

  private memo(key: string, files: () => FixtureFile[]): string[] {
    let found = this.verified.get(key);
    if (!found) {
      found = scrubViolations(files());
      this.verified.set(key, found);
    }
    return found;
  }

  private assertScrubbed(key: string, files: () => FixtureFile[]): void {
    const found = this.memo(key, files);
    if (found.length > 0) throw unscrubbed(key, found);
  }

  private scenarioDir(kind: FixtureKind, scenario: string): string {
    const dir = join(this.root, kind, safeSegments(scenario));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No ${kind} fixture scenario ${scenario} under ${this.root}`);
    return dir;
  }

  private fixtureFile(path: string, relative: string): FixtureFile {
    const text = this.read(path);
    return relative.endsWith('.json') ? { path: relative, text, json: JSON.parse(text) } : { path: relative, text };
  }

  /** CRLF from a Windows checkout is normalized; the recorded tools print LF only. */
  private read(path: string): string {
    if (!existsSync(path)) throw new Error(`Fixture file ${path} does not exist`);
    return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
  }
}

const store = new FixtureStore();

/** Parsed `fixtures/kubectl/<scenario>/<file>.json`; `file` may name a capture (`completed/pods`). */
export function loadKubectlFixture<T = unknown>(scenario: string, file: string): T {
  return store.kubectl<T>(scenario, file);
}

/** Raw text of a kubectl fixture as the recorded command printed it (stdout of a `{fixture}` step). */
export function readKubectlFixture(scenario: string, file: string): string {
  return store.kubectlText(scenario, file);
}

export function loadKubectlList<T = unknown>(scenario: string, resource: CapturedResource, capture = ''): KubeList<T> {
  return store.list<T>(scenario, resource, capture);
}

export function loadKubectlResources<T = unknown>(scenario: string, resources: readonly CapturedResource[], capture = ''): KubeList<T> {
  return store.resources<T>(scenario, resources, capture);
}

export function readHelmFixture(scenario: string, file: string): string {
  return store.helmText(scenario, file);
}

export function loadHelmFixture<T = unknown>(scenario: string, file: string): T {
  return store.helmJson<T>(scenario, file);
}

/** Raw `kubectl get --raw /apis/metrics.k8s.io/...` body of `fixtures/metrics/<scenario>.json`. */
export function readMetricsFixture(scenario: string): string {
  return store.metricsText(scenario);
}

export function loadMetricsFixture<T = unknown>(scenario: string): T {
  return store.metrics<T>(scenario);
}

export function loadFixtureMeta(kind: FixtureKind, scenario: string): FixtureMeta {
  return store.meta(kind, scenario);
}
