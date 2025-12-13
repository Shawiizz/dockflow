/**
 * Stop command - Stop and remove the stack
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printWarning, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerStopCommand(program: Command): void {
  program
    .command('stop <env>')
    .description('Stop and remove the stack')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (env: string, options: { yes?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
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
        process.exit(1);
      }
    });
}
