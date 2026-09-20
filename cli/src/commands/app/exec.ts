/**
 * Exec command (design-06 3.2), also registered as the `bash` and `shell` aliases. Interactive
 * sessions go through `ContainerBackend.shell`; a given command goes through `ContainerBackend.exec`
 * and its non-zero exit becomes the core `ExecExitError`, which `withErrorHandler` passes through as
 * `process.exitCode` instead of a Dockflow error code (design-06 2.7).
 */

import type { Command } from 'commander';
import type { InstanceTarget, OrchestratorKind } from '../../services/orchestrator/interfaces';
import { requireCapabilityFor } from '../../services/orchestrator/capabilities';
import { loadConfig } from '../../utils/config';
import { ExecExitError, withServicesRequired } from '../../utils/errors';
import { printInfo } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, type ExecPlanOptions, pickInstance, planExec, resolveService } from '../shared/day2';

export interface ExecCommandOptions {
  server?: string;
  user?: string;
  workdir?: string;
  sh?: boolean;
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

export async function runExec(
  env: string,
  service: string,
  command: string[],
  options: ExecCommandOptions,
  getOrchestratorKind: () => OrchestratorKind = configuredOrchestratorKind,
): Promise<void> {
  if (options.user !== undefined) {
    requireCapabilityFor(getOrchestratorKind(), 'execAsUser', 'dockflow exec --user');
  }

  const planOptions: ExecPlanOptions = {
    sh: options.sh,
    ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    env: options.env,
    ...(options.user !== undefined ? { user: options.user } : {}),
    noTty: options.tty === false,
  };
  const plan = planExec(command, planOptions, process);

  const ctx = await openDay2(env, { server: options.server });
  const { service: svc, workload } = await resolveService(ctx, ctx.appRef, service, { allowWorkload: true });

  const target: InstanceTarget = {
    service: svc.name,
    ...(workload !== undefined ? { workload } : {}),
    ...(options.pod !== undefined ? { instance: options.pod } : {}),
    ...(options.container !== undefined ? { container: options.container } : {}),
  };
  if (options.pod === undefined && options.pick) {
    target.instance = await pickInstance(ctx, ctx.appRef, svc);
  }

  if (plan.mode === 'shell') {
    printInfo(`Connecting to ${svc.name}...`);
    await ctx.orchestrator.containers.shell(ctx.appRef, target, plan.shell);
    return;
  }

  if (!plan.request.tty) printInfo(`Executing in ${svc.name}...`);
  const exitCode = await ctx.orchestrator.containers.exec(ctx.appRef, target, plan.request);
  if (exitCode !== 0) throw new ExecExitError(exitCode);
}

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .aliases(['bash', 'shell'])
    .description('Execute a command in a container (default: interactive shell)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('-u, --user <user>', 'Run as the given user (Swarm only)')
    .option('-w, --workdir <dir>', 'Working directory inside the container')
    .option('--sh', 'Use sh for the interactive shell')
    .option('-e, --env <KEY=VALUE>', 'Environment variable, repeatable', collectEnv, [] as string[])
    .option('--pod <instance>', 'Instance id from `dockflow ps`')
    .option('--pick', 'Interactively pick the instance')
    .option('-c, --container <name>', 'Container of a multi-container pod (k3s)')
    .option('-T, --no-tty', 'Never allocate a TTY')
    .action(
      withServicesRequired(
        withResolvedEnv((env: string, service: string, command: string[], options: ExecCommandOptions) => runExec(env, service, command, options)),
      ),
    );
}
