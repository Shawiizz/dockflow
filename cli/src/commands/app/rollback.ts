/**
 * Rollback command - Rollback to previous version
 *
 * Uses the OrchestratorService abstraction to support both Swarm and k3s.
 */

import type { Command } from 'commander';
import { printDebug, printRaw, createSpinner } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createOrchestrator } from '../../services/orchestrator/factory';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <env> [service]')
    .description('Rollback to previous version')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { config, stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const orchType = config.orchestrator ?? 'swarm';
      const orchestrator = createOrchestrator(orchType, connection);
      const spinner = createSpinner();

      try {
        if (service) {
          spinner.start(`Rolling back ${stackName}_${service}...`);
          await orchestrator.rollbackService(stackName, service);
          spinner.succeed('Done');
        } else {
          spinner.start('Rolling back all services...');
          const services = await orchestrator.getServices(stackName);

          if (services.length === 0) {
            spinner.warn('No services found');
            return;
          }

          const errors: string[] = [];
          for (const svc of services) {
            try {
              await orchestrator.rollbackService(stackName, svc.name);
            } catch (e) {
              errors.push(`${svc.name}: ${e}`);
            }
          }

          if (errors.length === 0) {
            spinner.succeed('Done');
          } else {
            spinner.warn(`Rollback completed with ${errors.length} error(s)`);
            for (const msg of errors) {
              printRaw(`  ${msg}`);
            }
            throw new DockerError('Some services failed to rollback');
          }
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        spinner.fail(`Failed to rollback: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
