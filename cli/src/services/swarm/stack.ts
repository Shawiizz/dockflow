/**
 * A Swarm stack on a manager: its deploy, convergence and health, and the commands on its services.
 */

import type { SSHKeyConnection } from '../../types';
import { ok, err, type Result } from '../../types/result';
import { DeployError, ErrorCode } from '../../utils/errors';
import { shellQuote, sshExec } from '../../utils/ssh';
import { realClock, type SwarmClock } from './clock';
import { ConvergenceError, waitForConvergence } from './convergence';
import { checkInternalHealth } from './health';
import { createExternalResources, deployAccessories, deployStack, readAccessoriesDigest, removeStackAndWait } from './stack-deploy';
import { runDockerQuery } from './docker';
import * as Compose from '../compose';
import { CONVERGENCE_TIMEOUT_S, DOCKFLOW_STACKS_DIR } from '../../constants';
import type { StackInfo, ServiceInfo, ConvergenceResult, StackMetadata, StackDeployInput, AccessoryDeployInput, InternalHealthResult } from './types';

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

export class SwarmStack {
  private readonly renders = new Map<string, string>();
  /** the manager's clock when the last stack deploy started: the convergence judges update states by it */
  private deployStartedAt: number | null = null;

  constructor(
    private readonly conn: SSHKeyConnection,
    private readonly clock: SwarmClock = realClock,
  ) {}

