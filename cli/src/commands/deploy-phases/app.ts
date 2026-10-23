/**
 * App phase: deploy the app stack, wait for Swarm to converge and check the health of its services.
 */

import { DeployError, ErrorCode } from '../../utils/errors';
import * as Compose from '../../services/compose';
import type { ParsedCompose } from '../../services/compose';
import { HealthCheck } from '../../services/health-check';
import { CONVERGENCE_TIMEOUT_S, CONVERGENCE_INTERVAL_S } from '../../constants';
import type { DeployContext } from '../deploy-context';
import { appStackInput } from './stack-render';
import { ensureProxy } from './shared';

/** Why the stack did not converge, with the command that shows more. */
export function convergenceError(
  convergence: { rolledBack: boolean; timedOut: boolean; errorDetail?: string },
  env: string,
  stack: 'app' | 'accessories' = 'app',
): DeployError {
  if (convergence.rolledBack) {
    const logs = stack === 'app' ? `dockflow logs ${env} <service>` : `dockflow accessories logs ${env} <accessory>`;
    return new DeployError(
      convergence.errorDetail ?? 'Swarm rolled the new version back',
      ErrorCode.HEALTH_CHECK_FAILED,
      `The new version failed to start; see why with \`${logs}\`.`,
    );
  }
  return new DeployError(
    convergence.errorDetail ?? 'The services did not converge in time',
    ErrorCode.DEPLOY_FAILED,
    `Run \`dockflow diagnose ${env}\` to see what keeps them from starting.`,
  );
}

/** How far the app deploy got, for what a failure must undo. */
export interface AppProgress {
  /** the stack reached Swarm: the new version may run */
  sent: boolean;
  /** Swarm put the previous version back by itself */
  swarmRolledBack: boolean;
}

export async function deployApp(ctx: DeployContext, compose: ParsedCompose, app: AppProgress = { sent: false, swarmRolledBack: false }): Promise<void> {
  if (!ctx.deployApp) return;
  if (!Compose.hasServices(compose)) return;

  await ensureProxy(ctx);

  const input = appStackInput(ctx, compose);
  const servicesFilter = input.servicesFilter;

  const deployStartedAt = new Date();

  const deployResult = await ctx.swarm.deploy(input);
  if (!deployResult.success) {
    throw deployResult.error;
  }
  app.sent = true;

  const convergence = await ctx.swarm.waitConvergence(
    ctx.stackName,
    CONVERGENCE_TIMEOUT_S,
    CONVERGENCE_INTERVAL_S,
    servicesFilter,
  );
  if (!convergence.converged) {
    app.swarmRolledBack = convergence.rolledBack;
    throw convergenceError(convergence, ctx.env);
  }

  if (ctx.config.health_checks?.enabled !== false) {
    const health = new HealthCheck(ctx.cluster.manager.connection, ctx.swarm);
    const internalResult = await health.checkInternalHealth(ctx.stackName, ctx.config.health_checks, servicesFilter, deployStartedAt);
    if (!internalResult.healthy) {
      throw new DeployError(
        internalResult.message || `Health check failed${internalResult.failedService ? `: ${internalResult.failedService}` : ''}`,
        ErrorCode.HEALTH_CHECK_FAILED,
        `Check its logs: \`dockflow logs ${ctx.env} ${internalResult.failedService ?? '<service>'}\`.`,
      );
    }

  }

}
