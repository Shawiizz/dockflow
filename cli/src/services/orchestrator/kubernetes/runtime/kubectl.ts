// kubectl over SSH on one control-plane node (DESIGN-CORE 8.4, D21), plus the SSH transport adapter
// and the channel plumbing the helm and node-shell executors share. This directory is the only
// place that builds kubectl or helm command strings and talks to utils/ssh.

import type { Duplex, Readable, Writable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import { printDebug } from '../../../../utils/output';
import type { Redactor } from '../../../../utils/redact';
import {
  executeInteractiveSSH,
  SSHExitStatusError,
  shellQuote,
  sshExec,
  sshExecChannelUnbuffered,
} from '../../../../utils/ssh';
import type { ClusterNodeRef } from '../../interfaces';
import {
  K8S_APPLY_GUARD_S,
  K8S_APPLY_TIMEOUT_S,
  K8S_FIELD_MANAGER,
  K8S_FIELD_MANAGER_ACCESSORIES_STATE,
  K8S_FIELD_MANAGER_RELEASE_STATE,
  K8S_GUARD_MARGIN_S,
  K8S_KUBECONFIG_PATH,
  K8S_REQUEST_TIMEOUT_S,
} from '../constants';
import { type Clock, type SshChannel, type SshTransport, systemClock } from '../deps';
import type { K8sDistribution } from '../distribution';
import { classifyKubectlFailure, KubeError, NO_EXIT_CODE } from './errors';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface KubectlCall {
  /** arguments after the binary and --kubeconfig; every element is shellQuote()d by the executor */
  args: string[];
  namespace?: string;
  /** written to the exec channel, then the channel is ended */
  stdin?: string | Uint8Array;
  /** true: exec channel, never retried; false: exec with one transport retry (a channel when stdin is set) */
  mutating: boolean;
  /** adds --request-timeout=<n>s; null for streaming/waiting calls; default K8S_REQUEST_TIMEOUT_S */
  requestTimeoutS?: number | null;
  /** local deadline, closes the channel and throws KubeError('Timeout'); default requestTimeoutS + 15; null = none */
  guardS?: number | null;
  /** return non-zero results instead of throwing */
  allowFailure?: boolean;
}

export interface KubectlResult {
  exitCode: number;
  stdout: string;
  /** already redacted */
  stderr: string;
}

export interface ShellCall {
  /** a POSIX sh script run on the executor's node; kubectl invocations inside it come from command() */
  script: string;
  /** local stream piped into the channel stdin, then ended */
  stdin?: Readable | Uint8Array | string;
  /** local deadline; null = none */
  guardS: number | null;
  /** when set, stdout is delivered here and not collected into the result */
  onStdout?(chunk: Buffer): void;
  /** redacted, one complete line at a time */
  onStderr?(chunk: string): void;
}

export interface GetJsonOptions {
  namespace?: string;
  selector?: string;
  name?: string;
  names?: string[];
  allNamespaces?: boolean;
  allowNotFound?: boolean;
  ignoreNotFound?: boolean;
}

export interface ApplyOptions {
  namespace?: string;
  dryRun: boolean;
  fieldManager?: string;
}

export interface CreateOptions {
  namespace?: string;
  json?: boolean;
}

export interface KubeDeleteOptions {
  namespace?: string;
  wait: boolean;
  timeoutS?: number;
  ignoreNotFound: boolean;
  cascade?: 'background' | 'foreground';
}

export type CreateResult<T> = { result: 'created'; object: T | null } | { result: 'exists' };

export interface KubeExecutor {
  readonly node: ClusterNodeRef;
  run(call: KubectlCall): Promise<KubectlResult>;
  /**
   * `get <resources> -o json`; returns items (List or single object). `name` fetches one object,
   * `names` several in one call and, with `ignoreNotFound`, only the ones that exist.
   * `allowNotFound` turns a NotFound failure into `[]`.
   */
  getJson<T>(resources: string[], options?: GetJsonOptions): Promise<T[]>;
  /**
   * `apply --server-side --field-manager=<fieldManager ?? dockflow> --force-conflicts
   * [--dry-run=server] -f -` with manifests on stdin. Only the three Dockflow field managers exist.
   */
  apply(manifests: string, options: ApplyOptions): Promise<void>;
  /** `create -f - [-o json]`; `AlreadyExists` -> `{ result: 'exists' }` */
  create<T = unknown>(manifest: string, options?: CreateOptions): Promise<CreateResult<T>>;
  /** `replace -f - -o json`; the manifest must carry metadata.resourceVersion */
  replace<T = unknown>(manifest: string, options?: { namespace?: string }): Promise<T>;
  delete(targets: string[], options: KubeDeleteOptions): Promise<void>;
  /** streaming (logs -f, exec without TTY); handlers never throw; resolves with the exit code */
  stream(
    call: Omit<KubectlCall, 'mutating' | 'stdin'>,
    handlers: { stdout(chunk: string): void; stderr(chunk: string): void },
  ): Promise<number>;
  /** non-retrying exec channel running a shell script (pipelines such as `K exec ... | gzip > file`) */
  shell(call: ShellCall): Promise<KubectlResult>;
  /** raw channel streaming both directions (exec -i, cp, restore relay); the caller owns the lifecycle */
  channel(script: string): Promise<SshChannel>;
  /** PTY session on a dedicated SSH connection; resolves with the remote exit code */
  interactive(script: string): Promise<number>;
  /** full remote command string for the web terminal and for shell() scripts; no request timeout */
  command(args: string[], namespace?: string): string;
}

// ---------------------------------------------------------------------------
// Pure command builders (R-S2-02: FakeKubeExecutor records calls through these)
// ---------------------------------------------------------------------------

/** the only field managers Dockflow writes with (design-03 0) */
export const KUBECTL_FIELD_MANAGERS: readonly string[] = [
  K8S_FIELD_MANAGER,
  K8S_FIELD_MANAGER_RELEASE_STATE,
  K8S_FIELD_MANAGER_ACCESSORIES_STATE,
];

/**
 * `get ... -o name` is allowed for these resources only (R1): `-o json` on Secrets and ConfigMaps
 * would move every environment value over SSH just to compare names.
 */
export const KUBECTL_NAME_OUTPUT_RESOURCES: readonly string[] = [
  'secrets',
  'configmaps',
  'customresourcedefinitions',
  'customresourcedefinitions.apiextensions.k8s.io',
];

/** margin between a waiting call's own --timeout and its local guard (design-03 20: wait+30) */
const WAIT_GUARD_MARGIN_S = 30;

function outputFormat(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // what follows `--` belongs to the command run in the container
    if (arg === '--') return null;
    if (arg === '-o' || arg === '--output') return args[i + 1] ?? '';
    if (arg.startsWith('--output=')) return arg.slice('--output='.length);
    if (arg.startsWith('-o=')) return arg.slice(3);
    if (arg.startsWith('-o') && !arg.startsWith('--')) return arg.slice(2);
  }
  return null;
}

