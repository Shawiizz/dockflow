import type { Command } from 'commander';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { requireAccessoriesStack } from './utils';
import { withErrorHandler } from '../../utils/errors';
import { type LogsCommandOptions, showLogs } from '../app/logs';

export function registerAccessoriesLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('View logs for accessories')
    .option('-f, --follow', 'Follow log output (every accessory when none is named)')
    .option('-n, --tail <lines>', 'Number of lines to show, or all', '100')
    .option('--since <time>', 'Show logs since a duration (30m, 2d), a date or a timestamp')
    .option('--timestamps', 'Show timestamps')
    .option('-a, --all-tasks', 'Include logs from terminated/historical task replicas')
    .option('--pick', 'Interactively pick which task replica to show')
    .option('--no-prefix', 'Do not prefix lines with their instance')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (env: string, service: string | undefined, options: LogsCommandOptions) => {
      const { connection } = await resolveEnv(env, options.server);
      const { stackName } = await requireAccessoriesStack(connection, env);
      await showLogs(env, connection, stackName, service, options);
    })));
}
