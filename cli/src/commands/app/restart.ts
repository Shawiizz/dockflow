/**
 * Restart command - Restart services
 */

import type { Command } from 'commander';
import { printDebug, printWarning, createSpinner } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { createStackBackend } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { DockerError, withServicesRequired, ConfigError } from '../../utils/errors';
import { idleServices, requireAppService } from './service-name';

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withServicesRequired(withResolvedEnv(async (env: string, service: string | undefined, options: { server?: string }) => {
      const { stackName, connection } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createStackBackend(connection);

      const spinner = createSpinner();

      try {
        if (service) await requireAppService(connection, env, stackName, service, 'restart');
        spinner.start(service ? `Restarting ${service}...` : 'Restarting all services...');
        await orchestrator.restart(stackName, service);
        const services = await orchestrator.getServices(stackName);
        const idle = idleServices(services, service ? [service] : services.map((s) => s.name));
        if (idle.length > 0) {
          spinner.warn(`Restarted, but ${idle.join(', ')} ${idle.length === 1 ? 'has' : 'have'} 0 replicas and ${idle.length === 1 ? 'was' : 'were'} not started`);
          printWarning(`Give ${idle.length === 1 ? 'it' : 'them'} replicas with \`dockflow scale ${env} <service> <n>\` or \`dockflow deploy ${env}\`.`);
        } else {
          spinner.succeed(service ? `Restarted ${service}` : 'All services restarted');
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        spinner.fail(`Failed to restart: ${msg}`);
        throw new DockerError(msg);
      }
    })));
}