/** Local guards shared by every call; a violation is a programming error, thrown before any SSH work. */
export function assertKubectlArgs(args: readonly string[]): void {
  if (args.length === 0) throw new Error('A kubectl call needs at least one argument');
  const verb = args[0];
  const format = outputFormat(args);
  if (format === 'name') {
    const resources = (args[1] ?? '').split(',');
    const allowed =
      verb === 'api-resources' ||
      (verb === 'get' && resources.every((resource) => KUBECTL_NAME_OUTPUT_RESOURCES.includes(resource)));
    if (!allowed) {
      throw new Error(`kubectl ${verb} ${args[1] ?? ''} -o name is only allowed for secrets, configmaps and customresourcedefinitions`);
    }
  } else if (format !== null && /^(?:jsonpath|custom-columns|template|go-template-file)/.test(format)) {
    throw new Error(`kubectl -o ${format.split('=')[0]} is not allowed; read -o json and parse it`);
  } else if (format?.startsWith('go-template') && !(verb === 'get' && args[1] === 'secrets')) {
    // the one exception is the release listing, which must not move release payloads (PD-7)
    throw new Error('kubectl -o go-template is only allowed for the release listing of get secrets');
  }
  if (verb === 'apply') {
    const managers = args.filter((arg) => arg.startsWith('--field-manager='));
    const manager = managers[0]?.slice('--field-manager='.length);
    if (
      managers.length !== 1 ||
      manager === undefined ||
      !KUBECTL_FIELD_MANAGERS.includes(manager) ||
      !args.includes('--server-side') ||
      !args.includes('--force-conflicts')
    ) {
      throw new Error('kubectl apply must be --server-side --force-conflicts with one of the Dockflow field managers');
    }
  }
}

