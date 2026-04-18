/**
 * Stop command - Stop and remove the stack
 */

import type { Command } from 'commander';
import { printWarning, printInfo, printDebug, createSpinner } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { validateEnv } from '../../utils/validation';
import { createStackBackend } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { DockerError, withErrorHandler, ConfigError } from '../../utils/errors';

export function registerStopCommand(program: Command): void {
  program
    .command('stop <env>')
    .description('Stop and remove the stack')
    .helpGroup('Operate')
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

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createStackBackend(config.orchestrator ?? 'swarm', connection);

      const spinner = createSpinner();
      spinner.start(`Stopping stack ${stackName}...`);

      try {
        await orchestrator.removeStack(stackName);
        spinner.succeed(`Stack ${stackName} stopped`);
      } catch (error) {
        if (error instanceof DockerError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        spinner.fail(`Failed to stop: ${msg}`);
        throw new DockerError(msg);
      }
    }));
}
