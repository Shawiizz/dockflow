// `dockflow helm values <env> [release]` (design-04 3.12.5): the user-supplied values of a
// revision, sensitive leaves masked by key name unless `--reveal` (interactive only).

import type { Command } from 'commander';
import { stringify } from 'yaml';
import { isSensitiveKeyPath, isValuesMap, joinKeyPath } from '../../services/orchestrator/kubernetes/helm/values-yaml';
import { CLIError, ErrorCode, ValidationError, withErrorHandler } from '../../utils/errors';
import { printJSON, printRaw } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { type HelmCommandContext, openHelmCommand, resolveReleaseTarget } from './utils';

export interface HelmValuesOptions {
  system?: boolean;
  revision?: string;
  reveal?: boolean;
  json?: boolean;
  server?: string;
}

const MASK = '***';

function mask(value: unknown, keyPath: string): unknown {
  if (isValuesMap(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = mask(value[key], joinKeyPath(keyPath, key));
    return out;
  }
  if (Array.isArray(value)) return value.map((item, i) => mask(item, `${keyPath}[${i}]`));
  return typeof value === 'string' && isSensitiveKeyPath(keyPath) ? MASK : value;
}

function parseRevision(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 1) {
    throw new ValidationError('--revision must be a positive integer');
  }
  return n;
}

export async function runHelmValues(ctx: HelmCommandContext, name: string | undefined, options: HelmValuesOptions): Promise<void> {
  if (options.reveal && !process.stdin.isTTY) {
    throw new ValidationError('--reveal prints secret values and needs an interactive terminal', 'Run it from a terminal session, not from CI.');
  }
  const target = await resolveReleaseTarget(ctx, name, { system: options.system });
  const revision = parseRevision(options.revision);
  const result = await ctx.helm.deployedValues(target.namespace, target.name, revision);
  if (result === null) {
    throw new CLIError(`Helm release ${target.name} has no revision ${revision ?? target.status.revision}`, ErrorCode.SERVICE_NOT_FOUND);
  }
  const shown = options.reveal ? result.values : (mask(result.values, '') as Record<string, unknown>);

  if (options.json) {
    printJSON(shown);
    return;
  }

  const shownRevision = revision ?? target.status.revision;
  const header = options.reveal
    ? `# user-supplied values of ${target.name}, revision ${shownRevision}`
    : `# user-supplied values of ${target.name}, revision ${shownRevision}; sensitive keys masked (use --reveal)`;
  printRaw(header);
  printRaw(stringify(shown));
}

export function registerHelmValuesCommand(helm: Command): void {
  helm
    .command('values <env> [release]')
    .description('Show the values of a Helm release')
    .option('--system', 'Target the Dockflow Traefik release')
    .option('--revision <n>', 'Revision to read (default: deployed)')
    .option('--reveal', 'Print sensitive values unmasked (requires a terminal)')
    .option('--json', 'Output as JSON')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withErrorHandler(
        withResolvedEnv(async (env: string, release: string | undefined, options: HelmValuesOptions) => {
          const ctx = await openHelmCommand(env, { server: options.server }, 'dockflow helm values');
          await runHelmValues(ctx, release, options);
        }),
      ),
    );
}
