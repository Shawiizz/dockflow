// FakeHelmExecutor (design-07 3.5, PD-3): the HelmExecutor under the real HelmBackend, which is never
// faked. It models releases and their revisions (labels, not annotations: the skip predicate reads
// the `P/spec-hash` release label), chart pulls into the control-plane node's file system shared with
// FakeNodeShell, installs from local archives only (cross-cutting rule 15), `--rollback-on-failure`,
// history trimming, credentials, and counts `status -o json` calls, which Dockflow never issues.
// Script steps answer before the model, for recorded outputs and failures.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import { HELM_CHARTS_DIR, K8S_REQUEST_TIMEOUT_S } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { classifyKubectlFailure, KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  type HelmCall,
  type HelmEnvOverrides,
  type HelmExecutor,
  type HelmResult,
  helmCommand,
} from '../../../services/orchestrator/kubernetes/runtime/helm';
import { firstLine } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { HELM_PIN } from '../../../services/orchestrator/kubernetes/versions';
import type { Redactor } from '../../../utils/redact';
import { readHelmFixture, splitFixtureRef } from '../support/kubectl-fixtures';
import { FAKE_CLOCK_START } from './fake-clock';
import { type ArgMatcher, fakeNode, matchArgs, renderArgs } from './fake-kube-executor';
import { FakeNodeFs, type FakeNodeShell, turn } from './fake-node-shell';

/** where the deploy path keeps verified chart archives (design-04 3.5.3, PD-9) */
export function chartCachePath(sha256: string): string {
  return `${HELM_CHARTS_DIR}/sha256-${sha256}.tgz`;
}

export interface FakeHelmChart {
  name: string;
  version: string;
  appVersion?: string | null;
  /** archive bytes; default: deterministic bytes naming the chart and version */
  bytes?: string | Uint8Array;
  /** `helm get manifest` of releases installed from this archive */
  manifest?: string;
  /** `helm show crds` of this archive */
  crds?: string;
  /** repository URL a `pull --repo` must name; default: any */
  repo?: string;
  /** `oci://` reference without tag a pull must name; default: any */
  oci?: string;
}

interface ChartEntry {
  name: string;
  version: string;
  appVersion: string | null;
  bytes: Uint8Array;
  sha256: string;
  manifest: string;
  crds: string;
  repo: string | null;
  oci: string | null;
}

export interface FakeHelmRevision {
  revision: number;
  chart: string;
  version: string;
  appVersion: string | null;
  /** user-supplied values; null when none were given */
  values: Record<string, unknown> | null;
  status: string;
  /** RFC 3339 */
  updated: string;
  description: string;
  /** release labels given with `--labels` (PD-3: the spec hash is one); Helm's storage labels are added by storageSecrets() */
  labels: Record<string, string>;
  manifest: string;
}

export class FakeHelmRelease {
  /** never written: PD-3 keeps checksums out of Helm storage; a test may assert it stays empty */
  readonly annotations: Record<string, string> = {};
  readonly revisions: FakeHelmRevision[] = [];

  constructor(
    readonly name: string,
    readonly namespace: string,
  ) {}

  get latest(): FakeHelmRevision | null {
    return this.revisions.at(-1) ?? null;
  }

  /** labels of the latest revision */
  get labels(): Record<string, string> {
    return { ...(this.latest?.labels ?? {}) };
  }

  get deployed(): FakeHelmRevision | null {
    return [...this.revisions].reverse().find((revision) => revision.status === 'deployed') ?? null;
  }

  revision(number: number): FakeHelmRevision | null {
    return this.revisions.find((revision) => revision.revision === number) ?? null;
  }
}

export type HelmStepRespond =
  | HelmResult
  | ((call: HelmCall) => HelmResult | Promise<HelmResult>)
  /** `<scenario>/<file>` of fixtures/helm, as stdout (exit 0) or as stderr (exit 1 unless given) */
  | { fixture: string; as?: 'stdout' | 'stderr'; exitCode?: number };

export interface HelmStep {
  id?: string;
  /** full argv, `-o json` included for json() calls */
  args: ArgMatcher[];
  respond: HelmStepRespond;
  /** default 1 */
  times?: number | 'any';
  optional?: boolean;
}

export interface RecordedHelmCall {
  args: string[];
  stdin: string;
  env: HelmEnvOverrides;
  mutating: boolean;
  timeoutS: number;
  allowFailure: boolean;
  /** built with the real helmCommand of runtime/helm.ts ('' when its local guard refused the call) */
  commandString: string;
  /** script step label, or 'model' */
  step?: string;
  /** what the call answered (stderr redacted) */
  result?: HelmResult;
}

