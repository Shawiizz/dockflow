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
    .action(async (env: string) => {
      const { connection } = await validateEnvOrExit(env);
      
      printInfo(`Connecting to ${env} server...`);
      console.log('');

      try {
        await sshShell(connection);
      } catch (error) {
        printError(`SSH connection failed: ${error}`);
        process.exit(1);
      }
    });
}
