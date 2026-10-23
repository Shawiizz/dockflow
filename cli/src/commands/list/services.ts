import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printSection, printNote, printJSON, printBlank, printDim, printRaw, colors } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStack } from '../../services/swarm/stack';
import { qualifyServiceName } from '../../services/swarm/docker';
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
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-t, --tasks', 'Show individual containers/tasks for each service')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { server?: string; tasks?: boolean; json?: boolean }) => {
      const { stackName, connection } = await resolveEnv(env, options.server);

      try {
        const swarm = new SwarmStack(connection);
        const services = await swarm.getServices(stackName);

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

        printRaw(
          colors.dim('SERVICE'.padEnd(25)) +
          colors.dim('REPLICAS'.padEnd(12)) +
          colors.dim('IMAGE'.padEnd(40)) +
          colors.dim('PORTS')
        );
        printDim('─'.repeat(90));

        for (const svc of services) {
          const [current, desired] = svc.replicas.split('/').map(n => parseInt(n, 10));
          const replicasColor = current === desired && current > 0
            ? colors.success
            : current === 0
              ? colors.error
              : colors.warning;

          const shortName = svc.name.startsWith(`${stackName}_`)
            ? svc.name.replace(`${stackName}_`, '')
            : svc.name;

          const shortImage = svc.image.length > 38
            ? '...' + svc.image.slice(-35)
            : svc.image;

          printRaw(
            colors.info(shortName.padEnd(25)) +
            replicasColor(svc.replicas.padEnd(12)) +
            shortImage.padEnd(40) +
            colors.dim(svc.ports || '-')
          );

          if (options.tasks) {
            const fullName = qualifyServiceName(stackName, svc.name);
            const tasksCmd = `docker service ps ${fullName} --format '{{.ID}}|{{.Name}}|{{.Node}}|{{.CurrentState}}|{{.Error}}' --no-trunc 2>/dev/null | head -10`;
            const tasksResult = await sshExec(connection, tasksCmd);
            const taskLines = tasksResult.stdout.trim().split('\n').filter(Boolean);

            for (const taskLine of taskLines) {
              const [id, name, node, state, error] = taskLine.split('|');
              const shortId = (id || '').substring(0, 12);
              const taskName = (name || '').replace(`${stackName}_`, '');

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
