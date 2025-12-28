/**
 * Scale command - Scale service replicas
 * 
 * Uses StackService to handle service scaling.
 */

import type { Command } from 'commander';
import ora from 'ora';
import { printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createStackService } from '../../services';
import { CLIError, DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerScaleCommand(program: Command): void {
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string, replicas: string, options: { server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });
      
      const replicaCount = parseInt(replicas, 10);
      if (isNaN(replicaCount) || replicaCount < 0) {
        throw new CLIError('Replicas must be a non-negative number', ErrorCode.INVALID_ARGUMENT);
      }

      const stackService = createStackService(connection, stackName);
      const spinner = ora(`Scaling ${stackName}_${service} to ${replicaCount} replicas...`).start();

      try {
        const result = await stackService.scale(service, replicaCount);
        
        if (result.success) {
          spinner.succeed(result.message);
        } else {
          spinner.fail(result.message || 'Scale failed');
          throw new DockerError(result.message || 'Failed to scale service');
        }
      } catch (error) {
        if (error instanceof CLIError) throw error;
        spinner.fail(`Failed to scale: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
