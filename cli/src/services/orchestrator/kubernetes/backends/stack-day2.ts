// Stack backend day-2 methods (design-03 17, 18): rollbackService, exists, remove,
// deleteRoleVolumes, stop, scale, restart. `backends/stack.ts` composes the rest of StackBackend
// and delegates these to this module; `apply` and `waitConvergence` are its own methods, so
// rollbackService calls back into them through StackDay2Deps rather than reimplementing them here
// (this module owns none of the render/apply/converge machinery). Backends never print (design-03
// section 0): only the informational lines the design explicitly assigns to this layer are printed
// here (rollbackService's outcome, stop's Helm warning), everything else returns data or throws.

import { CONVERGENCE_INTERVAL_S } from '../../../../constants';
import { CLIError, DeployError, ErrorCode, InterruptedError, UnsupportedOperationError } from '../../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { printDebug, printInfo, printWarning } from '../../../../utils/output';
import type {
  ControlOptions,
  HelmBackend,
  HelmManifestObject,
  HelmReleaseRecord,
  ReleaseStore,
  ResolvedHelmRelease,
  StackBackend,
  StackRef,
  StackRole,
} from '../../interfaces';
import type { ApplyEngine } from '../apply/engine';
import { closure } from '../apply/closure';
import { composeServiceOf, podSpecOf, templateRefs, type WorkloadObject } from '../apply/snapshot';
import { ANNOTATIONS, deleteWaitS, K8S_ROLLBACK_SCAN_LIMIT } from '../constants';
import { SEL_POD, SEL_ROLE } from '../labels';
import { namespaceFor } from '../naming';
import type { DaemonSet, Deployment, StatefulSet } from '../resources/apps';
import type { PersistentVolumeClaim } from '../resources/core';
import { KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import { parseJsonItems } from '../runtime/kubectl';
import { parseManifests } from '../yaml';
import {
  type InventoryPollResult,
  type InventoryTarget,
  inventorySummary,
  podsGone,
  pollInventoryUntil,
  rolledOut,
  scaledTo,
  type StackWaitDeps,
} from './stack-wait';
import { removeVolumesByProtocol, type VolumeTarget } from './volumes';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Everything design-03 17-18 needs, on top of the poll deps every wait already carries. */
export interface StackDay2Deps extends StackWaitDeps {
  /** namespace ownership guard (K01) and role snapshots (K07); used by `exists` and `remove` only */
  engine: Pick<ApplyEngine, 'assertNamespaceOwner' | 'snapshot'>;
  helm: Pick<HelmBackend, 'listAll' | 'manifestObjects' | 'uninstall' | 'upgradeInstall'>;
  releases: Pick<ReleaseStore, 'current' | 'list' | 'readArtifact' | 'writeAccessoriesDigest'>;
  /** the bundle's Traefik CRD memo (SharedMemo.crds); read before deleting routes */
  crds(): Promise<{ routes: boolean }>;
  /** `KubernetesStackBackend`'s own methods: rollbackService applies a stored release through them */
  apply: StackBackend['apply'];
  waitConvergence: StackBackend['waitConvergence'];
  /** design-03 2.5 `max(5, keep_releases + 2)`; config is outside this package */
  helmHistoryMax: number;
  /** `config.helm.releases[].auth` by release name; config is outside this package */
  helmAuth(release: string): { username: string; password: string } | null;
}

const RESTART_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function namesOf(targets: readonly { service: string }[]): string {
  return [...new Set(targets.map((t) => t.service))].sort(compareCodeUnits).join(', ');
}

/** design-03 18's `naming.describe(ref)`, inlined: `StackNaming`'s Kubernetes implementation is
 * not a dependency of this package (it is assembled later, in P63), and the wording is fixed by
 * core 6.1's own docstring ("namespace dockflow-shop-production (accessories)"). */
function describeRef(namespace: string, ref: Pick<StackRef, 'role'>): string {
  return ref.role === 'accessory' ? `namespace ${namespace} (accessories)` : `namespace ${namespace}`;
}

/** every restartable kind (Job excluded); a DaemonSet has no `spec.replicas`, so `currentReplicas`
 * reports it as always running (stop() never patches a DaemonSet, so it is never "at 0" here). */
function isRestartableWorkload(object: WorkloadObject): object is Deployment | StatefulSet | DaemonSet {
  return object.kind !== 'Job';
}

function currentReplicas(workload: Deployment | StatefulSet | DaemonSet): number {
  return workload.kind === 'DaemonSet' ? 1 : (workload.spec.replicas ?? 0);
}

function isScalableManifestObject(
  object: HelmManifestObject,
): object is HelmManifestObject & { kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' } {
  return object.kind === 'Deployment' || object.kind === 'StatefulSet' || object.kind === 'DaemonSet';
}

function waitFailureDetail(result: Extract<InventoryPollResult, { status: 'failed' | 'timeout' }>): string {
  return result.status === 'failed' ? result.failure.message : inventorySummary(result.pending[0]);
}

async function runPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Live reads shared by stop / scale / restart
// ---------------------------------------------------------------------------

/** K07 restricted to workload kinds: the whole role, or the named compose services. */
async function readComposeWorkloads(
  deps: StackDay2Deps,
  namespace: string,
  role: StackRole,
  services: readonly string[] | undefined,
): Promise<WorkloadObject[]> {
  const selector = services === undefined ? SEL_ROLE(namespace, role) : SEL_POD(namespace, role, services);
  return deps.kubectl.getJson<WorkloadObject>(
    ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps', 'jobs.batch'],
    { namespace, selector },
  );
}

/** the one workload of a single compose service, by name (K07 narrowed to one `P/service`). */
async function findComposeWorkload(
  deps: StackDay2Deps,
  namespace: string,
  role: StackRole,
  service: string,
): Promise<WorkloadObject | null> {
  const items = await readComposeWorkloads(deps, namespace, role, [service]);
  return items[0] ?? null;
}

/** Explicit `kind/name` targets (Helm workloads carry none of Dockflow's own selectors). */
async function readNamedWorkloads(
  deps: StackDay2Deps,
  namespace: string,
  targets: readonly { kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'; name: string }[],
): Promise<WorkloadObject[]> {
  if (targets.length === 0) return [];
  const result = await deps.kubectl.run({
    args: ['get', targets.map((t) => `${KIND_REGISTRY[t.kind].resource}/${t.name}`).join(','), '--ignore-not-found', '-o', 'json'],
    namespace,
    mutating: false,
  });
  return parseJsonItems<WorkloadObject>(result.stdout);
}

interface Day2Target {
  /** compose service name, or Helm release name */
  service: string;
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  name: string;
  namespace: string;
  replicas: number;
  /** raw `P/replicas-before-stop` annotation, when present */
  annotation: string | undefined;
  /** false: a Dockflow compose workload (carries `P/service`); true: a Helm workload (does not) */
  helm: boolean;
}

/**
 * The label selector `pollInventoryUntil` should read each involved namespace with: `SEL_POD` for
 * a namespace whose targets are all compose workloads (matches the fake's `k12()`-shaped reads and
 * the real cluster's index), whole-namespace (no selector) for one holding a Helm workload, which
 * carries none of Dockflow's own labels.
 */
function pollSelectors(role: StackRole, targets: readonly Day2Target[]): Record<string, string> {
  const byNamespace = new Map<string, { services: Set<string>; onlyCompose: boolean }>();
  for (const target of targets) {
    const entry = byNamespace.get(target.namespace) ?? { services: new Set<string>(), onlyCompose: true };
    entry.services.add(target.service);
    if (target.helm) entry.onlyCompose = false;
    byNamespace.set(target.namespace, entry);
  }
  const selectors: Record<string, string> = {};
  for (const [namespace, entry] of byNamespace) {
    if (entry.onlyCompose) selectors[namespace] = SEL_POD(namespace, role, [...entry.services]);
  }
  return selectors;
}

/** Live Deployment/StatefulSet/DaemonSet workloads of one Helm release, by name (Jobs excluded). */
async function helmWorkloadTargets(
  deps: StackDay2Deps,
  release: { name: string; namespace: string },
): Promise<Day2Target[]> {
  const manifest = (await deps.helm.manifestObjects(release.namespace, release.name)).filter(isScalableManifestObject);
  if (manifest.length === 0) return [];
  const live = await readNamedWorkloads(
    deps,
    release.namespace,
    manifest.map((object) => ({ kind: object.kind, name: object.name })),
  );
  return live.filter(isRestartableWorkload).map((workload) => ({
    service: release.name,
    kind: workload.kind,
    name: workload.metadata.name,
    namespace: release.namespace,
    replicas: currentReplicas(workload),
    annotation: workload.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop],
    helm: true,
  }));
}

function stopPatchBody(replicas: number): string {
  return JSON.stringify({ metadata: { annotations: { [ANNOTATIONS.replicasBeforeStop]: String(replicas) } }, spec: { replicas: 0 } });
}

function resumePatchBody(replicas: number): string {
  return JSON.stringify({ metadata: { annotations: { [ANNOTATIONS.replicasBeforeStop]: null } }, spec: { replicas } });
}

/** K50: the one merge patch that moves the annotation and `spec.replicas` together. */
async function patchWorkload(
  deps: StackDay2Deps,
  namespace: string,
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet',
  name: string,
  body: string,
): Promise<void> {
  await deps.kubectl.run({ args: ['patch', `${KIND_REGISTRY[kind].resource}/${name}`, '--type=merge', '-p', body], namespace, mutating: true });
}

// ---------------------------------------------------------------------------
// rollbackService (design-03 17)
// ---------------------------------------------------------------------------

function ownClosure(objects: readonly ManifestObject[], service: string): ManifestObject[] {
  return closure(objects, [service], { excludePvcs: true }).objects;
}

/** design-03 17's `digest`: the closure's canonical shape. */
function serviceDigest(objects: readonly ManifestObject[], service: string): string {
  return sha256Hex(canonicalJson(ownClosure(objects, service)));
}

/** the tuple a Helm record's rollback candidacy is compared on: chart, version, values checksum. */
function helmReleaseDigest(record: HelmReleaseRecord): string {
  return sha256Hex(canonicalJson({ chart: record.chart, version: record.version, valuesSha256: record.valuesSha256 }));
}

/** `ResolvedHelmRelease` cannot be rebuilt from the stored record alone: auth is never persisted,
 * and `declaredDigest` is the record's own pinned `chartSha256` (re-install from those exact bytes). */
function toResolvedRelease(record: HelmReleaseRecord, auth: ResolvedHelmRelease['auth']): ResolvedHelmRelease {
  const { chartSha256, ...rest } = record;
  return { ...rest, auth, declaredDigest: chartSha256 };
}

function availableServiceNames(objects: readonly ManifestObject[], helm: readonly HelmReleaseRecord[]): string[] {
  const names = new Set<string>();
  for (const object of objects) {
    const name = object.metadata.annotations?.[ANNOTATIONS.composeService];
    if (name !== undefined) names.add(name);
  }
  for (const release of helm) names.add(release.name);
  return [...names].sort(compareCodeUnits);
}

/**
 * Rolls one service back to the newest older stored release whose closure for it differs from the
 * current release (no `rollout undo` fallback, DV2: it would leave Services and routes behind).
 * Never touches `current`; idempotent relative to it.
 */
export async function rollbackService(
  deps: StackDay2Deps,
  ref: StackRef,
  service: string,
  options: ControlOptions,
): Promise<{ toVersion: string | null }> {
  if (ref.role !== 'app') {
    // R-12: the command's own guard (design-06 3.13) already raises this; repeated here as a
    // defensive check for a caller that skips it.
    throw new CLIError(
      `Service ${service} is an accessory; accessories have no release history`,
      ErrorCode.SERVICE_NOT_FOUND,
      `Change accessories.yml and run \`dockflow deploy ${ref.env} --accessories\`.`,
    );
  }
  const stackName = `${ref.project}-${ref.env}`;
  const current = await deps.releases.current(stackName);
  if (!current) {
    throw new DeployError(
      `No release is recorded for ${stackName}`,
      ErrorCode.ROLLBACK_FAILED,
      `Deploy first with \`dockflow deploy ${ref.env}\`.`,
    );
  }

  const currentArtifact = await deps.releases.readArtifact(stackName, current.version);
  const currentObjects = parseManifests(currentArtifact.content);
  const isHelm = currentArtifact.helm.some((h) => h.name === service);
  if (!isHelm && ownClosure(currentObjects, service).length === 0) {
    throw new CLIError(
      `Service ${service} is not part of release ${current.version}`,
      ErrorCode.SERVICE_NOT_FOUND,
      `Choose one of: ${availableServiceNames(currentObjects, currentArtifact.helm).join(', ')}.`,
    );
  }
  const reference = isHelm
    ? helmReleaseDigest(currentArtifact.helm.find((h) => h.name === service) as HelmReleaseRecord)
    : serviceDigest(currentObjects, service);

  const older = (await deps.releases.list(stackName)).filter((r) => r.epoch < current.epoch).slice(0, K8S_ROLLBACK_SCAN_LIMIT);

  for (const candidateRelease of older) {
    const artifact = await deps.releases.readArtifact(stackName, candidateRelease.version).catch(() => null);
    if (!artifact || artifact.format !== 'k8s-manifests/1') {
      printDebug(`Skipping release ${candidateRelease.version} (${artifact?.format ?? 'unreadable'})`);
      continue;
    }
    const objects = parseManifests(artifact.content);
    const helmCandidate = isHelm ? artifact.helm.find((h) => h.name === service) : undefined;
    const present = isHelm ? helmCandidate !== undefined : ownClosure(objects, service).length > 0;
    if (!present) continue; // K20: removed then re-added stays rollback-able; keep searching
    const candidateDigest = isHelm ? helmReleaseDigest(helmCandidate as HelmReleaseRecord) : serviceDigest(objects, service);
    if (candidateDigest === reference) continue;

    if (isHelm) {
      const record = helmCandidate as HelmReleaseRecord;
      const resolved = toResolvedRelease(record, deps.helmAuth(service));
      await deps.helm.upgradeInstall(resolved, { historyMax: deps.helmHistoryMax, stackId: namespaceFor(ref.project, ref.env) });
      printInfo(`Helm release ${service} rolled back to its definition in release ${candidateRelease.version}`);
      return { toVersion: candidateRelease.version };
    }

    const applied = await deps.apply(ref, candidateRelease.version, artifact, { prune: false, services: [service] });
    if (!applied.success) throw applied.error;
    if (options.wait) {
      const convergence = await deps.waitConvergence(applied.data, { timeoutS: options.timeoutS, intervalS: CONVERGENCE_INTERVAL_S });
      if (convergence.status !== 'converged') {
        throw new DeployError(
          `Rolling back ${service} to release ${candidateRelease.version} did not converge: ${convergence.message}`,
          ErrorCode.ROLLBACK_FAILED,
          `Run \`dockflow diagnose ${ref.env}\`, then \`dockflow deploy ${ref.env}\` to restore the current definition.`,
        );
      }
    }
    printInfo(`Service ${service} rolled back to its definition in release ${candidateRelease.version}`);
    return { toVersion: candidateRelease.version };
  }

  throw new DeployError(
    `${isHelm ? `Helm release ${service}` : `Service ${service}`} has the same definition in every stored release; there is nothing to roll back to`,
    ErrorCode.ROLLBACK_FAILED,
    `Restore a whole release with \`dockflow rollback ${ref.env}\`.`,
  );
}

// ---------------------------------------------------------------------------
// exists (design-03 18.1)
// ---------------------------------------------------------------------------

/** `false` on a missing namespace; stopped workloads and Helm-only accessories still count. */
export async function exists(deps: StackDay2Deps, ref: StackRef): Promise<boolean> {
  if ((await deps.engine.assertNamespaceOwner(ref)) === 'missing') return false;
  const namespace = namespaceFor(ref.project, ref.env);
  const snapshot = await deps.engine.snapshot(namespace, ref.role);
  if (snapshot.workloads.length > 0) return true;
  const releases = await deps.helm.listAll(namespace);
  return releases.some((release) => release.role === ref.role);
}

// ---------------------------------------------------------------------------
// deleteRoleVolumes (design-03 18.3, PD-15)
// ---------------------------------------------------------------------------

/**
 * The role's own PVCs (K09), deleted one at a time through the shared C13 protocol (PD-15). Called
 * only from `remove`, after the role's workloads are already gone, so `deleteWaitS([])` (the floor)
 * is the right budget: nothing is still using these claims.
 */
export async function deleteRoleVolumes(deps: StackDay2Deps, ref: StackRef, roleSel: string, signal?: AbortSignal): Promise<void> {
  const namespace = namespaceFor(ref.project, ref.env);
  const claims = await deps.kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace, selector: roleSel });
  if (claims.length === 0) return;
  const targets: VolumeTarget[] = claims.map((claim) => ({ claim: claim.metadata.name, volume: claim.spec.volumeName ?? null }));
  await removeVolumesByProtocol(deps, targets, { namespace, env: ref.env, waitS: deleteWaitS([]), signal });
}

