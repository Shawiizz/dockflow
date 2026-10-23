/**
 * Version command - Show deployed app version
 */

import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStack } from '../../services/swarm/stack';
import { loadConfig } from '../../utils/config';
import { CLIError, ErrorCode, withServicesRequired, ConfigError } from '../../utils/errors';
import { colors, printJSON, printBlank, printDim, printRaw } from '../../utils/output';

export function registerVersionCommand(program: Command): void {
  program
    .command('version <env>')
    .description('Show app version currently deployed')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-j, --json', 'Output as JSON')
    .action(withServicesRequired(withResolvedEnv(async (env: string, options: { server?: string; json?: boolean }) => {
      const { stackName, connection } = await resolveEnv(env, options.server);

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      const swarm = new SwarmStack(connection);

      const metadata = await swarm.getMetadata(stackName);
      if (!metadata) {
        throw new CLIError(`No deployment found for ${stackName}`, ErrorCode.STACK_NOT_FOUND, `Deploy first with \`dockflow deploy ${env}\`.`);
      }

      if (options.json) {
        printJSON(metadata);
        return;
      }

      const services = await swarm.getServices(stackName);

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
    })));
}
