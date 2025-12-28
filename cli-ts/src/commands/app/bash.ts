/**
 * Bash command - Open interactive shell in a container
 * 
 * Uses ExecService to handle shell connections.
 */

import type { Command } from 'commander';
import { printInfo } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createExecService, createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerBashCommand(program: Command): void {
  program
    .command('bash <env> <service>')
    .alias('shell')
    .description('Open an interactive shell in a container')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--sh', 'Use sh instead of bash')
    .action(withErrorHandler(async (env: string, service: string, options: { server?: string; sh?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      
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
          // Try to list available services
          const services = await stackService.getServiceNames();
          const suggestion = services.length > 0
            ? `Available services: ${services.join(', ')}`
            : undefined;
          
          throw new DockerError(result.error.message, { suggestion });
        }
      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to connect: ${error}`);
      }
    }));
}
