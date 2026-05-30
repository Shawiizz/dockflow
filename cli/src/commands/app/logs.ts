/**
 * Logs command - View service logs
 *
 * Uses the ContainerBackend abstraction to support both Swarm and k3s.
 */

import type { Command } from 'commander';
import type { SSHKeyConnection } from '../../types';
import { printInfo, printSection, printDebug, printBlank, printRaw } from '../../utils/output';
import { selectPrompt } from '../../utils/prompts';
import { validateEnv } from '../../utils/validation';
import { createContainerBackend, createStackBackend } from '../../services/orchestrator/factory';
import { listSwarmTasks } from '../../services/orchestrator/swarm/swarm-utils';
import { DockerError, withServicesRequired } from '../../utils/errors';

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
    .option('-a, --all-tasks', 'Include logs from terminated/historical task replicas (Swarm only)')
    .option('--pick', 'Interactively pick which task replica to follow')
    .action(withServicesRequired(async (env: string, service: string | undefined, options: {
      follow?: boolean;
      tail?: string;
      timestamps?: boolean;
      since?: string;
      server?: string;
      allTasks?: boolean;
      pick?: boolean;
    }) => {
      const { config, stackName, connection, serverName } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, serverName });
      printInfo(`Server: ${serverName}`);
      printInfo(`Fetching logs for stack: ${stackName}`);
      printBlank();

      const orchType = config.orchestrator ?? 'swarm';
      const logsBackend = createContainerBackend(orchType, connection);

      let taskId: string | undefined;
      if (options.pick) {
        if (orchType !== 'swarm') throw new DockerError('--pick is only supported on Swarm');
        if (!service) {
          service = await pickService(orchType, connection, stackName);
        }
        taskId = await pickSwarmTask(stackName, service, connection);
      }

      const logOptions = {
        tail: parseInt(options.tail || '100', 10),
        follow: options.follow ?? false,
        timestamps: options.timestamps,
        since: options.since,
        allTasks: options.allTasks,
        taskId,
      };

      try {
        if (service) {
          await logsBackend.streamLogs(
            stackName,
            service,
            logOptions,
            (line) => printRaw(line),
            (err) => { throw err; },
          );
        } else {
          const orchestrator = createStackBackend(orchType, connection);
          const services = await orchestrator.getServices(stackName);

          if (services.length === 0) {
            throw new DockerError(`No services found for stack ${stackName}`);
          }

          if (options.follow) {
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

async function pickService(orchType: 'swarm' | 'k3s', connection: SSHKeyConnection, stackName: string): Promise<string> {
  const services = await createStackBackend(orchType, connection).getServices(stackName);
  if (services.length === 0) throw new DockerError(`No services found for stack ${stackName}`);
  if (services.length === 1) return services[0].name;

  return selectPrompt({
    message: 'Pick a service:',
    options: services.map(s => ({ value: s.name, label: s.name })),
  });
}

async function pickSwarmTask(stackName: string, service: string, connection: SSHKeyConnection): Promise<string> {
  const tasks = await listSwarmTasks(stackName, service, connection);
  if (tasks.length === 0) throw new DockerError(`No tasks found for service ${service}`);

  const options = tasks.map(t => ({
    value: t.id,
    label: `replica ${t.slot} on ${t.node}`,
    hint: t.error ? `${t.currentState} — ${t.error}` : t.currentState,
  }));

  return selectPrompt({ message: 'Pick a task to follow:', options });
}
