/** `dockflow list images`: the app's images on every node. */

import type { Command } from 'commander';
import { sshExec, sh } from '../../utils/ssh';
import { printSection, printNote, printBlank, printRaw, colors } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { loadConfig } from '../../utils/config';
import { withErrorHandler } from '../../utils/errors';
import { nodesOf, onEveryNode } from '../app/nodes';

export interface ImageRow {
  repository: string;
  tag: string;
  size: string;
  created: string;
  inUse: boolean;
}

/**
 * `docker images` and the images of the running containers, as rows; without `all`, only the
 * repositories naming the project.
 */
export function imageRows(imagesOutput: string, runningOutput: string, projectName: string, all: boolean): ImageRow[] {
  const running = new Set(runningOutput.split('\n').map((line) => line.trim()).filter(Boolean));
  return imagesOutput
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [repository = '', tag = '', size = '', created = ''] = line.split('\t');
      const ref = `${repository}:${tag}`;
      return { repository, tag, size, created, inUse: running.has(ref) || running.has(repository) };
    })
    .filter((row) => all || row.repository.includes(projectName));
}

export function registerListImagesCommand(parent: Command): void {
  parent
    .command('images <env>')
    .description('Show app images on every node')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-a, --all', 'Show all images, not just app images')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { server?: string; all?: boolean }) => {
      const { stackName, connection, serverName } = await resolveEnv(env, options.server);
      const projectName = loadConfig()?.project_name || stackName.split('-')[0];

      const perNode = await onEveryNode(nodesOf(env, { name: serverName, connection }), async (node) => {
        const [images, running] = await Promise.all([
          sshExec(node.connection, sh`docker images --format "{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"`),
          sshExec(node.connection, sh`docker ps --format "{{.Image}}"`),
        ]);
        if (images.exitCode !== 0) throw new Error(images.stderr.trim() || `exit ${images.exitCode}`);
        return imageRows(images.stdout, running.stdout, projectName, options.all === true);
      });

      printBlank();
      for (const { node, value: rows } of perNode) {
        printSection(`${options.all ? 'Images' : `Images for ${projectName}`} on ${node.name}`);
        if (rows.length === 0) {
          printRaw(colors.dim('  No images'));
          continue;
        }
        const widths = [
          Math.max(10, ...rows.map((row) => row.repository.length)) + 2,
          Math.max(3, ...rows.map((row) => row.tag.length)) + 2,
          Math.max(4, ...rows.map((row) => row.size.length)) + 2,
          Math.max(7, ...rows.map((row) => row.created.length)) + 2,
        ];
        const line = (cells: string[]) => cells.map((cell, index) => (index < widths.length ? cell.padEnd(widths[index]) : cell)).join('');
        printRaw(colors.dim(line(['REPOSITORY', 'TAG', 'SIZE', 'CREATED', 'IN USE'])));
        for (const row of rows) printRaw(line([row.repository, row.tag, row.size, row.created, row.inUse ? 'yes' : '']));
      }

      printNote('Run `dockflow prune <env>` to clean up unused images', 'Tip');
    })));
}
