/**
 * Rollback command - Rollback to previous version
 */

import type { Command } from 'commander';
import { getPerformer } from '../../utils/config';
import { createSpinner } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { createStackBackend } from '../../services/orchestrator/factory';
import { Release } from '../../services/release';
import { Audit } from '../../services/audit';
import { Metrics } from '../../services/metrics';
import * as Notification from '../../services/notification';
import { withErrorHandler, DeployError, ErrorCode } from '../../utils/errors';
import { runPostRollbackHealthChecks } from '../deploy-phases';
import { requireAppService } from './service-name';
import { createEnvLock } from '../../services/lock';
import { withDeployLock } from '../with-lock';

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <env> [service]')
    .description('Rollback to previous version')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { config, stackName, connection } = await resolveEnv(env, options.server);

      if (config.no_services) {
        throw new DeployError(
          'Rollback is not supported for upload-only projects',
          ErrorCode.ROLLBACK_FAILED,
          'To restore a previous version, re-deploy from the corresponding git commit.',
        );
      }

      const orchestrator = createStackBackend(connection);
      const audit = new Audit(connection);
      const metrics = new Metrics(connection);
      const spinner = createSpinner();
      const startTime = Date.now();

      if (service) await requireAppService(connection, env, stackName, service, 'rollback');
      const lock = await createEnvLock(env, stackName, config.lock?.stale_threshold_minutes);
      // the audit, metrics and notification are written while the lock is held
      await withDeployLock(lock, service ? `Rollback ${service}` : `Rollback ${stackName}`, async () => {
        if (service) {
          spinner.start(`Rolling back ${stackName}_${service}...`);
          await orchestrator.rollbackService(stackName, service);
          spinner.succeed(`Rolled back ${stackName}_${service}`);

          const durationMs = Date.now() - startTime;
          const message = `Rolled back service ${service} in ${stackName}`;
          await Promise.allSettled([
            audit.writeEntry(stackName, 'rolled_back', message, 'service-rollback'),
            metrics.writeDeployment({ stackName, version: 'service-rollback', env, branch: '', status: 'rolled_back', durationMs, performer: getPerformer(), buildSkipped: true, accessoriesDeployed: false, nodeCount: 1 }),
            Notification.notify(config.notifications?.webhooks, { project: config.project_name, env, version: 'service-rollback', branch: '', performer: getPerformer(), status: 'success', duration_ms: durationMs, message }),
          ]);
        } else {
          // Full stack rollback — redeploy previous release compose and update symlink
          spinner.start('Rolling back to previous release...');
          const releases = new Release(connection);
          const rollbackStartedAt = new Date();
          const rolledBackTo = await releases.rollback(stackName, orchestrator);
          spinner.succeed(`Rolled back to ${rolledBackTo}`);
          await runPostRollbackHealthChecks(connection, orchestrator, stackName, config.health_checks, rollbackStartedAt);

          const durationMs = Date.now() - startTime;
          const message = `Rolled back ${stackName} to ${rolledBackTo}`;
          await Promise.allSettled([
            audit.writeEntry(stackName, 'rolled_back', message, rolledBackTo),
            metrics.writeDeployment({ stackName, version: rolledBackTo, env, branch: '', status: 'rolled_back', durationMs, performer: getPerformer(), buildSkipped: true, accessoriesDeployed: false, nodeCount: 1 }),
            Notification.notify(config.notifications?.webhooks, { project: config.project_name, env, version: rolledBackTo, branch: '', performer: getPerformer(), status: 'success', duration_ms: durationMs, message }),
          ]);
        }
      });
    })));
}
