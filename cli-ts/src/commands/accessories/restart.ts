/**
 * Accessories Restart Command
 * Restart accessory services by forcing an update
 *
 * Uses StackService (shared with app commands)
 */

import type { Command } from 'commander';
import { printIntro, printOutro, printDebug, printBlank, printRaw, createSpinner } from '../../utils/output';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

/**
 * Register the accessories restart command
 */
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
      const stackService = createStackService(connection, stackName);

      printDebug('Connection validated', { stackName });
      const spinner = createSpinner();

      try {
        if (service) {
          spinner.start(`Restarting ${service}...`);
          const result = await stackService.restart(service);

          if (result.success) {
            spinner.succeed(`Accessory '${service}' restarted`);
          } else {
            spinner.fail('Restart failed');
            throw new DockerError(result.message || 'Failed to restart service');
          }
        } else {
          spinner.start('Restarting all accessories...');
          const result = await stackService.restart();

          if (result.success) {
            spinner.succeed(result.message || 'Done');
            printOutro('Restart complete');
          } else {
            spinner.warn(result.message || 'Restart failed');
            if (result.output) {
              printRaw(result.output);
            }
          }
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to restart: ${error}`);
      }
    })));
}
