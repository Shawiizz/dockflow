/**
 * Logs command (design-06 3.1): streams service logs through `ContainerBackend.streamLogs`, which
 * both orchestrators implement identically from this command's point of view.
 */

import type { Command } from 'commander';
import type { LogsOptions, ServiceInfo } from '../../services/orchestrator/interfaces';
import { CLIError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { printSection } from '../../utils/output';
import { selectPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { createLogPrinter, openDay2, parseTailOption, pickInstance, resolveService } from '../shared/day2';

export interface LogsCommandOptions {
  follow?: boolean;
  tail?: string;
  timestamps?: boolean;
  since?: string;
  server?: string;
  allTasks?: boolean;
  pick?: boolean;
  container?: string;
  /** commander negates `--no-prefix` into this flag, default true */
  prefix?: boolean;
}

function shouldPrefix(options: LogsCommandOptions, service: ServiceInfo | null, instance: string | undefined): boolean {
  if (options.prefix === false || instance !== undefined) return false;
  if (service === null || options.allTasks) return true;
  return service.mode === 'global' || service.replicas.desired > 1;
}

export async function runLogs(env: string, service: string | undefined, options: LogsCommandOptions): Promise<void> {
  const tail = parseTailOption(options.tail, 100);
  const ctx = await openDay2(env, { server: options.server });
  const ref = ctx.appRef;

  let svc: ServiceInfo | null = service
    ? (await resolveService(ctx, ref, service, { allowWorkload: false, pickHint: true })).service
    : null;

  let instance: string | undefined;
  if (options.pick) {
    if (!svc) {
      const services = await ctx.orchestrator.stack.getServices(ref);
      svc = services.length === 1 ? services[0] : await pickService(services);
    }
    instance = await pickInstance(ctx, ref, svc, { includeTerminated: options.allTasks });
  }

  const logOptions: LogsOptions = {
    follow: Boolean(options.follow),
    tail,
    ...(options.since !== undefined ? { since: options.since } : {}),
    timestamps: Boolean(options.timestamps),
    ...(instance !== undefined ? { instance } : {}),
    includeTerminated: Boolean(options.allTasks),
    ...(options.container !== undefined ? { container: options.container } : {}),
  };

  if (svc || options.follow) {
    const sink = createLogPrinter({ timestamps: Boolean(options.timestamps), prefix: shouldPrefix(options, svc, instance) });
    await ctx.orchestrator.containers.streamLogs(ref, svc?.name ?? null, logOptions, sink);
    return;
  }

  const services = await ctx.orchestrator.stack.getServices(ref);
  for (const s of services) {
    printSection(s.name);
    const sink = createLogPrinter({ timestamps: Boolean(options.timestamps), prefix: shouldPrefix(options, s, undefined) });
    await ctx.orchestrator.containers.streamLogs(ref, s.name, logOptions, sink);
  }
}

async function pickService(services: ServiceInfo[]): Promise<ServiceInfo> {
  if (services.length === 0) throw new CLIError('No services found', ErrorCode.STACK_NOT_FOUND);
  const name = await selectPrompt({ message: 'Pick a service:', options: services.map((s) => ({ value: s.name, label: s.name })) });
  return services.find((s) => s.name === name) ?? services[0];
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <env> [service]')
    .description('Show logs for services')
    .helpGroup('Inspect')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --tail <lines>', 'Number of lines to show (or all)', '100')
    .option('-T, --timestamps', 'Show timestamps')
    .option('--since <time>', 'Show logs since a duration, date or timestamp')
    .option('-a, --all-tasks', 'Include terminated instances and previous container runs')
    .option('--pick', 'Interactively pick which instance to follow')
    .option('-c, --container <name>', 'Container of a multi-container pod (k3s)')
    .option('--no-prefix', 'Never prefix lines with the instance label')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runLogs)));
}
