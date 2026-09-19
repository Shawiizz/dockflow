// Executor invariants (design-07 3.9, DESIGN-CORE 8.9): the hygiene every backend, store, apply,
// runtime and setup test asserts in afterEach, each rule with its closed exception set (K66), plus
// assertNoSecretLeak (R-S6-08). The helper reads what the fakes recorded; it never re-runs a call.

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import { ANNOTATIONS, HELM_BIN_PATH, K8S_KUBECONFIG_PATH, LABELS, PARTS } from '../../../services/orchestrator/kubernetes/constants';
import type { K8sDistribution } from '../../../services/orchestrator/kubernetes/distribution';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { classifyKubectlFailure } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { HELM_ENV_PREFIX } from '../../../services/orchestrator/kubernetes/runtime/helm';
import {
  KUBECTL_FIELD_MANAGERS,
  KUBECTL_NAME_OUTPUT_RESOURCES,
} from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { parseManifests } from '../../../services/orchestrator/kubernetes/yaml';
import { Redactor } from '../../../utils/redact';
import type { RecordedHelmCall } from '../fakes/fake-helm-executor';
import type { RecordedKubeCall } from '../fakes/fake-kube-executor';
import { type NodeShellCall, shellTokens } from '../fakes/fake-node-shell';
import type { SshCall } from '../fakes/fake-ssh';
import { formatIssue, validateObject } from './schema/validate';

/**
 * The one go-template read INV-08 accepts (PD-7, design-03 K48): the release listing prints the
 * name, `P/release` and the base64 of `metadata.json`, so release payloads never leave the node.
 */
export const INV08_RELEASE_LIST_TEMPLATE = `go-template={{range .items}}{{.metadata.name}} {{index .metadata.annotations "${ANNOTATIONS.release}"}} {{index .data "metadata.json"}}{{"\\n"}}{{end}}`;

export type InvariantId =
  | 'INV-01'
  | 'INV-02'
  | 'INV-03'
  | 'INV-04'
  | 'INV-04b'
  | 'INV-05'
  | 'INV-06'
  | 'INV-07'
  | 'INV-08'
  | 'INV-09'
  | 'INV-10'
  | 'INV-11'
  | 'INV-12'
  | 'ASSERT-DONE';

export interface InvariantViolation {
  id: InvariantId;
  message: string;
}

// ---------------------------------------------------------------------------
// What the helper reads (structural, so later fakes plug in without an import)
// ---------------------------------------------------------------------------

export interface KubeRecorder {
  readonly node: ClusterNodeRef;
  readonly calls: readonly RecordedKubeCall[];
  readonly asserted: boolean;
  readonly redactor: Redactor;
  readonly distribution: K8sDistribution;
}

export interface HelmRecorder {
  readonly node: ClusterNodeRef;
  readonly calls: readonly RecordedHelmCall[];
  readonly asserted: boolean;
  readonly redactor: Redactor;
}

export interface NodeShellRecorder {
  readonly calls: readonly NodeShellCall[];
  readonly asserted: boolean;
  readonly redactor: Redactor;
}

export interface SshRecorder {
  readonly calls: readonly SshCall[];
  readonly asserted: boolean;
}

/** FakeHostRunner (design-07 3.12): stdin (`input`) is exempt from INV-02, it is where tokens travel */
export interface HostRunnerRecorder {
  readonly calls: readonly {
    readonly argv: readonly string[];
    readonly env?: Readonly<Record<string, string | undefined>>;
  }[];
  readonly asserted: boolean;
}

/** FakeSetupTransport (design-07 3.12): command strings are checked, stdin is exempt */
export interface SetupTransportRecorder {
  readonly calls: readonly { readonly command: string }[];
  readonly asserted: boolean;
}

/** end state of PersistentVolumes for INV-04b; FakeCluster can provide it */
export interface PersistentVolumeView {
  /** the PV's current reclaim policy, or null when it no longer exists */
  reclaimPolicyOf(name: string): string | null;
}

/** a captured string, or a bun spy on an output function (`printWarning`, `printDebug`, `printRaw`) */
export type PrintedSource = string | { readonly mock: { readonly calls: readonly (readonly unknown[])[] } };

type OneOrMany<T> = T | readonly T[];

export interface ExecutorInvariantOptions {
  kube?: OneOrMany<KubeRecorder>;
  helm?: OneOrMany<HelmRecorder>;
  nodeShell?: OneOrMany<NodeShellRecorder>;
  ssh?: OneOrMany<SshRecorder>;
  hostRunner?: OneOrMany<HostRunnerRecorder>;
  setupTransport?: OneOrMany<SetupTransportRecorder>;
  /** the test Redactor (INV-02); default: each executor fake's own */
  redactor?: Redactor;
  allow?: {
    /** only volumes tests, `stack.remove` with `volumes: 'delete'` and `helm uninstall --volumes` (INV-04) */
    volumeDeletion?: boolean;
    /** narrows the three Dockflow field managers (INV-06) */
    fieldManagers?: readonly string[];
  };
  /** output captured during the test (INV-11) */
  printed?: readonly PrintedSource[];
  /** files the test created, read at check time (INV-11) */
  writtenFiles?: readonly string[];
  /** INV-04b end state; without it, the calls must show each PV gone or restored */
  volumes?: PersistentVolumeView;
}