// ---------------------------------------------------------------------------
// remove (design-03 18.2)
// ---------------------------------------------------------------------------

/**
 * Ordered deletion (design-03 8.4 / K25): Helm releases of the role, routes (`--wait=false`, so
 * traffic stops first), workloads (foreground, waited), Services/Secrets/ConfigMaps, then volumes
 * when asked. The namespace, release Secrets, `dockflow-state`, the registry Secret, the other role
 * and PVCs (unless `volumes: 'delete'`) are kept by design. Ctrl+C (`signal`) lets the workloads go
 * and stops before the volumes, or between two of them.
 */
export async function remove(deps: StackDay2Deps, ref: StackRef, options: { volumes: 'retain' | 'delete'; signal?: AbortSignal }): Promise<void> {
  const namespace = namespaceFor(ref.project, ref.env);
  if ((await deps.engine.assertNamespaceOwner(ref)) === 'missing') return;
  const podSel = SEL_POD(namespace, ref.role);
  const roleSel = SEL_ROLE(namespace, ref.role);
  const live = await deps.engine.snapshot(namespace, ref.role);
  const waitS = deleteWaitS(live.workloads);

  // 1. Helm releases of the role (DV3: only manifest PVCs without helm.sh/resource-policy: keep
  //    block an implicit uninstall — those Helm itself never deletes anyway)
  for (const release of (await deps.helm.listAll(namespace)).filter((h) => h.role === ref.role)) {
    const pvcs = (await deps.helm.manifestObjects(release.namespace, release.name)).filter(
      (object) => object.kind === 'PersistentVolumeClaim' && !object.keep,
    );
    if (pvcs.length > 0 && options.volumes === 'retain') {
      printWarning(
        `Helm release ${release.name} owns volumes (${pvcs.map((p) => p.name).join(', ')}) and keeps running; remove it with: dockflow helm uninstall ${ref.env} ${release.name} --volumes`,
      );
      continue;
    }
    await deps.helm.uninstall(release.namespace, release.name, { timeoutS: waitS });
  }

  // 2. routes first (traffic stops before the pods do)
  if ((await deps.crds()).routes) {
    await deps.kubectl.run({
      args: ['delete', 'ingressroutes.traefik.io,middlewares.traefik.io', '-l', roleSel, '--ignore-not-found', '--wait=false'],
      namespace,
      mutating: true,
    });
  }

  // 3. workloads, foreground, waited
  await deps.kubectl.run({
    args: [
      'delete',
      'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch',
      '-l',
      roleSel,
      '--ignore-not-found',
      '--cascade=foreground',
      '--wait=true',
      `--timeout=${waitS}s`,
    ],
    namespace,
    mutating: true,
    requestTimeoutS: null,
    guardS: waitS + 30,
  });

  // 4. pods gone (success when nothing matches)
  const waited = await deps.kubectl.run({
    args: ['wait', '--for=delete', 'pods', '-l', podSel, `--timeout=${waitS}s`],
    namespace,
    mutating: false,
    requestTimeoutS: null,
    guardS: waitS + 30,
    allowFailure: true,
  });
  if (waited.exitCode !== 0) {
    const left = (await deps.kubectl.getJson(['pods'], { namespace, selector: podSel })).length;
    throw new DeployError(
      `Stopping ${describeRef(namespace, ref)} timed out after ${waitS}s: ${left} pod(s) still terminating`,
      ErrorCode.DEPLOY_FAILED,
      `Run \`dockflow diagnose ${ref.env}\`.`,
    );
  }

  // 5. Services and the role's env/secret/config objects
  await deps.kubectl.run({
    args: ['delete', 'services,secrets,configmaps', '-l', roleSel, '--ignore-not-found', '--wait=false'],
    namespace,
    mutating: true,
  });

  // 6. accessories change detection: with its workloads gone, the role must not be skipped as
  //    unchanged next deploy, whatever happens to its volumes
  if (ref.role === 'accessory') await deps.releases.writeAccessoriesDigest(namespace, null);

  // 7. volumes
  if (options.volumes === 'delete') {
    if (options.signal?.aborted) throw new InterruptedError('Removal interrupted before any volume was deleted', 'Run the command again to delete them.');
    await deleteRoleVolumes(deps, ref, roleSel, options.signal);
  }
}

