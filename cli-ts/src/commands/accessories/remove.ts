/**
 * Accessories Remove Command
 * Remove the accessories stack entirely
 */

import type { Command } from 'commander';
import ora from 'ora';
import inquirer from 'inquirer';
import { sshExec } from '../../utils/ssh';
import { printInfo, printSuccess, printHeader, printWarning, printError, printBlank, printRaw, colors } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { validateAccessoriesStack, getShortServiceNames } from './utils';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';
import { STACK_REMOVAL_MAX_ATTEMPTS, STACK_REMOVAL_POLL_INTERVAL_MS } from '../../constants';

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
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (
      env: string,
      options: { volumes?: boolean; yes?: boolean; server?: string }
    ) => {
      printHeader(`Removing Accessories - ${env}`);
      printBlank();

      // Validate environment and check stack exists
      const { connection } = validateEnv(env, options.server);
      const validation = await validateAccessoriesStack(connection, env);

      if (!validation.exists) {
        throw new DockerError(
          'Accessories stack not found',
          { code: ErrorCode.STACK_NOT_FOUND, suggestion: 'Nothing to remove.' }
        );
      }

      const { stackName, services } = validation;
      const shortNames = getShortServiceNames(services, stackName);

      // Show what will be removed
      if (services.length > 0) {
        printWarning('The following services will be removed:');
        
        // Get replicas info
        const servicesResult = await sshExec(connection, 
          `docker stack services ${stackName} --format "{{.Name}}\t{{.Replicas}}"`
        );
        
        for (const line of servicesResult.stdout.trim().split('\n')) {
          const [name, replicas] = line.split('\t');
          const shortName = name.replace(`${stackName}_`, '');
          console.log(`  ${colors.info(shortName)} ${colors.dim(`(${replicas})`)}`);
        }
      }

      // Show volumes if --volumes is specified
      if (options.volumes) {
        const volumesResult = await sshExec(connection,
          `docker volume ls --filter "label=com.docker.stack.namespace=${stackName}" --format "{{.Name}}"`
        );

        if (volumesResult.stdout.trim()) {
          printBlank();
          printError('⚠ The following volumes will be PERMANENTLY DELETED:');
          for (const vol of volumesResult.stdout.trim().split('\n').filter(Boolean)) {
            console.log(`  ${colors.error(vol)}`);
          }
        }
      }

      printBlank();

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

      printBlank();

      try {
        // Remove the stack
        const spinner = ora('Removing accessories stack...').start();
        
        const removeCmd = `docker stack rm ${stackName}`;
        const result = await sshExec(connection, removeCmd);

        if (result.exitCode !== 0) {
          spinner.fail('Remove failed');
          throw new DockerError(result.stderr || 'Failed to remove stack');
        }

        // Wait for stack to be fully removed
        spinner.text = 'Waiting for stack removal...';
        let attempts = 0;
        while (attempts < STACK_REMOVAL_MAX_ATTEMPTS) {
          const checkResult = await sshExec(connection, 
            `docker stack ps ${stackName} 2>&1 | grep -v "Nothing found" | wc -l`
          );
          const count = parseInt(checkResult.stdout.trim(), 10);
          if (count <= 1) break; // Only header line or nothing
          await new Promise(resolve => setTimeout(resolve, STACK_REMOVAL_POLL_INTERVAL_MS));
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

        printBlank();
        printSuccess('Accessories removed successfully');

        if (!options.volumes) {
          printBlank();
          printInfo('Volumes were preserved. To remove them manually:');
          printRaw(`  docker volume ls --filter "label=com.docker.stack.namespace=${stackName}"`);
          printRaw(`  docker volume rm <volume_name>`);
        }

      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to remove: ${error}`);
      }
    }));
}
