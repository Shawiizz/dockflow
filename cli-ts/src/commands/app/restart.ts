/**
 * Restart command - Restart services
 * 
 * Uses StackService to handle service restarts.
 */

import type { Command } from 'commander';
import ora from 'ora';
import { printSuccess, printDebug, printRaw } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });
      
      const stackService = createStackService(connection, stackName);
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Restarting ${stackName}_${service}...`);
          const result = await stackService.restart(service);
          
          if (result.success) {
            spinner.succeed(result.message);
          } else {
            spinner.fail(result.message || 'Restart failed');
            throw new DockerError(result.message || 'Failed to restart service');
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
              printRaw(result.output);
            }
          }
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        spinner.fail(`Failed to restart: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
