/**
 * Bash command - Open interactive shell in a container
 */

import type { Command } from 'commander';
import { sshExec, executeInteractiveSSH } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerBashCommand(program: Command): void {
  program
    .command('bash <env> <service>')
    .alias('shell')
    .description('Open an interactive shell in a container')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--sh', 'Use sh instead of bash')
    .action(async (env: string, service: string, options: { server?: string; sh?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const shell = options.sh ? 'sh' : 'bash';

      try {
        // Find container for the service
        const findCmd = `docker ps --filter "label=com.docker.swarm.service.name=${stackName}_${service}" --format '{{.ID}}' | head -n1`;
        const containerResult = await sshExec(connection, findCmd);
        const containerId = containerResult.stdout.trim();

        if (!containerId) {
          printError(`No running container found for service "${service}"`);
          
          // Try to list available services
          const listCmd = `docker service ls --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.Name}}' | sed 's/${stackName}_//'`;
          const servicesResult = await sshExec(connection, listCmd);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);
          
          if (services.length > 0) {
            console.log('');
            console.log('Available services:');
            services.forEach(svc => console.log(`  - ${svc}`));
          }
          
          process.exit(1);
        }

        printInfo(`Connecting to ${stackName}_${service} (${shell})...`);
        console.log('');

        // Open interactive shell with TTY
        // Try the requested shell, fallback to sh if bash not available
        let shellCmd = `docker exec -it ${containerId} ${shell}`;
        
        if (shell === 'bash') {
          // Check if bash exists, otherwise use sh
          const checkBash = await sshExec(connection, `docker exec ${containerId} which bash 2>/dev/null || echo ""`);
          if (!checkBash.stdout.trim()) {
            printInfo(`bash not found, using sh...`);
            shellCmd = `docker exec -it ${containerId} sh`;
          }
        }
        
        await executeInteractiveSSH(connection, shellCmd);
        
      } catch (error) {
        printError(`Failed to connect: ${error}`);
        process.exit(1);
      }
    });
}
