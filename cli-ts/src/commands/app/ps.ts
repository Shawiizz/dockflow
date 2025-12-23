/**
 * PS command - List running containers
 * 
 * Uses StackService to retrieve container information.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { printError, printInfo, printSection } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createStackService } from '../../services';

export function registerPsCommand(program: Command): void {
  program
    .command('ps <env>')
    .description('List running containers')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('--tasks', 'Show tasks instead of containers')
    .action(async (env: string, options: { server?: string; tasks?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const stackService = createStackService(connection, stackName);
      
      printInfo(`Stack: ${stackName}`);
      console.log('');

      try {
        if (options.tasks) {
          // Show tasks
          const tasksResult = await stackService.getTasks();
          
          if (!tasksResult.success) {
            printError(tasksResult.error.message);
            process.exit(1);
          }

          printSection('Tasks');
          console.log('');
          
          for (const task of tasksResult.data) {
            const stateColor = task.currentState.includes('Running') 
              ? chalk.green 
              : task.currentState.includes('Failed') 
                ? chalk.red 
                : chalk.yellow;
            
            console.log(`  ${chalk.cyan(task.name)}`);
            console.log(`    ID: ${task.id.substring(0, 12)}`);
            console.log(`    Node: ${task.node}`);
            console.log(`    State: ${stateColor(task.currentState)}`);
            if (task.error) {
              console.log(`    Error: ${chalk.red(task.error)}`);
            }
            console.log('');
          }
        } else {
          // Show containers
          const containersResult = await stackService.getContainers();
          
          if (!containersResult.success) {
            printError(containersResult.error.message);
            process.exit(1);
          }

          if (containersResult.data.length === 0) {
            printInfo('No running containers');
            return;
          }

          printSection('Containers');
          console.log('');
          console.log(chalk.gray('  ID            NAME                                STATUS              PORTS'));
          console.log(chalk.gray('  ' + '─'.repeat(80)));
          
          for (const container of containersResult.data) {
            const statusColor = container.status.includes('Up') ? chalk.green : chalk.yellow;
            console.log(
              `  ${container.id.substring(0, 12).padEnd(14)}` +
              `${container.name.substring(0, 35).padEnd(36)}` +
              `${statusColor(container.status.substring(0, 18).padEnd(20))}` +
              `${container.ports || ''}`
            );
          }
          console.log('');
        }
      } catch (error) {
        printError(`Failed to list containers: ${error}`);
        process.exit(1);
      }
    });
}
