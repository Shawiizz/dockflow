/**
 * Bash command - Open interactive shell in a container
 * 
 * Uses ExecService to handle shell connections.
 */

import type { Command } from 'commander';
import { printError, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';
import { createExecService, createStackService } from '../../services';

export function registerBashCommand(program: Command): void {
  program
    .command('bash <env> <service>')
    .alias('shell')
    .description('Open an interactive shell in a container')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--sh', 'Use sh instead of bash')
    .action(async (env: string, service: string, options: { server?: string; sh?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const execService = createExecService(connection, stackName);
      const stackService = createStackService(connection, stackName);

      try {
        printInfo(`Connecting to ${stackName}_${service}...`);
        console.log('');

        let result;
        if (options.sh) {
          result = await execService.shell(service, '/bin/sh');
        } else {
          result = await execService.bash(service);
        }

        if (!result.success) {
          printError(result.error.message);
          
          // Try to list available services
          const services = await stackService.getServiceNames();
          if (services.length > 0) {
            console.log('');
            console.log('Available services:');
            services.forEach(svc => console.log(`  - ${svc}`));
          }
          
          process.exit(1);
        }
      } catch (error) {
        printError(`Failed to connect: ${error}`);
        process.exit(1);
      }
    });
}
