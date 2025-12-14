/**
 * Rollback command - Rollback to previous version
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printSuccess } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <env> [service]')
    .description('Rollback to previous version')
    .action(async (env: string, service?: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Rolling back ${stackName}_${service}...`);
          const result = sshExec(connection, `docker service rollback ${stackName}_${service}`);
          if (result.exitCode === 0) {
            spinner.succeed(`Rolled back ${stackName}_${service}`);
          } else {
            spinner.warn(`Rollback may have failed: ${result.stderr}`);
          }
        } else {
          // Get all services
          const servicesResult = await sshExec(connection, `docker stack services ${stackName} --format '{{.Name}}'`);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          if (services.length === 0) {
            spinner.warn('No services found to rollback');
            return;
          }

          // Rollback all services in parallel with a single SSH command
          spinner.start(`Rolling back ${services.length} services...`);
          const rollbackCmd = services.map(svc => `docker service rollback ${svc} 2>&1`).join(' & ');
          const result = sshExec(connection, `${rollbackCmd}; wait`);
          
          if (result.exitCode === 0) {
            spinner.succeed(`Rolled back ${services.length} services`);
          } else {
            spinner.warn(`Some rollbacks may have failed: ${result.stderr || result.stdout}`);
          }
          
          printSuccess('Rollback complete');
        }
      } catch (error) {
        spinner.fail(`Failed to rollback: ${error}`);
        process.exit(1);
      }
    });
}
