/**
 * Accessories List Command
 * List all running accessories and their status
 */

import type { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProjectRoot } from '../../utils/config';
import { sshExec } from '../../utils/ssh';
import { printInfo, printHeader, printSection, printBlank, printJSON, printDim, colors } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { validateAccessoriesStack } from './utils';
import { DockerError, withErrorHandler } from '../../utils/errors';

interface ServiceInfo {
  name: string;
  mode: string;
  replicas: string;
  image: string;
  ports: string;
}

/**
 * Parse docker stack services output
 */
function parseServicesOutput(output: string): ServiceInfo[] {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const parts = line.split('\t');
    return {
      name: parts[0] || '',
      mode: parts[1] || '',
      replicas: parts[2] || '',
      image: parts[3] || '',
      ports: parts[4] || '',
    };
  });
}

/**
 * Format replicas with color
 */
function formatReplicas(replicas: string): string {
  if (!replicas) return colors.dim('-');
  
  const [current, desired] = replicas.split('/').map(s => parseInt(s.trim(), 10));
  
  if (isNaN(current) || isNaN(desired)) {
    return colors.dim(replicas);
  }
  
  if (current === desired && current > 0) {
    return colors.success(`● ${replicas}`);
  }
  if (current === 0) {
    return colors.error(`○ ${replicas}`);
  }
  return colors.warning(`◐ ${replicas}`);
}

/**
 * Check if accessories.yml exists locally
 */
function hasAccessoriesFile(): boolean {
  const accessoriesPath = join(getProjectRoot(), '.dockflow', 'docker', 'accessories.yml');
  return existsSync(accessoriesPath);
}

/**
 * Register the accessories list command
 */
export function registerAccessoriesListCommand(program: Command): void {
  program
    .command('list <env>')
    .alias('ls')
    .description('List running accessories and their status')
    .option('--json', 'Output in JSON format')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, options: { json?: boolean; server?: string }) => {
      if (!options.json) {
        printHeader(`Accessories - ${env}`);
        printBlank();
      }

      // Validate environment
      const { connection } = validateEnv(env, options.server);
      const validation = await validateAccessoriesStack(connection, env);

      try {
        if (!validation.exists) {
          if (!hasAccessoriesFile()) {
            printInfo('No accessories.yml found in .dockflow/docker/');
            printInfo('Create one to define your accessories (databases, caches, etc.)');
          } else {
            printInfo('Accessories not deployed yet');
            printBlank();
            printInfo(`Deploy with: dockflow deploy ${env} --accessories`);
          }
          return;
        }

        const { stackName } = validation;

        // Get services info using docker stack services
        const format = '{{.Name}}\t{{.Mode}}\t{{.Replicas}}\t{{.Image}}\t{{.Ports}}';
        const listCmd = `docker stack services ${stackName} --format "${format}"`;
        
        const result = await sshExec(connection, listCmd);

        if (result.exitCode !== 0) {
          throw new DockerError('Failed to list accessories' + (result.stderr ? ': ' + result.stderr : ''));
        }

        const services = parseServicesOutput(result.stdout);

        if (services.length === 0) {
          printInfo('No accessories services found');
          return;
        }

        if (options.json) {
          printJSON(services);
          return;
        }

        // Display table header
        console.log(colors.bold('  SERVICE'.padEnd(30) + 'REPLICAS'.padEnd(15) + 'IMAGE'.padEnd(35) + 'PORTS'));
        printDim('  ' + '-'.repeat(90));

        for (const service of services) {
          const serviceName = service.name.replace(`${stackName}_`, '');
          const imageShort = service.image.length > 32 
            ? service.image.substring(0, 29) + '...' 
            : service.image;
          
          console.log(
            `  ${colors.info(serviceName.padEnd(28))} ` +
            `${formatReplicas(service.replicas).padEnd(25)} ` +
            `${colors.dim(imageShort.padEnd(35))} ` +
            `${colors.dim(service.ports || '-')}`
          );
        }

        printBlank();

        // Show volumes (associated with the stack)
        const volumesResult = await sshExec(connection, 
          `docker volume ls --filter "label=com.docker.stack.namespace=${stackName}" --format "{{.Name}}"`
        );
        
        if (volumesResult.stdout.trim()) {
          printSection('Volumes');
          for (const vol of volumesResult.stdout.trim().split('\n').filter(Boolean)) {
            console.log(`  ${colors.info(vol)}`);
          }
        }

        printBlank();
        printInfo(`Stack: ${stackName}`);

      } catch (error) {
        if (error instanceof DockerError) throw error;
        throw new DockerError(`Failed to list accessories: ${error}`);
      }
    }));
}
