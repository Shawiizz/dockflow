/**
 * Deploy phases — self-contained steps called by `deploy.ts` (design-03 3.4, 12, 19.3).
 *
 * Orchestrator-agnostic: every remote effect goes through `ctx.orchestrator`, so the same code runs
 * a k3s or a Swarm deploy (DESIGN-CORE 2.2). k3s-only pieces (the normalizer call inside
 * `siblingInput`) are safe to run for Swarm too, because Swarm's StackBackend never reads
 * `StackDeployInput.sibling`.
 */

import { relative } from 'path';
import * as Build from '../services/build';
import * as Compose from '../services/compose';
import type { ParsedCompose } from '../services/compose';
import * as Distribution from '../services/distribution';
import type { ContainerRuntime } from '../services/distribution';
import { createFileResolver } from '../services/orchestrator/file-resolver';
import { convergenceFailureError, healthFailureError } from '../services/orchestrator/failure';
import { openOrchestrator } from '../services/orchestrator/factory';
import { requireCapability } from '../services/orchestrator/capabilities';
import { remoteHookContext, runHook } from '../services/hook';
import { DiagnosticSink } from '../services/orchestrator/diagnostics';
import type {
  DeployReceipt,
  ImageDelivery,
  LockData,
  LockStore,
  Orchestrator,
  RevertResult,
  StackArtifact,
  StackDeployInput,
  StackRef,
  StackRole,
} from '../services/orchestrator/interfaces';
import { k3sDistribution } from '../services/orchestrator/kubernetes/k3s/distribution';
import { namespaceFor } from '../services/orchestrator/kubernetes/naming';
import { normalizeStack } from '../services/orchestrator/kubernetes/normalize';
import type { StackIdentity } from '../services/orchestrator/kubernetes/model/types';
import { KubeError } from '../services/orchestrator/kubernetes/runtime/errors';
import { HealthCheck } from '../services/health-check';
import { renderedValuesFileLookup, resolveHelmReleases } from '../services/orchestrator/kubernetes/helm/resolve';
import { HEALTH_STABILITY_WINDOW_S, CONVERGENCE_INTERVAL_S, CONVERGENCE_TIMEOUT_S, DEFAULT_HEALTHCHECK_INTERVAL_S, DEFAULT_HEALTHCHECK_TIMEOUT_S, REGISTRY_PULL_SECRET_NAME } from '../constants';
import { getLayout, type DockflowConfig, type HealthCheckConfig } from '../utils/config';
import { OrchestratorUnavailableError } from '../utils/errors';
import { printDebug, printDim, printInfo, printSuccess, printWarning } from '../utils/output';
import { sshExec } from '../utils/ssh';
import type { DeployContext } from './deploy-context';
import { activeNodes } from './deploy-context';

/** the ONE registry predicate (design-03 12.1, K42); reused verbatim, never re-implemented here */
export { usesRegistry } from '../services/compose';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 12.1 Delivery mode (pure)
// ---------------------------------------------------------------------------

/**
 * Configuration-only, never a function of whether a build ran in this invocation: `--skip-build`
 * and `--accessories` deploys must render the exact same pod templates as a full deploy.
 */
export function resolveImageDelivery(config: DockflowConfig, compose: ParsedCompose): ImageDelivery {
  const hasBuilt = Object.values(compose.services).some((s) => s.build !== undefined);
  const registryMode = Compose.usesRegistry(config);
  return {
    built: [],
    mode: registryMode ? 'registry' : hasBuilt ? 'import' : 'none',
    pullSecretName: registryMode ? REGISTRY_PULL_SECRET_NAME : null,
  };
}

/** Said once per deploy (and as a validate diagnostic): the fallback is deliberate, not silent. */
export function warnRegistryWithoutPassword(config: DockflowConfig): void {
  const r = config.registry;
  if (r?.enabled === true && !!r.url && !r.password) {
    printWarning(`Registry ${r.url} is enabled but registry.password is not set; built images are distributed over SSH instead of pushed`);
  }
}

// ---------------------------------------------------------------------------
// 12.3 Registry pull secret
// ---------------------------------------------------------------------------

