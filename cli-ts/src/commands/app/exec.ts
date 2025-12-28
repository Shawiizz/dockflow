/**
 * Exec command - Execute commands in containers
 * 
 * Uses ExecService to handle command execution.
 */

import type { Command } from 'commander';
import { printInfo, printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createExecService } from '../../services';
import { DockerError, withErrorHandler, exitSuccess } from '../../utils/errors';

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in a container (default: bash)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('-u, --user <user>', 'Run as specified user')
    .option('-w, --workdir <dir>', 'Working directory inside container')
    .action(withErrorHandler(async (env: string, service: string, command: string[], options: { 
      server?: string;
      user?: string;
      workdir?: string;
    }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });
      
      const execService = createExecService(connection, stackName);
      const cmd = command.length > 0 ? command.join(' ') : 'bash';
      
      printInfo(`Executing in ${stackName}_${service}...`);

      try {
        // For interactive commands, open a shell
        if (cmd === 'bash' || cmd === 'sh') {
          const result = await execService.shell(service, cmd === 'bash' ? '/bin/bash' : '/bin/sh');
          if (!result.success) {
            throw new DockerError(result.error.message);
          }
        } else {
          // Execute non-interactive command
          const result = await execService.exec(service, cmd, {
            user: options.user,
            workdir: options.workdir,
          });

          if (!result.success) {
            throw new DockerError(result.error.message);
          }

          process.stdout.write(result.data.stdout);
          if (result.data.stderr) process.stderr.write(result.data.stderr);
          // Exit with the command's exit code
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
