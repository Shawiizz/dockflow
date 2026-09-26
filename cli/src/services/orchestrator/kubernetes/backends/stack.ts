// KubernetesStackBackend (design-03 2-18, design-04 3.8.1-3.8.8): the class composing every other
// package of the bundle into the StackBackend contract. `render` memoizes the pure renderer of
// render.ts (PD-1) around a render key of the deploy input alone, validated against the resolved
// files on every hit (K73). `deploy`/`apply` drive the pre-apply checks and the mutating apply
// through the injected ApplyEngine (P41), install Helm app releases first in config order (2.5),
// and hand a partial receipt to `revert` when the apply itself fails after a successful dry-run
// (5.8) or a Helm release fails mid-sequence. `waitConvergence`/`checkHealth`/`revert` delegate to
// the pure wait and revert modules (P42, P52); the day-2 members delegate to stack-day2.ts (P59).
// `getServices`/`listInstances`/`diagnose` read the shared inventory (P43) through the pure status
// modules (P17). `finalize` never throws: every step is independently wrapped and reported as a
// warning (DESIGN-CORE 6.1).
//
// Receipts are opaque to callers: everything revert/finalize need is kept in a private WeakMap
// keyed by receipt identity (design-03 2.3), and the render memo, keyed by input digest, lives here
// too (PD-1: memos private to one backend stay in that backend).

