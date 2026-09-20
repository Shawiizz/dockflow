/**
 * `dockflow accessories list` (design-06 3.16): the accessory-role listing, table + a Volumes section
 * from the orchestrator's `VolumeBackend` (never null, core 6.1, K61), so this command works
 * identically on both orchestrators without special-casing Swarm.
 */

import type { Command } from 'commander';
import { formatPorts, formatReplicas } from '../../services/orchestrator/format';
import type { ServiceInfo } from '../../services/orchestrator/interfaces';
import { getLayout } from '../../utils/config';
import { withServicesRequired } from '../../utils/errors';
import { colors, printBlank, printDim, printInfo, printJSON, printRaw, printSection } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { listingJson, openDay2 } from '../shared/day2';

export interface AccessoriesListOptions {
  server?: string;
  json?: boolean;
}

function hasAccessoriesFile(): boolean {
  return getLayout().accessoriesPath !== null;
}

function serviceLabel(service: ServiceInfo): string {
  return service.kind === 'helm' ? `${service.name} (helm)` : service.name;
}

export async function runAccessoriesList(env: string, options: AccessoriesListOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const ref = ctx.accessoryRef;
  const deployed = await ctx.orchestrator.stack.exists(ref);

  if (!deployed) {
    if (!hasAccessoriesFile()) {
      printInfo('No accessories.yml found in .dockflow/docker/');
      printInfo('Create one to define your accessories (databases, caches, etc.)');
    } else {
      printInfo('Accessories not deployed yet');
      printBlank();
      printInfo(`Deploy with: dockflow deploy ${env} --accessories`);
    }
    return;
  }

  const services = await ctx.orchestrator.stack.getServices(ref);

  if (options.json) {
    printJSON(listingJson(ctx, ref, services));
    return;
  }

  if (services.length === 0) {
    printInfo('No accessories services found');
    return;
  }

  printRaw(colors.dim(`  ${'SERVICE'.padEnd(28)}${'REPLICAS'.padEnd(12)}${'IMAGE'.padEnd(35)}PORTS`));
  printDim(`  ${'-'.repeat(90)}`);
  for (const service of services) {
    printRaw(
      `  ${colors.info(serviceLabel(service).padEnd(28))}` +
        `${formatReplicas(service).padEnd(12)}` +
        `${colors.dim(service.image.padEnd(35))}` +
        `${colors.dim(formatPorts(service.ports) || '-')}`,
    );
  }

  const volumes = await ctx.orchestrator.volumes.list({ project: ctx.orchestrator.target.project, env, role: 'accessory' });
  if (volumes.length > 0) {
    printBlank();
    printSection('Volumes');
    printRaw(colors.dim(`  ${'NAME'.padEnd(30)}${'STATUS'.padEnd(12)}${'CAPACITY'.padEnd(12)}NODE`));
    for (const volume of volumes) {
      printRaw(`  ${volume.name.padEnd(30)}${volume.phase.padEnd(12)}${(volume.capacity ?? '-').padEnd(12)}${volume.node ?? '-'}`);
    }
  }

  printBlank();
  printInfo(ctx.orchestrator.naming.describe(ref));
}

export function registerAccessoriesListCommand(program: Command): void {
  program
    .command('list <env>')
    .alias('ls')
    .description('List running accessories and their status')
    .option('-j, --json', 'Output in JSON format')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runAccessoriesList)));
}
