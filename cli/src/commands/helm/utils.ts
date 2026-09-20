// Shared context, target resolution and confirmation helpers for the `dockflow helm` command group
// (design-04 3.12.1). Every subcommand opens its context with `openHelmCommand`, resolves the
// release it targets with `resolveReleaseTarget`, and asks for confirmation through
// `confirmOrThrow`, so the six subcommands read alike and refuse alike.

import { requireCapabilityFor } from '../../services/orchestrator/capabilities';
import { openOrchestrator, type OpenedOrchestrator } from '../../services/orchestrator/factory';
import type { HelmBackend, HelmReleaseStatus, Orchestrator, StackRole, VolumeScope } from '../../services/orchestrator/interfaces';
import type { ResolveTargetOptions } from '../../services/orchestrator/target';
import {
  HELM_DEFAULT_TIMEOUT,
  K8S_PROXY_LOCK_NAME,
  K8S_PROXY_RELEASE,
  K8S_SYSTEM_NAMESPACE,
  TRAEFIK_TIMEOUT_S,
} from '../../services/orchestrator/kubernetes/constants';
import { statefulSetClaimPattern } from '../../services/orchestrator/kubernetes/helm/parse';
import { parseDurationMs } from '../../services/orchestrator/kubernetes/model/units';
import { DEFAULT_KEEP_RELEASES } from '../../services/orchestrator/kubernetes/render';
import { type DockflowConfig, type HelmReleaseConfig, loadConfig } from '../../utils/config';
import { CLIError, DeployError, ErrorCode, ValidationError } from '../../utils/errors';
import { confirmPrompt, dangerousConfirmPrompt } from '../../utils/prompts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A release declared in config.yml, loaded without rendering (name, role, namespace, chart, version, timeout). */
export interface DeclaredRelease {
  name: string;
  role: StackRole;
  namespace: string;
  /** `chart:` as written in config.yml (a bare chart name, or an `oci://` reference) */
  chart: string;
  version: string;
  timeoutS: number;
}

export interface HelmCommandContext {
  env: string;
  config: DockflowConfig;
  orchestrator: Orchestrator;
  helm: HelmBackend;
  /** the stack's namespace: the `P/stack` label value every backend call keys on */
  stackId: string;
  stackName: string;
  /** releases declared in config.yml, both roles, config order */
  declared: DeclaredRelease[];
}

/** The seams `openHelmCommand` calls, overridden by tests with a FakeOrchestrator; production uses the real ones. */
export interface HelmCommandDeps {
  loadConfig: () => DockflowConfig | null;
  openOrchestrator: (env: string, options?: ResolveTargetOptions) => Promise<OpenedOrchestrator>;
}

const realDeps: HelmCommandDeps = { loadConfig: () => loadConfig(), openOrchestrator };

function timeoutSecondsOf(text: string, fallbackS: number): number {
  const ms = parseDurationMs(text);
  return typeof ms === 'number' ? Math.max(1, Math.ceil(ms / 1000)) : fallbackS;
}

const HELM_DEFAULT_TIMEOUT_S = 300;

function declaredReleasesFrom(config: DockflowConfig, stackNamespace: string): DeclaredRelease[] {
  const globalTimeout = config.helm?.timeout ?? HELM_DEFAULT_TIMEOUT;
  const globalTimeoutS = timeoutSecondsOf(globalTimeout, HELM_DEFAULT_TIMEOUT_S);
  return (config.helm?.releases ?? []).map((release: HelmReleaseConfig) => ({
    name: release.name,
    role: release.role ?? 'app',
    namespace: release.namespace ?? stackNamespace,
    chart: release.chart,
    version: release.version,
    timeoutS: release.timeout === undefined ? globalTimeoutS : timeoutSecondsOf(release.timeout, globalTimeoutS),
  }));
}

/**
 * design-03 2.5 `max(5, keep_releases + 2)`. `DockflowConfig` is outside the kubernetes package, so
 * every caller that needs this from config.yml (kubernetes/index.ts's factory, this package)
 * recomputes it from the same two numbers rather than share a helper across that boundary (PD-9).
 */
const HELM_HISTORY_MIN = 5;
const HELM_HISTORY_MARGIN = 2;

export function helmHistoryMaxFor(config: DockflowConfig): number {
  return Math.max(HELM_HISTORY_MIN, (config.stack_management?.keep_releases ?? DEFAULT_KEEP_RELEASES) + HELM_HISTORY_MARGIN);
}

