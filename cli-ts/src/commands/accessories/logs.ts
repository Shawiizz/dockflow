/**
 * Accessories Logs Command
 * View logs for accessory services
 */

import type { Command } from 'commander';
import { getAccessoriesStackName } from '../../utils/config';
import { sshExec, sshExecStream } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

/**
 * Register the accessories logs command
 */
export function registerAccessoriesLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('View logs for accessories')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .option('--since <time>', 'Show logs since timestamp (e.g., 2021-01-02T13:23:37) or relative (e.g., 42m for 42 minutes)')
    .option('--timestamps', 'Show timestamps')
    .option('--raw', 'Show raw output without pretty printing')
    .action(async (
      env: string, 
      service: string | undefined, 
      options: { follow?: boolean; tail?: string; since?: string; timestamps?: boolean; raw?: boolean }
    ) => {
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

      // Build log command options
      const logOptions: string[] = [];
      
      if (options.follow) logOptions.push('-f');
      if (options.tail) logOptions.push(`--tail=${options.tail}`);
      if (options.since) logOptions.push(`--since=${options.since}`);
      if (options.timestamps) logOptions.push('--timestamps');
      if (options.raw) logOptions.push('--raw');

      const logFlags = logOptions.join(' ');

      try {
        if (service) {
          // Get the full service name
          const fullServiceName = `${stackName}_${service}`;
          
          // Check if service exists
          const checkResult = await sshExec(connection, 
            `docker service ls --filter "name=${fullServiceName}" --format "{{.Name}}"`
          );
          
          if (!checkResult.stdout.trim()) {
            printError(`Accessory '${service}' not found in stack ${stackName}`);
            
            // List available services
            const servicesResult = await sshExec(connection, 
              `docker stack services ${stackName} --format "{{.Name}}" | sed 's/${stackName}_//'`
            );
            if (servicesResult.stdout.trim()) {
              printInfo(`Available accessories: ${servicesResult.stdout.trim().split('\n').join(', ')}`);
            }
            process.exit(1);
          }

          // Logs for specific service
          printInfo(`Logs for ${service}:`);
          console.log('');
          
          const cmd = `docker service logs ${logFlags} ${fullServiceName} 2>&1`;
          await sshExecStream(connection, cmd);

        } else {
          // Get all services in the stack
          const servicesResult = await sshExec(connection, 
            `docker stack services ${stackName} --format "{{.Name}}"`
          );
          
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          if (services.length === 0) {
            printError('No accessories services found');
            process.exit(1);
          }

          if (services.length === 1) {
            // Only one service, show its logs directly
            printInfo(`Logs for ${services[0].replace(`${stackName}_`, '')}:`);
            console.log('');
            const cmd = `docker service logs ${logFlags} ${services[0]} 2>&1`;
            await sshExecStream(connection, cmd);
          } else {
            // Multiple services - show them all (or follow the first one)
            if (options.follow) {
              printInfo(`Following logs for ${services[0].replace(`${stackName}_`, '')}...`);
              printInfo(`(Specify a service name to follow a different one)`);
              console.log('');
              const cmd = `docker service logs ${logFlags} ${services[0]} 2>&1`;
              await sshExecStream(connection, cmd);
            } else {
              // Show logs from all services sequentially
              for (const svc of services) {
                const svcName = svc.replace(`${stackName}_`, '');
                console.log('');
                console.log(`=== ${svcName} ===`);
                console.log('');
                const cmd = `docker service logs ${logFlags} ${svc} 2>&1`;
                await sshExecStream(connection, cmd);
              }
            }
          }
        }
      } catch (error) {
        printError(`Failed to fetch logs: ${error}`);
        process.exit(1);
      }
    });
}
