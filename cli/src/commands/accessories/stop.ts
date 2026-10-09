/**
 * Accessories Stop Command
 * Stop accessory services by scaling to 0 replicas
 */

import type { Command } from 'commander';
import { printInfo, printIntro, printOutro, printNote, printWarning, printBlank, createSpinner } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { createStackBackend } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { CLIError, DockerError, ErrorCode, withErrorHandler, ConfigError } from '../../utils/errors';

export function registerAccessoriesStopCommand(program: Command): void {
  program
    .command('stop <env> [service]')
    .description('Stop accessory services (scale to 0; deploy --accessories starts them again)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--no-wait', 'Return once Swarm accepted the change, without waiting for the services to stop')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { yes?: boolean; server?: string; wait?: boolean }
    ) => {
      printIntro(`Stopping Accessories - ${env}`);
      printBlank();

      const { connection } = await resolveEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createStackBackend(connection);

      const services = await orchestrator.getServices(stackName);
      if (services.length === 0) {
        throw new DockerError('No accessories services found', { code: ErrorCode.STACK_NOT_FOUND });
      }

      if (service && !services.some((s) => s.name === service)) {
        throw new CLIError(`No accessory ${service} in ${stackName}`, ErrorCode.SERVICE_NOT_FOUND, `Accessories: ${services.map((s) => s.name).join(', ')}`);
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

      const scale = { detach: options.wait === false };
      const done = scale.detach ? 'asked to stop' : 'stopped';
      try {
        if (service) {
          const spinner = createSpinner();
          spinner.start(`Stopping ${service}...`);
          await orchestrator.scaleService(stackName, service, 0, scale);
          spinner.succeed(`Accessory '${service}' ${done}`);
        } else {
          const spinner = createSpinner();
          spinner.start('Scaling all services to 0...');
          const failed: string[] = [];

          for (const svc of services) {
            try {
              await orchestrator.scaleService(stackName, svc.name, 0, scale);
            } catch (error) {
              failed.push(`${svc.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          if (failed.length > 0) {
            spinner.fail(`${failed.length} of ${services.length} accessories did not stop`);
            throw new DockerError(`Accessories not stopped:\n  ${failed.join('\n  ')}`);
          }
          spinner.succeed(`All accessories ${done}`);
        }

        printBlank();
        // restart keeps a service at 0 replicas: the deploy brings back the count accessories.yml sets
        printNote(
          `To start again: dockflow deploy ${env} --accessories\n` +
          `To remove:      dockflow accessories remove ${env}`,
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
