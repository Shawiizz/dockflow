/**
 * Restart command - Restart services
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printSuccess } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Restarting ${stackName}_${service}...`);
          await sshExec(connection, `docker service update --force ${stackName}_${service}`);
          spinner.succeed(`Restarted ${stackName}_${service}`);
        } else {
          // Get all services
          const servicesResult = await sshExec(connection, `docker stack services ${stackName} --format '{{.Name}}'`);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          for (const svc of services) {
            spinner.start(`Restarting ${svc}...`);
            await sshExec(connection, `docker service update --force ${svc}`);
            spinner.succeed(`Restarted ${svc}`);
          }
          printSuccess('All services restarted');
        }
      } catch (error) {
        spinner.fail(`Failed to restart: ${error}`);
        process.exit(1);
      }
    });
}
