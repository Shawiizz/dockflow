/**
 * Swarm health backend.
 *
 * Implements HealthBackend with Swarm-native health checking logic.
 * Polls `docker service ps` tasks and container health status via SSH.
 */

import type { SSHKeyConnection } from '../../../types';
import { sshExec } from '../../../utils/ssh';
import { printDebug, createTimedSpinner } from '../../../utils/output';
import type { HealthBackend, InternalHealthResult } from '../health-interface';

export class SwarmHealthBackend implements HealthBackend {
  constructor(private readonly connection: SSHKeyConnection) {}

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
    let lastHealthy: string[] = [];

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
      lastHealthy = result.healthy;
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
      this.connection,
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
      this.connection,
      `TASK=$(docker service ps ${serviceName} --filter 'desired-state=running' --format '{{.ID}}' --no-trunc 2>/dev/null | head -1); ` +
      `[ -z "$TASK" ] && echo "NO_TASK" && exit 0; ` +
      `INFO=$(docker inspect "$TASK" --format '{{.Spec.ContainerSpec.Image}}\t{{.Status.ContainerStatus.ContainerID}}' 2>/dev/null) || { echo "NO_TASK"; exit 0; }; ` +
      `CID=$(echo "$INFO" | cut -f2); ` +
      `if [ -n "$CID" ]; then ` +
        `HEALTH=$(docker inspect "$CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null) || HEALTH="none"; ` +
        `echo "$INFO\t$HEALTH"; ` +
      `else ` +
        `echo "$INFO\tnone"; ` +
      `fi`,
    );

    const output = result.stdout.trim();
    if (!output || output === 'NO_TASK') {
      return { name: serviceName, status: 'unhealthy' };
    }

    const parts = output.split('\t');
    const containerId = parts[1];
    const healthStatus = (parts[2] || 'none').trim().toLowerCase();

    if (!containerId) {
      return { name: serviceName, status: 'unhealthy' };
    }

    if (healthStatus === 'healthy' || healthStatus === 'none') {
      return { name: serviceName, status: 'healthy' };
    }

    return { name: serviceName, status: 'unhealthy' };
  }
}
