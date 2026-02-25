/**
 * Accessories Exec Command
 * Execute commands in accessory containers
 *
 * Uses ExecService (shared with app commands)
 */

import type { Command } from 'commander';
import { printInfo } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createExecService, createStackService } from '../../services';
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
      const { connection } = validateEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      const execService = createExecService(connection, stackName);
      const stackService = createStackService(connection, stackName);
      const cmd = command.length > 0 ? command.join(' ') : 'sh';

      printInfo(`Connecting to ${service}...`);

      try {
        if (cmd === 'bash' || cmd === 'sh' || cmd.includes('/bin/sh') || cmd.includes('/bin/bash')) {
          const result = await execService.shell(service, cmd.includes('bash') ? '/bin/bash' : '/bin/sh');
          if (!result.success) {
            const services = await stackService.getServiceNames();
            const suggestion = services.length > 0
              ? `Available accessories: ${services.join(', ')}`
              : undefined;
            throw new DockerError(result.error.message, { code: ErrorCode.CONTAINER_NOT_FOUND, suggestion });
          }
        } else {
          const result = await execService.exec(service, cmd, {
            user: options.user,
            workdir: options.workdir,
          });

          if (!result.success) {
            const services = await stackService.getServiceNames();
            const suggestion = services.length > 0
              ? `Available accessories: ${services.join(', ')}`
              : undefined;
            throw new DockerError(result.error.message, { code: ErrorCode.CONTAINER_NOT_FOUND, suggestion });
          }

          process.stdout.write(result.data.stdout);
          if (result.data.stderr) process.stderr.write(result.data.stderr);
          if (result.data.exitCode !== 0) {
            process.exit(result.data.exitCode);
          }
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to exec: ${error}`);
      }
    }));
}
