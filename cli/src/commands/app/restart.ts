/**
 * Restart command - Restart services
 */

import type { Command } from 'commander';
import { printDebug, printWarning, createSpinner } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStack } from '../../services/swarm/stack';
import { loadConfig } from '../../utils/config';
import { CLIError, DockerError, withServicesRequired, ConfigError } from '../../utils/errors';
import { idleServices, requireAppService } from './service-name';

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('--no-wait', 'Return once Swarm accepted the change, without waiting for the services to converge')
    .action(withServicesRequired(withResolvedEnv(async (env: string, service: string | undefined, options: { server?: string; wait?: boolean }) => {
      const { stackName, connection } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const swarm = new SwarmStack(connection);

      if (service) await requireAppService(connection, env, stackName, service, 'restart');
      const spinner = createSpinner();

      try {
        spinner.start(service ? `Restarting ${service}...` : 'Restarting all services...');
        await swarm.restart(stackName, service, { detach: options.wait === false });
        const services = await swarm.getServices(stackName);
        const idle = idleServices(services, service ? [service] : services.map((s) => s.name));
        if (idle.length > 0) {
          spinner.warn(`Restarted, but ${idle.join(', ')} ${idle.length === 1 ? 'has' : 'have'} 0 replicas and ${idle.length === 1 ? 'was' : 'were'} not started`);
          printWarning(`Give ${idle.length === 1 ? 'it' : 'them'} replicas with \`dockflow scale ${env} <service> <n>\` or \`dockflow deploy ${env}\`.`);
        } else {
          spinner.succeed(service ? `Restarted ${service}` : 'All services restarted');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        spinner.fail(`Failed to restart: ${msg}`);
        throw error instanceof CLIError ? error : new DockerError(msg);
      }
    })));
}
