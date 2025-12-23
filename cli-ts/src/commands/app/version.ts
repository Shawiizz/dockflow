/**
 * Version command - Show deployed app version
 * 
 * Uses StackService to retrieve deployment metadata.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { printError } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createStackService } from '../../services';

export function registerVersionCommand(program: Command): void {
  program
    .command('version <env>')
    .description('Show app version currently deployed')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--json', 'Output as JSON')
    .action(async (env: string, options: { server?: string; json?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);

      const stackService = createStackService(connection, stackName);

      try {
        // Get deployment metadata
        const metadataResult = await stackService.getMetadata();
        
        if (!metadataResult.success) {
          printError(`No deployment found for ${stackName}`);
          process.exit(1);
        }

        const metadata = metadataResult.data;

        if (options.json) {
          console.log(JSON.stringify(metadata, null, 2));
          return;
        }

        // Get running images
        const servicesResult = await stackService.getServices();
        
        console.log('');
        console.log(chalk.white(`Stack: ${chalk.cyan(stackName)}`));
        console.log('');
        console.log(chalk.gray('  Version:     ') + chalk.green(metadata.version));
        console.log(chalk.gray('  Environment: ') + chalk.white(metadata.environment));
        console.log(chalk.gray('  Branch:      ') + chalk.white(metadata.branch || 'N/A'));
        console.log(chalk.gray('  Deployed:    ') + chalk.white(metadata.timestamp));
        console.log('');

        if (servicesResult.success && servicesResult.data.length > 0) {
          console.log(chalk.gray('Running images:'));
          for (const service of servicesResult.data) {
            console.log(chalk.gray('  ') + `${service.name}: ${service.image}`);
          }
          console.log('');
        }
      } catch (error) {
        printError(`Failed to get version: ${error}`);
        process.exit(1);
      }
    });
}
