/**
 * PS command - List running containers
 * 
 * Uses StackService to retrieve container information.
 */

import type { Command } from 'commander';
import { printInfo, printSection, printDebug, colors, printBlank, printDim, printRaw } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerPsCommand(program: Command): void {
  program
    .command('ps <env>')
    .description('List running containers')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('--tasks', 'Show tasks instead of containers')
    .action(withErrorHandler(async (env: string, options: { server?: string; tasks?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, tasks: options.tasks });
      
      const stackService = createStackService(connection, stackName);
      
      printInfo(`Stack: ${stackName}`);
      printBlank();

      try {
        if (options.tasks) {
          // Show tasks
          const tasksResult = await stackService.getTasks();
          
          if (!tasksResult.success) {
            throw new DockerError(tasksResult.error.message);
          }

          printSection('Tasks');
          printBlank();
          
          for (const task of tasksResult.data) {
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
          // Show containers + service-level ports
          const [containersResult, servicesResult] = await Promise.all([
            stackService.getContainers(),
            stackService.getServices(),
          ]);

          if (!containersResult.success) {
            throw new DockerError(containersResult.error.message);
          }

          if (containersResult.data.length === 0) {
            printInfo('No running containers');
            return;
          }

          // Build a map of service short name → published ports (from Swarm services)
          const servicePorts = new Map<string, string>();
          if (servicesResult.success) {
            for (const svc of servicesResult.data) {
              if (svc.ports) servicePorts.set(svc.name, svc.ports);
            }
          }

          printSection('Containers');
          printBlank();
          printDim('  ID            NAME                                STATUS                         PORTS');
          printDim('  ' + '─'.repeat(95));

          for (const container of containersResult.data) {
            const statusColor = container.status.includes('Up') ? colors.success : colors.warning;
            // Match container name to service ports (container name: stack_service.slot.id)
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
        throw new DockerError(`Failed to list containers: ${error}`);
      }
    }));
}
