/**
 * Deploy command (DESIGN-CORE 2.2, design-03 3.2/3.3/3.6): `deploy`, `deploy --dry-run`.
 *
 * Orchestrator-neutral: every remote effect goes through `ctx.orchestrator` (deploy-phases.ts,
 * P64), so the same flow runs a k3s or a Swarm deploy. `resolveSetup` does every read that has no
 * side effect (render, resolve, connect); `execute` does the mutating flow and owns the
 * release-record invariant (core 2.2) and the deploy lock.
 */

import { relative } from 'path';
import type { Command } from 'commander';
import {
  getProjectRoot,
  getLayout,
  getPerformer,
} from '../utils/config';
import {
  printSuccess,
  printInfo,
  printIntro,
  printDebug,
  printBlank,
  printWarning,
  printRaw,
  setVerbose,
  isVerbose,
  createSpinner,
  outputEvents,
} from '../utils/output';
import { onInterrupt, SIGINT_EXIT_CODE } from '../utils/interrupt';
import { buildTemplateContext } from '../utils/servers';
import { confirmPrompt } from '../utils/prompts';
import { detectCIEnvironment, resolveDeployParams } from '../utils/ci';
import { getCurrentBranch } from '../utils/git';
import { getLatestVersion, incrementVersion } from '../utils/version';
import {
  CLIError,
  ConfigError,
  DeployError,
  ErrorCode,
  ValidationError,
  withErrorHandler,
} from '../utils/errors';
import { displayDeployDryRun } from './deploy-dry-run';

import * as Compose from '../services/compose';
import { Audit } from '../services/audit';
import { Metrics } from '../services/metrics';
import * as Notification from '../services/notification';
import * as Plugin from '../services/plugin';
import * as Hook from '../services/hook';
import { remoteHookContext } from '../services/hook';
import { rollbackRelease, cleanupReleases } from '../services/release';
import { openOrchestrator } from '../services/orchestrator/factory';
import { chartDisplay, checkAdoptNames, checkOnlyNames, syncNonTargetedHelmRecords } from '../services/orchestrator/kubernetes/helm/resolve';
import { valuesDiff, formatValuesDiff } from '../services/orchestrator/kubernetes/helm/values-diff';
import { CONVERGENCE_INTERVAL_S, CONVERGENCE_TIMEOUT_S } from '../constants';
import type {
  HelmBackend,
  HelmChartSource,
  Orchestrator,
  ReleaseMetadata,
  StackArtifact,
  StackDeployInput,
  StackRef,
} from '../services/orchestrator/interfaces';

import type { DeployContext, DeployOptions } from './deploy-context';
import { activeNodes } from './deploy-context';
import {
  buildAccessoriesInput,
  hasLiveAccessoryReleases,
  buildAndDistribute,
  buildStackInput,
  checkUploadPermissions,
  cleanupBundle,
  commitUploads,
  composeForDeploy,
  deployAccessories,
  deployApp,
  ensureRegistryAccess,
  parseOnly,
  printArtifactDiagnostics,
  recordHistory,
  releaseLock,
  resolveImageDelivery,
  rollbackUploads,
  runHTTPHealthChecks,
  runPostRollbackHealthChecks,
  uploadFiles,
  warnRegistryWithoutPassword,
  type BuildResult,
  type UploadRollbackPlan,
} from './deploy-phases';

/**
 * `deploy --adopt` and `--yes` are not part of `DeployOptions` (owned by P64,
 * `deploy-context.ts`): `adopt` already is, `yes` (non-interactive confirmation skip, used by the
 * adoption flow of design-04 3.7.4) is added locally, the way every other command adds its own flags.
 */
