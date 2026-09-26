// Kubernetes ContainerBackend (design-06 3.1-3.3, 3.9): `kubectl exec` for exec, capture, shell and
// the web terminal, `kubectl logs` with the shared --since/--tail grammar, `dockflow cp` over tar
// streams and container stats from metrics.k8s.io. Targets come from the bundle's namespace
// inventory, never from a revisions read. Backends never print, except the one dim line naming
// the pod an interactive command lands in.

import { posix } from 'path';
import { StringDecoder } from 'string_decoder';
import { PassThrough, type Readable } from 'stream';
import type { SSHKeyConnection } from '../../../../types';
import type { Redactor } from '../../../../utils/redact';
import {
  CLIError,
  ConnectionError,
  ErrorCode,
  OrchestratorUnavailableError,
  UnsupportedOperationError,
  ValidationError,
} from '../../../../utils/errors';
import { printDim } from '../../../../utils/output';
import { requireCapabilityFor } from '../../capabilities';
import { ContainerPathError, containerTarArgs, noTarError } from '../../copy';
import type {
  ContainerBackend,
  ContainerStats,
  ExecRequest,
  ExecResult,
  InstanceInfo,
  InstanceTarget,
  LogLine,
  LogSink,
  LogsOptions,
  StackRef,
  StackRole,
} from '../../interfaces';
import { K8S_TRANSPORT_FAILURES_TOLERATED, LABELS } from '../constants';
import type { Clock, KubernetesBundleDeps, SshChannel } from '../deps';
import { SEL_POD, serviceSelector } from '../labels';
import { parseQuantity } from '../model/units';
import { namespaceFor } from '../naming';
import type { ContainerStatus, Pod } from '../resources/core';
import { KubeError, kubeErrorToCliError } from '../runtime/errors';
import { firstLine, type KubectlResult, type KubeExecutor } from '../runtime/kubectl';
import {
  kubectlSinceFlag,
  kubectlTailFlag,
  type LocalOffset,
  logLinesFromOutput,
  maxLogRequestsFlag,
  mergeLogLines,
  parsePrefixedLine,
  parseSince,
  splitTimestamp,
} from '../status/logs';
import {
  defaultContainerName,
  isHelperPod,
  nodeToServerMap,
  orderInstanceTable,
  type PodOwner,
  podOwner,
  selectContainer,
  selectInstance,
  statusSummary,
  toInstanceInfo,
} from '../status/pods';
import { EMPTY_REVISIONS, type InventoryReader, type NamespaceInventory, type PodMetrics, type StackInventory } from './inventory';

// ---------------------------------------------------------------------------
// Constants and pure helpers
// ---------------------------------------------------------------------------

/** written by the exec wrapper when `cd` fails; outside the 126/127 range shells use themselves */
export const EXEC_WORKDIR_MARKER = 'DOCKFLOW_NO_WORKDIR';
export const EXEC_WORKDIR_EXIT = 125;

/**
 * `sh -c` wrapper for `--workdir` and `--env`: positional parameters only, so no value is ever
 * interpolated into the script (K63b).
 */
export const EXEC_WRAPPER_SCRIPT = `[ -n "$1" ] && { cd "$1" 2>/dev/null || { echo ${EXEC_WORKDIR_MARKER} >&2; exit ${EXEC_WORKDIR_EXIT}; }; }; shift; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do export "$1"; shift; done; shift; exec "$@"`;

/** per-pod channels a follow opens for Helm pods, shared by every release (K64a) */
export const LOG_FOLLOW_POD_CHANNELS = 8;
/** channels the pod watcher may add for new pods (OpenSSH MaxSessions is 10 per connection) */
export const LOG_WATCHER_EXTRA_CHANNELS = 6;
export const LOG_WATCH_INTERVAL_MS = 5000;
export const LOG_READ_CONCURRENCY = 4;
export const LOG_READ_GUARD_S = 300;
export const LOG_IDLE_NOTICE = '(no running pods; waiting for new ones, Ctrl+C to stop)';

const RERUN_SUGGESTION = 'Run the command again; Dockflow picks another ready manager.';
const TERMINATED_LINE = /^command terminated with exit code \d+$/;
const PREVIOUS_MISSING = /previous terminated container .* not found/;
const METRICS_UNAVAILABLE = /the server could not find the requested resource|\(ServiceUnavailable\)/;

/** `argv` behind the `--workdir`/`--env` wrapper */
export function wrapExecArgv(argv: readonly string[], workdir: string | undefined, env: Record<string, string> | undefined): string[] {
  const pairs = Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);
  return ['sh', '-c', EXEC_WRAPPER_SCRIPT, 'dockflow-exec', workdir ?? '', ...pairs, '--', ...argv];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The container runtime could not start `program` (no such binary in the image). Keyed on the
 * runtime's quoted form, never on exit 127, which a missing user binary run by a present shell
 * also produces; kubectl's exit code for the runtime failure varies across versions.
 */
export function runtimeStartFailure(stderr: string, program: string): boolean {
  return new RegExp(`exec: "${escapeRegExp(program)}": (?:executable file not found|stat )`).test(stderr);
}

/** container usage in millicores (`104311n`, `250u`, `5m`, `2`) */
export function cpuMillicores(text: string | undefined): number | null {
  const value = quantityValue(text, 3);
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

/** bytes of a memory quantity (`412Ki`, `20Mi`, `1G`, `1048576`) */
export function memoryBytes(text: string | undefined): number | null {
  const value = quantityValue(text, 0);
  return value === null ? null : Math.round(value);
}

function quantityValue(text: string | undefined, shift: number): number | null {
  if (text === undefined) return null;
  const quantity = parseQuantity(text);
  if (!quantity) return null;
  const exponent = quantity.scale + shift;
  const magnitude = exponent >= 0 ? Number(quantity.mantissa) * 10 ** exponent : Number(quantity.mantissa) / 10 ** -exponent;
  return quantity.negative ? -magnitude : magnitude;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

/** resolves once a stream ended or closed */
function endOf(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
  });
}