// ---------------------------------------------------------------------------
// stop (design-03 18.4)
// ---------------------------------------------------------------------------

function daemonSetStopRefusal(ref: StackRef, service: string): UnsupportedOperationError {
  return ref.role === 'app'
    ? new UnsupportedOperationError(
        `Service ${service} runs in global mode and cannot be stopped`,
        `Remove it with \`dockflow stop ${ref.env}\`, or change \`deploy.mode\`.`,
      )
    : new UnsupportedOperationError(
        `Accessory ${service} runs in global mode and cannot be stopped`,
        `Remove the accessories with \`dockflow accessories remove ${ref.env}\`, or change \`deploy.mode\`.`,
      );
}

/**
 * Scales targets to 0, recording the replica count in one merge patch (K50) so `restart` can
 * resume it. Targets already at 0 are untouched. A named DaemonSet is refused (R-13); one swept up
 * by "all services" is skipped with a warning. Jobs are skipped silently (no running pods to stop).
 */
export async function stop(deps: StackDay2Deps, ref: StackRef, services: string[] | null, options: ControlOptions): Promise<void> {
  const namespace = namespaceFor(ref.project, ref.env);
  const composeWorkloads = await readComposeWorkloads(deps, namespace, ref.role, services ?? undefined);
  const helmReleases = (await deps.helm.listAll(namespace)).filter(
    (release) => release.role === ref.role && (services === null || services.includes(release.name)),
  );

  if (services !== null) {
    const known = new Set<string>();
    for (const workload of composeWorkloads) {
      const name = composeServiceOf(workload);
      if (name !== null) known.add(name);
    }
    for (const release of helmReleases) known.add(release.name);
    const missing = services.find((name) => !known.has(name));
    if (missing !== undefined) {
      const available = [...known].sort(compareCodeUnits);
      throw new CLIError(
        `Accessory ${missing} is not deployed`,
        ErrorCode.SERVICE_NOT_FOUND,
        available.length > 0 ? `Choose one of: ${available.join(', ')}.` : `Deploy accessories first with \`dockflow deploy ${ref.env} --accessories\`.`,
      );
    }
  }

  const targets: Day2Target[] = [];

  for (const workload of composeWorkloads) {
    if (workload.kind === 'Job') continue;
    const service = composeServiceOf(workload);
    if (service === null) continue;
    if (workload.kind === 'DaemonSet') {
      if (services !== null) throw daemonSetStopRefusal(ref, service);
      printWarning(`Accessory ${service} runs in global mode and was not stopped`);
      continue;
    }
    const replicas = workload.spec.replicas ?? 0;
    if (replicas === 0) continue;
    await patchWorkload(deps, namespace, workload.kind, workload.metadata.name, stopPatchBody(replicas));
    targets.push({ service, kind: workload.kind, name: workload.metadata.name, namespace, replicas: 0, annotation: undefined, helm: false });
  }

  for (const release of helmReleases) {
    const helmTargets = await helmWorkloadTargets(deps, release);
    let stopped = false;
    for (const target of helmTargets) {
      // a DaemonSet has no spec.replicas to scale: it runs on every node until the release goes
      if (target.kind === 'DaemonSet') {
        printWarning(`Helm release ${release.name} runs DaemonSet ${target.name} on every node, which was not stopped`);
        continue;
      }
      if (target.replicas === 0) continue;
      await patchWorkload(deps, target.namespace, target.kind, target.name, stopPatchBody(target.replicas));
      targets.push({ ...target, replicas: 0 });
      stopped = true;
    }
    if (stopped) printWarning(`Helm release ${release.name} was scaled to 0; its next upgrade restores the chart's replica count`);
  }

  if (!options.wait || targets.length === 0) return;
  const inventoryTargets: InventoryTarget[] = targets.map((t) => ({ service: t.service, kind: t.kind, name: t.name, namespace: t.namespace }));
  const result = await pollInventoryUntil(
    inventoryTargets,
    podsGone(),
    { env: ref.env, role: ref.role, timeoutS: options.timeoutS, selectors: pollSelectors(ref.role, targets) },
    deps,
  );
  if (result.status !== 'done') {
    const pending = result.status === 'timeout' ? result.pending.length : targets.length;
    throw new DeployError(
      `Stopping ${namesOf(targets)} timed out after ${options.timeoutS}s: ${pending} pod(s) still terminating`,
      ErrorCode.DEPLOY_FAILED,
      `Run \`dockflow diagnose ${ref.env}\`.`,
    );
  }
}