export function kubectlRequestTimeoutS(call: Pick<KubectlCall, 'requestTimeoutS'>): number | null {
  return call.requestTimeoutS === undefined ? K8S_REQUEST_TIMEOUT_S : call.requestTimeoutS;
}

export function kubectlGuardS(call: Pick<KubectlCall, 'requestTimeoutS' | 'guardS'>): number | null {
  if (call.guardS !== undefined) return call.guardS;
  const requestTimeoutS = kubectlRequestTimeoutS(call);
  return requestTimeoutS === null ? null : requestTimeoutS + K8S_GUARD_MARGIN_S;
}

/**
 * `<kubectlCommand> --kubeconfig=<path> [--request-timeout=<n>s] [-n <quoted ns>] <quoted args...>`
 */
export function kubectlCommand(
  distribution: K8sDistribution,
  call: Pick<KubectlCall, 'args' | 'namespace' | 'requestTimeoutS'>,
): string {
  assertKubectlArgs(call.args);
  const parts = [distribution.kubectlCommand, `--kubeconfig=${K8S_KUBECONFIG_PATH}`];
  const requestTimeoutS = kubectlRequestTimeoutS(call);
  if (requestTimeoutS !== null) parts.push(`--request-timeout=${requestTimeoutS}s`);
  if (call.namespace !== undefined) parts.push('-n', shellQuote(call.namespace));
  for (const arg of call.args) parts.push(shellQuote(arg));
  return parts.join(' ');
}

