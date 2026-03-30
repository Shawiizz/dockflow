/**
 * Stop command - Stop and remove the stack
 */

import type { Command } from 'commander';
import { printWarning, printInfo, printDebug, createSpinner } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
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

        const confirmed = await confirmPrompt({
          message: 'Are you sure?',
          initialValue: false,
        });

        if (!confirmed) {
          printInfo('Cancelled');
          return;
        }
      }

      const stackService = createStackService(connection, stackName);
      const spinner = createSpinner();
      spinner.start(`Stopping stack ${stackName}...`);

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
