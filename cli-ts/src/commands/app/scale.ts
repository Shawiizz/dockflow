/**
 * Scale command - Scale service replicas
 * 
 * Uses StackService to handle service scaling.
 */

import type { Command } from 'commander';
import ora from 'ora';
import { validateEnvOrExit } from '../../utils/validation';
import { createStackService } from '../../services';

export function registerScaleCommand(program: Command): void {
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, service: string, replicas: string, options: { server?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const replicaCount = parseInt(replicas, 10);
      if (isNaN(replicaCount) || replicaCount < 0) {
        console.error('Replicas must be a non-negative number');
        process.exit(1);
      }

      const stackService = createStackService(connection, stackName);
      const spinner = ora(`Scaling ${stackName}_${service} to ${replicaCount} replicas...`).start();

      try {
        const result = await stackService.scale(service, replicaCount);
        
        if (result.success) {
          spinner.succeed(result.message);
        } else {
          spinner.fail(result.message);
          process.exit(1);
        }
      } catch (error) {
        spinner.fail(`Failed to scale: ${error}`);
        process.exit(1);
      }
    });
}
