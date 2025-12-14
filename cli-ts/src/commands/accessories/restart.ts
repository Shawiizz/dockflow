/**
 * Accessories Restart Command
 * Restart accessory services by forcing an update
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getAccessoriesStackName } from '../../utils/config';
import { sshExec, sshExecStream } from '../../utils/ssh';
import { printError, printInfo, printSuccess, printHeader } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

/**
 * Register the accessories restart command
 */
export function registerAccessoriesRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart accessory services')
    .option('--force', 'Force restart even if service is updating')
    .action(async (
      env: string, 
      service: string | undefined,
      options: { force?: boolean }
    ) => {
      printHeader(`Restarting Accessories - ${env}`);
      console.log('');

      // Validate environment
      const { connection } = await validateEnvOrExit(env);
      const stackName = getAccessoriesStackName(env)!;

      // Check if accessories stack exists
      const stacksResult = await sshExec(connection, `docker stack ls --format "{{.Name}}"`);
      const stacks = stacksResult.stdout.trim().split('\n').filter(Boolean);
      
      if (!stacks.includes(stackName)) {
        printError('Accessories not deployed yet');
        printInfo(`Deploy with: dockflow deploy ${env} --accessories`);
        process.exit(1);
      }

      try {
        if (service) {
          // Restart specific service
          const fullServiceName = `${stackName}_${service}`;
          
          // Check if service exists
          const checkResult = await sshExec(connection, 
            `docker service ls --filter "name=${fullServiceName}" --format "{{.Name}}"`
          );
          
          if (!checkResult.stdout.trim()) {
            printError(`Accessory '${service}' not found`);
            const servicesResult = await sshExec(connection, 
              `docker stack services ${stackName} --format "{{.Name}}" | sed 's/${stackName}_//'`
            );
            if (servicesResult.stdout.trim()) {
              printInfo(`Available accessories: ${servicesResult.stdout.trim().split('\n').join(', ')}`);
            }
            process.exit(1);
          }

          const spinner = ora(`Restarting ${service}...`).start();
          
          // Force update to restart the service
          const forceFlag = options.force ? '--force' : '';
          const restartCmd = `docker service update ${forceFlag} --force ${fullServiceName}`;
          const result = await sshExec(connection, restartCmd);

          if (result.exitCode !== 0) {
            spinner.fail('Restart failed');
            console.error(result.stderr);
            process.exit(1);
          }

          spinner.succeed(`Accessory '${service}' restarted`);

        } else {
          // Restart all services in the stack
          const servicesResult = await sshExec(connection, 
            `docker stack services ${stackName} --format "{{.Name}}"`
          );
          
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          if (services.length === 0) {
            printError('No accessories services found');
            process.exit(1);
          }

          printInfo(`Restarting ${services.length} accessories...`);
          console.log('');

          for (const svc of services) {
            const svcName = svc.replace(`${stackName}_`, '');
            const spinner = ora(`Restarting ${svcName}...`).start();
            
            const forceFlag = options.force ? '--force' : '';
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
        printError(`Failed to restart: ${error}`);
        process.exit(1);
      }
    });
}
