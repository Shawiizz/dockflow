/**
 * `dockflow rollback <env> [service]` (design-06 3.13): a full-stack rollback through
 * `services/release.ts` `rollbackRelease`, or a single service through `StackBackend.rollbackService`.
 * Both forms take the deploy lock (2.8, U-FLOW-14, design-03 I-16): a rollback re-applies a whole
 * release (or one service's closure) and must not interleave with a running deploy.
 */

import type { Command } from 'commander';
import { CONTROL_WAIT_TIMEOUT_S } from '../../constants';
import { Audit } from '../../services/audit';
import { Metrics } from '../../services/metrics';
import * as Notification from '../../services/notification';
import { rollbackRelease } from '../../services/release';
import { getPerformer } from '../../utils/config';
import { CLIError, DeployError, ErrorCode, UnsupportedOperationError, withErrorHandler } from '../../utils/errors';
import { createSpinner, printSuccess } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { runPostRollbackHealthChecks } from '../deploy-phases';
import { type Day2Context, openDay2, resolveService } from '../shared/day2';
import { withLock } from '../shared/lock';

export interface RollbackCommandOptions {
  server?: string;
  allowChartDrift?: boolean;
}

/** Audit entry, deployment metric and webhook, best-effort (today's behaviour, unchanged). */
async function recordRollback(ctx: Day2Context, params: { version: string; message: string; startTime: number }): Promise<void> {
  const connection = ctx.orchestrator.target.controlPlane.connection;
  const audit = new Audit(connection);
  const metrics = new Metrics(connection);
  const durationMs = Date.now() - params.startTime;
  await Promise.allSettled([
    audit.writeEntry(ctx.stackName, 'rolled_back', params.message, params.version),
    metrics.writeDeployment({
      stackName: ctx.stackName,
      version: params.version,
      env: ctx.env,
      branch: '',
      status: 'rolled_back',
      durationMs,
      performer: getPerformer(),
      buildSkipped: true,
      accessoriesDeployed: false,
      nodeCount: 1,
    }),
    Notification.notify(ctx.config.notifications?.webhooks, {
      project: ctx.config.project_name,
      env: ctx.env,
      version: params.version,
      branch: '',
      performer: getPerformer(),
      status: 'success',
      duration_ms: durationMs,
      message: params.message,
    }),
  ]);
}

/** The deploy lock around a rollback (design-06 2.8); Ctrl+C lets the re-apply finish, then releases it. */
function withRollbackLock<T>(ctx: Day2Context, message: string, version: string | undefined, action: () => Promise<T>): Promise<T> {
  return withLock(ctx.lock(), version !== undefined ? { message, version } : { message }, () => action());
}

async function rollbackFullStack(ctx: Day2Context, options: RollbackCommandOptions): Promise<void> {
  const startTime = Date.now();
  // design-03 16.1: rollbackRelease, then the post-rollback HTTP health checks (design-06 3.13,
  // best-effort, forced to `notify`), then audit/metrics/notification, all before the lock releases.
  const target = await withRollbackLock(ctx, 'Rollback', 'rollback', async () => {
    const version = await rollbackRelease(ctx.orchestrator, {
      ref: ctx.appRef,
      stackName: ctx.stackName,
      to: null,
      failedVersion: null,
      wait: { timeoutS: CONTROL_WAIT_TIMEOUT_S, intervalS: 5 },
      ...(options.allowChartDrift ? { allowChartDrift: true } : {}),
    });
    await runPostRollbackHealthChecks(ctx.config, ctx.orchestrator);
    await recordRollback(ctx, { version, message: `Rolled back ${ctx.stackName} to ${version}`, startTime });
    return version;
  });
  printSuccess(`Rolled back to ${target}`);
}

/** An accessory has no release history (R-12); the defensive backend re-check is never reached from here. */
async function assertNotAccessory(ctx: Day2Context, name: string): Promise<void> {
  const accessory = await resolveService(ctx, ctx.accessoryRef, name).catch(() => null);
  if (accessory) {
    throw new UnsupportedOperationError(
      `Service ${accessory.service.name} is an accessory; accessories have no release history`,
      'Change accessories.yml and run `dockflow deploy <env> --accessories`.',
    );
  }
}

async function rollbackOneService(ctx: Day2Context, name: string): Promise<void> {
  let svc: { name: string };
  try {
    svc = (await resolveService(ctx, ctx.appRef, name)).service;
  } catch (error) {
    if (error instanceof CLIError && error.code === ErrorCode.SERVICE_NOT_FOUND) await assertNotAccessory(ctx, name);
    throw error;
  }

  const startTime = Date.now();
  const spinner = createSpinner();
  // design-06 3.13: audit/metrics/notify happen before the lock releases, same as the full rollback.
  await withRollbackLock(ctx, `Rollback ${svc.name}`, undefined, async () => {
    spinner.start(`Rolling back ${svc.name}...`);
    const result = await ctx.orchestrator.stack.rollbackService(ctx.appRef, svc.name, { wait: true, timeoutS: CONTROL_WAIT_TIMEOUT_S });
    ctx.invalidate(ctx.appRef);
    const message = result.toVersion
      ? `Rolled back ${svc.name} to its definition in release ${result.toVersion}`
      : `Rolled back ${svc.name} to its previous definition`;
    spinner.succeed(message);
    await recordRollback(ctx, {
      version: 'service-rollback',
      message: result.toVersion ? `Rolled back service ${svc.name} to release ${result.toVersion}` : `Rolled back service ${svc.name} in ${ctx.stackName}`,
      startTime,
    });
  });
}

export async function runRollback(env: string, service: string | undefined, options: RollbackCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });

  if (ctx.config.no_services) {
    throw new DeployError(
      'Rollback is not supported for upload-only projects',
      ErrorCode.ROLLBACK_FAILED,
      'To restore a previous version, re-deploy from the corresponding git commit.',
    );
  }

  if (service) {
    await rollbackOneService(ctx, service);
    return;
  }
  await rollbackFullStack(ctx, options);
}

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <env> [service]')
    .description('Rollback to previous version')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target server (defaults to first ready manager)')
    .option('--allow-chart-drift', 'Reinstall a Helm release even when its chart bytes changed upstream (full rollback only)')
    .action(withErrorHandler(withResolvedEnv(runRollback)));
}
