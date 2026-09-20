/**
 * `dockflow ps` (design-06 3.4): one instance table over `StackBackend.listInstances`, identical
 * shape on both orchestrators (`InstanceInfo`); `RESTARTS`/`AGE` print `-` when the backend does not
 * report them (Swarm, core `InstanceInfo.restarts`/`startedAt`).
 */

import type { Command } from 'commander';
import type { InstanceInfo, PortInfo, ServiceInfo } from '../../services/orchestrator/interfaces';
import { formatPorts } from '../../services/orchestrator/format';
import { formatAge, instanceStateText } from '../../services/orchestrator/kubernetes/status/pods';
import { withServicesRequired } from '../../utils/errors';
import { colors, printInfo, printJSON, printRaw } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { listingJson, openDay2 } from '../shared/day2';

export interface PsCommandOptions {
  server?: string;
  tasks?: boolean;
  all?: boolean;
  json?: boolean;
}

const COLUMN = { instance: 34, service: 15, status: 24, ready: 7, restarts: 10, node: 12, age: 6 };

function severityColor(severity: InstanceInfo['severity']): (text: string) => string {
  return severity === 'ok' ? colors.success : severity === 'error' ? colors.error : colors.warning;
}

function portsOf(instance: InstanceInfo, services: readonly ServiceInfo[]): PortInfo[] {
  return services.find((s) => s.name === instance.service)?.ports ?? [];
}

export async function runPs(env: string, options: PsCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const includeTerminated = Boolean(options.tasks || options.all);
  const [instances, services] = await Promise.all([
    ctx.orchestrator.stack.listInstances(ctx.appRef, { includeTerminated }),
    ctx.orchestrator.stack.getServices(ctx.appRef),
  ]);

  if (options.json) {
    printJSON(listingJson(ctx, ctx.appRef, instances));
    return;
  }

  if (instances.length === 0) {
    printInfo('No running instances');
    return;
  }

  if (options.tasks) {
    printTasksView(instances);
    return;
  }

  printRaw(
    colors.dim(
      `  ${'INSTANCE'.padEnd(COLUMN.instance)}${'SERVICE'.padEnd(COLUMN.service)}${'STATUS'.padEnd(COLUMN.status)}` +
        `${'READY'.padEnd(COLUMN.ready)}${'RESTARTS'.padEnd(COLUMN.restarts)}${'NODE'.padEnd(COLUMN.node)}${'AGE'.padEnd(COLUMN.age)}PORTS`,
    ),
  );
  const now = new Date();
  for (const instance of instances) {
    const paint = severityColor(instance.severity);
    const age = formatAge(instance.startedAt, now);
    const restarts = instance.restarts === null ? '-' : String(instance.restarts);
    const ports = formatPorts(portsOf(instance, services));
    printRaw(
      `  ${instance.id.slice(0, COLUMN.instance - 1).padEnd(COLUMN.instance)}` +
        `${instance.service.slice(0, COLUMN.service - 1).padEnd(COLUMN.service)}` +
        `${paint(instance.status.padEnd(COLUMN.status))}` +
        `${(instance.ready ? 'yes' : 'no').padEnd(COLUMN.ready)}` +
        `${restarts.padEnd(COLUMN.restarts)}` +
        `${(instance.node ?? '-').padEnd(COLUMN.node)}` +
        `${age.padEnd(COLUMN.age)}` +
        `${ports}`,
    );
  }
}

function printTasksView(instances: readonly InstanceInfo[]): void {
  const now = new Date();
  for (const instance of instances) {
    printRaw(`  ${instance.id}`);
    printRaw(`    Service: ${instance.service}`);
    printRaw(`    Node:    ${instance.node ?? '-'}`);
    printRaw(`    State:   ${instanceStateText(instance, now)}`);
    if (instance.error) printRaw(`    Error:   ${instance.error}`);
    printRaw('');
  }
}

export function registerPsCommand(program: Command): void {
  program
    .command('ps <env>')
    .description('List running instances (containers or pods)')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('--tasks', 'Show a detailed block per instance')
    .option('-a, --all', 'Include terminated instances')
    .option('-j, --json', 'Output as JSON')
    .action(withServicesRequired(withResolvedEnv(runPs)));
}
