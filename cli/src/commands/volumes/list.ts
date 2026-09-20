/**
 * `dockflow volumes list <env>` (design-06 3.17, DESIGN-CORE C13, D7): persistent volumes and
 * released PVs of a namespace, with the reclaim-policy guarantee as a mandatory column. Kubernetes
 * only: refused on Swarm before any SSH (R-05).
 */

import type { Command } from 'commander';
import { requireCapabilityFor } from '../../services/orchestrator/capabilities';
import { K8S_STORAGE_CLASS, K8S_SYSTEM_NAMESPACE } from '../../services/orchestrator/kubernetes/constants';
import type { OrchestratorKind, StackRole, VolumeScope } from '../../services/orchestrator/interfaces';
import { loadConfig } from '../../utils/config';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { colors, printBlank, printInfo, printIntro, printJSON, printRaw, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { type Day2Context, listingJson, openDay2 } from '../shared/day2';

export interface VolumesListOptions {
  role?: string;
  system?: boolean;
  namespace?: string;
  json?: boolean;
  server?: string;
}

/** `--system` / `--namespace` (design-06 3.17 table); `--namespace` must name a Helm release of this stack. */
export async function resolveVolumeNamespace(ctx: Day2Context, options: { system?: boolean; namespace?: string }): Promise<string | undefined> {
  if (options.system && options.namespace !== undefined) {
    throw new ValidationError('--system and --namespace cannot be combined');
  }
  if (options.system) return K8S_SYSTEM_NAMESPACE;
  if (options.namespace === undefined) return undefined;
  const helm = ctx.orchestrator.helm;
  const releases = helm ? await helm.listAll(ctx.orchestrator.naming.scope(ctx.appRef)) : [];
  if (!releases.some((release) => release.namespace === options.namespace)) {
    throw new ValidationError(
      `Namespace ${options.namespace} holds no Helm release of ${ctx.stackName}`,
      `List the releases with \`dockflow helm list ${ctx.env}\`.`,
    );
  }
  return options.namespace;
}

function column(value: string | null): string {
  return value ?? '-';
}

/** the configured orchestrator kind, read locally (before `openDay2`) so the refusal needs no probe */
function configuredOrchestratorKind(): OrchestratorKind {
  return loadConfig()?.orchestrator ?? 'swarm';
}

export async function runVolumesList(
  env: string,
  options: VolumesListOptions,
  getOrchestratorKind: () => OrchestratorKind = configuredOrchestratorKind,
): Promise<void> {
  requireCapabilityFor(getOrchestratorKind(), 'volumes', 'dockflow volumes list');
  if (options.role !== undefined && options.role !== 'app' && options.role !== 'accessory') {
    throw new ValidationError('--role must be app or accessory');
  }

  const ctx = await openDay2(env, { server: options.server });
  const namespace = await resolveVolumeNamespace(ctx, options);
  const scope: VolumeScope = {
    project: ctx.orchestrator.target.project,
    env: ctx.orchestrator.target.env,
    role: (options.role as StackRole | undefined) ?? null,
    ...(namespace !== undefined ? { namespace } : {}),
  };
  const infos = await ctx.orchestrator.volumes.list(scope);

  if (options.json) {
    printJSON(listingJson(ctx, ctx.appRef, infos));
    return;
  }

  printIntro(`Volumes - ${env}`);
  printBlank();

  if (infos.length === 0) {
    printInfo(`No volumes in ${ctx.orchestrator.naming.describe(ctx.appRef)}`);
    return;
  }

  printRaw(
    colors.bold(
      '  ' +
        'VOLUME'.padEnd(16) +
        'ROLE'.padEnd(11) +
        'COMPOSE'.padEnd(12) +
        'STATUS'.padEnd(9) +
        'CAPACITY'.padEnd(10) +
        'CLASS'.padEnd(16) +
        'NODE'.padEnd(10) +
        'RECLAIM'.padEnd(9) +
        'USED BY',
    ),
  );

  let unexpectedDelete = 0;
  for (const info of infos) {
    const usedBy = info.usedBy.length > 0 ? info.usedBy.join(', ') : colors.dim('(unused)');
    const row =
      '  ' +
      info.name.padEnd(16) +
      column(info.role).padEnd(11) +
      column(info.composeName).padEnd(12) +
      info.phase.padEnd(9) +
      column(info.capacity).padEnd(10) +
      column(info.storageClass).padEnd(16) +
      column(info.node).padEnd(10) +
      column(info.reclaimPolicy).padEnd(9) +
      usedBy;

    // C13 step 6: `repair()` already restored every PV of ours still carrying the evidence
    // annotation, so anything left at Delete with its claim bound was not left by Dockflow.
    const suspect = info.phase === 'Bound' && info.reclaimPolicy === 'Delete' && info.storageClass === K8S_STORAGE_CLASS;
    if (suspect) {
      unexpectedDelete++;
      printRaw(colors.warning(`${row} (expected Retain)`));
    } else {
      printRaw(row);
    }
  }

  if (unexpectedDelete > 0) {
    printBlank();
    printWarning(
      `${unexpectedDelete} volume(s) are set to Delete although their class keeps data; set them back with \`dockflow ssh ${env}\`, ` +
        `then \`k3s kubectl patch pv <pv> --type=merge -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'\`.`,
    );
  }
}

export function registerVolumesListCommand(volumes: Command): void {
  volumes
    .command('list <env>')
    .alias('ls')
    .description('List persistent volumes')
    .option('--role <role>', 'Filter by role (app or accessory)')
    .option('--system', 'Target the Dockflow system namespace')
    .option('--namespace <ns>', 'Target a Helm release namespace of this stack')
    .option('-j, --json', 'Output in JSON format')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withErrorHandler(withResolvedEnv(runVolumesList)));
}
