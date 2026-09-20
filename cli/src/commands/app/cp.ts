/**
 * `dockflow cp` (design-06 3.3, NEW): copies files between the CLI machine and a container, in
 * either direction, over the same `ContainerBackend.copyOut`/`copyIn` both orchestrators implement.
 * All planning (docker-cp semantics, the `SRC/.` contents form, path escaping on extraction) is pure
 * and lives in `services/orchestrator/copy.ts` and `utils/tar.ts`; this file only resolves the
 * target and drives the streams.
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import type { Command } from 'commander';
import type { ContainerEndpoint, LocalPathState } from '../../services/orchestrator/copy';
import { parseCopyArguments, planCopyIn, planCopyOut, probeContainerPath } from '../../services/orchestrator/copy';
import type { InstanceTarget } from '../../services/orchestrator/interfaces';
import { withServicesRequired } from '../../utils/errors';
import { formatBytes, printSuccess } from '../../utils/output';
import { extractTar, packPathToTar } from '../../utils/tar';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, pickInstance, resolveService } from '../shared/day2';

export interface CpCommandOptions {
  server?: string;
  accessories?: boolean;
  pod?: string;
  pick?: boolean;
  container?: string;
}

async function localState(path: string): Promise<LocalPathState> {
  try {
    const stat = await fs.stat(path);
    return { path, exists: true, isDirectory: stat.isDirectory() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let parentExists = true;
    try {
      await fs.stat(dirname(path));
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code === 'ENOENT') parentExists = false;
      else throw parentError;
    }
    return { path, exists: false, isDirectory: false, parentExists };
  }
}

function endpointRaw(endpoint: ContainerEndpoint): string {
  return endpoint.workload !== undefined ? `${endpoint.service}/${endpoint.workload}` : endpoint.service;
}

export async function runCp(env: string, src: string, dest: string, options: CpCommandOptions): Promise<void> {
  const request = parseCopyArguments(src, dest, process.platform);
  const ctx = await openDay2(env, { server: options.server });
  const ref = options.accessories ? ctx.accessoryRef : ctx.appRef;
  const endpoint = request.direction === 'out' ? request.source : request.destination;

  const { service: svc, workload } = await resolveService(ctx, ref, endpointRaw(endpoint), {
    allowWorkload: true,
    noun: options.accessories ? 'accessory' : 'service',
  });

  const target: InstanceTarget = {
    service: svc.name,
    ...(workload !== undefined ? { workload } : {}),
    ...(options.pod !== undefined ? { instance: options.pod } : {}),
    ...(options.container !== undefined ? { container: options.container } : {}),
  };
  if (options.pod === undefined && options.pick) target.instance = await pickInstance(ctx, ref, svc);

  if (request.direction === 'out') {
    const local = await localState(request.destination.path);
    const plan = planCopyOut(request.source, local);
    const archive = await ctx.orchestrator.containers.copyOut(ref, target, plan.remotePath);
    const result = await extractTar(archive, plan.extractDir, { renameTopEntry: plan.renameTopEntry });
    printSuccess(`Copied ${src} -> ${dest} (${result.files} file(s), ${formatBytes(result.bytes)})`);
    return;
  }

  const destination = await probeContainerPath((path) => ctx.orchestrator.containers.copyOut(ref, target, path), svc.name, request.destination.path);
  const localStat = await fs.lstat(request.source.path);
  const plan = planCopyIn({ path: request.source.path, isDirectory: localStat.isDirectory(), contents: request.source.contents }, destination);
  const archive = packPathToTar(request.source.path, plan.entryName);
  await ctx.orchestrator.containers.copyIn(ref, target, plan.destDir, archive);
  printSuccess(`Copied ${src} -> ${dest}`);
}

export function registerCpCommand(program: Command): void {
  program
    .command('cp <env> <src> <dest>')
    .description('Copy files between the local machine and a container')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('--accessories', 'Target the accessories role')
    .option('--pod <instance>', 'Instance id from `dockflow ps`')
    .option('--pick', 'Interactively pick the instance')
    .option('-c, --container <name>', 'Container of a multi-container pod (k3s)')
    .action(withServicesRequired(withResolvedEnv(runCp)));
}
