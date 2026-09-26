/**
 * `dockflow stop <env>` (design-06 3.14): remove the app role's workloads while keeping volumes,
 * accessories and release history. Takes the deploy lock (2.8, U-FLOW-14): it deletes the objects a
 * deploy is applying, and a half-deployed stack would otherwise be left behind.
 */

import type { Command } from 'commander';
import { withServicesRequired } from '../../utils/errors';
import { createSpinner, printBlank, printInfo, printNote, printWarning } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';
import { withLock } from '../shared/lock';

export interface StopCommandOptions {
  yes?: boolean;
  server?: string;
}

function volumeLine(volume: { name: string; capacity: string | null; node: string | null; reclaimPolicy: string | null }): string {
  return `${volume.name} (${volume.capacity ?? 'unknown size'}, node ${volume.node ?? 'unknown'}, reclaim ${volume.reclaimPolicy ?? 'unknown'})`;
}

export async function runStop(env: string, options: StopCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });

  if (!options.yes) {
    printWarning(`This will remove all services in ${ctx.orchestrator.naming.describe(ctx.appRef)}`);
    if (ctx.orchestrator.capabilities.volumes) {
      printInfo('Accessories, volumes and release history are kept');
    }
    const confirmed = await confirmPrompt({ message: 'Are you sure?', initialValue: false });
    if (!confirmed) {
      printInfo('Cancelled');
      return;
    }
  }

  const spinner = createSpinner();
  await withLock(ctx.lock(), { message: 'Stop' }, async (signal) => {
    spinner.start(`Stopping stack ${ctx.stackName}...`);
    await ctx.orchestrator.stack.remove(ctx.appRef, { volumes: 'retain', signal });
  });
  ctx.invalidate(ctx.appRef);
  spinner.succeed(`Stack ${ctx.stackName} stopped`);

  if (ctx.orchestrator.capabilities.volumes) {
    const kept = await ctx.orchestrator.volumes.list({ project: ctx.orchestrator.target.project, env: ctx.orchestrator.target.env, role: 'app' });
    if (kept.length > 0) {
      printBlank();
      printNote(kept.map(volumeLine).join('\n'), `Volumes kept — delete one with \`dockflow volumes rm ${env} <name>\``);
    }
  }
}

export function registerStopCommand(program: Command): void {
  program
    .command('stop <env>')
    .description('Stop and remove the stack')
    .helpGroup('Operate')
    .option('-y, --yes', 'Skip confirmation')
    .option('-s, --server <name>', 'Target server (defaults to first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runStop)));
}
