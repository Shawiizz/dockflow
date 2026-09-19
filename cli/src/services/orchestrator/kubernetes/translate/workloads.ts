// Workload objects around a service's pod template (design-02 3, 4): the kind the normalizer chose,
// its rollout strategy and timing (PD-5), the restart policy mapping and exactly the per-kind field
// set of emission rule 8. Pure (T2). The pod template and the claim templates arrive as parameters
// from translate/index.ts; this module never imports another translate module (PD-1).

import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { ANNOTATIONS, MAX_MIN_READY_S, minReadySecondsFor, progressDeadlineFor } from '../constants';
import { selectorLabels, serviceObjectLabels } from '../labels';
import type { CanonicalService, CanonicalVolume, RestartSpec, UpdateSpec, VolumeMountSpec, WorkloadKind } from '../model/types';
import { headlessServiceName, jobNameFor } from '../naming';
import { compareCodeUnits, DOCKER_UPDATE_DEFAULTS, DOCKFLOW_UPDATE_DEFAULTS } from '../normalize/context';
import type { DaemonSet, DaemonSetUpdateStrategy, Deployment, DeploymentStrategy, StatefulSet } from '../resources/apps';
import type { Job, JobSpec } from '../resources/batch';
import type { PodSpec, PodTemplateSpec } from '../resources/core';
import type { IntOrString, LabelSelector, ObjectMeta } from '../resources/meta';
import { type ClaimTemplates, type PodTemplate, type TranslateContext, translatorBug } from './context';
import { reportTranslator } from './diagnostics';

export type Workload = Deployment | StatefulSet | DaemonSet | Job;

/** Kubernetes' own default, written out because backoffLimit is part of the checksum that names the Job. */
export const JOB_DEFAULT_BACKOFF_LIMIT = 6;

/**
 * Swarm's `parallelism: 0` means "every task at once" on every kind (K38); anything else would be
 * a different rollout, not a translation.
 */
export function amount(parallelism: number): IntOrString {
  return parallelism === 0 ? '100%' : parallelism;
}

/** `backoffLimit` of a Job: `restart: "no"` runs it exactly once, whatever max_attempts says (design-02 4.5). */
export function jobBackoffLimit(restart: RestartSpec): number {
  if (restart.condition === 'none') return 0;
  return restart.maxAttempts ?? JOB_DEFAULT_BACKOFF_LIMIT;
}

/** Node ports the pods bind themselves: a surge pod on the same node could never bind them again. */
export function exclusiveHostPorts(svc: CanonicalService): boolean {
  return (
    svc.network.hostNetwork ||
    svc.ports.some((p) => p.published !== null && (p.mode === 'host' || svc.extension.publish === 'hostport'))
  );
}

export interface ClaimMount {
  mount: VolumeMountSpec;
  volume: CanonicalVolume;
}

function volumeOf(svc: CanonicalService, mount: VolumeMountSpec, ctx: TranslateContext): CanonicalVolume {
  return ctx.volumes.get(mount.volume) ?? translatorBug(`Service ${svc.composeName} mounts volume ${mount.volume}, which the stack does not declare`);
}

/**
 * Mounts of a claim every replica shares and that binds to one node (ReadWriteOnce or
 * ReadWriteOncePod, not per replica), in model order. A read-only mount counts too: D8 is literal.
 */
export function rwoMounts(svc: CanonicalService, ctx: TranslateContext): ClaimMount[] {
  return svc.mounts.flatMap((mount): ClaimMount[] => {
    if (mount.type !== 'volume') return [];
    const volume = volumeOf(svc, mount, ctx);
    return !volume.perReplica && volume.accessMode !== 'ReadWriteMany' ? [{ mount, volume }] : [];
  });
}

function deployPath(svc: CanonicalService, ...segments: string[]): string {
  return [svc.path, 'deploy', ...segments].join('.');
}

function injectedDefaults(update: UpdateSpec): Readonly<UpdateSpec> {
  return update.defaults === 'dockflow' ? DOCKFLOW_UPDATE_DEFAULTS : DOCKER_UPDATE_DEFAULTS;
}

