/**
 * Accessories Logs Command
 * View logs for accessory services
 */

import type { Command } from 'commander';
import { printInfo, printSection, printBlank, printRaw } from '../../utils/output';
import { resolveEnv, withResolvedEnv, getAllNodeConnections } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createContainerBackend, createStackBackend } from '../../services/orchestrator/factory';
import { DockerError, withErrorHandler } from '../../utils/errors';
import { parseTailOption } from '../../utils/log-options';

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
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { follow?: boolean; tail?: string; since?: string; timestamps?: boolean; raw?: boolean; server?: string }
    ) => {
      const { config, connection } = await resolveEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      // All node connections are required: in a multi-node Swarm the
      // accessory containers may run on any worker, not just the manager.
      const logsBackend = createContainerBackend(connection, getAllNodeConnections(env));
      const logOptions = {
        tail: parseTailOption(options.tail, 100),
        follow: options.follow ?? false,
        timestamps: options.timestamps,
        since: options.since,
      };

      try {
        if (service) {
          printInfo(`Logs for ${service}:`);
          printBlank();
          await logsBackend.streamLogs(
            stackName,
            service,
            logOptions,
            (line) => printRaw(line),
            (err) => { throw err; },
          );
        } else {
          // Get service list from orchestrator then stream each
          const orchestrator = createStackBackend(connection);
          const services = await orchestrator.getServices(stackName);

          if (services.length === 0) {
            throw new DockerError('No accessory services found');
          }

          if (options.follow) {
            const svc = services[0];
            printInfo(`Following logs for ${svc.name} (specify a service name to follow a different one)`);
            await logsBackend.streamLogs(
              stackName,
              svc.name,
              logOptions,
              (line) => printRaw(line),
              (err) => { throw err; },
            );
          } else {
            for (const svc of services) {
              printSection(svc.name);
              await logsBackend.streamLogs(
                stackName,
                svc.name,
                logOptions,
                (line) => printRaw(line),
                (err) => { throw err; },
              );
            }
          }
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to fetch logs: ${error}`);
      }
    })));
}