export function getJsonCall(resources: string[], options: GetJsonOptions = {}): KubectlCall {
  if (resources.length === 0) throw new Error('getJson needs at least one resource');
  if (options.names !== undefined && options.selector !== undefined) {
    throw new Error('getJson takes names or a selector, not both');
  }
  if (options.names !== undefined && options.name !== undefined) throw new Error('getJson takes name or names, not both');
  if (options.names !== undefined && options.names.length === 0) throw new Error('getJson names must not be empty');
  if (options.allNamespaces && options.namespace !== undefined) {
    throw new Error('getJson takes a namespace or allNamespaces, not both');
  }
  const args = ['get', resources.join(',')];
  if (options.name !== undefined) args.push(options.name);
  if (options.names !== undefined) args.push(...options.names);
  if (options.selector !== undefined) args.push('-l', options.selector);
  if (options.allNamespaces) args.push('--all-namespaces');
  if (options.ignoreNotFound) args.push('--ignore-not-found');
  args.push('-o', 'json');
  return { args, namespace: options.namespace, mutating: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function namespaceOf(document: unknown): string | undefined {
  if (!isRecord(document) || !isRecord(document.metadata)) return undefined;
  const namespace = document.metadata.namespace;
  return typeof namespace === 'string' ? namespace : undefined;
}

export function applyCall(manifests: string, options: ApplyOptions): KubectlCall {
  const fieldManager = options.fieldManager ?? K8S_FIELD_MANAGER;
  if (!KUBECTL_FIELD_MANAGERS.includes(fieldManager)) {
    throw new Error(`Field manager "${fieldManager}" is not one of ${KUBECTL_FIELD_MANAGERS.join(', ')}`);
  }
  if (options.namespace !== undefined) {
    for (const document of parseAllDocuments(manifests)) {
      if (document.errors.length > 0) continue;
      let namespace: string | undefined;
      try {
        namespace = namespaceOf(document.toJS());
      } catch {
        continue;
      }
      if (namespace !== undefined && namespace !== options.namespace) {
        throw new Error(`apply -n ${options.namespace} received an object of namespace ${namespace}`);
      }
    }
  }
  const args = ['apply', '--server-side', `--field-manager=${fieldManager}`, '--force-conflicts'];
  if (options.dryRun) args.push('--dry-run=server');
  args.push('-f', '-');
  return {
    args,
    namespace: options.namespace,
    stdin: manifests,
    // a server dry-run changes nothing, but every apply is flagged mutating (INV-01) and has stdin anyway
    mutating: true,
    requestTimeoutS: K8S_APPLY_TIMEOUT_S,
    guardS: K8S_APPLY_GUARD_S,
  };
}

export function createCall(manifest: string, options: CreateOptions = {}): KubectlCall {
  const args = ['create', '-f', '-'];
  if (options.json) args.push('-o', 'json');
  return { args, namespace: options.namespace, stdin: manifest, mutating: true };
}

export function replaceCall(manifest: string, options: { namespace?: string } = {}): KubectlCall {
  let object: unknown;
  try {
    object = parseYaml(manifest);
  } catch {
    object = undefined;
  }
  const resourceVersion = isRecord(object) && isRecord(object.metadata) ? object.metadata.resourceVersion : undefined;
  if (typeof resourceVersion !== 'string' || resourceVersion === '') {
    throw new Error('replace needs one object carrying metadata.resourceVersion (optimistic concurrency)');
  }
  return { args: ['replace', '-f', '-', '-o', 'json'], namespace: options.namespace, stdin: manifest, mutating: true };
}

export function deleteCall(targets: string[], options: KubeDeleteOptions): KubectlCall {
  if (targets.length === 0) throw new Error('delete needs at least one target');
  const args = ['delete', ...targets];
  if (options.ignoreNotFound) args.push('--ignore-not-found');
  if (options.cascade !== undefined) args.push(`--cascade=${options.cascade}`);
  args.push(`--wait=${options.wait}`);
  // --timeout bounds the wait only; a waiting delete gets no request timeout and a wider guard
  const waitS = options.wait ? options.timeoutS : undefined;
  if (waitS !== undefined) args.push(`--timeout=${waitS}s`);
  return {
    args,
    namespace: options.namespace,
    mutating: true,
    ...(waitS !== undefined ? { requestTimeoutS: null, guardS: waitS + WAIT_GUARD_MARGIN_S } : {}),
  };
}

/** items of a `-o json` read: a List's items, or the single object */
export function parseJsonItems<T>(stdout: string): T[] {
  const text = stdout.trim();
  if (text === '') return [];
  const parsed: unknown = JSON.parse(text);
  if (isRecord(parsed) && Array.isArray(parsed.items)) return parsed.items as T[];
  return [parsed as T];
}

/** `-o name` output: one `<resource>/<name>` per line */
export function parseNameList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Runtime plumbing shared by the kubectl, helm and node-shell executors
// ---------------------------------------------------------------------------

/**
 * Runs `run` under a local deadline measured on `clock`. On expiry the signal given to `run` is
 * aborted (which closes its channel) and `expired()` is thrown; whatever `run` does afterwards is
 * ignored. The deadline timer is cancelled as soon as `run` settles.
 */
export async function guarded<T>(
  clock: Clock,
  guardS: number | null,
  run: (signal: AbortSignal) => Promise<T>,
  expired: () => Error,
): Promise<T> {
  const call = new AbortController();
  const operation = run(call.signal);
  if (guardS === null) return operation;
  operation.catch(() => {});
  const timer = new AbortController();
  const deadline = clock.sleep(guardS * 1000, timer.signal).then((): Promise<never> => {
    if (timer.signal.aborted) return new Promise<never>(() => {});
    call.abort();
    throw expired();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    timer.abort();
  }
}

export interface ChannelOutput {
  exitCode: number;
  /** empty when an onStdout handler consumed it */
  stdout: Buffer;
  /** raw, not redacted */
  stderr: Buffer;
  /** the first exception thrown by a handler or by the stdin source; the channel was closed then */
  failure: { error: unknown } | null;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

/** lets data events queued before the exit status reach their listeners */
function drained(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function writeStdin(stdin: Writable, input: Readable | Uint8Array | string | undefined, fail: (error: unknown) => void): void {
  if (input === undefined) {
    stdin.end();
  } else if (typeof input === 'string' || input instanceof Uint8Array) {
    stdin.end(Buffer.from(input));
  } else {
    input.on('error', fail);
    input.pipe(stdin);
  }
}

/**
 * Feeds stdin, collects (or forwards) the output and waits for the exit status. Handler exceptions
 * never escape a data listener: the first one closes the channel and is returned in `failure`.
 * Rejects only when the transport loses the channel.
 */
export async function driveChannel(
  channel: SshChannel,
  options: {
    stdin?: Readable | Uint8Array | string;
    signal?: AbortSignal;
    onStdout?(chunk: Buffer): void;
    onStderr?(chunk: Buffer): void;
  },
): Promise<ChannelOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  // assigned from listeners; the cast keeps TypeScript from narrowing it to null
  let failure = null as { error: unknown } | null;
  const fail = (error: unknown): void => {
    if (failure !== null) return;
    failure = { error };
    channel.close();
  };
  const deliver = (handler: (chunk: Buffer) => void, chunk: Buffer): void => {
    if (failure !== null) return;
    try {
      handler(chunk);
    } catch (error) {
      fail(error);
    }
  };
  const onStdout = options.onStdout;
  const onStderr = options.onStderr;
  channel.stdout.on('data', (chunk: unknown) => {
    const bytes = toBuffer(chunk);
    if (onStdout) deliver(onStdout, bytes);
    else stdout.push(bytes);
  });
  channel.stderr.on('data', (chunk: unknown) => {
    const bytes = toBuffer(chunk);
    stderr.push(bytes);
    if (onStderr) deliver(onStderr, bytes);
  });
  // a command that exits before reading all of stdin makes later writes fail; its exit status says why
  channel.stdin.on('error', () => {});
  const abort = (): void => channel.close();
  options.signal?.addEventListener('abort', abort, { once: true });
  // a listener added to an already aborted signal never fires
  if (options.signal?.aborted) abort();
  try {
    writeStdin(channel.stdin, options.stdin, fail);
    const { exitCode } = await channel.done;
    await drained();
    return { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), failure };
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** maps a transport rejection (lost connection, refused channel) to KubeError('Unreachable') */
export async function overTransport<T>(
  node: ClusterNodeRef,
  redactor: Redactor,
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof KubeError) throw error;
    throw new KubeError(
      'Unreachable',
      `Lost the SSH connection to ${node.name} during ${what}: ${redactor.redact(errorText(error))}`,
      node.name,
      NO_EXIT_CODE,
      '',
    );
  }
}

/** first non-empty line of a (redacted) stderr, for error messages */
export function firstLine(stderr: string): string {
  return stderr.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Real transport over utils/ssh
// ---------------------------------------------------------------------------

/** the part of a utils/ssh unbuffered channel handle the adapter uses */
export interface RawSshChannel {
  stream: Duplex & { stderr: Readable; close(): void };
  /** settles on the exit status; rejects with SSHExitStatusError when the channel closed without one */
  done: Promise<{ exitCode: number }>;
}

/**
 * A channel that closes without an exit status lost its connection, unless close() was called
 * first: then no status is owed, and `done` resolves with NO_EXIT_CODE.
 */
export function toSshChannel(raw: RawSshChannel): SshChannel {
  let closedLocally = false;
  const done = raw.done.catch((error: unknown) => {
    if (closedLocally && error instanceof SSHExitStatusError) return { exitCode: NO_EXIT_CODE };
    throw error;
  });
  // a caller that abandons the channel must not turn a lost connection into an unhandled rejection
  done.catch(() => {});
  return {
    stdin: raw.stream,
    stdout: raw.stream,
    stderr: raw.stream.stderr,
    done,
    close: () => {
      closedLocally = true;
      raw.stream.close();
    },
  };
}

async function openSshChannel(node: ClusterNodeRef, command: string): Promise<SshChannel> {
  return toSshChannel(await sshExecChannelUnbuffered(node.connection, command));
}

export const sshTransport: SshTransport = {
  // sshExec cannot be cancelled; a guard only stops waiting, and --request-timeout ends the command
  async exec(node, command) {
    // a connection lost mid-command rejects and is not sent again; a signal reads as exit 255
    const result = await sshExec(node.connection, command, { requireExitStatus: true });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  },
  channel: openSshChannel,
  async stream(node, command, handlers, options) {
    const channel = await openSshChannel(node, command);
    channel.stdin.end();
    channel.stdout.on('data', (chunk: unknown) => handlers.stdout(toBuffer(chunk)));
    channel.stderr.on('data', (chunk: unknown) => handlers.stderr(toBuffer(chunk)));
    const abort = (): void => channel.close();
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    try {
      const { exitCode } = await channel.done;
      await drained();
      return exitCode;
    } finally {
      options?.signal?.removeEventListener('abort', abort);
    }
  },
  interactive: (node, command) => executeInteractiveSSH(node.connection, command),
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface KubeExecutorOptions {
  distribution: K8sDistribution;
  /** the bundle Redactor: stderr is redacted before it is stored in a result or an error */
  redactor: Redactor;
  /** default: sshTransport */
  transport?: SshTransport;
  /** default: systemClock */
  clock?: Clock;
}

/** stderr redacted line by line, so a value split across two chunks is still masked */
class LineRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  constructor(private readonly redactor: Redactor) {}

  push(chunk: Buffer): string[] {
    this.pending += this.decoder.write(chunk);
    const lines: string[] = [];
    for (let at = this.pending.indexOf('\n'); at !== -1; at = this.pending.indexOf('\n')) {
      lines.push(this.redactor.redact(this.pending.slice(0, at + 1)));
      this.pending = this.pending.slice(at + 1);
    }
    return lines;
  }

  flush(): string {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    return rest === '' ? '' : this.redactor.redact(rest);
  }
}

function describeArgs(args: readonly string[]): string {
  return args[0] === 'rollout' && args[1] !== undefined ? `rollout ${args[1]}` : (args[0] ?? '');
}

class SshKubeExecutor implements KubeExecutor {
  private readonly distribution: K8sDistribution;
  private readonly redactor: Redactor;
  private readonly transport: SshTransport;
  private readonly clock: Clock;

  constructor(
    readonly node: ClusterNodeRef,
    options: KubeExecutorOptions,
  ) {
    this.distribution = options.distribution;
    this.redactor = options.redactor;
    this.transport = options.transport ?? sshTransport;
    this.clock = options.clock ?? systemClock;
  }

  async run(call: KubectlCall): Promise<KubectlResult> {
    const command = kubectlCommand(this.distribution, call);
    const what = `kubectl ${describeArgs(call.args)}`;
    const guardS = kubectlGuardS(call);
    const viaChannel = call.mutating || call.stdin !== undefined;
    const debugArgs = this.redactor.redact(call.args.join(' '));
    let raw: { exitCode: number; stdout: string; stderr: string };
    try {
      raw = await guarded(
        this.clock,
        guardS,
        async (signal) => {
          if (!viaChannel) {
            return overTransport(this.node, this.redactor, what, () => this.transport.exec(this.node, command, { signal }));
          }
          const out = await overTransport(this.node, this.redactor, what, async () =>
            driveChannel(await this.transport.channel(this.node, command), { stdin: call.stdin, signal }),
          );
          return { exitCode: out.exitCode, stdout: out.stdout.toString('utf8'), stderr: out.stderr.toString('utf8') };
        },
        () => this.timeout(what, guardS),
      );
    } catch (error) {
      printDebug(`kubectl ${debugArgs} on ${this.node.name}: ${error instanceof KubeError ? error.reason : 'failed'}`);
      throw error;
    }
    const result: KubectlResult = { exitCode: raw.exitCode, stdout: raw.stdout, stderr: this.redactor.redact(raw.stderr) };
    printDebug(`kubectl ${debugArgs} on ${this.node.name}: exit ${result.exitCode}`);
    if (result.exitCode !== 0 && !call.allowFailure) throw this.failure(what, result);
    return result;
  }

  async getJson<T>(resources: string[], options: GetJsonOptions = {}): Promise<T[]> {
    const call = getJsonCall(resources, options);
    const what = `kubectl get ${resources.join(',')}`;
    const result = await this.run({ ...call, allowFailure: true });
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
    await this.run(applyCall(manifests, options));
  }

  async create<T = unknown>(manifest: string, options: CreateOptions = {}): Promise<CreateResult<T>> {
    const result = await this.run({ ...createCall(manifest, options), allowFailure: true });
    if (result.exitCode !== 0) {
      if (classifyKubectlFailure(result.exitCode, result.stderr) === 'AlreadyExists') return { result: 'exists' };
      throw this.failure('kubectl create', result);
    }
    return { result: 'created', object: options.json ? this.object<T>('kubectl create', result.stdout) : null };
  }

  async replace<T = unknown>(manifest: string, options: { namespace?: string } = {}): Promise<T> {
    const result = await this.run(replaceCall(manifest, options));
    return this.object<T>('kubectl replace', result.stdout);
  }

  async delete(targets: string[], options: KubeDeleteOptions): Promise<void> {
    await this.run(deleteCall(targets, options));
  }

  async stream(
    call: Omit<KubectlCall, 'mutating' | 'stdin'>,
    handlers: { stdout(chunk: string): void; stderr(chunk: string): void },
  ): Promise<number> {
    const command = kubectlCommand(this.distribution, call);
    const what = `kubectl ${describeArgs(call.args)}`;
    const guardS = kubectlGuardS(call);
    const cancel = new AbortController();
    const decoder = new StringDecoder('utf8');
    const stderrLines = new LineRedactor(this.redactor);
    // assigned from handler callbacks; the cast keeps TypeScript from narrowing it to null
    let failure = null as { error: unknown } | null;
    const deliver = (handler: (chunk: string) => void, text: string): void => {
      if (failure !== null || text === '') return;
      try {
        handler(text);
      } catch (error) {
        failure = { error };
        cancel.abort();
      }
    };
    let exitCode: number;
    try {
      exitCode = await guarded(
        this.clock,
        guardS,
        (signal) => {
          signal.addEventListener('abort', () => cancel.abort(), { once: true });
          return overTransport(this.node, this.redactor, what, () =>
            this.transport.stream(
              this.node,
              command,
              {
                stdout: (chunk) => deliver(handlers.stdout, decoder.write(chunk)),
                stderr: (chunk) => {
                  for (const line of stderrLines.push(chunk)) deliver(handlers.stderr, line);
                },
              },
              { signal: cancel.signal },
            ),
          );
        },
        () => this.timeout(what, guardS),
      );
    } catch (error) {
      if (failure !== null) throw failure.error;
      throw error;
    }
    deliver(handlers.stdout, decoder.end());
    deliver(handlers.stderr, stderrLines.flush());
    if (failure !== null) throw failure.error;
    printDebug(`kubectl ${this.redactor.redact(call.args.join(' '))} on ${this.node.name}: exit ${exitCode}`);
    return exitCode;
  }

  async shell(call: ShellCall): Promise<KubectlResult> {
    const stderrLines = new LineRedactor(this.redactor);
    const onStderr = call.onStderr;
    const out = await guarded(
      this.clock,
      call.guardS,
      async (signal) =>
        overTransport(this.node, this.redactor, 'a shell script', async () =>
          driveChannel(await this.transport.channel(this.node, call.script), {
            stdin: call.stdin,
            signal,
            onStdout: call.onStdout,
            onStderr: onStderr
              ? (chunk) => {
                  for (const line of stderrLines.push(chunk)) onStderr(line);
                }
              : undefined,
          }),
        ),
      () => this.timeout('a shell script', call.guardS),
    );
    if (out.failure !== null) throw out.failure.error;
    if (onStderr) {
      const rest = stderrLines.flush();
      if (rest !== '') onStderr(rest);
    }
    printDebug(`shell script on ${this.node.name}: exit ${out.exitCode}`);
    return {
      exitCode: out.exitCode,
      stdout: out.stdout.toString('utf8'),
      stderr: this.redactor.redact(out.stderr.toString('utf8')),
    };
  }

  async channel(script: string): Promise<SshChannel> {
    const channel = await overTransport(this.node, this.redactor, 'a channel', () =>
      this.transport.channel(this.node, script),
    );
    const done = overTransport(this.node, this.redactor, 'a channel', () => channel.done);
    done.then(
      ({ exitCode }) => printDebug(`channel on ${this.node.name}: exit ${exitCode}`),
      () => {},
    );
    return { stdin: channel.stdin, stdout: channel.stdout, stderr: channel.stderr, done, close: () => channel.close() };
  }

  async interactive(script: string): Promise<number> {
    const exitCode = await overTransport(this.node, this.redactor, 'an interactive session', () =>
      this.transport.interactive(this.node, script),
    );
    printDebug(`interactive session on ${this.node.name}: exit ${exitCode}`);
    return exitCode;
  }

  command(args: string[], namespace?: string): string {
    return kubectlCommand(this.distribution, { args, namespace, requestTimeoutS: null });
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

  private timeout(what: string, guardS: number | null): KubeError {
    return new KubeError('Timeout', `${what} did not finish within ${guardS}s on ${this.node.name}`, this.node.name, NO_EXIT_CODE, '');
  }

  private object<T>(what: string, stdout: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new KubeError('Unknown', `${what} returned output that is not JSON on ${this.node.name}`, this.node.name, 0, '');
    }
  }
}

export function createKubeExecutor(node: ClusterNodeRef, options: KubeExecutorOptions): KubeExecutor {
  return new SshKubeExecutor(node, options);
}
