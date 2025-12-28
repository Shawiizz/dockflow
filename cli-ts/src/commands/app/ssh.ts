/**
 * SSH command - Open SSH session to server
 */

import type { Command } from 'commander';
import { sshShell } from '../../utils/ssh';
import { printInfo } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { ConnectionError, withErrorHandler } from '../../utils/errors';

export function registerSshCommand(program: Command): void {
  program
    .command('ssh <env>')
    .description('Open SSH session to server')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, options: { server?: string }) => {
      const { connection, serverName } = validateEnv(env, options.server);
      
      printInfo(`Connecting to ${env} server (${serverName})...`);
      console.log('');

      try {
        await sshShell(connection);
      } catch (error) {
        throw new ConnectionError(`SSH connection failed: ${error}`);
      }
    }));
}
