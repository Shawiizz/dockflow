/**
 * SSH command - Open SSH session to server
 */

import type { Command } from 'commander';
import { sshShell } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerSshCommand(program: Command): void {
  program
    .command('ssh <env>')
    .description('Open SSH session to server')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(async (env: string, options: { server?: string }) => {
      const { connection, serverName } = await validateEnvOrExit(env, options.server);
      
      printInfo(`Connecting to ${env} server (${serverName})...`);
      console.log('');

      try {
        await sshShell(connection);
      } catch (error) {
        printError(`SSH connection failed: ${error}`);
        process.exit(1);
      }
    });
}
