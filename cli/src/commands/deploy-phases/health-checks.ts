/**
 * Health checks run after the app converged: the HTTP endpoints, and the best-effort checks after
 * a rollback.
 */

import { printWarning } from '../../utils/output';
import { HealthCheck } from '../../services/health-check';
import type { SwarmStack } from '../../services/swarm/stack';
import type { HealthCheckConfig } from '../../utils/config';
import type { SSHKeyConnection } from '../../types';
import type { DeployContext } from '../deploy-context';

export async function runHTTPHealthChecks(ctx: DeployContext): Promise<void> {
  if (!ctx.deployApp || !ctx.config.health_checks?.endpoints?.length) return;
  const health = new HealthCheck(ctx.cluster.manager.connection, ctx.swarm);
  await health.checkHTTPEndpoints(ctx.config.health_checks);
}

/**
 * Best-effort: failures are printed as warnings, never thrown, because there is nothing left to
 * roll back to.
 */
export async function runPostRollbackHealthChecks(
  connection: SSHKeyConnection,
  swarm: SwarmStack,
  stackName: string,
  healthConfig: HealthCheckConfig | undefined,
  rollbackStartedAt: Date,
): Promise<void> {
  if (healthConfig?.enabled === false) return;

  const health = new HealthCheck(connection, swarm);

  // a Swarm rollback completed before ours (the failed update's own) says nothing about this version
  const result = await health.checkInternalHealth(stackName, healthConfig, undefined, rollbackStartedAt).catch(() => null);
  if (result && !result.healthy) {
    printWarning(`Rolled-back version is unhealthy: ${result.message ?? result.failedService ?? 'check logs'}`);
  }

  if (healthConfig?.endpoints?.length) {
    // rolling back a rollback is not an option
    await health.checkHTTPEndpoints({ ...healthConfig, on_failure: 'notify' });
  }
}
