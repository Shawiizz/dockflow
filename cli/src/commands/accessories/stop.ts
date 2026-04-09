/**
 * Accessories Stop Command
 * Stop accessory services by scaling to 0 replicas
 *
 * Uses StackService (shared with app commands)
 */

import type { Command } from 'commander';
import { printInfo, printIntro, printOutro, printNote, printWarning, printBlank, createSpinner } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

/**
 * Register the accessories stop command
 */
export function registerAccessoriesStopCommand(program: Command): void {
  program
    .command('stop <env> [service]')
    .description('Stop accessory services (scale to 0, can be restarted)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { yes?: boolean; server?: string }
    ) => {
      printIntro(`Stopping Accessories - ${env}`);
      printBlank();

      const { connection } = validateEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);
      const stackService = createStackService(connection, stackName);

      const serviceNames = await stackService.getServiceNames();
      if (serviceNames.length === 0) {
        throw new DockerError('No accessories services found');
      }

      const targetDesc = service ? `accessory '${service}'` : 'all accessories';

      // Confirmation
      if (!options.yes) {
        printWarning(`This will stop ${targetDesc} (scale to 0 replicas)`);
        printInfo('Data in volumes will be preserved');
        printBlank();

        const confirmed = await confirmPrompt({
          message: `Are you sure you want to stop ${targetDesc}?`,
          initialValue: false,
        });

        if (!confirmed) {
          printInfo('Cancelled');
          return;
        }
      }

      try {
        if (service) {
          const spinner = createSpinner();
          spinner.start(`Stopping ${service}...`);
          const result = await stackService.scale(service, 0);

          if (result.success) {
            spinner.succeed(`Accessory '${service}' stopped`);
          } else {
            spinner.fail('Stop failed');
            throw new DockerError(result.message || 'Failed to stop service');
          }
        } else {
          const spinner = createSpinner();
          spinner.start('Scaling all services to 0...');
          let allSuccess = true;

          for (const svc of serviceNames) {
            const result = await stackService.scale(svc, 0);
            if (!result.success) allSuccess = false;
          }

          if (allSuccess) {
            spinner.succeed('All accessories stopped');
          } else {
            spinner.warn('Some services failed to stop');
          }
        }

        printBlank();
        printNote(
          `To restart: dockflow accessories restart ${env}` + (service ? ` ${service}` : '') + '\n' +
          `To remove:  dockflow accessories remove ${env}` + (service ? ` ${service}` : ''),
          'Next steps'
        );
        printOutro('Accessories stopped');

      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to stop: ${error}`);
      }
    })));
}