function many<T>(value: OneOrMany<T> | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

// ---------------------------------------------------------------------------
// kubectl argv
// ---------------------------------------------------------------------------

const KUBECTL_VALUE_FLAGS = new Set([
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
  '--patch-file',
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
  '--request-timeout',
  '--kubeconfig',
  '--raw',
  '--field-manager',
]);

const MUTATING_VERBS = new Set([
  'apply',
  'create',
  'replace',
  'delete',
  'scale',
  'patch',
  'label',
  'annotate',
  'cordon',
  'uncordon',
  'drain',
  'taint',
]);

const NAMESPACE_RESOURCES = new Set(['namespace', 'namespaces', 'ns']);
const CLAIM_RESOURCES = new Set(['persistentvolumeclaim', 'persistentvolumeclaims', 'pvc']);
const VOLUME_RESOURCES = new Set(['persistentvolume', 'persistentvolumes', 'pv']);
const POD_RESOURCES = new Set(['pod', 'pods', 'po']);

interface KubectlArgv {
  verb: string;
  /** positionals after the verb */
  positionals: string[];
  flags: Map<string, string[]>;
}

function parseKubectl(args: readonly string[]): KubectlArgv {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    flags.set(name, [...(flags.get(name) ?? []), value]);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // what follows belongs to the command run in the container
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        add(arg.slice(0, eq), arg.slice(eq + 1));
      } else if (KUBECTL_VALUE_FLAGS.has(arg)) {
        add(arg, args[i + 1] ?? '');
        i += 1;
      } else {
        add(arg, '');
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(0, 2);
      if (arg.length > 2) add(name, arg[2] === '=' ? arg.slice(3) : arg.slice(2));
      else if (KUBECTL_VALUE_FLAGS.has(name)) {
        add(name, args[i + 1] ?? '');
        i += 1;
      } else add(name, '');
    } else {
      positionals.push(arg);
    }
  }
  return { verb: positionals[0] ?? '', positionals: positionals.slice(1), flags };
}

function flagValue(argv: KubectlArgv, ...names: string[]): string | undefined {
  for (const name of names) {
    const values = argv.flags.get(name);
    if (values !== undefined) return values.at(-1);
  }
  return undefined;
}

function hasFlag(argv: KubectlArgv, name: string): boolean {
  return argv.flags.has(name);
}

function isMutatingVerb(argv: KubectlArgv): boolean {
  if (MUTATING_VERBS.has(argv.verb)) return true;
  return argv.verb === 'rollout' && (argv.positionals[0] === 'undo' || argv.positionals[0] === 'restart');
}

/** `persistentvolumeclaims.v1` or `Deployment.apps` -> the lowercase resource part */
function resourceName(text: string): string {
  return text.split('.')[0].toLowerCase();
}

interface ObjectTarget {
  resource: string;
  name: string | null;
  namespace: string | null;
}

/** `/api/v1/namespaces/<ns>/<resource>/<name>`, `/apis/<group>/<version>/...` */
function rawTarget(uri: string): ObjectTarget | null {
  const segments = uri.split('?')[0].split('/').filter((segment) => segment !== '');
  let rest: string[];
  if (segments[0] === 'api' && segments.length >= 2) rest = segments.slice(2);
  else if (segments[0] === 'apis' && segments.length >= 3) rest = segments.slice(3);
  else return null;
  if (rest[0] === 'namespaces' && rest.length >= 3) {
    return { resource: rest[2].toLowerCase(), name: rest[3] ?? null, namespace: rest[1] };
  }
  if (rest.length === 0) return null;
  return { resource: rest[0].toLowerCase(), name: rest[1] ?? null, namespace: null };
}

interface ManifestDocument {
  kind: string;
  name: string | null;
  namespace: string | null;
  labels: Record<string, string>;
  object: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') out[key] = entry;
  return out;
}

/** documents of a manifest stdin; [] when it is not YAML */
function manifestDocuments(text: string): ManifestDocument[] {
  if (text.trim() === '') return [];
  let objects: unknown[];
  try {
    objects = parseManifests(text);
  } catch {
    return [];
  }
  return objects.filter(isRecord).map((object) => {
    const metadata = isRecord(object.metadata) ? object.metadata : {};
    return {
      kind: typeof object.kind === 'string' ? object.kind : '',
      name: typeof metadata.name === 'string' ? metadata.name : null,
      namespace: typeof metadata.namespace === 'string' ? metadata.namespace : null,
      labels: stringRecord(metadata.labels),
      object,
    };
  });
}

/** every object a `delete` call names, whatever its form */
function deleteTargets(record: RecordedKubeCall, argv: KubectlArgv): ObjectTarget[] {
  const namespace = record.call.namespace ?? null;
  const raw = flagValue(argv, '--raw');
  if (raw !== undefined) {
    const target = rawTarget(raw);
    return target ? [target] : [{ resource: raw, name: null, namespace }];
  }
  if (flagValue(argv, '-f', '--filename') === '-') {
    return manifestDocuments(record.stdinText).map((doc) => ({
      resource: doc.kind.toLowerCase(),
      name: doc.name,
      namespace: doc.namespace ?? namespace,
    }));
  }
  const targets: ObjectTarget[] = [];
  const [first, ...rest] = argv.positionals;
  if (first === undefined) return targets;
  if (first.includes('/')) {
    for (const positional of argv.positionals) {
      const slash = positional.indexOf('/');
      targets.push({ resource: resourceName(positional.slice(0, slash)), name: positional.slice(slash + 1), namespace });
    }
    return targets;
  }
  for (const resource of first.split(',')) {
    const normalized = resourceName(resource);
    if (rest.length === 0) targets.push({ resource: normalized, name: null, namespace });
    for (const name of rest) targets.push({ resource: normalized, name, namespace });
  }
  return targets;
}

/** `patch pv/<n>`, `patch pv <n>`, `annotate pv/<n> k=v`: the PV names a call targets */
function patchedVolumes(argv: KubectlArgv): string[] {
  // `key=value` positionals of annotate/label are not objects
  const objects = argv.positionals.filter((positional) => !positional.includes('='));
  const [first] = objects;
  if (first === undefined) return [];
  if (first.includes('/')) {
    return objects.filter((p) => VOLUME_RESOURCES.has(resourceName(p.split('/')[0]))).map((p) => p.slice(p.indexOf('/') + 1));
  }
  return VOLUME_RESOURCES.has(resourceName(first)) ? objects.slice(1) : [];
}

