// `dockflow helm uninstall <env> [release]` (design-04 3.12.6): explicit uninstall with the
// deletable/surviving PVC guard and the `--volumes` / `--keep-volumes` protocol of design-04 3.10.

import type { Command } from 'commander';
import type { HelmEventSink } from '../../services/orchestrator/interfaces';
import { ValidationError, withErrorHandler } from '../../utils/errors';
import { colors, printInfo, printIntro, printOutro, printRaw, printTableRow, printWarning } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import {
  classifyReleaseVolumes,
  confirmOrThrow,
  type HelmCommandContext,
  openHelmCommand,
  type ReleaseTarget,
  resolveReleaseTarget,
  resolveTimeoutS,
  volumeScopeFor,
  withHelmLock,
} from './utils';

export interface HelmUninstallOptions {
  system?: boolean;
  volumes?: boolean;
  keepVolumes?: boolean;
  force?: boolean;
  timeout?: string;
  yes?: boolean;
  server?: string;
}

const eventsToOutput: HelmEventSink = { step: printInfo, warn: (message, suggestion) => printWarning(suggestion ? `${message} ${suggestion}` : message) };

function declaredNote(ctx: HelmCommandContext, target: ReleaseTarget): void {
  if (target.declared === null) return;
  const consequence = target.declared.role === 'app' ? 'installs it again' : 'warns about it';
  printWarning(`Helm release ${target.name} is still declared in config.yml, so the next dockflow deploy ${consequence}`);
  printRaw(colors.dim('  → Remove it from config.yml first.'));
}

export async function runHelmUninstall(ctx: HelmCommandContext, name: string | undefined, options: HelmUninstallOptions): Promise<void> {
  if (options.volumes && options.keepVolumes) {
    throw new ValidationError('--volumes and --keep-volumes cannot be combined');
  }
  if (options.force && !options.system) {
    throw new ValidationError('--force only applies with --system');
  }
  const target = await resolveReleaseTarget(ctx, name, { system: options.system });
  const { deletable, surviving, deletableBoundVolumes } = await classifyReleaseVolumes(ctx, target);
  const boundVolumes = [...new Set(deletableBoundVolumes.values())];

  if (deletable.length > 0 && !options.volumes && !options.keepVolumes) {
    throw new ValidationError(
      `Helm release ${target.name} owns volumes that an uninstall deletes (${deletable.join(', ')})`,
      'Re-run with `--volumes` to delete them with their data, or with `--keep-volumes` to keep the data as released volumes.',
    );
  }

  if (options.system && !options.force) {
    const routes = await ctx.orchestrator.proxy.routesInUse?.();
    if (routes !== undefined && (routes.ingressRoutes > 0 || routes.ingresses > 0)) {
      throw new ValidationError(
        `Traefik still serves routes in ${routes.namespaces.length} namespace(s): ${routes.namespaces.join(', ')} (${routes.ingressRoutes} IngressRoute(s), ${routes.ingresses} Ingress object(s))`,
        'Set `proxy.enabled: false` and deploy those stacks, remove those Ingress objects, or re-run with `--force`.',
      );
    }
  }

  declaredNote(ctx, target);

  const timeoutS = resolveTimeoutS(ctx, options.timeout, target.declared, options.system === true);
  printIntro(`Uninstall Helm release ${target.name} - ${ctx.env}`);
  printTableRow('Release', target.name);
  printTableRow('Namespace', target.namespace);
  printTableRow('Chart', target.status.chart);
  printTableRow('Revision', String(target.status.revision));
  printTableRow(
    'Volumes',
    options.volumes
      ? `deleted: ${surviving.concat(boundVolumes).join(', ') || 'none'}`
      : options.keepVolumes
        ? `kept: ${surviving.concat(deletable).join(', ') || 'none'}`
        : 'none owned',
  );

  const confirmed = await confirmOrThrow(
    options.volumes
      ? { yes: options.yes, typed: ctx.env, message: `Type '${ctx.env}' to uninstall ${target.name} and delete its volumes:` }
      : { yes: options.yes, message: `Uninstall Helm release ${target.name} from ${ctx.env}?` },
  );
  if (!confirmed) {
    printInfo('Cancelled');
    return;
  }

  await withHelmLock(ctx, { system: target.system, message: `Helm uninstall ${target.name}` }, async () => {
    // design-04 3.10 `keepVolumes(entry)`: patch the deletable PVCs' bound PVs to Retain before the
    // uninstall, so a failed uninstall leaves every policy exactly as it was (never a PV stuck on
    // Delete with nothing to restore it). Optional: without `retainVolumes` only the claim-template
    // survivors are protected (Helm never deletes those on its own).
    if (options.keepVolumes && boundVolumes.length > 0) {
      await ctx.orchestrator.volumes.retainVolumes?.(volumeScopeFor(ctx, target.namespace), boundVolumes);
    }
    await ctx.helm.uninstall(target.namespace, target.name, { timeoutS, description: 'Dockflow manual uninstall', events: eventsToOutput });
    if (options.volumes) {
      // survivingPvcs (still claims after uninstall) + the PVs released by it (found by name before
      // the claim was deleted, design-04 3.10 step 0/2).
      const toDelete = [...surviving, ...boundVolumes];
      if (toDelete.length > 0) {
        await ctx.orchestrator.volumes.remove(volumeScopeFor(ctx, target.namespace), toDelete);
      }
    }
    if (options.system) {
      // design-04 3.12.6 step 11: forget the ownership record so a later ensure() from any owner
      // recreates it. Optional: without it, the ConfigMap is left in place and overwritten the same
      // way on the next ensure().
      await ctx.orchestrator.proxy.forget?.();
    }
  });

  printOutro(`Helm release ${target.name} uninstalled`);
  if (options.keepVolumes && (surviving.length > 0 || deletable.length > 0)) {
    printRaw(colors.dim(`Kept volumes: ${[...surviving, ...deletable].join(', ')}; delete them later with \`dockflow volumes rm ${ctx.env} <name>\`.`));
  }
  if (options.volumes) {
    printRaw(colors.dim(`Deleted ${surviving.length + boundVolumes.length} volume(s)`));
  }
  if (options.system) {
    printRaw(colors.dim('Traefik CRDs and existing IngressRoutes were kept; the next deploy with proxy.enabled installs Traefik again'));
  }
}

export function registerHelmUninstallCommand(helm: Command): void {
  helm
    .command('uninstall <env> [release]')
    .description('Uninstall a Helm release')
    .option('--system', 'Target the Dockflow Traefik release')
    .option('--volumes', 'Also delete the release volumes (DESTRUCTIVE)')
    .option('--keep-volumes', 'Keep the release volumes as released volumes')
    .option('--force', 'Skip the routes check (--system only)')
    .option('--timeout <duration>', 'Uninstall timeout (default: the release timeout)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(
      withErrorHandler(
        withResolvedEnv(async (env: string, release: string | undefined, options: HelmUninstallOptions) => {
          const ctx = await openHelmCommand(env, { server: options.server }, 'dockflow helm uninstall');
          await runHelmUninstall(ctx, release, options);
        }),
      ),
    );
}