interface DeployCliOptions extends DeployOptions {
  yes?: boolean;
  /** deploy --server <name>: pin the control plane (core 6.6 step 2), same surface as every other orchestrator command */
  server?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Deployment target selection (which roles this invocation touches)
// ---------------------------------------------------------------------------

function getDeploymentTargets(options: Partial<DeployOptions>) {
  if (options.skipAccessories) return { deployApp: true, forceAccessories: false, skipAccessories: true };
  if (options.all) return { deployApp: true, forceAccessories: true, skipAccessories: false };
  if (options.accessories) return { deployApp: false, forceAccessories: true, skipAccessories: false };
  return { deployApp: true, forceAccessories: false, skipAccessories: false };
}

// ---------------------------------------------------------------------------
// Diagnostics labels (mirrors deploy-phases.ts's private accessoriesRelPath; DESIGN-CORE 8.2)
// ---------------------------------------------------------------------------

function accessoriesFileLabel(ctx: DeployContext): string {
  const layout = getLayout();
  return layout.accessoriesPath
    ? relative(ctx.projectRoot, layout.accessoriesPath).replace(/\\/g, '/')
    : '.dockflow/docker/accessories.yml';
}

function composeFileLabel(ctx: DeployContext): string {
  const layout = getLayout();
  return layout.composePath ? relative(ctx.projectRoot, layout.composePath).replace(/\\/g, '/') : 'docker-compose.yml';
}

// ---------------------------------------------------------------------------
// traefikOnCluster (design-04 2.9.2, core K28): the one cluster read the render needs
// ---------------------------------------------------------------------------

async function resolveTraefikOnCluster(ctx: DeployContext): Promise<boolean> {
  if (ctx.orchestrator.kind !== 'k3s') return false;
  // this deploy ensures/needs it (managing or consuming): the cluster read below is never needed
  if (ctx.config.proxy?.enabled === true) return true;
  try {
    const status = await ctx.orchestrator.proxy.status();
    return status.installed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// --only: borrow the previous release's Helm records for non-targeted releases (3.4.5, I18)
// ---------------------------------------------------------------------------

async function previousArtifactHelm(ctx: DeployContext) {
  const current = await ctx.orchestrator.releases.currentVersion(ctx.stackName);
  if (!current) return null;
  const artifact = await ctx.orchestrator.releases.readArtifact(ctx.stackName, current);
  return artifact.helm;
}

// ---------------------------------------------------------------------------
// Hooks — thin wrapper binding the phase to this deploy's remote context (design-03 3.3)
// ---------------------------------------------------------------------------

async function runDeployHook(ctx: DeployContext, phase: Hook.HookPhase, env?: Record<string, string>): Promise<void> {
  const remote = remoteHookContext(ctx.orchestrator, ctx.deployVersion, ctx.target.controlPlane.connection);
  await Hook.runHook(phase, ctx.projectRoot, ctx.config, ctx.rendered, remote, env ? { env } : {});
}

// ---------------------------------------------------------------------------
// --adopt (design-04 3.7.4): read-only diff + confirmation, the upgrade itself runs under the lock
// ---------------------------------------------------------------------------

async function confirmYesNo(options: Partial<DeployCliOptions>, promptMessage: string): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY) return false;
  return confirmPrompt({ message: promptMessage, initialValue: false });
}

/** Prints the value diff for every `--adopt`ed release and confirms, before the lock. */
async function previewAdoptions(ctx: DeployContext, appInput: StackDeployInput): Promise<void> {
  const names = ctx.options.adopt;
  const helm = ctx.orchestrator.helm;
  if (!names?.length || !helm) return;

  for (const release of appInput.helm.filter((r) => names.includes(r.name))) {
    const deployed = await helm.deployedValues(release.namespace, release.name);
    const diff = valuesDiff(deployed?.values ?? null, release.values);
    printInfo(`Adopting Helm release ${release.name} (${chartDisplay(release.chart, release.version)}) in ${release.namespace}`);
    for (const line of formatValuesDiff(diff)) printRaw(line);

    if (!ctx.options.dryRun) {
      const confirmed = await confirmYesNo(ctx.options as Partial<DeployCliOptions>, `Dockflow will manage ${release.name} from now on and replace its values. Continue?`);
      if (!confirmed) throw new ValidationError('Confirmation required', 'Re-run with `--yes` in non-interactive sessions.');
    }
  }
}

/** Takes over the named releases under the lock, before the ordinary deploy sees them as unchanged. */
async function applyAdoptions(ctx: DeployContext, appInput: StackDeployInput): Promise<void> {
  const names = ctx.options.adopt;
  const helm = ctx.orchestrator.helm as HelmBackend | null;
  if (!names?.length || !helm) return;

  const historyMax = Math.max(5, (ctx.config.stack_management?.keep_releases ?? 3) + 2);
  // the id the ownership labels carry, as for every other Helm call: the stack name is not it
  const stackId = ctx.orchestrator.naming.scope({ project: ctx.config.project_name, env: ctx.env, role: 'app' });
  for (const release of appInput.helm.filter((r) => names.includes(r.name))) {
    const result = await helm.upgradeInstall(release, {
      historyMax,
      stackId,
      description: `Dockflow ${ctx.deployVersion}`,
      adopt: true,
    });
    printSuccess(`Helm release ${release.name} is now managed by Dockflow; its previous revision is ${result.previousRevision ?? '-'} in \`dockflow helm history ${ctx.env} ${release.name}\``);
  }
}

// ---------------------------------------------------------------------------
// resolveSetup — no remote writes except the read-only connect + probe of openOrchestrator
// ---------------------------------------------------------------------------

async function resolveSetup(rawEnv: string | undefined, rawVersion: string | undefined, options: Partial<DeployCliOptions>): Promise<{ ctx: DeployContext } | null> {
  let env = rawEnv;
  let version = rawVersion;

  if (!env) {
    const ci = detectCIEnvironment();
    if (ci) {
      const params = resolveDeployParams(ci);
      env = params.env;
      version = version ?? params.version;
      printInfo(`CI detected (${ci.provider}): deploying to ${env} with version ${version}`);
    } else {
      throw new ConfigError('Environment is required', 'Usage: dockflow deploy <env> [version]\nIn CI, environment and version are auto-detected from git tag/branch.');
    }
  }

  const { deployApp: shouldDeployApp, forceAccessories, skipAccessories } = getDeploymentTargets(options);
  const accessoriesDesc = skipAccessories ? '' : forceAccessories ? ' + Accessories (forced)' : ' + Accessories (auto)';
  const targetDesc = options.accessories ? 'Accessories only' : `App${accessoriesDesc}`;

  printIntro(`Deploying ${targetDesc} to ${env}`);
  printBlank();

  const { config, orchestrator } = await openOrchestrator(env, {
    server: options.server,
    failover: options.failover !== false,
    requireWorkerCredentials: true,
    onProbe: (p) => printDebug(`probe ${p.node}: ${p.status}${p.detail ? ` (${p.detail})` : ''}`),
  });
  const target = orchestrator.target;
  env = target.env;

  // R-S2-04: printed once probing (if any) has already settled — `onProbe` above only fires after
  // every candidate manager has answered, so there is no earlier point at which the count is known.
  if (target.probes.length > 0) {
    printInfo(`Checking ${target.probes.length} managers...`);
    const chosen = target.probes.find((p) => p.node === target.controlPlane.name);
    printInfo(`Using ${target.controlPlane.name} (${chosen?.status ?? 'ready'})`);
  }

  if (config.options?.enable_debug_logs) setVerbose(true);

  const branchName = options.branch || getCurrentBranch();
  let deployVersion: string;
  if (version) {
    deployVersion = version;
  } else {
    const versionSpinner = createSpinner();
    versionSpinner.start('Fetching latest deployed version...');
    const latestVersion = await getLatestVersion(orchestrator, target.stackName);
    if (latestVersion) {
      deployVersion = incrementVersion(latestVersion);
      versionSpinner.succeed(`Latest version: ${latestVersion} -> New version: ${deployVersion}`);
    } else {
      deployVersion = '1.0.0';
      versionSpinner.info('No previous deployment found, starting at 1.0.0');
    }
  }

  const projectRoot = getProjectRoot();

  printInfo(`Version: ${deployVersion}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Control plane: ${isVerbose() ? `${target.controlPlane.name} (${target.controlPlane.host})` : target.controlPlane.name}`);
  if (target.workers.length > 0) printInfo(`Workers: ${target.workers.map((w) => (isVerbose() ? `${w.name} (${w.host})` : w.name)).join(', ')}`);
  if (target.kind === 'k3s') printInfo(`Namespace: ${orchestrator.naming.scope({ project: config.project_name, env, role: 'app' })}`);
  printInfo(`Branch: ${branchName}`);
  printInfo(`Targets: ${targetDesc}`);
  if (options.only) printInfo(`Only: ${options.only}`);
  printBlank();

  const templateContext = buildTemplateContext(env, target.controlPlane.name);
  const { rendered, composeContent, composeDirPath, renderContext } = Compose.renderAndResolveCompose(
    { env, version: deployVersion, branch: branchName, project_name: config.project_name, config },
    templateContext,
    { composeOptional: Compose.composeFileOptional(config) },
  );
  const pluginsLoaded = await Plugin.loadConfigWithPlugins({ rendered, fallback: config, projectRoot, projectContext: renderContext });
  const finalConfig = pluginsLoaded.config;

  if (options.only) {
    const compose = Compose.loadFromString(composeContent);
    checkOnlyNames(parseOnly(options.only), Object.keys(compose.services), finalConfig.helm);
  }
  if (options.adopt?.length) {
    checkAdoptNames(options.adopt, finalConfig.helm);
  }

  const ctx: DeployContext = {
    env,
    config: finalConfig,
    stackName: target.stackName,
    branchName,
    deployVersion,
    projectRoot,
    target,
    orchestrator,
    deployApp: shouldDeployApp,
    forceAccessories,
    skipAccessories,
    options,
    rendered,
    composeContent,
    composeDirPath,
    audit: new Audit(target.controlPlane.connection),
    metrics: new Metrics(target.controlPlane.connection),
    revertedTo: null,
    applyStarted: false,
    appSettled: false,
    cleanupOrchestrator: null,
    traefikOnCluster: false,
  };

  if (options.dryRun) {
    await displayDeployDryRun(ctx, pluginsLoaded.pluginSummary);
    return null;
  }

  return { ctx };
}

// ---------------------------------------------------------------------------
// execute — lock, phases, rollback, audit, unlock (design-03 3.3, DESIGN-CORE 2.2)
// ---------------------------------------------------------------------------

export async function execute(ctx: DeployContext): Promise<void> {
  const orch = ctx.orchestrator;
  const lock = orch.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
  const acquired = await lock.acquire({ version: ctx.deployVersion, force: ctx.options.force, message: `Deploy ${ctx.deployVersion}` });
  // a CLIError is the cluster failing to answer, anything else another holder: only that is DEPLOY_LOCKED
  if (!acquired.success) throw acquired.error instanceof CLIError ? acquired.error : new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED);