// ---------------------------------------------------------------------------
// Checks shared by several kinds
// ---------------------------------------------------------------------------

/** Replicas of one workload scheduled against a single-node claim cannot all start (D8, design-01 V1). */
function checkSharedClaimReplicas(svc: CanonicalService, shared: readonly ClaimMount[], ctx: TranslateContext): void {
  const first = shared[0];
  if (first === undefined || svc.replicas <= 1) return;
  reportTranslator(ctx.sink, 'volumes.rwo-replicas', deployPath(svc, 'replicas'), {
    service: svc.composeName,
    volume: first.volume.key,
    accessMode: first.volume.accessMode,
    replicas: svc.replicas,
  });
}

/** `minReadySeconds` from `update_config.monitor`, refused rather than capped when no rollout could be observed (PD-5). */
function checkedMinReadySeconds(svc: CanonicalService, ctx: TranslateContext): number {
  const seconds = minReadySecondsFor(svc.update.monitorMs);
  if (seconds > MAX_MIN_READY_S) {
    reportTranslator(ctx.sink, 'update.monitor-too-long', deployPath(svc, 'update_config', 'monitor'), {
      service: svc.composeName,
      monitorS: seconds,
    });
  }
  return seconds;
}

function minReadyField(seconds: number): { minReadySeconds?: number } {
  return seconds > 0 ? { minReadySeconds: seconds } : {};
}

/** Kubernetes retries with its own back-off; only a Job has a use for max_attempts (design-02 4.5, C2). */
function checkRestartPolicy(svc: CanonicalService, ctx: TranslateContext): void {
  const written: [field: string, value: number | null][] = [
    ['delay', svc.restart.delayMs],
    ['max_attempts', svc.workloadKind === 'Job' ? null : svc.restart.maxAttempts],
    ['window', svc.restart.windowMs],
  ];
  for (const [field, value] of written) {
    if (value === null) continue;
    // One entry per field: the sink keeps one diagnostic per (code, path).
    reportTranslator(ctx.sink, 'deploy.restart-policy-unsupported', deployPath(svc, 'restart_policy', field), {
      service: svc.composeName,
      field,
    });
  }
}

/** start-first unless the pods bind node ports, where a surge pod would never start (update.surge-disabled). */
function effectiveOrder(svc: CanonicalService, ctx: TranslateContext): UpdateSpec['order'] {
  const order = svc.update.order;
  if (order !== 'start-first' || !exclusiveHostPorts(svc)) return order;
  reportTranslator(
    ctx.sink,
    'update.surge-disabled',
    deployPath(svc, 'update_config', 'order'),
    { service: svc.composeName },
    { equalsDefault: order === injectedDefaults(svc.update).order },
  );
  return 'stop-first';
}

function rollingAmounts(order: UpdateSpec['order'], parallelism: number): { maxSurge: IntOrString; maxUnavailable: IntOrString } {
  return order === 'start-first'
    ? { maxSurge: amount(parallelism), maxUnavailable: 0 }
    : { maxSurge: 0, maxUnavailable: amount(parallelism) };
}

// ---------------------------------------------------------------------------
// Object parts
// ---------------------------------------------------------------------------

function workloadMetadata(svc: CanonicalService, name: string, ctx: TranslateContext): ObjectMeta {
  const annotations: Record<string, string> = { ...svc.serviceLabels, [ANNOTATIONS.composeService]: svc.composeName };
  // Never on accessories and never on the pod template, so an unchanged service neither rolls nor
  // changes the accessories digest when only the release version moves (emission rule 9).
  if (svc.role === 'app') annotations[ANNOTATIONS.release] = ctx.stack.identity.version;
  return {
    name,
    namespace: ctx.namespace,
    labels: serviceObjectLabels(ctx.stack.identity, svc.role, svc.name),
    annotations,
  };
}

function selectorOf(svc: CanonicalService, ctx: TranslateContext): LabelSelector {
  return { matchLabels: selectorLabels(ctx.stack.identity, svc.name) };
}

