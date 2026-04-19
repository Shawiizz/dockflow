/**
 * Orchestrator backend interfaces.
 *
 * Every backend that plugs into the deploy/operate pipeline implements one
 * of these three contracts. Swarm and K3s each ship their own implementations
 * under ./swarm/ and ./k3s/.
 */

import type { Result } from '../../types/result';
import type { DeployError } from '../../utils/errors';
import type { ParsedCompose } from '../compose';
import type { ProxyConfig } from '../../utils/config';

// ---------------------------------------------------------------------------
// Stack-level types
// ---------------------------------------------------------------------------

export interface StackInfo {
  name: string;
  services: number;
}

export interface ServiceInfo {
  name: string;
  image: string;
  replicas: string;
  ports: string;
}

export interface ConvergenceResult {
  converged: boolean;
  rolledBack: boolean;
  timedOut: boolean;
}

export interface StackMetadata {
  version: string;
  env: string;
  branch: string;
  timestamp: string;
  project_name: string;
}

export interface InternalHealthResult {
  healthy: boolean;
  rolledBack: boolean;
  failedService?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Deploy inputs (concrete values — no DockflowConfig leaks into the interface)
// ---------------------------------------------------------------------------

export interface StackDeployInput {
  stackName: string;
  env: string;
  compose: ParsedCompose;
  /** Proxy config — if defined with enabled=true, backend injects Traefik routing. */
  proxy?: ProxyConfig;
  /** True when deploying via a remote registry (affects manifest generation on k3s). */
  useRegistry?: boolean;
}

export interface AccessoryDeployInput {
  stackName: string;
  env: string;
  compose: ParsedCompose;
  /** Path of the accessories compose file, used by backends that cache by path. */
  accessoryPath: string;
  /** Skip change detection and deploy even if the content hasn't changed. */
  force?: boolean;
  proxy?: ProxyConfig;
  useRegistry?: boolean;
}

// ---------------------------------------------------------------------------
// StackBackend — lifecycle + health
// ---------------------------------------------------------------------------

export interface StackBackend {
  /**
   * Deploy a stack end-to-end: create external resources, render content,
   * apply to the cluster. Single entry point — no multi-step protocol.
   */
  deploy(input: StackDeployInput): Promise<Result<void, DeployError>>;

  /**
   * Deploy the accessories companion stack. Implementations may skip if the
   * content is unchanged since the last deploy unless `force: true`.
   */
  deployAccessory(input: AccessoryDeployInput): Promise<Result<{ deployed: boolean }, DeployError>>;

  /**
   * Re-apply a previously-rendered stack definition (no preparation).
   * Used for rollback, where the content is read straight from a release dir.
   */
  redeploy(stackName: string, rawContent: string): Promise<Result<void, DeployError>>;

  waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<ConvergenceResult>;

  /** Internal cluster-level health check (tasks/pods in desired state). */
  checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<InternalHealthResult>;

  removeStack(stackName: string): Promise<void>;
  listStacks(): Promise<StackInfo[]>;
  getServices(stackName: string): Promise<ServiceInfo[]>;
  scaleService(stackName: string, service: string, replicas: number): Promise<void>;
  rollbackService(stackName: string, service: string): Promise<void>;

  stackExists(stackName: string): Promise<boolean>;

  /**
   * Force a restart of one service, or every service in the stack.
   * - Swarm: `docker service update --force`
   * - k3s:   `kubectl rollout restart deployment/...`
   */
  restart(stackName: string, service?: string): Promise<void>;

  /** Read the deployment metadata file written by the release service. */
  getMetadata(stackName: string): Promise<StackMetadata | null>;
}

// ---------------------------------------------------------------------------
// ContainerBackend — exec + logs
// ---------------------------------------------------------------------------

export interface ExecOptions {
  interactive?: boolean;
  workdir?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LogsOptions {
  follow: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}

export interface ContainerBackend {
  exec(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options?: ExecOptions,
  ): Promise<Result<ExecResult, Error>>;

  execStream(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options?: ExecOptions,
    callbacks?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void },
  ): Promise<Result<number, Error>>;

  shell(
    stackName: string,
    serviceName: string,
    shell?: string,
  ): Promise<Result<void, Error>>;

  bash(stackName: string, serviceName: string): Promise<Result<void, Error>>;

  copyTo(
    stackName: string,
    serviceName: string,
    localPath: string,
    containerPath: string,
  ): Promise<Result<void, Error>>;

  copyFrom(
    stackName: string,
    serviceName: string,
    containerPath: string,
    localPath: string,
  ): Promise<Result<void, Error>>;

  streamLogs(
    stackName: string,
    serviceName: string,
    options: LogsOptions,
    onData: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// ProxyBackend — reverse-proxy installer (Traefik on Swarm or k3s)
// ---------------------------------------------------------------------------

export interface ProxyBackend {
  ensureRunning(proxyConfig: ProxyConfig): Promise<void>;
}
