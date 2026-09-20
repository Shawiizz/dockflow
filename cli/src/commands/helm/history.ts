// `dockflow helm history <env> [release]` (design-04 3.12.4): revisions newest first, `*` marks the
// deployed one; descriptions are already redacted by the backend and truncated to 120 characters
// for display (full text with `--json`).

import type { Command } from 'commander';
import { colors, printIntro, printJSON, printOutro, printRaw } from '../../utils/output';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { withResolvedEnv } from '../../utils/validation';
import { type HelmCommandContext, openHelmCommand, resolveReleaseTarget } from './utils';

export interface HelmHistoryOptions {
  system?: boolean;
  max?: string;
  json?: boolean;
  server?: string;
}

const DESCRIPTION_DISPLAY_MAX = 120;

function truncate(text: string): string {
  return text.length > DESCRIPTION_DISPLAY_MAX ? `${text.slice(0, DESCRIPTION_DISPLAY_MAX)}...` : text;
}

function parseMax(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 1 || n > 256) {
    throw new ValidationError('--max must be an integer between 1 and 256');
  }
  return n;
}

export async function runHelmHistory(ctx: HelmCommandContext, name: string | undefined, options: HelmHistoryOptions): Promise<void> {
  const max = parseMax(options.max);
  const target = await resolveReleaseTarget(ctx, name, { system: options.system });
  const history = await ctx.helm.history(target.namespace, target.name, max);

  if (options.json) {
    printJSON(history.map((entry) => ({ ...entry, deployed: entry.status === 'deployed' })));
    return;
  }

  printIntro(`Helm history ${target.name} - ${ctx.env}`);
  printRaw(
    colors.dim('REVISION'.padEnd(10)) +
      colors.dim('UPDATED'.padEnd(21)) +
      colors.dim('STATUS'.padEnd(12)) +
      colors.dim('CHART'.padEnd(20)) +
      colors.dim('APP VERSION'.padEnd(13)) +
      colors.dim('DESCRIPTION'),
  );
  for (const entry of history) {
    const marker = entry.status === 'deployed' ? '*' : ' ';
    const statusColor = entry.status === 'deployed' ? colors.success : entry.status === 'failed' ? colors.error : colors.dim;
    printRaw(
      `${marker}${String(entry.revision).padEnd(9)}` +
        (entry.updated ?? '-').padEnd(21) +
        statusColor(entry.status.padEnd(12)) +
        entry.chart.padEnd(20) +
        (entry.appVersion ?? '-').padEnd(13) +
        colors.dim(truncate(entry.description ?? '')),
    );
  }
  printOutro('Done');
}

export function registerHelmHistoryCommand(helm: Command): void {
  helm
    .command('history <env> [release]')
    .description('Show a Helm release history')
    .option('--system', 'Target the Dockflow Traefik release')
    .option('--max <n>', 'Maximum revisions to list (default 20)')
    .option('--json', 'Output as JSON')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withErrorHandler(
        withResolvedEnv(async (env: string, release: string | undefined, options: HelmHistoryOptions) => {
          const ctx = await openHelmCommand(env, { server: options.server }, 'dockflow helm history');
          await runHelmHistory(ctx, release, options);
        }),
      ),
    );
}
