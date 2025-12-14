/**
 * Accessories Stop Command
 * Stop accessory services by scaling to 0 replicas
 */

import type { Command } from 'commander';
import ora from 'ora';
import inquirer from 'inquirer';
import { getAccessoriesStackName } from '../../utils/config';
import { sshExec } from '../../utils/ssh';
import { printError, printInfo, printSuccess, printHeader, printWarning } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

/**
 * Register the accessories stop command
 */
export function registerAccessoriesStopCommand(program: Command): void {
  program
    .command('stop <env> [service]')
    .description('Stop accessory services (scale to 0, can be restarted)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (
      env: string, 
      service: string | undefined,
      options: { yes?: boolean }
    ) => {
      printHeader(`Stopping Accessories - ${env}`);
      console.log('');

      // Validate environment
      const { connection } = await validateEnvOrExit(env);
      const stackName = getAccessoriesStackName(env)!;

      // Check if accessories stack exists
      const stacksResult = await sshExec(connection, `docker stack ls --format "{{.Name}}"`);
      const stacks = stacksResult.stdout.trim().split('\n').filter(Boolean);
      
      if (!stacks.includes(stackName)) {
        printError('Accessories not deployed');
        printInfo('Nothing to stop.');
        process.exit(1);
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
          // Stop specific service
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

          const spinner = ora(`Stopping ${service}...`).start();
          
          const stopCmd = `docker service scale ${fullServiceName}=0`;
          const result = await sshExec(connection, stopCmd);

          if (result.exitCode !== 0) {
            spinner.fail('Stop failed');
            console.error(result.stderr);
            process.exit(1);
          }

          spinner.succeed(`Accessory '${service}' stopped`);

        } else {
          // Stop all services in the stack
          const servicesResult = await sshExec(connection, 
            `docker stack services ${stackName} --format "{{.Name}}"`
          );
          
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          if (services.length === 0) {
            printError('No accessories services found');
            process.exit(1);
          }

          printInfo(`Stopping ${services.length} accessories...`);
          console.log('');

          // Build scale command for all services at once
          const scaleArgs = services.map(svc => `${svc}=0`).join(' ');
          const spinner = ora('Scaling all services to 0...').start();
          
          const stopCmd = `docker service scale ${scaleArgs}`;
          const result = await sshExec(connection, stopCmd);

          if (result.exitCode !== 0) {
            spinner.fail('Stop failed');
            console.error(result.stderr);
            process.exit(1);
          }

          spinner.succeed('All accessories stopped');
        }

        console.log('');
        printSuccess('Accessories stopped');
        
        console.log('');
        printInfo(`To restart: dockflow accessories restart ${env}` + (service ? ` ${service}` : ''));
        printInfo(`To remove:  dockflow accessories remove ${env}` + (service ? ` ${service}` : ''));

      } catch (error) {
        printError(`Failed to stop: ${error}`);
        process.exit(1);
      }
    });
}
