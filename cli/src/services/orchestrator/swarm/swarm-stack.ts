/**
 * Swarm stack backend.
 *
 * Implements StackBackend for Docker Swarm. Deploy mechanics live in the
 * helper (SwarmStackOps); inspection, health, and lifecycle commands are
 * direct SSH calls.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { sshExec } from '../../../utils/ssh';
import { printDebug, createTimedSpinner } from '../../../utils/output';
import { SwarmStackOps } from './swarm-stack-ops';
import * as Compose from '../../compose';
import { DOCKFLOW_STACKS_DIR } from '../../../constants';
import type {
  StackBackend,
  StackInfo,
  ServiceInfo,
  ConvergenceResult,
  StackMetadata,
  StackDeployInput,
  AccessoryDeployInput,
  InternalHealthResult,
} from '../interfaces';

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

export class SwarmStackBackend implements StackBackend {
  private readonly ops: SwarmStackOps;

  constructor(private readonly conn: SSHKeyConnection) {
    this.ops = new SwarmStackOps(conn);
  }

  async deploy(input: StackDeployInput): Promise<Result<void, DeployError>> {
    try {
      // 1. Create external networks + volumes
      const networks = Compose.getExternalNetworks(input.compose);
      const volumes = Compose.getExternalVolumes(input.compose);
      await this.ops.createExternalResources(networks, volumes);

      // 2. Render compose: inject Swarm deploy defaults + optional Traefik labels
      Compose.injectSwarmDefaults(input.compose);
      if (input.proxy?.enabled) {
        Compose.injectTraefikLabels(input.compose, input.proxy, input.stackName, input.env);
      }
      const content = Compose.serialize(input.compose);

      // 3. Apply
      await this.ops.deployStack(input.stackName, content);
      return ok(undefined);
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  async deployAccessory(input: AccessoryDeployInput): Promise<Result<{ deployed: boolean }, DeployError>> {
    try {
      // Accessories already have injectAccessoriesDefaults applied by caller.
      const content = Compose.serialize(input.compose);
      await this.ops.deployAccessories(input.stackName, input.accessoryPath, content, { force: input.force });
      return ok({ deployed: true });
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  async redeploy(stackName: string, rawContent: string): Promise<Result<void, DeployError>> {
    try {
      await this.ops.deployStack(stackName, rawContent);
      return ok(undefined);
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  async waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<ConvergenceResult> {
    try {
      await this.ops.waitConvergence(stackName, {
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

  async checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
  ): Promise<InternalHealthResult> {
    const timeout = timeoutSeconds * 1000;
    const interval = intervalSeconds * 1000;
    const deadline = Date.now() + timeout;

    const spinner = createTimedSpinner();
    spinner.start(`Checking Swarm health (timeout: ${timeoutSeconds}s)...`);

    let lastUnhealthy: string[] = [];

    while (Date.now() < deadline) {
      const result = await this.pollHealth(stackName);

      if (result.rolledBack.length > 0) {
        spinner.fail(`Swarm auto-rolled back: ${result.rolledBack.join(', ')}`);
        return {
          healthy: false,
          rolledBack: true,
          failedService: result.rolledBack[0],
          message: `Swarm auto-rolled back: ${result.rolledBack.join(', ')}`,
        };
      }

      if (result.unhealthy.length === 0) {
        spinner.succeed(`All services healthy: ${result.healthy.join(', ')}`);
        return { healthy: true, rolledBack: false };
      }

      lastUnhealthy = result.unhealthy;
      printDebug(`Health: healthy=[${result.healthy.join(', ')}] unhealthy=[${result.unhealthy.join(', ')}]`);
      spinner.update(`Checking Swarm health: ${result.unhealthy.length} unhealthy`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    spinner.fail(`Health check timeout after ${timeoutSeconds}s`);

    if (lastUnhealthy.length > 0) {
      return {
        healthy: false,
        rolledBack: false,
        failedService: lastUnhealthy[0],
        message: `Health check timeout after ${timeoutSeconds}s. Unhealthy services: ${lastUnhealthy.join(', ')}`,
      };
    }

    return { healthy: true, rolledBack: false };
  }

  private async pollHealth(
    stackName: string,
  ): Promise<{ healthy: string[]; unhealthy: string[]; rolledBack: string[] }> {
    const listResult = await sshExec(
      this.conn,
      `docker stack services ${stackName} --format '{{.Name}}' 2>/dev/null || echo ""`,
    );

    const serviceNames = listResult.stdout.trim().split('\n').filter(Boolean);
    if (serviceNames.length === 0) {
      return { healthy: [], unhealthy: [], rolledBack: [] };
    }

    const results = await Promise.all(
      serviceNames.map((serviceName) => this.checkServiceHealth(serviceName)),
    );

    const healthy: string[] = [];
    const unhealthy: string[] = [];
    const rolledBack: string[] = [];

    for (const r of results) {
      switch (r.status) {
        case 'healthy':
          healthy.push(r.name);
          break;
        case 'rolled_back':
          rolledBack.push(r.name);
          break;
        default:
          unhealthy.push(r.name);
          break;
      }
    }

    return { healthy, unhealthy, rolledBack };
  }

  private async checkServiceHealth(
    serviceName: string,
  ): Promise<{ name: string; status: 'healthy' | 'unhealthy' | 'rolled_back' }> {
    const result = await sshExec(
      this.conn,
      `docker service inspect ${serviceName} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null; ` +
      `echo "---"; ` +
      `docker service ps ${serviceName} --filter 'desired-state=running' --format '{{.CurrentState}}' --no-trunc 2>/dev/null`,
    );

    const output = result.stdout.trim();
    const [updateState, , ...taskLines] = output.split('---');
    const trimmedUpdateState = (updateState || '').trim().toLowerCase();

    if (trimmedUpdateState === 'rollback_started' || trimmedUpdateState === 'rollback_completed') {
      return { name: serviceName, status: 'rolled_back' };
    }

    const tasks = (taskLines.join('').trim()).split('\n').filter(Boolean);
    if (tasks.length === 0) {
      return { name: serviceName, status: 'unhealthy' };
    }

    const allRunning = tasks.every((t) => t.trim().toLowerCase().startsWith('running'));
    return { name: serviceName, status: allRunning ? 'healthy' : 'unhealthy' };
  }

  async removeStack(stackName: string): Promise<void> {
    await this.ops.forceRemoveStack(stackName);
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

  async scaleService(stackName: string, service: string, replicas: number): Promise<void> {
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
  // Swarm-only inspection methods (not on StackBackend interface).
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
}

function toDeployError(e: unknown): DeployError {
  if (e instanceof DeployError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new DeployError(msg, ErrorCode.DEPLOY_FAILED);
}
