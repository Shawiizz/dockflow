/**
 * Accessories Remove Command
 * Remove the accessories stack entirely
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { getAccessoriesStackName } from '../../utils/config';
import { sshExec, sshExecStream } from '../../utils/ssh';
import { printError, printInfo, printSuccess, printHeader, printWarning } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

/**
 * Register the accessories remove command
 */
export function registerAccessoriesRemoveCommand(program: Command): void {
  program
    .command('remove <env>')
    .alias('rm')
    .description('Remove the accessories stack entirely')
    .option('-v, --volumes', 'Also remove associated volumes (DESTRUCTIVE)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (
      env: string,
      options: { volumes?: boolean; yes?: boolean }
    ) => {
      printHeader(`Removing Accessories - ${env}`);
      console.log('');

      // Validate environment
      const { connection } = await validateEnvOrExit(env);
      const stackName = getAccessoriesStackName(env)!;

      // Check if accessories stack exists
      const stacksResult = await sshExec(connection, `docker stack ls --format "{{.Name}}"`);
      const stacks = stacksResult.stdout.trim().split('\n').filter(Boolean);
      
      if (!stacks.includes(stackName)) {
        printError('Accessories stack not found');
        printInfo('Nothing to remove.');
        process.exit(1);
      }

      // Show what will be removed
      const servicesResult = await sshExec(connection, 
        `docker stack services ${stackName} --format "{{.Name}}\t{{.Replicas}}"`
      );
      
      if (servicesResult.stdout.trim()) {
        console.log(chalk.yellow('The following services will be removed:'));
        for (const line of servicesResult.stdout.trim().split('\n')) {
          const [name, replicas] = line.split('\t');
          const shortName = name.replace(`${stackName}_`, '');
          console.log(`  ${chalk.cyan(shortName)} ${chalk.dim(`(${replicas})`)}`);
        }
      }

      // Show volumes if --volumes is specified
      if (options.volumes) {
        const volumesResult = await sshExec(connection, 
          `docker volume ls --filter "label=com.docker.stack.namespace=${stackName}" --format "{{.Name}}"`
        );
        
        if (volumesResult.stdout.trim()) {
          console.log('');
          console.log(chalk.red('⚠ The following volumes will be PERMANENTLY DELETED:'));
          for (const vol of volumesResult.stdout.trim().split('\n').filter(Boolean)) {
            console.log(`  ${chalk.red(vol)}`);
          }
        }
      }

      console.log('');

      // Confirmation
      if (!options.yes) {
        const warningMessage = options.volumes 
          ? 'This will PERMANENTLY DELETE the accessories stack and their data!'
          : 'This will remove the accessories stack (volumes will be preserved)';
        
        printWarning(warningMessage);
        
        if (options.volumes) {
          // Extra confirmation for volume deletion
          const { confirmText } = await inquirer.prompt([
            {
              type: 'input',
              name: 'confirmText',
              message: `Type '${env}' to confirm removal with volumes:`,
            },
          ]);

          if (confirmText !== env) {
            printInfo('Cancelled - text did not match');
            return;
          }
        } else {
          const { confirm } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: 'Are you sure you want to remove the accessories stack?',
              default: false,
            },
          ]);

          if (!confirm) {
            printInfo('Cancelled');
            return;
          }
        }
      }

      console.log('');
      
      try {
        // Remove the stack
        const spinner = ora('Removing accessories stack...').start();
        
        const removeCmd = `docker stack rm ${stackName}`;
        const result = await sshExec(connection, removeCmd);

        if (result.exitCode !== 0) {
          spinner.fail('Remove failed');
          console.error(result.stderr);
          process.exit(1);
        }

        // Wait for stack to be fully removed
        spinner.text = 'Waiting for stack removal...';
        let attempts = 0;
        while (attempts < 30) {
          const checkResult = await sshExec(connection, 
            `docker stack ps ${stackName} 2>&1 | grep -v "Nothing found" | wc -l`
          );
          const count = parseInt(checkResult.stdout.trim(), 10);
          if (count <= 1) break; // Only header line or nothing
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }

        spinner.succeed('Accessories stack removed');

        // Remove volumes if requested
        if (options.volumes) {
          const volumesResult = await sshExec(connection, 
            `docker volume ls --filter "label=com.docker.stack.namespace=${stackName}" --format "{{.Name}}"`
          );
          
          const volumes = volumesResult.stdout.trim().split('\n').filter(Boolean);
          
          if (volumes.length > 0) {
            const volSpinner = ora('Removing volumes...').start();
            
            for (const vol of volumes) {
              await sshExec(connection, `docker volume rm ${vol}`);
            }
            
            volSpinner.succeed(`Removed ${volumes.length} volume(s)`);
          }
        }

        // Clean up local files on remote
        const accessoriesDir = `/var/lib/dockflow/accessories/${stackName}`;
        await sshExec(connection, `rm -rf ${accessoriesDir}`);

        console.log('');
        printSuccess('Accessories removed successfully');
        
        if (!options.volumes) {
          console.log('');
          printInfo('Volumes were preserved. To remove them manually:');
          console.log(`  docker volume ls --filter "label=com.docker.stack.namespace=${stackName}"`);
          console.log(`  docker volume rm <volume_name>`);
        }

      } catch (error) {
        printError(`Failed to remove: ${error}`);
        process.exit(1);
      }
    });
}