/** Long-running kinds keep the default (Always); a Job never restarts a container in place (K35). */
function templateFor(podTemplate: PodTemplate, kind: WorkloadKind): PodTemplateSpec {
  const spec: PodSpec = { ...podTemplate.spec };
  if (kind === 'Job') spec.restartPolicy = 'Never';
  else delete spec.restartPolicy;
  return { metadata: podTemplate.metadata, spec };
}

// ---------------------------------------------------------------------------
// Per kind
// ---------------------------------------------------------------------------

export function deploymentStrategy(svc: CanonicalService, ctx: TranslateContext): DeploymentStrategy {
  const shared = rwoMounts(svc, ctx);
  const first = shared[0];
  if (first !== undefined) {
    checkSharedClaimReplicas(svc, shared, ctx);
    reportTranslator(ctx.sink, 'update.strategy-recreate', deployPath(svc, 'update_config'), {
      service: svc.composeName,
      volume: first.volume.key,
      accessMode: first.volume.accessMode,
    });
    return { type: 'Recreate' };
  }
  return { type: 'RollingUpdate', rollingUpdate: rollingAmounts(effectiveOrder(svc, ctx), svc.update.parallelism) };
}

/** Exactly one of maxSurge and maxUnavailable is non-zero, as the API server requires of a DaemonSet. */
export function daemonSetStrategy(svc: CanonicalService, ctx: TranslateContext): DaemonSetUpdateStrategy {
  const rolling = rollingAmounts(effectiveOrder(svc, ctx), svc.update.parallelism);
  if (rolling.maxUnavailable === '100%') {
    reportTranslator(ctx.sink, 'update.global-all-at-once', deployPath(svc, 'update_config', 'parallelism'), {
      service: svc.composeName,
    });
  }
  return { type: 'RollingUpdate', rollingUpdate: rolling };
}

function buildDeployment(svc: CanonicalService, podTemplate: PodTemplate, ctx: TranslateContext): Deployment {
  const minReady = checkedMinReadySeconds(svc, ctx);
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: workloadMetadata(svc, svc.name, ctx),
    spec: {
      replicas: svc.replicas,
      revisionHistoryLimit: ctx.options.revisionHistoryLimit,
      progressDeadlineSeconds: progressDeadlineFor(minReady),
      ...minReadyField(minReady),
      selector: selectorOf(svc, ctx),
      strategy: deploymentStrategy(svc, ctx),
      template: templateFor(podTemplate, 'Deployment'),
    },
  };
}

/** The templates index.ts passes must be exactly the per-replica volumes the pods mount (4.3). */
function assertClaimTemplates(svc: CanonicalService, claimTemplates: ClaimTemplates, ctx: TranslateContext): void {
  const mounted = new Set<string>();
  for (const mount of svc.mounts) {
    if (mount.type !== 'volume') continue;
    const volume = volumeOf(svc, mount, ctx);
    if (volume.perReplica) mounted.add(volume.name);
  }
  const given = new Set(claimTemplates.map((t) => t.metadata.name));
  const same = given.size === claimTemplates.length && given.size === mounted.size && [...given].every((n) => mounted.has(n));
  if (!same) {
    translatorBug(
      `StatefulSet ${svc.name} received claim templates [${[...given].join(', ')}] for its per-replica volumes [${[...mounted].join(', ')}]`,
    );
  }
}

