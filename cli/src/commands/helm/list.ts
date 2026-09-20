// `dockflow helm list <env>` (design-04 3.12.2): every owned release plus declared releases that
// are not installed, accessories first then app (each in config order), undeclared releases last.

import type { Command } from 'commander';
import { splitChartString } from '../../services/orchestrator/kubernetes/helm/parse';
import type { StackRole } from '../../services/orchestrator/interfaces';
import { colors, printBlank, printDim, printInfo, printIntro, printJSON, printOutro, printRaw } from '../../utils/output';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { withResolvedEnv } from '../../utils/validation';
import { type HelmCommandContext, openHelmCommand } from './utils';

export interface HelmListOptions {
  role?: string;
  json?: boolean;
  server?: string;
}

interface Row {
  name: string;
  role: StackRole | null;
  namespace: string;
  chart: string | null;
  chartVersion: string | null;
  appVersion: string | null;
  revision: number | null;
  status: string | null;
  updated: string | null;
  declared: boolean;
  installed: boolean;
  note: string | null;
}

function roleRank(role: StackRole | null): number {
  return role === 'accessory' ? 0 : role === 'app' ? 1 : 2;
}

export async function runHelmList(ctx: HelmCommandContext, options: HelmListOptions): Promise<void> {
  if (options.role !== undefined && options.role !== 'app' && options.role !== 'accessory') {
    throw new ValidationError("--role must be 'app' or 'accessory'");
  }

  const owned = await ctx.helm.listAll(ctx.stackId);
  const declaredByName = new Map(ctx.declared.map((release) => [release.name, release]));
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const release of owned) {
    const declared = declaredByName.get(release.name) ?? null;
    const { name: chart, version: chartVersion } = splitChartString(release.chart);
    rows.push({
      name: release.name,
      role: release.role,
      namespace: release.namespace,
      chart,
      chartVersion,
      appVersion: release.appVersion,
      revision: release.revision,
      status: release.status,
      updated: release.updated,
      declared: declared !== null,
      installed: true,
      note: declared === null ? 'not in config.yml' : null,
    });
    seen.add(release.name);
  }
  for (const declared of ctx.declared) {
    if (seen.has(declared.name)) continue;
    rows.push({
      name: declared.name,
      role: declared.role,
      namespace: declared.namespace,
      chart: null,
      chartVersion: null,
      appVersion: null,
      revision: null,
      status: null,
      updated: null,
      declared: true,
      installed: false,
      note: 'not installed',
    });
  }

  const declaredOrder = new Map(ctx.declared.map((release, index) => [release.name, index]));
  const filtered = (options.role === undefined ? rows : rows.filter((row) => row.role === options.role)).sort((a, b) => {
    if (roleRank(a.role) !== roleRank(b.role)) return roleRank(a.role) - roleRank(b.role);
    const ia = declaredOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const ib = declaredOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  if (options.json) {
    printJSON(
      filtered.map((row) => ({
        name: row.name,
        role: row.role,
        namespace: row.namespace,
        chart: row.chart,
        chartVersion: row.chartVersion,
        appVersion: row.appVersion,
        revision: row.revision,
        status: row.status,
        updated: row.updated,
        declared: row.declared,
        installed: row.installed,
      })),
    );
    return;
  }

  if (filtered.length === 0) {
    printInfo(`No Helm releases for ${ctx.env}`);
    return;
  }

  printIntro(`Helm releases - ${ctx.env}`);
  printRaw(
    colors.dim('RELEASE'.padEnd(20)) +
      colors.dim('ROLE'.padEnd(11)) +
      colors.dim('NAMESPACE'.padEnd(26)) +
      colors.dim('CHART'.padEnd(20)) +
      colors.dim('REV'.padEnd(5)) +
      colors.dim('STATUS'.padEnd(11)) +
      colors.dim('NOTE'),
  );
  for (const row of filtered) {
    const statusColor = row.status === 'deployed' ? colors.success : row.status === 'failed' ? colors.error : row.status === null ? colors.dim : colors.warning;
    const chart = row.chart === null ? '-' : `${row.chart} ${row.chartVersion ?? ''}`.trim();
    printRaw(
      colors.info(row.name.padEnd(20)) +
        (row.role ?? '-').padEnd(11) +
        row.namespace.padEnd(26) +
        chart.padEnd(20) +
        String(row.revision ?? '-').padEnd(5) +
        statusColor((row.status ?? '-').padEnd(11)) +
        colors.dim(row.note ?? ''),
    );
  }
  printBlank();
  printDim(`${filtered.length} release(s)`);
  printOutro(`Stack: ${ctx.stackName} (namespace ${ctx.stackId})`);
}

export function registerHelmListCommand(helm: Command): void {
  helm
    .command('list <env>')
    .description('List Helm releases')
    .option('--role <role>', 'Filter by role (app or accessory)')
    .option('--json', 'Output as JSON')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withErrorHandler(
        withResolvedEnv(async (env: string, options: HelmListOptions) => {
          const ctx = await openHelmCommand(env, { server: options.server }, 'dockflow helm list');
          await runHelmList(ctx, options);
        }),
      ),
    );
}