/**
 * Opens the command's context: the capability check runs on the loaded config, before any SSH
 * (`openOrchestrator` resolves the control plane and probes managers) - U-CMD-REFUSE-03.
 */
export async function openHelmCommand(
  env: string,
  options: { server?: string },
  operation: string,
  deps: HelmCommandDeps = realDeps,
): Promise<HelmCommandContext> {
  const config = deps.loadConfig();
  if (!config) throw new CLIError('No config.yml found', ErrorCode.CONFIG_NOT_FOUND, 'Run `dockflow init` to create a project configuration.');
  requireCapabilityFor(config.orchestrator ?? 'swarm', 'helm', operation);
  const { orchestrator } = await deps.openOrchestrator(env, { server: options.server });
  if (orchestrator.helm === null) {
    // capabilities.helm already gated this above; kept only so `ctx.helm` below never needs a cast.
    throw new CLIError(`Helm is not available for ${env}`, ErrorCode.ORCHESTRATOR_UNAVAILABLE);
  }
  const stackId = orchestrator.naming.scope({ project: orchestrator.target.project, env: orchestrator.target.env, role: 'app' });
  return {
    env: orchestrator.target.env,
    config,
    orchestrator,
    helm: orchestrator.helm,
    stackId,
    stackName: orchestrator.target.stackName,
    declared: declaredReleasesFrom(config, stackId),
  };
}

// ---------------------------------------------------------------------------
// Release target resolution (design-04 3.12.1 table)
// ---------------------------------------------------------------------------

export interface ReleaseTarget {
  name: string;
  namespace: string;
  role: StackRole | null;
  system: boolean;
  declared: DeclaredRelease | null;
  status: HelmReleaseStatus;
}

export async function resolveReleaseTarget(ctx: HelmCommandContext, name: string | undefined, options: { system?: boolean }): Promise<ReleaseTarget> {
  if (options.system) {
    if (name !== undefined) {
      throw new ValidationError('--system targets the Dockflow Traefik release; omit the release name');
    }
    const status = await ctx.helm.status(K8S_SYSTEM_NAMESPACE, K8S_PROXY_RELEASE);
    if (status === null) {
      throw new CLIError(`Traefik is not installed on ${ctx.env}`, ErrorCode.SERVICE_NOT_FOUND, 'It is installed by `dockflow deploy <env>` when `proxy.enabled` is true.');
    }
    return { name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null, system: true, declared: null, status };
  }
  if (name === undefined) {
    throw new ValidationError('A Helm release name is required', 'Pass a release name, or `--system` for the Dockflow Traefik release.');
  }
  if (name === K8S_PROXY_RELEASE) {
    throw new ValidationError(`${K8S_PROXY_RELEASE} is the Dockflow Traefik release`, 'Add `--system`.');
  }
  const declared = ctx.declared.find((release) => release.name === name) ?? null;
  const owned = await ctx.helm.listAll(ctx.stackId);
  const status = owned.find((release) => release.name === name);
  if (status !== undefined) {
    return { name, namespace: status.namespace, role: status.role, system: false, declared, status };
  }
  if (declared !== null) {
    throw new CLIError(`Helm release ${name} is declared in config.yml but not installed on ${ctx.env}`, ErrorCode.SERVICE_NOT_FOUND, `Deploy it with \`dockflow deploy ${ctx.env}\`.`);
  }
  throw new CLIError(`Helm release ${name} not found for ${ctx.env}`, ErrorCode.SERVICE_NOT_FOUND, `List releases with \`dockflow helm list ${ctx.env}\`.`);
}

/** "search 2.4.1": release name and the version declared in config.yml, never the resolved chart text. */
export function declaredDisplay(release: DeclaredRelease): string {
  return `${release.name} ${release.version}`;
}

// ---------------------------------------------------------------------------
// Timeouts (design-04 3.12.1)
// ---------------------------------------------------------------------------

const TIMEOUT_MIN_MS = 30_000;
const TIMEOUT_MAX_MS = 3_600_000;

/**
 * `--timeout <duration>`: 30s..1h. Otherwise the release's own config.yml timeout, else
 * `helm.timeout`, else 5m; `--system` uses `TRAEFIK_TIMEOUT_S` (300s, design-04 1).
 */
