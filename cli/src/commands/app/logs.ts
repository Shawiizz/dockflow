/**
 * Logs command - View service logs
 *
 * Uses the LogsBackend abstraction to support both Swarm and k3s.
 */

import type { Command } from 'commander';
import { printInfo, printSection, printDebug, printBlank, printRaw } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createLogsBackend, createOrchestrator } from '../../services/orchestrator/factory';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .helpGroup('Inspect')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .option('-T, --timestamps', 'Show timestamps')
    .option('--since <time>', 'Show logs since timestamp (e.g., "1h", "2024-01-01")')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string | undefined, options: {
      follow?: boolean;
      tail?: string;
      timestamps?: boolean;
      since?: string;
      server?: string
    }) => {
      const { config, stackName, connection, serverName } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, serverName });
      printInfo(`Server: ${serverName}`);
      printInfo(`Fetching logs for stack: ${stackName}`);
      printBlank();

      const orchType = config.orchestrator ?? 'swarm';
      const logsBackend = createLogsBackend(orchType, connection);
      const logOptions = {
        tail: parseInt(options.tail || '100', 10),
        follow: options.follow ?? false,
        timestamps: options.timestamps,
        since: options.since,
      };

      try {
        if (service) {
          // Logs for specific service
          await logsBackend.streamLogs(
            stackName,
            service,
            logOptions,
            (line) => printRaw(line),
            (err) => { throw err; },
          );
        } else {
          // Logs for all services — get service list from orchestrator
          const orchestrator = createOrchestrator(orchType, connection);
          const services = await orchestrator.getServices(stackName);

          if (services.length === 0) {
            throw new DockerError(`No services found for stack ${stackName}`);
          }

          if (options.follow) {
            // Follow mode - only first service
            const svc = services[0];
            printInfo(`Following logs for ${svc.name} (use service name to follow specific service)`);
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
    }));
}
