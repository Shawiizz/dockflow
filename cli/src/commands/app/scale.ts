/**
 * Scale command - Scale service replicas
 *
 * Uses the StackBackend abstraction to support both Swarm and k3s.
 */

import type { Command } from 'commander';
import { printDebug, createSpinner } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createStackBackend } from '../../services/orchestrator/factory';
import { CLIError, DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerScaleCommand(program: Command): void {
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string, replicas: string, options: { server?: string }) => {
      const { config, stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const replicaCount = parseInt(replicas, 10);
      if (isNaN(replicaCount) || replicaCount < 0) {
        throw new CLIError('Replicas must be a non-negative number', ErrorCode.INVALID_ARGUMENT);
      }

      const orchType = config.orchestrator ?? 'swarm';
      const orchestrator = createStackBackend(orchType, connection);
      const spinner = createSpinner();
      spinner.start(`Scaling ${stackName}_${service} to ${replicaCount} replicas...`);

      try {
        await orchestrator.scaleService(stackName, service, replicaCount);
        spinner.succeed('Done');
      } catch (error) {
        if (error instanceof CLIError) {
          spinner.fail(error.message);
          throw error;
        }
        spinner.fail(`Failed to scale: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
