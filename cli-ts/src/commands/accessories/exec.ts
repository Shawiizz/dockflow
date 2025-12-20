/**
 * Accessories Exec Command
 * Execute commands in accessory containers
 */

import type { Command } from 'commander';
import { sshExec, executeInteractiveSSH } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';

/**
 * Register the accessories exec command
 */
export function registerAccessoriesExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in an accessory container (default: sh)')
    .option('-u, --user <user>', 'Run command as specific user')
    .option('--workdir <dir>', 'Working directory inside the container')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (
      env: string, 
      service: string, 
      command: string[],
      options: { user?: string; workdir?: string; server?: string }
    ) => {
      // Validate environment and stack
      const { connection } = await validateEnvOrExit(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      // Get the full service name
      const fullServiceName = `${stackName}_${service}`;

      // Check if service exists and get a running container
      const containerResult = await sshExec(connection, 
        `docker ps --filter "label=com.docker.swarm.service.name=${fullServiceName}" --format "{{.ID}}" | head -n1`
      );
      
      const containerId = containerResult.stdout.trim();
      
      if (!containerId) {
        printError(`No running container found for accessory '${service}'`);
        
        // Check if service exists but has no running containers
        const serviceCheck = await sshExec(connection, 
          `docker service ls --filter "name=${fullServiceName}" --format "{{.Replicas}}"`
        );
        
        if (serviceCheck.stdout.trim()) {
          printInfo(`Service exists but has no running replicas: ${serviceCheck.stdout.trim()}`);
          printInfo(`Check service status with: dockflow accessories list ${env}`);
        } else {
          // List available services
          const servicesResult = await sshExec(connection, 
            `docker stack services ${stackName} --format "{{.Name}}" | sed 's/${stackName}_//'`
          );
          if (servicesResult.stdout.trim()) {
            printInfo(`Available accessories: ${servicesResult.stdout.trim().split('\n').join(', ')}`);
          }
        }
        process.exit(1);
      }

      // Build exec command
      const cmd = command.length > 0 ? command.join(' ') : 'sh';
      const execOptions: string[] = [];
      
      if (options.user) execOptions.push(`-u ${options.user}`);
      if (options.workdir) execOptions.push(`-w ${options.workdir}`);

      const execFlags = execOptions.join(' ');

      printInfo(`Connecting to ${service} (${containerId.substring(0, 12)})...`);

      try {
        // For interactive commands, use interactive SSH
        if (cmd === 'bash' || cmd === 'sh' || cmd.includes('/bin/sh') || cmd.includes('/bin/bash')) {
          const shellCmd = `docker exec -it ${execFlags} ${containerId} ${cmd}`;
          await executeInteractiveSSH(connection, shellCmd);
        } else {
          // For non-interactive commands, stream output
          const execCmd = `docker exec ${execFlags} ${containerId} ${cmd}`;
          const result = await sshExec(connection, execCmd);
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
