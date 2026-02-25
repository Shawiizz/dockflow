/**
 * List services command - Show services in a deployed stack
 */

import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printSection, printJSON, printBlank, printDim, colors } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';

interface ServiceInfo {
  name: string;
  shortName: string;
  mode: string;
  replicas: string;
  image: string;
  ports: string;
}

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
    .option('--json', 'Output as JSON')
    .action(withErrorHandler(async (env: string, options: { server?: string; tasks?: boolean; json?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);

      try {
        // Get services for the stack
        const listCmd = `docker service ls --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.Name}}|{{.Mode}}|{{.Replicas}}|{{.Image}}|{{.Ports}}'`;
        const result = await sshExec(connection, listCmd);
        
        const lines = result.stdout.trim().split('\n').filter(Boolean);
        
        if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
          throw new DockerError(
            `No services found for stack "${stackName}"`,
            { code: ErrorCode.STACK_NOT_FOUND, suggestion: `Make sure the stack is deployed with: dockflow deploy ${env}` }
          );
        }

        const services: ServiceInfo[] = lines.map(line => {
          const [name, mode, replicas, image, ports] = line.split('|');
          return {
            name: name || '',
            shortName: name?.replace(`${stackName}_`, '') || '',
            mode: mode || 'replicated',
            replicas: replicas || '0/0',
            image: image || '',
            ports: ports || ''
          };
        });

        if (options.json) {
          printJSON({ stack: stackName, services });
          return;
        }

        printBlank();
        printSection(`Services: ${stackName}`);
        printBlank();

        // Header
        console.log(
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

          // Shorten image name
          const shortImage = svc.image.length > 38 
            ? '...' + svc.image.slice(-35) 
            : svc.image;

          console.log(
            colors.info(svc.shortName.padEnd(25)) +
            replicasColor(svc.replicas.padEnd(12)) +
            shortImage.padEnd(40) +
            colors.dim(svc.ports || '-')
          );

          // Show tasks/containers if requested
          if (options.tasks) {
            const tasksCmd = `docker service ps ${svc.name} --format '{{.ID}}|{{.Name}}|{{.Node}}|{{.CurrentState}}|{{.Error}}' --no-trunc 2>/dev/null | head -10`;
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
              
              console.log(
                colors.dim('  └─ ') +
                colors.dim(shortId.padEnd(14)) +
                taskName.padEnd(20) +
                colors.info((node || '').padEnd(15)) +
                stateColor(stateStr) +
                errorStr
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
        printDim('Connect to a service:');
        if (services.length > 0) {
          printDim(`  dockflow bash ${env} ${services[0].shortName}`);
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to list services: ${error}`);
      }
    }));
}
