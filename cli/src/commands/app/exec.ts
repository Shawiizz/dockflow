/**
 * Exec command, also registered as `bash` and `shell`: an interactive shell, or a command whose
 * output streams back and whose exit code becomes the CLI's.
 */

import type { Command } from 'commander';
import type { SSHKeyConnection } from '../../types';
import { printInfo } from '../../utils/output';
import { resolveEnv, getAllNodeConnections, withResolvedEnv } from '../../utils/validation';
import { createContainerBackend } from '../../services/orchestrator/factory';
import { ExecExitError, withServicesRequired } from '../../utils/errors';
import { type ExecPlan, planExec } from '../../utils/exec-plan';
import { pickSwarmTask } from './pick';
import { requireAppService } from './service-name';

export interface ExecCommandOptions {
  server?: string;
  user?: string;
  workdir?: string;
  sh?: boolean;
  env?: string[];
  pick?: boolean;
  /** commander turns `--no-tty` into `tty: false` */
  tty?: boolean;
}

export function collectEnv(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** The plan of `command`, checked before anything reaches a server. */
export function planExecCommand(command: string[], options: ExecCommandOptions): ExecPlan {
  return planExec(command, {
    sh: options.sh,
    workdir: options.workdir,
    env: options.env,
    user: options.user,
    noTty: options.tty === false,
  }, process);
}

/** Runs the plan in `service` of `stackName`; app and accessories share it. */
export async function runExecIn(
  env: string,
  connection: SSHKeyConnection,
  stackName: string,
  service: string,
  plan: ExecPlan,
  options: Pick<ExecCommandOptions, 'pick'>,
): Promise<void> {
  const containers = createContainerBackend(connection, getAllNodeConnections(env));
  const taskId = options.pick ? await pickSwarmTask(stackName, service, connection) : undefined;

  if (plan.mode === 'shell') {
    printInfo(`Connecting to ${service}...`);
    await containers.shell(stackName, service, plan.shell, taskId);
    return;
  }

  if (!plan.request.tty) printInfo(`Executing in ${service}...`);
  const exitCode = await containers.run(stackName, service, plan.request, taskId);
  if (exitCode !== 0) throw new ExecExitError(exitCode);
}

export function registerExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .aliases(['bash', 'shell'])
    .description('Execute a command in a container (default: interactive shell)')
    .helpGroup('Operate')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-u, --user <user>', 'Run as specified user')
    .option('-w, --workdir <dir>', 'Working directory inside the container (absolute)')
    .option('--sh', 'Use sh instead of bash for interactive shell')
    .option('-e, --env <KEY=VALUE>', 'Environment variable, repeatable', collectEnv, [] as string[])
    .option('--pick', 'Interactively pick the task to run in')
    .option('-T, --no-tty', 'Never allocate a TTY')
    .action(withServicesRequired(withResolvedEnv(async (env: string, service: string, command: string[], options: ExecCommandOptions) => {
      const plan = planExecCommand(command, options);
      const { stackName, connection } = await resolveEnv(env, options.server);
      await requireAppService(connection, env, stackName, service, 'exec');
      await runExecIn(env, connection, stackName, service, plan, options);
    })));
}
