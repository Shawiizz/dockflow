/**
 * Accessories Logs Command
 * View logs for accessory services
 */

import type { Command } from 'commander';
import { sshExecStream } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { requireAccessoriesStack, requireAccessoryService, getShortServiceNames } from './utils';

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
      // Validate environment and stack
      const { connection } = await validateEnvOrExit(env);
      const { stackName, services } = await requireAccessoriesStack(connection, env);

      if (services.length === 0) {
        printError('No accessories services found');
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
          // Get the full service name - validate it exists
          const fullServiceName = await requireAccessoryService(connection, stackName, service);

          // Logs for specific service
          printInfo(`Logs for ${service}:`);
          console.log('');
          
          const cmd = `docker service logs ${logFlags} ${fullServiceName} 2>&1`;
          await sshExecStream(connection, cmd);

        } else {
          const shortNames = getShortServiceNames(services, stackName);

          if (services.length === 1) {
            // Only one service, show its logs directly
            printInfo(`Logs for ${shortNames[0]}:`);
            console.log('');
            const cmd = `docker service logs ${logFlags} ${services[0]} 2>&1`;
            await sshExecStream(connection, cmd);
          } else {
            // Multiple services - show them all (or follow the first one)
            if (options.follow) {
              printInfo(`Following logs for ${shortNames[0]}...`);
              printInfo(`(Specify a service name to follow a different one)`);
              console.log('');
              const cmd = `docker service logs ${logFlags} ${services[0]} 2>&1`;
              await sshExecStream(connection, cmd);
            } else {
              // Show logs from all services sequentially
              for (let i = 0; i < services.length; i++) {
                console.log('');
                console.log(`=== ${shortNames[i]} ===`);
                console.log('');
                const cmd = `docker service logs ${logFlags} ${services[i]} 2>&1`;
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
