/**
 * App commands - Interact with deployed services
 * These commands use SSH directly (no Ansible/Docker needed locally)
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec, sshExecStream, sshShell } from '../utils/ssh';
import { printError, printSuccess, printInfo, printSection, printHeader, printWarning } from '../utils/output';
import { validateEnvOrExit } from '../utils/validation';

/**
 * Register all app commands
 */
export function registerAppCommands(program: Command): void {
  // logs command
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .action(async (env: string, service: string | undefined, options: { follow?: boolean; tail?: string }) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      printInfo(`Fetching logs for stack: ${stackName}`);
      console.log('');

      try {
        const tailFlag = `--tail ${options.tail || 100}`;
        const followFlag = options.follow ? '-f' : '';

        if (service) {
          // Logs for specific service
          const cmd = `docker service logs ${followFlag} ${tailFlag} ${stackName}_${service} 2>&1`;
          await sshExecStream(connection, cmd);
        } else {
          // Get all services
          const servicesResult = await sshExec(connection, `docker stack services ${stackName} --format '{{.Name}}'`);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          if (services.length === 0) {
            printError(`No services found for stack ${stackName}`);
            process.exit(1);
          }

          if (options.follow) {
            // Follow mode - only first service
            printInfo(`Following logs for ${services[0]} (use service name to follow specific service)`);
            const cmd = `docker service logs -f ${tailFlag} ${services[0]} 2>&1`;
            await sshExecStream(connection, cmd);
          } else {
            // Show recent logs from all services
            for (const svc of services) {
              printSection(svc);
              const cmd = `docker service logs ${tailFlag} ${svc} 2>&1`;
              await sshExecStream(connection, cmd);
            }
          }
        }
      } catch (error) {
        printError(`Failed to fetch logs: ${error}`);
        process.exit(1);
      }
    });

  // exec command
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in a container (default: bash)')
    .action(async (env: string, service: string, command: string[]) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      const cmd = command.length > 0 ? command.join(' ') : 'bash';
      printInfo(`Connecting to ${stackName}_${service}...`);

      try {
        // Find container
        const findCmd = `docker ps --filter "label=com.docker.swarm.service.name=${stackName}_${service}" --format '{{.ID}}' | head -n1`;
        const containerResult = await sshExec(connection, findCmd);
        const containerId = containerResult.stdout.trim();

        if (!containerId) {
          printError(`No running container found for service ${service}`);
          process.exit(1);
        }

        // For interactive commands, we need a different approach
        if (cmd === 'bash' || cmd === 'sh') {
          // Open interactive shell via SSH
          const shellCmd = `docker exec -it ${containerId} ${cmd}`;
          await sshExecStream(connection, shellCmd);
        } else {
          const execCmd = `docker exec ${containerId} ${cmd}`;
          const result = sshExec(connection, execCmd);
          process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          process.exit(result.exitCode);
        }
      } catch (error) {
        printError(`Failed to exec: ${error}`);
        process.exit(1);
      }
    });

  // restart command
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .action(async (env: string, service?: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Restarting ${stackName}_${service}...`);
          await sshExec(connection, `docker service update --force ${stackName}_${service}`);
          spinner.succeed(`Restarted ${stackName}_${service}`);
        } else {
          // Get all services
          const servicesResult = await sshExec(connection, `docker stack services ${stackName} --format '{{.Name}}'`);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          for (const svc of services) {
            spinner.start(`Restarting ${svc}...`);
            await sshExec(connection, `docker service update --force ${svc}`);
            spinner.succeed(`Restarted ${svc}`);
          }
          printSuccess('All services restarted');
        }
      } catch (error) {
        spinner.fail(`Failed to restart: ${error}`);
        process.exit(1);
      }
    });

  // stop command
  program
    .command('stop <env>')
    .description('Stop and remove the stack')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (env: string, options: { yes?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      if (!options.yes) {
        printWarning(`This will remove all services in stack: ${stackName}`);
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        
        const answer = await new Promise<string>((resolve) => {
          rl.question('Are you sure? (y/N) ', resolve);
        });
        rl.close();
        
        if (answer.toLowerCase() !== 'y') {
          printInfo('Cancelled');
          return;
        }
      }

      const spinner = ora(`Stopping stack ${stackName}...`).start();

      try {
        await sshExec(connection, `docker stack rm ${stackName}`);
        spinner.succeed(`Stack ${stackName} stopped`);
      } catch (error) {
        spinner.fail(`Failed to stop: ${error}`);
        process.exit(1);
      }
    });

  // details command
  program
    .command('details <env>')
    .description('Show stack details and resource usage')
    .action(async (env: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      printHeader(`Stack: ${stackName}`);

      try {
        printSection('Services');
        const servicesResult = await sshExec(connection, `docker stack services ${stackName}`);
        console.log(servicesResult.stdout);

        printSection('Tasks');
        const tasksResult = await sshExec(connection, `docker stack ps ${stackName} --no-trunc`);
        console.log(tasksResult.stdout);

        printSection('Resource Usage');
        const containerIds = await sshExec(
          connection,
          `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.ID}}' | tr '\\n' ' '`
        );
        
        if (containerIds.stdout.trim()) {
          const statsResult = await sshExec(connection, `docker stats --no-stream ${containerIds.stdout.trim()}`);
          console.log(statsResult.stdout);
        } else {
          console.log('No running containers');
        }
      } catch (error) {
        printError(`Failed to get details: ${error}`);
        process.exit(1);
      }
    });

  // ssh command
  program
    .command('ssh <env>')
    .description('Open SSH session to server')
    .action(async (env: string) => {
      const { connection } = await validateEnvOrExit(env);
      
      printInfo(`Connecting to ${env} server...`);
      console.log('');

      try {
        await sshShell(connection);
      } catch (error) {
        printError(`SSH connection failed: ${error}`);
        process.exit(1);
      }
    });

  // scale command
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .action(async (env: string, service: string, replicas: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      const spinner = ora(`Scaling ${stackName}_${service} to ${replicas} replicas...`).start();

      try {
        await sshExec(connection, `docker service scale ${stackName}_${service}=${replicas}`);
        spinner.succeed(`Scaled ${stackName}_${service} to ${replicas} replicas`);
      } catch (error) {
        spinner.fail(`Failed to scale: ${error}`);
        process.exit(1);
      }
    });

  // rollback command
  program
    .command('rollback <env> [service]')
    .description('Rollback to previous version')
    .action(async (env: string, service?: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      const spinner = ora();

      try {
        if (service) {
          spinner.start(`Rolling back ${stackName}_${service}...`);
          const result = sshExec(connection, `docker service rollback ${stackName}_${service}`);
          if (result.exitCode === 0) {
            spinner.succeed(`Rolled back ${stackName}_${service}`);
          } else {
            spinner.warn(`Rollback may have failed: ${result.stderr}`);
          }
        } else {
          // Get all services
          const servicesResult = await sshExec(connection, `docker stack services ${stackName} --format '{{.Name}}'`);
          const services = servicesResult.stdout.trim().split('\n').filter(Boolean);

          for (const svc of services) {
            spinner.start(`Rolling back ${svc}...`);
            const result = sshExec(connection, `docker service rollback ${svc}`);
            if (result.exitCode === 0) {
              spinner.succeed(`Rolled back ${svc}`);
            } else {
              spinner.warn(`${svc}: ${result.stderr.trim() || 'may have failed'}`);
            }
          }
          printSuccess('Rollback complete');
        }
      } catch (error) {
        spinner.fail(`Failed to rollback: ${error}`);
        process.exit(1);
      }
    });

  // ps command
  program
    .command('ps <env>')
    .description('List running containers')
    .action(async (env: string) => {
      const { stackName, connection } = await validateEnvOrExit(env);
      
      printInfo(`Containers for stack: ${stackName}`);
      console.log('');

      try {
        const result = await sshExec(
          connection,
          `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format 'table {{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Ports}}'`
        );
        console.log(result.stdout);
      } catch (error) {
        printError(`Failed to list containers: ${error}`);
        process.exit(1);
      }
    });
}

