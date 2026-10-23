/**
 * Accessories Restart Command
 * Restart accessory services by forcing an update
 */

import type { Command } from 'commander';
import { printIntro, printOutro, printDebug, printBlank, printWarning, createSpinner } from '../../utils/output';
import { idleServices } from '../app/service-name';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { SwarmStack } from '../../services/swarm/stack';
import { loadConfig } from '../../utils/config';
import { CLIError, DockerError, withErrorHandler, ConfigError } from '../../utils/errors';

export function registerAccessoriesRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart accessory services')
    .option('--force', 'Force restart even if service is updating')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('--no-wait', 'Return once Swarm accepted the change, without waiting for the services to converge')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      service: string | undefined,
      options: { force?: boolean; server?: string; wait?: boolean }
    ) => {
      printIntro(`Restarting Accessories - ${env}`);
      printBlank();

      const { connection } = await resolveEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const swarm = new SwarmStack(connection);

      printDebug('Connection validated', { stackName });
      const spinner = createSpinner();

      try {
        spinner.start(service ? `Restarting ${service}...` : 'Restarting all accessories...');
        await swarm.restart(stackName, service, { detach: options.wait === false });
        const services = await swarm.getServices(stackName);
        const idle = idleServices(services, service ? [service] : services.map((s) => s.name));
        if (idle.length > 0) {
          spinner.warn(`Restarted, but ${idle.join(', ')} ${idle.length === 1 ? 'has' : 'have'} 0 replicas and ${idle.length === 1 ? 'was' : 'were'} not started`);
          printWarning(`Start stopped accessories with \`dockflow deploy ${env} --accessories\`.`);
        } else {
          spinner.succeed(service ? `Accessory '${service}' restarted` : 'All accessories restarted');
          if (!service) printOutro('Restart complete');
        }
      } catch (error) {
        if (error instanceof CLIError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        throw new DockerError(`Failed to restart: ${msg}`);
      }
    })));
}
