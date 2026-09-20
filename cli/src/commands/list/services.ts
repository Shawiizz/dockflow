/**
 * `dockflow list services` (design-06 3.5, alias `svc`): the app-role listing, over the same
 * `StackBackend.getServices`/`listInstances` both orchestrators implement.
 */

import type { Command } from 'commander';
import { formatPorts, formatReplicas } from '../../services/orchestrator/format';
import type { InstanceInfo, ServiceInfo } from '../../services/orchestrator/interfaces';
import { CLIError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { colors, printBlank, printDim, printJSON, printRaw } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { listingJson, openDay2 } from '../shared/day2';

export interface ListServicesOptions {
  server?: string;
  tasks?: boolean;
  json?: boolean;
}

const TASK_LIMIT = 10;
const ERROR_PREVIEW = 40;

function serviceLabel(service: ServiceInfo): string {
  return service.kind === 'helm' ? `${service.name} (helm)` : service.name;
}

function taskLine(instance: InstanceInfo): string {
  const error = instance.error ? ` (${instance.error.length > ERROR_PREVIEW ? `${instance.error.slice(0, ERROR_PREVIEW)}…` : instance.error})` : '';
  return `  └─ ${instance.id.padEnd(32)}${(instance.node ?? '-').padEnd(15)}${instance.status}${error}`;
}

export async function runListServices(env: string, options: ListServicesOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const services = await ctx.orchestrator.stack.getServices(ctx.appRef);

  if (services.length === 0) {
    throw new CLIError(`No services found for stack "${ctx.stackName}"`, ErrorCode.STACK_NOT_FOUND, `Deploy the stack with: \`dockflow deploy ${env}\`.`);
  }

  if (options.json) {
    printJSON(listingJson(ctx, ctx.appRef, services));
    return;
  }

  printRaw(colors.dim(`${'SERVICE'.padEnd(25)}${'REPLICAS'.padEnd(12)}${'IMAGE'.padEnd(40)}PORTS`));
  printDim('─'.repeat(90));
  for (const service of services) {
    printRaw(
      `${colors.info(serviceLabel(service).padEnd(25))}` +
        `${formatReplicas(service).padEnd(12)}` +
        `${service.image.padEnd(40)}` +
        `${colors.dim(formatPorts(service.ports) || '-')}`,
    );
    if (options.tasks) {
      const instances = await ctx.orchestrator.stack.listInstances(ctx.appRef, { service: service.name });
      for (const instance of instances.slice(0, TASK_LIMIT)) printRaw(colors.dim(taskLine(instance)));
    }
  }
  printBlank();
  printDim(`${services.length} service(s)`);
  if (!options.tasks) printDim('Use -t/--tasks to show individual tasks');
}

export function registerListServicesCommand(parent: Command): void {
  parent
    .command('services <env>')
    .alias('svc')
    .description('List services in a deployed stack')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('-t, --tasks', 'Show individual containers/tasks for each service')
    .option('-j, --json', 'Output as JSON')
    .action(withServicesRequired(withResolvedEnv(runListServices)));
}