/** splits a byte stream into lines, UTF-8 safe across chunks */
class LineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  push(chunk: Buffer): string[] {
    this.pending += this.decoder.write(chunk);
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines;
  }

  /** the unterminated rest, '' when none */
  flush(): string {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    return rest;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function localZone(at: Date): number {
  return -at.getTimezoneOffset();
}

/** registers a Ctrl+C listener; returns its removal */
export type InterruptSource = (onInterrupt: () => void) => () => void;

export const processInterrupts: InterruptSource = (onInterrupt) => {
  process.once('SIGINT', onInterrupt);
  return () => {
    process.removeListener('SIGINT', onInterrupt);
  };
};

function containerStatusOf(pod: Pod, container: string): ContainerStatus | undefined {
  return pod.status?.containerStatuses?.find((status) => status.name === container);
}

function hasStarted(status: ContainerStatus | undefined): boolean {
  return Boolean(status?.state?.running || status?.state?.terminated || status?.lastState?.terminated);
}

function isLogTarget(pod: Pod, includeTerminated: boolean): boolean {
  if (pod.metadata.deletionTimestamp) return false;
  const phase = pod.status?.phase;
  return includeTerminated || (phase !== 'Succeeded' && phase !== 'Failed');
}

function labelsMatch(pod: Pod, expected: Record<string, string>): boolean {
  const labels = pod.metadata.labels ?? {};
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type ServiceScope =
  | { kind: 'compose'; view: NamespaceInventory; service: string; serviceName: string }
  | { kind: 'helm'; view: NamespaceInventory; service: string; workloads: string[] };

interface ResolvedTarget {
  namespace: string;
  service: string;
  pod: Pod;
  owner: PodOwner;
  container: string;
  instance: InstanceInfo;
}

interface LogPod {
  namespace: string;
  pod: Pod;
  owner: PodOwner;
  info: InstanceInfo;
}

interface LogContext {
  ref: StackRef;
  stackId: string;
  scope: ServiceScope | null;
  options: LogsOptions;
  sink: LogSink;
  /** `--since=`/`--since-time=` flag, or nothing */
  since: string[];
  tail: string;
}

export interface KubernetesContainerBackendOptions {
  deps: Pick<KubernetesBundleDeps, 'kubectl' | 'clock' | 'redactor' | 'distribution'>;
  inventory: InventoryReader;
  /** environment name, for suggestions */
  env: string;
  /** servers.yml keys of the environment: node names map back to them */
  serverNames: readonly string[];
  /** minutes east of UTC for `--since` dates without a zone; default: the CLI machine's zone */
  localOffset?: LocalOffset;
  /** Ctrl+C while following logs; default: process SIGINT */
  interrupts?: InterruptSource;
  /** the dim `(pod <name> on <node>)` line of an interactive command; default printDim */
  announce?: (text: string) => void;
}

export class KubernetesContainerBackend implements ContainerBackend {
  private readonly kubectl: KubeExecutor;
  private readonly clock: Clock;
  private readonly redactor: Redactor;
  private readonly distributionName: string;
  private readonly inventory: InventoryReader;
  private readonly env: string;
  private readonly nodeToServer: Map<string, string>;
  private readonly localOffset: LocalOffset;
  private readonly interrupts: InterruptSource;
  private readonly announce: (text: string) => void;

  constructor(options: KubernetesContainerBackendOptions) {
    this.kubectl = options.deps.kubectl;
    this.clock = options.deps.clock;
    this.redactor = options.deps.redactor;
    this.distributionName = options.deps.distribution.traits.name;
    this.inventory = options.inventory;
    this.env = options.env;
    this.nodeToServer = nodeToServerMap(options.serverNames);
    this.localOffset = options.localOffset ?? localZone;
    this.interrupts = options.interrupts ?? processInterrupts;
    this.announce = options.announce ?? printDim;
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  private commandName(ref: StackRef, command: 'exec' | 'logs'): string {
    return ref.role === 'accessory' ? `accessories ${command}` : command;
  }

  private readError(error: unknown, operation: string): unknown {
    if (!(error instanceof KubeError)) return error;
    return kubeErrorToCliError(error, { env: this.env, operation, mutating: false, distribution: this.distributionName });
  }

  private lostConnection(operation: string): ConnectionError {
    return new ConnectionError(`Lost the connection to ${this.kubectl.node.name} while ${operation}`, RERUN_SUGGESTION);
  }

  /** a lost SSH channel is a ConnectionError (2.7); any other kubectl failure is mapped as a read */
  private channelError(error: unknown, operation: string): unknown {
    if (error instanceof KubeError && error.reason === 'Unreachable') return this.lostConnection(operation);
    return this.readError(error, operation);
  }

  private async openChannel(args: string[], namespace: string, operation: string): Promise<SshChannel> {
    try {
      return await this.kubectl.channel(this.kubectl.command(args, namespace));
    } catch (error) {
      throw this.channelError(error, operation);
    }
  }

  private async interactive(args: string[], namespace: string, operation: string): Promise<number> {
    try {
      return await this.kubectl.interactive(this.kubectl.command(args, namespace));
    } catch (error) {
      throw this.channelError(error, operation);
    }
  }

  // -------------------------------------------------------------------------
  // Inventory and target resolution
  // -------------------------------------------------------------------------

  private async readStack(ref: StackRef): Promise<StackInventory> {
    try {
      return await this.inventory.read(namespaceFor(ref.project, ref.env));
    } catch (error) {
      throw this.readError(error, 'read the stack');
    }
  }

  private scopeOf(stack: StackInventory, ref: StackRef, service: string): ServiceScope {
    const record = stack.primary.composeWorkloads.get(service);
    if (record && record.role === ref.role) {
      return { kind: 'compose', view: stack.primary, service, serviceName: record.serviceName };
    }
    for (const view of stack.namespaces) {
      const release = view.helm.find((h) => h.release === service && h.role === ref.role);
      if (release) return { kind: 'helm', view, service, workloads: release.workloads.map((w) => w.name) };
    }
    const noun = ref.role === 'accessory' ? 'Accessory' : 'Service';
    throw new CLIError(
      `${noun} ${service} is not deployed in namespace ${stack.stackId}`,
      ErrorCode.SERVICE_NOT_FOUND,
      `Run \`dockflow status ${this.env}\` to see what is deployed.`,
    );
  }

  private scopePods(scope: ServiceScope, ref: StackRef, workload?: string): { pod: Pod; owner: PodOwner }[] {
    const found: { pod: Pod; owner: PodOwner }[] = [];
    for (const pod of scope.view.pods) {
      const owner = podOwner(pod, scope.view);
      if (!owner || owner.source !== scope.kind || owner.role !== ref.role || owner.service !== scope.service) continue;
      if (workload !== undefined && owner.name !== workload) continue;
      found.push({ pod, owner });
    }
    return found;
  }

  private info(pod: Pod, view: NamespaceInventory): InstanceInfo | null {
    return toInstanceInfo(pod, view, EMPTY_REVISIONS, this.nodeToServer, this.redactor);
  }

  /**
   * One running pod of the target: compose service or Helm release (a release workload named, or
   * the release's only workload), selection order of design-06 2.3, then the container.
   */
  private async resolveTarget(ref: StackRef, target: InstanceTarget): Promise<ResolvedTarget> {
    const stack = await this.readStack(ref);
    const scope = this.scopeOf(stack, ref, target.service);
    let workload: string | undefined;
    if (scope.kind === 'compose') {
      if (target.workload !== undefined) {
        throw new ValidationError(
          `${target.service}/${target.workload} names a workload, but ${target.service} is not a Helm release`,
          `Use the service name \`${target.service}\`.`,
        );
      }
    } else if (target.workload !== undefined) {
      if (!scope.workloads.includes(target.workload)) {
        throw new ValidationError(
          `Helm release ${target.service} has no workload ${target.workload}`,
          `Choose one of: \`${scope.workloads.join(', ')}\`.`,
        );
      }
      workload = target.workload;
    } else if (scope.workloads.length > 1) {
      // R-25: an arbitrary pod of a multi-workload release is not a target anyone can reason about
      throw new UnsupportedOperationError(
        `Helm release ${target.service} owns ${scope.workloads.length} workloads; name the one you mean`,
        `Run it again with \`<release>/<workload>\`: \`${scope.workloads.map((w) => `${target.service}/${w}`).join(', ')}\`.`,
      );
    } else {
      workload = scope.workloads[0];
    }
    const pods = this.scopePods(scope, ref, workload);
    const instances = pods.map((p) => this.info(p.pod, scope.view)).filter((i): i is InstanceInfo => i !== null);
    const chosen = selectInstance(instances, { service: target.service, instance: target.instance, requireReady: false, env: this.env });
    const found = pods.find((p) => p.pod.metadata.name === chosen.id);
    if (!found) throw new Error(`unreachable: instance ${chosen.id} has no pod`);
    return {
      namespace: scope.view.namespace,
      service: target.service,
      pod: found.pod,
      owner: found.owner,
      container: selectContainer(found.pod, target.container, found.owner.serviceName),
      instance: chosen,
    };
  }

  private announceTarget(resolved: ResolvedTarget): void {
    this.announce(`(pod ${resolved.pod.metadata.name} on ${resolved.instance.node ?? 'an unknown node'})`);
  }

  private execArgs(resolved: ResolvedTarget, flags: string[], argv: readonly string[]): string[] {
    return ['exec', ...flags, resolved.pod.metadata.name, '-c', resolved.container, '--', ...argv];
  }

  // -------------------------------------------------------------------------
  // exec, capture, shell, interactiveCommand
  // -------------------------------------------------------------------------

  async exec(ref: StackRef, target: InstanceTarget, request: ExecRequest): Promise<number> {
    if (request.user !== undefined) {
      requireCapabilityFor('k3s', 'execAsUser', `dockflow ${this.commandName(ref, 'exec')} --user`);
    }
    const resolved = await this.resolveTarget(ref, target);
    const wrapped = request.workdir !== undefined || Object.keys(request.env ?? {}).length > 0;
    const argv = wrapped ? wrapExecArgv(request.argv, request.workdir, request.env) : request.argv;
    // a PTY needs the process terminal; streams handed in (the API) are always driven without one
    const tty = request.tty && request.io === undefined;
    if (request.io === undefined) this.announceTarget(resolved);
    const operation = `running a command in ${resolved.service}`;
    if (tty) return this.interactive(this.execArgs(resolved, ['-i', '-t'], argv), resolved.namespace, operation);
    const outcome = await this.pipeExec(resolved, argv, request, wrapped, operation);
    if (wrapped && outcome.exitCode === EXEC_WORKDIR_EXIT && outcome.sawMarker) {
      const workdir = request.workdir ?? '';
      throw new ValidationError(
        `--workdir ${workdir} does not exist in ${resolved.service}`,
        `Check the path with: \`dockflow ${this.commandName(ref, 'exec')} ${this.env} ${resolved.service} -- ls ${posix.dirname(workdir)}\`.`,
      );
    }
    if (wrapped && outcome.shellMissing) {
      // R-20
      throw new UnsupportedOperationError(
        `--workdir and --env require /bin/sh in the container on orchestrator: ${this.distributionName}`,
        'Run the command without `--workdir` and `--env`.',
      );
    }
    return outcome.exitCode;
  }

  /** non-TTY exec over a channel; kubectl's own `command terminated` line and the wrapper's marker are not forwarded */
  private async pipeExec(
    resolved: ResolvedTarget,
    argv: readonly string[],
    request: ExecRequest,
    wrapped: boolean,
    operation: string,
  ): Promise<{ exitCode: number; sawMarker: boolean; shellMissing: boolean }> {
    const io: NonNullable<ExecRequest['io']> = request.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
    const channel = await this.openChannel(this.execArgs(resolved, request.stdin ? ['-i'] : [], argv), resolved.namespace, operation);
    let sawMarker = false;
    let shellMissing = false;
    const forward = (line: string, terminated: boolean): void => {
      const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (TERMINATED_LINE.test(bare)) return;
      if (wrapped && bare === EXEC_WORKDIR_MARKER) {
        sawMarker = true;
        return;
      }
      if (wrapped && runtimeStartFailure(bare, 'sh')) {
        shellMissing = true;
        return;
      }
      io.stderr.write(terminated ? `${line}\n` : line);
    };
    const stderrLines = new LineBuffer();
    channel.stdout.pipe(io.stdout, { end: false });
    channel.stderr.on('data', (chunk: unknown) => {
      for (const line of stderrLines.push(toBuffer(chunk))) forward(line, true);
    });
    const output = Promise.all([endOf(channel.stdout), endOf(channel.stderr)]);
    // a command that exits before reading all of its input makes later writes fail; its exit status says why
    channel.stdin.on('error', () => {});
    if (request.stdin) io.stdin.pipe(channel.stdin);
    else channel.stdin.end();
    try {
      const { exitCode } = await channel.done;
      await output;
      const rest = stderrLines.flush();
      if (rest !== '') forward(rest, false);
      return { exitCode, sawMarker, shellMissing };
    } catch (error) {
      throw this.channelError(error, operation);
    } finally {
      channel.stdout.unpipe(io.stdout);
      if (request.stdin) {
        io.stdin.unpipe(channel.stdin);
        // an unpiped process stdin still holds the event loop open
        if (request.io === undefined) process.stdin.pause();
      }
    }
  }

  async capture(ref: StackRef, target: InstanceTarget, argv: string[]): Promise<ExecResult> {
    return this.captureOn(await this.resolveTarget(ref, target), argv);
  }

  /** buffered, read-only probes: one transport retry allowed */
  private async captureOn(resolved: ResolvedTarget, argv: readonly string[]): Promise<ExecResult> {
    try {
      const result = await this.kubectl.run({
        args: this.execArgs(resolved, [], argv),
        namespace: resolved.namespace,
        mutating: false,
        allowFailure: true,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      throw this.channelError(error, `running a command in ${resolved.service}`);
    }
  }

  async shell(ref: StackRef, target: InstanceTarget, shell: 'auto' | '/bin/sh' | '/bin/bash'): Promise<number> {
    const resolved = await this.resolveTarget(ref, target);
    this.announceTarget(resolved);
    const path = await this.shellPath(ref, resolved, shell);
    return this.interactive(this.execArgs(resolved, ['-i', '-t'], [path]), resolved.namespace, `running a shell in ${resolved.service}`);
  }

  /**
   * `auto` asks the container for bash, else sh; a named shell is probed too, because a PTY
   * session's own error never reaches Dockflow. The runtime's start failure is R-18.
   */
  private async shellPath(ref: StackRef, resolved: ResolvedTarget, shell: 'auto' | '/bin/sh' | '/bin/bash'): Promise<string> {
    const auto = shell === 'auto';
    const probe = await this.captureOn(resolved, auto ? ['sh', '-c', 'command -v bash || command -v sh'] : [shell, '-c', 'exit 0']);
    if (runtimeStartFailure(probe.stderr, auto ? 'sh' : shell)) {
      throw new CLIError(
        `Service ${resolved.service} has no shell (${auto ? '/bin/sh' : shell} not found in the image)`,
        ErrorCode.CONTAINER_NOT_FOUND,
        `Run a binary directly: \`dockflow ${this.commandName(ref, 'exec')} ${this.env} ${resolved.service} -- <binary> <args>\`.`,
      );
    }
    if (!auto) return shell;
    const found = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('/'));
    return found ?? '/bin/sh';
  }

  async interactiveCommand(
    ref: StackRef,
    target: InstanceTarget,
    shell: '/bin/sh' | '/bin/bash',
  ): Promise<{ connection: SSHKeyConnection; command: string }> {
    const resolved = await this.resolveTarget(ref, target);
    return {
      connection: this.kubectl.node.connection,
      command: this.kubectl.command(this.execArgs(resolved, ['-i', '-t'], [shell]), resolved.namespace),
    };
  }

  // -------------------------------------------------------------------------
  // cp
  // -------------------------------------------------------------------------

  private copyFailure(stderr: string, exitCode: number, subject: string, path: string, service: string): ContainerPathError {
    const shown = path.endsWith('/.') ? path.slice(0, -2) || '/' : path;
    if (runtimeStartFailure(stderr, 'tar') || exitCode === 126 || exitCode === 127) return noTarError(service);
    if (/no such file or directory/i.test(stderr)) return new ContainerPathError(`Path ${shown} does not exist in ${service}`, 'not-found');
    if (/not a directory/i.test(stderr)) return new ContainerPathError(`Path ${shown} in ${service} is not a directory`, 'not-a-directory');
    const detail = firstLine(
      stderr
        .split(/\r?\n/)
        .filter((line) => !TERMINATED_LINE.test(line.trim()))
        .join('\n'),
    );
    return new ContainerPathError(`${subject} failed: ${detail || `exit ${exitCode}`}`, 'other');
  }

  /**
   * `tar cf - -C <dir> <entry>` in the container (`<dir>/.` archives the entries). The exit status
   * comes after the data, so the stream ends only once it is 0 and otherwise errors with a
   * ContainerPathError; a reader that stops early releases the channel.
   */
  async copyOut(ref: StackRef, target: InstanceTarget, path: string): Promise<Readable> {
    const resolved = await this.resolveTarget(ref, target);
    const operation = `copying ${path} out of ${resolved.service}`;
    const channel = await this.openChannel(
      this.execArgs(resolved, [], ['tar', 'cf', '-', ...containerTarArgs(path)]),
      resolved.namespace,
      operation,
    );
    channel.stdin.end();
    const decoder = new StringDecoder('utf8');
    let stderr = '';
    channel.stderr.on('data', (chunk: unknown) => {
      stderr += decoder.write(toBuffer(chunk));
    });
    const archive = new PassThrough();
    channel.stdout.pipe(archive, { end: false });
    let settled = false;
    archive.once('close', () => {
      if (settled) return;
      channel.close();
      channel.stdout.resume();
    });
    Promise.all([channel.done, endOf(channel.stdout), endOf(channel.stderr)]).then(
      ([{ exitCode }]) => {
        settled = true;
        if (exitCode === 0) archive.end();
        else {
          const text = this.redactor.redact(stderr + decoder.end());
          archive.destroy(this.copyFailure(text, exitCode, `Copying ${path} out of ${resolved.service}`, path, resolved.service));
        }
      },
      (error: unknown) => {
        settled = true;
        const mapped = this.channelError(error, operation);
        archive.destroy(mapped instanceof Error ? mapped : new Error(String(mapped)));
      },
    );
    return archive;
  }

  /** `tar xf - -C <destDir>` in the container with the local archive on stdin, bytes unchanged */
  async copyIn(ref: StackRef, target: InstanceTarget, destDir: string, archive: Readable): Promise<void> {
    const resolved = await this.resolveTarget(ref, target);
    const operation = `copying into ${destDir} of ${resolved.service}`;
    const channel = await this.openChannel(
      this.execArgs(resolved, ['-i'], ['tar', 'xf', '-', '-C', destDir]),
      resolved.namespace,
      operation,
    );
    const decoder = new StringDecoder('utf8');
    let stderr = '';
    channel.stderr.on('data', (chunk: unknown) => {
      stderr += decoder.write(toBuffer(chunk));
    });
    channel.stdout.resume();
    const localFailure = new Promise<never>((_, reject) => {
      archive.once('error', (error) => {
        channel.close();
        reject(error);
      });
    });
    localFailure.catch(() => {});
    // a tar that fails early stops reading; its exit status and stderr say why
    channel.stdin.on('error', () => {});
    archive.pipe(channel.stdin);
    const remote = Promise.all([channel.done, endOf(channel.stdout), endOf(channel.stderr)]).then(
      ([{ exitCode }]) => exitCode,
      (error: unknown) => {
        throw this.channelError(error, operation);
      },
    );
    const exitCode = await Promise.race([remote, localFailure]);
    if (exitCode !== 0) {
      const text = this.redactor.redact(stderr + decoder.end());
      throw this.copyFailure(text, exitCode, `Copying into ${destDir} of ${resolved.service}`, destDir, resolved.service);
    }
  }

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  private async readMetrics(namespace: string): Promise<PodMetrics[]> {
    try {
      return await this.inventory.podMetrics(namespace);
    } catch (error) {
      if (error instanceof KubeError && METRICS_UNAVAILABLE.test(error.stderr)) {
        const name = this.distributionName;
        throw new OrchestratorUnavailableError(
          `metrics-server is not available on ${this.kubectl.node.name}`,
          `${name} runs metrics-server by default; check it with \`dockflow ssh ${this.env}\`, then \`${name} kubectl -n kube-system get deploy metrics-server\`.`,
          error,
        );
      }
      throw this.readError(error, 'read pod metrics');
    }
  }

  /** compose service or Helm release of a pod, from its owner or, for an unindexed one, its pod labels */
  private statsOwner(pod: Pod, view: NamespaceInventory, stackId: string): { service: string; role: StackRole } | null {
    const owner = podOwner(pod, view);
    if (owner) return owner.role === null ? null : { service: owner.service, role: owner.role };
    const labels = pod.metadata.labels ?? {};
    const role = labels[LABELS.role];
    if (labels[LABELS.stack] !== stackId || (role !== 'app' && role !== 'accessory')) return null;
    const serviceName = labels[LABELS.service];
    const record = [...view.composeWorkloads.values()].find((r) => r.serviceName === serviceName);
    return { service: record?.service ?? serviceName ?? pod.metadata.name, role };
  }

  /**
   * One metrics read per namespace and bundle, joined with the inventory and kept for the ref's
   * role only: `details` never lists the other role, chart pods of the other role or helper pods
   * (K63a). Pods without metrics yet are left out.
   */
  async stats(ref: StackRef): Promise<ContainerStats[]> {
    const stack = await this.readStack(ref);
    const views = stack.namespaces.filter((view) => view === stack.primary || view.helm.some((h) => h.role === ref.role));
    const metrics = await Promise.all(views.map((view) => this.readMetrics(view.namespace)));
    const rows: ContainerStats[] = [];
    views.forEach((view, index) => {
      for (const item of metrics[index]) {
        const pod = view.pods.find((p) => p.metadata.name === item.metadata.name);
        if (!pod || isHelperPod(pod)) continue;
        const owned = this.statsOwner(pod, view, stack.stackId);
        if (!owned || owned.role !== ref.role) continue;
        const nodeName = pod.spec.nodeName;
        const node = nodeName ? (this.nodeToServer.get(nodeName) ?? nodeName) : null;
        for (const container of item.containers) {
          const spec = pod.spec.containers.find((c) => c.name === container.name);
          rows.push({
            service: owned.service,
            role: owned.role,
            instance: pod.metadata.name,
            container: container.name,
            node,
            cpuMilli: cpuMillicores(container.usage.cpu),
            memoryBytes: memoryBytes(container.usage.memory),
            memoryLimitBytes: memoryBytes(spec?.resources?.limits?.memory),
            netIO: null,
            blockIO: null,
          });
        }
      }
    });
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return rows.sort((a, b) => compare(a.service, b.service) || compare(a.instance, b.instance) || compare(a.container, b.container));
  }

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------

  /** pods of the target (one service, one release or the whole role), in the table order */
  private logPods(stack: StackInventory, ref: StackRef, scope: ServiceScope | null): LogPod[] {
    const found: LogPod[] = [];
    for (const view of scope ? [scope.view] : stack.namespaces) {
      for (const pod of view.pods) {
        const owner = podOwner(pod, view);
        if (!owner || owner.role !== ref.role) continue;
        if (scope && (owner.source !== scope.kind || owner.service !== scope.service)) continue;
        const info = this.info(pod, view);
        if (info) found.push({ namespace: view.namespace, pod, owner, info });
      }
    }
    const order = orderInstanceTable(found.map((p) => p.info));
    return order.map((info) => found.find((p) => p.info === info)).filter((p): p is LogPod => p !== undefined);
  }

  /**
   * Container of a pod: a service or release target applies `selectContainer` (asking for
   * `--container` when a chart pod has several); the whole role takes kubectl's default and leaves
   * out pods without a requested container.
   */
  private logContainer(pod: LogPod, requested: string | undefined, strict: boolean): string | null {
    const names = pod.pod.spec.containers.map((c) => c.name);
    if (strict) return selectContainer(pod.pod, requested, pod.owner.serviceName);
    if (requested !== undefined) return names.includes(requested) ? requested : null;
    return defaultContainerName(names, pod.pod.metadata.annotations, pod.owner.serviceName) ?? names[0] ?? null;
  }

  async streamLogs(ref: StackRef, service: string | null, options: LogsOptions, sink: LogSink): Promise<void> {
    // a bad --since is refused before any remote work
    const since = options.since === undefined ? [] : [kubectlSinceFlag(parseSince(options.since, this.localOffset))];
    const stack = await this.readStack(ref);
    const scope = service === null ? null : this.scopeOf(stack, ref, service);
    const all = this.logPods(stack, ref, scope);
    let pods: LogPod[];
    if (options.instance !== undefined) {
      const hit = all.find((p) => p.pod.metadata.name === options.instance);
      if (!hit) {
        const owner = service === null ? `the ${ref.role} role` : `service ${service}`;
        throw new ValidationError(
          `Instance ${options.instance} does not belong to ${owner}`,
          all.length > 0 ? `Choose one of: \`${all.map((p) => p.pod.metadata.name).join(', ')}\`.` : undefined,
        );
      }
      pods = [hit];
    } else {
      // a Job's pods have all terminated once it ran: its logs are those runs
      pods = all.filter((p) => isLogTarget(p.pod, options.includeTerminated || p.owner.kind === 'Job'));
    }
    // only a whole-role follow waits for pods to appear
    if (pods.length === 0 && scope !== null) {
      throw new CLIError(
        `Service ${scope.service} has no running instance (${statusSummary(all.map((p) => p.info))})`,
        ErrorCode.CONTAINER_NOT_FOUND,
        `Add \`--all-tasks\` to include terminated instances, or run \`dockflow diagnose ${this.env}\`.`,
      );
    }
    const context: LogContext = {
      ref,
      stackId: stack.stackId,
      scope,
      options,
      sink,
      since,
      tail: kubectlTailFlag(options.tail),
    };
    if (!options.follow) {
      await this.readLogs(context, pods);
      return;
    }
    const follower = new LogFollower(
      {
        kubectl: this.kubectl,
        clock: this.clock,
        redactor: this.redactor,
        interrupts: this.interrupts,
        openChannel: (args, namespace) => this.openChannel(args, namespace, 'following logs'),
        channelError: (error) => this.channelError(error, 'following logs'),
        lostConnection: () => this.lostConnection('following logs'),
        logContainer: (pod, requested, strict) => this.logContainer(pod, requested, strict),
        info: (pod, view) => this.info(pod, view),
        env: this.env,
        command: this.commandName(ref, 'logs'),
      },
      context,
      stack,
    );
    await follower.run(pods, all);
  }

  private async runLogs(args: string[], namespace: string): Promise<KubectlResult> {
    try {
      return await this.kubectl.run({
        args,
        namespace,
        mutating: false,
        requestTimeoutS: null,
        guardS: LOG_READ_GUARD_S,
        allowFailure: true,
      });
    } catch (error) {
      throw this.channelError(error, 'reading logs');
    }
  }

  private async readLogs(context: LogContext, pods: LogPod[]): Promise<void> {
    const { sink, ref } = context;
    if (pods.length === 0) {
      sink.warn(`No ${ref.role === 'app' ? 'application' : 'accessory'} pod is running in namespace ${context.stackId}`);
      return;
    }
    const streams = await mapLimit(pods, LOG_READ_CONCURRENCY, (pod) => this.readPodLogs(context, pod));
    for (const line of mergeLogLines(streams)) sink.line(line);
  }

  private async readPodLogs(context: LogContext, pod: LogPod): Promise<LogLine[]> {
    const { options, sink } = context;
    const container = this.logContainer(pod, options.container, context.scope !== null);
    if (container === null) return [];
    const status = containerStatusOf(pod.pod, container);
    if (!hasStarted(status)) {
      sink.warn(`${pod.info.label} is waiting (${pod.info.status}); no logs yet`);
      return [];
    }
    const name = pod.pod.metadata.name;
    const source = { service: pod.owner.service, instance: name };
    const base = ['logs', name, '-c', container];
    const lines: LogLine[] = [];
    if (options.includeTerminated && (status?.restartCount ?? 0) > 0) {
      const previous = await this.runLogs([...base, '--previous', '--timestamps', context.tail, ...context.since], pod.namespace);
      if (previous.exitCode === 0) lines.push(...logLinesFromOutput(previous.stdout, source));
      else if (!PREVIOUS_MISSING.test(previous.stderr)) {
        sink.warn(`Could not read the previous run of ${pod.info.label}: ${firstLine(previous.stderr) || `exit ${previous.exitCode}`}`);
      }
    }
    const current = await this.runLogs([...base, '--timestamps', context.tail, ...context.since], pod.namespace);
    if (current.exitCode === 0) lines.push(...logLinesFromOutput(current.stdout, source));
    else sink.warn(`Could not read the logs of ${pod.info.label}: ${firstLine(current.stderr) || `exit ${current.exitCode}`}`);
    return lines;
  }
}

// ---------------------------------------------------------------------------
// logs --follow
// ---------------------------------------------------------------------------

interface FollowDeps {
  kubectl: KubeExecutor;
  clock: Clock;
  redactor: Redactor;
  interrupts: InterruptSource;
  openChannel(args: string[], namespace: string): Promise<SshChannel>;
  channelError(error: unknown): unknown;
  lostConnection(): ConnectionError;
  logContainer(pod: LogPod, requested: string | undefined, strict: boolean): string | null;
  info(pod: Pod, view: NamespaceInventory): InstanceInfo | null;
  env: string;
  /** `logs` or `accessories logs`, for suggestions */
  command: string;
}

/**
 * One follow session: a prefixed selector channel for Dockflow's pods, per-pod channels for Helm
 * pods (8 at most, shared by every release) and a pod watcher polling every 5 s that opens a
 * channel for each new pod (6 at most). Ctrl+C closes every channel and resolves; a lost channel
 * rejects with a ConnectionError. Nothing a line or warning does can throw into a stream listener.
 */
class LogFollower {
  private readonly stop = new AbortController();
  private readonly channels = new Set<SshChannel>();
  private readonly ends: Promise<void>[] = [];
  private failure: unknown = null;
  /** `<namespace>/<pod>` followed by a channel already */
  private readonly seen = new Set<string>();
  /** `<namespace>/<pod>` -> compose service or release */
  private readonly services = new Map<string, string>();
  private live = 0;
  private extraOpened = 0;
  private extraWarned = false;
  private idleNoticed = false;
  private transientFailures = 0;

  constructor(
    private readonly deps: FollowDeps,
    private readonly context: LogContext,
    private readonly stack: StackInventory,
  ) {}

  private key(namespace: string, pod: string): string {
    return `${namespace}/${pod}`;
  }

  private warn(message: string): void {
    try {
      this.context.sink.warn(message);
    } catch {
      // a sink never breaks the stream
    }
  }

  private emit(line: LogLine): void {
    try {
      this.context.sink.line(line);
    } catch {
      // a sink never breaks the stream
    }
  }

  private fail(error: unknown): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.stop.abort();
  }

  private aborted(): Promise<void> {
    const signal = this.stop.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  async run(pods: LogPod[], all: LogPod[]): Promise<void> {
    for (const pod of all) this.services.set(this.key(pod.namespace, pod.pod.metadata.name), pod.owner.service);
    const unsubscribe = this.deps.interrupts(() => this.stop.abort());
    try {
      if (this.context.options.instance !== undefined) {
        await this.followInstance(pods[0]);
      } else {
        await this.start(pods);
        await this.watch();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      unsubscribe();
      for (const channel of this.channels) channel.close();
      await Promise.all(this.ends);
    }
    if (this.failure !== null) throw this.failure;
  }

  /** a picked pod: one unprefixed channel, done when it ends */
  private async followInstance(pod: LogPod | undefined): Promise<void> {
    if (!pod) return;
    const container = this.deps.logContainer(pod, this.context.options.container, true);
    if (container === null) return;
    if (!hasStarted(containerStatusOf(pod.pod, container))) {
      this.warn(`${pod.info.label} is waiting (${pod.info.status}); no logs yet`);
      return;
    }
    const name = pod.pod.metadata.name;
    const { ended } = await this.open(
      ['logs', '-f', name, '-c', container, '--timestamps', this.context.tail, ...this.context.since],
      pod.namespace,
      { service: pod.owner.service, pod: name },
    );
    await Promise.race([ended, this.aborted()]);
  }

  private startedContainer(pod: LogPod, strict: boolean): string | null {
    const container = this.deps.logContainer(pod, this.context.options.container, strict);
    if (container === null || !hasStarted(containerStatusOf(pod.pod, container))) return null;
    return container;
  }

  private async start(pods: LogPod[]): Promise<void> {
    const { scope, ref, stackId, options } = this.context;
    const primary = this.stack.primary.namespace;
    if (scope === null || scope.kind === 'compose') {
      const expected: Record<string, string> =
        scope === null
          ? { [LABELS.stack]: stackId, [LABELS.role]: ref.role }
          : { [LABELS.stack]: stackId, [LABELS.service]: scope.serviceName };
      const matched = this.stack.primary.pods.filter((pod) => !pod.metadata.deletionTimestamp && labelsMatch(pod, expected));
      const followed = pods.filter((p) => p.owner.source === 'compose' && this.startedContainer(p, false) !== null);
      if (followed.length > 0) {
        const selector = scope === null ? SEL_POD(stackId, ref.role) : serviceSelector(stackId, scope.serviceName);
        const container = scope === null ? options.container : (options.container ?? scope.serviceName);
        for (const pod of followed) this.seen.add(this.key(pod.namespace, pod.pod.metadata.name));
        await this.open(
          [
            'logs',
            '-f',
            '-l',
            selector,
            ...(container !== undefined ? ['-c', container] : []),
            '--prefix',
            '--timestamps',
            this.context.tail,
            maxLogRequestsFlag(matched.length),
            '--ignore-errors',
            ...this.context.since,
          ],
          primary,
          { service: scope?.service ?? '', pod: null },
        );
      }
    }
    if (scope === null || scope.kind === 'helm') await this.startHelm(pods, scope === null);
    if (this.live === 0) this.idle();
  }

  /** per-pod channels for chart pods, which carry no Dockflow selector labels (K64a) */
  private async startHelm(pods: LogPod[], wholeRole: boolean): Promise<void> {
    const helmPods = pods.filter((p) => p.owner.source === 'helm');
    const startable = helmPods
      .map((pod) => ({ pod, container: this.startedContainer(pod, !wholeRole) }))
      .filter((entry): entry is { pod: LogPod; container: string } => entry.container !== null);
    if (wholeRole) {
      for (const view of this.stack.namespaces) {
        for (const release of view.helm) {
          if (release.role !== this.context.ref.role) continue;
          if (!startable.some((entry) => entry.pod.owner.service === release.release)) {
            this.warn(`Helm release ${release.release} has no running pod yet; its logs are followed once one starts`);
          }
        }
      }
    }
    if (startable.length > LOG_FOLLOW_POD_CHANNELS) {
      this.warn(
        wholeRole
          ? `Following the first ${LOG_FOLLOW_POD_CHANNELS} of ${startable.length} Helm pods; name a release with \`dockflow ${this.deps.command} ${this.deps.env} <release> -f\``
          : `Following the first ${LOG_FOLLOW_POD_CHANNELS} of ${startable.length} pods; name one with \`--pick\``,
      );
    }
    for (const { pod, container } of startable.slice(0, LOG_FOLLOW_POD_CHANNELS)) {
      const name = pod.pod.metadata.name;
      this.seen.add(this.key(pod.namespace, name));
      await this.open(
        ['logs', '-f', name, '-c', container, '--timestamps', this.context.tail, ...this.context.since],
        pod.namespace,
        { service: pod.owner.service, pod: name },
      );
    }
    // pods beyond the budget are not picked up by the watcher either
    for (const { pod } of startable.slice(LOG_FOLLOW_POD_CHANNELS)) this.seen.add(this.key(pod.namespace, pod.pod.metadata.name));
  }

  private idle(): void {
    if (this.idleNoticed) return;
    this.idleNoticed = true;
    this.warn(LOG_IDLE_NOTICE);
  }

  /** opens a follow channel; resolves once it is open, with its end (wrapped: an async function would wait for it) */
  private async open(args: string[], namespace: string, source: { service: string; pod: string | null }): Promise<{ ended: Promise<void> }> {
    const channel = await this.deps.openChannel(args, namespace);
    this.channels.add(channel);
    this.live += 1;
    this.idleNoticed = false;
    channel.stdin.end();
    const out = new LineBuffer();
    const err = new LineBuffer();
    const onOut = (line: string): void => {
      const parsed = this.toLine(line, namespace, source);
      if (parsed) this.emit(parsed);
    };
    const onErr = (line: string): void => {
      const text = this.deps.redactor.redact(line.trim());
      if (text !== '') this.warn(text);
    };
    channel.stdout.on('data', (chunk: unknown) => {
      for (const line of out.push(toBuffer(chunk))) onOut(line);
    });
    channel.stderr.on('data', (chunk: unknown) => {
      for (const line of err.push(toBuffer(chunk))) onErr(line);
    });
    const ended = Promise.all([channel.done, endOf(channel.stdout), endOf(channel.stderr)]).then(
      () => undefined,
      (error: unknown) => {
        if (!this.stop.signal.aborted) this.fail(this.deps.channelError(error));
      },
    );
    const settled = ended.then(() => {
      onOut(out.flush());
      onErr(err.flush());
      this.live -= 1;
      this.channels.delete(channel);
    });
    this.ends.push(settled);
    return { ended: settled };
  }

  private toLine(line: string, namespace: string, source: { service: string; pod: string | null }): LogLine | null {
    if (line.trim() === '') return null;
    const prefixed = parsePrefixedLine(line);
    if (prefixed) {
      const service = this.services.get(this.key(namespace, prefixed.pod)) ?? (source.service || prefixed.pod);
      return { service, instance: prefixed.pod, text: prefixed.text, timestamp: prefixed.timestamp };
    }
    return { service: source.service, instance: source.pod ?? '', ...splitTimestamp(line) };
  }

  /** where the watcher looks for new pods */
  private watchedSelectors(): { view: NamespaceInventory; selector: string }[] {
    const { scope, ref, stackId } = this.context;
    const primary = this.stack.primary;
    const releaseSelector = (release: string): string => `${LABELS.instance}=${release}`;
    if (scope?.kind === 'compose') return [{ view: primary, selector: serviceSelector(stackId, scope.serviceName) }];
    if (scope?.kind === 'helm') return [{ view: scope.view, selector: releaseSelector(scope.service) }];
    const selectors = [{ view: primary, selector: SEL_POD(stackId, ref.role) }];
    for (const view of this.stack.namespaces) {
      for (const release of view.helm) {
        if (release.role === ref.role) selectors.push({ view, selector: releaseSelector(release.release) });
      }
    }
    return selectors;
  }

  /** pods of the target currently known to the API server; null after a tolerated failure */
  private async poll(): Promise<{ pod: LogPod; view: NamespaceInventory }[] | null> {
    const { scope, ref } = this.context;
    const found: { pod: LogPod; view: NamespaceInventory }[] = [];
    try {
      for (const { view, selector } of this.watchedSelectors()) {
        const pods = await this.deps.kubectl.getJson<Pod>(['pods'], { namespace: view.namespace, selector });
        for (const pod of pods) {
          if (pod.metadata.deletionTimestamp || isHelperPod(pod)) continue;
          const owner = podOwner(pod, view);
          if (!owner || owner.role !== ref.role) continue;
          if (scope && (owner.source !== scope.kind || owner.service !== scope.service)) continue;
          const info = this.deps.info(pod, view);
          if (info) found.push({ pod: { namespace: view.namespace, pod, owner, info }, view });
        }
      }
    } catch (error) {
      if (error instanceof KubeError && (error.reason === 'Unreachable' || error.reason === 'Timeout')) {
        this.transientFailures += 1;
        if (this.transientFailures > K8S_TRANSPORT_FAILURES_TOLERATED) this.fail(this.deps.lostConnection());
        return null;
      }
      this.fail(this.deps.channelError(error));
      return null;
    }
    this.transientFailures = 0;
    return found;
  }

  private async watch(): Promise<void> {
    const signal = this.stop.signal;
    while (!signal.aborted) {
      await this.deps.clock.sleep(LOG_WATCH_INTERVAL_MS, signal);
      if (signal.aborted) return;
      const polled = await this.poll();
      if (polled === null || signal.aborted) continue;
      let running = 0;
      for (const { pod } of polled) {
        const container = this.startedContainer(pod, false);
        if (container === null) continue;
        running += 1;
        const name = pod.pod.metadata.name;
        const key = this.key(pod.namespace, name);
        this.services.set(key, pod.owner.service);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (this.extraOpened >= LOG_WATCHER_EXTRA_CHANNELS) {
          if (!this.extraWarned) {
            this.extraWarned = true;
            this.warn(`More than ${LOG_WATCHER_EXTRA_CHANNELS} new pods appeared; run the command again to follow them`);
          }
          continue;
        }
        this.extraOpened += 1;
        const startTime = pod.pod.status?.startTime;
        await this.open(
          ['logs', '-f', name, '-c', container, '--prefix', '--timestamps', ...(startTime ? [`--since-time=${startTime}`] : [])],
          pod.namespace,
          { service: pod.owner.service, pod: name },
        );
      }
      if (this.live === 0 && running === 0) this.idle();
    }
  }
}
