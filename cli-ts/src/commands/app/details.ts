/**
 * Details command - Show stack details and resource usage
 */

import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printError, printSection, printHeader } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerDetailsCommand(program: Command): void {
  program
    .command('details <env>')
    .description('Show stack details and resource usage')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, options: { server?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      printHeader(`Stack: ${stackName}`);

      try {
        printSection('Services');
        const servicesResult = await sshExec(connection, `docker stack services ${stackName}`);
        console.log(servicesResult.stdout);

        printSection('Tasks');
        const tasksResult = await sshExec(connection, `docker stack ps ${stackName} --no-trunc`);
        console.log(tasksResult.stdout);

        printSection('Resource Usage');
        const containerIds = await sshExec(
          connection,
          `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.ID}}' | tr '\\n' ' '`
        );
        
        if (containerIds.stdout.trim()) {
          const statsResult = await sshExec(connection, `docker stats --no-stream ${containerIds.stdout.trim()}`);
          console.log(statsResult.stdout);
        } else {
          console.log('No running containers');
        }
      } catch (error) {
        printError(`Failed to get details: ${error}`);
        process.exit(1);
      }
    });
}