// ---------------------------------------------------------------------------
// scale (design-03 18.5)
// ---------------------------------------------------------------------------

/** R-08: a Deployment (or a StatefulSet's non-template volume) mounting a shared ReadWriteOnce
 * claim cannot run more than one replica; returns the compose volume key when it does. */
async function sharedRwoConflict(deps: StackDay2Deps, namespace: string, workload: Deployment | StatefulSet): Promise<string | null> {
  const claimNames = templateRefs(podSpecOf(workload)).claims;
  if (claimNames.length === 0) return null;
  const claims = await deps.kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], {
    namespace,
    names: claimNames,
    ignoreNotFound: true,
  });
  for (const claim of claims) {
    if (claim.spec.accessModes.includes('ReadWriteOnce') || claim.spec.accessModes.includes('ReadWriteOncePod')) {
      return claim.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? claim.metadata.name;
    }
  }
  return null;
}

/**
 * Scales one compose service. Resuming from a stop (the annotation present, `replicas > 0`) is one
 * merge patch that also clears the annotation; every other case is a plain `kubectl scale`.
 */
export async function scale(deps: StackDay2Deps, ref: StackRef, service: string, replicas: number, options: ControlOptions): Promise<void> {
  const namespace = namespaceFor(ref.project, ref.env);
  const workload = await findComposeWorkload(deps, namespace, ref.role, service);
  if (workload === null) {
    throw new CLIError(`Service ${service} is not deployed`, ErrorCode.SERVICE_NOT_FOUND, `Run \`dockflow ps ${ref.env}\` to see what is deployed.`);
  }
  if (workload.kind === 'DaemonSet') {
    throw new UnsupportedOperationError(
      `Service ${service} runs in global mode (one instance per node) and cannot be scaled`,
      'Change `deploy.mode` in docker-compose.yml, or use placement constraints to choose its nodes.',
    );
  }
  if (workload.kind === 'Job') {
    throw new UnsupportedOperationError(`Service ${service} runs as a job and cannot be scaled`, `Run it again with \`dockflow deploy ${ref.env}\`.`);
  }
  if (replicas > 1) {
    const conflict = await sharedRwoConflict(deps, namespace, workload);
    if (conflict !== null) {
      throw new UnsupportedOperationError(
        `Service ${service} mounts volume ${conflict} (ReadWriteOnce) and cannot run more than 1 replica`,
        'Give each replica its own volume with `x-dockflow: {kind: statefulset}` and `volumes.<key>.x-dockflow.per_replica: true`.',
      );
    }
  }

  const annotation = workload.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop];
  if (annotation !== undefined && replicas > 0) {
    await patchWorkload(deps, namespace, workload.kind, workload.metadata.name, resumePatchBody(replicas));
  } else {
    await deps.kubectl.run({
      args: ['scale', `${KIND_REGISTRY[workload.kind].resource}/${workload.metadata.name}`, `--replicas=${replicas}`],
      namespace,
      mutating: true,
    });
  }

  if (!options.wait) return;
  const target: InventoryTarget = { service, kind: workload.kind, name: workload.metadata.name, namespace };
  const result = await pollInventoryUntil(
    [target],
    scaledTo(replicas),
    { env: ref.env, role: ref.role, timeoutS: options.timeoutS, selectors: { [namespace]: SEL_POD(namespace, ref.role, [service]) } },
    deps,
  );
  if (result.status !== 'done') {
    throw new DeployError(
      `Service ${service} did not reach ${replicas} ready replica(s) within ${options.timeoutS}s (${waitFailureDetail(result)})`,
      ErrorCode.DEPLOY_FAILED,
      `Run \`dockflow diagnose ${ref.env}\`.`,
    );
  }
}

