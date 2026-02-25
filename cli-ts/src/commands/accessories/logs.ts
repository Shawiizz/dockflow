/**
 * Accessories Logs Command
 * View logs for accessory services
 *
 * Uses LogsService (shared with app commands)
 */

import type { Command } from 'commander';
import { printInfo, printSection, printBlank } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createLogsService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

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
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string,
      service: string | undefined,
      options: { follow?: boolean; tail?: string; since?: string; timestamps?: boolean; raw?: boolean; server?: string }
    ) => {
      const { connection } = validateEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      const logsService = createLogsService(connection, stackName);
      const logOptions = {
        tail: parseInt(options.tail || '100', 10),
        follow: options.follow,
        timestamps: options.timestamps,
        since: options.since,
        raw: options.raw,
      };

      try {
        if (service) {
          printInfo(`Logs for ${service}:`);
          printBlank();
          await logsService.streamServiceLogs(service, logOptions);
        } else {
          await logsService.streamAllLogs(logOptions, (serviceName) => {
            if (!options.follow) {
              printSection(serviceName);
            } else {
              printInfo(`Following logs for ${serviceName} (specify a service name to follow a different one)`);
            }
          });
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to fetch logs: ${error}`);
      }
    }));
}
