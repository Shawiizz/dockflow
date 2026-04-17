/**
 * Accessories Stop Command
 * Stop accessory services by scaling to 0 replicas
 */

import type { Command } from 'commander';
import { printInfo, printIntro, printOutro, printNote, printWarning, printBlank, createSpinner } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createOrchestrator } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { DockerError, withErrorHandler, ConfigError } from '../../utils/errors';

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

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createOrchestrator(config.orchestrator ?? 'swarm', connection);

      const services = await orchestrator.getServices(stackName);
      if (services.length === 0) {
        throw new DockerError('No accessories services found');
      }

      const targetDesc = service ? `accessory '${service}'` : 'all accessories';

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
          await orchestrator.scaleService(stackName, service, 0);
          spinner.succeed(`Accessory '${service}' stopped`);
        } else {
          const spinner = createSpinner();
          spinner.start('Scaling all services to 0...');
          let allSuccess = true;

          for (const svc of services) {
            try {
              await orchestrator.scaleService(stackName, svc.name, 0);
            } catch {
              allSuccess = false;
            }
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
        const msg = error instanceof Error ? error.message : String(error);
        throw new DockerError(`Failed to stop: ${msg}`);
      }
    })));
}