// ---------------------------------------------------------------------------
// restart (design-03 18.6)
// ---------------------------------------------------------------------------

function groupByNamespace(targets: readonly Day2Target[]): [string, Day2Target[]][] {
  const groups = new Map<string, Day2Target[]>();
  for (const target of targets) {
    const group = groups.get(target.namespace);
    if (group) group.push(target);
    else groups.set(target.namespace, [target]);
  }
  return [...groups.entries()];
}

async function restartTargets(deps: StackDay2Deps, namespace: string, ref: StackRef, service: string | null): Promise<Day2Target[]> {
  if (service !== null) {
    const workload = await findComposeWorkload(deps, namespace, ref.role, service);
    if (workload !== null) {
      if (workload.kind === 'Job') {
        throw new UnsupportedOperationError(
          `Service ${service} runs as a Kubernetes Job and cannot be restarted`,
          `Change its definition and run \`dockflow deploy ${ref.env}\` to run it again.`,
        );
      }
      return [
        {
          service,
          kind: workload.kind,
          name: workload.metadata.name,
          namespace,
          replicas: currentReplicas(workload),
          annotation: workload.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop],
          helm: false,
        },
      ];
    }
    const release = (await deps.helm.listAll(namespace)).find((r) => r.role === ref.role && r.name === service);
    if (release === undefined) {
      throw new CLIError(`Service ${service} is not deployed`, ErrorCode.SERVICE_NOT_FOUND, `Run \`dockflow ps ${ref.env}\` to see what is deployed.`);
    }
    return helmWorkloadTargets(deps, release);
  }

  const compose: Day2Target[] = [];
  for (const workload of (await readComposeWorkloads(deps, namespace, ref.role, undefined)).filter(isRestartableWorkload)) {
    const composeService = composeServiceOf(workload);
    if (composeService === null) continue;
    compose.push({
      service: composeService,
      kind: workload.kind,
      name: workload.metadata.name,
      namespace,
      replicas: currentReplicas(workload),
      annotation: workload.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop],
      helm: false,
    });
  }
  const releases = (await deps.helm.listAll(namespace)).filter((r) => r.role === ref.role);
  const helm = (await Promise.all(releases.map((release) => helmWorkloadTargets(deps, release)))).flat();
  return [...compose, ...helm];
}

