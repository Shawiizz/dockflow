/**
 * HealthCheck — orchestrator-agnostic health checking.
 *
 * Internal health checks (Swarm tasks or K8s pods) are delegated to the
 * injected StackBackend. HTTP endpoint checks run sequentially with a
 * per-endpoint spinner that updates in place on each retry.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { printDebug, printDim, printWarning, createSpinner } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import type { HealthCheckConfig, HealthCheckEndpoint } from '../utils/config';
import type { StackBackend, InternalHealthResult } from './orchestrator/interfaces';

// Defaults — overridable via config.health_checks.timeout / .interval
const DEFAULT_HEALTHCHECK_TIMEOUT_S = 120;
const DEFAULT_HEALTHCHECK_INTERVAL_S = 5;

export class HealthCheck {
  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackBackend: StackBackend,
  ) {}

  /**
   * Orchestrator-agnostic internal health check.
   * Delegates to the injected StackBackend (Swarm or k3s).
   */
  async checkInternalHealth(
    stackName: string,
    config?: HealthCheckConfig,
    servicesFilter?: string[],
    deployStartedAt?: Date,
  ): Promise<InternalHealthResult> {
    const timeoutS = config?.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_S;
    const intervalS = config?.interval ?? DEFAULT_HEALTHCHECK_INTERVAL_S;

    return this.stackBackend.checkInternalHealth(stackName, timeoutS, intervalS, servicesFilter, deployStartedAt);
  }

  private async checkHTTPLocal(
    endpoint: HealthCheckEndpoint,
    onRetry?: (attempt: number, total: number) => void,
  ): Promise<void> {
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
        onRetry?.(attempt, retries);
        await Bun.sleep(retryDelay);
      }
    }

    throw new Error(`${method} ${endpoint.url} — ${lastError}`);
  }

  private async checkHTTPRemote(
    endpoint: HealthCheckEndpoint,
    onRetry?: (attempt: number, total: number) => void,
  ): Promise<void> {
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
        onRetry?.(attempt, retries);
        await Bun.sleep(retryDelay);
      }
    }

    throw new Error(`${method} ${endpoint.url} — ${lastError}`);
  }

  async checkHTTPEndpoints(config: HealthCheckConfig): Promise<string[]> {
    const endpoints = config.endpoints ?? [];
    if (endpoints.length === 0) return [];

    const startupDelay = config.startup_delay ?? 0;
    if (startupDelay > 0) {
      printDim(`Waiting ${startupDelay}s before HTTP health checks...`);
      await Bun.sleep(startupDelay * 1000);
    }

    const failedEndpoints: string[] = [];

    for (const endpoint of endpoints) {
      const spinner = createSpinner();
      spinner.start(`HTTP check ${endpoint.url}`);

      const onRetry = (attempt: number, total: number) => {
        spinner.update(`HTTP check ${endpoint.url} [${attempt}/${total}]`);
      };

      try {
        if (endpoint.remote) {
          await this.checkHTTPRemote(endpoint, onRetry);
        } else {
          await this.checkHTTPLocal(endpoint, onRetry);
        }
        spinner.succeed(`HTTP check passed: ${endpoint.url}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failedEndpoints.push(endpoint.url);
        spinner.fail(`HTTP check failed: ${msg}`);
        if (!endpoint.remote) {
          printWarning('Hint: this check ran on this machine, not on the remote server. Add `remote: true` to run it via SSH on the deployment target.');
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
        // This service only signals the failure — deploy.ts performs the actual rollback.
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
