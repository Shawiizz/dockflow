/**
 * Scale command - Scale service replicas
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { validateEnvOrExit } from '../../utils/validation';

export function registerScaleCommand(program: Command): void {
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .action(async (env: string, service: string, replicas: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      const spinner = ora(`Scaling ${stackName}_${service} to ${replicas} replicas...`).start();

      try {
        await sshExec(connection, `docker service scale ${stackName}_${service}=${replicas}`);
        spinner.succeed(`Scaled ${stackName}_${service} to ${replicas} replicas`);
      } catch (error) {
        spinner.fail(`Failed to scale: ${error}`);
        process.exit(1);
      }
    });
}
