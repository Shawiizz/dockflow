/**
 * Health Check Service
 *
 * Replaces the Ansible roles `swarm-healthcheck` and `health-check`.
 * Polls Docker Swarm container health after deploy and performs
 * external HTTP endpoint checks.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { printDebug, printDim, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import type { HealthCheckConfig } from '../utils/config';

// Default from ansible/group_vars/all.yml: dockflow_defaults.healthcheck_timeout
const HEALTHCHECK_TIMEOUT_S = 120;
const HEALTHCHECK_INTERVAL_S = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SwarmHealthResult {
  healthy: string[];
  unhealthy: string[];
  rolledBack: string[];
}

export class HealthCheckService {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Check internal Swarm container health for all services in a stack.
   *
   * Polls until all services are healthy (or have no healthcheck defined),
   * up to `HEALTHCHECK_TIMEOUT_S`. Detects Swarm auto-rollbacks by
   * comparing running container images against expected images.
   */
  async checkSwarmHealth(
    stackName: string,
    expectedImages?: Record<string, string>,
  ): Promise<SwarmHealthResult> {
    const timeout = HEALTHCHECK_TIMEOUT_S * 1000;
    const interval = HEALTHCHECK_INTERVAL_S * 1000;
    const deadline = Date.now() + timeout;

    printDim(`Checking Swarm health (timeout: ${HEALTHCHECK_TIMEOUT_S}s)...`);

    while (Date.now() < deadline) {
      const result = await this.pollHealth(stackName, expectedImages);

      // If any service was rolled back, fail immediately
      if (result.rolledBack.length > 0) {
        throw new DeployError(
          `Swarm auto-rolled back services: ${result.rolledBack.join(', ')}`,
          ErrorCode.HEALTH_CHECK_FAILED,
          'Check service logs to understand why the new version failed.',
        );
      }

      // If no unhealthy services remain, we're done
      if (result.unhealthy.length === 0) {
        printDebug(`All services healthy: ${result.healthy.join(', ')}`);
        return result;
      }

      printDebug(`Health: healthy=[${result.healthy.join(', ')}] unhealthy=[${result.unhealthy.join(', ')}]`);
      await sleep(interval);
    }

    // Final check after timeout
    const final = await this.pollHealth(stackName, expectedImages);
    if (final.unhealthy.length > 0) {
      throw new DeployError(
        `Health check timeout after ${HEALTHCHECK_TIMEOUT_S}s. Unhealthy services: ${final.unhealthy.join(', ')}`,
        ErrorCode.HEALTH_CHECK_FAILED,
        'Check service logs with `dockflow logs <service>` for details.',
      );
    }

    return final;
  }

  /**
   * Single poll of all services' health status.
   */
  private async pollHealth(
    stackName: string,
    expectedImages?: Record<string, string>,
  ): Promise<SwarmHealthResult> {
    const healthy: string[] = [];
    const unhealthy: string[] = [];
    const rolledBack: string[] = [];

    // Get services + their expected images
    const listResult = await sshExec(
      this.connection,
      `docker stack services ${stackName} --format '{{.Name}}\t{{.Image}}' 2>/dev/null || echo ""`,
    );

    const lines = listResult.stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const [serviceName, serviceImage] = line.split('\t');
      if (!serviceName) continue;

      // Get running task
      const taskResult = await sshExec(
        this.connection,
        `docker service ps ${serviceName} --filter 'desired-state=running' --format '{{.ID}}' --no-trunc 2>/dev/null | head -1`,
      );
      const taskId = taskResult.stdout.trim();
      if (!taskId) {
        unhealthy.push(serviceName);
        continue;
      }

      // Get container ID from task
      const containerResult = await sshExec(
        this.connection,
        `docker inspect ${taskId} --format '{{.Status.ContainerStatus.ContainerID}}' 2>/dev/null || echo ""`,
      );
      const containerId = containerResult.stdout.trim();
      if (!containerId) {
        unhealthy.push(serviceName);
        continue;
      }

      // Check if auto-rolled back (image mismatch)
      if (expectedImages?.[serviceName]) {
        const imgResult = await sshExec(
          this.connection,
          `docker inspect ${containerId} --format '{{.Config.Image}}' 2>/dev/null || echo ""`,
        );
        const runningImage = imgResult.stdout.trim();
        if (runningImage && runningImage !== expectedImages[serviceName]) {
          rolledBack.push(serviceName);
          continue;
        }
      }

      // Check health status
      const healthResult = await sshExec(
        this.connection,
        `docker inspect ${containerId} --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo "none"`,
      );
      const status = healthResult.stdout.trim().toLowerCase();

      switch (status) {
        case 'healthy':
        case 'none': // No HEALTHCHECK defined — treat as healthy
          healthy.push(serviceName);
          break;
        case 'starting':
        case 'unhealthy':
        default:
          unhealthy.push(serviceName);
          break;
      }
    }

    return { healthy, unhealthy, rolledBack };
  }

  /**
   * Perform HTTP health checks against external endpoints.
   *
   * Returns list of failed endpoint URLs (empty = all passed).
   * Throws DeployError if `on_failure` is 'fail' or 'rollback'.
   */
  async checkHTTPEndpoints(config: HealthCheckConfig): Promise<string[]> {
    const endpoints = config.endpoints ?? [];
    if (endpoints.length === 0) return [];

    // Wait startup delay
    const startupDelay = config.startup_delay ?? 0;
    if (startupDelay > 0) {
      printDim(`Waiting ${startupDelay}s before HTTP health checks...`);
      await sleep(startupDelay * 1000);
    }

    const failedEndpoints: string[] = [];

    for (const endpoint of endpoints) {
      const method = endpoint.method ?? 'GET';
      const expectedStatus = endpoint.expected_status ?? 200;
      const timeoutMs = (endpoint.timeout ?? 30) * 1000;
      const retries = endpoint.retries ?? 3;
      const retryDelay = (endpoint.retry_delay ?? 5) * 1000;

      let lastError = '';
      let passed = false;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await fetch(endpoint.url, {
            method,
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (response.status === expectedStatus) {
            passed = true;
            printDebug(`HTTP check passed: ${method} ${endpoint.url} → ${response.status}`);
            break;
          }

          lastError = `Expected ${expectedStatus}, got ${response.status}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }

        if (attempt < retries) {
          printDebug(`HTTP check ${endpoint.url} attempt ${attempt}/${retries} failed: ${lastError}`);
          await sleep(retryDelay);
        }
      }

      if (!passed) {
        failedEndpoints.push(endpoint.url);
        printWarning(`HTTP check failed: ${method} ${endpoint.url} — ${lastError}`);
      }
    }

    if (failedEndpoints.length === 0) return [];

    const onFailure = config.on_failure ?? 'fail';

    switch (onFailure) {
      case 'fail':
        throw new DeployError(
          `HTTP health checks failed: ${failedEndpoints.join(', ')}`,
          ErrorCode.HEALTH_CHECK_FAILED,
        );
      case 'rollback':
        throw new DeployError(
          `HTTP health checks failed (triggering rollback): ${failedEndpoints.join(', ')}`,
          ErrorCode.HEALTH_CHECK_FAILED,
        );
      case 'notify':
        printWarning(`HTTP health checks failed (non-fatal): ${failedEndpoints.join(', ')}`);
        break;
      case 'ignore':
        break;
    }

    return failedEndpoints;
  }
}
