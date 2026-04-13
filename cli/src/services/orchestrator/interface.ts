import type { Result } from '../../types/result';
import type { DeployError } from '../../utils/errors';

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

/**
 * Contrat que tout backend d'orchestration doit implémenter.
 * SwarmOrchestratorService et K3sOrchestratorService implémentent cette interface.
 * Le deploy command ne connaît que cette interface — jamais les implémentations concrètes.
 */
export interface OrchestratorService {
  deployStack(
    stackName: string,
    content: string,
    releasePath: string,
  ): Promise<Result<void, DeployError>>;

  deployAccessory(
    name: string,
    content: string,
    accessoryPath: string,
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

  prepareInfrastructure(stackName: string, content: string): Promise<void>;
}