export async function ensureRegistryAccess(ctx: DeployContext, appRef: StackRef): Promise<string | null> {
  if (!Compose.usesRegistry(ctx.config)) return null;
  const r = ctx.config.registry!;
  return ctx.orchestrator.images.ensurePullSecret(appRef, { server: r.url!, username: r.username ?? '', password: r.password! });
}

// ---------------------------------------------------------------------------
// Build and distribute (12.2, through ImageBackend)
// ---------------------------------------------------------------------------

export interface BuildResult {
  images: string[];
  engine: ContainerRuntime;
  delivery: ImageDelivery;
}

async function pushBuiltImages(ctx: DeployContext, images: string[], engine: ContainerRuntime): Promise<void> {
  const r = ctx.config.registry!;
  await Distribution.registryLogin(ctx.target.controlPlane.connection, { url: r.url!, username: r.username, password: r.password! }, engine);
  await Distribution.pushImages(
    images,
    r.additional_tags?.length ? { tags: r.additional_tags, env: ctx.env, version: ctx.deployVersion, branch: ctx.branchName } : undefined,
    engine,
  );
}

async function distributeOrPush(ctx: DeployContext, images: string[], delivery: ImageDelivery, engine: ContainerRuntime): Promise<void> {
  if (images.length === 0) return;
  if (delivery.mode === 'registry') {
    await pushBuiltImages(ctx, images, engine);
    return;
  }
  await ctx.orchestrator.images.distribute(images, activeNodes(ctx.target));
}

/** `pre-build` / `post-build` run locally by default, remotely on `options.remote_build` (8.8). */
async function runBuildHook(ctx: DeployContext, phase: 'pre-build' | 'post-build'): Promise<void> {
  const remote = ctx.config.options?.remote_build ? remoteHookContext(ctx.orchestrator, ctx.deployVersion) : undefined;
  await runHook(phase, ctx.projectRoot, ctx.config, ctx.rendered, remote);
}

export async function buildAndDistribute(ctx: DeployContext, compose: ParsedCompose, delivery: ImageDelivery): Promise<BuildResult | null> {
  if (ctx.options.skipBuild || !ctx.deployApp) return null;
  if (!Compose.hasServices(compose)) return null;

  await runBuildHook(ctx, 'pre-build');

  const connection = ctx.target.controlPlane.connection;
  const engine: ContainerRuntime = Distribution.detectLocalEngine(ctx.config.container_engine);
  let images: string[] = [];

  if (ctx.config.options?.remote_build) {
    requireCapability(ctx.orchestrator, 'remoteBuild', 'options.remote_build');
    ({ images } = await Build.buildRemote(connection, {
      projectRoot: ctx.projectRoot,
      composeContent: Compose.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.only,
      engine,
    }));
    await distributeOrPush(ctx, images, delivery, engine);
  } else {
    const targets = Build.getBuildTargets(Compose.serialize(compose), ctx.composeDirPath, ctx.options.only);
    if (targets.length > 0) {
      const archResult = await sshExec(connection, 'uname -m');
      const remoteArch = archResult.stdout.trim();
      const platform = remoteArch === 'aarch64' || remoteArch === 'arm64' ? 'linux/arm64' : 'linux/amd64';

      for (const target of targets) {
        target.renderedOverrides = Build.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
        target.platform = platform;
        target.engine = engine;
      }

      ({ images } = await Build.buildAll(targets));
      await distributeOrPush(ctx, images, delivery, engine);
    }
  }

  await runBuildHook(ctx, 'post-build');
  return { images, engine, delivery };
}

// ---------------------------------------------------------------------------
// 3.4 buildStackInput / siblingInput / buildAccessoriesInput
// ---------------------------------------------------------------------------

function accessoriesRelPath(ctx: DeployContext): string {
  const layout = getLayout();
  return layout.accessoriesPath ? relative(ctx.projectRoot, layout.accessoriesPath).replace(/\\/g, '/') : '.dockflow/docker/accessories.yml';
}

function loadAccessoriesCompose(ctx: DeployContext): ParsedCompose | null {
  const content = ctx.rendered.get(accessoriesRelPath(ctx));
  return content ? Compose.loadFromString(content) : null;
}

