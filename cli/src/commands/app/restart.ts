/**
 * Restart command - Restart services
 */

import type { Command } from 'commander';
import { printSuccess, printDebug, createSpinner } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createOrchestrator } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { DockerError, withErrorHandler, ConfigError } from '../../utils/errors';

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createOrchestrator(config.orchestrator ?? 'swarm', connection);

      const spinner = createSpinner();

      try {
        if (service) {
          spinner.start(`Restarting ${service}...`);
          await orchestrator.restart(stackName, service);
          spinner.succeed(`Restarted ${service}`);
        } else {
          spinner.start('Restarting all services...');
          await orchestrator.restart(stackName);
          spinner.succeed('All services restarted');
          printSuccess('All services restarted');
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        spinner.fail(`Failed to restart: ${msg}`);
        throw new DockerError(msg);
      }
    }));
}
