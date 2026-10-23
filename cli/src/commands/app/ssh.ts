/**
 * SSH command - Open SSH session to server or execute a command
 */

import type { Command } from 'commander';
import { sshShell, sshExecStream } from '../../utils/ssh';
import { printInfo, printBlank } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { ConnectionError, ExecExitError, withServicesRequired } from '../../utils/errors';

export function registerSshCommand(program: Command): void {
  program
    .command('ssh <env> [command...]')
    .description('Open SSH session to server or execute a command')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server, workers included (defaults to the first manager)')
    .action(withServicesRequired(withResolvedEnv(async (env: string, commandParts: string[], options: { server?: string }) => {
      const { connection, serverName } = await resolveEnv(env, options.server, { anyServer: true });

      if (commandParts && commandParts.length > 0) {
        const command = commandParts.join(' ');
        printInfo(`Executing on ${env} server (${serverName}): ${command}`);
        printBlank();

        let exitCode: number;
        try {
          ({ exitCode } = await sshExecStream(connection, command));
        } catch (error) {
          throw new ConnectionError(`SSH command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (exitCode !== 0) throw new ExecExitError(exitCode);
        return;
      }

      printInfo(`Connecting to ${env} server (${serverName})...`);
      printBlank();

      try {
        await sshShell(connection);
      } catch (error) {
        throw new ConnectionError(`SSH connection failed: ${error}`);
      }
    })));
}