function configSourceOf(ctx: DeployContext): { file: string; text: string } {
  const layout = getLayout();
  const file = relative(ctx.projectRoot, layout.configPath).replace(/\\/g, '/');
  return { file, text: ctx.rendered.get(file) ?? '' };
}

/** Names of every Helm release of `role` declared in config.yml, --only filtering included (8.5). */
export function declaredHelmNames(config: DockflowConfig, role: StackRole): string[] {
  return (config.helm?.releases ?? []).filter((r) => (r.role ?? 'app') === role).map((r) => r.name);
}

export function parseOnly(only: string): string[] {
  return only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pure: the sibling file is normalized first (core 3 / K27) so the checks that need more than keys
 * (external volumes, aliases, published ports, middleware names) have their inputs. Diagnostics of
 * this pass are discarded: only the sibling's own render can report on its own compose file.
 */
export function siblingInput(ctx: DeployContext, other: ParsedCompose | null, role: StackRole): StackDeployInput['sibling'] {
  const empty: StackDeployInput['sibling'] = { services: [], volumes: [], middlewares: [] };
  if (!other) return empty;

  const identity: StackIdentity = {
    project: ctx.config.project_name,
    env: ctx.env,
    stackName: ctx.stackName,
    namespace: namespaceFor(ctx.config.project_name, ctx.env),
    version: ctx.deployVersion,
  };

  const { stack } = normalizeStack({
    compose: other,
    role: role === 'app' ? 'accessory' : 'app',
    identity,
    proxy: ctx.config.proxy,
    sibling: empty,
    serverNames: activeNodes(ctx.target).map((n) => n.name),
    imageDelivery: 'none',
    files: createFileResolver(ctx.rendered, ctx.projectRoot, ctx.composeDirPath),
    traits: k3sDistribution.traits,
    sink: new DiagnosticSink(),
  });

  return {
    services: stack.services.map((s) => ({
      key: s.composeName,
      name: s.name,
      aliases: s.network.aliases,
      published: s.ports.filter((p) => p.published !== null).map((p) => ({ port: p.published as number, protocol: p.protocol })),
    })),
    volumes: stack.volumes.map((v) => ({ key: v.key, claimName: v.name, external: v.external })),
    middlewares: stack.middlewares.map((m) => m.name),
  };
}

export function buildStackInput(
  ctx: DeployContext,
  role: StackRole,
  compose: ParsedCompose,
  delivery: ImageDelivery,
  force = false,
): StackDeployInput {
  const other = role === 'app' ? loadAccessoriesCompose(ctx) : Compose.loadFromString(ctx.composeContent);
  const composeServices = {
    app: Object.keys((role === 'app' ? compose : other)?.services ?? {}),
    accessory: Object.keys((role === 'accessory' ? compose : other)?.services ?? {}),
  };

  const { releases } = resolveHelmReleases({
    helm: ctx.config.helm,
    role,
    stackNamespace: namespaceFor(ctx.config.project_name, ctx.env),
    configSource: configSourceOf(ctx),
    readValuesFile: renderedValuesFileLookup(ctx.rendered),
    composeServices,
    noServices: ctx.config.no_services === true,
    templates: ctx.config.templates,
  });

  return {
    ref: { project: ctx.config.project_name, env: ctx.env, role },
    version: ctx.deployVersion,
    compose,
    proxy: ctx.config.proxy,
    services: role === 'app' && ctx.options.only ? parseOnly(ctx.options.only) : null,
    previousVersion: null,
    force,
    images: delivery,
    helm: releases,
    helmDeclared: declaredHelmNames(ctx.config, role),
    sibling: siblingInput(ctx, other, role),
    serverNames: activeNodes(ctx.target).map((n) => n.name),
    rebindVolumes: ctx.options.rebindVolumes === true,
    traefikOnCluster: ctx.traefikOnCluster,
    files: createFileResolver(ctx.rendered, ctx.projectRoot, ctx.composeDirPath),
  };
}

export function buildAccessoriesInput(ctx: DeployContext, delivery: ImageDelivery): StackDeployInput | null {
  if (ctx.skipAccessories) return null;
  const compose = loadAccessoriesCompose(ctx);
  if (!compose) return null;
  Compose.injectAccessoriesDefaults(compose, ctx.orchestrator.kind);
  return buildStackInput(ctx, 'accessory', compose, delivery, ctx.forceAccessories);
}

// ---------------------------------------------------------------------------
// 8.2 Diagnostics printing (once per role)
// ---------------------------------------------------------------------------

export function printArtifactDiagnostics(file: string, artifact: StackArtifact): void {
  for (const d of artifact.diagnostics) {
    if (d.severity === 'info') {
      printDebug(`${file} ${d.path}: ${d.message}`);
      continue;
    }
    printWarning(`${file} ${d.path}: ${d.message}`);
    if (d.hint) printDim(`  ${d.hint}`);
  }
}

// ---------------------------------------------------------------------------
// deployAccessories / deployApp (3.4)
// ---------------------------------------------------------------------------

const NATIVE: RevertResult = { status: 'native', services: [] };

/** K08: does this revert prove the app role runs what `previous` describes again? Pure. */
export function settles(r: RevertResult, previousVersion: string | null, nativeRolledBack: boolean): boolean {
  if (r.status === 'native') return nativeRolledBack;
  if (r.status === 'reverted') return true;
  return r.status === 'nothing-to-revert' && previousVersion === null;
}

async function revertIfBackend(ctx: DeployContext, receipt: DeployReceipt): Promise<RevertResult> {
  if (ctx.orchestrator.capabilities.revert === 'native') return NATIVE;
  const result = await ctx.orchestrator.stack.revert(receipt);
  if (result.status === 'reverted' && receipt.ref.role === 'app') ctx.revertedTo = receipt.previousVersion;
  return result;
}

export async function deployAccessories(ctx: DeployContext, input: StackDeployInput | null): Promise<void> {
  if (!input) return; // skipped or no accessories.yml
  const stack = ctx.orchestrator.stack; // already rendered and printed by execute()
  const deployed = await stack.deploy(input);
  if (!deployed.success) throw deployed.error;
  const receipt = deployed.data;
  if (receipt.skipped) {
    printInfo('Accessories unchanged, skipping');
    return;
  }

  const convergence = await stack.waitConvergence(receipt, { timeoutS: CONVERGENCE_TIMEOUT_S, intervalS: CONVERGENCE_INTERVAL_S });
  if (convergence.status !== 'converged') {
    const revert = convergence.status === 'reverted' ? NATIVE : await revertIfBackend(ctx, receipt);
    throw convergenceFailureError(convergence, revert, { env: ctx.env, role: 'accessory', previousVersion: null });
  }
  await stack.finalize(receipt);
  printSuccess('Accessories deployed');
}

export async function deployApp(ctx: DeployContext, input: StackDeployInput): Promise<void> {
  if (!ctx.deployApp) return;
  const hasServices = Compose.hasServices(input.compose);
  if (!hasServices && input.helm.length === 0) return; // Helm-only projects still deploy (design-04 3.11)

  const orch = ctx.orchestrator;
  // proxy.ensure already ran in execute() (K09), before accessories and independently of deployApp

  const deployed = await orch.stack.deploy({
    ...input,
    onApplyProgress: (p) => {
      if (p.kind === 'started') ctx.applyStarted = true;
      else ctx.appSettled = settles(p.revert, input.previousVersion, false);
    },
  });
  if (!deployed.success) throw deployed.error; // backend already reverted a partial apply (5.8)
  const receipt = deployed.data;

  const convergence = await orch.stack.waitConvergence(receipt, { timeoutS: CONVERGENCE_TIMEOUT_S, intervalS: CONVERGENCE_INTERVAL_S });
  if (convergence.status !== 'converged') {
    const revert = convergence.status === 'reverted' ? NATIVE : await revertIfBackend(ctx, receipt);
    ctx.appSettled = settles(revert, input.previousVersion, convergence.status === 'reverted');
    throw convergenceFailureError(convergence, revert, { env: ctx.env, role: 'app', previousVersion: input.previousVersion });
  }

  const hc = ctx.config.health_checks;
  if (hc?.enabled !== false) {
    const health = await orch.stack.checkHealth(receipt, {
      timeoutS: hc?.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_S,
      intervalS: hc?.interval ?? DEFAULT_HEALTHCHECK_INTERVAL_S,
      stabilityS: HEALTH_STABILITY_WINDOW_S,
    });
    if (!health.healthy) {
      const revert = health.rolledBack ? NATIVE : await revertIfBackend(ctx, receipt);
      ctx.appSettled = settles(revert, input.previousVersion, health.rolledBack);
      throw healthFailureError(health, revert, { env: ctx.env, role: 'app', previousVersion: input.previousVersion });
    }
  }

  await orch.stack.finalize(receipt); // never throws (I-19)
}

// ---------------------------------------------------------------------------
// HTTP health checks (health-check.ts keeps the endpoint logic; this decides when to run it)
// ---------------------------------------------------------------------------

export async function runHTTPHealthChecks(ctx: DeployContext): Promise<void> {
  if (!ctx.deployApp || !ctx.config.health_checks?.endpoints?.length) return;
  const health = new HealthCheck(ctx.target.controlPlane.connection);
  await health.checkHTTPEndpoints(ctx.config.health_checks);
}

/**
 * Best-effort only: there is nothing left to roll back to if this fails. `on_failure` is forced to
 * `notify` because rolling back a rollback is not an option.
 */
export async function runPostRollbackHealthChecks(ctx: DeployContext, orchestrator: Orchestrator): Promise<void> {
  const hc: HealthCheckConfig | undefined = ctx.config.health_checks;
  if (hc?.enabled === false || !hc?.endpoints?.length) return;
  const health = new HealthCheck(orchestrator.target.controlPlane.connection);
  await health.checkHTTPEndpoints({ ...hc, on_failure: 'notify' }).catch((e) => printWarning(`Post-rollback health check failed: ${message(e)}`));
}

// ---------------------------------------------------------------------------
// 19.3 Deploy cleanup failover
// ---------------------------------------------------------------------------

/** `OrchestratorUnavailableError` from `Unreachable`, `Timeout`, or an SSH transport failure. */
export function isControlPlaneLoss(error: unknown): boolean {
  if (!(error instanceof OrchestratorUnavailableError)) return false;
  const cause = error.cause;
  if (cause instanceof KubeError) return cause.reason === 'Unreachable' || cause.reason === 'Timeout';
  return true; // SSH transport-level failures reach here without a KubeError cause
}

/**
 * When the deploy fails with a control-plane loss and the environment has several managers,
 * re-resolve a control plane before touching the release record and the lock, so a dead server
 * does not leave a Lease behind for 30 minutes.
 */
export async function cleanupBundle(ctx: DeployContext, error: unknown): Promise<Orchestrator> {
  if (!isControlPlaneLoss(error) || ctx.target.managers.length < 2 || ctx.options.noFailover) return ctx.orchestrator;
  try {
    const reopened = await openOrchestrator(ctx.env, { failover: true, requireWorkerCredentials: false });
    if (reopened.orchestrator.target.controlPlane.name !== ctx.target.controlPlane.name) {
      printWarning(`Control plane ${ctx.target.controlPlane.name} was lost; finishing cleanup on ${reopened.orchestrator.target.controlPlane.name}`);
    }
    return reopened.orchestrator;
  } catch {
    return ctx.orchestrator; // nothing ready: cleanup fails with warnings, lock stays (stale later)
  }
}

export async function releaseLock(ctx: DeployContext, lock: LockStore, acquired: LockData): Promise<void> {
  const first = await lock.release();
  if (first.success) return;
  const bundle = ctx.cleanupOrchestrator ?? ctx.orchestrator;
  if (bundle === ctx.orchestrator) {
    printWarning(`Lock release failed: ${first.error.message}`);
    return;
  }
  const other = bundle.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
  const status = await other.status();
  if (status.success && status.data.data?.started_at === acquired.started_at && status.data.data.performer === acquired.performer) {
    const second = await other.release(); // unconditional, after verifying the holder is this deploy
    if (!second.success) printWarning(`Lock release failed: ${second.error.message}`);
  }
}
