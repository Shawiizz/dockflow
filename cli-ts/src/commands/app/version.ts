/**
 * Version command - Show deployed app version
 * 
 * Uses StackService to retrieve deployment metadata.
 */

import type { Command } from 'commander';
import { validateEnv } from '../../utils/validation';
import { createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';
import { colors, printJSON, printBlank, printDim, printRaw } from '../../utils/output';

export function registerVersionCommand(program: Command): void {
  program
    .command('version <env>')
    .description('Show app version currently deployed')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(async (env: string, options: { server?: string; json?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);

      const stackService = createStackService(connection, stackName);

      try {
        // Get deployment metadata
        const metadataResult = await stackService.getMetadata();
        
        if (!metadataResult.success) {
          throw new DockerError(`No deployment found for ${stackName}`);
        }

        const metadata = metadataResult.data;

        if (options.json) {
          printJSON(metadata);
          return;
        }

        // Get running images
        const servicesResult = await stackService.getServices();

        printBlank();
        printRaw(`Stack: ${colors.info(stackName)}`);
        printBlank();
        printRaw(colors.dim('  Version:     ') + colors.success(metadata.version));
        printRaw(colors.dim('  Environment: ') + metadata.environment);
        printRaw(colors.dim('  Branch:      ') + (metadata.branch || 'N/A'));
        printRaw(colors.dim('  Deployed:    ') + metadata.timestamp);
        printBlank();

        if (servicesResult.success && servicesResult.data.length > 0) {
          printDim('Running images:');
          for (const service of servicesResult.data) {
            printRaw(colors.dim('  ') + `${service.name}: ${service.image}`);
          }
          printBlank();
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to get version: ${error}`);
      }
    }));
}
