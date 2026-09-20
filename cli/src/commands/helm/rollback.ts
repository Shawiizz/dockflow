// `dockflow helm rollback <env> [release] [revision]` (design-04 3.12.7): native `helm rollback` to
// an earlier deployed or superseded revision. With `--system` the first positional is the revision.

import type { Command } from 'commander';
import type { HelmEventSink } from '../../services/orchestrator/interfaces';
import { TRAEFIK_HISTORY_MAX } from '../../services/orchestrator/kubernetes/constants';
import { CLIError, ErrorCode, ValidationError, withErrorHandler } from '../../utils/errors';
import { printInfo, printIntro, printOutro, printRaw, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { confirmOrThrow, declaredDisplay, type HelmCommandContext, helmHistoryMaxFor, openHelmCommand, resolveReleaseTarget, resolveTimeoutS, withHelmLock } from './utils';

export interface HelmRollbackOptions {
  system?: boolean;
  timeout?: string;
  yes?: boolean;
  server?: string;
}

const events: HelmEventSink = { step: printInfo, warn: (message, suggestion) => printWarning(suggestion ? `${message} ${suggestion}` : message) };

function parseRevisionArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 1) {
    throw new ValidationError('revision must be a positive integer');
  }
  return n;
}

export async function runHelmRollback(
  ctx: HelmCommandContext,
  name: string | undefined,
  revisionArg: string | undefined,
  options: HelmRollbackOptions,
): Promise<void> {
  const target = await resolveReleaseTarget(ctx, name, { system: options.system });
  const history = await ctx.helm.history(target.namespace, target.name, 256);
  const historyMax = options.system ? TRAEFIK_HISTORY_MAX : helmHistoryMaxFor(ctx.config);

  let revision: number;
  if (revisionArg !== undefined) {
    revision = parseRevisionArg(revisionArg);
  } else {
    const superseded = history.filter((entry) => entry.status === 'superseded' && entry.revision < target.status.revision).sort((a, b) => b.revision - a.revision)[0];
    if (superseded === undefined) {
      throw new CLIError(`Helm release ${target.name} has no earlier deployed revision`, ErrorCode.SERVICE_NOT_FOUND);
    }
    revision = superseded.revision;
  }

  if (revision === target.status.revision) {
    printInfo(`Helm release ${target.name} is already at revision ${revision}`);
    return;
  }

  const entry = history.find((candidate) => candidate.revision === revision);
  if (entry === undefined) {
    throw new CLIError(`Helm release ${target.name} has no revision ${revision} (history keeps ${historyMax} revisions)`, ErrorCode.SERVICE_NOT_FOUND);
  }
  if (entry.status === 'failed' || entry.status.startsWith('pending-')) {
    throw new ValidationError(
      `Revision ${revision} of ${target.name} was never successfully deployed`,
      `Pick a deployed or superseded revision from \`dockflow helm history ${ctx.env} ${target.name}\`.`,
    );
  }

  const from = history.find((candidate) => candidate.revision === target.status.revision);
  printRaw(`${from?.chart ?? target.status.chart} (app ${from?.appVersion ?? target.status.appVersion ?? '-'}), revision ${target.status.revision} -> ${entry.chart} (app ${entry.appVersion ?? '-'}), revision ${revision}`);

  const confirmed = await confirmOrThrow({ yes: options.yes, message: `Roll back Helm release ${target.name} to revision ${revision}?` });
  if (!confirmed) {
    printInfo('Cancelled');
    return;
  }

  const timeoutS = resolveTimeoutS(ctx, options.timeout, target.declared, options.system === true);
  printIntro(`Rolling back Helm release ${target.name} - ${ctx.env}`);
  const status = await withHelmLock(ctx, { system: target.system, message: `Helm rollback ${target.name}` }, () =>
    ctx.helm.rollback(target.namespace, target.name, revision, { timeoutS, historyMax, description: `Dockflow manual rollback to revision ${revision}`, events }),
  );

  printOutro(`Helm release ${target.name} rolled back to revision ${revision} (now revision ${status.revision})`);
  if (target.declared !== null) {
    printRaw(`The next dockflow deploy applies config.yml again (${declaredDisplay(target.declared)})`);
  }
  if (options.system) {
    printRaw('The next deploy with proxy.enabled restores the Traefik configuration of the Dockflow CLI in use');
  }
}

export function registerHelmRollbackCommand(helm: Command): void {
  helm
    .command('rollback <env> [releaseOrRevision] [revision]')
    .description('Roll back a Helm release to an earlier revision')
    .option('--system', 'Target the Dockflow Traefik release (the first positional is then the revision)')
    .option('--timeout <duration>', 'Rollback timeout (default: the release timeout)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withErrorHandler(
        withResolvedEnv(async (env: string, releaseOrRevision: string | undefined, revision: string | undefined, options: HelmRollbackOptions) => {
          const ctx = await openHelmCommand(env, { server: options.server }, 'dockflow helm rollback');
          const name = options.system ? undefined : releaseOrRevision;
          const revisionArg = options.system ? releaseOrRevision : revision;
          await runHelmRollback(ctx, name, revisionArg, options);
        }),
      ),
    );
}
