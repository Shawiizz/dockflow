/**
 * Accessories Stop Command
 * Stop accessory services by scaling to 0 replicas
 */

import type { Command } from 'commander';
import ora from 'ora';
import inquirer from 'inquirer';
import { sshExec } from '../../utils/ssh';
import { printInfo, printSuccess, printHeader, printWarning } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { requireAccessoriesStack, requireAccessoryService } from './utils';
import { DockerError, withErrorHandler } from '../../utils/errors';

/**
 * Register the accessories stop command
 */
export function registerAccessoriesStopCommand(program: Command): void {
  program
    .command('stop <env> [service]')
    .description('Stop accessory services (scale to 0, can be restarted)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string, 
      service: string | undefined,
      options: { yes?: boolean; server?: string }
    ) => {
      printHeader(`Stopping Accessories - ${env}`);
      console.log('');

      // Validate environment and stack
      const { connection } = validateEnv(env, options.server);
      const { stackName, services } = await requireAccessoriesStack(connection, env);

      if (services.length === 0) {
        throw new DockerError('No accessories services found');
      }

      const targetDesc = service ? `accessory '${service}'` : 'all accessories';

      // Confirmation
      if (!options.yes) {
        printWarning(`This will stop ${targetDesc} (scale to 0 replicas)`);
        printInfo('Data in volumes will be preserved');
        console.log('');
        
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Are you sure you want to stop ${targetDesc}?`,
            default: false,
          },
        ]);

        if (!confirm) {
          printInfo('Cancelled');
          return;
        }
      }

      try {
        if (service) {
          // Stop specific service - validate it exists
          const fullServiceName = await requireAccessoryService(connection, stackName, service);

          const spinner = ora(`Stopping ${service}...`).start();
          
          const stopCmd = `docker service scale ${fullServiceName}=0`;
          const result = await sshExec(connection, stopCmd);

          if (result.exitCode !== 0) {
            spinner.fail('Stop failed');
            throw new DockerError(result.stderr || 'Failed to stop service');
          }

          spinner.succeed(`Accessory '${service}' stopped`);

        } else {
          // Stop all services in the stack
          printInfo(`Stopping ${services.length} accessories...`);
          console.log('');

          // Build scale command for all services at once
          const scaleArgs = services.map(svc => `${svc}=0`).join(' ');
          const spinner = ora('Scaling all services to 0...').start();
          
          const stopCmd = `docker service scale ${scaleArgs}`;
          const result = await sshExec(connection, stopCmd);

          if (result.exitCode !== 0) {
            spinner.fail('Stop failed');
            throw new DockerError(result.stderr || 'Failed to stop services');
          }

          spinner.succeed('All accessories stopped');
        }

        console.log('');
        printSuccess('Accessories stopped');
        
        console.log('');
        printInfo(`To restart: dockflow accessories restart ${env}` + (service ? ` ${service}` : ''));
        printInfo(`To remove:  dockflow accessories remove ${env}` + (service ? ` ${service}` : ''));

      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to stop: ${error}`);
      }
    }));
}