function buildStatefulSet(
  svc: CanonicalService,
  podTemplate: PodTemplate,
  claimTemplates: ClaimTemplates,
  ctx: TranslateContext,
): StatefulSet {
  assertClaimTemplates(svc, claimTemplates, ctx);
  checkSharedClaimReplicas(svc, rwoMounts(svc, ctx), ctx);
  if (svc.update.order === 'start-first') {
    reportTranslator(
      ctx.sink,
      'update.statefulset-order',
      deployPath(svc, 'update_config', 'order'),
      { service: svc.composeName },
      { equalsDefault: svc.update.order === injectedDefaults(svc.update).order },
    );
  }
  const minReady = checkedMinReadySeconds(svc, ctx);
  const templates = [...claimTemplates].sort((a, b) => compareCodeUnits(a.metadata.name, b.metadata.name));
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: workloadMetadata(svc, svc.name, ctx),
    spec: {
      // Emitted although it is the default: owning the field restores Retain after a hand edit (D7).
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      // Immutable: a value derived from anything would make a later apply fail (K13).
      podManagementPolicy: 'Parallel',
      replicas: svc.replicas,
      revisionHistoryLimit: ctx.options.revisionHistoryLimit,
      ...minReadyField(minReady),
      selector: selectorOf(svc, ctx),
      // Immutable too, hence never dependent on whether the service has ports.
      serviceName: headlessServiceName(svc.name),
      template: templateFor(podTemplate, 'StatefulSet'),
      updateStrategy: { type: 'RollingUpdate' },
      ...(templates.length > 0 ? { volumeClaimTemplates: templates } : {}),
    },
  };
}

function buildDaemonSet(svc: CanonicalService, podTemplate: PodTemplate, ctx: TranslateContext): DaemonSet {
  if (svc.placement.spreadLabels.length > 0 || svc.placement.maxReplicasPerNode !== null) {
    reportTranslator(ctx.sink, 'placement.global-ignored', deployPath(svc, 'placement'), { service: svc.composeName });
  }
  const minReady = checkedMinReadySeconds(svc, ctx);
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: workloadMetadata(svc, svc.name, ctx),
    spec: {
      ...minReadyField(minReady),
      revisionHistoryLimit: ctx.options.revisionHistoryLimit,
      selector: selectorOf(svc, ctx),
      template: templateFor(podTemplate, 'DaemonSet'),
      updateStrategy: daemonSetStrategy(svc, ctx),
    },
  };
}

function buildJob(svc: CanonicalService, podTemplate: PodTemplate, ctx: TranslateContext): Job | null {
  if (svc.replicas === 0) {
    reportTranslator(ctx.sink, 'deploy.job-zero-replicas', deployPath(svc, 'replicas'), { service: svc.composeName });
    return null;
  }
  checkSharedClaimReplicas(svc, rwoMounts(svc, ctx), ctx);
  // No selector, manualSelector or ttlSecondsAfterFinished: the controller owns the first two and
  // the finished Job is the proof that it ran (design-03 5.4.4).
  const spec: JobSpec = {
    backoffLimit: jobBackoffLimit(svc.restart),
    completions: svc.replicas,
    parallelism: svc.replicas,
    template: templateFor(podTemplate, 'Job'),
  };
  // `completions` and the template are immutable, so the name covers the whole spec (PD-9, design-02 I3).
  const name = jobNameFor(svc.name, sha256Hex(canonicalJson(spec)));
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: workloadMetadata(svc, name, ctx), spec };
}

/**
 * The workload of `svc` around `podTemplate`, of the kind the normalizer chose (`workloadKind`,
 * never re-derived). `claimTemplates` are the StatefulSet's per-replica claims built by storage.ts
 * ([] for every other kind). Returns null for a Job with 0 replicas, which is not created
 * (`deploy.job-zero-replicas`). Diagnostics go to `ctx.sink`; a precondition the normalizer
 * guarantees throws (T6).
 */
export function buildWorkload(
  svc: CanonicalService,
  podTemplate: PodTemplate,
  claimTemplates: ClaimTemplates,
  ctx: TranslateContext,
): Workload | null {
  if (claimTemplates.length > 0 && svc.workloadKind !== 'StatefulSet') {
    translatorBug(`${svc.workloadKind} ${svc.name} received volume claim templates, which only a StatefulSet has`);
  }
  checkRestartPolicy(svc, ctx);
  switch (svc.workloadKind) {
    case 'Deployment':
      return buildDeployment(svc, podTemplate, ctx);
    case 'StatefulSet':
      return buildStatefulSet(svc, podTemplate, claimTemplates, ctx);
    case 'DaemonSet':
      return buildDaemonSet(svc, podTemplate, ctx);
    case 'Job':
      return buildJob(svc, podTemplate, ctx);
  }
}
