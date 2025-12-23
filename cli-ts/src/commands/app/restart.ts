/**
 * Restart command - Restart services
 * 
 * Uses StackService to handle service restarts.
 */

import type { Command } from 'commander';
import ora from 'ora';
import { printSuccess, printError } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createStackService } from '../../services';

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const stackService = createStackService(connection, stackName);
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Restarting ${stackName}_${service}...`);
          const result = await stackService.restart(service);
          
          if (result.success) {
            spinner.succeed(result.message);
          } else {
            spinner.fail(result.message);
            process.exit(1);
          }
        } else {
          spinner.start('Restarting all services...');
          const result = await stackService.restart();
          
          if (result.success) {
            spinner.succeed(result.message);
            printSuccess('All services restarted');
          } else {
            spinner.warn(result.message);
            if (result.output) {
              console.log(result.output);
            }
          }
        }
      } catch (error) {
        spinner.fail(`Failed to restart: ${error}`);
        process.exit(1);
      }
    });
}