const POLICY_KEY = 'persistentVolumeReclaimPolicy';

/** the reclaim policy a PV patch sets; undefined when the patch does not touch it */
function patchedPolicy(argv: KubectlArgv): string | undefined {
  const body = flagValue(argv, '-p', '--patch');
  if (body === undefined) return hasFlag(argv, '--patch-file') ? 'unknown' : undefined;
  if (!body.includes(POLICY_KEY)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch {
    return 'unknown';
  }
  if (Array.isArray(parsed)) {
    for (const op of parsed) {
      if (isRecord(op) && typeof op.path === 'string' && op.path.endsWith(`/${POLICY_KEY}`)) {
        return typeof op.value === 'string' ? op.value : 'unknown';
      }
    }
    return 'unknown';
  }
  if (isRecord(parsed) && isRecord(parsed.spec) && typeof parsed.spec[POLICY_KEY] === 'string') return parsed.spec[POLICY_KEY];
  return 'unknown';
}

/** the recorded original policy a patch or annotate call writes as `P/reclaim-policy-before` */
function recordedOriginal(argv: KubectlArgv): string | undefined {
  const key = ANNOTATIONS.reclaimPolicyBefore;
  if (argv.verb === 'annotate') {
    for (const positional of argv.positionals) {
      if (positional.startsWith(`${key}=`)) return positional.slice(key.length + 1);
    }
    return undefined;
  }
  const body = flagValue(argv, '-p', '--patch');
  if (body === undefined || !body.includes(key)) return undefined;
  try {
    const parsed: unknown = parseYaml(body);
    if (isRecord(parsed) && isRecord(parsed.metadata) && isRecord(parsed.metadata.annotations)) {
      const value = parsed.metadata.annotations[key];
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** names of the objects a successful `get` returned */
function returnedNames(stdout: string): string[] | null {
  const text = stdout.trim();
  if (text === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [parsed];
    return items.flatMap((item) => (isRecord(item) && isRecord(item.metadata) && typeof item.metadata.name === 'string' ? [item.metadata.name] : []));
  } catch {
    return null;
  }
}

function outputFormat(argv: KubectlArgv): string | undefined {
  return flagValue(argv, '-o', '--output');
}

// ---------------------------------------------------------------------------
// Command strings (FakeSsh, node-shell scripts, kubectl shell scripts)
// ---------------------------------------------------------------------------

interface ToolInvocation {
  tool: 'kubectl' | 'helm';
  args: string[];
}

/** the kubectl and helm invocations of a shell command string, global flags removed */
function invocations(command: string): ToolInvocation[] {
  let tokens: ReturnType<typeof shellTokens>;
  try {
    tokens = shellTokens(command);
  } catch {
    return [];
  }
  const found: ToolInvocation[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'word') continue;
    const base = token.value.split('/').pop() ?? '';
    const tool = base === 'kubectl' ? 'kubectl' : base === 'helm' ? 'helm' : null;
    if (tool === null) continue;
    const args: string[] = [];
    let j = i + 1;
    while (j < tokens.length && tokens[j].kind === 'word') {
      args.push(tokens[j].value);
      j += 1;
    }
    const cleaned: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const arg = args[k];
      if (arg.startsWith('--kubeconfig=') || arg.startsWith('--request-timeout=')) continue;
      if (tool === 'kubectl' && cleaned.length === 0 && (arg === '-n' || arg === '--namespace')) {
        k += 1;
        continue;
      }
      if (tool === 'kubectl' && cleaned.length === 0 && arg.startsWith('--namespace=')) continue;
      cleaned.push(arg);
    }
    found.push({ tool, args: cleaned });
    i = j - 1;
  }
  return found;
}

const HELM_MUTATING_VERBS = new Set(['install', 'upgrade', 'uninstall', 'rollback']);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HELM_PREFIXED = new RegExp(
  `${escapeRegExp(HELM_ENV_PREFIX)}(?: HELM_(?:REPOSITORY_CONFIG|REPOSITORY_CACHE|REGISTRY_CONFIG)=\\S+)* $`,
);

/** tokens after which a word is in command position */
const COMMAND_POSITION = new Set(['', ';', '&&', '||', '|', '(', '{', 'then', 'do', 'else', 'exec']);

/** INV-10: every kubectl invocation carries the Dockflow kubeconfig, every helm one the env prefix */
function unprefixedTools(text: string, kubectlCommands: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const command of kubectlCommands) {
    for (let at = text.indexOf(command); at !== -1; at = text.indexOf(command, at + 1)) {
      if (!text.startsWith(` --kubeconfig=${K8S_KUBECONFIG_PATH}`, at + command.length)) {
        problems.push(`${command} without --kubeconfig=${K8S_KUBECONFIG_PATH}`);
      }
    }
  }
  for (let at = text.indexOf(HELM_BIN_PATH); at !== -1; at = text.indexOf(HELM_BIN_PATH, at + 1)) {
    const before = text.slice(0, at);
    if (HELM_PREFIXED.test(before)) continue;
    const previous = before.trimEnd().split(/\s+/).at(-1) ?? '';
    // a path argument (`test -x`, `sha256sum`) is not an invocation
    if (COMMAND_POSITION.has(previous)) problems.push(`${HELM_BIN_PATH} without the helm environment prefix`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// INV-05 payload classification
// ---------------------------------------------------------------------------

const DELETE_OPTIONS_KEYS = new Set(['apiVersion', 'kind', 'preconditions', 'propagationPolicy', 'gracePeriodSeconds', 'dryRun', 'orphanDependents']);

function deleteOptionsIssues(object: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(object)) if (!DELETE_OPTIONS_KEYS.has(key)) issues.push(`unknown field ${key}`);
  if (object.preconditions !== undefined) {
    if (!isRecord(object.preconditions)) issues.push('preconditions is not an object');
    else {
      for (const [key, value] of Object.entries(object.preconditions)) {
        if (key !== 'uid' && key !== 'resourceVersion') issues.push(`unknown field preconditions.${key}`);
        else if (typeof value !== 'string') issues.push(`preconditions.${key} is not a string`);
      }
    }
  }
  if (object.propagationPolicy !== undefined && !['Orphan', 'Background', 'Foreground'].includes(String(object.propagationPolicy))) {
    issues.push(`propagationPolicy ${String(object.propagationPolicy)} is not Orphan, Background or Foreground`);
  }
  const grace = object.gracePeriodSeconds;
  if (grace !== undefined && !(typeof grace === 'number' && Number.isInteger(grace) && grace >= 0)) {
    issues.push('gracePeriodSeconds is not a non-negative integer');
  }
  if (object.dryRun !== undefined && !(Array.isArray(object.dryRun) && object.dryRun.every((v) => v === 'All'))) {
    issues.push('dryRun is not a list of All');
  }
  return issues;
}

function looksBinary(bytes: Uint8Array, text: string): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  // a NUL byte, or bytes that are not UTF-8 (decoded as the replacement character)
  return bytes.includes(0) || text.includes(String.fromCharCode(0xfffd));
}

/**
 * Schema problems of a stdin payload. `strict`: the call only takes manifests (apply, create,
 * replace, delete -f -), so anything else is a problem; otherwise (shell and channel streams) a
 * payload is a manifest only when its first document carries apiVersion and kind.
 */
function payloadProblems(bytes: Uint8Array, text: string, strict: boolean): string[] {
  if (text.trim() === '') return [];
  if (looksBinary(bytes, text)) return strict ? ['stdin is not a YAML manifest'] : [];
  let objects: unknown[];
  try {
    objects = parseManifests(text);
  } catch (error) {
    return strict ? [`stdin does not parse as manifests: ${error instanceof Error ? error.message : String(error)}`] : [];
  }
  const first = objects[0];
  if (!strict && !(isRecord(first) && typeof first.apiVersion === 'string' && typeof first.kind === 'string')) return [];
  if (strict && objects.length === 0) return ['stdin holds no manifest'];
  const problems: string[] = [];
  for (const object of objects) {
    if (isRecord(object) && object.apiVersion === 'v1' && object.kind === 'DeleteOptions') {
      problems.push(...deleteOptionsIssues(object).map((issue) => `DeleteOptions: ${issue}`));
      continue;
    }
    for (const found of validateObject(object)) {
      if (found.severity !== 'warning') problems.push(formatIssue(object, found));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function isScript(record: RecordedKubeCall): boolean {
  return record.method === 'shell' || record.method === 'channel' || record.method === 'interactive';
}

function describeKube(kube: KubeRecorder, record: RecordedKubeCall, index: number, redactor: Redactor): string {
  const where = record.call.namespace !== undefined ? ` -n ${record.call.namespace}` : '';
  const shown = isScript(record) ? record.commandString : record.call.args.join(' ');
  const refused = record.commandString === '' ? ' (refused by the command builder)' : '';
  return `kube[${kube.node.name}] call #${index} ${record.method}${where}: ${redactor.redact(shown).slice(0, 200)}${refused}`;
}

function succeeded(record: RecordedKubeCall): boolean {
  return record.result?.exitCode === 0;
}

interface VolumePatchState {
  original: string | null;
  open: boolean;
  /** where the Delete patch was issued */
  at: string;
}

class Checker {
  readonly violations: InvariantViolation[] = [];

  constructor(private readonly options: ExecutorInvariantOptions) {}

  add(id: InvariantId, message: string): void {
    this.violations.push({ id, message });
  }

  run(): InvariantViolation[] {
    const kubes = many(this.options.kube);
    const kubectlCommands = new Set([k3sDistribution.kubectlCommand, ...kubes.map((kube) => kube.distribution.kubectlCommand)]);
    for (const kube of kubes) this.kube(kube, kubectlCommands);
    for (const helm of many(this.options.helm)) this.helm(helm);
    for (const shell of many(this.options.nodeShell)) this.nodeShell(shell, kubectlCommands);
    for (const ssh of many(this.options.ssh)) this.ssh(ssh, kubectlCommands);
    for (const runner of many(this.options.hostRunner)) this.hostRunner(runner);
    for (const transport of many(this.options.setupTransport)) this.setupTransport(transport);
    this.output();
    return this.violations;
  }

  /** the test Redactor, else the fake's own; the SSH and setup recorders have none of their own */
  private redactorFor(own: Redactor): Redactor;
  private redactorFor(): Redactor | null;
  private redactorFor(own?: Redactor): Redactor | null {
    return this.options.redactor ?? own ?? null;
  }

  /** INV-02 on one piece of text that must never carry a registered secret */
  private secretFree(redactor: Redactor | null, text: string, where: string): void {
    if (redactor === null || text === '') return;
    if (redactor.redact(text) !== text) this.add('INV-02', `${where} contains a registered secret: ${redactor.redact(text).slice(0, 200)}`);
  }

  private notAsserted(kind: string, asserted: boolean): void {
    if (!asserted) this.add('ASSERT-DONE', `a ${kind} was constructed but never asserted with assertDone()`);
  }

  // ---- kubectl --------------------------------------------------------------------------------

  private kube(kube: KubeRecorder, kubectlCommands: ReadonlySet<string>): void {
    this.notAsserted(`FakeKubeExecutor on ${kube.node.name}`, kube.asserted);
    const redactor = this.redactorFor(kube.redactor);
    const helpers = new Map<string, string>();
    const volumes = new Map<string, VolumePatchState>();
    const observedPolicy = new Map<string, string>();
    kube.calls.forEach((record, index) => {
      const where = describeKube(kube, record, index, redactor);
      this.secretFree(redactor, `${record.commandString} ${record.call.args.join(' ')} ${record.call.namespace ?? ''}`, where);
      if (isScript(record)) {
        for (const problem of unprefixedTools(record.commandString, kubectlCommands)) this.add('INV-10', `${where}: ${problem}`);
        // tar, gzip and dumps travel on these channels: only a payload that is a manifest is validated
        for (const problem of payloadProblems(record.stdinBytes, record.stdinText, false)) this.add('INV-05', `${where}: ${problem}`);
        return;
      }
      if (record.commandString !== '' && !record.commandString.includes(`--kubeconfig=${K8S_KUBECONFIG_PATH}`)) {
        this.add('INV-10', `${where}: the command string lacks --kubeconfig=${K8S_KUBECONFIG_PATH}`);
      }
      const argv = parseKubectl(record.call.args);
      if (record.method !== 'command' && isMutatingVerb(argv) && !record.call.mutating) {
        this.add('INV-01', `${where}: ${argv.verb} is flagged mutating: false`);
      }
      this.apply(argv, where);
      this.get(argv, where);
      const stdinManifest = flagValue(argv, '-f', '--filename') === '-';
      if (record.stdinText.trim() !== '' && record.method !== 'command') {
        for (const problem of payloadProblems(record.stdinBytes, record.stdinText, stdinManifest || argv.verb === 'apply')) {
          this.add('INV-05', `${where}: ${problem}`);
        }
      }
      if (argv.verb === 'delete') this.deletion(record, argv, where, helpers, volumes);
      if (argv.verb === 'patch' || argv.verb === 'annotate' || argv.verb === 'apply' || argv.verb === 'replace') {
        this.volumePolicy(record, argv, where, volumes, observedPolicy);
      }
      if (record.method !== 'command') this.observeVolumes(record, argv, volumes, observedPolicy);
      if ((argv.verb === 'create' || argv.verb === 'apply') && record.method !== 'command' && succeeded(record)) {
        this.helperCreated(record, where, helpers);
      }
    });
    for (const [pod, where] of helpers) this.add('INV-12', `helper pod ${pod} created by ${where} was never deleted`);
    this.volumesAtEnd(volumes);
  }

  private apply(argv: KubectlArgv, where: string): void {
    if (argv.verb !== 'apply') return;
    const allowed = (this.options.allow?.fieldManagers ?? KUBECTL_FIELD_MANAGERS).filter((m) => KUBECTL_FIELD_MANAGERS.includes(m));
    const serverSide = argv.flags.get('--server-side');
    if (serverSide === undefined || !serverSide.every((value) => value === '' || value === 'true')) {
      this.add('INV-06', `${where}: apply without --server-side`);
    }
    if (!hasFlag(argv, '--force-conflicts')) this.add('INV-06', `${where}: apply without --force-conflicts`);
    const managers = argv.flags.get('--field-manager') ?? [];
    if (managers.length !== 1 || !allowed.includes(managers[0])) {
      this.add('INV-06', `${where}: field manager ${managers.join(', ') || '(none)'} is not one of ${allowed.join(', ')}`);
    }
    const dryRun = argv.flags.get('--dry-run');
    if (dryRun !== undefined && !dryRun.every((value) => value === 'server')) {
      this.add('INV-06', `${where}: --dry-run=${dryRun.join(',')} (only --dry-run=server)`);
    }
  }

  private get(argv: KubectlArgv, where: string): void {
    if (argv.verb === 'api-resources') {
      if (outputFormat(argv) !== 'name') this.add('INV-08', `${where}: api-resources without -o name`);
      return;
    }
    if (argv.verb !== 'get') return;
    const format = outputFormat(argv);
    if (hasFlag(argv, '--raw')) {
      if (format !== undefined) this.add('INV-08', `${where}: get --raw carries -o ${format}`);
      return;
    }
    if (format === 'json') return;
    const resources = (argv.positionals[0] ?? '').split(',');
    if (format === 'name') {
      if (!resources.every((resource) => KUBECTL_NAME_OUTPUT_RESOURCES.includes(resource))) {
        this.add('INV-08', `${where}: -o name is only allowed for secrets, configmaps and customresourcedefinitions`);
      }
      return;
    }
    if (format === INV08_RELEASE_LIST_TEMPLATE && argv.positionals[0] === 'secrets') return;
    this.add('INV-08', `${where}: get without -o json (${format === undefined ? 'no -o' : `-o ${format.split('=')[0]}`})`);
  }

  private deletion(
    record: RecordedKubeCall,
    argv: KubectlArgv,
    where: string,
    helpers: Map<string, string>,
    volumes: Map<string, VolumePatchState>,
  ): void {
    const targets = deleteTargets(record, argv);
    for (const target of targets) {
      const resource = target.resource;
      // structural: `--raw=/apis/coordination.k8s.io/v1/namespaces/<ns>/leases/<n>` deletes a Lease
      if (NAMESPACE_RESOURCES.has(resource)) {
        this.add('INV-03', `${where}: deletes a Namespace${target.name ? ` (${target.name})` : ''}`);
      }
      if ((CLAIM_RESOURCES.has(resource) || VOLUME_RESOURCES.has(resource)) && !this.options.allow?.volumeDeletion) {
        this.add('INV-04', `${where}: deletes ${resource}${target.name ? `/${target.name}` : ''} without allow.volumeDeletion`);
      }
    }
    if (record.method === 'command' || !succeeded(record)) return;
    for (const target of targets) {
      if (VOLUME_RESOURCES.has(target.resource) && target.name !== null) {
        const state = volumes.get(target.name);
        if (state) state.open = false;
      }
      if (!POD_RESOURCES.has(target.resource)) continue;
      const namespace = target.namespace ?? 'default';
      if (target.name !== null) helpers.delete(`${namespace}/${target.name}`);
    }
    const selector = flagValue(argv, '-l', '--selector');
    const podsOnly = targets.length > 0 && targets.every((target) => POD_RESOURCES.has(target.resource) && target.name === null);
    if (selector !== undefined && podsOnly && selector.split(',').includes(`${LABELS.part}=${PARTS.helper}`)) {
      const namespace = record.call.namespace ?? 'default';
      for (const key of [...helpers.keys()]) if (key.startsWith(`${namespace}/`)) helpers.delete(key);
    }
  }

  private helperCreated(record: RecordedKubeCall, where: string, helpers: Map<string, string>): void {
    for (const doc of manifestDocuments(record.stdinText)) {
      if (doc.kind !== 'Pod' || doc.labels[LABELS.part] !== PARTS.helper) continue;
      let name = doc.name;
      if (name === null) {
        const created = returnedNames(record.result?.stdout ?? '');
        name = created?.[0] ?? null;
      }
      if (name === null) continue;
      helpers.set(`${doc.namespace ?? record.call.namespace ?? 'default'}/${name}`, where);
    }
  }

  private volumePolicy(
    record: RecordedKubeCall,
    argv: KubectlArgv,
    where: string,
    volumes: Map<string, VolumePatchState>,
    observedPolicy: Map<string, string>,
  ): void {
    const writes: { volume: string; policy: string }[] = [];
    if (argv.verb === 'patch') {
      const original = recordedOriginal(argv);
      for (const volume of patchedVolumes(argv)) {
        if (original !== undefined && !observedPolicy.has(volume)) observedPolicy.set(volume, original);
        const policy = patchedPolicy(argv);
        if (policy !== undefined) writes.push({ volume, policy });
      }
    } else if (argv.verb === 'annotate') {
      const original = recordedOriginal(argv);
      const volumesAnnotated = patchedVolumes(argv);
      if (original !== undefined) for (const volume of volumesAnnotated) if (!observedPolicy.has(volume)) observedPolicy.set(volume, original);
    } else {
      for (const doc of manifestDocuments(record.stdinText)) {
        if (doc.kind !== 'PersistentVolume' || doc.name === null) continue;
        const spec = isRecord(doc.object.spec) ? doc.object.spec : {};
        if (typeof spec[POLICY_KEY] === 'string') writes.push({ volume: doc.name, policy: spec[POLICY_KEY] });
      }
    }
    if (writes.length === 0) return;
    if (!this.options.allow?.volumeDeletion) {
      for (const write of writes) this.add('INV-04', `${where}: sets ${POLICY_KEY} of PV ${write.volume} without allow.volumeDeletion`);
      return;
    }
    if (record.method === 'command' || !succeeded(record)) return;
    for (const write of writes) {
      const state = volumes.get(write.volume);
      if (write.policy === 'Delete') {
        const others = [...volumes.entries()].filter(([name, s]) => s.open && name !== write.volume).map(([name]) => name);
        if (others.length > 0) {
          this.add('INV-04b', `${where}: PV ${write.volume} patched to Delete while ${others.join(', ')} still is (one volume at a time)`);
        }
        volumes.set(write.volume, { original: observedPolicy.get(write.volume) ?? state?.original ?? null, open: true, at: where });
        continue;
      }
      if (state === undefined) continue;
      if (state.original !== null && write.policy !== state.original) {
        this.add('INV-04b', `${where}: PV ${write.volume} restored to ${write.policy}, its recorded policy was ${state.original}`);
      }
      state.open = false;
    }
  }

  /** policy observations before a patch, and "the PV is gone" observations after one */
  private observeVolumes(
    record: RecordedKubeCall,
    argv: KubectlArgv,
    volumes: Map<string, VolumePatchState>,
    observedPolicy: Map<string, string>,
  ): void {
    const resources = (argv.positionals[0] ?? '').split(',').map(resourceName);
    if (argv.verb === 'get' && resources.some((resource) => VOLUME_RESOURCES.has(resource))) {
      const named = argv.positionals.slice(1);
      if (succeeded(record)) {
        const stdout = record.result?.stdout ?? '';
        try {
          const parsed: unknown = stdout.trim() === '' ? { items: [] } : JSON.parse(stdout);
          const items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [parsed];
          for (const item of items) {
            if (!isRecord(item) || !isRecord(item.metadata) || typeof item.metadata.name !== 'string') continue;
            const spec = isRecord(item.spec) ? item.spec : {};
            const annotations = stringRecord(item.metadata.annotations);
            const recorded = annotations[ANNOTATIONS.reclaimPolicyBefore] ?? (typeof spec[POLICY_KEY] === 'string' ? spec[POLICY_KEY] : undefined);
            if (recorded !== undefined && !volumes.get(item.metadata.name)?.open && !observedPolicy.has(item.metadata.name)) {
              observedPolicy.set(item.metadata.name, recorded);
            }
          }
          const returned = returnedNames(stdout) ?? [];
          for (const name of named) {
            const state = volumes.get(name);
            if (state?.open && !returned.includes(name)) state.open = false;
          }
        } catch {
          // not JSON: nothing observed
        }
      } else if (record.result !== undefined && classifyKubectlFailure(record.result.exitCode, record.result.stderr) === 'NotFound') {
        for (const name of named) {
          const state = volumes.get(name);
          if (state) state.open = false;
        }
      }
    }
    if (argv.verb === 'wait' && flagValue(argv, '--for') === 'delete' && succeeded(record)) {
      for (const positional of argv.positionals) {
        const [resource, name] = positional.split('/');
        const state = name === undefined ? undefined : volumes.get(name);
        if (state && VOLUME_RESOURCES.has(resourceName(resource))) state.open = false;
      }
    }
  }

  private volumesAtEnd(volumes: Map<string, VolumePatchState>): void {
    const view = this.options.volumes;
    for (const [name, state] of volumes) {
      if (view) {
        const policy = view.reclaimPolicyOf(name);
        if (policy === null) continue;
        if (policy === 'Delete' || (state.original !== null && policy !== state.original)) {
          this.add('INV-04b', `PV ${name} (patched by ${state.at}) still exists with policy ${policy}${state.original ? `, recorded ${state.original}` : ''}`);
        }
        continue;
      }
      if (state.open) {
        this.add('INV-04b', `PV ${name} was patched to Delete by ${state.at} and was neither seen gone nor restored`);
      }
    }
  }

  // ---- helm -----------------------------------------------------------------------------------

  private helm(helm: HelmRecorder): void {
    this.notAsserted(`FakeHelmExecutor on ${helm.node.name}`, helm.asserted);
    const redactor = this.redactorFor(helm.redactor);
    helm.calls.forEach((record, index) => {
      const where = `helm[${helm.node.name}] call #${index}: ${redactor.redact(record.args.join(' ')).slice(0, 200)}`;
      const env = Object.values(record.env).filter((value): value is string => typeof value === 'string');
      this.secretFree(redactor, [record.commandString, ...record.args, ...env].join(' '), where);
      if (record.commandString !== '' && !record.commandString.startsWith(HELM_ENV_PREFIX)) {
        this.add('INV-10', `${where}: the command string does not start with the helm environment prefix`);
      }
      this.helmArgs(record.args, record.stdin, where);
    });
  }

  private helmArgs(args: readonly string[], stdin: string, where: string): void {
    for (const arg of args) {
      if (/^--(?:set|set-string|set-file|set-json|set-literal)(?:=|$)/.test(arg)) this.add('INV-09', `${where}: ${arg.split('=')[0]} in argv`);
      if (/^--password(?:=|$)/.test(arg)) this.add('INV-09', `${where}: --password in argv (use --password-stdin)`);
    }
    const verb = args[0];
    if (verb !== 'upgrade' && verb !== 'install' && verb !== 'template') return;
    const sources: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--values' || arg === '-f') sources.push(args[i + 1] ?? '');
      else if (arg.startsWith('--values=')) sources.push(arg.slice('--values='.length));
    }
    for (const source of sources) if (source !== '-') this.add('INV-09', `${where}: values read from ${source} instead of --values -`);
    if (stdin.trim() !== '' && !sources.includes('-')) this.add('INV-09', `${where}: values on stdin without --values -`);
  }

  // ---- node shell, SSH, setup ------------------------------------------------------------------

  private nodeShell(shell: NodeShellRecorder, kubectlCommands: ReadonlySet<string>): void {
    this.notAsserted('FakeNodeShell', shell.asserted);
    const redactor = this.redactorFor(shell.redactor);
    shell.calls.forEach((call, index) => {
      const where = `nodeShell[${call.node}] call #${index} ${call.kind}: ${redactor.redact(call.script).slice(0, 200)}`;
      this.secretFree(redactor, call.script, where);
      for (const problem of unprefixedTools(call.script, kubectlCommands)) this.add('INV-10', `${where}: ${problem}`);
      const text = Buffer.from(call.stdin).toString('utf8');
      for (const problem of payloadProblems(call.stdin, text, false)) this.add('INV-05', `${where}: ${problem}`);
    });
  }

  private ssh(ssh: SshRecorder, kubectlCommands: ReadonlySet<string>): void {
    this.notAsserted('FakeSsh', ssh.asserted);
    const redactor = this.redactorFor();
    ssh.calls.forEach((call, index) => {
      const shown = redactor ? redactor.redact(call.command) : call.command;
      const where = `ssh[${call.node}] call #${index} ${call.path} (attempt ${call.attempt}): ${shown.slice(0, 200)}`;
      this.secretFree(redactor, call.command, where);
      if (call.attempt > 1 && call.path !== 'exec') this.add('INV-07', `${where}: retried on the ${call.path} path`);
      for (const problem of unprefixedTools(call.command, kubectlCommands)) this.add('INV-10', `${where}: ${problem}`);
      const found = invocations(call.command);
      for (const invocation of found) {
        if (invocation.tool === 'kubectl') {
          const argv = parseKubectl(invocation.args);
          if (isMutatingVerb(argv) && call.path !== 'channel') this.add('INV-07', `${where}: mutating kubectl ${argv.verb} not sent on a channel`);
        } else {
          if (HELM_MUTATING_VERBS.has(invocation.args[0] ?? '') && call.path !== 'channel') {
            this.add('INV-07', `${where}: mutating helm ${invocation.args[0]} not sent on a channel`);
          }
          this.helmArgs(invocation.args, Buffer.from(call.stdin).toString('utf8'), where);
        }
      }
      // helm values are not manifests
      if (!found.some((invocation) => invocation.tool === 'helm')) {
        const text = Buffer.from(call.stdin).toString('utf8');
        for (const problem of payloadProblems(call.stdin, text, false)) this.add('INV-05', `${where}: ${problem}`);
      }
    });
  }

  private hostRunner(runner: HostRunnerRecorder): void {
    this.notAsserted('FakeHostRunner', runner.asserted);
    const redactor = this.redactorFor();
    runner.calls.forEach((call, index) => {
      const env = Object.entries(call.env ?? {}).map(([key, value]) => `${key}=${value ?? ''}`);
      this.secretFree(redactor, [...call.argv, ...env].join(' '), `hostRunner call #${index} (argv or env)`);
    });
  }

  private setupTransport(transport: SetupTransportRecorder): void {
    this.notAsserted('FakeSetupTransport', transport.asserted);
    const redactor = this.redactorFor();
    transport.calls.forEach((call, index) => this.secretFree(redactor, call.command, `setupTransport call #${index}`));
  }

  // ---- INV-11 ---------------------------------------------------------------------------------

  private output(): void {
    const printed = [...(this.options.printed ?? []).flatMap(printedTexts), ...(this.options.writtenFiles ?? []).flatMap(fileText)];
    if (printed.length === 0) return;
    const outputs: { where: string; stdout: string }[] = [];
    for (const kube of many(this.options.kube)) {
      kube.calls.forEach((record, index) => {
        if (record.result?.stdout) outputs.push({ where: `kube[${kube.node.name}] call #${index}`, stdout: record.result.stdout });
      });
    }
    for (const helm of many(this.options.helm)) {
      helm.calls.forEach((record, index) => {
        if (record.result?.stdout) outputs.push({ where: `helm[${helm.node.name}] call #${index}`, stdout: record.result.stdout });
      });
    }
    for (const shell of many(this.options.nodeShell)) {
      shell.calls.forEach((call, index) => {
        if (call.result?.stdout) outputs.push({ where: `nodeShell[${call.node}] call #${index}`, stdout: call.result.stdout });
      });
    }
    for (const { where, stdout } of outputs) {
      const leaked = stdoutFragments(stdout).find((fragment) => printed.some((text) => text.includes(fragment)));
      if (leaked !== undefined) this.add('INV-11', `the stdout of ${where} reached printed output or a file: ${leaked.slice(0, 80)}`);
    }
  }
}

/**
 * The whole stdout, and its longer lines: short fragments (`ok`, `{`) would match any output.
 */
function stdoutFragments(stdout: string): string[] {
  const whole = stdout.trim();
  const fragments = whole.length >= 6 ? [whole] : [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length >= 24 && trimmed !== whole) fragments.push(trimmed);
  }
  return fragments;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function printedTexts(source: PrintedSource): string[] {
  if (typeof source === 'string') return [source];
  return source.mock.calls.flatMap((args) => args.map(textOf));
}

function fileText(path: string): string[] {
  return existsSync(path) ? [readFileSync(path, 'utf8')] : [];
}

/** every violation, without throwing (the fakes tests read them by id) */
export function checkExecutorInvariants(options: ExecutorInvariantOptions): InvariantViolation[] {
  return new Checker(options).run();
}

/** afterEach of every backend, store, apply, runtime and setup test file (design-07 3.9) */
export function assertExecutorInvariants(options: ExecutorInvariantOptions): void {
  const violations = checkExecutorInvariants(options);
  if (violations.length === 0) return;
  throw new Error(`Executor invariants violated:\n${violations.map((v) => `  ${v.id} ${v.message}`).join('\n')}`);
}

// ---------------------------------------------------------------------------
// assertNoSecretLeak (R-S6-08)
// ---------------------------------------------------------------------------

/** keys of recorded fake calls that carry stdin or command output: where secrets are supposed to travel */
const RECORDER_EXEMPT_KEYS = new Set(['stdin', 'stdinText', 'stdinBytes', 'input', 'result']);

function isSpy(value: unknown): value is { mock: { calls: readonly (readonly unknown[])[] } } {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !('mock' in value)) return false;
  const mock = (value as { mock: unknown }).mock;
  return isRecord(mock) && Array.isArray(mock.calls);
}

function isFakeRecorder(value: unknown): value is { calls: readonly unknown[] } {
  return isRecord(value) && Array.isArray(value.calls) && ('asserted' in value || 'redactor' in value);
}

class LeakScanner {
  readonly found: string[] = [];
  private readonly seen = new WeakSet<object>();

  constructor(private readonly redactor: Redactor) {}

  scan(value: unknown, path: string, exempt: boolean): void {
    if (typeof value === 'string') {
      if (this.redactor.redact(value) !== value) this.found.push(`${path}: ${this.redactor.redact(value).slice(0, 160)}`);
      return;
    }
    if (value instanceof Uint8Array) {
      this.scan(Buffer.from(value).toString('utf8'), path, exempt);
      return;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (this.seen.has(value)) return;
    this.seen.add(value);
    if (isSpy(value)) {
      value.mock.calls.forEach((args, i) => this.scan(args, `${path}.mock.calls[${i}]`, exempt));
      return;
    }
    if (typeof value === 'function') return;
    if (isFakeRecorder(value) && !exempt) {
      value.calls.forEach((call, i) => this.scan(call, `${path}.calls[${i}]`, true));
      return;
    }
    if (value instanceof Error) {
      this.scan(value.message, `${path}.message`, exempt);
      if (value.cause !== undefined) this.scan(value.cause, `${path}.cause`, exempt);
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => this.scan(item, `${path}[${i}]`, exempt));
      return;
    }
    if (value instanceof Map) {
      for (const [key, item] of value) {
        this.scan(key, `${path}<key>`, exempt);
        this.scan(item, `${path}.get(${String(key)})`, exempt);
      }
      return;
    }
    if (value instanceof Set) {
      for (const item of value) this.scan(item, `${path}<item>`, exempt);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (exempt && RECORDER_EXEMPT_KEYS.has(key)) continue;
      this.scan(key, `${path}<key ${key.slice(0, 20)}>`, exempt);
      this.scan(item, `${path}.${key}`, exempt);
    }
  }
}

/**
 * Fails when a secret (plain, base64 or URL-encoded) appears in printed output, an error, a plain
 * object such as a serialized SetupReport, or the argv/env/command strings a fake recorded (a
 * fake's stdin and command output are exempt: that is where secrets are supposed to travel).
 */
export function assertNoSecretLeak(recorder: unknown, secrets: Iterable<string> | Redactor): void {
  let redactor: Redactor;
  if (secrets instanceof Redactor) {
    redactor = secrets;
  } else {
    const values = [...secrets];
    if (values.length === 0) throw new Error('assertNoSecretLeak needs at least one secret');
    const short = values.filter((value) => value.length < 6);
    // the Redactor ignores such values, so the check would pass vacuously
    if (short.length > 0) throw new Error(`assertNoSecretLeak needs secrets of at least 6 characters (${short.length} shorter)`);
    redactor = new Redactor(values);
  }
  const scanner = new LeakScanner(redactor);
  scanner.scan(recorder, '$', false);
  if (scanner.found.length > 0) {
    throw new Error(`Secret leaked in ${scanner.found.length} place(s):\n${scanner.found.map((line) => `  ${line}`).join('\n')}`);
  }
}
