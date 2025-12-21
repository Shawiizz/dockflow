/**
 * List services command - Show services in a deployed stack
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printSection, printError } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

interface ServiceInfo {
  name: string;
  shortName: string;
  mode: string;
  replicas: string;
  image: string;
  ports: string;
}

interface TaskInfo {
  id: string;
  name: string;
  node: string;
  state: string;
  error: string;
}

export function registerListServicesCommand(parent: Command): void {
  parent
    .command('services <env>')
    .alias('svc')
    .description('List services in a deployed stack')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-t, --tasks', 'Show individual containers/tasks for each service')
    .option('--json', 'Output as JSON')
    .action(async (env: string, options: { server?: string; tasks?: boolean; json?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);

      try {
        // Get services for the stack
        const listCmd = `docker service ls --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.Name}}|{{.Mode}}|{{.Replicas}}|{{.Image}}|{{.Ports}}'`;
        const result = await sshExec(connection, listCmd);
        
        const lines = result.stdout.trim().split('\n').filter(Boolean);
        
        if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
          printError(`No services found for stack "${stackName}"`);
          console.log(chalk.gray('Make sure the stack is deployed with: dockflow deploy ' + env));
          process.exit(1);
        }

        const services: ServiceInfo[] = lines.map(line => {
          const [name, mode, replicas, image, ports] = line.split('|');
          return {
            name: name || '',
            shortName: name?.replace(`${stackName}_`, '') || '',
            mode: mode || 'replicated',
            replicas: replicas || '0/0',
            image: image || '',
            ports: ports || ''
          };
        });

        if (options.json) {
          console.log(JSON.stringify({ stack: stackName, services }, null, 2));
          return;
        }

        console.log('');
        printSection(`Services: ${stackName}`);
        console.log('');

        // Header
        console.log(
          chalk.gray('SERVICE'.padEnd(25)) +
          chalk.gray('REPLICAS'.padEnd(12)) +
          chalk.gray('IMAGE'.padEnd(40)) +
          chalk.gray('PORTS')
        );
        console.log(chalk.gray('─'.repeat(90)));

        for (const svc of services) {
          // Parse replicas for coloring
          const [current, desired] = svc.replicas.split('/').map(n => parseInt(n, 10));
          const replicasColor = current === desired && current > 0 
            ? chalk.green 
            : current === 0 
              ? chalk.red 
              : chalk.yellow;

          // Shorten image name
          const shortImage = svc.image.length > 38 
            ? '...' + svc.image.slice(-35) 
            : svc.image;

          console.log(
            chalk.cyan(svc.shortName.padEnd(25)) +
            replicasColor(svc.replicas.padEnd(12)) +
            chalk.white(shortImage.padEnd(40)) +
            chalk.gray(svc.ports || '-')
          );

          // Show tasks/containers if requested
          if (options.tasks) {
            const tasksCmd = `docker service ps ${svc.name} --format '{{.ID}}|{{.Name}}|{{.Node}}|{{.CurrentState}}|{{.Error}}' --no-trunc 2>/dev/null | head -10`;
            const tasksResult = await sshExec(connection, tasksCmd);
            const taskLines = tasksResult.stdout.trim().split('\n').filter(Boolean);
            
            for (const taskLine of taskLines) {
              const [id, name, node, state, error] = taskLine.split('|');
              const shortId = (id || '').substring(0, 12);
              const taskName = (name || '').replace(`${stackName}_`, '');
              
              // Color based on state
              let stateColor = chalk.gray;
              if (state?.toLowerCase().includes('running')) stateColor = chalk.green;
              else if (state?.toLowerCase().includes('failed') || error) stateColor = chalk.red;
              else if (state?.toLowerCase().includes('starting') || state?.toLowerCase().includes('preparing')) stateColor = chalk.yellow;
              
              const stateStr = state || 'unknown';
              const errorStr = error ? chalk.red(` (${error.substring(0, 30)})`) : '';
              
              console.log(
                chalk.gray('  └─ ') +
                chalk.gray(shortId.padEnd(14)) +
                chalk.white(taskName.padEnd(20)) +
                chalk.blue((node || '').padEnd(15)) +
                stateColor(stateStr) +
                errorStr
              );
            }
          }
        }

        console.log('');
        console.log(chalk.gray(`${services.length} service(s)`));
        if (!options.tasks) {
          console.log(chalk.gray('Use -t/--tasks to show individual tasks'));
        }
        console.log('');
        console.log(chalk.gray('Connect to a service:'));
        if (services.length > 0) {
          console.log(chalk.gray(`  dockflow bash ${env} ${services[0].shortName}`));
        }
      } catch (error) {
        printError(`Failed to list services: ${error}`);
        process.exit(1);
      }
    });
}
