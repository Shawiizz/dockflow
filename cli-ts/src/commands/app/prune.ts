/**
 * Prune command - Remove unused Docker resources
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printSuccess, printInfo, printSection, printHeader, printWarning, printDebug, printBlank, printRaw } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerPruneCommand(program: Command): void {
  program
    .command('prune <env>')
    .description('Remove unused Docker resources (images, containers, volumes, networks)')
    .option('-a, --all', 'Remove all unused images, not just dangling ones')
    .option('--images', 'Prune images only')
    .option('--containers', 'Prune containers only')
    .option('--volumes', 'Prune volumes only')
    .option('--networks', 'Prune networks only')
    .option('-y, --yes', 'Skip confirmation')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, options: { 
      all?: boolean; 
      images?: boolean; 
      containers?: boolean; 
      volumes?: boolean; 
      networks?: boolean;
      yes?: boolean;
      server?: string;
    }) => {
      const { connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { targets: [options.images, options.containers, options.volumes, options.networks] });

      // Determine what to prune
      const pruneAll = !options.images && !options.containers && !options.volumes && !options.networks;
      const targets: string[] = [];
      
      if (pruneAll || options.containers) targets.push('containers');
      if (pruneAll || options.images) targets.push('images');
      if (pruneAll || options.volumes) targets.push('volumes');
      if (pruneAll || options.networks) targets.push('networks');

      printHeader(`Prune Docker Resources on ${env}`);
      printInfo(`Targets: ${targets.join(', ')}`);
      printBlank();

      if (!options.yes) {
        printWarning('This will permanently remove unused Docker resources.');
        if (options.volumes || pruneAll) {
          printWarning('WARNING: Pruning volumes will delete data that is not attached to containers!');
        }
        
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        
        const answer = await new Promise<string>((resolve) => {
          rl.question('Are you sure you want to continue? (y/N) ', resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          printInfo('Cancelled');
          return;
        }
        printBlank();
      }

      const spinner = ora();

      try {
        // Prune containers
        if (pruneAll || options.containers) {
          spinner.start('Pruning stopped containers...');
          const result = await sshExec(connection, 'docker container prune -f');
          const match = result.stdout.match(/Total reclaimed space: (.+)/);
          spinner.succeed(`Containers pruned${match ? ` (${match[1]})` : ''}`);
        }

        // Prune images
        if (pruneAll || options.images) {
          const allFlag = options.all ? ' -a' : '';
          spinner.start(`Pruning ${options.all ? 'all unused' : 'dangling'} images...`);
          const result = await sshExec(connection, `docker image prune -f${allFlag}`);
          const match = result.stdout.match(/Total reclaimed space: (.+)/);
          spinner.succeed(`Images pruned${match ? ` (${match[1]})` : ''}`);
        }

        // Prune volumes (careful - can delete data!)
        if (pruneAll || options.volumes) {
          spinner.start('Pruning unused volumes...');
          const result = await sshExec(connection, 'docker volume prune -f');
          const match = result.stdout.match(/Total reclaimed space: (.+)/);
          spinner.succeed(`Volumes pruned${match ? ` (${match[1]})` : ''}`);
        }

        // Prune networks
        if (pruneAll || options.networks) {
          spinner.start('Pruning unused networks...');
          await sshExec(connection, 'docker network prune -f');
          spinner.succeed('Networks pruned');
        }

        printBlank();
        printSuccess('Docker resources cleaned up successfully');

        // Show disk usage after prune
        printSection('Current Disk Usage');
        const dfResult = await sshExec(connection, 'docker system df');
        printRaw(dfResult.stdout);

      } catch (error) {
        spinner.fail(`Prune failed: ${error}`);
        throw new DockerError(`${error}`);
      }
    }));
}
