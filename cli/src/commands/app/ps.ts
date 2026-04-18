/**
 * PS command - List running containers (Swarm-only).
 *
 * k3s users should use `kubectl get pods` — this command surfaces
 * Swarm-native concepts (containers on nodes, task scheduling).
 */

import type { Command } from 'commander';
import { printInfo, printSection, printDebug, colors, printBlank, printDim, printRaw } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { SwarmStackBackend } from '../../services/orchestrator/swarm/swarm-stack';
import { loadConfig } from '../../utils/config';
import { DockerError, withErrorHandler, ConfigError } from '../../utils/errors';

export function registerPsCommand(program: Command): void {
  program
    .command('ps <env>')
    .description('List running containers (Swarm only)')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('--tasks', 'Show tasks instead of containers')
    .action(withErrorHandler(async (env: string, options: { server?: string; tasks?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, tasks: options.tasks });

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      if ((config.orchestrator ?? 'swarm') !== 'swarm') {
        throw new DockerError(
          '`dockflow ps` is Swarm-only. For k3s, use `kubectl get pods` or `dockflow status`.',
        );
      }

      const orchestrator = new SwarmStackBackend(connection);

      printInfo(`Stack: ${stackName}`);
      printBlank();

      try {
        if (options.tasks) {
          const tasks = await orchestrator.getTasks(stackName);

          printSection('Tasks');
          printBlank();

          for (const task of tasks) {
            const stateColor = task.currentState.includes('Running')
              ? colors.success
              : task.currentState.includes('Failed')
                ? colors.error
                : colors.warning;

            printRaw(`  ${colors.info(task.name)}`);
            printRaw(`    ID: ${task.id.substring(0, 12)}`);
            printRaw(`    Node: ${task.node}`);
            printRaw(`    State: ${stateColor(task.currentState)}`);
            if (task.error) {
              printRaw(`    Error: ${colors.error(task.error)}`);
            }
            printBlank();
          }
        } else {
          const [containers, services] = await Promise.all([
            orchestrator.getContainers(stackName),
            orchestrator.getServices(stackName),
          ]);

          if (containers.length === 0) {
            printInfo('No running containers');
            return;
          }

          const servicePorts = new Map<string, string>();
          for (const svc of services) {
            if (svc.ports) servicePorts.set(svc.name, svc.ports);
          }

          printSection('Containers');
          printBlank();
          printDim('  ID            NAME                                STATUS                         PORTS');
          printDim('  ' + '─'.repeat(95));

          for (const container of containers) {
            const statusColor = container.status.includes('Up') ? colors.success : colors.warning;
            const shortName = container.name.replace(`${stackName}_`, '').replace(/\.\d+\..*$/, '');
            const ports = container.ports || servicePorts.get(shortName) || '';
            printRaw(
              `  ${container.id.substring(0, 12).padEnd(14)}` +
              `${container.name.substring(0, 35).padEnd(36)}` +
              `${statusColor(container.status.padEnd(31))}` +
              `${ports}`
            );
          }
          printBlank();
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        throw new DockerError(`Failed to list containers: ${msg}`);
      }
    }));
}
