/**
 * Containers command - Show app containers on server
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printError, printSection } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerContainersCommand(program: Command): void {
  program
    .command('containers <env>')
    .description('Show app containers on server')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-a, --all', 'Show all containers including stopped')
    .action(async (env: string, options: { server?: string; all?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);

      try {
        console.log('');
        printSection(`Containers for ${stackName}`);

        const allFlag = options.all ? '-a' : '';
        
        // Get containers for this stack
        const result = await sshExec(
          connection,
          `docker ps ${allFlag} --filter "label=com.docker.stack.namespace=${stackName}" --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"`
        );
        
        if (!result.stdout.trim() || result.stdout.includes('CONTAINER ID') && result.stdout.trim().split('\n').length === 1) {
          console.log(chalk.yellow('No containers found for this stack'));
          console.log('');
          console.log(chalk.gray('The stack may not be deployed or all containers are stopped.'));
          console.log(chalk.gray('Use --all to include stopped containers.'));
        } else {
          console.log(result.stdout);
          
          // Count summary
          const lines = result.stdout.trim().split('\n');
          const containerCount = lines.length - 1; // Subtract header
          console.log('');
          console.log(chalk.gray(`Total: ${containerCount} container(s)`));
        }

        // Show health status summary
        console.log('');
        printSection('Health Status');
        const healthResult = await sshExec(
          connection,
          `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format "{{.Names}}: {{.Status}}" | grep -E "healthy|unhealthy|starting" || echo "No health info available"`
        );
        console.log(healthResult.stdout);

      } catch (error) {
        printError(`Failed to list containers: ${error}`);
        process.exit(1);
      }
    });
}
