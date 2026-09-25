/**
 * `dockflow volumes rm <env> <name...>` (design-06 3.17, DESIGN-CORE C13): deletes persistent
 * volume data through the one deletion protocol (PD-15), with the deploy lock (2.8) and a typed
 * confirmation. Kubernetes only: refused on Swarm before any SSH (R-05).
 */

import type { Command } from 'commander';
import { requireCapabilityFor } from '../../services/orchestrator/capabilities';
import { K8S_SYSTEM_NAMESPACE } from '../../services/orchestrator/kubernetes/constants';
import type { OrchestratorKind, VolumeInfo, VolumeScope } from '../../services/orchestrator/interfaces';
import { loadConfig } from '../../utils/config';
import { DeployError, ErrorCode, ValidationError, withErrorHandler } from '../../utils/errors';
import { colors, printBlank, printInfo, printIntro, printOutro, printRaw, printSuccess, printWarning } from '../../utils/output';
import { dangerousConfirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface VolumesRemoveOptions {
  system?: boolean;
  namespace?: string;
  yes?: boolean;
  server?: string;
}

function column(value: string | null): string {
  return value ?? '-';
}

/** the configured orchestrator kind, read locally (before `openDay2`) so the refusal needs no probe */
function configuredOrchestratorKind(): OrchestratorKind {
  return loadConfig()?.orchestrator ?? 'swarm';
}

export async function runVolumesRemove(
  env: string,
  names: string[],
  options: VolumesRemoveOptions,
  getOrchestratorKind: () => OrchestratorKind = configuredOrchestratorKind,
): Promise<void> {
  requireCapabilityFor(getOrchestratorKind(), 'volumes', 'dockflow volumes rm');
  if (options.system && options.namespace !== undefined) {
    throw new ValidationError('--system and --namespace cannot be combined');
  }
  if (names.length === 0) {
    throw new ValidationError('Missing required argument: name', 'List the volumes with `dockflow volumes list <env>`.');
  }

  const ctx = await openDay2(env, { server: options.server });

  let namespace: string | undefined;
  if (options.system) {
    namespace = K8S_SYSTEM_NAMESPACE;
  } else if (options.namespace !== undefined) {
    const helm = ctx.orchestrator.helm;
    const releases = helm ? await helm.listAll(ctx.orchestrator.naming.scope(ctx.appRef)) : [];
    if (!releases.some((release) => release.namespace === options.namespace)) {
      throw new ValidationError(
        `Namespace ${options.namespace} holds no Helm release of ${ctx.stackName}`,
        `List the releases with \`dockflow helm list ${ctx.env}\`.`,
      );
    }
    namespace = options.namespace;
  }

  const scope: VolumeScope = {
    project: ctx.orchestrator.target.project,
    env: ctx.orchestrator.target.env,
    role: null,
    ...(namespace !== undefined ? { namespace } : {}),
  };

  printIntro(`Removing volumes - ${env}`);
  printBlank();

  // best-effort preview: the backend's own resolution (PVC name, compose name, or claim-template
  // key, design-06 3.17 step 1) is authoritative and runs again inside `remove`.
  const infos = await ctx.orchestrator.volumes.list(scope);
  const byName = new Map<string, VolumeInfo>();
  for (const info of infos) {
    byName.set(info.name, info);
    if (info.composeName) byName.set(info.composeName, info);
  }

  printWarning(`This will PERMANENTLY DELETE ${names.length} volume(s) and their data:`);
  for (const name of names) {
    const info = byName.get(name);
    printRaw(
      `  ${colors.info(name)} ` +
        (info ? `${column(info.capacity)} ${column(info.node)} ${column(info.hostPath)} reclaim ${column(info.reclaimPolicy)}` : colors.dim('(not previewed)')),
    );
  }
  if (options.system && names.includes('dockflow-traefik')) {
    printBlank();
    printWarning("Volume dockflow-traefik holds the ACME account key and every issued certificate; copy /data/acme.json out first (proxy documentation, `dockflow ssh " + env + '`)');
  }
  printBlank();

  if (!options.yes) {
    const confirmed = await dangerousConfirmPrompt({
      message: `Type '${env}' to permanently delete ${names.length} volume(s) and their data:`,
      expectedText: env,
    });
    if (!confirmed) {
      printInfo('Cancelled - text did not match');
      return;
    }
  }

  printBlank();
  const lock = ctx.lock();
  const acquired = await lock.acquire({ message: `Delete volumes ${names.join(', ')}` });
  if (!acquired.success) throw new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED);

  try {
    const report = await ctx.orchestrator.volumes.remove(scope, names);
    printSuccess(`Deleted ${report.deleted.length} volume(s)`);
    for (const deleted of report.deleted) printRaw(`Volume ${deleted.claim}: deleted`);
    for (const restored of report.restored) {
      printRaw(`Volume ${restored}: not deleted (its claim still exists); its reclaim policy was restored`);
    }
    for (const failed of report.restoreFailed) {
      printWarning(
        `Volume ${failed.volume}: not deleted and its reclaim policy could not be restored — it is ${failed.policy}. ` +
          `Restore it with \`dockflow ssh ${env}\`, then \`k3s kubectl patch pv ${failed.volume} --type=merge -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'\`.`,
      );
    }
  } finally {
    await lock.release();
  }

  printBlank();
  printOutro('Volumes removed');
}

export function registerVolumesRemoveCommand(volumes: Command): void {
  volumes
    .command('rm <env> <name...>')
    .alias('remove')
    .description('Delete persistent volumes and their data')
    .option('--system', 'Target the Dockflow system namespace')
    .option('--namespace <ns>', 'Target a Helm release namespace of this stack')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    // Commander's action callback appends the Command instance as a trailing argument, which would
    // otherwise clobber runVolumesRemove's test-only `getOrchestratorKind` default.
    .action(
      withErrorHandler(withResolvedEnv((env: string, names: string[], options: VolumesRemoveOptions) => runVolumesRemove(env, names, options))),
    );
}
