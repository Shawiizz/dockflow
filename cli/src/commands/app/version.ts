/**
 * Version command - Show deployed app version
 */

import type { Command } from 'commander';
import { validateEnv } from '../../utils/validation';
import { createStackBackend } from '../../services/orchestrator/factory';
import { loadConfig } from '../../utils/config';
import { DockerError, withErrorHandler, ConfigError } from '../../utils/errors';
import { colors, printJSON, printBlank, printDim, printRaw } from '../../utils/output';

export function registerVersionCommand(program: Command): void {
  program
    .command('version <env>')
    .description('Show app version currently deployed')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(async (env: string, options: { server?: string; json?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const orchestrator = createStackBackend(config.orchestrator ?? 'swarm', connection);

      const metadata = await orchestrator.getMetadata(stackName);
      if (!metadata) {
        throw new DockerError(`No deployment found for ${stackName}`);
      }

      if (options.json) {
        printJSON(metadata);
        return;
      }

      const services = await orchestrator.getServices(stackName);

      printBlank();
      printRaw(`Stack: ${colors.info(stackName)}`);
      printBlank();
      printRaw(colors.dim('  Version:     ') + colors.success(metadata.version));
      printRaw(colors.dim('  Environment: ') + metadata.env);
      printRaw(colors.dim('  Branch:      ') + (metadata.branch || 'N/A'));
      printRaw(colors.dim('  Deployed:    ') + metadata.timestamp);
      printBlank();

      if (services.length > 0) {
        printDim('Running images:');
        for (const service of services) {
          printRaw(colors.dim('  ') + `${service.name}: ${service.image}`);
        }
        printBlank();
      }
    }));
}