export function resolveTimeoutS(ctx: HelmCommandContext, raw: string | undefined, declared: DeclaredRelease | null, system: boolean): number {
  if (raw !== undefined) {
    const ms = parseDurationMs(raw);
    if (typeof ms !== 'number' || ms < TIMEOUT_MIN_MS || ms > TIMEOUT_MAX_MS) {
      throw new ValidationError('--timeout must be between 30s and 1h');
    }
    return Math.ceil(ms / 1000);
  }
  if (system) return TRAEFIK_TIMEOUT_S;
  if (declared !== null) return declared.timeoutS;
  return timeoutSecondsOf(ctx.config.helm?.timeout ?? HELM_DEFAULT_TIMEOUT, HELM_DEFAULT_TIMEOUT_S);
}

// ---------------------------------------------------------------------------
// Confirmation (design-04 3.12.1)
// ---------------------------------------------------------------------------

/** Non-TTY without `--yes` is an error, never a silent cancel. */
export async function confirmOrThrow(options: { yes?: boolean; typed?: string; message: string }): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY) {
    throw new ValidationError('Confirmation required', 'Re-run with `--yes` in non-interactive sessions.');
  }
  if (options.typed !== undefined) {
    return dangerousConfirmPrompt({ message: options.message, expectedText: options.typed });
  }
  return confirmPrompt({ message: options.message, initialValue: false });
}

// ---------------------------------------------------------------------------
// Lock (design-04 3.12.6 step 9, 3.12.7 step 6)
// ---------------------------------------------------------------------------

/** Acquires the stack's deploy lock (or the shared proxy lease for `--system`), runs `action`, releases it in `finally`. */
export async function withHelmLock<T>(ctx: HelmCommandContext, options: { system: boolean; message: string }, action: () => Promise<T>): Promise<T> {
  const lock = ctx.orchestrator.lock(ctx.stackId, ctx.config.lock?.stale_threshold_minutes, options.system ? K8S_PROXY_LOCK_NAME : undefined);
  const acquired = await lock.acquire({ message: options.message });
  if (!acquired.success) {
    throw new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED);
  }
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Volumes (design-04 3.10)
// ---------------------------------------------------------------------------

export function volumeScopeFor(ctx: HelmCommandContext, namespace: string): VolumeScope {
  return { project: ctx.orchestrator.target.project, env: ctx.orchestrator.target.env, role: null, namespace };
}

export interface ReleaseVolumes {
  /** manifest PVC objects an uninstall deletes (no `helm.sh/resource-policy: keep`) */
  deletable: string[];
  /** manifest PVC objects annotated `keep`, plus live StatefulSet claim-template PVCs */
  surviving: string[];
  /**
   * The PersistentVolume each `deletable` PVC is bound to, by PVC name (design-04 3.10 `deleteVolumes`
   * step 0 / `keepVolumes`): read from `VolumeInfo.boundVolume` while the claim still exists, so it
   * can be found again by name once Helm's own uninstall has deleted the claim. A PVC not yet bound,
   * or read through a backend that predates the field, is omitted.
   */
  deletableBoundVolumes: Map<string, string>;
}

/**
 * `manifestObjects` -> deletable and surviving PVC names, plus the PV each deletable PVC is bound to
 * (design-04 3.12.6 step 3). A StatefulSet's `volumeClaimTemplates` are never manifest objects (DV3):
 * the live claims they produced are found by listing the namespace's volumes and matching
 * `statefulSetClaimPattern`.
 */
export async function classifyReleaseVolumes(ctx: HelmCommandContext, target: ReleaseTarget): Promise<ReleaseVolumes> {
  const objects = await ctx.helm.manifestObjects(target.namespace, target.name);
  const deletable: string[] = [];
  const surviving: string[] = [];
  const patterns: RegExp[] = [];
  for (const object of objects) {
    if (object.kind === 'PersistentVolumeClaim') {
      (object.keep ? surviving : deletable).push(object.name);
    }
    for (const claim of object.claimTemplates) patterns.push(statefulSetClaimPattern(claim, object.name));
  }
  const deletableBoundVolumes = new Map<string, string>();
  if (patterns.length > 0 || deletable.length > 0) {
    const volumes = await ctx.orchestrator.volumes.list(volumeScopeFor(ctx, target.namespace));
    for (const volume of volumes) {
      if (patterns.some((pattern) => pattern.test(volume.name))) surviving.push(volume.name);
      if (deletable.includes(volume.name) && typeof volume.boundVolume === 'string') {
        deletableBoundVolumes.set(volume.name, volume.boundVolume);
      }
    }
  }
  return { deletable, surviving, deletableBoundVolumes };
}
