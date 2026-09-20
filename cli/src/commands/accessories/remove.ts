/**
 * `dockflow accessories remove` (design-06 3.16, D7, C13): removes the accessory role entirely.
 * Takes the deploy lock (2.8: it clears the accessories digest, and a concurrent deploy must not
 * race that) and, with `--volumes`, requires the typed confirmation of a destructive action.
 */

import type { Command } from 'commander';
import { formatReplicas } from '../../services/orchestrator/format';
import type { VolumeInfo, VolumeScope } from '../../services/orchestrator/interfaces';
import { DeployError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { colors, createSpinner, printBlank, printError, printInfo, printNote, printRaw, printWarning } from '../../utils/output';
import { confirmPrompt, dangerousConfirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { type Day2Context, openDay2 } from '../shared/day2';
import { requireAccessories } from './utils';

export interface AccessoriesRemoveOptions {
  server?: string;
  volumes?: boolean;
  yes?: boolean;
}

function volumeScope(ctx: Day2Context): VolumeScope {
  return { project: ctx.orchestrator.target.project, env: ctx.env, role: 'accessory' };
}

export async function runAccessoriesRemove(env: string, options: AccessoriesRemoveOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const ref = ctx.accessoryRef;
  const services = await requireAccessories(ctx);

  if (services.length > 0) {
    printWarning('The following services will be removed:');
    for (const service of services) printRaw(`  ${colors.info(service.name)} ${colors.dim(`(${formatReplicas(service)})`)}`);
  }

  let volumesToDelete: VolumeInfo[] = [];
  if (options.volumes) {
    volumesToDelete = await ctx.orchestrator.volumes.list(volumeScope(ctx));
    if (volumesToDelete.length > 0) {
      printBlank();
      printError('The following volumes will be PERMANENTLY DELETED:');
      for (const volume of volumesToDelete) printRaw(`  ${colors.error(volume.name)}`);
    }
  }

  printBlank();
  if (!options.yes) {
    if (options.volumes) {
      const confirmed = await dangerousConfirmPrompt({ message: `Type '${env}' to confirm removal with volumes:`, expectedText: env });
      if (!confirmed) {
        printInfo('Cancelled - text did not match');
        return;
      }
    } else {
      const confirmed = await confirmPrompt({ message: 'Are you sure you want to remove the accessories stack?', initialValue: false });
      if (!confirmed) {
        printInfo('Cancelled');
        return;
      }
    }
  }
  printBlank();

  const lock = ctx.lock();
  const acquired = await lock.acquire({ message: 'Remove accessories' });
  if (!acquired.success) {
    throw new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED, `Wait for it to finish, or release it with \`dockflow lock release ${env}\`.`);
  }

  const spinner = createSpinner();
  spinner.start('Removing accessories...');
  try {
    await ctx.orchestrator.stack.remove(ref, { volumes: options.volumes ? 'delete' : 'retain' });
    ctx.invalidate(ref);
    spinner.succeed('Accessories removed');
  } finally {
    await lock.release();
  }

  printBlank();
  if (options.volumes) {
    printInfo(`Deleted ${volumesToDelete.length} volume(s)`);
    return;
  }
  if (ctx.orchestrator.capabilities.volumes) {
    printNote(`dockflow volumes rm ${env} <name>`, `Volumes preserved — delete one with \`dockflow volumes rm ${env} <name>\`.`);
  } else {
    printNote(
      `docker volume ls --filter "label=com.docker.stack.namespace=${ctx.orchestrator.naming.scope(ref)}"\ndocker volume rm <volume_name>`,
      'Volumes preserved — remove manually',
    );
  }
}

export function registerAccessoriesRemoveCommand(program: Command): void {
  program
    .command('remove <env>')
    .alias('rm')
    .description('Remove the accessories stack entirely')
    .option('-v, --volumes', 'Also remove associated volumes (DESTRUCTIVE)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runAccessoriesRemove)));
}
