/**
 * Logs command - View service logs
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SSHKeyConnection } from '../../types';
import type { LogSource } from '../../services/orchestrator/interfaces';
import { printInfo, printSection, printDebug, printBlank, printRaw } from '../../utils/output';
import { resolveEnv, getAllNodeConnections, withResolvedEnv } from '../../utils/validation';
import { createContainerBackend, createStackBackend } from '../../services/orchestrator/factory';
import { DockerError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { parseTailOption } from '../../utils/log-options';
import { pickService, pickSwarmTask } from './pick';
import { requireAppService } from './service-name';

export interface LogsCommandOptions {
  follow?: boolean;
  tail?: string;
  timestamps?: boolean;
  since?: string;
  server?: string;
  allTasks?: boolean;
  pick?: boolean;
  /** commander turns `--no-prefix` into `prefix: false` */
  prefix?: boolean;
}

const PREFIX_COLORS = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blue];

/**
 * Prints lines as they come, prefixed with their instance (`web.2 |`) once several instances or
 * services share the output, in a colour stable for the instance.
 */
export function createLogPrinter(options: { prefix: boolean; services: number }, write: (text: string) => void = printRaw) {
  const colorOf = new Map<string, (text: string) => string>();
  let width = 0;
  return (line: string, source: LogSource): void => {
    if (!options.prefix || (options.services < 2 && source.instances < 2)) {
      write(line);
      return;
    }
    let color = colorOf.get(source.instance);
    if (!color) {
      color = PREFIX_COLORS[colorOf.size % PREFIX_COLORS.length];
      colorOf.set(source.instance, color);
    }
    width = Math.max(width, source.instance.length);
    write(`${color(`${source.instance.padEnd(width)} |`)} ${line}`);
  };
}

/** Logs of one service, or of every service of the stack: followed together, or one section each. */
export async function showLogs(
  env: string,
  connection: SSHKeyConnection,
  stackName: string,
  service: string | undefined,
  options: LogsCommandOptions,
): Promise<void> {
  // every node: a service's tasks may all run on workers
  const logsBackend = createContainerBackend(connection, getAllNodeConnections(env));

  let taskId: string | undefined;
  if (options.pick) {
    service ??= await pickService(connection, stackName);
    taskId = await pickSwarmTask(stackName, service, connection);
  }

  const logOptions = {
    tail: parseTailOption(options.tail, 100),
    follow: options.follow ?? false,
    timestamps: options.timestamps,
    since: options.since,
    allTasks: options.allTasks,
    taskId,
  };
  const fail = (err: Error) => { throw err; };

  const services = service ? [service] : (await createStackBackend(connection).getServices(stackName)).map((s) => s.name);
  if (services.length === 0) throw new DockerError(`No services found for stack ${stackName}`, { code: ErrorCode.STACK_NOT_FOUND });

  try {
    if (options.follow || services.length === 1) {
      const print = createLogPrinter({ prefix: options.prefix !== false, services: services.length });
      await Promise.all(services.map((name) => logsBackend.streamLogs(stackName, name, logOptions, print, fail)));
      return;
    }
    for (const name of services) {
      printSection(name);
      await logsBackend.streamLogs(stackName, name, logOptions, createLogPrinter({ prefix: options.prefix !== false, services: 1 }), fail);
    }
  } catch (error) {
    if (error instanceof DockerError) throw error;
    throw new DockerError(`Failed to fetch logs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .helpGroup('Inspect')
    .option('-f, --follow', 'Follow log output (every service when none is named)')
    .option('-n, --tail <lines>', 'Number of lines to show, or all', '100')
    .option('-T, --timestamps', 'Show timestamps')
    .option('--since <time>', 'Show logs since a duration (30m, 2d), a date or a timestamp')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .option('-a, --all-tasks', 'Include logs from terminated/historical task replicas')
    .option('--pick', 'Interactively pick which task replica to show')
    .option('--no-prefix', 'Do not prefix lines with their instance')
    .action(withServicesRequired(withResolvedEnv(async (env: string, service: string | undefined, options: LogsCommandOptions) => {
      const { stackName, connection, serverName } = await resolveEnv(env, options.server);
      printDebug('Connection validated', { stackName, serverName });
      printInfo(`Server: ${serverName}`);
      printInfo(`Fetching logs for stack: ${stackName}`);
      printBlank();
      if (service) await requireAppService(connection, env, stackName, service, 'logs');
      await showLogs(env, connection, stackName, service, options);
    })));
}
