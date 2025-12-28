/**
 * Accessories Restart Command
 * Restart accessory services by forcing an update
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printInfo, printSuccess, printHeader } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { requireAccessoriesStack, requireAccessoryService, getShortServiceNames } from './utils';
import { DockerError, withErrorHandler } from '../../utils/errors';

/**
 * Register the accessories restart command
 */
export function registerAccessoriesRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart accessory services')
    .option('--force', 'Force restart even if service is updating')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string, 
      service: string | undefined,
      options: { force?: boolean; server?: string }
    ) => {
      printHeader(`Restarting Accessories - ${env}`);
      console.log('');

      // Validate environment and stack
      const { connection } = validateEnv(env, options.server);
      const { stackName, services } = await requireAccessoriesStack(connection, env);

      if (services.length === 0) {
        throw new DockerError('No accessories services found');
      }

      try {
        const forceFlag = options.force ? '--force' : '';
        
        if (service) {
          // Restart specific service - validate it exists
          const fullServiceName = await requireAccessoryService(connection, stackName, service);

          const spinner = ora(`Restarting ${service}...`).start();
          
          const restartCmd = `docker service update ${forceFlag} --force ${fullServiceName}`;
          const result = await sshExec(connection, restartCmd);

          if (result.exitCode !== 0) {
            spinner.fail('Restart failed');
            throw new DockerError(result.stderr || 'Failed to restart service');
          }

          spinner.succeed(`Accessory '${service}' restarted`);

        } else {
          // Restart all services in the stack
          printInfo(`Restarting ${services.length} accessories...`);
          console.log('');

          const shortNames = getShortServiceNames(services, stackName);
          
          for (let i = 0; i < services.length; i++) {
            const svc = services[i];
            const svcName = shortNames[i];
            const spinner = ora(`Restarting ${svcName}...`).start();
            
            const restartCmd = `docker service update ${forceFlag} --force ${svc}`;
            const result = await sshExec(connection, restartCmd);

            if (result.exitCode !== 0) {
              spinner.fail(`Failed to restart ${svcName}`);
            } else {
              spinner.succeed(`${svcName} restarted`);
            }
          }
        }

        console.log('');
        printSuccess('Restart complete');
        
        // Show status
        console.log('');
        const statusResult = await sshExec(connection, 
          `docker stack services ${stackName} --format "table {{.Name}}\t{{.Replicas}}\t{{.Image}}"`
        );
        console.log(statusResult.stdout);

      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to restart: ${error}`);
      }
    }));
}