export interface HelmCredentialRecord {
  kind: 'registry-login' | 'repo-update';
  env: HelmEnvOverrides;
  host?: string;
  username?: string;
  /** what arrived on stdin (`--password-stdin`) */
  passwordStdin?: string;
}

export interface FakeHelmExecutorOptions {
  redactor: Redactor;
  /** default fakeNode('server_1') */
  node?: ClusterNodeRef;
  /** shares that node's file system (pulled archives, cache, temp files) */
  nodeShell?: FakeNodeShell;
  /** used when no nodeShell is given */
  fs?: FakeNodeFs;
  /** timestamps of revisions; default: a counter from 2026-01-01 */
  clock?: Clock;
  script?: HelmStep[];
}

// ---------------------------------------------------------------------------
// Label selectors (the subset Helm and kubectl accept)
// ---------------------------------------------------------------------------

function splitRequirements(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of selector) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function requirementHolds(requirement: string, labels: Readonly<Record<string, string>>): boolean {
  const set = /^(\S+)\s+(in|notin)\s*\(([^)]*)\)$/.exec(requirement);
  if (set) {
    const values = set[3].split(',').map((value) => value.trim());
    const has = Object.hasOwn(labels, set[1]) && values.includes(labels[set[1]]);
    return set[2] === 'in' ? has : !has;
  }
  const compare = /^([^=!\s]+)\s*(==|=|!=)\s*(.*)$/.exec(requirement);
  if (compare) {
    const present = Object.hasOwn(labels, compare[1]);
    return compare[2] === '!=' ? !present || labels[compare[1]] !== compare[3] : present && labels[compare[1]] === compare[3];
  }
  const exists = /^(!?)(\S+)$/.exec(requirement);
  if (exists) return exists[1] === '!' ? !Object.hasOwn(labels, exists[2]) : Object.hasOwn(labels, exists[2]);
  throw new Error(`Unsupported label selector requirement: ${requirement}`);
}

/** `k=v`, `k==v`, `k!=v`, `k in (a,b)`, `k notin (a,b)`, `k`, `!k`, comma-joined */
export function labelSelectorMatches(selector: string, labels: Readonly<Record<string, string>>): boolean {
  return splitRequirements(selector).every((requirement) => requirementHolds(requirement, labels));
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '--version',
  '--repo',
  '--destination',
  '-d',
  '--labels',
  '-l',
  '--selector',
  '--history-max',
  '--timeout',
  '--description',
  '--values',
  '-f',
  '--filter',
  '--max',
  '--revision',
  '--username',
  '-o',
  '--output',
  '--cascade',
  '--kube-context',
]);

const LIST_STATES: Readonly<Record<string, string[]>> = {
  '--deployed': ['deployed'],
  '--failed': ['failed'],
  '--pending': ['pending-install', 'pending-upgrade', 'pending-rollback'],
  '--superseded': ['superseded'],
  '--uninstalled': ['uninstalled'],
  '--uninstalling': ['uninstalling'],
};

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      flags.set(arg.slice(0, eq), arg.slice(eq + 1));
    } else if (VALUE_FLAGS.has(arg)) {
      flags.set(arg, args[i + 1] ?? '');
      i += 1;
    } else {
      flags.set(arg, 'true');
    }
  }
  return { positionals, flags };
}

function flag(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseLabels(text: string | undefined): Record<string, string> | null {
  if (text === undefined) return null;
  const labels: Record<string, string> = {};
  for (const pair of text.split(',')) {
    if (pair.trim() === '') continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`helm --labels entry ${pair} is not key=value`);
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

function goTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000000 +0000 UTC`;
}

function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, 'Z');
}

function detailOf(stderr: string): string {
  return stderr.trim().replace(/^Error: /, '');
}

interface Raw {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function ok(stdout = ''): Raw {
  return { exitCode: 0, stdout, stderr: '' };
}

function failed(stderr: string): Raw {
  return { exitCode: 1, stdout: '', stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n` };
}

function describeArgs(args: readonly string[]): string {
  const [first, second] = args;
  return (first === 'get' || first === 'registry' || first === 'repo') && second !== undefined ? `${first} ${second}` : (first ?? '');
}

interface StepState {
  step: HelmStep;
  index: number;
  used: number;
}

function stepLabel(state: StepState): string {
  return state.step.id ?? `#${state.index}`;
}

// ---------------------------------------------------------------------------
// FakeHelmExecutor
// ---------------------------------------------------------------------------

