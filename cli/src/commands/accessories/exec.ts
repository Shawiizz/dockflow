import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { withErrorHandler } from '../../utils/errors';
import { collectEnv, type ExecCommandOptions, planExecCommand, runExecIn } from '../app/exec';

export function registerAccessoriesExecCommand(program: Command): void {
  program
    .command('exec <env> <service> [command...]')
    .description('Execute a command in an accessory container (default: sh)')
    .option('-u, --user <user>', 'Run command as specific user')
    .option('-w, --workdir <dir>', 'Working directory inside the container (absolute)')
    .option('-e, --env <KEY=VALUE>', 'Environment variable, repeatable', collectEnv, [] as string[])
    .option('--pick', 'Interactively pick the task to run in')
    .option('-T, --no-tty', 'Never allocate a TTY')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (env: string, service: string, command: string[], options: ExecCommandOptions) => {
      const plan = planExecCommand(command, { ...options, sh: true });
      const { connection } = await resolveEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);
      await runExecIn(env, connection, stackName, service, plan, options);
    })));
}
