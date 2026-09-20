/**
 * `dockflow details <env>` (design-06 3.9): services, resource usage and cluster nodes. A stats
 * read failure (metrics-server unavailable, `docker stats` unreachable) is a warning, not a fatal
 * error, so the rest of the command still runs.
 */

import type { Command } from 'commander';
import { formatReplicas } from '../../services/orchestrator/format';
import type { ContainerStats } from '../../services/orchestrator/interfaces';
import { OrchestratorUnavailableError, withServicesRequired } from '../../utils/errors';
import { printNote, printRaw, printSection, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface DetailsCommandOptions {
  server?: string;
}

const COLUMN = { instance: 30, container: 12, node: 12, cpu: 14, mem: 12, memPct: 9 };

function cpuText(cpuMilli: number | null): string {
  if (cpuMilli === null) return '-';
  return `${Math.round(cpuMilli)}m (${(cpuMilli / 10).toFixed(1)}%)`;
}

function bytesText(bytes: number | null): string {
  if (bytes === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function memPercentText(row: ContainerStats): string {
  if (row.memoryBytes === null || row.memoryLimitBytes === null || row.memoryLimitBytes === 0) return '-';
  return `${((row.memoryBytes / row.memoryLimitBytes) * 100).toFixed(1)}%`;
}

export async function runDetails(env: string, options: DetailsCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });

  printSection('Services');
  const services = await ctx.orchestrator.stack.getServices(ctx.appRef);
  for (const service of services) printRaw(`  ${service.name.padEnd(20)}${formatReplicas(service).padEnd(10)}${service.image}`);

  printSection('Resource Usage');
  let stats: ContainerStats[] = [];
  try {
    stats = await ctx.orchestrator.containers.stats(ctx.appRef);
  } catch (error) {
    if (error instanceof OrchestratorUnavailableError) printWarning(error.message);
    else throw error;
  }
  if (stats.length === 0) {
    printWarning('No running containers');
  } else {
    printRaw(
      `  ${'INSTANCE'.padEnd(COLUMN.instance)}${'CONTAINER'.padEnd(COLUMN.container)}${'NODE'.padEnd(COLUMN.node)}` +
        `${'CPU'.padEnd(COLUMN.cpu)}${'MEM'.padEnd(COLUMN.mem)}${'MEM%'.padEnd(COLUMN.memPct)}NET I/O        BLOCK I/O`,
    );
    for (const row of stats) {
      printRaw(
        `  ${row.instance.slice(0, COLUMN.instance - 1).padEnd(COLUMN.instance)}${row.container.padEnd(COLUMN.container)}` +
          `${(row.node ?? '-').padEnd(COLUMN.node)}${cpuText(row.cpuMilli).padEnd(COLUMN.cpu)}${bytesText(row.memoryBytes).padEnd(COLUMN.mem)}` +
          `${memPercentText(row).padEnd(COLUMN.memPct)}${(row.netIO ?? '-').padEnd(15)}${row.blockIO ?? '-'}`,
      );
    }
  }

  printSection('Nodes');
  const nodes = await ctx.orchestrator.cluster.nodes();
  printRaw(`  ${'NODE'.padEnd(20)}${'SERVER'.padEnd(14)}${'ROLE'.padEnd(10)}${'STATUS'.padEnd(10)}${'VERSION'.padEnd(14)}PRESSURE`);
  for (const node of nodes) {
    printRaw(
      `  ${node.name.padEnd(20)}${(node.server ?? '-').padEnd(14)}${node.role.padEnd(10)}` +
        `${(node.ready ? 'Ready' : 'NotReady').padEnd(10)}${(node.version ?? '-').padEnd(14)}${node.pressure.join(', ') || '-'}`,
    );
  }

  printNote(
    'dockflow version <env>        Deployed version info\n' +
      'dockflow ps <env>              Instances (containers or pods)\n' +
      'dockflow list images <env>     Available images\n' +
      'dockflow logs <env>            View logs',
    'More commands',
  );
}

export function registerDetailsCommand(program: Command): void {
  program
    .command('details <env>')
    .description('Show stack overview and resource usage')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runDetails)));
}