  async deploy(input: StackDeployInput): Promise<Result<void, DeployError>> {
    try {
      // 1. Create external networks + volumes (always from the full compose)
      const networks = Compose.externalNetworksToCreate(input.compose, input.stackName);
      const volumes = Compose.getExternalVolumes(input.compose);
      await createExternalResources(this.conn, networks, volumes);

      // 2. When --services filter is set, only those services are deployed, and
      //    prune is disabled so other running services are left untouched.
      const prune = !input.servicesFilter?.length;
      this.deployStartedAt = await deployStack(this.conn, this.clock, input.stackName, this.render(input), { prune, withRegistryAuth: true });
      return ok(undefined);
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  /** The same input renders once: the release and the deploy both need it, and its warnings print once. */
  render(input: StackDeployInput): string {
    const source = Compose.serialize(input.compose);
    const key = JSON.stringify([input.stackName, input.env, input.servicesFilter ?? null, input.proxy ?? null, source]);
    const cached = this.renders.get(key);
    if (cached !== undefined) return cached;
    const rendered = this.renderOnce(input, source);
    this.renders.set(key, rendered);
    return rendered;
  }

  private renderOnce(input: StackDeployInput, source: string): string {
    const compose = Compose.loadFromString(source);
    const targeted = input.servicesFilter?.length
      ? Compose.filterServices(compose, input.servicesFilter)
      : compose;

    Compose.stripBuildSections(targeted);
    Compose.injectSwarmDefaults(targeted);
    if (input.proxy?.enabled) {
      Compose.injectTraefikLabels(targeted, input.proxy, input.stackName, input.env);
    }
    return Compose.serialize(targeted);
  }

  async deployAccessory(input: AccessoryDeployInput): Promise<Result<{ deployed: boolean }, DeployError>> {
    try {
      // Accessories already have injectAccessoriesDefaults applied by caller.
      const content = Compose.serialize(input.compose);
      await createExternalResources(this.conn, Compose.externalNetworksToCreate(input.compose, input.stackName), Compose.getExternalVolumes(input.compose));
      const deployed = await deployAccessories(this.conn, this.clock, input.stackName, content, { force: input.force });
      return ok({ deployed });
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  accessoriesDigest(stackName: string): Promise<string | null> {
    return readAccessoriesDigest(this.conn, stackName);
  }

  async redeploy(stackName: string, rawContent: string): Promise<Result<void, DeployError>> {
    try {
      this.deployStartedAt = await deployStack(this.conn, this.clock, stackName, rawContent);
      return ok(undefined);
    } catch (e) {
      return err(toDeployError(e));
    }
  }

  async waitConvergence(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
    servicesFilter?: string[],
  ): Promise<ConvergenceResult> {
    try {
      await waitForConvergence(this.conn, this.clock, stackName, {
        timeout: timeoutSeconds,
        interval: intervalSeconds,
        servicesFilter,
        deployStartedAt: this.deployStartedAt,
      });
      return { converged: true, rolledBack: false, timedOut: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const outcome = e instanceof ConvergenceError ? e.outcome : null;
      return { converged: false, rolledBack: outcome === 'rolled-back', timedOut: outcome === 'timeout', errorDetail: msg };
    }
  }

  checkInternalHealth(
    stackName: string,
    timeoutSeconds: number,
    intervalSeconds: number,
    servicesFilter?: string[],
    deployStartedAt?: Date,
  ): Promise<InternalHealthResult> {
    return checkInternalHealth(this.conn, this.clock, stackName, timeoutSeconds, intervalSeconds, servicesFilter, deployStartedAt);
  }

  async removeStack(stackName: string): Promise<void> {
    await removeStackAndWait(this.conn, this.clock, stackName);
  }

  async listStacks(): Promise<StackInfo[]> {
    const stdout = await runDockerQuery(this.conn, `docker stack ls --format '{{.Name}}\t{{.Services}}'`, 'docker stack ls');
    return (stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, services] = line.split('\t');
        return { name, services: parseInt(services ?? '0', 10) || 0 };
      });
  }

  async getServices(stackName: string): Promise<ServiceInfo[]> {
    const stdout = await runDockerQuery(
      this.conn,
      `docker stack services ${shellQuote(stackName)} --format '{{.Name}}|{{.Image}}|{{.Replicas}}|{{.Ports}}'`,
      'docker stack services',
    );
    return (stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [fullName, image, replicas, ports] = line.split('|');
        const name = fullName.replace(`${stackName}_`, '');
        return { name, image, replicas, ports };
      });
  }

  async scaleService(stackName: string, service: string, replicas: number, options: { detach?: boolean } = {}): Promise<void> {
    const fullName = `${stackName}_${service}`;
    const result = await sshExec(this.conn, `${waiting('docker service scale', options.detach)} ${shellQuote(fullName)}=${replicas}`);
    if (result.exitCode !== 0) throw serviceCommandError(result, service, `Failed to scale ${service}`);
  }

  async rollbackService(stackName: string, service: string): Promise<void> {
    const fullName = `${stackName}_${service}`;
    const result = await sshExec(this.conn, `${waiting('docker service rollback')} ${shellQuote(fullName)}`);
    if (result.exitCode !== 0) throw serviceCommandError(result, service, `Failed to rollback ${service}`);
  }

  async stackExists(stackName: string): Promise<boolean> {
    const stdout = await runDockerQuery(this.conn, `docker stack ls --format '{{.Name}}'`, 'docker stack ls');
    return (stdout ?? '').split('\n').map((line) => line.trim()).includes(stackName);
  }

  async restart(stackName: string, service?: string, options: { detach?: boolean } = {}): Promise<void> {
    const update = waiting('docker service update --force', options.detach);
    if (service) {
      const fullName = `${stackName}_${service}`;
      const r = await sshExec(this.conn, `${update} ${shellQuote(fullName)}`);
      if (r.exitCode !== 0) throw serviceCommandError(r, service, `Failed to restart ${service}`);
      return;
    }

    const services = await this.getServices(stackName);
    if (services.length === 0) {
      throw new DeployError('No services found', ErrorCode.STACK_NOT_FOUND);
    }

    const cmd = services
      .map((s) => `${update} ${shellQuote(`${stackName}_${s.name}`)}`)
      .join(' && ');
    const r = await sshExec(this.conn, cmd);
    if (r.exitCode !== 0) throw serviceCommandError(r, stackName, 'Some services failed to restart');
  }

  async getMetadata(stackName: string): Promise<StackMetadata | null> {
    const result = await sshExec(
      this.conn,
      `cat ${shellQuote(`${DOCKFLOW_STACKS_DIR}/${stackName}/current/metadata.json`)} 2>/dev/null`,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    try {
      return JSON.parse(result.stdout.trim()) as StackMetadata;
    } catch {
      return null;
    }
  }

  async getContainers(stackName: string): Promise<SwarmContainerInfo[]> {
    const stdout = await runDockerQuery(
      this.conn,
      `docker ps --filter ${shellQuote(`label=com.docker.stack.namespace=${stackName}`)} --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}'`,
      'docker ps',
    );
    return (stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, status, ports] = line.split('|');
        return { id, name, status, ports };
      });
  }

  async getTasks(stackName: string): Promise<SwarmTaskInfo[]> {
    const stdout = await runDockerQuery(
      this.conn,
      `docker stack ps ${shellQuote(stackName)} --format '{{.ID}}|{{.Name}}|{{.Image}}|{{.Node}}|{{.DesiredState}}|{{.CurrentState}}|{{.Error}}' --no-trunc`,
      'docker stack ps',
    );
    return (stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, image, node, desiredState, currentState, error] = line.split('|');
        return { id, name, image, node, desiredState, currentState, error };
      });
  }
}

/** The Docker CLI waits for the service to converge, forever when no node can take its tasks. */
function waiting(command: string, detach?: boolean): string {
  return detach ? `${command} --detach` : `timeout ${CONVERGENCE_TIMEOUT_S} ${command}`;
}

const TIMED_OUT = 124;

function serviceCommandError(result: { stderr: string; exitCode: number }, what: string, fallback: string): DeployError {
  if (result.exitCode === TIMED_OUT) {
    return new DeployError(
      `${what} did not converge within ${CONVERGENCE_TIMEOUT_S}s; Swarm keeps trying`,
      ErrorCode.DEPLOY_FAILED,
      'Run `dockflow diagnose <env>` to see what keeps its tasks from starting.',
    );
  }
  return new DeployError(result.stderr || fallback, ErrorCode.DEPLOY_FAILED);
}

function toDeployError(e: unknown): DeployError {
  if (e instanceof DeployError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new DeployError(msg, ErrorCode.DEPLOY_FAILED);
}
