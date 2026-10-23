/** `dockflow details`: the stack's services, the cluster nodes and the resource usage of its containers on every node. */

import type { Command } from 'commander';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printSection, printIntro, printNote, printDebug, printRaw, printWarning, colors } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { CLIError, DockerError, withServicesRequired } from '../../utils/errors';
import { nodesOf, onEveryNode } from './nodes';

export function registerDetailsCommand(program: Command): void {
  program
    .command('details <env>')
    .description('Show stack overview and resource usage')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withServicesRequired(withResolvedEnv(async (env: string, options: { server?: string }) => {
      const { stackName, connection, serverName } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName });

      printIntro(`Stack: ${stackName}`);

      try {
        printSection('Services');
        const servicesResult = await sshExec(
          connection,
          `docker stack services ${shellQuote(stackName)} --format "table {{.Name}}\t{{.Replicas}}\t{{.Image}}"`
        );
        printRaw(servicesResult.stdout);

        printSection('Nodes');
        const nodesResult = await sshExec(connection, 'docker node ls --format "table {{.Hostname}}\t{{.Status}}\t{{.Availability}}\t{{.ManagerStatus}}"');
        printRaw(nodesResult.exitCode === 0 ? nodesResult.stdout : colors.dim(`  docker node ls failed: ${nodesResult.stderr.trim()}`));

        // every node: the stack's containers run wherever Swarm put them
        printSection('Resource Usage');
        const stats = await onEveryNode(nodesOf(env, { name: serverName, connection }), async (node) => {
          // without ids docker stats would list every container of the node
          const result = await sshExec(
            node.connection,
            `ids=$(docker ps -q --filter ${shellQuote(`label=com.docker.stack.namespace=${stackName}`)}); ` +
              `[ -z "$ids" ] || docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" $ids`,
          );
          if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
          return result.stdout.split('\n').filter((line) => line.trim());
        });
        const rows = stats.flatMap(({ node, value }) => value.map((line) => [...line.split('\t'), node.name]));
        if (rows.length === 0) {
          printWarning('No running containers');
        } else {
          const header = ['NAME', 'CPU %', 'MEM USAGE / LIMIT', 'NET I/O', 'BLOCK I/O', 'NODE'];
          const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)) + 2);
          const format = (cells: string[]) => cells.map((cell, column) => (cell ?? '').padEnd(widths[column])).join('').trimEnd();
          printRaw(colors.dim(format(header)));
          for (const row of rows) printRaw(format(row));
        }

        printNote(
          'dockflow version <env>        Deployed version info\n' +
          'dockflow ps <env>             Container details\n' +
          'dockflow list images <env>    Available images\n' +
          'dockflow logs <env>           View logs',
          'More commands'
        );
      } catch (error) {
        if (error instanceof CLIError) throw error;
        throw new DockerError(`Failed to get details: ${error instanceof Error ? error.message : String(error)}`);
      }
    })));
}
