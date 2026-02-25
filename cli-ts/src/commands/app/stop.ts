/**
 * Stop command - Stop and remove the stack
 */

import type { Command } from 'commander';
import ora from 'ora';
import inquirer from 'inquirer';
import { printWarning, printInfo, printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createStackService } from '../../services';
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

        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Are you sure?',
            default: false,
          },
        ]);

        if (!confirm) {
          printInfo('Cancelled');
          return;
        }
      }

      const stackService = createStackService(connection, stackName);
      const spinner = ora(`Stopping stack ${stackName}...`).start();

      try {
        const result = await stackService.remove();
        if (result.success) {
          spinner.succeed(`Stack ${stackName} stopped`);
        } else {
          spinner.fail(`Failed to stop: ${result.message}`);
          throw new DockerError(result.message || 'Failed to remove stack');
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        spinner.fail(`Failed to stop: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
