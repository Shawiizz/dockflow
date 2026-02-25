/**
 * Exec command - Execute commands in containers
 *
 * Also serves as: bash, shell (aliases)
 * Uses ExecService to handle command execution.
 */

import type { Command } from 'commander';
import { printInfo, printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createExecService, createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .aliases(['bash', 'shell'])
    .description('Execute a command in a container (default: interactive shell)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('-u, --user <user>', 'Run as specified user')
    .option('-w, --workdir <dir>', 'Working directory inside container')
    .option('--sh', 'Use sh instead of bash for interactive shell')
    .action(withErrorHandler(async (env: string, service: string, command: string[], options: {
      server?: string;
      user?: string;
      workdir?: string;
      sh?: boolean;
    }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const execService = createExecService(connection, stackName);
      const cmd = command.length > 0 ? command.join(' ') : undefined;

      try {
        // Interactive shell (no command, or explicit bash/sh)
        if (!cmd || cmd === 'bash' || cmd === 'sh') {
          const shellPath = (options.sh || cmd === 'sh') ? '/bin/sh' : '/bin/bash';
          printInfo(`Connecting to ${stackName}_${service}...`);
          console.log('');

          const result = await execService.shell(service, shellPath);

          if (!result.success) {
            const stackService = createStackService(connection, stackName);
            const services = await stackService.getServiceNames();
            const suggestion = services.length > 0
              ? `Available services: ${services.join(', ')}`
              : undefined;
            throw new DockerError(result.error.message, { suggestion });
          }
        } else {
          // Execute non-interactive command
          printInfo(`Executing in ${stackName}_${service}...`);

          const result = await execService.exec(service, cmd, {
            user: options.user,
            workdir: options.workdir,
          });

          if (!result.success) {
            throw new DockerError(result.error.message);
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
