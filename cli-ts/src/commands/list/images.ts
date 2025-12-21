/**
 * List images command - Show app images on server
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printError, printSection } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { loadConfig } from '../../utils/config';

export function registerListImagesCommand(parent: Command): void {
  parent
    .command('images <env>')
    .description('Show app images on server')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-a, --all', 'Show all images, not just app images')
    .action(async (env: string, options: { server?: string; all?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      const config = loadConfig();
      const projectName = config?.project_name || stackName.split('-')[0];

      try {
        console.log('');
        
        if (options.all) {
          // Show all images
          printSection('All Docker Images');
          const result = await sshExec(
            connection,
            `docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"`
          );
          console.log(result.stdout);
        } else {
          // Show only app-related images
          printSection(`Images for ${projectName}`);
          
          // Get images matching project name
          const result = await sshExec(
            connection,
            `docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}" | grep -E "^REPOSITORY|${projectName}" || echo "No images found for ${projectName}"`
          );
          console.log(result.stdout);

          // Show disk usage summary
          console.log('');
          printSection('Disk Usage');
          const diskResult = await sshExec(
            connection,
            `docker system df --format "table {{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}"`
          );
          console.log(diskResult.stdout);
          
          console.log('');
          console.log(chalk.gray('Tip: Run `dockflow prune <env>` to clean up unused images'));
        }
      } catch (error) {
        printError(`Failed to list images: ${error}`);
        process.exit(1);
      }
    });
}
