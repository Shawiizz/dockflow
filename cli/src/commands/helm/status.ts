// `dockflow helm status <env> [release]` (design-04 3.12.3): release, workload and volume summary,
// with the C18 reclaim-policy warning and, with `--system`, the proxy section.

import type { Command } from 'commander';
import { splitChartString } from '../../services/orchestrator/kubernetes/helm/parse';
import type { StackRef } from '../../services/orchestrator/interfaces';
import { colors, printBlank, printIntro, printJSON, printOutro, printRaw, printTableRow, printWarning } from '../../utils/output';
import { withErrorHandler } from '../../utils/errors';
import { withResolvedEnv } from '../../utils/validation';
import { classifyReleaseVolumes, type HelmCommandContext, openHelmCommand, type ReleaseTarget, resolveReleaseTarget, volumeScopeFor } from './utils';

export interface HelmStatusOptions {
  system?: boolean;
  json?: boolean;
  server?: string;
}

async function chartDigestOf(ctx: HelmCommandContext, target: ReleaseTarget): Promise<string | null> {
  if (target.role === null) return null;
  const current = await ctx.orchestrator.releases.current(ctx.stackName);
  return current?.helm?.find((record) => record.name === target.name)?.chart_sha256 ?? null;
}

async function workloadSummary(ctx: HelmCommandContext, target: ReleaseTarget): Promise<{ running: number; desired: number } | null> {
  if (target.role === null) return null;
  const ref: StackRef = { project: ctx.orchestrator.target.project, env: ctx.orchestrator.target.env, role: target.role };
  const services = await ctx.orchestrator.stack.getServices(ref);
  const row = services.find((service) => service.kind === 'helm' && service.name === target.name);
  return row?.replicas ?? null;
}

export async function runHelmStatus(ctx: HelmCommandContext, name: string | undefined, options: HelmStatusOptions): Promise<void> {
  const target = await resolveReleaseTarget(ctx, name, { system: options.system });
  const [history, volumes, chartSha256, replicas, proxyStatus] = await Promise.all([
    ctx.helm.history(target.namespace, target.name, 1),
    classifyReleaseVolumes(ctx, target),
    chartDigestOf(ctx, target),
    workloadSummary(ctx, target),
    options.system ? ctx.orchestrator.proxy.status() : Promise.resolve(null),
  ]);
  const description = history[0]?.description ?? null;
  const { name: chartName, version: chartVersion } = splitChartString(target.status.chart);
  const liveVolumes = await ctx.orchestrator.volumes.list(volumeScopeFor(ctx, target.namespace));
  const volumeRows = liveVolumes
    .filter((volume) => volumes.deletable.includes(volume.name) || volumes.surviving.includes(volume.name))
    .map((volume) => ({ ...volume, deletedByUninstall: volumes.deletable.includes(volume.name) }));
  const deleteClassVolumes = volumeRows.filter((volume) => volume.reclaimPolicy === 'Delete');

  if (options.json) {
    printJSON({
      release: target.name,
      description,
      declared: target.declared !== null,
      chartSha256,
      workloads: replicas === null ? [] : [{ kind: 'aggregate', name: target.name, ready: replicas.running, desired: replicas.desired }],
      volumes: volumeRows.map((volume) => ({
        name: volume.name,
        phase: volume.phase,
        capacity: volume.capacity,
        storageClass: volume.storageClass,
        reclaimPolicy: volume.reclaimPolicy,
        node: volume.node,
        deletedByUninstall: volume.deletedByUninstall,
      })),
      proxy: proxyStatus,
    });
    return;
  }

  printIntro(`Helm release ${target.name} - ${ctx.env}`);
  printRaw(colors.bold('Release'));
  printTableRow('Namespace', target.namespace);
  printTableRow('Role', target.declared !== null ? `${target.role ?? '-'} (declared in config.yml: ${target.declared.name} ${target.declared.version})` : (target.role ?? '-'));
  printTableRow('Chart', `${chartName}${chartVersion ? `-${chartVersion}` : ''}${target.status.appVersion ? ` (app ${target.status.appVersion})` : ''}`);
  printTableRow('Revision', `${target.status.revision}, ${target.status.status}${target.status.updated ? `, ${target.status.updated}` : ''}`);
  if (chartSha256 !== null) printTableRow('Chart digest', chartSha256);
  if (description !== null) printTableRow('Description', description);
  printBlank();

  if (replicas !== null) {
    printRaw(colors.bold('Workloads'));
    printTableRow(target.name, `${replicas.running}/${replicas.desired} ready`);
    printBlank();
  }

  if (volumeRows.length > 0) {
    printRaw(colors.bold('Volumes'));
    for (const volume of volumeRows) {
      printTableRow(
        volume.name,
        `${volume.phase}  ${volume.capacity ?? '-'}  ${volume.storageClass ?? '-'}  ${volume.reclaimPolicy ?? '-'}  node ${volume.node ?? '-'}  ${volume.deletedByUninstall ? 'deleted by uninstall' : 'survives uninstall'}`,
      );
    }
    printBlank();
  }

  if (options.system && proxyStatus !== null) {
    printRaw(colors.bold('Proxy'));
    printTableRow('Ready', proxyStatus.ready ? 'yes' : 'no');
    if (proxyStatus.version !== null) printTableRow('Version', proxyStatus.version);
    if (proxyStatus.node !== undefined && proxyStatus.node !== null) printTableRow('Node', proxyStatus.node);
    if (proxyStatus.recordedNode !== undefined && proxyStatus.recordedNode !== null) printTableRow('Recorded node', proxyStatus.recordedNode);
    for (const conflict of proxyStatus.conflicts ?? []) printWarning(conflict);
    for (const line of proxyStatus.recovery ?? []) printRaw(colors.warning(`  ${line}`));
    printBlank();
  }

  if (target.status.status === 'failed') {
    printWarning(`Last failure: ${description ?? 'unknown'}`);
  }

  for (const volume of deleteClassVolumes) {
    printWarning(`Volume ${volume.name} of Helm release ${target.name} has reclaim policy Delete, so deleting its claim destroys its data`);
    printRaw(
      colors.dim(
        `  → Set it to Retain with \`kubectl patch pv <pv> --type=merge -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'\`, and re-run \`dockflow setup k3s ${ctx.env}\` so dockflow-local stays the only default StorageClass.`,
      ),
    );
  }

  printOutro('Done');
}

export function registerHelmStatusCommand(helm: Command): void {
  helm
    .command('status <env> [release]')
    .description('Show a Helm release')
    .option('--system', 'Target the Dockflow Traefik release')
    .option('--json', 'Output as JSON')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withErrorHandler(
        withResolvedEnv(async (env: string, release: string | undefined, options: HelmStatusOptions) => {
          const ctx = await openHelmCommand(env, { server: options.server }, 'dockflow helm status');
          await runHelmStatus(ctx, release, options);
        }),
      ),
    );
}
