/**
 * `dockflow accessories exec` (design-06 3.2, 3.16): the same flow as the app `exec` command
 * (`commands/app/exec.ts`), scoped to the accessory role, defaulting an empty command to `/bin/sh`
 * (today's default) instead of the app command's `auto` shell detection.
 */

import type { Command } from 'commander';
import { requireCapabilityFor } from '../../services/orchestrator/capabilities';
import type { InstanceTarget, OrchestratorKind } from '../../services/orchestrator/interfaces';
import { loadConfig } from '../../utils/config';
import { ExecExitError, withServicesRequired } from '../../utils/errors';
import { printInfo } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { type ExecPlanOptions, openDay2, pickInstance, planExec, resolveService } from '../shared/day2';

export interface AccessoriesExecOptions {
  server?: string;
  user?: string;
  workdir?: string;
  env?: string[];
  pod?: string;
  pick?: boolean;
  container?: string;
  /** commander negates `--no-tty` into this flag, default true */
  tty?: boolean;
}

function collectEnv(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** the configured orchestrator kind, read locally (before `openDay2`) so `--user` is refused without probing a manager */
function configuredOrchestratorKind(): OrchestratorKind {
  return loadConfig()?.orchestrator ?? 'swarm';
}

export async function runAccessoriesExec(
  env: string,
  service: string,
  command: string[],
  options: AccessoriesExecOptions,
  getOrchestratorKind: () => OrchestratorKind = configuredOrchestratorKind,
): Promise<void> {
  if (options.user !== undefined) {
    requireCapabilityFor(getOrchestratorKind(), 'execAsUser', 'dockflow accessories exec --user');
  }

  const planOptions: ExecPlanOptions = {
    sh: true, // accessories exec defaults an empty command to `/bin/sh`, never Swarm's `auto` shell probe
    ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    env: options.env,
    ...(options.user !== undefined ? { user: options.user } : {}),
    noTty: options.tty === false,
  };
  const plan = planExec(command, planOptions, process);

  const ctx = await openDay2(env, { server: options.server });
  const ref = ctx.accessoryRef;
  const { service: svc, workload } = await resolveService(ctx, ref, service, { allowWorkload: true, noun: 'accessory' });

  const target: InstanceTarget = {
    service: svc.name,
    ...(workload !== undefined ? { workload } : {}),
    ...(options.pod !== undefined ? { instance: options.pod } : {}),
    ...(options.container !== undefined ? { container: options.container } : {}),
  };
  if (options.pod === undefined && options.pick) {
    target.instance = await pickInstance(ctx, ref, svc);
  }

  if (plan.mode === 'shell') {
    printInfo(`Connecting to ${svc.name}...`);
    await ctx.orchestrator.containers.shell(ref, target, plan.shell);
    return;
  }

  if (!plan.request.tty) printInfo(`Executing in ${svc.name}...`);
  const exitCode = await ctx.orchestrator.containers.exec(ref, target, plan.request);
  if (exitCode !== 0) throw new ExecExitError(exitCode);
}

export function registerAccessoriesExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in an accessory container (default: /bin/sh)')
    .option('-u, --user <user>', 'Run as the given user (Swarm only)')
    .option('-w, --workdir <dir>', 'Working directory inside the container')
    .option('-e, --env <KEY=VALUE>', 'Environment variable, repeatable', collectEnv, [] as string[])
    .option('--pod <instance>', 'Instance id from `dockflow ps`')
    .option('--pick', 'Interactively pick the instance')
    .option('-c, --container <name>', 'Container of a multi-container pod (k3s)')
    .option('-T, --no-tty', 'Never allocate a TTY')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withServicesRequired(
        withResolvedEnv((env: string, service: string, command: string[], options: AccessoriesExecOptions) =>
          runAccessoriesExec(env, service, command, options),
        ),
      ),
    );
}
