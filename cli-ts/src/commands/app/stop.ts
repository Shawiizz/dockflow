/**
 * Stop command - Stop and remove the stack
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printWarning, printInfo, printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerStopCommand(program: Command): void {
  program
    .command('stop <env>')
    .description('Stop and remove the stack')
    .option('-y, --yes', 'Skip confirmation')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, options: { yes?: boolean; server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });
      
      if (!options.yes) {
        printWarning(`This will remove all services in stack: ${stackName}`);
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        
        const answer = await new Promise<string>((resolve) => {
          rl.question('Are you sure? (y/N) ', resolve);
        });
        rl.close();
        
        if (answer.toLowerCase() !== 'y') {
          printInfo('Cancelled');
          return;
        }
      }

      const spinner = ora(`Stopping stack ${stackName}...`).start();

      try {
        await sshExec(connection, `docker stack rm ${stackName}`);
        spinner.succeed(`Stack ${stackName} stopped`);
      } catch (error) {
        spinner.fail(`Failed to stop: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
