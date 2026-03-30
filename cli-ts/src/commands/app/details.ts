/**
 * Details command - Show stack overview and resource usage
 * For specific info, use: containers, images, version
 */

import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import { printSection, printIntro, printNote, printDebug, printRaw, printWarning, printBlank } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { DockerError, withErrorHandler } from '../../utils/errors';

export function registerDetailsCommand(program: Command): void {
  program
    .command('details <env>')
    .description('Show stack overview and resource usage')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(async (env: string, options: { server?: string }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName });
      
      printIntro(`Stack: ${stackName}`);

      try {
        // Services summary (compact)
        printSection('Services');
        const servicesResult = await sshExec(
          connection, 
          `docker stack services ${stackName} --format "table {{.Name}}\t{{.Replicas}}\t{{.Image}}"`
        );
        printRaw(servicesResult.stdout);

        // Resource usage
        printSection('Resource Usage');
        const containerIds = await sshExec(
          connection,
          `docker ps --filter "label=com.docker.stack.namespace=${stackName}" --format '{{.ID}}' | tr '\\n' ' '`
        );

        if (containerIds.stdout.trim()) {
          const statsResult = await sshExec(
            connection,
            `docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" ${containerIds.stdout.trim()}`
          );
          printRaw(statsResult.stdout);
        } else {
          printWarning('No running containers');
        }

        // Quick tips
        printNote(
          'dockflow version <env>        Deployed version info\n' +
          'dockflow ps <env>             Container details\n' +
          'dockflow list images <env>    Available images\n' +
          'dockflow logs <env>           View logs',
          'More commands'
        );
      } catch (error) {
        throw new DockerError(`Failed to get details: ${error}`);
      }
    }));
}