export class FakeHelmExecutor implements HelmExecutor {
  readonly node: ClusterNodeRef;
  readonly calls: RecordedHelmCall[] = [];
  readonly credentials: HelmCredentialRecord[] = [];
  /** unsupported commands and rule violations; assertDone() reports them */
  readonly problems: string[] = [];
  readonly redactor: Redactor;
  /** the control-plane node's file system */
  readonly fs: FakeNodeFs;
  private readonly charts: ChartEntry[] = [];
  private readonly bySha = new Map<string, ChartEntry>();
  private readonly store: FakeHelmRelease[] = [];
  private readonly failures = new Map<string, string[]>();
  private readonly states: StepState[];
  private readonly clock: Clock | undefined;
  private statusCount = 0;
  private tick = 0;
  private done = false;

  constructor(options: FakeHelmExecutorOptions) {
    this.node = options.node ?? fakeNode('server_1');
    this.redactor = options.redactor;
    this.fs = options.nodeShell ? options.nodeShell.fs(this.node) : (options.fs ?? new FakeNodeFs());
    this.clock = options.clock;
    this.states = (options.script ?? []).map((step, index) => ({ step, index, used: 0 }));
  }

  /** `status` calls made (design-04 never issues one: it returns values and the manifest) */
  get statusCalls(): number {
    return this.statusCount;
  }

  get asserted(): boolean {
    return this.done;
  }

  /** registers a chart archive a pull can fetch; returns its sha256 */
  chart(definition: FakeHelmChart): string {
    const bytes =
      definition.bytes === undefined
        ? new Uint8Array(Buffer.from(`fake chart archive ${definition.name}-${definition.version}\n`, 'utf8'))
        : typeof definition.bytes === 'string'
          ? new Uint8Array(Buffer.from(definition.bytes, 'utf8'))
          : new Uint8Array(definition.bytes);
    const entry: ChartEntry = {
      name: definition.name,
      version: definition.version,
      appVersion: definition.appVersion ?? null,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      manifest: definition.manifest ?? '',
      crds: definition.crds ?? '',
      repo: definition.repo ?? null,
      oci: definition.oci ?? null,
    };
    // a re-registration replaces what the repository serves; earlier bytes stay installable
    const existing = this.charts.findIndex((c) => c.name === entry.name && c.version === entry.version);
    if (existing === -1) this.charts.push(entry);
    else this.charts[existing] = entry;
    this.bySha.set(entry.sha256, entry);
    return entry.sha256;
  }

  /** pre-populates the verified chart cache; bytes that do not hash to `sha256` model a corrupt entry */
  seedCache(sha256: string, bytes: string | Uint8Array): string {
    const path = chartCachePath(sha256);
    this.fs.write(path, bytes, 0o600);
    return path;
  }

  /** a release as if installed earlier; revisions default to deployed, the last one only */
  seedRelease(release: {
    name: string;
    namespace: string;
    revisions: (Partial<Omit<FakeHelmRevision, 'revision'>> & { chart: string; version: string })[];
  }): FakeHelmRelease {
    const seeded = new FakeHelmRelease(release.name, release.namespace);
    release.revisions.forEach((revision, index) => {
      const last = index === release.revisions.length - 1;
      seeded.revisions.push({
        revision: index + 1,
        chart: revision.chart,
        version: revision.version,
        appVersion: revision.appVersion ?? null,
        values: revision.values ?? null,
        status: revision.status ?? (last ? 'deployed' : 'superseded'),
        updated: revision.updated ?? rfc3339(this.stamp()),
        description: revision.description ?? (index === 0 ? 'Install complete' : 'Upgrade complete'),
        labels: revision.labels ?? {},
        manifest: revision.manifest ?? '',
      });
    });
    this.store.push(seeded);
    return seeded;
  }

  /** the next upgrade (or rollback) of `name` fails with this stderr */
  failNext(name: string, stderr: string): void {
    const queue = this.failures.get(name) ?? [];
    queue.push(stderr);
    this.failures.set(name, queue);
  }

  release(namespace: string, name: string): FakeHelmRelease | null {
    return this.store.find((r) => r.namespace === namespace && r.name === name) ?? null;
  }

  releases(): FakeHelmRelease[] {
    return [...this.store];
  }

