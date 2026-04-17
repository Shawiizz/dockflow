/**
 * Swarm orchestrator backend.
 *
 * Implements OrchestratorService for Docker Swarm. Delegates stack deploy
 * lifecycle to SwarmDeployService; all other operations are direct SSH calls.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { sshExec } from '../../../utils/ssh';
import { SwarmDeployService } from '../../swarm-deploy-service';
import { ComposeService, type ParsedCompose } from '../../compose-service';
import { DOCKFLOW_STACKS_DIR } from '../../../constants';
import type { DockflowConfig } from '../../../utils/config';
import type {
  OrchestratorService,
  StackInfo,
  ServiceInfo,
  ConvergenceResult,
  StackMetadata,
} from '../interface';

export interface SwarmContainerInfo {
  id: string;
  name: string;
  status: string;
  ports: string;
}

export interface SwarmTaskInfo {
  id: string;
  name: string;
  image: string;
  node: string;
  desiredState: string;
  currentState: string;
  error: string;
}

export class SwarmOrchestratorService implements OrchestratorService {
  private readonly inner: SwarmDeployService;

  constructor(private readonly conn: SSHKeyConnection) {
    this.inner = new SwarmDeployService(conn);
  }

  prepareDeployContent(
    stackName: string,
    compose: ParsedCompose,
    config: DockflowConfig,
    env: string,
    options?: { skipDefaults?: boolean },
  ): string {
    if (!options?.skipDefaults) {
      ComposeService.injectSwarmDefaults(compose);
    }
    if (config.proxy?.enabled) {
      ComposeService.injectTraefikLabels(compose, config, stackName, env);
    }
    return ComposeService.serialize(compose);
  }

  async deployStack(
    stackName: string,
    content: string,
    _releasePath: string,
  ): Promise<Result<void, DeployError>> {
    try {
      await this.inner.deployStack(stackName, content);
      return ok(undefined);
    } catch (e) {
      return err(this.toDeployError(e));
    }
  }

  async deployAccessory(
    name: string,
    content: string,
    accessoryPath: string,
    options?: { force?: boolean },
  ): Promise<Result<{ deployed: boolean }, DeployError>> {
    try {
      await this.inner.deployAccessories(name, accessoryPath, content, options);
      return ok({ deployed: true });
    } catch (e) {
      return err(this.toDeployError(e));
    }
  }

  async waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<ConvergenceResult> {
    try {
      await this.inner.waitConvergence(stackName, {
        timeout: timeoutSeconds,
        interval: intervalSeconds,
      });
      return { converged: true, rolledBack: false, timedOut: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rolledBack = /rolled back|rollback/i.test(msg);
      const timedOut = /timeout/i.test(msg);
      return { converged: false, rolledBack, timedOut };
    }
  }

  async removeStack(stackName: string): Promise<void> {
    await this.inner.forceRemoveStack(stackName);
  }

  async listStacks(): Promise<StackInfo[]> {
    const result = await sshExec(
      this.conn,
      `docker stack ls --format '{{.Name}}\t{{.Services}}' 2>/dev/null || echo ""`,
    );
    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, services] = line.split('\t');
        return { name, services: parseInt(services ?? '0', 10) || 0 };
      });
  }

  async getServices(stackName: string): Promise<ServiceInfo[]> {
    const result = await sshExec(
      this.conn,
      `docker stack services ${stackName} --format '{{.Name}}|{{.Image}}|{{.Replicas}}|{{.Ports}}' 2>/dev/null`,
    );
    if (result.exitCode !== 0) return [];

    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [fullName, image, replicas, ports] = line.split('|');
        const name = fullName.replace(`${stackName}_`, '');
        return { name, image, replicas, ports };
      });
  }

  async scaleService(
    stackName: string,
    service: string,
    replicas: number,
  ): Promise<void> {
    const fullName = `${stackName}_${service}`;
    const result = await sshExec(this.conn, `docker service scale ${fullName}=${replicas}`);
    if (result.exitCode !== 0) {
      throw new DeployError(
        result.stderr || `Failed to scale ${service}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async rollbackService(stackName: string, service: string): Promise<void> {
    const fullName = `${stackName}_${service}`;
    const result = await sshExec(this.conn, `docker service rollback ${fullName}`);
    if (result.exitCode !== 0) {
      throw new DeployError(
        result.stderr || `Failed to rollback ${service}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async prepareInfrastructure(_stackName: string, compose: ParsedCompose): Promise<void> {
    const networks = ComposeService.getExternalNetworks(compose);
    const volumes = ComposeService.getExternalVolumes(compose);
    await this.inner.createExternalResources(networks, volumes);
  }

  async stackExists(stackName: string): Promise<boolean> {
    const result = await sshExec(
      this.conn,
      `docker stack ls --format '{{.Name}}' | grep -Fxq '${stackName}' && echo exists || echo not_found`,
    );
    return result.stdout.trim() === 'exists';
  }

  async restart(stackName: string, service?: string): Promise<void> {
    if (service) {
      const fullName = `${stackName}_${service}`;
      const r = await sshExec(this.conn, `docker service update --force ${fullName}`);
      if (r.exitCode !== 0) {
        throw new DeployError(r.stderr || `Failed to restart ${service}`, ErrorCode.DEPLOY_FAILED);
      }
      return;
    }

    const services = await this.getServices(stackName);
    if (services.length === 0) {
      throw new DeployError('No services found', ErrorCode.STACK_NOT_FOUND);
    }

    const cmd = services
      .map((s) => `docker service update --force ${stackName}_${s.name}`)
      .join(' && ');
    const r = await sshExec(this.conn, cmd);
    if (r.exitCode !== 0) {
      throw new DeployError(r.stderr || 'Some services failed to restart', ErrorCode.DEPLOY_FAILED);
    }
  }

  async getMetadata(stackName: string): Promise<StackMetadata | null> {
    const result = await sshExec(
      this.conn,
      `cat '${DOCKFLOW_STACKS_DIR}/${stackName}/current/metadata.json' 2>/dev/null`,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    try {
      return JSON.parse(result.stdout.trim()) as StackMetadata;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Swarm-only inspection methods (not on OrchestratorService interface).
  // Used by `dockflow ps` and `dockflow diagnose` — commands that surface
  // Swarm-native concepts (containers on nodes, task scheduling) that don't
  // translate to k3s.
  // ---------------------------------------------------------------------------

  async getContainers(stackName: string): Promise<SwarmContainerInfo[]> {
    const result = await sshExec(
      this.conn,
      `docker ps --filter 'label=com.docker.stack.namespace=${stackName}' --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}'`,
    );
    if (result.exitCode !== 0) return [];

    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, status, ports] = line.split('|');
        return { id, name, status, ports };
      });
  }

  async getTasks(stackName: string): Promise<SwarmTaskInfo[]> {
    const result = await sshExec(
      this.conn,
      `docker stack ps ${stackName} --format '{{.ID}}|{{.Name}}|{{.Image}}|{{.Node}}|{{.DesiredState}}|{{.CurrentState}}|{{.Error}}' --no-trunc 2>/dev/null`,
    );
    if (result.exitCode !== 0) return [];

    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, image, node, desiredState, currentState, error] = line.split('|');
        return { id, name, image, node, desiredState, currentState, error };
      });
  }

  private toDeployError(e: unknown): DeployError {
    if (e instanceof DeployError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    return new DeployError(msg, ErrorCode.DEPLOY_FAILED);
  }
}
