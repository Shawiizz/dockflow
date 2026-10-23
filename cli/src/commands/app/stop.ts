/**
 * Stop command - Stop and remove the stack
 */

import type { Command } from 'commander';
import { printWarning, printInfo, printDebug, createSpinner } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStack } from '../../services/swarm/stack';
import { loadConfig } from '../../utils/config';
import { CLIError, DockerError, withServicesRequired, ConfigError } from '../../utils/errors';
import { createEnvLock } from '../../services/lock';
import { withDeployLock } from '../with-lock';

export function registerStopCommand(program: Command): void {
  program
    .command('stop <env>')
    .description('Stop and remove the stack')
    .helpGroup('Operate')
    .option('-y, --yes', 'Skip confirmation')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withServicesRequired(withResolvedEnv(async (env: string, options: { yes?: boolean; server?: string }) => {
      const { stackName, connection } = await resolveEnv(env, options.server);
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
      const swarm = new SwarmStack(connection);

      const spinner = createSpinner();

      try {
        await withDeployLock(await createEnvLock(env, stackName, config.lock?.stale_threshold_minutes), `Stop ${stackName}`, async () => {
          spinner.start(`Stopping stack ${stackName}...`);
          await swarm.removeStack(stackName);
          spinner.succeed(`Stack ${stackName} stopped`);
        });
      } catch (error) {
        if (error instanceof CLIError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        spinner.fail(`Failed to stop: ${msg}`);
        throw new DockerError(msg);
      }
    })));
}
