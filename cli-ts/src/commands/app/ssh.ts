/**
 * SSH command - Open SSH session to server or execute a command
 */

import type { Command } from 'commander';
import { sshShell, sshExecStream } from '../../utils/ssh';
import { printInfo, printError, printBlank } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { ConnectionError, withErrorHandler } from '../../utils/errors';

export function registerSshCommand(program: Command): void {
  program
    .command('ssh <env> [command...]')
    .description('Open SSH session to server or execute a command')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, commandParts: string[], options: { server?: string }) => {
      const { connection, serverName } = validateEnv(env, options.server);
      
      // If command is provided, execute it and return
      if (commandParts && commandParts.length > 0) {
        const command = commandParts.join(' ');
        printInfo(`Executing on ${env} server (${serverName}): ${command}`);
        printBlank();

        try {
          const result = await sshExecStream(connection, command);
          if (result.exitCode !== 0) {
            printError(`Command exited with code ${result.exitCode}`);
            process.exit(result.exitCode);
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
    }));
}
