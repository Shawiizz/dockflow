/**
 * `dockflow restart <env> [service]` (design-06 3.12): `rollout restart` a service (or every
 * service of the role) through `StackBackend.restart`. A target at 0 replicas is resumed instead
 * (K61), which is why the command re-reads the service afterwards rather than assuming success.
 * Deliberately no deploy lock (2.8, U-FLOW-14).
 */

import type { Command } from 'commander';
import { CONTROL_WAIT_TIMEOUT_S } from '../../constants';
import type { ControlOptions } from '../../services/orchestrator/interfaces';
import { withServicesRequired } from '../../utils/errors';
import { createSpinner, printDim, printSuccess } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, resolveService } from '../shared/day2';

export interface RestartCommandOptions {
  server?: string;
  /** commander negates `--no-wait` into this flag, default true */
  wait?: boolean;
}

export async function runRestart(env: string, service: string | undefined, options: RestartCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const svc = service ? (await resolveService(ctx, ctx.appRef, service, { accessoryCommand: 'restart' })).service : null;
  const wasStopped = svc !== null && svc.replicas.desired === 0;

  const spinner = createSpinner();
  spinner.start(svc ? `Restarting ${svc.name}...` : 'Restarting all services...');
  const control: ControlOptions = { wait: options.wait !== false, timeoutS: CONTROL_WAIT_TIMEOUT_S };
  await ctx.orchestrator.stack.restart(ctx.appRef, svc?.name ?? null, control);
  ctx.invalidate(ctx.appRef);

  if (!svc) {
    spinner.succeed('All services restarted');
    printSuccess('All services restarted');
    return;
  }

  // the backend returns void; the resumed replica count is read back rather than invented
  const after = (await ctx.orchestrator.stack.getServices(ctx.appRef)).find((s) => s.name === svc.name);
  const desired = after?.replicas.desired ?? 0;
  if (wasStopped && desired > 0) {
    spinner.succeed(`Started ${svc.name} with ${desired} replica(s); it was stopped`);
  } else if (desired === 0) {
    spinner.warn(`Service ${svc.name} has 0 replicas and was not started`);
    printDim(`  Start it with \`dockflow scale <env> ${svc.name} <n>\`.`);
  } else {
    spinner.succeed(`Restarted ${svc.name}`);
  }
}

export function registerRestartCommand(program: Command): void {
  program
    .command('restart <env> [service]')
    .description('Restart service(s)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first ready manager)')
    .option('--no-wait', 'Do not wait for the restart to complete')
    .action(withServicesRequired(withResolvedEnv(runRestart)));
}
