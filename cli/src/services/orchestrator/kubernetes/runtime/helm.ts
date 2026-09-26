// helm over SSH on the control-plane node (DESIGN-CORE 8.5 as amended by design-04 3.5.1). Values,
// passwords and repository credentials travel on stdin or in per-call temp files, never in argv.

import { printDebug } from '../../../../utils/output';
import type { Redactor } from '../../../../utils/redact';
import { shellQuote } from '../../../../utils/ssh';
import type { ClusterNodeRef } from '../../interfaces';
import { HELM_BIN_PATH, HELM_HOME_DIR, HELM_TMP_DIR, K8S_KUBECONFIG_PATH, K8S_REQUEST_TIMEOUT_S } from '../constants';
import { type Clock, type SshTransport, systemClock } from '../deps';
import { classifyKubectlFailure, KubeError, NO_EXIT_CODE } from './errors';
import { driveChannel, firstLine, guarded, overTransport, sshTransport } from './kubectl';

export interface HelmEnvOverrides {
  /** HELM_REPOSITORY_CONFIG */
  repositoryConfig?: string;
  /** HELM_REPOSITORY_CACHE */
  repositoryCache?: string;
  /** HELM_REGISTRY_CONFIG */
  registryConfig?: string;
}

export interface HelmCall {
  args: string[];
  stdin?: string;
  mutating: boolean;
  /** the value passed as --timeout, or the expected duration of a read */
  timeoutS: number;
  /** temp-dir paths only, never credentials */
  env?: HelmEnvOverrides;
  /** return non-zero exits instead of throwing */
  allowFailure?: boolean;
}

export interface HelmResult {
  exitCode: number;
  stdout: string;
  /** redacted, see helmStderr */
  stderr: string;
}

export interface HelmExecutor {
  readonly node: ClusterNodeRef;
  run(call: HelmCall): Promise<HelmResult>;
  /** appends -o json; null on "release: not found" */
  json<T>(args: string[]): Promise<T | null>;
}

/**
 * `helm list` shows only deployed and failed releases unless told otherwise, and Helm 4 has no
 * `-a`: every status is named, so a `pending-*` or `uninstalling` release stays visible.
 */
export const HELM_LIST_EVERY_STATUS: readonly string[] = ['--deployed', '--failed', '--pending', '--superseded', '--uninstalled', '--uninstalling'];

/** every helm command string starts with this (INV-10) */
export const HELM_ENV_PREFIX = `env HELM_CACHE_HOME=${HELM_HOME_DIR}/cache HELM_CONFIG_HOME=${HELM_HOME_DIR}/config HELM_DATA_HOME=${HELM_HOME_DIR}/data`;

/** per-call temp directories created by runtime/host.ts (`mktemp -d <HELM_TMP_DIR>/call.XXXXXXXXXX`) */
const OVERRIDE_PREFIX = `${HELM_TMP_DIR}/call.`;

/** user values go through `--values -` and passwords through `--password-stdin` */
const FORBIDDEN_ARG = /^--(?:set|set-string|set-file|set-json|set-literal|password)(?:=|$)/;

/**
 * `env HELM_CACHE_HOME=.. HELM_CONFIG_HOME=.. HELM_DATA_HOME=..[ HELM_REPOSITORY_CONFIG=<q>]
 * [ HELM_REPOSITORY_CACHE=<q>][ HELM_REGISTRY_CONFIG=<q>] <helm> --kubeconfig=<path> <quoted args...>`
 */
export function helmCommand(call: Pick<HelmCall, 'args' | 'env'>): string {
  if (call.args.length === 0) throw new Error('A helm call needs at least one argument');
  for (const arg of call.args) {
    if (FORBIDDEN_ARG.test(arg)) throw new Error(`helm ${arg.split('=')[0]} is not allowed; values and passwords travel on stdin`);
  }
  const parts = [HELM_ENV_PREFIX];
  const env = call.env ?? {};
  const overrides: [string, string | undefined][] = [
    ['HELM_REPOSITORY_CONFIG', env.repositoryConfig],
    ['HELM_REPOSITORY_CACHE', env.repositoryCache],
    ['HELM_REGISTRY_CONFIG', env.registryConfig],
  ];
  for (const [name, path] of overrides) {
    if (path === undefined) continue;
    if (!path.startsWith(OVERRIDE_PREFIX) || path.split('/').includes('..')) {
      throw new Error(`${name} must point inside a per-call directory ${OVERRIDE_PREFIX}*, got ${path}`);
    }
    parts.push(`${name}=${shellQuote(path)}`);
  }
  parts.push(HELM_BIN_PATH, `--kubeconfig=${K8S_KUBECONFIG_PATH}`);
  for (const arg of call.args) parts.push(shellQuote(arg));
  return parts.join(' ');
}

