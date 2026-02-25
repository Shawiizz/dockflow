/**
 * Logs command - View service logs
 * 
 * Uses LogsService to handle log retrieval and streaming.
 */

import type { Command } from 'commander';
import { printInfo, printSection, printDebug, printBlank } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createLogsService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .option('-t, --timestamps', 'Show timestamps')
    .option('--since <time>', 'Show logs since timestamp (e.g., "1h", "2024-01-01")')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string | undefined, options: { 
      follow?: boolean; 
      tail?: string; 
      timestamps?: boolean;
      since?: string;
      server?: string 
    }) => {
      const { stackName, connection, serverName } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, serverName });
      printInfo(`Server: ${serverName}`);
      printInfo(`Fetching logs for stack: ${stackName}`);
      printBlank();

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
        throw new DockerError(`Failed to fetch logs: ${error}`);
      }
    }));
}
