/**
 * Swarm orchestrator backend.
 *
 * Thin wrapper that implements OrchestratorService by delegating to the
 * existing Swarm services (SwarmDeployService, StackService, ComposeService).
 * No business logic lives here — every method forwards to a pre-existing
 * implementation.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { sshExec } from '../../../utils/ssh';
import { SwarmDeployService } from '../../swarm-deploy-service';
import { createStackService } from '../../stack-service';
import { ComposeService } from '../../compose-service';
import type {
  OrchestratorService,
  StackInfo,
  ServiceInfo,
  ConvergenceResult,
} from '../interface';

export class SwarmOrchestratorService implements OrchestratorService {
  private readonly inner: SwarmDeployService;

  constructor(private readonly conn: SSHKeyConnection) {
    this.inner = new SwarmDeployService(conn);
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
  ): Promise<Result<{ deployed: boolean }, DeployError>> {
    try {
      await this.inner.deployAccessories(name, accessoryPath, content);
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
    const stack = createStackService(this.conn, stackName);
    const result = await stack.getServices();
    if (!result.success) return [];
    return result.data.map((s) => ({
      name: s.name,
      image: s.image,
      replicas: s.replicas,
      ports: s.ports,
    }));
  }

  async scaleService(
    stackName: string,
    service: string,
    replicas: number,
  ): Promise<void> {
    const stack = createStackService(this.conn, stackName);
    const result = await stack.scale(service, replicas);
    if (!result.success) {
      throw new DeployError(
        result.message ?? `Failed to scale ${service}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async rollbackService(stackName: string, service: string): Promise<void> {
    const stack = createStackService(this.conn, stackName);
    const result = await stack.rollback(service);
    if (!result.success) {
      throw new DeployError(
        result.message ?? `Failed to rollback ${service}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  async prepareInfrastructure(_stackName: string, content: string): Promise<void> {
    const compose = ComposeService.loadFromString(content);
    const networks = ComposeService.getExternalNetworks(compose);
    const volumes = ComposeService.getExternalVolumes(compose);
    await this.inner.createExternalResources(networks, volumes);
  }

  private toDeployError(e: unknown): DeployError {
    if (e instanceof DeployError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    return new DeployError(msg, ErrorCode.DEPLOY_FAILED);
  }
}
