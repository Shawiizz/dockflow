/**
 * Exec command - Execute commands in containers
 * 
 * Uses ExecService to handle command execution.
 */

import type { Command } from 'commander';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createExecService } from '../../services';

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in a container (default: bash)')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('-u, --user <user>', 'Run as specified user')
    .option('-w, --workdir <dir>', 'Working directory inside container')
    .action(async (env: string, service: string, command: string[], options: { 
      server?: string;
      user?: string;
      workdir?: string;
    }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const execService = createExecService(connection, stackName);
      const cmd = command.length > 0 ? command.join(' ') : 'bash';
      
      printInfo(`Executing in ${stackName}_${service}...`);

      try {
        // For interactive commands, open a shell
        if (cmd === 'bash' || cmd === 'sh') {
          const result = await execService.shell(service, cmd === 'bash' ? '/bin/bash' : '/bin/sh');
          if (!result.success) {
            printError(result.error.message);
            process.exit(1);
          }
        } else {
          // Execute non-interactive command
          const result = await execService.exec(service, cmd, {
            user: options.user,
            workdir: options.workdir,
          });

          if (!result.success) {
            printError(result.error.message);
            process.exit(1);
          }

          process.stdout.write(result.data.stdout);
          if (result.data.stderr) process.stderr.write(result.data.stderr);
          process.exit(result.data.exitCode);
        }
      } catch (error) {
        printError(`Failed to exec: ${error}`);
        process.exit(1);
      }
    });
}
