/**
 * Logs command - View service logs
 */

import type { Command } from 'commander';
import { sshExec, sshExecStream } from '../../utils/ssh';
import { printError, printInfo, printSection } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .action(async (env: string, service: string | undefined, options: { follow?: boolean; tail?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      printInfo(`Fetching logs for stack: ${stackName}`);
      console.log('');

      try {
        const tailFlag = `--tail ${options.tail || 100}`;
        const followFlag = options.follow ? '-f' : '';

        if (service) {
          // Logs for specific service
          const cmd = `docker service logs ${followFlag} ${tailFlag} ${stackName}_${service} 2>&1`;
          await sshExecStream(connection, cmd);
        } else {
          // Get all services
          const servicesResult = await sshExec(connection, `docker stack services ${stackName} --format '{{.Name}}'`);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          if (services.length === 0) {
            printError(`No services found for stack ${stackName}`);
            process.exit(1);
          }

          if (options.follow) {
            // Follow mode - only first service
            printInfo(`Following logs for ${services[0]} (use service name to follow specific service)`);
            const cmd = `docker service logs -f ${tailFlag} ${services[0]} 2>&1`;
            await sshExecStream(connection, cmd);
          } else {
            // Show recent logs from all services
            for (const svc of services) {
              printSection(svc);
              const cmd = `docker service logs ${tailFlag} ${svc} 2>&1`;
              await sshExecStream(connection, cmd);
            }
          }
        }
      } catch (error) {
        printError(`Failed to fetch logs: ${error}`);
        process.exit(1);
      }
    });
}
