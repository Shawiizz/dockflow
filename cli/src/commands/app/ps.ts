/**
 * PS command - List the running containers of the stack on every node.
 */

import type { Command } from 'commander';
import { printInfo, printSection, printDebug, colors, printBlank, printDim, printRaw } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStackBackend } from '../../services/orchestrator/swarm/swarm-stack';
import { DockerError, withServicesRequired } from '../../utils/errors';
import { nodesOf, onEveryNode } from './nodes';

export function registerPsCommand(program: Command): void {
  program
    .command('ps <env>')
    .description('List running containers')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('--tasks', 'Show tasks instead of containers')
    .action(withServicesRequired(withResolvedEnv(async (env: string, options: { server?: string; tasks?: boolean }) => {
      const { stackName, connection, serverName } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName, tasks: options.tasks });


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
          const nodes = nodesOf(env, { name: serverName, connection });
          const [perNode, services] = await Promise.all([
            onEveryNode(nodes, (node) => new SwarmStackBackend(node.connection).getContainers(stackName)),
            orchestrator.getServices(stackName),
          ]);
          const containers = perNode.flatMap(({ node, value }) => value.map((container) => ({ ...container, node: node.name })));

          if (containers.length === 0) {
            printInfo('No running containers');
            return;
          }

          const servicePorts = new Map<string, string>();
          for (const svc of services) {
            if (svc.ports) servicePorts.set(svc.name, svc.ports);
          }

          const nodeWidth = Math.max(4, ...containers.map((c) => c.node.length)) + 2;
          printSection('Containers');
          printBlank();
          printDim(`  ${'ID'.padEnd(14)}${'NAME'.padEnd(36)}${'NODE'.padEnd(nodeWidth)}${'STATUS'.padEnd(31)}PORTS`);
          printDim('  ' + '─'.repeat(81 + nodeWidth));

          for (const container of containers) {
            const statusColor = container.status.includes('Up') ? colors.success : colors.warning;
            const shortName = container.name.replace(`${stackName}_`, '').replace(/\.\d+\..*$/, '');
            const ports = container.ports || servicePorts.get(shortName) || '';
            printRaw(
              `  ${container.id.substring(0, 12).padEnd(14)}` +
              `${container.name.substring(0, 35).padEnd(36)}` +
              `${container.node.padEnd(nodeWidth)}` +
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
    })));
}