  const appRef: StackRef = { project: ctx.config.project_name, env: ctx.env, role: 'app' };
  const startTime = Date.now();
  let deployFailed = false;
  let appDeployed = false;
  let releaseCreated = false;
  let previous: string | null = null;
  let build: BuildResult | null = null;
  let uploadPlan: UploadRollbackPlan | null = null;
  let auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env}`;
  let interrupted = false;

  const handleSignal = (): void => {
    if (interrupted) return;
    interrupted = true;
    printWarning('\nDeploy interrupted — cleaning up before exit...');
    (async () => {
      if (uploadPlan) await rollbackUploads(uploadPlan).catch(() => {});
      if (releaseCreated && (!ctx.applyStarted || ctx.appSettled)) {
        await orch.releases.remove(ctx.stackName, ctx.deployVersion, { restoreCurrentTo: previous }).catch(() => {});
      } else if (ctx.applyStarted) {
        printWarning(`Version ${ctx.deployVersion} was applied but its state is unknown; run dockflow status ${ctx.env}`);
      }
      await orch.proxy.releaseLock?.().catch(() => {});
      await lock.release().catch(() => {});
    })().finally(() => process.exit(SIGINT_EXIT_CODE));
  };
  const stopHandlingInterrupts = onInterrupt(handleSignal);

  try {
    const compose = await composeForDeploy(ctx);
    const delivery = resolveImageDelivery(ctx.config, compose);
    warnRegistryWithoutPassword(ctx.config);

    // 0. the one read the render needs (core K28): does a Dockflow-owned Traefik exist on the cluster?
    ctx.traefikOnCluster = await resolveTraefikOnCluster(ctx);

    // 1. render both roles BEFORE any remote mutation (m14/K73)
    let appInput = buildStackInput(ctx, 'app', compose, delivery);
    const previousHelm = ctx.options.only || appInput.helm.length > 0 ? await previousArtifactHelm(ctx) : null;
    if (ctx.options.only) {
      appInput = { ...appInput, helm: syncNonTargetedHelmRecords(appInput.helm, previousHelm, parseOnly(ctx.options.only)) };
    }
    // The release record is written before the apply, so the chart bytes it names are fixed now:
    // a chart republished under an unchanged version is refused instead of installed (3.4.4).
    if (orch.helm && appInput.helm.length > 0) {
      appInput = { ...appInput, helm: await orch.helm.pinCharts(appInput.helm, previousHelm ?? [], { allowChartDrift: false }) };
    }
    const appArtifact = orch.stack.render(appInput);
    printArtifactDiagnostics(composeFileLabel(ctx), appArtifact);

    const accInput = buildAccessoriesInput(ctx, delivery, await hasLiveAccessoryReleases(ctx));
    const accArtifact = accInput ? orch.stack.render(accInput) : null;
    if (accInput && accArtifact) printArtifactDiagnostics(accessoriesFileLabel(ctx), accArtifact);

    await previewAdoptions(ctx, appInput);

    // 2. remote work starts here
    await checkUploadPermissions(ctx);
    build = await buildAndDistribute(ctx, compose, delivery);
    await ensureRegistryAccess(ctx, appRef);

    await runDeployHook(ctx, 'pre-upload');
    uploadPlan = await uploadFiles(ctx);
    await runDeployHook(ctx, 'post-upload');
    await runDeployHook(ctx, 'pre-deploy');

    // 3. proxy before anything that can render routes (K09), whenever anything is deployed
    const anythingDeployed = ctx.deployApp || accInput !== null;
    if (ctx.config.proxy?.enabled && anythingDeployed) {
      await orch.proxy.plan(ctx.config.proxy, ctx.env, ctx.rendered);
      await orch.proxy.ensure(ctx.config.proxy, ctx.env, outputEvents, ctx.rendered);
    }

    await applyAdoptions(ctx, appInput);

    // Settled, not Promise.all: when accessories fail first, the release write must still hand back
    // the symlink/`previous` to restore.
    const [releaseOutcome, accessoriesOutcome] = await Promise.allSettled([
      ctx.deployApp
        ? orch.releases.create(ctx.stackName, {
            version: ctx.deployVersion,
            compose: Compose.serialize(compose),
            artifact: appArtifact,
            metadata: buildReleaseMetadata(ctx, orch, appArtifact, accArtifact),
          })
        : orch.releases.currentVersion(ctx.stackName).then((v) => ({ previous: v })),
      deployAccessories(ctx, accInput),
    ]);
    if (releaseOutcome.status === 'rejected') throw releaseOutcome.reason;
    previous = releaseOutcome.value.previous;
    releaseCreated = ctx.deployApp;
    if (accessoriesOutcome.status === 'rejected') throw accessoriesOutcome.reason;

    await deployApp(ctx, { ...appInput, previousVersion: previous });
    appDeployed = ctx.deployApp && (Compose.hasServices(compose) || appInput.helm.length > 0);

    await runHTTPHealthChecks(ctx);
    await runDeployHook(ctx, 'post-deploy');

    await Promise.all([
      cleanupReleases(orch, ctx.stackName, ctx.config.stack_management?.keep_releases ?? 3),
      commitUploads(uploadPlan).catch((e) => printWarning(`Upload commit failed: ${message(e)}`)),
    ]);
    auditMessage = `Deployed ${ctx.deployVersion} to ${ctx.env} successfully`;
  } catch (err) {
    deployFailed = true;
    auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env} failed: ${message(err)}`;

    if (uploadPlan) await rollbackUploads(uploadPlan).catch((e) => printWarning(`Upload rollback failed: ${message(e)}`));

    let rolledBackTo: string | null = null;
    const bundle = await cleanupBundle(ctx, err);
    ctx.cleanupOrchestrator = bundle;

    if (appDeployed && ctx.config.health_checks?.on_failure === 'rollback' && previous && previous !== ctx.deployVersion) {
      try {
        rolledBackTo = await rollbackRelease(bundle, {
          ref: appRef,
          stackName: ctx.stackName,
          to: previous,
          failedVersion: ctx.deployVersion,
          wait: { timeoutS: CONVERGENCE_TIMEOUT_S, intervalS: CONVERGENCE_INTERVAL_S },
        });
        printWarning(`Rolled back to ${rolledBackTo}`);
        await runPostRollbackHealthChecks(ctx.config, bundle);
      } catch (e) {
        printWarning(`Rollback failed: ${message(e)}\nThe cluster may be in an inconsistent state. Run 'dockflow status ${ctx.env}' to check what is running.`);
        printWarning(`Release ${ctx.deployVersion} is deployed but the deploy reported a failure; current stays ${ctx.deployVersion}`);
      }
    } else if (appDeployed || (ctx.applyStarted && !ctx.appSettled)) {
      // K08: once the app was applied, the release record and `current` are never rewound.
      if (previous === ctx.deployVersion) printWarning(`Release ${ctx.deployVersion} was redeployed in place; nothing distinct to roll back to`);
      else if (appDeployed) printWarning(`Release ${ctx.deployVersion} is deployed but the deploy reported a failure; current stays ${ctx.deployVersion}`);
      else printWarning(`Version ${ctx.deployVersion} was applied but its state is unknown; run dockflow status ${ctx.env}`);
    } else if (releaseCreated) {
      await bundle.releases.remove(ctx.stackName, ctx.deployVersion, { restoreCurrentTo: previous }).catch((e) => printWarning(`Release cleanup failed: ${message(e)}`));
    }

    // after rollback/revert so that in-use protection sees the settled cluster (I-18)
    if (build && ctx.config.stack_management?.cleanup_on_failure !== false && build.delivery.mode === 'import') {
      await bundle.images.remove(build.images, activeNodes(ctx.target)).catch((e) => printWarning(`Image cleanup failed: ${message(e)}`));
    }

    await runDeployHook(ctx, 'on-failure', {
      DOCKFLOW_ERROR: message(err),
      DOCKFLOW_ROLLED_BACK_TO: rolledBackTo ?? ctx.revertedTo ?? '',
    }).catch((e) => printWarning(`on-failure hooks could not run: ${message(e)}`));

    if (rolledBackTo) {
      // the cause keeps its code (53 for a failed health check) and its text, as the native revert does
      const cause = CLIError.from(err, ErrorCode.DEPLOY_FAILED);
      throw new DeployError(`${cause.message}; rolled back to ${rolledBackTo}`, cause.code, cause.suggestion);
    }
    throw err;
  } finally {
    stopHandlingInterrupts();
    const durationMs = Date.now() - startTime;
    const status = deployFailed ? 'failed' : 'success';

    await recordHistory(ctx, status, durationMs, auditMessage);
    await Notification.notify(ctx.config.notifications?.webhooks, {
      project: ctx.config.project_name,
      env: ctx.env,
      version: ctx.deployVersion,
      branch: ctx.branchName,
      performer: getPerformer(),
      status,
      duration_ms: durationMs,
      message: auditMessage,
    });
    await releaseLock(ctx, lock, acquired.data);
  }

  const managerCount = ctx.target.managers.length;
  const workerCount = ctx.target.workers.length;
  const totalNodes = managerCount + workerCount;
  printBlank();
  printSuccess(totalNodes > 1 ? `Deployment completed! Cluster: ${managerCount} manager(s) + ${workerCount} worker(s)` : 'Deployment completed!');
}

