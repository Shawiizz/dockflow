/**
 * Logs command - View service logs
 * 
 * Uses LogsService to handle log retrieval and streaming.
 */

import type { Command } from 'commander';
import { printError, printInfo, printSection } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createLogsService } from '../../services';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .option('-t, --timestamps', 'Show timestamps')
    .option('--since <time>', 'Show logs since timestamp (e.g., "1h", "2024-01-01")')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, service: string | undefined, options: { 
      follow?: boolean; 
      tail?: string; 
      timestamps?: boolean;
      since?: string;
      server?: string 
    }) => {
      const { stackName, connection, serverName } = await validateEnvOrExit(env, options.server);
      printInfo(`Server: ${serverName}`);
      printInfo(`Fetching logs for stack: ${stackName}`);
      console.log('');

      const logsService = createLogsService(connection, stackName);
      const logOptions = {
        tail: parseInt(options.tail || '100', 10),
        follow: options.follow,
        timestamps: options.timestamps,
        since: options.since,
      };

      try {
        if (service) {
          // Logs for specific service
          await logsService.streamServiceLogs(service, logOptions);
        } else {
          // Logs for all services
          await logsService.streamAllLogs(logOptions, (serviceName) => {
            if (!options.follow) {
              printSection(serviceName);
            } else {
              printInfo(`Following logs for ${serviceName} (use service name to follow specific service)`);
            }
          });
        }
      } catch (error) {
        printError(`Failed to fetch logs: ${error}`);
        process.exit(1);
      }
    });
}
