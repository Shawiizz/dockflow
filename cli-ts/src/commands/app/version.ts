/**
 * Version command - Show deployed app version
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerVersionCommand(program: Command): void {
  program
    .command('version <env>')
    .description('Show app version currently deployed')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .action(async (env: string, options: { server?: string }) => {
      const { stackName, connection, serverName } = await validateEnvOrExit(env, options.server);

      try {
        // Get version from metadata file
        const metadataResult = await sshExec(
          connection,
          `cat /var/lib/dockflow/stacks/${stackName}/current/metadata.json 2>/dev/null || echo "NO_METADATA"`
        );

        if (metadataResult.stdout.trim() === 'NO_METADATA') {
          printError(`No deployment found for ${stackName}`);
          process.exit(1);
        }

        try {
          const metadata = JSON.parse(metadataResult.stdout.trim());
          
          console.log('');
          console.log(chalk.white(`Stack: ${chalk.cyan(stackName)}`));
          console.log('');
          console.log(chalk.gray('  Version:     ') + chalk.green(metadata.version));
          console.log(chalk.gray('  Environment: ') + chalk.white(metadata.environment));
          console.log(chalk.gray('  Branch:      ') + chalk.white(metadata.branch || 'N/A'));
          console.log(chalk.gray('  Deployed:    ') + chalk.white(metadata.timestamp));
          console.log('');

          // Also show running image versions for verification
          const imagesResult = await sshExec(
            connection,
            `docker stack services ${stackName} --format '{{.Name}}: {{.Image}}' 2>/dev/null || echo ""`
          );
          
          if (imagesResult.stdout.trim()) {
            console.log(chalk.gray('Running images:'));
            imagesResult.stdout.trim().split('\n').forEach(line => {
              console.log(chalk.gray('  ') + line);
            });
            console.log('');
          }
        } catch {
          printError('Failed to parse deployment metadata');
          console.log(chalk.gray(metadataResult.stdout));
          process.exit(1);
        }
      } catch (error) {
        printError(`Failed to get version: ${error}`);
        process.exit(1);
      }
    });
}