function chartLabel(chart: HelmChartSource): string {
  return chart.kind === 'oci' ? chart.ref : `${chart.repo}#${chart.chart}`;
}

function buildReleaseMetadata(ctx: DeployContext, orch: Orchestrator, appArtifact: StackArtifact, accArtifact: StackArtifact | null): ReleaseMetadata {
  const now = new Date();
  return {
    project_name: ctx.config.project_name,
    version: ctx.deployVersion,
    env: ctx.env,
    timestamp: now.toISOString(),
    epoch: Math.floor(now.getTime() / 1000),
    performer: getPerformer(),
    branch: ctx.branchName,
    orchestrator: orch.kind,
    artifact_format: orch.capabilities.artifactFormat,
    helm: appArtifact.helm.map((h) => ({
      name: h.name,
      chart: chartLabel(h.chart),
      version: h.version,
      values_sha256: h.valuesSha256,
      chart_sha256: h.chartSha256,
    })),
    accessories_digest: accArtifact?.digest ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runDeploy(env: string | undefined, version: string | undefined, options: Partial<DeployCliOptions>): Promise<void> {
  if (options.debug) setVerbose(true);
  const setup = await resolveSetup(env, version, options);
  if (!setup) return;
  await execute(setup.ctx);
}

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy [env] [version]')
    .description('Deploy application to specified environment')
    .helpGroup('Deploy')
    .option('--only <services>', 'Comma-separated list of services (or app Helm releases) to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .option('--accessories', 'Deploy only accessories (databases, caches, etc.)')
    .option('--all', 'Deploy both application and accessories')
    .option('--skip-accessories', 'Skip accessories check entirely')
    .option('--no-failover', 'Disable multi-manager failover (use first manager only)')
    .option('-s, --server <name>', 'Target server (defaults to first ready manager)')
    .option('--dry-run', 'Show what would be deployed without executing')
    .option('--render', 'With --dry-run: print the rendered manifests (secrets masked)')
    .option('--branch <branch>', 'Override auto-detected git branch')
    .option('--adopt <name>', 'Take over a Helm release installed outside Dockflow (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--rebind-volumes', 'Accept a claim-shape change that repoints a service at another claim')
    .option('-y, --yes', 'Skip interactive confirmations')
    .option('--debug', 'Enable debug output')
    .action(
      withErrorHandler(async (env: string | undefined, version: string | undefined, options: DeployCliOptions & { render?: boolean }) => {
        await runDeploy(env, version, options);
      }),
    );
}