  /** Helm's storage Secrets: one per revision, with the owner/name/status/version labels */
  storageSecrets(namespace?: string): { namespace: string; name: string; labels: Record<string, string> }[] {
    return this.store
      .filter((release) => namespace === undefined || release.namespace === namespace)
      .flatMap((release) =>
        release.revisions.map((revision) => ({
          namespace: release.namespace,
          name: `sh.helm.release.v1.${release.name}.v${revision.revision}`,
          labels: { ...revision.labels, name: release.name, owner: 'helm', status: revision.status, version: String(revision.revision) },
        })),
      );
  }

  /** `kubectl get secrets -n <ns> -l <selector> -o name` over the storage Secrets */
  secretNamesMatching(namespace: string, selector: string): string {
    return this.storageSecrets(namespace)
      .filter((secret) => labelSelectorMatches(selector, secret.labels))
      .map((secret) => `secret/${secret.name}\n`)
      .join('');
  }

  /** credential files (HELM_*_CONFIG overrides of recorded calls) still present on the node */
  credentialFilesLeft(): string[] {
    const paths = new Set<string>();
    for (const call of this.calls) {
      for (const path of [call.env.registryConfig, call.env.repositoryConfig]) if (path !== undefined) paths.add(path);
    }
    return [...paths].filter((path) => this.fs.exists(path)).sort();
  }

  assertDone(): void {
    this.done = true;
    const failures: string[] = [];
    for (const state of this.states) {
      const times = state.step.times ?? 1;
      if (state.step.optional || times === 'any' || state.used >= times) continue;
      failures.push(`step ${stepLabel(state)} (${renderArgs(state.step.args)}) was used ${state.used} of ${times} time(s)`);
    }
    for (const [name, queue] of this.failures) {
      if (queue.length > 0) failures.push(`failNext(${name}) was never consumed`);
    }
    failures.push(...this.problems);
    if (failures.length > 0) throw new Error(`FakeHelmExecutor:\n${failures.join('\n')}`);
  }

  // ---- HelmExecutor ----------------------------------------------------------------------------

  async run(call: HelmCall): Promise<HelmResult> {
    const recorded: RecordedHelmCall = {
      args: [...call.args],
      stdin: call.stdin ?? '',
      env: { ...(call.env ?? {}) },
      mutating: call.mutating,
      timeoutS: call.timeoutS,
      allowFailure: call.allowFailure ?? false,
      commandString: '',
    };
    this.calls.push(recorded);
    recorded.commandString = helmCommand(call);
    if (call.args[0] === 'status') this.statusCount += 1;
    await turn();
    const state = this.claim(call.args);
    let raw: Raw;
    if (state) {
      recorded.step = stepLabel(state);
      raw = await this.answer(state, call);
    } else {
      recorded.step = 'model';
      raw = this.execute(call);
    }
    const result: HelmResult = { exitCode: raw.exitCode, stdout: raw.stdout, stderr: this.redactor.redact(raw.stderr) };
    recorded.result = result;
    if (result.exitCode !== 0 && !call.allowFailure) throw this.failure(`helm ${describeArgs(call.args)}`, result);
    return result;
  }

