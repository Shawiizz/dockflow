import type { Result } from '../../types/result';
import type { DeployError } from '../../utils/errors';
import type { ParsedCompose } from '../compose-service';
import type { DockflowConfig, ProxyConfig } from '../../utils/config';

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

/**
 * Contrat que tout backend d'orchestration doit implémenter.
 * SwarmOrchestratorService et K3sOrchestratorService implémentent cette interface.
 * Le deploy command ne connaît que cette interface — jamais les implémentations concrètes.
 */
export interface OrchestratorService {
  /**
   * Prepare the compose content for deployment:
   * - Swarm: inject deploy defaults, inject Traefik labels, serialize to YAML
   * - K3s: convert to Kubernetes manifests
   *
   * Called by deploy phases instead of manually checking orchestrator type.
   */
  prepareDeployContent(
    stackName: string,
    compose: ParsedCompose,
    config: DockflowConfig,
    env: string,
    options?: { skipDefaults?: boolean },
  ): string;

  deployStack(
    stackName: string,
    content: string,
    releasePath: string,
  ): Promise<Result<void, DeployError>>;

  deployAccessory(
    name: string,
    content: string,
    accessoryPath: string,
    options?: { force?: boolean },
  ): Promise<Result<{ deployed: boolean }, DeployError>>;

  waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<ConvergenceResult>;

  removeStack(stackName: string): Promise<void>;

  listStacks(): Promise<StackInfo[]>;

  getServices(stackName: string): Promise<ServiceInfo[]>;

  scaleService(stackName: string, service: string, replicas: number): Promise<void>;

  rollbackService(stackName: string, service: string): Promise<void>;

  prepareInfrastructure(stackName: string, compose: ParsedCompose): Promise<void>;

  /** Whether the stack is currently deployed on the cluster. */
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

/**
 * Backend for managing the reverse proxy (Traefik).
 * Swarm and K3s have different Traefik deployment strategies.
 */
export interface TraefikBackend {
  ensureRunning(proxyConfig: ProxyConfig): Promise<void>;
}
