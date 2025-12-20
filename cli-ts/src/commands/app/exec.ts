/**
 * Exec command - Execute commands in containers
 */

import type { Command } from 'commander';
import { sshExec, sshExecStream } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in a container (default: bash)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, service: string, command: string[], options: { server?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const cmd = command.length > 0 ? command.join(' ') : 'bash';
      printInfo(`Connecting to ${stackName}_${service}...`);

      try {
        // Find container
        const findCmd = `docker ps --filter "label=com.docker.swarm.service.name=${stackName}_${service}" --format '{{.ID}}' | head -n1`;
        const containerResult = await sshExec(connection, findCmd);
        const containerId = containerResult.stdout.trim();

        if (!containerId) {
          printError(`No running container found for service ${service}`);
          process.exit(1);
        }

        // For interactive commands, we need a different approach
        if (cmd === 'bash' || cmd === 'sh') {
          // Open interactive shell via SSH
          const shellCmd = `docker exec -it ${containerId} ${cmd}`;
          await sshExecStream(connection, shellCmd);
        } else {
          const execCmd = `docker exec ${containerId} ${cmd}`;
          const result = sshExec(connection, execCmd);
          process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          process.exit(result.exitCode);
        }
      } catch (error) {
        printError(`Failed to exec: ${error}`);
        process.exit(1);
      }
    });
}
