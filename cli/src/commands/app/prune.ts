/**
 * Prune command - Remove unused Docker resources on every node of the environment
 */

import type { Command } from 'commander';
import { sshExec, sh, type ShellCommand } from '../../utils/ssh';
import { printIntro, printOutro, printInfo, printSection, printWarning, printDebug, printBlank, printRaw, printSuccess, createSpinner } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { DockerError, withServicesRequired } from '../../utils/errors';
import { confirmPrompt } from '../../utils/prompts';
import { type NodeRef, nodesOf } from './nodes';

type PruneTarget = 'containers' | 'images' | 'volumes' | 'networks';

const PRUNE_COMMANDS: Record<PruneTarget, (all: boolean) => ShellCommand> = {
  containers: () => sh`docker container prune -f`,
  images: (all) => (all ? sh`docker image prune -f -a` : sh`docker image prune -f`),
  volumes: () => sh`docker volume prune -f`,
  networks: () => sh`docker network prune -f`,
};

/** What each target reclaimed on `node`; a failed prune throws, it must not read as a success. */
async function pruneNode(node: NodeRef, targets: readonly PruneTarget[], all: boolean): Promise<string[]> {
  const done: string[] = [];
  for (const target of targets) {
    const result = await sshExec(node.connection, PRUNE_COMMANDS[target](all));
    if (result.exitCode !== 0) {
      throw new Error(`${target} prune failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const reclaimed = result.stdout.match(/Total reclaimed space: (.+)/)?.[1];
    done.push(reclaimed ? `${target} (${reclaimed})` : target);
  }
  return done;
}

export function registerPruneCommand(program: Command): void {
  program
    .command('prune <env>')
    .description('Remove unused Docker resources (images, containers, volumes, networks) on every node')
    .helpGroup('Operate')
    .option('-a, --all', 'Remove all unused images, not just dangling ones')
    .option('--images', 'Prune images only')
    .option('--containers', 'Prune containers only')
    .option('--volumes', 'Prune volumes only')
    .option('--networks', 'Prune networks only')
    .option('-y, --yes', 'Skip confirmation')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withServicesRequired(withResolvedEnv(async (env: string, options: {
      all?: boolean;
      images?: boolean;
      containers?: boolean;
      volumes?: boolean;
      networks?: boolean;
      yes?: boolean;
      server?: string;
    }) => {
      const pruneAll = !options.images && !options.containers && !options.volumes && !options.networks;
      const targets = (['containers', 'images', 'volumes', 'networks'] as const).filter((target) => pruneAll || options[target]);

      // the nodes are listed before anything connects: the confirmation names them
      const { connection, serverName } = await resolveEnv(env, options.server);
      const nodes = nodesOf(env, { name: serverName, connection });
      printDebug('Prune targets', { targets, nodes: nodes.map((node) => node.name) });

      printIntro(`Prune Docker Resources on ${env}`);
      printInfo(`Targets: ${targets.join(', ')}`);
      printInfo(`Nodes: ${nodes.map((node) => node.name).join(', ')}`);
      printBlank();

      if (!options.yes) {
        printWarning('This will permanently remove unused Docker resources on every node.');
        if (targets.includes('volumes')) {
          printWarning('WARNING: Pruning volumes will delete data that is not attached to containers!');
        }

        const confirmed = await confirmPrompt({
          message: 'Are you sure you want to continue?',
          initialValue: false,
        });

        if (!confirmed) {
          printInfo('Cancelled');
          return;
        }
        printBlank();
      }

      const spinner = createSpinner();
      spinner.start(`Pruning on ${nodes.length} node(s)...`);
      const outcomes = await Promise.allSettled(nodes.map((node) => pruneNode(node, targets, options.all === true)));
      spinner.stop();

      const failed: string[] = [];
      outcomes.forEach((outcome, index) => {
        const node = nodes[index].name;
        if (outcome.status === 'fulfilled') printSuccess(`${node}: pruned ${outcome.value.join(', ')}`);
        else failed.push(`${node}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      });
      if (failed.length > 0) {
        throw new DockerError(`Prune failed on ${failed.length} of ${nodes.length} node(s):\n  ${failed.join('\n  ')}`);
      }

      printBlank();
      printOutro('Docker resources cleaned up successfully');

      printSection('Current Disk Usage');
      for (const node of nodes) {
        const df = await sshExec(node.connection, sh`docker system df`);
        printRaw(`${node.name}\n${df.stdout}`);
      }
    })));
}
