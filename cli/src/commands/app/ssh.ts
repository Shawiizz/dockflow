/**
 * SSH command - Open SSH session to server or execute a command
 */

import type { Command } from 'commander';
import { sshShell, sshExecStream } from '../../utils/ssh';
import { printInfo, printBlank } from '../../utils/output';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { CLIError, ConnectionError, withErrorHandler } from '../../utils/errors';

export function registerSshCommand(program: Command): void {
  program
    .command('ssh <env> [command...]')
    .description('Open SSH session to server or execute a command')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (env: string, commandParts: string[], options: { server?: string }) => {
      const { connection, serverName } = validateEnv(env, options.server);
      
      // If command is provided, execute it and return
      if (commandParts && commandParts.length > 0) {
        const command = commandParts.join(' ');
        printInfo(`Executing on ${env} server (${serverName}): ${command}`);
        printBlank();

        try {
          const result = await sshExecStream(connection, command);
          if (result.exitCode !== 0) {
            throw new CLIError(
              `Command exited with code ${result.exitCode}`,
              result.exitCode,
            );
          }
        } catch (error) {
          throw new ConnectionError(`SSH command failed: ${error}`);
        }
        return;
      }

      // Otherwise, open interactive shell
      printInfo(`Connecting to ${env} server (${serverName})...`);
      printBlank();

      try {
        await sshShell(connection);
      } catch (error) {
        throw new ConnectionError(`SSH connection failed: ${error}`);
      }
    })));
}
