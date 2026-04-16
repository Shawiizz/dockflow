/**
 * Health Check Service
 *
 * Orchestrator-agnostic health checking. Internal health checks (Swarm tasks
 * or K8s pods) are delegated to the injected HealthBackend. HTTP endpoint
 * checks run concurrently via Promise.allSettled.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { printDebug, printDim, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import type { HealthCheckConfig, HealthCheckEndpoint } from '../utils/config';
import type { HealthBackend, InternalHealthResult } from './orchestrator/health-interface';

// Defaults — overridable via config.health_checks.timeout / .interval
const DEFAULT_HEALTHCHECK_TIMEOUT_S = 120;
const DEFAULT_HEALTHCHECK_INTERVAL_S = 5;

export class HealthCheckService {
  private readonly healthBackend?: HealthBackend;

  constructor(
    private readonly connection: SSHKeyConnection,
    healthBackend?: HealthBackend,
  ) {
    this.healthBackend = healthBackend;
  }

  /**
   * Orchestrator-agnostic internal health check.
   * Delegates to the injected HealthBackend (Swarm or k3s).
   * Throws DeployError if no backend is configured.
   */
  async checkInternalHealth(
    stackName: string,
    config?: HealthCheckConfig,
  ): Promise<InternalHealthResult> {
    if (!this.healthBackend) {
      throw new DeployError(
        'No health backend configured',
        ErrorCode.HEALTH_CHECK_FAILED,
      );
    }

    const timeoutS = config?.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_S;
    const intervalS = config?.interval ?? DEFAULT_HEALTHCHECK_INTERVAL_S;

    return this.healthBackend.checkInternalHealth(stackName, timeoutS, intervalS);
  }

  /**
   * Perform a single HTTP health check locally via fetch.
   */
  private async checkHTTPLocal(endpoint: HealthCheckEndpoint): Promise<void> {
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
          return;
        }

        lastError = `Expected ${expectedStatus}, got ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < retries) {
        printDebug(`HTTP check ${endpoint.url} attempt ${attempt}/${retries} failed: ${lastError}`);
        await Bun.sleep(retryDelay);
      }
    }

    throw new Error(`${method} ${endpoint.url} — ${lastError}`);
  }

  /**
   * Perform a single HTTP health check remotely via SSH curl.
   * Runs on the manager node — suitable for localhost/internal endpoints.
   */
  private async checkHTTPRemote(endpoint: HealthCheckEndpoint): Promise<void> {
    const method = endpoint.method ?? 'GET';
    const expectedStatus = endpoint.expected_status ?? 200;
    const timeoutS = endpoint.timeout ?? 30;
    const retries = endpoint.retries ?? 3;
    const retryDelay = (endpoint.retry_delay ?? 5) * 1000;

    const curlFlags = [
      '-4', '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', String(timeoutS),
      '-X', method,
    ];
    if (endpoint.validate_certs === false) curlFlags.push('-k');
    // Shell-escape the URL to avoid injection (no shell expansion in double-quoted string)
    const safeUrl = endpoint.url.replace(/'/g, "'\\''");
    const cmd = `curl ${curlFlags.join(' ')} '${safeUrl}'`;

    let lastError = '';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await sshExec(this.connection, cmd);
        const status = parseInt(result.stdout.trim(), 10);

        if (status === expectedStatus) {
          printDebug(`HTTP check (remote) passed: ${method} ${endpoint.url} → ${status}`);
          return;
        }

        lastError = `Expected ${expectedStatus}, got ${isNaN(status) ? result.stdout.trim() : status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < retries) {
        printDebug(`HTTP check (remote) ${endpoint.url} attempt ${attempt}/${retries} failed: ${lastError}`);
        await Bun.sleep(retryDelay);
      }
    }

    throw new Error(`${method} ${endpoint.url} — ${lastError}`);
  }

  /**
   * Perform HTTP health checks against external endpoints.
   * All endpoints are checked concurrently via Promise.allSettled.
   * Endpoints with `remote: true` run via SSH curl on the manager node.
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
      await Bun.sleep(startupDelay * 1000);
    }

    // Check all endpoints concurrently
    const results = await Promise.allSettled(
      endpoints.map((endpoint) =>
        endpoint.remote
          ? this.checkHTTPRemote(endpoint)
          : this.checkHTTPLocal(endpoint),
      ),
    );

    const failedEndpoints: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        failedEndpoints.push(endpoints[i].url);
        printWarning(`HTTP check failed: ${msg}`);
        if (!endpoints[i].remote) {
          printWarning(`Hint: this check ran on this machine, not on the remote server. Add \`remote: true\` to the endpoint to run it via SSH on the deployment target.`);
        }
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
        // Note: this service only signals the failure — the caller (deploy.ts)
        // is responsible for performing the actual rollback based on config.health_checks.on_failure.
        throw new DeployError(
          `HTTP health checks failed: ${failedEndpoints.join(', ')}`,
          ErrorCode.HEALTH_CHECK_FAILED,
          'The deploy command will attempt a rollback (on_failure: rollback).',
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