/**
 * Restarts one service, one Helm release's workloads, or (with no argument) every workload of the
 * role. A target at `spec.replicas === 0` is resumed (K61: `rollout restart` on it would start
 * nothing) with the recorded count or 1; every other target is rolled with `kubectl rollout
 * restart` (K36, field manager `kubectl-rollout`), one call per namespace naming every target in it.
 */
export async function restart(deps: StackDay2Deps, ref: StackRef, service: string | null, options: ControlOptions): Promise<void> {
  const namespace = namespaceFor(ref.project, ref.env);
  const targets = await restartTargets(deps, namespace, ref, service);
  if (targets.length === 0) {
    throw new CLIError(`No services of ${describeRef(namespace, ref)} are running`, ErrorCode.STACK_NOT_FOUND);
  }

  const toResume = targets.filter((t) => t.replicas === 0);
  const toRestart = targets.filter((t) => t.replicas > 0);

  await runPool(toResume, RESTART_CONCURRENCY, (target) => {
    const resumed = target.annotation !== undefined ? Number.parseInt(target.annotation, 10) || 1 : 1;
    return patchWorkload(deps, target.namespace, target.kind, target.name, resumePatchBody(resumed));
  });

  for (const [ns, group] of groupByNamespace(toRestart)) {
    await deps.kubectl.run({
      args: ['rollout', 'restart', ...group.map((t) => `${KIND_REGISTRY[t.kind].resource}/${t.name}`)],
      namespace: ns,
      mutating: true,
    });
  }

  if (!options.wait) return;
  const inventoryTargets: InventoryTarget[] = targets.map((t) => ({ service: t.service, kind: t.kind, name: t.name, namespace: t.namespace }));
  const result = await pollInventoryUntil(
    inventoryTargets,
    rolledOut(),
    { env: ref.env, role: ref.role, timeoutS: options.timeoutS, selectors: pollSelectors(ref.role, targets) },
    deps,
  );
  if (result.status !== 'done') {
    throw new DeployError(
      `Restart of ${namesOf(targets)} did not complete within ${options.timeoutS}s: ${waitFailureDetail(result)}`,
      ErrorCode.DEPLOY_FAILED,
      `Run \`dockflow diagnose ${ref.env}\`.`,
    );
  }
}