  async json<T>(args: string[]): Promise<T | null> {
    const what = `helm ${describeArgs(args)}`;
    const result = await this.run({ args: [...args, '-o', 'json'], mutating: false, timeoutS: K8S_REQUEST_TIMEOUT_S, allowFailure: true });
    if (result.exitCode !== 0) {
      if (result.stderr.includes('release: not found')) return null;
      throw this.failure(what, result);
    }
    const text = result.stdout.trim();
    if (text === '') return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new KubeError('Unknown', `${what} returned output that is not JSON on ${this.node.name}`, this.node.name, 0, '');
    }
  }

  // ---- script ----------------------------------------------------------------------------------

  private claim(args: readonly string[]): StepState | null {
    const state = this.states.find((candidate) => {
      const times = candidate.step.times ?? 1;
      return (times === 'any' || candidate.used < times) && matchArgs(candidate.step.args, args);
    });
    if (state) state.used += 1;
    return state ?? null;
  }

  private async answer(state: StepState, call: HelmCall): Promise<Raw> {
    const respond = state.step.respond;
    if (typeof respond === 'function') return respond(call);
    if ('fixture' in respond) {
      const { scenario, file } = splitFixtureRef(respond.fixture);
      const text = readHelmFixture(scenario, file);
      if (respond.as === 'stderr') return { exitCode: respond.exitCode ?? 1, stdout: '', stderr: text };
      return { exitCode: respond.exitCode ?? 0, stdout: text, stderr: '' };
    }
    return respond;
  }

  // ---- model -----------------------------------------------------------------------------------

  private stamp(): Date {
    if (this.clock) return this.clock.now();
    this.tick += 1;
    return new Date(new Date(FAKE_CLOCK_START).getTime() + this.tick * 1000);
  }

  private unsupported(call: HelmCall, why: string): never {
    const message = `FakeHelmExecutor: ${why}: helm ${call.args.join(' ')}`;
    this.problems.push(message);
    throw new Error(message);
  }

  private execute(call: HelmCall): Raw {
    const [verb, sub] = call.args;
    const parsed = parseArgs(call.args.slice(verb === 'get' || verb === 'registry' || verb === 'repo' || verb === 'show' ? 2 : 1));
    switch (verb) {
      case 'pull':
        return this.pull(parsed, call);
      case 'upgrade':
      case 'install':
        return this.upgrade(parsed, call, verb === 'install' || parsed.flags.has('--install') || parsed.flags.has('-i'));
      case 'rollback':
        return this.rollback(parsed);
      case 'uninstall':
        return this.uninstall(parsed);
      case 'list':
      case 'ls':
        return this.list(parsed);
      case 'history':
        return this.history(parsed);
      case 'status':
        return this.status(parsed);
      case 'version':
        return ok(parsed.flags.has('--short') ? `${HELM_PIN.version}+gfake\n` : `version.BuildInfo{Version:"${HELM_PIN.version}"}\n`);
      case 'get':
        if (sub === 'values') return this.getValues(parsed);
        if (sub === 'manifest') return this.getManifest(parsed);
        break;
      case 'registry':
        if (sub === 'login') return this.registryLogin(parsed, call);
        if (sub === 'logout') return ok('Removing login credentials\n');
        break;
      case 'repo':
        if (sub === 'update') return this.repoUpdate(parsed, call);
        break;
      case 'show':
        if (sub === 'crds') return this.showCrds(parsed);
        break;
    }
    return this.unsupported(call, 'unsupported command');
  }

  private namespaceOf(parsed: ParsedArgs): string {
    return flag(parsed, '-n', '--namespace') ?? 'default';
  }

  private findChart(name: string, version: string | undefined, source: { repo?: string; oci?: string }): ChartEntry | null {
    const candidates = this.charts.filter(
      (chart) =>
        chart.name === name &&
        (source.repo === undefined || chart.repo === null || chart.repo === source.repo) &&
        (source.oci === undefined || chart.oci === null || chart.oci === source.oci),
    );
    if (version === undefined) return candidates.at(-1) ?? null;
    return candidates.find((chart) => chart.version === version || chart.version === version.replace(/^v/, '')) ?? null;
  }

  private pull(parsed: ParsedArgs, call: HelmCall): Raw {
    const ref = parsed.positionals[0];
    if (ref === undefined) return this.unsupported(call, 'pull without a chart reference');
    const version = flag(parsed, '--version');
    const repo = flag(parsed, '--repo');
    const destination = flag(parsed, '--destination', '-d') ?? '.';
    let chart: ChartEntry | null;
    if (ref.startsWith('oci://')) {
      const base = ref.replace(/@sha256:[0-9a-f]+$/, '').replace(/:[^/:]+$/, '');
      chart = this.findChart(base.split('/').pop() ?? '', version, { oci: base });
    } else {
      chart = this.findChart(ref.split('/').pop() ?? ref, version, repo === undefined ? {} : { repo });
    }
    if (chart === null) {
      return failed(`Error: chart "${ref.split('/').pop()}" version "${version ?? 'latest'}" not found in ${repo ?? ref} repository`);
    }
    const file = `${chart.name}-${chart.version}.tgz`;
    if (!this.fs.isDir(destination)) return failed(`Error: open ${destination}/${file}: no such file or directory`);
    this.fs.write(`${destination}/${file}`, chart.bytes, 0o644);
    return ok(`Pulled: ${ref}:${chart.version}\nDigest: sha256:${chart.sha256}\n`);
  }

  private values(parsed: ParsedArgs, call: HelmCall): { values: Record<string, unknown> | null; error?: string } {
    const source = flag(parsed, '--values', '-f');
    if (source === undefined) return { values: null };
    if (source !== '-') return this.unsupported(call, `values from ${source} (values travel on stdin)`);
    const text = call.stdin ?? '';
    if (text.trim() === '') return { values: null };
    let parsedValues: unknown;
    try {
      parsedValues = parseYaml(text);
    } catch (error) {
      return { values: null, error: `Error: failed to parse -: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
    }
    if (parsedValues === null || parsedValues === undefined) return { values: null };
    if (typeof parsedValues !== 'object' || Array.isArray(parsedValues)) return { values: null, error: 'Error: values from - must be a map' };
    return { values: parsedValues as Record<string, unknown> };
  }

  private trim(release: FakeHelmRelease, parsed: ParsedArgs): void {
    const max = Number.parseInt(flag(parsed, '--history-max') ?? '10', 10);
    if (!(max > 0)) return;
    while (release.revisions.length > max) {
      const current = release.deployed;
      const oldest = release.revisions.findIndex((revision) => revision !== current);
      if (oldest === -1) return;
      release.revisions.splice(oldest, 1);
    }
  }

  private supersede(release: FakeHelmRelease): FakeHelmRevision | null {
    const previous = release.deployed;
    if (previous) previous.status = 'superseded';
    return previous;
  }

  private upgrade(parsed: ParsedArgs, call: HelmCall, install: boolean): Raw {
    const [name, chartArg] = parsed.positionals;
    if (name === undefined || chartArg === undefined) return this.unsupported(call, 'upgrade without a release name and a chart');
    if (!chartArg.startsWith('/') || !chartArg.endsWith('.tgz')) {
      return this.unsupported(call, `chart ${chartArg} is not a local .tgz (cross-cutting rule 15)`);
    }
    for (const forbidden of ['--repo', '--version']) {
      if (parsed.flags.has(forbidden)) return this.unsupported(call, `${forbidden} on an upgrade of a local archive (design-04 3.5.4)`);
    }
    const bytes = this.fs.read(chartArg);
    if (bytes === null) return failed(`Error: path "${chartArg}" not found`);
    const chart = this.bySha.get(createHash('sha256').update(bytes).digest('hex'));
    if (!chart) return this.unsupported(call, `the bytes of ${chartArg} match no chart registered with chart()`);
    const namespace = this.namespaceOf(parsed);
    const { values: supplied, error } = this.values(parsed, call);
    if (error !== undefined) return failed(error);
    let labels: Record<string, string> | null;
    try {
      labels = parseLabels(flag(parsed, '--labels'));
    } catch (labelError) {
      return failed(`Error: ${labelError instanceof Error ? labelError.message : String(labelError)}`);
    }

    let release = this.release(namespace, name);
    const latest = release?.latest ?? null;
    const installing = latest === null || latest.status === 'uninstalled';
    if (installing && !install) return failed(`Error: UPGRADE FAILED: "${name}" has no deployed releases`);
    if (latest !== null && latest.status.startsWith('pending-')) {
      return failed('Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress');
    }
    const previous = release?.deployed ?? null;
    const values = supplied ?? (parsed.flags.has('--reset-values') ? null : (previous?.values ?? null));
    const now = this.stamp();
    const number = (latest?.revision ?? 0) + 1;
    const revision: FakeHelmRevision = {
      revision: number,
      chart: chart.name,
      version: chart.version,
      appVersion: chart.appVersion,
      values,
      status: 'deployed',
      updated: rfc3339(now),
      description: flag(parsed, '--description') ?? (installing ? 'Install complete' : 'Upgrade complete'),
      labels: labels ?? { ...(latest?.labels ?? {}) },
      manifest: chart.manifest,
    };
    const header = `NAME: ${name}\nLAST DEPLOYED: ${goTime(now)}\nNAMESPACE: ${namespace}\nSTATUS: deployed\nREVISION: ${number}\n`;
    if (flag(parsed, '--dry-run') !== undefined) return ok(`${header.replace('STATUS: deployed', 'STATUS: pending-upgrade')}DRY RUN\n`);

    if (!release) {
      release = new FakeHelmRelease(name, namespace);
      this.store.push(release);
    }
    const failure = this.failures.get(name)?.shift();
    const rollbackOnFailure = parsed.flags.has('--rollback-on-failure') || parsed.flags.has('--atomic');
    if (failure === undefined) {
      this.supersede(release);
      release.revisions.push(revision);
      this.trim(release, parsed);
      return ok(installing ? header : `Release "${name}" has been upgraded. Happy Helming!\n${header}`);
    }

    const detail = detailOf(failure);
    this.supersede(release);
    release.revisions.push({ ...revision, status: 'failed', description: `${installing ? 'Release' : 'Upgrade'} "${name}" failed: ${detail}` });
    if (installing) {
      if (rollbackOnFailure) {
        this.store.splice(this.store.indexOf(release), 1);
        return failed(`Error: INSTALL FAILED: release ${name} failed, and has been uninstalled due to rollback-on-failure being set: ${detail}`);
      }
      this.trim(release, parsed);
      return failed(`Error: INSTALL FAILED: ${detail}`);
    }
    if (rollbackOnFailure && previous) {
      release.revisions.push({
        ...previous,
        revision: number + 1,
        status: 'deployed',
        updated: rfc3339(this.stamp()),
        description: `Rollback to ${previous.revision}`,
      });
      this.trim(release, parsed);
      return failed(`Error: UPGRADE FAILED: release ${name} failed, and has been rolled back due to rollback-on-failure being set: ${detail}`);
    }
    this.trim(release, parsed);
    return failed(`Error: UPGRADE FAILED: ${detail}`);
  }

  private rollback(parsed: ParsedArgs): Raw {
    const [name, target] = parsed.positionals;
    const release = name === undefined ? null : this.release(this.namespaceOf(parsed), name);
    if (!release || !release.latest) return failed('Error: release: not found');
    const number = target === undefined ? release.latest.revision - 1 : Number.parseInt(target, 10);
    const source = release.revision(number);
    if (!source) return failed(`Error: release has no ${number} version`);
    const next = release.latest.revision + 1;
    const failure = this.failures.get(release.name)?.shift();
    if (failure !== undefined) {
      release.revisions.push({ ...source, revision: next, status: 'failed', updated: rfc3339(this.stamp()), description: `Rollback "${release.name}" failed: ${detailOf(failure)}` });
      this.trim(release, parsed);
      return failed(`Error: ${detailOf(failure)}`);
    }
    this.supersede(release);
    release.revisions.push({
      ...source,
      revision: next,
      status: 'deployed',
      updated: rfc3339(this.stamp()),
      description: flag(parsed, '--description') ?? `Rollback to ${number}`,
    });
    this.trim(release, parsed);
    return ok('Rollback was a success! Happy Helming!\n');
  }

  private uninstall(parsed: ParsedArgs): Raw {
    const [name] = parsed.positionals;
    const release = name === undefined ? null : this.release(this.namespaceOf(parsed), name);
    if (!release || release.latest?.status === 'uninstalled') {
      if (parsed.flags.has('--ignore-not-found')) return ok();
      return failed(`Error: uninstall: Release not loaded: ${name ?? ''}: release: not found`);
    }
    if (parsed.flags.has('--keep-history')) {
      const latest = release.latest;
      if (latest) {
        latest.status = 'uninstalled';
        latest.description = flag(parsed, '--description') ?? 'Uninstallation complete';
      }
    } else {
      this.store.splice(this.store.indexOf(release), 1);
    }
    return ok(`release "${release.name}" uninstalled\n`);
  }

  private list(parsed: ParsedArgs): Raw {
    // Helm 4 removed `list -a/--all`
    if (parsed.flags.has('-a')) return failed("Error: unknown shorthand flag: 'a' in -a");
    if (parsed.flags.has('--all')) return failed('Error: unknown flag: --all');
    const all = parsed.flags.has('-A') || parsed.flags.has('--all-namespaces');
    const namespace = this.namespaceOf(parsed);
    const selector = flag(parsed, '-l', '--selector');
    const filter = flag(parsed, '--filter');
    const pattern = filter === undefined ? null : new RegExp(filter);
    const states = Object.entries(LIST_STATES)
      .filter(([name]) => parsed.flags.has(name))
      .flatMap(([, values]) => values);
    const mask = states.length > 0 ? states : ['deployed', 'failed'];
    const rows = this.store
      .filter((release) => all || release.namespace === namespace)
      .filter((release) => pattern === null || pattern.test(release.name))
      .map((release) => ({ release, latest: release.latest }))
      .filter((row): row is { release: FakeHelmRelease; latest: FakeHelmRevision } => row.latest !== null)
      .filter(({ latest }) => mask.includes(latest.status))
      .filter(
        ({ release, latest }) =>
          selector === undefined ||
          labelSelectorMatches(selector, { ...latest.labels, name: release.name, owner: 'helm', status: latest.status, version: String(latest.revision) }),
      )
      .sort((a, b) => (a.release.name < b.release.name ? -1 : a.release.name > b.release.name ? 1 : a.release.namespace < b.release.namespace ? -1 : 1))
      .map(({ release, latest }) => ({
        name: release.name,
        namespace: release.namespace,
        revision: String(latest.revision),
        updated: goTime(new Date(latest.updated)),
        status: latest.status,
        chart: `${latest.chart}-${latest.version}`,
        app_version: latest.appVersion ?? '',
      }));
    if (flag(parsed, '-o', '--output') === 'json') return ok(`${JSON.stringify(rows)}\n`);
    const lines = rows.map((row) => [row.name, row.namespace, row.revision, row.updated, row.status, row.chart, row.app_version].join('\t'));
    return ok(`${['NAME\tNAMESPACE\tREVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION', ...lines].join('\n')}\n`);
  }

  private history(parsed: ParsedArgs): Raw {
    const [name] = parsed.positionals;
    const release = name === undefined ? null : this.release(this.namespaceOf(parsed), name);
    if (!release) return failed('Error: release: not found');
    const max = Number.parseInt(flag(parsed, '--max') ?? '256', 10);
    const rows = release.revisions.slice(-max).map((revision) => ({
      revision: revision.revision,
      updated: revision.updated,
      status: revision.status,
      chart: `${revision.chart}-${revision.version}`,
      app_version: revision.appVersion ?? '',
      description: revision.description,
    }));
    return ok(`${JSON.stringify(rows)}\n`);
  }

  private revisionOf(parsed: ParsedArgs): FakeHelmRevision | null {
    const [name] = parsed.positionals;
    const release = name === undefined ? null : this.release(this.namespaceOf(parsed), name);
    if (!release) return null;
    const wanted = flag(parsed, '--revision');
    return wanted === undefined ? release.latest : release.revision(Number.parseInt(wanted, 10));
  }

  private getValues(parsed: ParsedArgs): Raw {
    const revision = this.revisionOf(parsed);
    if (!revision) return failed('Error: release: not found');
    const values = revision.values !== null && Object.keys(revision.values).length > 0 ? revision.values : null;
    if (flag(parsed, '-o', '--output') === 'json') return ok(`${JSON.stringify(values)}\n`);
    return ok(`USER-SUPPLIED VALUES:\n${values === null ? 'null' : JSON.stringify(values, null, 2)}\n`);
  }

  private getManifest(parsed: ParsedArgs): Raw {
    const revision = this.revisionOf(parsed);
    return revision ? ok(revision.manifest) : failed('Error: release: not found');
  }

  private status(parsed: ParsedArgs): Raw {
    const revision = this.revisionOf(parsed);
    const [name] = parsed.positionals;
    if (!revision || name === undefined) return failed('Error: release: not found');
    return ok(
      `${JSON.stringify({
        name,
        info: { last_deployed: revision.updated, description: revision.description, status: revision.status, notes: '' },
        chart: { metadata: { name: revision.chart, version: revision.version, appVersion: revision.appVersion ?? '' } },
        config: revision.values ?? {},
        manifest: revision.manifest,
        version: revision.revision,
        namespace: this.namespaceOf(parsed),
      })}\n`,
    );
  }

  private registryLogin(parsed: ParsedArgs, call: HelmCall): Raw {
    const host = parsed.positionals[0] ?? '';
    const username = flag(parsed, '--username') ?? '';
    const password = (call.stdin ?? '').replace(/\n$/, '');
    this.credentials.push({ kind: 'registry-login', env: { ...(call.env ?? {}) }, host, username, passwordStdin: call.stdin ?? '' });
    const config = call.env?.registryConfig;
    if (config !== undefined) {
      const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      this.fs.write(config, JSON.stringify({ auths: { [host]: { auth } } }), 0o600);
    }
    return ok('Login Succeeded\n');
  }

  private repoUpdate(parsed: ParsedArgs, call: HelmCall): Raw {
    this.credentials.push({ kind: 'repo-update', env: { ...(call.env ?? {}) } });
    const config = call.env?.repositoryConfig;
    if (config !== undefined && !this.fs.isFile(config)) return failed('Error: no repositories found. You must add one before updating');
    return ok(`Update Complete.${parsed.positionals.length > 0 ? ` (${parsed.positionals.join(', ')})` : ''}\n`);
  }

  private showCrds(parsed: ParsedArgs): Raw {
    const path = parsed.positionals[0] ?? '';
    const bytes = this.fs.read(path);
    if (bytes === null) return failed(`Error: path "${path}" not found`);
    const chart = this.bySha.get(createHash('sha256').update(bytes).digest('hex'));
    return chart ? ok(chart.crds) : failed(`Error: file '${path}' does not appear to be a gzipped archive`);
  }

  private failure(what: string, result: HelmResult): KubeError {
    const line = firstLine(result.stderr);
    return new KubeError(
      classifyKubectlFailure(result.exitCode, result.stderr),
      `${what} failed on ${this.node.name} (exit ${result.exitCode})${line ? `: ${line}` : ''}`,
      this.node.name,
      result.exitCode,
      result.stderr,
    );
  }
}
