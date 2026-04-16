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
    // Use task-level inspection only — works regardless of which node
    // the container runs on (docker inspect on a container ID only works
    // on the node where the container is running).
    const result = await sshExec(
      this.connection,
      `docker service inspect ${serviceName} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null; ` +
      `echo "---"; ` +
      `docker service ps ${serviceName} --filter 'desired-state=running' --format '{{.CurrentState}}' --no-trunc 2>/dev/null`,
    );

    const output = result.stdout.trim();
    const [updateState, , ...taskLines] = output.split('---');
    const trimmedUpdateState = (updateState || '').trim().toLowerCase();

    // Detect rollback
    if (trimmedUpdateState === 'rollback_started' || trimmedUpdateState === 'rollback_completed') {
      return { name: serviceName, status: 'rolled_back' };
    }

    // Check task states — all running tasks must be in "Running" state
    const tasks = (taskLines.join('').trim()).split('\n').filter(Boolean);
    if (tasks.length === 0) {
      return { name: serviceName, status: 'unhealthy' };
    }

    const allRunning = tasks.every((t) => t.trim().toLowerCase().startsWith('running'));
    return { name: serviceName, status: allRunning ? 'healthy' : 'unhealthy' };
  }
}
