/**
 * `dockflow prune <env>` (design-06 3.15): reclaim image (and, on Swarm, container/volume/network)
 * disk space on every manager and worker. Target selection is pure (`planPrune`) and runs right
 * after the config is loaded, before `openDay2`, so a target k3s does not support is refused without
 * ever probing a manager (core 6.2).
 */

import type { Command } from 'commander';
import { capabilitiesFor } from '../../services/orchestrator/capabilities';
import type { OrchestratorKind } from '../../services/orchestrator/interfaces';
import { loadConfig } from '../../utils/config';
import { withServicesRequired } from '../../utils/errors';
import { createSpinner, printBlank, printInfo, printIntro, printOutro, printRaw, printSection, printWarning } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, planPrune, type PruneTarget } from '../shared/day2';

export interface PruneCommandOptions {
  all?: boolean;
  images?: boolean;
  containers?: boolean;
  volumes?: boolean;
  networks?: boolean;
  yes?: boolean;
  server?: string;
}

const K3S_NO_ALL_NOTE =
  'containerd keeps no dangling images and the kubelet removes unused images under disk pressure; use `--all` to remove every unused image now';

const RUNTIME_LABEL: Record<Exclude<PruneTarget, 'images'>, string> = {
  containers: 'Containers',
  volumes: 'Volumes',
  networks: 'Networks',
};

/** the configured orchestrator kind, read locally (before `openDay2`) so a refused target is never probed */
function configuredOrchestratorKind(): OrchestratorKind {
  return loadConfig()?.orchestrator ?? 'swarm';
}

export async function runPrune(
  env: string,
  options: PruneCommandOptions,
  getOrchestratorKind: () => OrchestratorKind = configuredOrchestratorKind,
): Promise<void> {
  const kind = getOrchestratorKind();
  const isK3s = kind === 'k3s';
  const plan = planPrune(options, capabilitiesFor(kind)); // may refuse before any SSH (R-02..R-04)

  printIntro(`Prune Resources - ${env}`);
  printInfo(plan.note ?? `Targets: ${plan.targets.join(', ')}`);
  printBlank();

  // without --all, k3s images are a documented no-op (containerd/kubelet already reclaim them)
  const pruneImagesNow = plan.targets.includes('images') && !(isK3s && !options.all);
  if (plan.targets.includes('images') && !pruneImagesNow) {
    printInfo(K3S_NO_ALL_NOTE);
  }

  if (!options.yes) {
    if (isK3s) {
      if (pruneImagesNow) {
        const confirmed = await confirmPrompt({
          message: 'This will remove every container image no container uses, on every node (images imported by Dockflow stay pinned).',
          initialValue: false,
        });
        if (!confirmed) {
          printInfo('Cancelled');
          return;
        }
      }
    } else {
      printWarning('This will permanently remove unused Docker resources.');
      if (plan.targets.includes('volumes')) {
        printWarning('WARNING: Pruning volumes will delete data that is not attached to containers!');
      }
      const confirmed = await confirmPrompt({ message: 'Are you sure you want to continue?', initialValue: false });
      if (!confirmed) {
        printInfo('Cancelled');
        return;
      }
    }
  }

  const ctx = await openDay2(env, { server: options.server });
  const nodes = [...ctx.orchestrator.target.managers, ...ctx.orchestrator.target.workers];

  for (const target of plan.targets) {
    if (target === 'images') {
      if (!pruneImagesNow) continue;
      const spinner = createSpinner();
      spinner.start(`Pruning ${options.all ? 'all unused' : 'dangling'} images...`);
      const results = await ctx.orchestrator.images.prune(nodes, { all: Boolean(options.all) });
      spinner.succeed('Images pruned');
      for (const result of results) {
        printRaw(`  Images pruned on ${result.node}${result.reclaimed ? ` (reclaimed ${result.reclaimed})` : ''}`);
      }
      continue;
    }

    const label = RUNTIME_LABEL[target];
    const spinner = createSpinner();
    spinner.start(`Pruning unused ${label.toLowerCase()}...`);
    const results = await ctx.orchestrator.images.pruneRuntime(nodes, target);
    spinner.succeed(`${label} pruned`);
    for (const result of results) {
      printRaw(`  ${label} pruned on ${result.node}${result.reclaimed ? ` (reclaimed ${result.reclaimed})` : ''}`);
    }
  }

  if (pruneImagesNow) {
    printBlank();
    printSection('Current Disk Usage');
    const usage = await ctx.orchestrator.images.list(nodes, { all: false });
    for (const row of usage) {
      printRaw(`  ${row.node}: ${row.diskUsage ?? 'unknown'}`);
    }
  }

  printBlank();
  printOutro('Prune complete');
}

export function registerPruneCommand(program: Command): void {
  program
    .command('prune <env>')
    .description('Remove unused resources (images, containers, volumes, networks)')
    .helpGroup('Operate')
    .option('-a, --all', 'Remove all unused images, not just dangling ones')
    .option('--images', 'Prune images only')
    .option('--containers', 'Prune containers only')
    .option('--volumes', 'Prune volumes only')
    .option('--networks', 'Prune networks only')
    .option('-y, --yes', 'Skip confirmation')
    .option('-s, --server <name>', 'Target server (defaults to first ready manager)')
    .action(withServicesRequired(withResolvedEnv((env: string, options: PruneCommandOptions) => runPrune(env, options))));
}
