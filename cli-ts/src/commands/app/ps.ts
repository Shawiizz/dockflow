/**
 * PS command - List running containers
 */

import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerPsCommand(program: Command): void {
  program
    .command('ps <env>')
    .description('List running containers')
    .action(async (env: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      printInfo(`Containers for stack: ${stackName}`);
      console.log('');

      try {
        const result = await sshExec(
          connection,
          `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format 'table {{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Ports}}'`
        );
        console.log(result.stdout);
      } catch (error) {
        printError(`Failed to list containers: ${error}`);
        process.exit(1);
      }
    });
}
