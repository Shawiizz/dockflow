/**
 * Accessories Restart Command
 * Restart accessory services by forcing an update
 */

import type { Command } from 'commander';
import { printIntro, printOutro, printDebug, printBlank, createSpinner } from '../../utils/output';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createStackBackend } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { DockerError, withErrorHandler, ConfigError } from '../../utils/errors';

export function registerAccessoriesRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart accessory services')
    .option('--force', 'Force restart even if service is updating')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { force?: boolean; server?: string }
    ) => {
      printIntro(`Restarting Accessories - ${env}`);
      printBlank();

      const { connection } = validateEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createStackBackend(config.orchestrator ?? 'swarm', connection);

      printDebug('Connection validated', { stackName });
      const spinner = createSpinner();

      try {
        if (service) {
          spinner.start(`Restarting ${service}...`);
          await orchestrator.restart(stackName, service);
          spinner.succeed(`Accessory '${service}' restarted`);
        } else {
          spinner.start('Restarting all accessories...');
          await orchestrator.restart(stackName);
          spinner.succeed('All accessories restarted');
          printOutro('Restart complete');
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        throw new DockerError(`Failed to restart: ${msg}`);
      }
    })));
}
