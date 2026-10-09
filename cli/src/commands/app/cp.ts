/**
 * `dockflow cp`: copies files between the CLI machine and a container, in either direction, as a
 * tar stream through `docker cp` on the node running it. The planning (docker cp semantics, the
 * `SRC/.` contents form) lives in `services/orchestrator/copy.ts`, the archive safety in
 * `utils/tar.ts`; this file resolves the target and drives the streams.
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import type { Command } from 'commander';
import { createContainerBackend } from '../../services/orchestrator/factory';
import type { LocalPathState } from '../../services/orchestrator/copy';
import { parseCopyArguments, planCopyIn, planCopyOut, probeContainerPath } from '../../services/orchestrator/copy';
import { ValidationError, withServicesRequired } from '../../utils/errors';
import { formatBytes, printSuccess } from '../../utils/output';
import { extractTar, packPathToTar } from '../../utils/tar';
import { getAllNodeConnections, resolveEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack, requireAccessoryService } from '../accessories/utils';
import { pickSwarmTask } from './pick';
import { requireAppService } from './service-name';

export interface CpCommandOptions {
  server?: string;
  accessories?: boolean;
  pick?: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function localState(path: string): Promise<LocalPathState> {
  try {
    const stat = await fs.stat(path);
    return { path, exists: true, isDirectory: stat.isDirectory() };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await fs.stat(dirname(path));
    return { path, exists: false, isDirectory: false, parentExists: true };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { path, exists: false, isDirectory: false, parentExists: false };
  }
}

async function localSource(path: string): Promise<{ isDirectory: boolean }> {
  try {
    return { isDirectory: (await fs.lstat(path)).isDirectory() };
  } catch (error) {
    if (isMissing(error)) throw new ValidationError(`${path} does not exist`);
    throw error;
  }
}

export async function runCp(env: string, src: string, dest: string, options: CpCommandOptions): Promise<void> {
  const request = parseCopyArguments(src, dest, process.platform);
  const { stackName: appStack, connection } = await resolveEnv(env, options.server);
  const { service } = request.direction === 'out' ? request.source : request.destination;

  let stackName = appStack;
  if (options.accessories) {
    stackName = (await requireAccessoriesStack(connection, env)).stackName;
    await requireAccessoryService(connection, stackName, service);
  } else {
    await requireAppService(connection, env, stackName, service, 'cp');
  }

  const containers = createContainerBackend(connection, getAllNodeConnections(env));
  const taskId = options.pick ? await pickSwarmTask(stackName, service, connection) : undefined;

  if (request.direction === 'out') {
    const plan = planCopyOut(request.source, await localState(request.destination.path));
    const archive = await containers.copyOut(stackName, service, plan.remotePath, taskId);
    const result = await extractTar(archive, plan.extractDir, { renameTopEntry: plan.renameTopEntry });
    printSuccess(`Copied ${src} -> ${dest} (${result.files} file(s), ${formatBytes(result.bytes)})`);
    return;
  }

  const local = { path: request.source.path, contents: request.source.contents, ...(await localSource(request.source.path)) };
  const destination = await probeContainerPath(
    (path) => containers.copyOut(stackName, service, path, taskId),
    service,
    request.destination.path,
  );
  const plan = planCopyIn(local, destination);
  await containers.copyIn(stackName, service, plan.destDir, packPathToTar(local.path, plan.entryName), taskId);
  printSuccess(`Copied ${src} -> ${dest}`);
}

export function registerCpCommand(program: Command): void {
  program
    .command('cp <env> <src> <dest>')
    .description('Copy files between the local machine and a container (<service>:<path> on one side)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('--accessories', 'Copy in an accessory instead of the app')
    .option('--pick', 'Interactively pick the task to copy in')
    .action(withServicesRequired(withResolvedEnv(runCp)));
}
