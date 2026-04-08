/**
 * Health Check Service
 *
 * Replaces the Ansible roles `swarm-healthcheck` and `health-check`.
 * Polls Docker Swarm container health after deploy and performs
 * external HTTP endpoint checks.
 *
 * Per-service health polls run in parallel (one SSH channel per service).
 * HTTP endpoint checks also run concurrently via Promise.allSettled.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { printDebug, printDim, printWarning, createTimedSpinner } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import type { HealthCheckConfig } from '../utils/config';

// Defaults — overridable via config.health_checks.timeout / .interval
const DEFAULT_HEALTHCHECK_TIMEOUT_S = 120;
const DEFAULT_HEALTHCHECK_INTERVAL_S = 5;

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
   * Polls until all services are healthy (or have no healthcheck defined).
   * Detects Swarm auto-rollbacks by comparing running container images
   * against expected images. Per-service checks run in parallel.
   *
   * Timeout and interval are configurable via `config` parameter.
   */
  async checkSwarmHealth(
    stackName: string,
    expectedImages?: Record<string, string>,
    config?: HealthCheckConfig,
  ): Promise<SwarmHealthResult> {
    const timeoutS = config?.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_S;
    const intervalS = config?.interval ?? DEFAULT_HEALTHCHECK_INTERVAL_S;
    const timeout = timeoutS * 1000;
    const interval = intervalS * 1000;
    const deadline = Date.now() + timeout;

    const spinner = createTimedSpinner();
    spinner.start(`Checking Swarm health (timeout: ${timeoutS}s)...`);

    let lastResult: SwarmHealthResult | undefined;

    while (Date.now() < deadline) {
      const result = await this.pollHealth(stackName, expectedImages);
      lastResult = result;

      // If any service was rolled back, fail immediately
      if (result.rolledBack.length > 0) {
        spinner.fail(`Swarm auto-rolled back: ${result.rolledBack.join(', ')}`);
        throw new DeployError(
          `Swarm auto-rolled back services: ${result.rolledBack.join(', ')}`,
          ErrorCode.HEALTH_CHECK_FAILED,
          'Check service logs to understand why the new version failed.',
        );
      }

      // If no unhealthy services remain, we're done
      if (result.unhealthy.length === 0) {
        spinner.succeed(`All services healthy: ${result.healthy.join(', ')}`);
        return result;
      }

      printDebug(`Health: healthy=[${result.healthy.join(', ')}] unhealthy=[${result.unhealthy.join(', ')}]`);
      spinner.update(`Checking Swarm health: ${result.unhealthy.length} unhealthy`);
      await sleep(interval);
    }

    // Timeout — use last known result to avoid an extra SSH round-trip
    if (lastResult && lastResult.unhealthy.length > 0) {
      spinner.fail(`Health check timeout after ${timeoutS}s`);
      throw new DeployError(
        `Health check timeout after ${timeoutS}s. Unhealthy services: ${lastResult.unhealthy.join(', ')}`,
        ErrorCode.HEALTH_CHECK_FAILED,
        'Check service logs with `dockflow logs <service>` for details.',
      );
    }

    spinner.succeed('All services healthy');
    return lastResult ?? { healthy: [], unhealthy: [], rolledBack: [] };
  }

  /**
   * Single poll of all services' health status.
   * Each service is inspected in parallel (independent SSH channels).
   */
  private async pollHealth(
    stackName: string,
    expectedImages?: Record<string, string>,
  ): Promise<SwarmHealthResult> {
    // Get services list (single SSH call)
    const listResult = await sshExec(
      this.connection,
      `docker stack services ${stackName} --format '{{.Name}}' 2>/dev/null || echo ""`,
    );

    const serviceNames = listResult.stdout.trim().split('\n').filter(Boolean);
    if (serviceNames.length === 0) {
      return { healthy: [], unhealthy: [], rolledBack: [] };
    }

    // Inspect all services in parallel
    const results = await Promise.all(
      serviceNames.map((serviceName) =>
        this.checkServiceHealth(serviceName, expectedImages?.[serviceName]),
      ),
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

  /**
   * Check the health of a single service.
   * Uses Swarm-level inspection (works from manager for any node).
   * Falls back to container inspect only when the container is local.
   */
  private async checkServiceHealth(
    serviceName: string,
    expectedImage?: string,
  ): Promise<{ name: string; status: 'healthy' | 'unhealthy' | 'rolled_back' }> {
    // Single SSH call: get task image, container ID, and container health in one shot
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
    const taskImage = parts[0];
    const containerId = parts[1];
    const healthStatus = (parts[2] || 'none').trim().toLowerCase();

    // Check if auto-rolled back (image mismatch from task spec)
    if (expectedImage && taskImage) {
      const cleanTaskImage = taskImage.split('@')[0];
      if (cleanTaskImage !== expectedImage) {
        return { name: serviceName, status: 'rolled_back' };
      }
    }

    if (!containerId) {
      return { name: serviceName, status: 'unhealthy' };
    }

    if (healthStatus === 'healthy' || healthStatus === 'none') {
      return { name: serviceName, status: 'healthy' };
    }

    return { name: serviceName, status: 'unhealthy' };
  }

  /**
   * Perform HTTP health checks against external endpoints.
   * All endpoints are checked concurrently via Promise.allSettled.
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

    // Check all endpoints concurrently
    const results = await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        const method = endpoint.method ?? 'GET';
        const expectedStatus = endpoint.expected_status ?? 200;
        const timeoutMs = (endpoint.timeout ?? 30) * 1000;
        const retries = endpoint.retries ?? 3;
        const retryDelay = (endpoint.retry_delay ?? 5) * 1000;

        let lastError = '';

        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const response = await fetch(endpoint.url, {
              method,
              signal: AbortSignal.timeout(timeoutMs),
            });

            if (response.status === expectedStatus) {
              printDebug(`HTTP check passed: ${method} ${endpoint.url} → ${response.status}`);
              return; // success
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

        // All retries exhausted
        throw new Error(`${method} ${endpoint.url} — ${lastError}`);
      }),
    );

    const failedEndpoints: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        failedEndpoints.push(endpoints[i].url);
        printWarning(`HTTP check failed: ${msg}`);
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
