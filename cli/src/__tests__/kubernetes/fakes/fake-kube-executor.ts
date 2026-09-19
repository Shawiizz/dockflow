// FakeKubeExecutor (design-07 3.3): the KubeExecutor every backend, store, apply and setup test
// drives. Script mode matches each call against KubeStep rows (strict order by default); cluster mode
// hands the calls no row matches to a KubeCallHandler (FakeCluster, P18), so rows express fault
// injection. Calls are recorded with the command string the real builder of runtime/kubectl.ts
// produces, and each method mirrors the real executor's result handling (throws, allowFailure,
// AlreadyExists, NotFound, stderr redaction).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'stream';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import { K8S_FIELD_MANAGER } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock, SshChannel } from '../../../services/orchestrator/kubernetes/deps';
import type { K8sDistribution } from '../../../services/orchestrator/kubernetes/distribution';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import {
  classifyKubectlFailure,
  KubeError,
  type KubeErrorReason,
  NO_EXIT_CODE,
} from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  type ApplyOptions,
  applyCall,
  type CreateOptions,
  type CreateResult,
  createCall,
  deleteCall,
  firstLine,
  type GetJsonOptions,
  getJsonCall,
  type KubeDeleteOptions,
  type KubeExecutor,
  type KubectlCall,
  type KubectlResult,
  kubectlCommand,
  kubectlGuardS,
  parseJsonItems,
  replaceCall,
  type ShellCall,
} from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import type { Redactor } from '../../../utils/redact';
import {
  formatKubectlJson,
  loadKubectlFixture,
  readKubectlFixture,
  readMetricsFixture,
  splitFixtureRef,
} from '../support/kubectl-fixtures';
import { CLOSED_CHANNEL_EXIT, collectStdin, readGolden, STDIN_GOLDEN_ROOT, turn } from './fake-node-shell';

/** matches exactly one argument */
export const ANY: unique symbol = Symbol('ANY');
/** matches the remaining arguments (zero or more); only as the last element */
export const REST: unique symbol = Symbol('REST');

export type ArgMatcher = string | RegExp | typeof ANY | typeof REST;

export type KubeMethod =
  | 'run'
  | 'getJson'
  | 'apply'
  | 'create'
  | 'replace'
  | 'delete'
  | 'stream'
  | 'shell'
  | 'channel'
  | 'interactive'
  | 'command';

export type KubeResponse =
  | KubectlResult
  | ((call: KubectlCall, recorded: RecordedKubeCall) => KubectlResult | Promise<KubectlResult>)
  /** stdout = JSON.stringify(json), exit 0 */
  | { json: unknown }
  /** `<scenario>/<file>` of fixtures/kubectl (several: one combined List), or `metrics/<scenario>` */
  | { fixture: string | readonly string[] }
  /** exit 1 (127 for ToolMissing) with a recorded stderr the classifier maps to that reason */
  | { error: KubeErrorReason; stderr?: string }
  /** the SSH connection drops: KubeError('Unreachable') without an exit status */
  | { transportError: true }
  /** never answers: KubeError('Timeout') once the call's local guard elapses on the fake clock */
  | { hang: true };

export interface KubeStep {
  /** catalogue id (design-03 20 K01..K46, design-06), printed in failure messages */
  id?: string;
  /** the argv after the global flags; for shell/channel/interactive, the one-element [script] */
  args: ArgMatcher[];
  /** restricts the row to one executor method */
  method?: KubeMethod;
  /** undefined: any; null: the call carries no namespace */
  namespace?: string | null;
  /** asserted when present */
  mutating?: boolean;
  /** asserted when present: a callback, a regex, or a golden file under fixtures/stdin/ */
  stdin?: ((text: string) => void) | RegExp | { golden: string };
  /** default 1 */
  times?: number | 'any';
  /** never required by assertDone() */
  optional?: boolean;
  respond: KubeResponse;
}

