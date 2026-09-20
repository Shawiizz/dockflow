/**
 * `dockflow accessories restart` (design-06 3.12, 3.16): the same flow and resume behaviour as the
 * app `restart` command, scoped to the accessory role. `--force` is kept as a documented no-op
 * (unused on both orchestrators today). No deploy lock (2.8): it is one field/annotation a deploy
 * overwrites from config anyway.
 */

import type { Command } from 'commander';
import { CONTROL_WAIT_TIMEOUT_S } from '../../constants';
import type { ServiceInfo } from '../../services/orchestrator/interfaces';
import { withServicesRequired } from '../../utils/errors';
import { createSpinner, printInfo } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, resolveService } from '../shared/day2';
import { requireAccessories } from './utils';

export interface AccessoriesRestartOptions {
  server?: string;
  force?: boolean;
}

export async function runAccessoriesRestart(env: string, service: string | undefined, options: AccessoriesRestartOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const ref = ctx.accessoryRef;
  // a named service gets its own not-found message from resolveService; the whole-role restart has
  // no such call to fall back on, so it checks the role is deployed itself.
  if (!service) await requireAccessories(ctx);
  const svc: ServiceInfo | null = service ? (await resolveService(ctx, ref, service, { noun: 'accessory' })).service : null;
  const wasStopped = svc !== null && svc.replicas.desired === 0;

  const spinner = createSpinner();
  spinner.start(svc ? `Restarting ${svc.name}...` : 'Restarting all accessories...');
  await ctx.orchestrator.stack.restart(ref, svc?.name ?? null, { wait: true, timeoutS: CONTROL_WAIT_TIMEOUT_S });
  ctx.invalidate(ref);

  if (!svc) {
    spinner.succeed('All accessories restarted');
    return;
  }

  // read back the live count instead of assuming the resume succeeded (design-06 3.12)
  const after = (await ctx.orchestrator.stack.getServices(ref)).find((s) => s.name === svc.name);
  if (wasStopped && after && after.replicas.desired > 0) {
    spinner.succeed(`Started ${svc.name} with ${after.replicas.desired} replica(s); it was stopped`);
  } else if (after && after.replicas.desired === 0) {
    spinner.warn(`Accessory ${svc.name} has 0 replicas and was not started`);
    printInfo(`Start it with \`dockflow scale ${env} ${svc.name} <n>\`.`);
  } else {
    spinner.succeed(`Restarted ${svc.name}`);
  }
}

export function registerAccessoriesRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart accessory services')
    .option('--force', 'Force restart even if service is updating (no-op)')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runAccessoriesRestart)));
}
