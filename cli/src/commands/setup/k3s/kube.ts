// hostKubeExecutor (design-05 4.0): the core KubeExecutor whose transport is the HostRunner argv
// `/usr/local/bin/k3s kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml ...` on the node itself, for
// the in-cluster work of the node step. Calls are built with the pure builders of runtime/kubectl.ts,
// so the same argv rules (JSON reads, server-side apply, field managers) hold on both paths.

import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import type { SshChannel } from '../../../services/orchestrator/kubernetes/deps';
import { classifyKubectlFailure, KubeError, NO_EXIT_CODE } from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  type ApplyOptions,
  applyCall,
  assertKubectlArgs,
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
  kubectlGuardS,
  kubectlRequestTimeoutS,
  parseJsonItems,
  replaceCall,
  type ShellCall,
} from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { Redactor } from '../../../utils/redact';
import { shellQuote } from '../../../utils/ssh';
import { K3S_ADMIN_KUBECONFIG, K3S_BINARY } from './constants';
import type { HostRunner } from './host-runner';

/** `k3s kubectl` with the admin kubeconfig: the node step runs as root on a server */
export const HOST_KUBECTL_PREFIX: readonly string[] = Object.freeze([K3S_BINARY, 'kubectl', `--kubeconfig=${K3S_ADMIN_KUBECONFIG}`]);

/** The argv of one call: prefix, `--request-timeout`, `-n`, then the call's own arguments. */
export function hostKubectlArgv(call: Pick<KubectlCall, 'args' | 'namespace' | 'requestTimeoutS'>): string[] {
  assertKubectlArgs(call.args);
  const argv = [...HOST_KUBECTL_PREFIX];
  const requestTimeoutS = kubectlRequestTimeoutS(call);
  if (requestTimeoutS !== null) argv.push(`--request-timeout=${requestTimeoutS}s`);
  if (call.namespace !== undefined) argv.push('-n', call.namespace);
  argv.push(...call.args);
  return argv;
}

/** The ClusterNodeRef of the node the step runs on; it is never reached over SSH. */
export function localNodeRef(name: string, role: ClusterNodeRef['role'] = 'manager'): ClusterNodeRef {
  return {
    name,
    role,
    host: '127.0.0.1',
    privateHost: '127.0.0.1',
    connection: { host: '127.0.0.1', port: 22, user: 'root', privateKey: '' },
  };
}

export interface HostKubeExecutorOptions {
  /** masks stderr before it reaches a result or an error; default: an empty Redactor */
  redactor?: Redactor;
}

function describeArgs(args: readonly string[]): string {
  return args[0] === 'rollout' && args[1] !== undefined ? `rollout ${args[1]}` : (args[0] ?? '');
}

class HostKubeExecutor implements KubeExecutor {
  private readonly redactor: Redactor;

  constructor(
    private readonly runner: HostRunner,
    readonly node: ClusterNodeRef,
    options: HostKubeExecutorOptions,
  ) {
    this.redactor = options.redactor ?? new Redactor();
  }

  async run(call: KubectlCall): Promise<KubectlResult> {
    const argv = hostKubectlArgv(call);
    const what = `kubectl ${describeArgs(call.args)}`;
    const guardS = kubectlGuardS(call);
    const raw = await this.runner.run(argv, {
      input: call.stdin,
      timeoutMs: guardS === null ? undefined : guardS * 1000,
    });
    if (raw.timedOut) {
      throw new KubeError('Timeout', `${what} did not finish within ${guardS}s on ${this.node.name}`, this.node.name, NO_EXIT_CODE, '');
    }
    const result: KubectlResult = { exitCode: raw.exitCode, stdout: raw.stdout, stderr: this.redactor.redact(raw.stderr) };
    if (result.exitCode !== 0 && !call.allowFailure) throw this.failure(what, result);
    return result;
  }

  async getJson<T>(resources: string[], options: GetJsonOptions = {}): Promise<T[]> {
    const what = `kubectl get ${resources.join(',')}`;
    const result = await this.run({ ...getJsonCall(resources, options), allowFailure: true });
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

  /** the node step never follows a stream: the whole output is delivered once the command ends */
  async stream(
    call: Omit<KubectlCall, 'mutating' | 'stdin'>,
    handlers: { stdout(chunk: string): void; stderr(chunk: string): void },
  ): Promise<number> {
    const result = await this.run({ ...call, mutating: false, allowFailure: true });
    if (result.stdout) handlers.stdout(result.stdout);
    if (result.stderr) handlers.stderr(result.stderr);
    return result.exitCode;
  }

  async shell(_call: ShellCall): Promise<KubectlResult> {
    throw this.noShell('shell');
  }

  async channel(_script: string): Promise<SshChannel> {
    throw this.noShell('channel');
  }

  async interactive(_script: string): Promise<number> {
    throw this.noShell('interactive');
  }

  command(args: string[], namespace?: string): string {
    return hostKubectlArgv({ args, namespace, requestTimeoutS: null }).map(shellQuote).join(' ');
  }

  // the node step runs argv only (4.0): shell scripts have no place on this path
  private noShell(method: string): Error {
    return new Error(`hostKubeExecutor.${method} is not available: the node step runs kubectl by argv only`);
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

/** A KubeExecutor running `k3s kubectl` with the admin kubeconfig through `runner`. */
export function hostKubeExecutor(
  runner: HostRunner,
  node: ClusterNodeRef | string,
  options: HostKubeExecutorOptions = {},
): KubeExecutor {
  return new HostKubeExecutor(runner, typeof node === 'string' ? localNodeRef(node) : node, options);
}
