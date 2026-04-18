/**
 * List services command - Show services in a deployed stack
 */

import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printSection, printNote, printJSON, printBlank, printDim, printRaw, colors } from '../../utils/output';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { createStackBackend } from '../../services/orchestrator/factory';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';

interface TaskInfo {
  id: string;
  name: string;
  node: string;
  state: string;
  error: string;
}

export function registerListServicesCommand(parent: Command): void {
  parent
    .command('services <env>')
    .alias('svc')
    .description('List services in a deployed stack')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-t, --tasks', 'Show individual containers/tasks for each service')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { server?: string; tasks?: boolean; json?: boolean }) => {
      const { config, stackName, connection } = validateEnv(env, options.server);

      try {
        const orchType = config.orchestrator ?? 'swarm';
        const orchestrator = createStackBackend(orchType, connection);
        const services = await orchestrator.getServices(stackName);

        if (services.length === 0) {
          throw new DockerError(
            `No services found for stack "${stackName}"`,
            { code: ErrorCode.STACK_NOT_FOUND, suggestion: `Make sure the stack is deployed with: dockflow deploy ${env}` }
          );
        }

        if (options.json) {
          printJSON({ stack: stackName, services });
          return;
        }

        printBlank();
        printSection(`Services: ${stackName}`);
        printBlank();

        // Header
        printRaw(
          colors.dim('SERVICE'.padEnd(25)) +
          colors.dim('REPLICAS'.padEnd(12)) +
          colors.dim('IMAGE'.padEnd(40)) +
          colors.dim('PORTS')
        );
        printDim('─'.repeat(90));

        for (const svc of services) {
          // Parse replicas for coloring
          const [current, desired] = svc.replicas.split('/').map(n => parseInt(n, 10));
          const replicasColor = current === desired && current > 0
            ? colors.success
            : current === 0
              ? colors.error
              : colors.warning;

          // Short name: strip stack prefix if present
          const shortName = svc.name.startsWith(`${stackName}_`)
            ? svc.name.replace(`${stackName}_`, '')
            : svc.name;

          // Shorten image name
          const shortImage = svc.image.length > 38
            ? '...' + svc.image.slice(-35)
            : svc.image;

          printRaw(
            colors.info(shortName.padEnd(25)) +
            replicasColor(svc.replicas.padEnd(12)) +
            shortImage.padEnd(40) +
            colors.dim(svc.ports || '-')
          );

          // Show tasks/containers if requested (Swarm-specific detail)
          if (options.tasks && orchType === 'swarm') {
            const fullName = svc.name.includes('_') ? svc.name : `${stackName}_${svc.name}`;
            const tasksCmd = `docker service ps ${fullName} --format '{{.ID}}|{{.Name}}|{{.Node}}|{{.CurrentState}}|{{.Error}}' --no-trunc 2>/dev/null | head -10`;
            const tasksResult = await sshExec(connection, tasksCmd);
            const taskLines = tasksResult.stdout.trim().split('\n').filter(Boolean);

            for (const taskLine of taskLines) {
              const [id, name, node, state, error] = taskLine.split('|');
              const shortId = (id || '').substring(0, 12);
              const taskName = (name || '').replace(`${stackName}_`, '');

              // Color based on state
              let stateColor = colors.dim;
              if (state?.toLowerCase().includes('running')) stateColor = colors.success;
              else if (state?.toLowerCase().includes('failed') || error) stateColor = colors.error;
              else if (state?.toLowerCase().includes('starting') || state?.toLowerCase().includes('preparing')) stateColor = colors.warning;

              const stateStr = state || 'unknown';
              const errorStr = error ? colors.error(` (${error.substring(0, 30)})`) : '';

              printRaw(
                colors.dim('  └─ ') +
                colors.dim(shortId.padEnd(14)) +
                taskName.padEnd(20) +
                colors.info((node || '').padEnd(15)) +
                stateColor(stateStr) +
                errorStr
              );
            }
          } else if (options.tasks && orchType === 'k3s') {
            const tasksCmd = `kubectl get pods -n dockflow-${stackName} -l app=${svc.name} -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase' --no-headers 2>/dev/null | head -10`;
            const tasksResult = await sshExec(connection, tasksCmd);
            const taskLines = tasksResult.stdout.trim().split('\n').filter(Boolean);

            for (const taskLine of taskLines) {
              const parts = taskLine.trim().split(/\s+/);
              const podName = parts[0] || '';
              const nodeName = parts[1] || '';
              const status = parts[2] || 'Unknown';

              let stateColor = colors.dim;
              if (status === 'Running') stateColor = colors.success;
              else if (status === 'Failed' || status === 'CrashLoopBackOff') stateColor = colors.error;
              else if (status === 'Pending' || status === 'ContainerCreating') stateColor = colors.warning;

              printRaw(
                colors.dim('  └─ ') +
                podName.padEnd(34) +
                colors.info(nodeName.padEnd(15)) +
                stateColor(status)
              );
            }
          }
        }

        printBlank();
        printDim(`${services.length} service(s)`);
        if (!options.tasks) {
          printDim('Use -t/--tasks to show individual tasks');
        }
        printBlank();
        if (services.length > 0) {
          const firstShort = services[0].name.startsWith(`${stackName}_`)
            ? services[0].name.replace(`${stackName}_`, '')
            : services[0].name;
          printNote(`dockflow bash ${env} ${firstShort}`, 'Connect to a service');
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to list services: ${error}`);
      }
    })));
}
