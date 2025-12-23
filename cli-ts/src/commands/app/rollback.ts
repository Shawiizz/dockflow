/**
 * Rollback command - Rollback to previous version
 * 
 * Uses StackService to handle service rollbacks.
 */

import type { Command } from 'commander';
import ora from 'ora';
import { printSuccess } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createStackService } from '../../services';

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <env> [service]')
    .description('Rollback to previous version')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const stackService = createStackService(connection, stackName);
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Rolling back ${stackName}_${service}...`);
          const result = await stackService.rollback(service);
          
          if (result.success) {
            spinner.succeed(result.message);
          } else {
            spinner.warn(`Rollback may have failed: ${result.message}`);
          }
        } else {
          spinner.start('Rolling back all services...');
          const result = await stackService.rollback();
          
          if (result.success) {
            spinner.succeed(result.message);
          } else {
            spinner.warn(result.message);
            if (result.output) {
              console.log(result.output);
            }
          }
          
          printSuccess('Rollback complete');
        }
      } catch (error) {
        spinner.fail(`Failed to rollback: ${error}`);
        process.exit(1);
      }
    });
}