export interface RecordedKubeCall {
  method: KubeMethod;
  call: KubectlCall;
  /** built with the real command builder of runtime/kubectl.ts; the script for shell/channel/interactive */
  commandString: string;
  /** apply() only: the field manager the call carried */
  fieldManager?: string;
  /** ClusterNodeRef.name of the executor */
  node: string;
  /** stdin as sent ('' / empty when none) */
  stdinText: string;
  stdinBytes: Uint8Array;
  /** id (or `#<index>`) of the row that answered; 'cluster' when the cluster handler did */
  step?: string;
  /** what the call answered (stderr redacted); absent when it threw before answering */
  result?: KubectlResult;
  /** a channel the caller closed before it answered */
  closed?: boolean;
}

/** One call the script did not match, as the cluster handler receives it. */
export interface KubeRequest {
  method: KubeMethod;
  call: KubectlCall;
  node: ClusterNodeRef;
  commandString: string;
  stdinText: string;
}

/** What FakeCluster implements (PD-13): serves the calls no script row matched. */
export interface KubeCallHandler {
  handle(request: KubeRequest): KubectlResult | Promise<KubectlResult>;
}

export interface FakeKubeExecutorOptions {
  /** default fakeNode('server_1') */
  node?: ClusterNodeRef;
  script?: KubeStep[];
  /** cluster mode: calls no row matches are served here */
  cluster?: KubeCallHandler;
  /** default 'strict' in script mode, 'any' in cluster mode */
  order?: 'strict' | 'any';
  redactor: Redactor;
  /** default k3sDistribution */
  distribution?: K8sDistribution;
  /** measures `{hang: true}` guards */
  clock?: Clock;
  /** root of `{golden}` stdin files; default fixtures/stdin */
  stdinGoldenRoot?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FAKE_NODE_ADDRESSES: Readonly<Record<string, string>> = {
  server_1: '192.0.2.10',
  server_2: '192.0.2.11',
  server_3: '192.0.2.12',
  agent_1: '192.0.2.20',
  agent_2: '192.0.2.21',
};

/** a ClusterNodeRef with a documentation address; `server_*` names are managers */
export function fakeNode(name: string, role?: 'manager' | 'worker'): ClusterNodeRef {
  const host = FAKE_NODE_ADDRESSES[name] ?? '192.0.2.99';
  return {
    name,
    role: role ?? (name.startsWith('agent') || name.startsWith('worker') ? 'worker' : 'manager'),
    host,
    privateHost: host,
    connection: { host, port: 22, user: 'deploy', privateKey: 'test-only-key' },
  };
}

function argMatches(matcher: ArgMatcher, arg: string): boolean {
  if (matcher === ANY) return true;
  if (typeof matcher === 'string') return matcher === arg;
  if (matcher instanceof RegExp) return matcher.test(arg);
  return false;
}

function assertPattern(pattern: readonly ArgMatcher[]): void {
  const rest = pattern.indexOf(REST);
  if (rest !== -1 && rest !== pattern.length - 1) throw new Error(`REST may only be the last argument: ${renderArgs(pattern)}`);
}

/** step args against call args: strings equal, RegExp test, ANY one argument, REST the rest */
export function matchArgs(pattern: readonly ArgMatcher[], args: readonly string[]): boolean {
  assertPattern(pattern);
  const rest = pattern.indexOf(REST);
  const fixed = rest === -1 ? pattern : pattern.slice(0, rest);
  if (rest === -1 ? args.length !== fixed.length : args.length < fixed.length) return false;
  return fixed.every((matcher, i) => argMatches(matcher, args[i]));
}

/** token edit distance between a pattern and an argv, for the closest-steps hint */
export function argDistance(pattern: readonly ArgMatcher[], args: readonly string[]): number {
  const rest = pattern.indexOf(REST);
  const fixed = rest === -1 ? pattern : pattern.slice(0, rest);
  const rows = fixed.length + 1;
  const cols = args.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = argMatches(fixed[i - 1], args[j - 1]) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  if (rest === -1) return d[fixed.length][args.length];
  // REST absorbs any tail of the call for free
  return Math.min(...d[fixed.length]);
}

export function renderArgs(pattern: readonly ArgMatcher[]): string {
  return pattern
    .map((matcher) => {
      if (matcher === ANY) return '<ANY>';
      if (matcher === REST) return '<REST...>';
      if (matcher instanceof RegExp) return String(matcher);
      return /\s/.test(matcher) || matcher === '' ? JSON.stringify(matcher) : matcher;
    })
    .join(' ');
}

const STDERR_SAMPLES = join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr');

/** exit code the fake reports for an `{error}` row */
export function errorExitCode(reason: KubeErrorReason): number {
  return reason === 'ToolMissing' ? 127 : 1;
}

/** the first recorded stderr sample that the classifier maps to `reason` */
export function kubectlStderrSample(reason: KubeErrorReason): string {
  const dir = join(STDERR_SAMPLES, reason);
  if (!existsSync(dir)) throw new Error(`No kubectl stderr samples for ${reason} under ${STDERR_SAMPLES}`);
  for (const file of readdirSync(dir).sort()) {
    const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    if (classifyKubectlFailure(errorExitCode(reason), text) === reason) return text;
  }
  throw new Error(`No kubectl stderr sample of ${reason} classifies as ${reason}`);
}

function fixtureStdout(ref: string | readonly string[]): string {
  if (typeof ref !== 'string') {
    const items = ref.flatMap((one) => {
      const { scenario, file } = splitFixtureRef(one);
      const list = loadKubectlFixture<{ items?: unknown[] }>(scenario, file);
      return Array.isArray(list.items) ? list.items : [list];
    });
    return formatKubectlJson({ apiVersion: 'v1', items, kind: 'List', metadata: { resourceVersion: '' } });
  }
  const { scenario, file } = splitFixtureRef(ref);
  return scenario === 'metrics' ? readMetricsFixture(file) : readKubectlFixture(scenario, file);
}

function isKubectlResult(value: object): value is KubectlResult {
  return 'exitCode' in value && typeof (value as { exitCode: unknown }).exitCode === 'number';
}

function describeArgs(args: readonly string[]): string {
  return args[0] === 'rollout' && args[1] !== undefined ? `rollout ${args[1]}` : (args[0] ?? '');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function bytesOf(stdin: string | Uint8Array | undefined): Uint8Array {
  if (stdin === undefined) return new Uint8Array();
  return typeof stdin === 'string' ? new Uint8Array(Buffer.from(stdin, 'utf8')) : new Uint8Array(stdin);
}

interface StepState {
  step: KubeStep;
  index: number;
  used: number;
}

function stepLabel(state: StepState): string {
  return state.step.id ?? `#${state.index}`;
}

function required(state: StepState): number {
  const times = state.step.times ?? 1;
  return state.step.optional || times === 'any' ? 0 : times;
}

function exhausted(state: StepState): boolean {
  const times = state.step.times ?? 1;
  return times !== 'any' && state.used >= times;
}

type Answer = { kind: 'result'; result: KubectlResult; step: string } | { kind: 'hang'; step: string };

// ---------------------------------------------------------------------------
// FakeKubeExecutor
// ---------------------------------------------------------------------------

export class FakeKubeExecutor implements KubeExecutor {
  readonly node: ClusterNodeRef;
  readonly calls: RecordedKubeCall[] = [];
  /** calls neither a row nor the cluster served */
  readonly unexpected: string[] = [];
  /** assertion failures on matched rows (stdin, mutating) */
  readonly problems: string[] = [];
  readonly redactor: Redactor;
  readonly distribution: K8sDistribution;
  private readonly states: StepState[];
  private readonly order: 'strict' | 'any';
  private readonly cluster: KubeCallHandler | undefined;
  private readonly clock: Clock | undefined;
  private readonly goldenRoot: string;
  private cursor = 0;
  private done = false;

  constructor(options: FakeKubeExecutorOptions) {
    this.node = options.node ?? fakeNode('server_1');
    this.redactor = options.redactor;
    this.distribution = options.distribution ?? k3sDistribution;
    this.cluster = options.cluster;
    this.clock = options.clock;
    this.goldenRoot = options.stdinGoldenRoot ?? STDIN_GOLDEN_ROOT;
    this.order = options.order ?? (options.cluster ? 'any' : 'strict');
    this.states = (options.script ?? []).map((step, index) => {
      assertPattern(step.args);
      return { step, index, used: 0 };
    });
  }

  /** assertDone() was called */
  get asserted(): boolean {
    return this.done;
  }

  /** every non-optional, non-'any' row consumed; no unexpected call; no failed row assertion */
  assertDone(): void {
    this.done = true;
    const failures: string[] = [];
    for (const state of this.states) {
      const times = required(state);
      if (state.used < times) {
        failures.push(`step ${stepLabel(state)} (${renderArgs(state.step.args)}) was used ${state.used} of ${times} time(s)`);
      }
    }
    for (const call of this.unexpected) failures.push(`unexpected call: ${call}`);
    failures.push(...this.problems);
    if (failures.length > 0) throw new Error(`FakeKubeExecutor on ${this.node.name}:\n${failures.join('\n')}`);
  }

  // ---- KubeExecutor ----------------------------------------------------------------------------

  async run(call: KubectlCall): Promise<KubectlResult> {
    const result = await this.serve('run', call);
    if (result.exitCode !== 0 && !call.allowFailure) throw this.failure(`kubectl ${describeArgs(call.args)}`, result);
    return result;
  }

  async getJson<T>(resources: string[], options: GetJsonOptions = {}): Promise<T[]> {
    const call = getJsonCall(resources, options);
    const what = `kubectl get ${resources.join(',')}`;
    const result = await this.serve('getJson', call);
    if (result.exitCode !== 0) {
      if (options.allowNotFound && classifyKubectlFailure(result.exitCode, result.stderr) === 'NotFound') return [];
      throw this.failure(what, result);
    }
    try {
      return parseJsonItems<T>(result.stdout);
    } catch {
      throw new KubeError('Unknown', `${what} returned output that is not JSON on ${this.node.name}`, this.node.name, 0, '');
    }
  }

  async apply(manifests: string, options: ApplyOptions): Promise<void> {
    const call = applyCall(manifests, options);
    const result = await this.serve('apply', call, { fieldManager: options.fieldManager ?? K8S_FIELD_MANAGER });
    if (result.exitCode !== 0) throw this.failure('kubectl apply', result);
  }

  async create<T = unknown>(manifest: string, options: CreateOptions = {}): Promise<CreateResult<T>> {
    const result = await this.serve('create', createCall(manifest, options));
    if (result.exitCode !== 0) {
      if (classifyKubectlFailure(result.exitCode, result.stderr) === 'AlreadyExists') return { result: 'exists' };
      throw this.failure('kubectl create', result);
    }
    return { result: 'created', object: options.json ? this.object<T>('kubectl create', result.stdout) : null };
  }

  async replace<T = unknown>(manifest: string, options: { namespace?: string } = {}): Promise<T> {
    const result = await this.serve('replace', replaceCall(manifest, options));
    if (result.exitCode !== 0) throw this.failure('kubectl replace', result);
    return this.object<T>('kubectl replace', result.stdout);
  }

  async delete(targets: string[], options: KubeDeleteOptions): Promise<void> {
    const result = await this.serve('delete', deleteCall(targets, options));
    if (result.exitCode !== 0) throw this.failure('kubectl delete', result);
  }

  async stream(
    call: Omit<KubectlCall, 'mutating' | 'stdin'>,
    handlers: { stdout(chunk: string): void; stderr(chunk: string): void },
  ): Promise<number> {
    const result = await this.serve('stream', { ...call, mutating: false });
    if (result.stdout) handlers.stdout(result.stdout);
    if (result.stderr) handlers.stderr(result.stderr);
    return result.exitCode;
  }

  async shell(call: ShellCall): Promise<KubectlResult> {
    const stdin = await collectStdin(call.stdin);
    const result = await this.serve('shell', { args: [call.script], mutating: true, stdin, guardS: call.guardS }, { script: call.script });
    if (call.onStdout && result.stdout) call.onStdout(Buffer.from(result.stdout, 'utf8'));
    if (call.onStderr) {
      for (const line of result.stderr.split(/(?<=\n)/)) if (line !== '') call.onStderr(line);
    }
    return call.onStdout ? { ...result, stdout: '' } : result;
  }

  async channel(script: string): Promise<SshChannel> {
    const call: KubectlCall = { args: [script], mutating: true };
    const recorded = this.record('channel', call, script);
    const state = this.claim(recorded);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Uint8Array[] = [];
    let settle: (value: { exitCode: number }) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const done = new Promise<{ exitCode: number }>((resolve, rejectDone) => {
      settle = resolve;
      reject = rejectDone;
    });
    done.catch(() => {});
    let finished = false;
    const end = (): void => {
      finished = true;
      stdout.end();
      stderr.end();
    };
    const finish = (exitCode: number): void => {
      if (finished) return;
      end();
      void turn().then(() => settle({ exitCode }));
    };
    const respond = async (): Promise<void> => {
      await turn();
      if (finished) return;
      recorded.stdinBytes = new Uint8Array(Buffer.concat(received.map((part) => Buffer.from(part))));
      recorded.stdinText = textOf(recorded.stdinBytes);
      recorded.call = { ...call, stdin: recorded.stdinBytes };
      try {
        const answer = await this.answer(recorded, state);
        if (answer.kind === 'hang' || finished) return;
        recorded.result = answer.result;
        if (answer.result.stdout) stdout.write(answer.result.stdout);
        if (answer.result.stderr) stderr.write(answer.result.stderr);
        finish(answer.result.exitCode);
      } catch (error) {
        if (finished) return;
        end();
        reject(error);
      }
    };
    const stdin = new Writable({
      write(chunk: unknown, _encoding, callback) {
        received.push(chunk instanceof Uint8Array ? new Uint8Array(chunk) : new Uint8Array(Buffer.from(String(chunk), 'utf8')));
        callback();
      },
      final(callback) {
        callback();
        void respond();
      },
    });
    return {
      stdin,
      stdout,
      stderr,
      done,
      close: () => {
        if (finished) return;
        recorded.closed = true;
        finish(CLOSED_CHANNEL_EXIT);
      },
    };
  }

  async interactive(script: string): Promise<number> {
    const result = await this.serve('interactive', { args: [script], mutating: true }, { script });
    return result.exitCode;
  }

  /** pure, as in the real executor: recorded but never matched against the script */
  command(args: string[], namespace?: string): string {
    const commandString = kubectlCommand(this.distribution, { args, namespace, requestTimeoutS: null });
    this.calls.push({
      method: 'command',
      call: { args, namespace, mutating: false, requestTimeoutS: null },
      commandString,
      node: this.node.name,
      stdinText: '',
      stdinBytes: new Uint8Array(),
    });
    return commandString;
  }

  // ---- matching and answers -------------------------------------------------------------------

  private record(method: KubeMethod, call: KubectlCall, script?: string, fieldManager?: string): RecordedKubeCall {
    const stdinBytes = bytesOf(call.stdin);
    const recorded: RecordedKubeCall = {
      method,
      call,
      commandString: script ?? '',
      node: this.node.name,
      stdinText: textOf(stdinBytes),
      stdinBytes,
      ...(fieldManager !== undefined ? { fieldManager } : {}),
    };
    this.calls.push(recorded);
    // the real builder applies the local guards (argv rules) before any SSH work
    if (script === undefined) recorded.commandString = kubectlCommand(this.distribution, call);
    return recorded;
  }

  private matches(state: StepState, recorded: RecordedKubeCall): boolean {
    const step = state.step;
    if (step.method !== undefined && step.method !== recorded.method) return false;
    if (recorded.method === 'command') return false;
    if (step.namespace === null && recorded.call.namespace !== undefined) return false;
    if (typeof step.namespace === 'string' && step.namespace !== recorded.call.namespace) return false;
    return matchArgs(step.args, recorded.call.args);
  }

  private findStep(recorded: RecordedKubeCall): StepState | null {
    if (this.order === 'any') return this.states.find((state) => !exhausted(state) && this.matches(state, recorded)) ?? null;
    for (let i = this.cursor; i < this.states.length; i++) {
      const state = this.states[i];
      if (!exhausted(state) && this.matches(state, recorded)) {
        this.cursor = i;
        return state;
      }
      if (state.used < required(state)) return null;
    }
    return null;
  }

  /** the row that answers, null for the cluster, or an unexpected-call error */
  private claim(recorded: RecordedKubeCall): StepState | null {
    const state = this.findStep(recorded);
    if (state) {
      state.used += 1;
      recorded.step = stepLabel(state);
      return state;
    }
    if (this.cluster) {
      recorded.step = 'cluster';
      return null;
    }
    throw this.unexpectedCall(recorded);
  }

  private unexpectedCall(recorded: RecordedKubeCall): Error {
    const where = recorded.call.namespace !== undefined ? ` in namespace ${recorded.call.namespace}` : '';
    const line = `${recorded.method}${where}: ${renderArgs(recorded.call.args)}`;
    this.unexpected.push(line);
    const closest = [...this.states]
      .map((state) => ({ state, distance: argDistance(state.step.args, recorded.call.args) }))
      .sort((a, b) => a.distance - b.distance || a.state.index - b.state.index)
      .slice(0, 3)
      .map(({ state, distance }) => {
        const ns = state.step.namespace === undefined ? '' : `, namespace ${state.step.namespace ?? '(none)'}`;
        const times = state.step.times ?? 1;
        return `    ${stepLabel(state)}: ${renderArgs(state.step.args)} (distance ${distance}${ns}, used ${state.used}/${times})`;
      });
    const next = this.order === 'strict' && this.cursor < this.states.length ? [`  next step in order: ${stepLabel(this.states[this.cursor])}`] : [];
    return new Error(
      [
        `Unexpected kubectl call on ${this.node.name}: ${line}`,
        `  command: ${recorded.commandString}`,
        ...next,
        closest.length > 0 ? '  closest steps:' : '  the script has no steps',
        ...closest,
      ].join('\n'),
    );
  }

  private problem(state: StepState, message: string): never {
    const text = `step ${stepLabel(state)}: ${message}`;
    this.problems.push(text);
    throw new Error(text);
  }

  private checkRow(state: StepState, recorded: RecordedKubeCall): void {
    const step = state.step;
    if (step.mutating !== undefined && step.mutating !== recorded.call.mutating) {
      this.problem(state, `expected mutating: ${step.mutating}, the call has mutating: ${recorded.call.mutating}`);
    }
    const expected = step.stdin;
    if (expected === undefined) return;
    if (typeof expected === 'function') {
      try {
        expected(recorded.stdinText);
      } catch (error) {
        this.problem(state, `stdin assertion failed: ${describeError(error)}`);
      }
    } else if (expected instanceof RegExp) {
      if (!expected.test(recorded.stdinText)) this.problem(state, `stdin does not match ${String(expected)}`);
    } else {
      const golden = textOf(readGolden(this.goldenRoot, expected.golden)).replace(/\r\n/g, '\n');
      if (golden !== recorded.stdinText) this.problem(state, `stdin differs from golden ${expected.golden}`);
    }
  }

  private async answer(recorded: RecordedKubeCall, state: StepState | null): Promise<Answer> {
    if (state === null) {
      const cluster = this.cluster;
      if (!cluster) throw new Error('unreachable: no cluster handler');
      const raw = await cluster.handle({
        method: recorded.method,
        call: recorded.call,
        node: this.node,
        commandString: recorded.commandString,
        stdinText: recorded.stdinText,
      });
      return { kind: 'result', result: this.redacted(raw), step: 'cluster' };
    }
    this.checkRow(state, recorded);
    const label = stepLabel(state);
    const respond = state.step.respond;
    if (typeof respond === 'function') return { kind: 'result', result: this.redacted(await respond(recorded.call, recorded)), step: label };
    if (isKubectlResult(respond)) return { kind: 'result', result: this.redacted(respond), step: label };
    if ('json' in respond) return { kind: 'result', result: { exitCode: 0, stdout: JSON.stringify(respond.json), stderr: '' }, step: label };
    if ('fixture' in respond) return { kind: 'result', result: { exitCode: 0, stdout: fixtureStdout(respond.fixture), stderr: '' }, step: label };
    if ('error' in respond) {
      const stderr = respond.stderr ?? kubectlStderrSample(respond.error);
      return { kind: 'result', result: { exitCode: errorExitCode(respond.error), stdout: '', stderr: this.redactor.redact(stderr) }, step: label };
    }
    const what = recorded.method === 'channel' || recorded.method === 'shell' || recorded.method === 'interactive'
      ? 'a shell script'
      : `kubectl ${describeArgs(recorded.call.args)}`;
    if ('transportError' in respond) {
      throw new KubeError('Unreachable', `Lost the SSH connection to ${this.node.name} during ${what}: read ECONNRESET`, this.node.name, NO_EXIT_CODE, '');
    }
    if (recorded.method === 'channel') return { kind: 'hang', step: label };
    // interactive sessions have no local guard; shell scripts carry their own
    const guardS =
      recorded.method === 'interactive' ? null : recorded.method === 'shell' ? (recorded.call.guardS ?? null) : kubectlGuardS(recorded.call);
    if (guardS === null) return new Promise<Answer>(() => {});
    if (this.clock) await this.clock.sleep(guardS * 1000);
    throw new KubeError('Timeout', `${what} did not finish within ${guardS}s on ${this.node.name}`, this.node.name, NO_EXIT_CODE, '');
  }

  private redacted(result: KubectlResult): KubectlResult {
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: this.redactor.redact(result.stderr) };
  }

  private async serve(
    method: KubeMethod,
    call: KubectlCall,
    extra: { script?: string; fieldManager?: string } = {},
  ): Promise<KubectlResult> {
    const recorded = this.record(method, call, extra.script, extra.fieldManager);
    const state = this.claim(recorded);
    await turn();
    const answer = await this.answer(recorded, state);
    if (answer.kind === 'hang') return new Promise<KubectlResult>(() => {});
    recorded.result = answer.result;
    return answer.result;
  }

  private failure(what: string, result: KubectlResult): KubeError {
    const line = firstLine(result.stderr);
    return new KubeError(
      classifyKubectlFailure(result.exitCode, result.stderr),
      `${what} failed on ${this.node.name} (exit ${result.exitCode})${line ? `: ${line}` : ''}`,
      this.node.name,
      result.exitCode,
      result.stderr,
    );
  }

  private object<T>(what: string, stdout: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new KubeError('Unknown', `${what} returned output that is not JSON on ${this.node.name}`, this.node.name, 0, '');
    }
  }
}
