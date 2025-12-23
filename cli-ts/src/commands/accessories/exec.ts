/**
 * Accessories Exec Command
 * Execute commands in accessory containers
 */

import type { Command } from 'commander';
import { sshExec, executeInteractiveSSH } from '../../utils/ssh';
import { printInfo } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';

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
    .action(withErrorHandler(async (
      env: string, 
      service: string, 
      command: string[],
      options: { user?: string; workdir?: string; server?: string }
    ) => {
      // Validate environment and stack
      const { connection } = validateEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      // Get the full service name
      const fullServiceName = `${stackName}_${service}`;

      // Check if service exists and get a running container
      const containerResult = await sshExec(connection, 
        `docker ps --filter "label=com.docker.swarm.service.name=${fullServiceName}" --format "{{.ID}}" | head -n1`
      );
      
      const containerId = containerResult.stdout.trim();
      
      if (!containerId) {
        // Check if service exists but has no running containers
        const serviceCheck = await sshExec(connection, 
          `docker service ls --filter "name=${fullServiceName}" --format "{{.Replicas}}"`
        );
        
        let suggestion: string | undefined;
        if (serviceCheck.stdout.trim()) {
          suggestion = `Service exists but has no running replicas: ${serviceCheck.stdout.trim()}\nCheck service status with: dockflow accessories list ${env}`;
        } else {
          // List available services
          const servicesResult = await sshExec(connection, 
            `docker stack services ${stackName} --format "{{.Name}}" | sed 's/${stackName}_//'`
          );
          if (servicesResult.stdout.trim()) {
            suggestion = `Available accessories: ${servicesResult.stdout.trim().split('\n').join(', ')}`;
          }
        }
        throw new DockerError(
          `No running container found for accessory '${service}'`,
          { code: ErrorCode.CONTAINER_NOT_FOUND, suggestion }
        );
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
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to exec: ${error}`);
      }
    }));
}