/** `...Unable to get an update from the "<name>" chart repository (<url>):`, then the cause tab-indented */
const REPO_UPDATE_FAILURE = /^\.\.\.Unable to get an update from .*\n((?:\t.*\n?)+)/gm;

/**
 * The stderr of a result, before redaction. A failed `repo update` prints why a repository failed
 * on stdout and only the failed URLs on stderr, so those causes come first.
 */
export function helmStderr(args: readonly string[], raw: { exitCode: number; stdout: string; stderr: string }): string {
  if (raw.exitCode === 0 || args[0] !== 'repo' || args[1] !== 'update') return raw.stderr;
  const causes = [...raw.stdout.matchAll(REPO_UPDATE_FAILURE)].map((match) => (match[1] ?? '').replace(/^\t/gm, '').trimEnd());
  return [...causes, raw.stderr].join('\n');
}

/**
 * Local deadline. Helm's --timeout bounds each operation separately (pre hooks, resource wait, post
 * hooks, the rollback wait after a failure), and closing the channel early can leave a `pending-*`
 * release that blocks every later upgrade, hence the wide margin for mutating calls (design-04 I4).
 */
export function helmGuardS(call: Pick<HelmCall, 'mutating' | 'timeoutS'>): number {
  return call.mutating ? 4 * call.timeoutS + 120 : call.timeoutS + 60;
}

/** a `pending-*` release older than this cannot belong to a live Dockflow operation */
export function helmPendingStaleS(timeoutS: number): number {
  return 2 * helmGuardS({ mutating: true, timeoutS });
}

export interface HelmExecutorOptions {
  /** the bundle Redactor */
  redactor: Redactor;
  /** default: the SSH transport of runtime/kubectl.ts */
  transport?: SshTransport;
  /** default: systemClock */
  clock?: Clock;
}

function describeArgs(args: readonly string[]): string {
  const [first, second] = args;
  return (first === 'get' || first === 'registry' || first === 'repo') && second !== undefined
    ? `${first} ${second}`
    : (first ?? '');
}

class SshHelmExecutor implements HelmExecutor {
  private readonly redactor: Redactor;
  private readonly transport: SshTransport;
  private readonly clock: Clock;

  constructor(
    readonly node: ClusterNodeRef,
    options: HelmExecutorOptions,
  ) {
    this.redactor = options.redactor;
    this.transport = options.transport ?? sshTransport;
    this.clock = options.clock ?? systemClock;
  }

  async run(call: HelmCall): Promise<HelmResult> {
    const command = helmCommand(call);
    const what = `helm ${describeArgs(call.args)}`;
    const guardS = helmGuardS(call);
    // mutating calls are never retried; a read with stdin needs a channel as well
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
        () =>
          new KubeError(
            'Timeout',
            `${what} did not finish within ${guardS}s on ${this.node.name}; it may still be running there`,
            this.node.name,
            NO_EXIT_CODE,
            '',
          ),
      );
    } catch (error) {
      printDebug(`helm ${debugArgs} on ${this.node.name}: ${error instanceof KubeError ? error.reason : 'failed'}`);
      throw error;
    }
    const result: HelmResult = { exitCode: raw.exitCode, stdout: raw.stdout, stderr: this.redactor.redact(helmStderr(call.args, raw)) };
    printDebug(`helm ${debugArgs} on ${this.node.name}: exit ${result.exitCode}`);
    if (result.exitCode !== 0 && !call.allowFailure) throw this.failure(what, result);
    return result;
  }

  async json<T>(args: string[]): Promise<T | null> {
    const what = `helm ${describeArgs(args)}`;
    const result = await this.run({
      args: [...args, '-o', 'json'],
      mutating: false,
      timeoutS: K8S_REQUEST_TIMEOUT_S,
      allowFailure: true,
    });
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

export function createHelmExecutor(node: ClusterNodeRef, options: HelmExecutorOptions): HelmExecutor {
  return new SshHelmExecutor(node, options);
}
