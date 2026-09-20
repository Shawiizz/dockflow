/**
 * `dockflow scale <env> <service> <replicas>` (design-06 3.11): scale a compose service's replica
 * count through `StackBackend.scale`. Deliberately no deploy lock (2.8, U-FLOW-14): this is an
 * operator's emergency lever that must keep working while a deploy is stuck, and the next deploy
 * resets replicas from docker-compose.yml anyway.
 */

import type { Command } from 'commander';
import { CONTROL_WAIT_TIMEOUT_S } from '../../constants';
import type { ControlOptions } from '../../services/orchestrator/interfaces';
import { CLIError, ErrorCode, UnsupportedOperationError, withServicesRequired } from '../../utils/errors';
import { createSpinner, printInfo } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, resolveService } from '../shared/day2';

export interface ScaleCommandOptions {
  server?: string;
  /** commander negates `--no-wait` into this flag, default true */
  wait?: boolean;
}

export async function runScale(env: string, service: string, replicas: string, options: ScaleCommandOptions): Promise<void> {
  const n = parseInt(replicas, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new CLIError('Replicas must be a non-negative number', ErrorCode.INVALID_ARGUMENT);
  }

  const ctx = await openDay2(env, { server: options.server });
  const { service: svc } = await resolveService(ctx, ctx.appRef, service);

  if (svc.kind === 'helm') {
    throw new UnsupportedOperationError(
      `Helm release ${svc.name} cannot be scaled with dockflow scale`,
      'Set the replica count in its values in config.yml, then run `dockflow deploy <env>`.',
    );
  }
  if (svc.mode === 'global') {
    throw new UnsupportedOperationError(
      `Service ${svc.name} runs in global mode (one instance per node) and cannot be scaled`,
      'Change `deploy.mode` in docker-compose.yml, or use placement constraints to choose its nodes.',
    );
  }
  if (svc.mode === 'job') {
    throw new UnsupportedOperationError(`Service ${svc.name} runs as a job and cannot be scaled`, 'Run it again with `dockflow deploy <env>`.');
  }

  const control: ControlOptions = { wait: options.wait !== false, timeoutS: CONTROL_WAIT_TIMEOUT_S };
  const spinner = createSpinner();
  spinner.start(`Scaling ${svc.name} to ${n} replicas...`);
  await ctx.orchestrator.stack.scale(ctx.appRef, svc.name, n, control);
  ctx.invalidate(ctx.appRef);
  spinner.succeed(n === 0 ? `Scaled ${svc.name} to 0 replicas` : `Scaled ${svc.name} to ${n} replicas`);
  printInfo('The next deploy resets replicas to the value in docker-compose.yml');
}

export function registerScaleCommand(program: Command): void {
  program
    .command('scale <env> <service> <replicas>')
    .description('Scale service to specified replicas')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first ready manager)')
    .option('--no-wait', 'Do not wait for the scale to reach its target')
    .action(withServicesRequired(withResolvedEnv(runScale)));
}