import { serialize } from '../../../compose';
import { resolutionDigest, type RecordingFileResolver } from '../../file-resolver';
import type {
  ApplyOptions,
  ClusterBackend,
  ConvergenceResult,
  ControlOptions,
  DeployReceipt,
  DiagnosticReport,
  HealthOptions,
  HelmReleaseChange,
  HelmReleaseRecord,
  HelmReleaseStatus,
  HelmUpgradeResult,
  InstanceInfo,
  InternalHealthResult,
  OrchestratorTarget,
  ProxyBackend,
  ReleaseStore,
  ResolvedHelmRelease,
  RevertResult,
  ServiceInfo,
  StackArtifact,
  StackBackend,
  StackDeployInput,
  StackRef,
  StackRole,
  WaitOptions,
  WorkloadChange,
} from '../../interfaces';
import { CLIError, DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { printDebug, printInfo, printWarning } from '../../../../utils/output';
import type { Redactor } from '../../../../utils/redact';
import { type Result, err, ok } from '../../../../types/result';
import { closure } from '../apply/closure';
import { ApplyEngine, type PartialApply } from '../apply/engine';
import { factsFromObjects, factsFromStack } from '../apply/pre-apply';
import { prune } from '../apply/prune';
import { revert as executeRevert } from '../apply/revert';
import type { PreviousRelease } from '../apply/revert-plan';
import { composeServiceOf, isWorkload, podSpecOf, type Snapshot, templateRefs, type TemplateRefs } from '../apply/snapshot';
import { K8S_REGISTRY_SECRET, K8S_REQUEST_TIMEOUT_S, LABELS } from '../constants';
import type { Clock, KubernetesBundleDeps, SharedMemo } from '../deps';
import type { K8sDistribution } from '../distribution';
import { helmRedactions } from '../helm/resolve';
import { isSensitiveKeyPath } from '../helm/values-yaml';
import { namespaceFor } from '../naming';
import { renderStackArtifact, type RenderEnvironment, type StackRender } from '../render';
import type { Event, Namespace, Node } from '../resources/core';
import type { ManifestObject } from '../resources/registry';
import { KubeError, kubeErrorToCliError } from '../runtime/errors';
import type { KubeExecutor } from '../runtime/kubectl';
import { parseManifests } from '../yaml';
import { KubernetesHelmBackend } from './helm';
import { createInventoryReader, type InventoryReader } from './inventory';
import {
  exists as day2Exists,
  remove as day2Remove,
  restart as day2Restart,
  rollbackService as day2RollbackService,
  scale as day2Scale,
  stop as day2Stop,
  type StackDay2Deps,
} from './stack-day2';
import { type ReceiptState, stateFor } from './stack-state';
import { checkHealth as runCheckHealth, nodeNameMap, type StackWaitDeps, waitConvergence as runWaitConvergence } from './stack-wait';
import {
  buildDiagnosticReport,
  crashLogTargets,
  describeTargets,
  type CrashLogExcerpt,
  type CrashLogTarget,
  type DiagnoseHelmRelease,
  type DiagnoseHostFacts,
  type DiagnoseInput,
  type PodDescription,
} from '../status/diagnose';
import { instancesFor, nodeToServerMap as buildNodeToServerMap } from '../status/pods';
import { toServiceInfos } from '../status/services';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface KubernetesStackBackendOptions {
  /** bound to the control plane; shared by every backend of the bundle */
  deps: KubernetesBundleDeps;
  /** the bundle's shared memo (preflight, namespaces, crds); render/receipt memos stay private here */
  memo: SharedMemo;
  target: Pick<OrchestratorTarget, 'env' | 'controlPlane'>;
  /** injected: the type is core, the implementation is the bundle's own (P40) */
  cluster: Pick<ClusterBackend, 'preflight'>;
  releases: Pick<ReleaseStore, 'current' | 'currentVersion' | 'list' | 'readArtifact' | 'readState' | 'writeAccessoriesDigest'>;
  render: RenderEnvironment;
  /** servers.yml keys of the environment (node name mapping for waits, instances, host facts) */
  serverNames: readonly string[];
  /** design-03 2.5: max(5, keep_releases + 2); config is outside this package */
  helmHistoryMax: number;
  /** injected: null when the bundle has no proxy wired yet (diagnose omits the Proxy section) */
  proxy?: Pick<ProxyBackend, 'status'> | null;
  /** config.helm.releases[].auth by release name, for a rollback's Helm records; config is outside this package */
  helmAuth?(release: string): { username: string; password: string } | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const HELM_UNINSTALL_TIMEOUT_S = 300;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ClusterBackend.preflight needs, from what the render/artifact actually contains. */
function needsOf(objects: readonly ManifestObject[], helmCount: number): { routes: boolean; volumes: boolean; helm: boolean } {
  return {
    routes: objects.some((o) => o.kind === 'IngressRoute' || o.kind === 'Middleware'),
    volumes: objects.some((o) => o.kind === 'PersistentVolumeClaim'),
    helm: helmCount > 0,
  };
}

/**
 * Every name `closure()` could not match must be an app-role Helm release of the same filter;
 * anything else is a translator bug, never something to report as deployed (K74).
 */
function assertUnmatchedAreHelm(unmatched: readonly string[], helm: readonly ResolvedHelmRelease[]): void {
  const names = new Set(helm.map((h) => h.name));
  const bad = unmatched.find((name) => !names.has(name));
  if (bad !== undefined) {
    throw new DeployError(`internal error: --only name ${bad} matched no object of the render`, ErrorCode.DEPLOY_FAILED);
  }
}

/** D6: every rendered workload of the role is already live (nothing was deleted out from under the digest). */
function allRenderedWorkloadsExist(objects: readonly ManifestObject[], before: Snapshot): boolean {
  return objects
    .filter(isWorkload)
    .every((o) => before.workloads.some((w) => w.kind === o.kind && w.name === o.metadata.name));
}

function sameRefSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort(compareCodeUnits);
  const right = [...new Set(b)].sort(compareCodeUnits);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** parts of a pod template that changed between the render and the live workload (6.4). */
function differingParts(rendered: TemplateRefs, live: TemplateRefs): string[] {
  const parts: string[] = [];
  if (!sameRefSet(rendered.secrets, live.secrets)) parts.push('secrets');
  if (!sameRefSet(rendered.configMaps, live.configMaps)) parts.push('configs');
  if (!sameRefSet(rendered.images, live.images)) parts.push('image');
  return parts;
}

/**
 * `--only` deploys the closure only; a service left out that has local changes not yet applied
 * would otherwise look identical to one that is fully up to date (design-03 6.4).
 */
function warnUndeployedChanges(rendered: readonly ManifestObject[], targets: readonly string[], before: Snapshot, version: string): void {
  for (const object of rendered.filter(isWorkload)) {
    const service = composeServiceOf(object);
    if (service === null || targets.includes(service)) continue;
    const live = before.workloads.find((w) => w.kind === object.kind && w.name === object.metadata.name);
    if (!live) continue;
    const parts = differingParts(templateRefs(podSpecOf(object)), live.refs);
    if (parts.length === 0) continue;
    printWarning(
      `Service ${service} has local changes (${parts.join(', ')}) that --only does not deploy; release ${version} records them and the next full deploy or rollback applies them`,
    );
  }
}

/**
 * What the Redactor must learn from the objects' Secrets before anything is applied, so kubectl
 * stderr, pod messages and the logs of a failed rollout never print it: the content of every compose
 * secret, and the env values under a sensitive-looking name (the rule `helm values` masks with). An
 * ordinary value such as `production` is left out, or it would turn into *** inside every name.
 */
export function secretValuesOf(objects: readonly ManifestObject[]): string[] {
  const values: string[] = [];
  for (const object of objects) {
    if (object.kind !== 'Secret') continue;
    // an env Secret belongs to one service, a compose secret does not
    const env = object.metadata.labels?.[LABELS.service] !== undefined;
    for (const [key, encoded] of Object.entries(object.data ?? {})) {
      if (!env || isSensitiveKeyPath(key)) values.push(Buffer.from(encoded, 'base64').toString('utf8'));
    }
  }
  return values;
}

/** What `artifact.helm`/a receipt store: no credentials, the digest `upgradeInstall` actually installed from. */
function toHelmRecord(release: ResolvedHelmRelease, result: HelmUpgradeResult): HelmReleaseRecord {
  const { auth: _auth, declaredDigest: _declaredDigest, ...rest } = release;
  return { ...rest, chartSha256: result.chartSha256 || null };
}

/** Re-installs from the pinned bytes: `declaredDigest` is the record's own already-verified `chartSha256`. */
function toResolvedRelease(record: HelmReleaseRecord, auth: ResolvedHelmRelease['auth']): ResolvedHelmRelease {
  const { chartSha256, ...rest } = record;
  return { ...rest, auth, declaredDigest: chartSha256 };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helmDeployError(release: ResolvedHelmRelease, error: unknown, reverted: RevertResult): DeployError {
  const revertPart = reverted.message ? `; ${reverted.message}` : '';
  return new DeployError(`Helm release ${release.name} failed: ${errorText(error)}${revertPart}`, ErrorCode.DEPLOY_FAILED);
}

function applySummaryText(ns: string, role: StackRole, applied: readonly ManifestObject[], changes: readonly WorkloadChange[]): string {
  const changedServices = [...new Set(changes.map((c) => c.service))].sort(compareCodeUnits);
  const created = [...new Set(changes.filter((c) => c.created).map((c) => c.service))].sort(compareCodeUnits);
  const changedOnly = changedServices.filter((s) => !created.includes(s));
  const parts: string[] = [];
  if (changedOnly.length > 0) parts.push(`changed ${changedOnly.join(', ')}`);
  if (created.length > 0) parts.push(`created ${created.join(', ')}`);
  const unchanged = applied.filter(isWorkload).length - changes.length;
  if (unchanged > 0) parts.push(`unchanged ${unchanged} service(s)`);
  const detail = parts.length > 0 ? `: ${parts.join('; ')}` : '';
  return `Applied ${applied.length} object(s) to ${ns} (${role})${detail}`;
}

async function toResult<T>(fn: () => Promise<T>): Promise<Result<T, string>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(errorText(error));
  }
}

// ---------------------------------------------------------------------------
// KubernetesStackBackend
// ---------------------------------------------------------------------------

interface RenderEntry {
  render: StackRender;
  fileDigests: Record<string, string>;
}

export class KubernetesStackBackend implements StackBackend {
  private readonly deps: KubernetesBundleDeps;
  private readonly kubectl: KubeExecutor;
  private readonly clock: Clock;
  private readonly redactor: Redactor;
  private readonly distribution: K8sDistribution;
  private readonly memo: SharedMemo;
  private readonly env: string;
  private readonly controlPlane: OrchestratorTarget['controlPlane'];
  private readonly engine: ApplyEngine;
  private readonly cluster: Pick<ClusterBackend, 'preflight'>;
  private readonly helm: KubernetesHelmBackend;
  private readonly releases: KubernetesStackBackendOptions['releases'];
  private readonly inventory: InventoryReader;
  private readonly proxy: Pick<ProxyBackend, 'status'> | null;
  private readonly renderEnv: RenderEnvironment;
  private readonly serverNames: readonly string[];
  private readonly helmHistoryMax: number;
  private readonly helmAuthFn: (release: string) => { username: string; password: string } | null;

  /** private per-backend memos (PD-1): renders keyed by input digest, receipt state by identity */
  private readonly renders = new Map<string, RenderEntry>();
  private readonly receipts = new WeakMap<DeployReceipt, ReceiptState>();

  constructor(options: KubernetesStackBackendOptions) {
    this.deps = options.deps;
    this.kubectl = options.deps.kubectl;
    this.clock = options.deps.clock;
    this.redactor = options.deps.redactor;
    this.distribution = options.deps.distribution;
    this.memo = options.memo;
    this.env = options.target.env;
    this.controlPlane = options.target.controlPlane;
    this.engine = new ApplyEngine({
      kubectl: this.kubectl,
      clock: this.clock,
      distribution: this.distribution,
      memo: this.memo,
      events: { step: printInfo, warn: printWarning },
    });
    this.cluster = options.cluster;
    this.helm = new KubernetesHelmBackend({ deps: options.deps, env: this.env });
    this.releases = options.releases;
    this.inventory = createInventoryReader({ kubectl: this.kubectl, helm: this.helm });
    this.proxy = options.proxy ?? null;
    this.renderEnv = options.render;
    this.serverNames = options.serverNames;
    this.helmHistoryMax = options.helmHistoryMax;
    this.helmAuthFn = options.helmAuth ?? (() => null);
  }

  // ---------------------------------------------------------------------------
  // render (design-03 4, PD-1)
  // ---------------------------------------------------------------------------

  /** Pure and synchronous; memoized on `input` alone, validated against the resolved files (K73). */
  render(input: StackDeployInput): StackArtifact {
    return this.renderInternal(input).artifact;
  }

  private renderInternal(input: StackDeployInput): StackRender {
    const key = this.renderKey(input);
    const cached = this.renders.get(key);
    if (cached && this.filesUnchanged(cached.fileDigests, input.files)) return cached.render;
    const render = renderStackArtifact(input, this.renderEnv);
    this.redactor.add([...secretValuesOf(render.objects), ...helmRedactions(input.helm)]);
    const digests = input.files as Partial<RecordingFileResolver>;
    this.renders.set(key, { render, fileDigests: typeof digests.digests === 'function' ? digests.digests() : {} });
    return render;
  }

  /** Everything the render depends on besides the fixed bundle environment. */
  private renderKey(input: StackDeployInput): string {
    return sha256Hex(
      canonicalJson({
        ref: input.ref,
        version: input.version,
        compose: serialize(input.compose),
        proxy: input.proxy ?? null,
        images: { mode: input.images.mode, pullSecretName: input.images.pullSecretName },
        helm: input.helm.map((h) => [h.name, h.valuesSha256, h.version]),
        sibling: input.sibling,
        serverNames: input.serverNames,
        traefikOnCluster: input.traefikOnCluster,
      }),
    );
  }

  /** Files are a *validation* of the cache entry, never part of the key: a mismatch re-renders. */
  private filesUnchanged(digests: Record<string, string>, files: StackDeployInput['files']): boolean {
    return Object.entries(digests).every(([path, digest]) => resolutionDigest(files(path)) === digest);
  }

  // ---------------------------------------------------------------------------
  // deploy (design-03 5, 2.5)
  // ---------------------------------------------------------------------------

  async deploy(input: StackDeployInput): Promise<Result<DeployReceipt, DeployError>> {
    const { ref } = input;
    const ns = namespaceFor(ref.project, ref.env);
    const r = this.renderInternal(input);
    const startedAt = this.clock.now();
    try {
      await this.engine.ensureNamespace(ref);
      const before = await this.engine.snapshot(ns, ref.role);

      if (ref.role === 'accessory' && !input.force) {
        const state = await this.releases.readState(ns);
        if (state.accessoriesDigest === r.artifact.digest && allRenderedWorkloadsExist(r.objects, before)) {
          printInfo('Accessories unchanged, skipping');
          return ok(
            this.remember(
              {
                ref,
                version: input.version,
                startedAt,
                services: input.services,
                skipped: true,
                artifactDigest: r.artifact.digest,
                changes: [],
                helm: [],
                helmChanges: [],
                helmDeclared: input.helmDeclared,
                previousVersion: input.previousVersion,
              },
              stateFor({
                ref,
                namespace: ns,
                objects: r.objects,
                applied: [],
                prune: false,
                now: this.clock.now(),
                failureActions: r.failureActions,
                helmInputs: input.helm,
                helmDeclared: input.helmDeclared,
                pullSecretName: input.images.pullSecretName,
              }),
            ),
          );
        }
      }

      await this.cluster.preflight(needsOf(r.objects, input.helm.length));

      const targets = ref.role === 'app' ? input.services : null;
      const selected = targets ? closure(r.objects, targets) : null;
      if (selected) assertUnmatchedAreHelm(selected.unmatched, input.helm);
      const applied = selected ? selected.objects : r.objects;
      const helmTargets = targets ? input.helm.filter((h) => targets.includes(h.name)) : input.helm;
      const previous = ref.role === 'app' && input.previousVersion ? await this.loadPrevious(ref, input.previousVersion) : null;

      const prepared = await this.engine.prepare({
        ref,
        version: input.version,
        objects: r.objects,
        applied,
        facts: factsFromStack(r.stack),
        mode: 'deploy',
        full: targets === null,
        rebindVolumes: input.rebindVolumes,
        before,
      });

      if (targets) warnUndeployedChanges(r.objects, targets, before, input.version);

      const helmStatuses: HelmReleaseStatus[] = [];
      const helmChanges: HelmReleaseChange[] = [];
      const helmApplied: ReceiptState['helmApplied'] = [];
      for (const release of helmTargets) {
        const replaced = previous?.helm.find((h) => h.name === release.name) ?? null;
        let result: HelmUpgradeResult;
        try {
          result = await this.helm.upgradeInstall(release, { historyMax: this.helmHistoryMax, stackId: ns });
        } catch (error) {
          const partialReceipt = this.remember(
            {
              ref,
              version: input.version,
              startedAt,
              services: input.services,
              skipped: false,
              artifactDigest: r.artifact.digest,
              changes: [],
              helm: helmStatuses,
              helmChanges,
              helmDeclared: input.helmDeclared,
              previousVersion: input.previousVersion,
            },
            stateFor({
              ref,
              namespace: ns,
              objects: r.objects,
              applied: [],
              now: this.clock.now(),
              before,
              helmApplied,
              targets,
              previous,
              failureActions: r.failureActions,
              helmInputs: input.helm,
              helmDeclared: input.helmDeclared,
              pullSecretName: input.images.pullSecretName,
            }),
          );
          const reverted = helmApplied.length > 0 ? await this.revert(partialReceipt) : { status: 'nothing-to-revert' as const, services: [], message: 'there is nothing to revert' };
          return err(helmDeployError(release, error, reverted));
        }
        helmStatuses.push(result);
        helmChanges.push({
          name: release.name,
          namespace: release.namespace,
          role: release.role,
          action: result.changed ? (result.previousRevision === null ? 'installed' : 'upgraded') : 'skipped',
          previousRevision: result.previousRevision,
          revision: result.revision,
        });
        if (result.changed) helmApplied.push({ release: toHelmRecord(release, result), replaced });
      }

      const revertOnFailure = async (partial: PartialApply): Promise<RevertResult> => {
        const partialReceipt = this.remember(
          {
            ref,
            version: input.version,
            startedAt,
            services: input.services,
            skipped: false,
            artifactDigest: r.artifact.digest,
            changes: partial.changes,
            helm: helmStatuses,
            helmChanges,
            helmDeclared: input.helmDeclared,
            previousVersion: input.previousVersion,
          },
          stateFor({
            ref,
            namespace: ns,
            objects: r.objects,
            applied: partial.toApply,
            now: partial.after.takenAt,
            before: partial.before,
            after: partial.after,
            previous,
            targets,
            helmApplied,
            failureActions: r.failureActions,
            helmInputs: input.helm,
            helmDeclared: input.helmDeclared,
            pullSecretName: input.images.pullSecretName,
            disruptive: partial.disruptive,
          }),
        );
        return this.revert(partialReceipt);
      };

      const outcome = await this.engine.execute(prepared, { onApplyProgress: input.onApplyProgress, revert: revertOnFailure });
      printInfo(applySummaryText(ns, ref.role, outcome.applied, outcome.changes));

      return ok(
        this.remember(
          {
            ref,
            version: input.version,
            startedAt,
            services: input.services,
            skipped: false,
            artifactDigest: r.artifact.digest,
            changes: outcome.changes,
            helm: helmStatuses,
            helmChanges,
            helmDeclared: input.helmDeclared,
            previousVersion: input.previousVersion,
          },
          stateFor({
            ref,
            namespace: ns,
            objects: r.objects,
            applied: outcome.applied,
            before: outcome.before,
            after: outcome.after,
            previous,
            targets,
            prune: targets === null,
            helmApplied,
            failureActions: r.failureActions,
            helmInputs: input.helm,
            helmDeclared: input.helmDeclared,
            pullSecretName: input.images.pullSecretName,
            disruptive: outcome.disruptive,
            lbWatch: outcome.lbWatch,
            now: outcome.after.takenAt,
          }),
        ),
      );
    } catch (error) {
      return err(this.mapError(error, ref.env, `deploy namespace ${ns}`));
    } finally {
      this.inventory.invalidate(ns);
    }
  }

  /** memo.replacedReleases of the old design is now internal to ReleaseStore (P40); this just reads it. */
  private async loadPrevious(ref: StackRef, version: string): Promise<PreviousRelease | null> {
    const stackName = `${ref.project}-${ref.env}`;
    let artifact: StackArtifact;
    try {
      artifact = await this.releases.readArtifact(stackName, version);
    } catch (error) {
      printDebug(`Release ${version} not found in ${stackName}: ${errorText(error)}`);
      return null;
    }
    if (artifact.format !== 'k8s-manifests/1') {
      printWarning(`Release ${version} was produced for ${artifact.format}; automatic revert falls back to rollout undo`);
      return null;
    }
    return { version, objects: parseManifests(artifact.content), helm: artifact.helm };
  }

  // ---------------------------------------------------------------------------
  // apply (design-03 16.2: restore semantics, kind-switch and Job rules, digest-verified Helm records)
  // ---------------------------------------------------------------------------

  async apply(ref: StackRef, version: string, artifact: StackArtifact, options: ApplyOptions): Promise<Result<DeployReceipt, DeployError>> {
    if (artifact.format !== 'k8s-manifests/1') {
      return err(
        new DeployError(
          `Release ${version} was produced for ${artifact.format} and cannot be applied with orchestrator: ${this.distribution.traits.name}`,
          ErrorCode.ROLLBACK_FAILED,
        ),
      );
    }
    if (artifact.role !== ref.role) {
      return err(new DeployError(`Release ${version} was recorded for role ${artifact.role}, not ${ref.role}`, ErrorCode.ROLLBACK_FAILED));
    }
    const ns = namespaceFor(ref.project, ref.env);
    const startedAt = this.clock.now();
    let objects: ManifestObject[];
    try {
      objects = parseManifests(artifact.content);
    } catch (error) {
      return err(new DeployError(`Release ${version} cannot be read: ${errorText(error)}`, ErrorCode.ROLLBACK_FAILED));
    }
    const foreign = objects.find((o) => o.metadata.namespace !== ns);
    if (foreign) {
      return err(new DeployError(`Release ${version} contains ${foreign.kind} ${foreign.metadata.name} outside namespace ${ns}`, ErrorCode.ROLLBACK_FAILED));
    }
    this.redactor.add([...secretValuesOf(objects), ...helmRedactions(artifact.helm)]);

    try {
      await this.cluster.preflight(needsOf(objects, artifact.helm.length));
      const targets = options.services;
      const selected = targets ? closure(objects, targets, { excludePvcs: true }).objects : objects;
      const prepared = await this.engine.prepare({
        ref,
        version,
        objects,
        applied: selected,
        facts: factsFromObjects(objects),
        mode: 'restore',
        full: false,
      });

      const records = targets ? artifact.helm.filter((h) => targets.includes(h.name)) : artifact.helm;
      const helmStatuses: HelmReleaseStatus[] = [];
      const helmApplied: ReceiptState['helmApplied'] = [];
      const helmInputs: ResolvedHelmRelease[] = [];
      for (const record of records) {
        const release = toResolvedRelease(record, this.helmAuthFn(record.name));
        helmInputs.push(release);
        const result = await this.helm.upgradeInstall(release, { historyMax: this.helmHistoryMax, stackId: ns, allowChartDrift: options.allowChartDrift });
        helmStatuses.push(result);
        if (result.changed) helmApplied.push({ release: toHelmRecord(release, result), replaced: null });
      }

      const outcome = await this.engine.execute(prepared);

      const receipt: DeployReceipt = {
        ref,
        version,
        startedAt,
        services: targets,
        skipped: false,
        artifactDigest: artifact.digest,
        changes: outcome.changes,
        helm: helmStatuses,
        helmChanges: [],
        helmDeclared: artifact.helm.map((h) => h.name),
        previousVersion: null,
      };
      return ok(
        this.remember(
          receipt,
          stateFor({
            origin: 'apply',
            ref,
            namespace: ns,
            objects,
            applied: outcome.applied,
            targets,
            prune: options.prune && targets === null,
            before: outcome.before,
            after: outcome.after,
            helmInputs,
            helmDeclared: artifact.helm.map((h) => h.name),
            helmApplied,
            disruptive: outcome.disruptive,
            lbWatch: outcome.lbWatch,
            now: outcome.after.takenAt,
          }),
        ),
      );
    } catch (error) {
      return err(this.mapApplyError(error, ref.env));
    } finally {
      this.inventory.invalidate(ns);
    }
  }

  // ---------------------------------------------------------------------------
  // waitConvergence / checkHealth (design-03 9, 10; delegated to stack-wait.ts, P42)
  // ---------------------------------------------------------------------------

  async waitConvergence(receipt: DeployReceipt, options: WaitOptions): Promise<ConvergenceResult> {
    return runWaitConvergence({ receipt, state: this.receipts.get(receipt) }, options, this.waitDeps());
  }

  async checkHealth(receipt: DeployReceipt, options: HealthOptions): Promise<InternalHealthResult> {
    return runCheckHealth({ receipt, state: this.receipts.get(receipt) }, options, this.waitDeps());
  }

  // ---------------------------------------------------------------------------
  // revert (design-03 11; delegated to apply/revert.ts, P52)
  // ---------------------------------------------------------------------------

  async revert(receipt: DeployReceipt): Promise<RevertResult> {
    const state = this.receipts.get(receipt);
    try {
      return await executeRevert(
        { kubectl: this.kubectl, engine: this.engine, helm: this.helm, redactor: this.redactor, wait: this.waitDeps() },
        { receipt, state, helmHistoryMax: this.helmHistoryMax },
      );
    } finally {
      if (state) this.inventory.invalidate(state.namespace);
    }
  }

  // ---------------------------------------------------------------------------
  // finalize (design-03 8; NEVER THROWS)
  // ---------------------------------------------------------------------------

  async finalize(receipt: DeployReceipt): Promise<void> {
    const st = this.receipts.get(receipt);
    if (!st || receipt.skipped) return;
    try {
      if (st.prune) {
        await this.step('prune', () => this.runPrune(st));
        await this.step('removed Helm releases', () => this.finalizeHelm(st));
        if (st.ref.role === 'app') await this.step('registry secret', () => this.finalizeRegistrySecret(st));
      }
      if (st.ref.role === 'accessory') {
        await this.step('accessories digest', () => this.releases.writeAccessoriesDigest(st.namespace, receipt.artifactDigest));
      }
    } finally {
      this.inventory.invalidate(st.namespace);
    }
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      printWarning(`Cleanup after deploy failed (${name}): ${errorText(error)}; the deploy itself succeeded`);
    }
  }

  private async runPrune(st: ReceiptState): Promise<void> {
    const routes = (await this.crds()).routes;
    await prune(
      { kubectl: this.kubectl, engine: this.engine, notices: { info: printInfo, warn: printWarning } },
      { ref: st.ref, namespace: st.namespace, rendered: st.objects, routes },
    );
  }

  /** design-03 8.5: app releases no longer declared are uninstalled subject to DV3; accessories only warned about. */
  private async finalizeHelm(st: ReceiptState): Promise<void> {
    const live = (await this.helm.listAll(st.namespace)).filter((r) => r.role === st.ref.role);
    const declared = new Set(st.helmDeclared);
    for (const release of live.filter((l) => !declared.has(l.name))) {
      if (st.ref.role === 'accessory') {
        printWarning(
          `Helm release ${release.name} (accessory) is no longer in config.yml and keeps running; remove it with: dockflow helm uninstall ${st.ref.env} ${release.name}`,
        );
        continue;
      }
      const pvcs = (await this.helm.manifestObjects(release.namespace, release.name)).filter((o) => o.kind === 'PersistentVolumeClaim' && !o.keep);
      if (pvcs.length > 0) {
        printWarning(
          `Helm release ${release.name} is no longer in config.yml but owns volumes (${pvcs.map((p) => p.name).join(', ')}); it keeps running. Remove it with: dockflow helm uninstall ${st.ref.env} ${release.name} --volumes`,
        );
        continue;
      }
      await this.helm.uninstall(release.namespace, release.name, { timeoutS: HELM_UNINSTALL_TIMEOUT_S });
      printInfo(`Uninstalled Helm release ${release.name} (no longer in config.yml)`);
    }
  }

  /** design-03 8.6: a full app deploy without registry credentials drops the pull Secret it no longer needs. */
  private async finalizeRegistrySecret(st: ReceiptState): Promise<void> {
    if (st.pullSecretName !== null) return;
    await this.kubectl.delete([`secrets/${K8S_REGISTRY_SECRET}`], { namespace: st.namespace, wait: false, ignoreNotFound: true });
  }

  private crds(): Promise<{ routes: boolean }> {
    if (this.memo.crds === null) {
      this.memo.crds = this.kubectl
        .getJson(['customresourcedefinitions.apiextensions.k8s.io'], { names: ['ingressroutes.traefik.io', 'middlewares.traefik.io'], ignoreNotFound: true })
        .then((crds) => ({ routes: crds.length >= 2 }));
      this.memo.crds.catch(() => {
        this.memo.crds = null;
      });
    }
    return this.memo.crds;
  }

  // ---------------------------------------------------------------------------
  // Queries (design-03 2.1: S4's read side, folded into this package)
  // ---------------------------------------------------------------------------

  async exists(ref: StackRef): Promise<boolean> {
    try {
      return await day2Exists(this.day2Deps(), ref);
    } catch (error) {
      throw this.mapQueryError(error, ref.env, `check whether ${namespaceFor(ref.project, ref.env)} exists`);
    }
  }

  async getServices(ref: StackRef): Promise<ServiceInfo[]> {
    const ns = namespaceFor(ref.project, ref.env);
    try {
      const stack = await this.inventory.read(ns);
      return toServiceInfos(stack.primary, ref.role, stack.releases);
    } catch (error) {
      if (error instanceof KubeError && error.reason === 'NotFound') return [];
      throw this.mapQueryError(error, ref.env, `read services of ${ns}`);
    }
  }

  async listInstances(ref: StackRef, options?: { service?: string; includeTerminated?: boolean }): Promise<InstanceInfo[]> {
    const ns = namespaceFor(ref.project, ref.env);
    try {
      const stack = await this.inventory.read(ns);
      const revisions = await stack.primary.revisions(ref.role);
      return instancesFor(
        stack.primary,
        { role: ref.role, service: options?.service, includeTerminated: options?.includeTerminated },
        revisions,
        buildNodeToServerMap(this.serverNames),
        this.redactor,
      );
    } catch (error) {
      if (error instanceof KubeError && error.reason === 'NotFound') return [];
      throw this.mapQueryError(error, ref.env, `list instances of ${ns}`);
    }
  }

  async diagnose(ref: StackRef, options: { verbose: boolean }): Promise<DiagnosticReport> {
    const ns = namespaceFor(ref.project, ref.env);
    const now = this.clock.now();
    const namespaceObject = await this.kubectl
      .getJson<Namespace>(['namespaces'], { name: ns, allowNotFound: true })
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    const currentRelease = namespaceObject
      ? await this.releases.currentVersion(`${ref.project}-${ref.env}`).catch(() => null)
      : null;
    // this process rendered nothing: what logs and descriptions must never print is learned here
    if (namespaceObject) await this.learnLiveSecrets(ns);

    const inventoryResult = await toResult(async () => (await this.inventory.read(ns)).primary);
    const revisions = inventoryResult.success ? await inventoryResult.data.revisions(null).catch(() => null) : null;
    const helmReleasesResult = await toResult<DiagnoseHelmRelease[]>(async () => {
      const releases = await this.helm.listAll(ns);
      const out: DiagnoseHelmRelease[] = [];
      for (const release of releases) {
        if (release.status === 'failed' || release.status.startsWith('pending-')) {
          const history = await this.helm.history(release.namespace, release.name, 1).catch(() => []);
          out.push({ ...release, description: history[0]?.description ?? null });
        } else {
          out.push(release);
        }
      }
      return out;
    });
    const eventsResult = await toResult(() => this.warningEvents(ns));
    const nodesResult = await toResult(() => this.kubectl.getJson<Node>(['nodes']));
    const proxyResult = this.proxy ? await toResult(() => this.proxy!.status()) : null;

    let crashLogs: CrashLogExcerpt[] = [];
    let descriptions: PodDescription[] = [];
    if (options.verbose && inventoryResult.success) {
      crashLogs = await this.readCrashLogs(ns, crashLogTargets(inventoryResult.data));
      descriptions = await this.readDescriptions(ns, describeTargets(inventoryResult.data));
    }

    const host = await this.hostFacts();

    const input: DiagnoseInput = {
      env: ref.env,
      namespace: ns,
      namespaceObject,
      currentRelease,
      verbose: options.verbose,
      inventory: inventoryResult,
      revisions,
      helmReleases: helmReleasesResult,
      events: eventsResult,
      nodes: nodesResult,
      proxy: proxyResult,
      crashLogs,
      descriptions,
      host,
      nodeToServer: buildNodeToServerMap(this.serverNames),
      redactor: this.redactor,
    };
    return buildDiagnosticReport(input, now);
  }

  /** Teaches the Redactor the Dockflow Secrets live in `ns`, both roles; best effort, the report prints anyway. */
  private async learnLiveSecrets(ns: string): Promise<void> {
    try {
      const secrets = await this.kubectl.getJson<ManifestObject>(['secrets'], { namespace: ns, selector: `${LABELS.hashed}=true` });
      this.redactor.add(secretValuesOf(secrets));
    } catch (error) {
      printDebug(`Secret values could not be read for redaction: ${errorText(error)}`);
    }
  }

  private async warningEvents(ns: string): Promise<Event[]> {
    const result = await this.kubectl.run({ args: ['get', 'events', '--field-selector=type=Warning', '-o', 'json'], namespace: ns, mutating: false });
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
      return (parsed as { items: Event[] }).items;
    }
    return [];
  }

  private async readCrashLogs(ns: string, targets: readonly CrashLogTarget[]): Promise<CrashLogExcerpt[]> {
    const out: CrashLogExcerpt[] = [];
    for (const target of targets) {
      const args = ['logs', target.pod, '-c', target.container, '--tail=20'];
      if (target.previous) args.push('--previous');
      let result = await this.kubectl.run({ args, namespace: ns, mutating: false, allowFailure: true });
      if (result.exitCode !== 0 && target.previous) {
        result = await this.kubectl.run({ args: args.filter((a) => a !== '--previous'), namespace: ns, mutating: false, allowFailure: true });
      }
      if (result.exitCode !== 0) continue;
      const lines = result.stdout.split(/\r?\n/).filter((line) => line !== '').map((line) => this.redactor.redact(line));
      out.push({ label: target.label, container: target.container, previous: target.previous, lines });
    }
    return out;
  }

  private async readDescriptions(ns: string, targets: readonly { pod: string; label: string }[]): Promise<PodDescription[]> {
    const out: PodDescription[] = [];
    for (const target of targets) {
      const result = await this.kubectl.run({ args: ['describe', 'pod', target.pod], namespace: ns, mutating: false, allowFailure: true });
      if (result.exitCode !== 0) continue;
      out.push({ label: target.label, text: this.redactor.redact(result.stdout) });
    }
    return out;
  }

  private async hostFacts(): Promise<DiagnoseHostFacts> {
    const shell = this.deps.nodeShell(this.controlPlane);
    const rootDisk = await toResult(() => this.hostCommand(shell, 'df -P / | tail -1'));
    const volumeRoot = this.distribution.localVolumeRoot;
    const volumeDisk = volumeRoot ? await toResult(() => this.hostCommand(shell, `df -P ${volumeRoot} 2>/dev/null | tail -1`)) : null;
    const memory = await toResult(() => this.hostCommand(shell, "free -m | awk 'NR==2{printf \"%.0f\", $3*100/$2}'"));
    return { rootDisk, volumeDisk, memory };
  }

  private async hostCommand(shell: ReturnType<KubernetesBundleDeps['nodeShell']>, script: string): Promise<string> {
    const result = await shell.run(script, { guardS: K8S_REQUEST_TIMEOUT_S });
    if (result.exitCode !== 0) throw new Error(result.stderr || `command failed with exit ${result.exitCode}`);
    return result.stdout;
  }

  // ---------------------------------------------------------------------------
  // Day-2 mutations (design-03 17, 18; delegated to stack-day2.ts, P59)
  // ---------------------------------------------------------------------------

  async scale(ref: StackRef, service: string, replicas: number, options: ControlOptions): Promise<void> {
    try {
      await day2Scale(this.day2Deps(), ref, service, replicas, options);
    } finally {
      this.inventory.invalidate(namespaceFor(ref.project, ref.env));
    }
  }

  async restart(ref: StackRef, service: string | null, options: ControlOptions): Promise<void> {
    try {
      await day2Restart(this.day2Deps(), ref, service, options);
    } finally {
      this.inventory.invalidate(namespaceFor(ref.project, ref.env));
    }
  }

  async rollbackService(ref: StackRef, service: string, options: ControlOptions): Promise<{ toVersion: string | null }> {
    try {
      return await day2RollbackService(this.day2Deps(), ref, service, options);
    } finally {
      this.inventory.invalidate(namespaceFor(ref.project, ref.env));
    }
  }

  async stop(ref: StackRef, services: string[] | null, options: ControlOptions): Promise<void> {
    try {
      await day2Stop(this.day2Deps(), ref, services, options);
    } finally {
      this.inventory.invalidate(namespaceFor(ref.project, ref.env));
    }
  }

  async remove(ref: StackRef, options: { volumes: 'retain' | 'delete' }): Promise<void> {
    try {
      await day2Remove(this.day2Deps(), ref, options);
    } finally {
      this.inventory.invalidate(namespaceFor(ref.project, ref.env));
    }
  }

  // ---------------------------------------------------------------------------
  // Shared dependency builders
  // ---------------------------------------------------------------------------

  private remember(receipt: DeployReceipt, state: ReceiptState): DeployReceipt {
    this.receipts.set(receipt, state);
    return receipt;
  }

  private waitDeps(): StackWaitDeps {
    return {
      kubectl: this.kubectl,
      clock: this.clock,
      redactor: this.redactor,
      distribution: this.distribution,
      nodeNames: nodeNameMap(this.serverNames),
    };
  }

  private day2Deps(): StackDay2Deps {
    return {
      ...this.waitDeps(),
      engine: this.engine,
      helm: this.helm,
      releases: this.releases,
      crds: () => this.crds(),
      apply: (ref, version, artifact, options) => this.apply(ref, version, artifact, options),
      waitConvergence: (receipt, options) => this.waitConvergence(receipt, options),
      helmHistoryMax: this.helmHistoryMax,
      helmAuth: this.helmAuthFn,
    };
  }

  private mapError(error: unknown, env: string, operation: string): DeployError {
    if (error instanceof KubeError) {
      const mapped = kubeErrorToCliError(error, { env, operation, mutating: true, distribution: this.distribution.traits.name });
      return new DeployError(mapped.message, mapped.code, mapped.suggestion);
    }
    if (error instanceof CLIError) return new DeployError(error.message, error.code, error.suggestion);
    return new DeployError(`${operation} failed: ${errorText(error)}`, ErrorCode.DEPLOY_FAILED);
  }

  /** apply()'s own failures are always ROLLBACK_FAILED: "revert of an apply receipt is not used" (16.2). */
  private mapApplyError(error: unknown, env: string): DeployError {
    if (error instanceof KubeError) {
      const mapped = kubeErrorToCliError(error, { env, operation: 'apply the release', mutating: true, distribution: this.distribution.traits.name });
      return new DeployError(mapped.message, ErrorCode.ROLLBACK_FAILED, mapped.suggestion);
    }
    if (error instanceof CLIError) return new DeployError(error.message, ErrorCode.ROLLBACK_FAILED, error.suggestion);
    return new DeployError(`apply release failed: ${errorText(error)}`, ErrorCode.ROLLBACK_FAILED);
  }

  private mapQueryError(error: unknown, env: string, operation: string): CLIError {
    if (error instanceof KubeError) return kubeErrorToCliError(error, { env, operation, mutating: false, distribution: this.distribution.traits.name });
    if (error instanceof CLIError) return error;
    return new OrchestratorUnavailableError(`${operation} failed: ${errorText(error)}`);
  }
}
