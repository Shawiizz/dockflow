/**
 * Accessories Exec Command
 * Execute commands in accessory containers
 *
 * Uses ContainerBackend abstraction to support both Swarm and k3s.
 */

import type { Command } from 'commander';
import { printInfo } from '../../utils/output';
import { validateEnv, getAllNodeConnections, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createContainerBackend, createStackBackend } from '../../services/orchestrator/factory';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';

/**
 * Register the accessories exec command
 */
export function registerAccessoriesExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in an accessory container (default: sh)')
    .option('-u, --user <user>', 'Run command as specific user')
    .option('-w, --workdir <dir>', 'Working directory inside the container')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string,
      command: string[],
      options: { user?: string; workdir?: string; server?: string }
    ) => {
      const { config, connection } = validateEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      const orchType = config.orchestrator ?? 'swarm';
      const execBackend = createContainerBackend(orchType, connection, getAllNodeConnections(env));
      const cmd = command.length > 0 ? command.join(' ') : 'sh';

      printInfo(`Connecting to ${service}...`);

      try {
        if (cmd === 'bash' || cmd === 'sh' || cmd.includes('/bin/sh') || cmd.includes('/bin/bash')) {
          const result = await execBackend.shell(stackName, service, cmd.includes('bash') ? '/bin/bash' : '/bin/sh');
          if (!result.success) {
            const orchestrator = createStackBackend(orchType, connection);
            const services = await orchestrator.getServices(stackName);
            const suggestion = services.length > 0
              ? `Available accessories: ${services.map(s => s.name).join(', ')}`
              : undefined;
            throw new DockerError(result.error.message, { code: ErrorCode.CONTAINER_NOT_FOUND, suggestion });
          }
        } else {
          const result = await execBackend.exec(stackName, service, cmd, {
            user: options.user,
            workdir: options.workdir,
          });

          if (!result.success) {
            const orchestrator = createStackBackend(orchType, connection);
            const services = await orchestrator.getServices(stackName);
            const suggestion = services.length > 0
              ? `Available accessories: ${services.map(s => s.name).join(', ')}`
              : undefined;
            throw new DockerError(result.error.message, { code: ErrorCode.CONTAINER_NOT_FOUND, suggestion });
          }

          process.stdout.write(result.data.stdout);
          if (result.data.stderr) process.stderr.write(result.data.stderr);
          if (result.data.exitCode !== 0) {
            throw new DockerError(
              `Command exited with code ${result.data.exitCode}`,
              { code: result.data.exitCode },
            );
          }
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to exec: ${error}`);
      }
    })));
}
