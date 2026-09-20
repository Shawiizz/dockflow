/**
 * `dockflow version <env>` (design-06 3.8): the current release plus, on k3s, the app-role Helm
 * releases of the stack (`HelmBackend.list`, filtered to role app).
 */

import type { Command } from 'commander';
import { splitChartString } from '../../services/orchestrator/kubernetes/helm/parse';
import { CLIError, ErrorCode, withServicesRequired } from '../../utils/errors';
import { colors, printBlank, printDim, printJSON, printRaw } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface VersionCommandOptions {
  server?: string;
  json?: boolean;
}

export async function runVersion(env: string, options: VersionCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const meta = await ctx.orchestrator.releases.current(ctx.stackName);
  if (!meta) {
    throw new CLIError(`No deployment found for ${ctx.stackName}`, ErrorCode.STACK_NOT_FOUND, `Deploy first with \`dockflow deploy ${env}\`.`);
  }

  if (options.json) {
    printJSON(meta);
    return;
  }

  const services = await ctx.orchestrator.stack.getServices(ctx.appRef);

  printBlank();
  printRaw(`Stack: ${colors.info(ctx.stackName)}`);
  printBlank();
  printRaw(`${colors.dim('  Version:     ')}${colors.success(meta.version)}`);
  printRaw(`${colors.dim('  Environment: ')}${meta.env}`);
  printRaw(`${colors.dim('  Branch:      ')}${meta.branch || 'N/A'}`);
  printRaw(`${colors.dim('  Deployed:    ')}${meta.timestamp}`);
  printBlank();

  const compose = services.filter((s) => s.kind !== 'helm');
  if (compose.length > 0) {
    printDim('Running images:');
    for (const service of compose) printRaw(`${colors.dim('  ')}${service.name}: ${service.image}`);
    printBlank();
  }

  if (ctx.orchestrator.helm) {
    const ns = ctx.orchestrator.naming.scope(ctx.appRef);
    const otherNamespaces = [...new Set((ctx.config.helm?.releases ?? []).map((r) => r.namespace).filter((n): n is string => Boolean(n) && n !== ns))];
    const releases = (await ctx.orchestrator.helm.list([ns, ...otherNamespaces], ns)).filter((r) => r.role === 'app');
    if (releases.length > 0) {
      printDim('Helm releases:');
      for (const release of releases) {
        const { name, version } = splitChartString(release.chart);
        printRaw(`${colors.dim('  ')}${release.name}: chart ${name}@${version ?? '?'} (revision ${release.revision}, ${release.status})`);
      }
      printBlank();
    }
  }
}

export function registerVersionCommand(program: Command): void {
  program
    .command('version <env>')
    .description('Show app version currently deployed')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('-j, --json', 'Output as JSON')
    .action(withServicesRequired(withResolvedEnv(runVersion)));
}
