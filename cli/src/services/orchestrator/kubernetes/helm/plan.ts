// Pure planning of Helm operations (design-04 3.7) and of the cluster-wide Traefik (2.8, 2.10).
// Backends observe, these functions decide, backends execute: nothing here reads the cluster, and
// time is always a parameter.

import { ErrorCode } from '../../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import type { HelmManifestObject, HelmPlanEntry, HelmReleaseRecord, HelmReleaseStatus, HelmStatus, ResolvedHelmRelease } from '../../interfaces';
import { K8S_PROXY_RELEASE, K8S_SYSTEM_NAMESPACE, LABELS, TRAEFIK_TIMEOUT_S } from '../constants';
import type { Event, Pod } from '../resources/core';
import { TRAEFIK_CHART_PIN, type TraefikChartPin } from '../versions';
import {
  compareChartVersions,
  desiredChartName,
  isPendingStatus,
  parseHelmStatus,
  sameChartVersion,
  splitChartString,
  statefulSetClaimPattern,
} from './parse';
import {
  intentCapabilities,
  type ProxyCapabilities,
  type ProxyRefusal,
  type ProxyWarning,
  proxyHostPorts,
  TRAEFIK_VALUES_REVISION,
  type TraefikIntent,
  type TraefikPodFact,
} from './traefik-values';

/** A warning of the Helm catalogue (design-04 3.7, 3.10), emitted through HelmEventSink.warn. */
export interface HelmWarning {
  /** catalogue id, e.g. W-HELM-DV3 */
  code: string;
  message: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Pending releases
// ---------------------------------------------------------------------------

/**
 * Age after which a pending-* release cannot belong to a live Dockflow operation: twice the guard
 * of a mutating helm call, `2 * (4 * T + 120)` (design-04 3.5.1, 2 640 s for T = 300). The same
 * budget as runtime/helm.ts `helmPendingStaleS`, restated because pure modules never import runtime/.
 */
export function pendingStaleAfterS(timeoutS: number): number {
  return 2 * (4 * timeoutS + 120);
}

/** Strictly older than the threshold; an unknown or unparseable time is never stale. */
function isStale(since: string | null, now: Date, afterS: number): boolean {
  if (since === null) return false;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > afterS * 1000;
}

const timeText = (since: string | null): string => since ?? 'an unknown time';

// ---------------------------------------------------------------------------
// One release (3.7.1)
// ---------------------------------------------------------------------------

export interface ObservedRelease {
  name: string;
  namespace: string;
  revision: number;
  status: HelmStatus;
  /** `<chart name>-<chart version>` as `helm list` prints it */
  chart: string;
  owner: { kind: 'me' } | { kind: 'none' } | { kind: 'foreign'; stackId: string };
  /** the deployed revision carries the desired P/spec-hash */
  deployedSpecMatches: boolean;
  /** from history; needed for failed and pending-* releases */
  lastDeployedRevision: number | null;
  /** from history for pending-* releases */
  pendingSince: string | null;
}

export type NamespaceOwner = 'free' | 'mine' | { stackName: string };

export interface ReleasePlanContext {
  now: Date;
  namespaceOwner: NamespaceOwner;
  /** this release name was passed to deploy --adopt (3.7.4) */
  adoptAllowed: boolean;
  /** environment name, used in the refusal messages */
  env: string;
}

function inProgressRefusal(name: string, observed: ObservedRelease, env: string): { message: string; suggestion: string } {
  const revision = observed.lastDeployedRevision === null ? '<revision>' : String(observed.lastDeployedRevision);
  return {
    message: `Helm release ${name} has an operation in progress since ${timeText(observed.pendingSince)} (${observed.status})`,
    suggestion: `Wait for it to finish (\`dockflow helm status ${env} ${name}\`), then deploy again; if nothing is running, return to the last good revision with \`dockflow helm rollback ${env} ${name} ${revision}\`.`,
  };
}

/**
 * Decision table of design-04 3.7.1, first match wins. One refinement: the stale-pending recovery
 * of row 4 runs only on a release Dockflow owns, because a release it did not install is never
 * touched without --adopt; another owner's stale pending release is blocked by row 6 instead.
 */
export function planRelease(desired: ResolvedHelmRelease, observed: ObservedRelease | null, context: ReleasePlanContext): HelmPlanEntry {
  const name = desired.name;
  const namespace = desired.namespace;
  const env = context.env;
  const plan = (action: HelmPlanEntry['action'], reason: string): HelmPlanEntry => ({ release: name, namespace, action, reason });
  const blocked = (message: string, suggestion: string): HelmPlanEntry => ({ release: name, namespace, action: 'blocked', reason: message, suggestion });

  if (typeof context.namespaceOwner === 'object') {
    return blocked(
      `Helm release ${name} targets namespace ${namespace}, which belongs to stack ${context.namespaceOwner.stackName}`,
      'Omit `namespace`, or use a namespace no Dockflow stack owns.',
    );
  }
  if (observed === null || observed.status === 'uninstalled') return plan('installed', 'not installed');
  if (observed.owner.kind === 'foreign') {
    return blocked(
      `Helm release ${name} in namespace ${namespace} belongs to stack ${observed.owner.stackId}`,
      'Rename the release in config.yml, or remove it from the other project first.',
    );
  }
  if (isPendingStatus(observed.status)) {
    const stale = isStale(observed.pendingSince, context.now, pendingStaleAfterS(desired.timeoutS));
    if (stale && observed.lastDeployedRevision !== null && observed.owner.kind === 'me') {
      return { ...plan('upgraded', 'recover'), rollbackTo: observed.lastDeployedRevision };
    }
    if (stale && observed.lastDeployedRevision === null) {
      return blocked(
        `Helm release ${name} is stuck in ${observed.status} since ${timeText(observed.pendingSince)} with no deployed revision to return to`,
        `Remove it with \`dockflow helm uninstall ${env} ${name}\`, then deploy again.`,
      );
    }
    const refusal = inProgressRefusal(name, observed, env);
    return blocked(refusal.message, refusal.suggestion);
  }
  if (observed.status === 'uninstalling') {
    return blocked(`Helm release ${name} is being uninstalled`, 'Wait for the uninstall to finish, then deploy again.');
  }
  if (observed.owner.kind === 'none') {
    const deployed = splitChartString(observed.chart);
    if (context.adoptAllowed && deployed.name === desiredChartName(desired.chart)) {
      if (sameChartVersion(deployed.version, desired.version)) return plan('upgraded', 'adopt');
      return blocked(
        `Helm release ${name} in ${namespace} runs chart ${observed.chart} and config.yml declares ${desired.version}`,
        `Declare the version that is running and adopt that first, or uninstall the release with \`dockflow helm uninstall ${env} ${name}\` before deploying.`,
      );
    }
    return blocked(
      `Helm release ${name} in namespace ${namespace} exists and was not installed by Dockflow (chart ${observed.chart})`,
      `Review its values with \`dockflow helm values ${env} ${name}\`, then take it over with \`dockflow deploy ${env} --adopt ${name}\`, or rename the release in config.yml.`,
    );
  }
  if (observed.status === 'failed') return plan('upgraded', 'failed');
  if (observed.status === 'deployed' && observed.deployedSpecMatches) return plan('skipped', 'unchanged');
  return plan('upgraded', 'changed');
}

/** HelmUpgradeResult.previousRevision: the observed revision when deployed, else the last deployed one. */
export function previousRevisionOf(observed: ObservedRelease | null): number | null {
  if (observed === null || observed.status === 'uninstalled') return null;
  return observed.status === 'deployed' ? observed.revision : observed.lastDeployedRevision;
}

/** The warning a `recover` plan emits before its rollback (3.7.1 row 4). */
export function recoveryWarning(observed: ObservedRelease, revision: number): HelmWarning {
  return {
    code: 'W-HELM-RECOVER',
    message: `Helm release ${observed.name} was left in ${observed.status} since ${timeText(observed.pendingSince)}; rolling back to revision ${revision} before upgrading`,
  };
}

// ---------------------------------------------------------------------------
// Removals (3.7.2, 3.10)
// ---------------------------------------------------------------------------

export type RemovalMode = 'finalize' | 'stop' | 'accessories-remove' | 'accessories-remove-volumes';

export interface RemovalEntry {
  name: string;
  namespace: string;
  role: 'app' | 'accessory';
  action: 'uninstall' | 'keep-owns-volumes' | 'uninstall-delete-volumes';
  /** manifest PVCs without keep: deleted by helm uninstall */
  deletablePvcs: string[];
  /** manifest PVCs with keep + live StatefulSet template PVCs: survive helm uninstall */
  survivingPvcs: string[];
  /** W-HELM-DV3, W-HELM-STOP-KEPT or W-HELM-ACC-KEPT on `keep-owns-volumes` */
  warning?: HelmWarning;
}

export interface RemovalInput {
  mode: RemovalMode;
  /** releases labelled with this stack, both roles */
  owned: readonly HelmReleaseStatus[];
  /** release names declared in config.yml (both roles) or in the applied record set */
  declared: ReadonlySet<string>;
  /** config order of declared names, for ordering */
  order: readonly string[];
  /** release name -> objects of its deployed manifest */
  manifests: ReadonlyMap<string, readonly HelmManifestObject[]>;
  /** namespace -> live PVC names */
  livePvcs: ReadonlyMap<string, readonly string[]>;
  /** environment name, for the warning suggestions */
  env: string;
}

/**
 * Which releases an uninstall flow removes. Only manifest PVCs without `helm.sh/resource-policy:
 * keep` block an implicit uninstall: Helm keeps annotated objects and never owned claim-template
 * PVCs (DV3 as refined by design-04 I10).
 */
export function planRemovals(input: RemovalInput): RemovalEntry[] {
  const role = input.mode === 'finalize' || input.mode === 'stop' ? 'app' : 'accessory';
  const entries: RemovalEntry[] = [];
  const seen = new Set<string>();
  for (const release of input.owned) {
    if (release.role !== role || release.status === 'uninstalled') continue;
    if (input.mode === 'finalize' && input.declared.has(release.name)) continue;
    const key = `${release.namespace}/${release.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const objects = input.manifests.get(release.name) ?? [];
    const claims = objects.filter((object) => object.kind === 'PersistentVolumeClaim');
    const deletablePvcs = uniqueSorted(claims.filter((claim) => !claim.keep).map((claim) => claim.name));
    const survivingPvcs = uniqueSorted([
      ...claims.filter((claim) => claim.keep).map((claim) => claim.name),
      ...templateClaims(objects, release.namespace, input.livePvcs),
    ]);
    const action: RemovalEntry['action'] =
      input.mode === 'accessories-remove-volumes' ? 'uninstall-delete-volumes' : deletablePvcs.length === 0 ? 'uninstall' : 'keep-owns-volumes';
    const entry: RemovalEntry = { name: release.name, namespace: release.namespace, role, action, deletablePvcs, survivingPvcs };
    if (action === 'keep-owns-volumes') entry.warning = keptWarning(input.mode, release.name, deletablePvcs, input.env);
    entries.push(entry);
  }
  return entries.sort(removalOrder(input.order));
}

function uniqueSorted(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

function templateClaims(objects: readonly HelmManifestObject[], releaseNamespace: string, livePvcs: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  for (const object of objects) {
    if (object.kind !== 'StatefulSet' || object.claimTemplates.length === 0) continue;
    const live = livePvcs.get(object.namespace ?? releaseNamespace) ?? [];
    for (const claim of object.claimTemplates) {
      const pattern = statefulSetClaimPattern(claim, object.name);
      out.push(...live.filter((pvc) => pattern.test(pvc)));
    }
  }
  return out;
}

/** Reverse config order for declared names, then the others in descending code-unit order. */
function removalOrder(order: readonly string[]): (a: RemovalEntry, b: RemovalEntry) => number {
  const index = new Map(order.map((name, i) => [name, i]));
  return (a, b) => {
    const ia = index.get(a.name);
    const ib = index.get(b.name);
    if (ia !== undefined && ib !== undefined) return ib - ia;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    if (a.name !== b.name) return a.name < b.name ? 1 : -1;
    return a.namespace < b.namespace ? 1 : a.namespace > b.namespace ? -1 : 0;
  };
}

function keptWarning(mode: RemovalMode, name: string, pvcs: readonly string[], env: string): HelmWarning {
  const list = pvcs.join(', ');
  switch (mode) {
    case 'finalize':
      return {
        code: 'W-HELM-DV3',
        message: `Helm release ${name} is no longer in config.yml but owns volumes (${list}); it keeps running`,
        suggestion: `Remove it with \`dockflow helm uninstall ${env} ${name} --volumes\` (deletes the data) or \`--keep-volumes\`.`,
      };
    case 'stop':
      return {
        code: 'W-HELM-STOP-KEPT',
        message: `Helm release ${name} owns volumes (${list}) and was not uninstalled`,
        suggestion: `Remove it with \`dockflow helm uninstall ${env} ${name} --volumes\` or \`--keep-volumes\`.`,
      };
    default:
      return {
        code: 'W-HELM-ACC-KEPT',
        message: `Accessory Helm release ${name} owns volumes (${list}) and was kept`,
        suggestion: `Re-run with \`--volumes\` to delete them, or run \`dockflow helm uninstall ${env} ${name} --keep-volumes\`.`,
      };
  }
}

/** W-HELM-ACC-ORPHAN: accessory releases are never uninstalled implicitly, only reported (3.10). */
export function accessoryOrphanWarnings(input: { owned: readonly HelmReleaseStatus[]; declared: ReadonlySet<string>; env: string }): HelmWarning[] {
  const names = uniqueSorted(
    input.owned.filter((release) => release.role === 'accessory' && release.status !== 'uninstalled' && !input.declared.has(release.name)).map((release) => release.name),
  );
  return names.map((name) => ({
    code: 'W-HELM-ACC-ORPHAN',
    message: `Helm release ${name} (accessory) is no longer in config.yml and keeps running`,
    suggestion: `Remove it with \`dockflow helm uninstall ${input.env} ${name}\`.`,
  }));
}

// ---------------------------------------------------------------------------
// Applying a recorded release set (3.7.3)
// ---------------------------------------------------------------------------

export type RecordApplyEntry =
  | { name: string; action: 'unchanged' }
  | { name: string; action: 'native-rollback'; revision: number }
  | { name: string; action: 'upgrade-from-record'; warning?: HelmWarning }
  | { name: string; action: 'install-from-record'; warning?: HelmWarning }
  | { name: string; action: 'blocked'; message: string; suggestion: string };

export interface RecordApplyInput {
  records: readonly HelmReleaseRecord[];
  observed: ReadonlyMap<string, ObservedRelease | null>;
  /** revisionsWithSpec(ns, name, specHash) results, newest first */
  specRevisions: ReadonlyMap<string, readonly number[]>;
  now: Date;
  /** environment name, used in the refusal messages */
  env: string;
}

/**
 * A native rollback (chart, values and labels from Helm storage: no network, no credentials) is
 * preferred whenever Helm still holds a revision with the recorded spec; the two paths that pull
 * the chart again are the ones that verify the recorded digest.
 */
export function planRecordApply(input: RecordApplyInput): RecordApplyEntry[] {
  return input.records.map((record): RecordApplyEntry => {
    const name = record.name;
    const observed = input.observed.get(name) ?? null;
    if (observed === null || observed.status === 'uninstalled') return withDigestWarning({ name, action: 'install-from-record' }, record);

    // an adoption is never part of a rollback, and a pending release is never recovered by one
    const release: ResolvedHelmRelease = { ...record, auth: null, declaredDigest: record.chartSha256 };
    const entry = planRelease(release, observed, { now: input.now, namespaceOwner: 'mine', adoptAllowed: false, env: input.env });
    if (entry.action === 'blocked') return { name, action: 'blocked', message: entry.reason, suggestion: entry.suggestion ?? '' };
    if (entry.reason === 'recover') {
      const refusal = inProgressRefusal(name, observed, input.env);
      return { name, action: 'blocked', ...refusal };
    }
    if (observed.status === 'deployed' && observed.deployedSpecMatches) return { name, action: 'unchanged' };
    const revisions = input.specRevisions.get(name) ?? [];
    if (revisions.length > 0) return { name, action: 'native-rollback', revision: Math.max(...revisions) };
    return withDigestWarning({ name, action: 'upgrade-from-record' }, record);
  });
}

function withDigestWarning<T extends { name: string; action: 'upgrade-from-record' | 'install-from-record'; warning?: HelmWarning }>(
  entry: T,
  record: HelmReleaseRecord,
): T {
  if (record.chartSha256 !== null) return entry;
  return {
    ...entry,
    warning: {
      code: 'W-HELM-CHART-UNVERIFIED',
      message: `Helm release ${record.name} was recorded without a chart digest, so its content cannot be verified`,
      suggestion: 'Deploy again to record it.',
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy: recorded state (2.8.1)
// ---------------------------------------------------------------------------

/** `schema` of the dockflow-proxy ConfigMap this CLI writes; a higher one means a newer CLI. */
export const PROXY_STATE_SCHEMA = 2;

/** Keys of `intent-fields`, in the order refusals name them. */
export const INTENT_FIELDS = ['acme', 'email', 'ca_server', 'ca_bundle', 'dashboard', 'default_ingress_class'] as const;
export type IntentField = (typeof INTENT_FIELDS)[number];

/** config.yml key under `proxy` of each intent field, as messages name it */
const FIELD_KEYS: Readonly<Record<IntentField, string>> = {
  acme: 'acme',
  email: 'email',
  ca_server: 'acme_ca_server',
  ca_bundle: 'acme_ca_bundle',
  dashboard: 'dashboard',
  default_ingress_class: 'default_ingress_class',
};

export function intentSha256(intent: TraefikIntent): string {
  return sha256Hex(canonicalJson(intent));
}

/** Per-field hashes: they name the settings that differ without publishing an e-mail or a CA. */
export function intentFieldHashes(intent: TraefikIntent): Record<IntentField, string> {
  const values: Record<IntentField, unknown> = {
    acme: intent.acme,
    email: intent.email,
    ca_server: intent.caServer,
    ca_bundle: intent.caBundle,
    dashboard: intent.dashboard,
    default_ingress_class: intent.defaultIngressClass,
  };
  const out = {} as Record<IntentField, string>;
  for (const field of INTENT_FIELDS) out[field] = sha256Hex(canonicalJson(values[field]));
  return out;
}

export interface ProxyState {
  schema: number | null;
  /** stackId of the managing stack */
  owner: string | null;
  ownerStackName: string | null;
  chartVersion: string | null;
  /** informational: the release label is authoritative */
  valuesRevision: number | null;
  valuesSha256: string | null;
  intentSha256: string | null;
  intentFields: Partial<Record<IntentField, string>> | null;
  capabilities: ProxyCapabilities | null;
  nodeHostname: string | null;
  /** servers.yml key of the pinned node */
  node: string | null;
  dockflowVersion: string | null;
  updatedAt: string | null;
}

export interface ProxyStateInput {
  /** the recorded owner: this stack when it takes ownership, else the owner that stays */
  owner: { stackId: string; stackName: string };
  intent: TraefikIntent;
  desired: Record<string, unknown>;
  /** pinned node: kubernetes.io/hostname and servers.yml key */
  placement: { hostname: string; node: string };
  dockflowVersion: string;
  now: Date;
  pin?: TraefikChartPin;
}

/** `data` of ConfigMap dockflow-proxy: hashes only, never the e-mail (a ConfigMap is widely readable). */
export function proxyStateData(input: ProxyStateInput): Record<string, string> {
  const pin = input.pin ?? TRAEFIK_CHART_PIN;
  return {
    schema: String(PROXY_STATE_SCHEMA),
    owner: input.owner.stackId,
    'owner-stack-name': input.owner.stackName,
    'chart-version': pin.version,
    'values-revision': String(TRAEFIK_VALUES_REVISION),
    'values-sha256': sha256Hex(canonicalJson(input.desired)),
    'intent-sha256': intentSha256(input.intent),
    'intent-fields': canonicalJson(intentFieldHashes(input.intent)),
    capabilities: canonicalJson(intentCapabilities(input.intent)),
    'node-hostname': input.placement.hostname,
    node: input.placement.node,
    'dockflow-version': input.dockflowVersion,
    'updated-at': input.now.toISOString(),
  };
}

function text(data: Record<string, string>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function integer(data: Record<string, string>, key: string): number | null {
  const value = text(data, key);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

function jsonObject(data: Record<string, string>, key: string): Record<string, unknown> | null {
  const value = text(data, key);
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** O3: the ConfigMap's data, read leniently; null when the ConfigMap does not exist. */
export function parseProxyState(data: Record<string, string> | null | undefined): ProxyState | null {
  if (data === null || data === undefined) return null;
  const fields = jsonObject(data, 'intent-fields');
  const intentFields: Partial<Record<IntentField, string>> | null = fields === null ? null : {};
  if (fields !== null && intentFields !== null) {
    for (const field of INTENT_FIELDS) if (typeof fields[field] === 'string') intentFields[field] = fields[field] as string;
  }
  const caps = jsonObject(data, 'capabilities');
  const capabilities =
    caps !== null && ['acme', 'redirectToHttps', 'dashboard', 'defaultIngressClass'].every((key) => typeof caps[key] === 'boolean')
      ? (caps as unknown as ProxyCapabilities)
      : null;
  return {
    schema: integer(data, 'schema'),
    owner: text(data, 'owner'),
    ownerStackName: text(data, 'owner-stack-name'),
    chartVersion: text(data, 'chart-version'),
    valuesRevision: integer(data, 'values-revision'),
    valuesSha256: text(data, 'values-sha256'),
    intentSha256: text(data, 'intent-sha256'),
    intentFields,
    capabilities,
    nodeHostname: text(data, 'node-hostname'),
    node: text(data, 'node'),
    dockflowVersion: text(data, 'dockflow-version'),
    updatedAt: text(data, 'updated-at'),
  };
}

// ---------------------------------------------------------------------------
// Proxy: observation (2.8.2)
// ---------------------------------------------------------------------------

export interface ProxyReleaseFact {
  revision: number;
  status: HelmStatus;
  /** null when the chart string carries no version */
  chartVersion: string | null;
  appVersion: string | null;
  updated: string | null;
}

/** O1: the dockflow-traefik row of `helm list --filter ^dockflow-traefik$ -o json`. */
export function proxyReleaseFrom(rows: readonly HelmReleaseStatus[]): ProxyReleaseFact | null {
  const row = rows.find((item) => item.name === K8S_PROXY_RELEASE);
  if (row === undefined) return null;
  return {
    revision: row.revision,
    status: parseHelmStatus(row.status),
    chartVersion: splitChartString(row.chart).version,
    appVersion: row.appVersion,
    updated: row.updated,
  };
}

export interface ProxyObservation {
  /** O1; null when no release exists */
  release: ProxyReleaseFact | null;
  /** O2: user values of the release (`null` output -> {}); null when O1 found nothing */
  deployedValues: Record<string, unknown> | null;
  /** O3 */
  state: ProxyState | null;
  /** O4: ingressroutes.traefik.io and middlewares.traefik.io are both served */
  crdsPresent: boolean;
  /** O5: Deployment dockflow-traefik; null when it does not exist */
  deployment: { replicas: number; readyReplicas: number } | null;
  /** O5: the Traefik pods */
  pods: readonly TraefikPodFact[];
  /** O6: false when the owner's namespace is gone or terminating; null when not read */
  ownerNamespaceExists: boolean | null;
  /** O7 */
  pendingSince: string | null;
  lastDeployedRevision: number | null;
  /** O8: the deployed revision carries a values revision above this CLI's */
  deployedValuesNewer: boolean;
  /** O8: the deployed revision carries no values-revision label (fall back to the ConfigMap) */
  revisionLabelMissing: boolean;
}

/** O8: a deployed proxy revision whose values revision this CLI does not know (`-o name` only, F29). */
export function newerValuesRevisionSelector(revision: number = TRAEFIK_VALUES_REVISION): string {
  const known = Array.from({ length: revision }, (_, i) => i + 1).join(',');
  return `owner=helm,name=${K8S_PROXY_RELEASE},status=deployed,${LABELS.valuesRevision},${LABELS.valuesRevision} notin (${known})`;
}

/** O8: a deployed proxy revision written before the values-revision label existed. */
export function missingValuesRevisionSelector(): string {
  return `owner=helm,name=${K8S_PROXY_RELEASE},status=deployed,!${LABELS.valuesRevision}`;
}

// ---------------------------------------------------------------------------
// Proxy: planProxy (2.8.3)
// ---------------------------------------------------------------------------

/** Mapped onto core ProxyPlan / ProxyEnsureResult by the proxy backend (2.9). */
export type InternalProxyPlan =
  | {
      kind: 'unchanged' | 'consume' | 'crds-only' | 'install' | 'upgrade' | 'keep-newer';
      reasons: string[];
      warnings: ProxyWarning[];
      applyCrds: boolean;
      /** a stale pending release is rolled back to this revision before the upgrade (M1) */
      recoverTo: number | null;
      /**
       * The recorded owner becomes this stack: no state yet, or its owner's namespace is gone.
       * On `unchanged` the state is written without a Helm call; a live other owner stays recorded.
       */
      adoptState: boolean;
    }
  | { kind: 'refuse'; refusal: ProxyRefusal; warnings: ProxyWarning[] };

export interface PlanProxyInput {
  manage: boolean;
  intent: TraefikIntent;
  /** managing stacks: buildTraefikValues with the resolved placement; null for consuming stacks */
  desired: Record<string, unknown> | null;
  /** managing stacks: the `ok` result of resolvePlacement, whose warnings are prepended; null for consuming stacks */
  placement: { hostname: string; warnings?: readonly ProxyWarning[] } | null;
  me: { stackId: string; stackName: string };
  /** environment name, for the commands the messages name */
  env: string;
  /** traits.name, for the setup command of W-PX-FIREWALL */
  distribution: string;
  observation: ProxyObservation;
  now: Date;
  pin?: TraefikChartPin;
}

type ProxyPlanKind = Exclude<InternalProxyPlan['kind'], 'refuse'>;

function proxyPlan(kind: ProxyPlanKind, fields: Partial<Omit<Extract<InternalProxyPlan, { kind: ProxyPlanKind }>, 'kind'>> = {}): InternalProxyPlan {
  return { kind, reasons: [], warnings: [], applyCrds: false, recoverTo: null, adoptState: false, ...fields };
}

function refuse(refusal: ProxyRefusal, warnings: ProxyWarning[] = []): InternalProxyPlan {
  return { kind: 'refuse', refusal, warnings };
}

/**
 * The proxy plan of a managing (rows M1-M9) or consuming (rows C1-C4) stack, first match wins.
 * Refusals are returned, never thrown, so `deploy --dry-run` can print them as blockers.
 */
export function planProxy(input: PlanProxyInput): InternalProxyPlan {
  const plan = input.manage ? planManaging(input) : planConsuming(input);
  const prefix = input.manage ? (input.placement?.warnings ?? []) : [];
  return prefix.length === 0 ? plan : { ...plan, warnings: [...prefix, ...plan.warnings] };
}

function ownerName(state: ProxyState | null): string | null {
  return state?.ownerStackName ?? state?.owner ?? null;
}

function releaseOf(observation: ProxyObservation): ProxyReleaseFact | null {
  return observation.release !== null && observation.release.status !== 'uninstalled' ? observation.release : null;
}

function valuesAt(values: Record<string, unknown> | null, path: readonly string[]): unknown {
  let node: unknown = values;
  for (const key of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Capabilities read back from deployed values, when no ConfigMap records them (C3). */
export function capabilitiesFromValues(values: Record<string, unknown> | null): ProxyCapabilities | null {
  if (values === null) return null;
  const acme = valuesAt(values, ['certificatesResolvers', 'letsencrypt']) !== undefined && valuesAt(values, ['ports', 'websecure', 'hostPort']) === 443;
  return {
    acme,
    redirectToHttps: valuesAt(values, ['ports', 'web', 'http', 'redirections', 'entryPoint', 'to']) === 'websecure',
    dashboard: valuesAt(values, ['api', 'dashboard']) === true,
    defaultIngressClass: valuesAt(values, ['ingressClass', 'isDefaultClass']) === true,
  };
}

function notReadyWarning(observation: ProxyObservation, env: string): ProxyWarning[] {
  if (observation.deployment === null || observation.deployment.readyReplicas >= 1) return [];
  const status = observation.pods[0]?.status ?? 'no pod';
  return [
    {
      code: 'W-PX-NOT-READY',
      message: `Traefik in ${K8S_SYSTEM_NAMESPACE} is not ready (${status}), so routes do not serve traffic until it recovers`,
      suggestion: `Run \`dockflow diagnose ${env}\`.`,
    },
  ];
}

function planConsuming(input: PlanProxyInput): InternalProxyPlan {
  const { observation, me } = input;
  const release = releaseOf(observation);
  const foreignProxy: ProxyWarning = {
    code: 'W-PX-FOREIGN-PROXY',
    message: `No Dockflow-managed Traefik is installed, so the routes of ${me.stackName} are applied for the Traefik that owns the traefik.io CRDs, whose entry points Dockflow cannot check`,
    suggestion: 'Check that its entry points are named `web` and `websecure`, or set `proxy.manage: true` to let Dockflow install its own Traefik.',
  };

  if (release === null && observation.deployment === null) {
    // C1 / C2
    if (!observation.crdsPresent) {
      return refuse({
        code: 'E-PX-ABSENT',
        errorCode: ErrorCode.VALIDATION_FAILED,
        message: 'No Dockflow Traefik is installed on this cluster and `proxy.manage` is false, so this stack has nothing to route through',
        suggestion: 'Deploy the stack that manages the proxy first, or set `proxy.manage: true` here to install it.',
      });
    }
    return proxyPlan('consume', { warnings: [foreignProxy] });
  }

  const capabilities = observation.state?.capabilities ?? capabilitiesFromValues(observation.deployedValues);
  if (capabilities === null) return proxyPlan('consume', { warnings: [foreignProxy] });

  const owner = ownerName(observation.state);
  // C3: the only refusal of a healthy cluster; the opposite direction is served (redirect at priority 1)
  if (input.intent.acme && !capabilities.acme) {
    return refuse({
      code: 'E-PX-INCOMPATIBLE',
      errorCode: ErrorCode.VALIDATION_FAILED,
      message: `Traefik in ${K8S_SYSTEM_NAMESPACE} was installed without ACME by ${owner === null ? 'another stack' : `stack ${owner}`}, so the websecure entry point is not published and the letsencrypt resolver does not exist`,
      suggestion: `Let the stack with \`proxy.acme: true\` manage the proxy (\`proxy.manage: true\` here, \`proxy.manage: false\` in ${owner ?? 'the stack that manages it'}), or set \`proxy.acme: false\` here to route over HTTP.`,
    });
  }

  // C4
  const warnings: ProxyWarning[] = [];
  const ignored = ignoredSettings(input.intent, observation.state);
  if (ignored.length > 0) {
    warnings.push({
      code: 'W-PX-SETTINGS-IGNORED',
      message: `${ignored.map((field) => `proxy.${FIELD_KEYS[field]}`).join(', ')} of ${me.stackName} differ from the Traefik that ${owner ?? 'another stack'} manages and are ignored, because ${me.stackName} sets proxy.manage: false`,
      suggestion: `Change these settings in ${owner ?? 'the stack that manages the proxy'}, or remove them from this stack.`,
    });
  }
  warnings.push(...notReadyWarning(observation, input.env));
  if (!observation.crdsPresent) {
    warnings.push({
      code: 'W-PX-CRDS-MISSING',
      message: `The cluster has no traefik.io CRDs, so the routes of ${me.stackName} cannot be applied`,
      suggestion: 'Deploy the stack that manages the proxy first, or set `proxy.manage: true` here.',
    });
  }
  return proxyPlan('consume', { warnings });
}

/**
 * Settings a consuming stack sets away from their defaults whose recorded hash differs. `acme` is
 * C3's business and a consuming stack's e-mail is always null.
 */
function ignoredSettings(intent: TraefikIntent, state: ProxyState | null): IntentField[] {
  const recorded = state?.intentFields;
  if (!recorded) return [];
  const mine = intentFieldHashes(intent);
  const sets: [IntentField, boolean][] = [
    ['dashboard', intent.dashboard.enabled],
    ['default_ingress_class', intent.defaultIngressClass],
    ['ca_server', intent.caServer !== null],
    ['ca_bundle', intent.caBundle !== null],
  ];
  return sets.filter(([field, set]) => set && recorded[field] !== mine[field]).map(([field]) => field);
}

function differingFields(intent: TraefikIntent, state: ProxyState): IntentField[] {
  const recorded = state.intentFields;
  if (!recorded) return [];
  const mine = intentFieldHashes(intent);
  return INTENT_FIELDS.filter((field) => recorded[field] !== mine[field]);
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function conflictRefusal(input: PlanProxyInput, state: ProxyState): ProxyRefusal {
  const fields = differingFields(input.intent, state);
  const owner = ownerName(state) ?? 'another stack';
  const keys = fields.map((field) => FIELD_KEYS[field]);
  const same = keys.length === 0 ? '`proxy` settings' : joinWithAnd(keys.map((key) => `\`proxy.${key}\``));
  // when acme differs, only the stack without ACME can follow (C3 refuses the other way round)
  const follower = input.intent.acme ? owner : input.me.stackName;
  const follow = fields.includes('acme')
    ? `set \`proxy.manage: false\` in ${follower}, the stack with \`proxy.acme: false\`,`
    : 'set `proxy.manage: false` in the stack that should follow';
  return {
    code: 'E-PX-CONFLICT',
    errorCode: ErrorCode.VALIDATION_FAILED,
    message: `Traefik in ${K8S_SYSTEM_NAMESPACE} is managed by stack ${owner} with different proxy settings${keys.length === 0 ? '' : ` (${keys.join(', ')})`}; one Traefik serves every stack on the cluster`,
    suggestion: `Use the same ${same} in both stacks, or ${follow} so it uses the other stack's Traefik without changing it.`,
  };
}

/** Values revision of the deployed release when known: the label when present, else the ConfigMap, else 1. */
function deployedValuesRevision(observation: ProxyObservation): number | null {
  if (observation.revisionLabelMissing) return observation.state?.valuesRevision ?? 1;
  return observation.state?.valuesRevision ?? null;
}

function newerThanPin(input: PlanProxyInput, release: ProxyReleaseFact | null, pin: TraefikChartPin): { deployed: string; mine: string } | null {
  const { observation } = input;
  const chart = release?.chartVersion ?? null;
  const order = chart === null ? null : compareChartVersions(chart, pin.version);
  if (chart !== null && order !== null && order > 0) return { deployed: chart, mine: pin.version };
  if (chart !== null && order === 0) {
    // the release label is authoritative; the ConfigMap only speaks for releases written without it
    const recorded = observation.state?.valuesRevision ?? null;
    const recordedNewer = recorded !== null && recorded > TRAEFIK_VALUES_REVISION;
    if (observation.deployedValuesNewer || (observation.revisionLabelMissing && recordedNewer)) {
      const revision = recordedNewer ? `values revision ${recorded}` : 'a newer values revision';
      return { deployed: `${chart} with ${revision}`, mine: `${pin.version} with values revision ${TRAEFIK_VALUES_REVISION}` };
    }
  }
  const schema = observation.state?.schema ?? null;
  if (schema !== null && schema > PROXY_STATE_SCHEMA) {
    return { deployed: `${chart ?? observation.state?.chartVersion ?? 'unknown'} with state schema ${schema}`, mine: `${pin.version} with state schema ${PROXY_STATE_SCHEMA}` };
  }
  return null;
}

function planManaging(input: PlanProxyInput): InternalProxyPlan {
  const { observation, me, intent, env } = input;
  if (input.desired === null || input.placement === null) throw new Error('planProxy needs the desired values and placement of a managing stack');
  const desired = input.desired;
  const hostname = input.placement.hostname;
  const pin = input.pin ?? TRAEFIK_CHART_PIN;
  const release = releaseOf(observation);
  const state = observation.state;
  const chartMatches = release !== null && release.chartVersion === pin.version;
  const applyCrds = !chartMatches || !observation.crdsPresent;
  const ownerGone = state !== null && state.owner !== null && state.owner !== me.stackId && observation.ownerNamespaceExists === false;
  const adoptState = state === null || state.owner === null || ownerGone;
  const takeover: ProxyWarning[] = ownerGone
    ? [
        {
          code: 'W-PX-TAKEOVER',
          message: `Traefik in ${K8S_SYSTEM_NAMESPACE} was managed by stack ${ownerName(state)}, which no longer exists, so ${me.stackName} manages it from now on`,
        },
      ]
    : [];

  // M1-M3: a pending operation
  if (release !== null && isPendingStatus(release.status)) {
    const stale = isStale(observation.pendingSince, input.now, pendingStaleAfterS(TRAEFIK_TIMEOUT_S));
    const since = timeText(observation.pendingSince);
    if (stale && observation.lastDeployedRevision !== null) {
      return proxyPlan('upgrade', {
        reasons: [`recovering from an interrupted ${release.status.replace('pending-', '')}`],
        warnings: takeover,
        applyCrds,
        recoverTo: observation.lastDeployedRevision,
        adoptState,
      });
    }
    if (stale) {
      return refuse({
        code: 'E-PX-PENDING-INSTALL',
        errorCode: ErrorCode.DEPLOY_FAILED,
        message: `Traefik in ${K8S_SYSTEM_NAMESPACE} has been stuck in ${release.status} since ${since} with no deployed revision to return to, so the interrupted operation will never finish`,
        suggestion: `Remove the unfinished release with \`dockflow helm uninstall ${env} --system --force -y\`, then deploy again; no route or certificate is lost, because the ACME volume is kept.`,
      });
    }
    const revision = observation.lastDeployedRevision === null ? '<revision>' : String(observation.lastDeployedRevision);
    return refuse({
      code: 'E-PX-PENDING',
      errorCode: ErrorCode.DEPLOY_FAILED,
      message: `Traefik in ${K8S_SYSTEM_NAMESPACE} has a Helm operation in progress since ${since} (${release.status})`,
      suggestion: `Wait for it to finish and inspect it with \`dockflow helm status ${env} --system\`; if nothing is running, return to the last good revision with \`dockflow helm rollback ${env} --system ${revision}\`.`,
    });
  }

  // M4
  if (release?.status === 'uninstalling') {
    return refuse({
      code: 'E-PX-UNINSTALLING',
      errorCode: ErrorCode.DEPLOY_FAILED,
      message: `Traefik in ${K8S_SYSTEM_NAMESPACE} is being uninstalled`,
      suggestion: 'Wait for the uninstall to finish, then deploy again.',
    });
  }

  // M5: never downgrade what a newer CLI deployed
  const newer = newerThanPin(input, release, pin);
  if (newer !== null) {
    return proxyPlan('keep-newer', {
      reasons: [`chart ${newer.deployed} is newer than this Dockflow release`],
      warnings: [
        {
          code: 'W-PX-NEWER',
          message: `Traefik chart ${newer.deployed} in ${K8S_SYSTEM_NAMESPACE} is newer than this Dockflow release (${newer.mine}), so the proxy is left unchanged`,
          suggestion: `Upgrade the Dockflow CLI used for ${me.stackName}.`,
        },
        ...notReadyWarning(observation, env),
      ],
    });
  }

  // M6
  const valuesMatch = observation.deployedValues !== null && canonicalJson(observation.deployedValues) === canonicalJson(desired);
  const drift = observation.pods.find((pod) => pod.phase === 'Running' && pod.node !== null && pod.node !== hostname)?.node ?? null;
  if (
    release?.status === 'deployed' &&
    chartMatches &&
    valuesMatch &&
    observation.deployment !== null &&
    observation.deployment.replicas >= 1 &&
    drift === null
  ) {
    const warnings = [...notReadyWarning(observation, env), ...takeover];
    if (!observation.crdsPresent) return proxyPlan('crds-only', { reasons: ['traefik.io CRDs missing'], warnings, applyCrds: true, adoptState });
    return proxyPlan('unchanged', { warnings, adoptState });
  }

  // M7: two managing stacks with different settings
  if (state !== null && state.owner !== null && state.owner !== me.stackId && observation.ownerNamespaceExists !== false && state.intentSha256 !== intentSha256(intent)) {
    return refuse(conflictRefusal(input, state));
  }

  const ports = proxyHostPorts(intent.acme);
  const firewall = (open: readonly number[]): ProxyWarning => ({
    code: 'W-PX-FIREWALL',
    message: open.length === 1 ? `Port ${open[0]} has to be open on ${hostname} for Traefik to answer` : `Ports ${joinWithAnd(open.map(String))} have to be open on ${hostname} for Traefik to answer`,
    suggestion: `If your nodes run ufw or firewalld, re-run \`dockflow setup ${input.distribution} ${env}\` to open ports 80 and 443.`,
  });

  // M8
  if (release === null) {
    return proxyPlan('install', { reasons: ['not installed'], warnings: [...takeover, firewall(ports)], applyCrds: true, adoptState });
  }

  // M9
  const reasons: string[] = [];
  if (!chartMatches) reasons.push(`chart ${release.chartVersion ?? 'unknown'} -> ${pin.version}`);
  if (state !== null && state.intentSha256 !== null && state.intentSha256 !== intentSha256(intent)) {
    const fields = differingFields(intent, state);
    if (fields.length > 0) reasons.push(`settings changed (${fields.map((field) => FIELD_KEYS[field]).join(', ')})`);
  }
  const deployedRevision = deployedValuesRevision(observation);
  if (deployedRevision !== null && deployedRevision < TRAEFIK_VALUES_REVISION) reasons.push(`values revision ${deployedRevision} -> ${TRAEFIK_VALUES_REVISION}`);
  const recordedNode = state?.nodeHostname ?? null;
  const moved = recordedNode !== null && recordedNode !== hostname;
  if (moved) reasons.push(`node ${recordedNode} -> ${hostname}`);
  if (drift !== null) reasons.push(`running on ${drift}, pinned to ${hostname}`);
  if (observation.deployment !== null && observation.deployment.replicas < 1) reasons.push('deployment scaled to 0');
  if (release.status !== 'deployed') reasons.push(`release status ${release.status}`);
  if (observation.deployment === null) reasons.push('deployment missing');
  if (reasons.length === 0) reasons.push('values changed');

  const warnings: ProxyWarning[] = [...takeover];
  if (drift !== null) {
    warnings.push({
      code: 'W-PX-NODE-DRIFT',
      message: `Traefik runs on ${drift} but is pinned to ${hostname}, so it is moved back to ${hostname}`,
      suggestion: `Check who edited Deployment ${K8S_PROXY_RELEASE}; DNS for this environment must point at ${hostname}.`,
    });
  }
  const acmeTurnedOn = intent.acme && valuesAt(observation.deployedValues, ['ports', 'websecure', 'hostPort']) !== 443;
  if (moved || drift !== null) warnings.push(firewall(ports));
  else if (acmeTurnedOn) warnings.push(firewall([443]));
  return proxyPlan('upgrade', { reasons, warnings, applyCrds, adoptState });
}

// ---------------------------------------------------------------------------
// Port conflicts and scheduling details (2.10)
// ---------------------------------------------------------------------------

/** E-PX-HOSTPORT for each proxy port a host process listens on (first listener per port). */
export function hostPortRefusals(listeners: readonly { port: number; local: string }[], ports: readonly number[], node: string): ProxyRefusal[] {
  const refusals: ProxyRefusal[] = [];
  for (const port of [...ports].sort((a, b) => a - b)) {
    const listener = listeners.find((item) => item.port === port);
    if (listener === undefined) continue;
    refusals.push({
      code: 'E-PX-HOSTPORT',
      errorCode: ErrorCode.DEPLOY_FAILED,
      message: `Port ${port} on ${node} is used by a host process (${listener.local}), and Dockflow's Traefik publishes ports 80 and 443 on that node, so it would take its traffic`,
      suggestion: 'Stop that service (the host nginx of the nginx plugin, for example), or set `proxy.enabled: false` for this environment.',
    });
  }
  return refusals;
}

export interface PodPortConflict {
  port: number;
  namespace: string;
  pod: string;
  node: string;
}

function isProxyPod(pod: Pod): boolean {
  return pod.metadata.namespace === K8S_SYSTEM_NAMESPACE && pod.metadata.labels?.[LABELS.name] === 'traefik';
}

/**
 * Scheduled pods other than Traefik's that publish a proxy port as a TCP hostPort; this also
 * catches the load-balancer pods of Services on 80/443, including a leftover bundled Traefik.
 */
export function podPortConflicts(pods: readonly Pod[], ports: readonly number[]): PodPortConflict[] {
  const out: PodPortConflict[] = [];
  const seen = new Set<string>();
  for (const pod of pods) {
    const phase = pod.status?.phase;
    const node = pod.spec.nodeName;
    if (isProxyPod(pod) || phase === 'Succeeded' || phase === 'Failed' || !node) continue;
    for (const container of pod.spec.containers) {
      for (const port of container.ports ?? []) {
        if (port.hostPort === undefined || !ports.includes(port.hostPort) || (port.protocol ?? 'TCP') !== 'TCP') continue;
        const namespace = pod.metadata.namespace ?? 'default';
        const key = `${port.hostPort}/${namespace}/${pod.metadata.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ port: port.hostPort, namespace, pod: pod.metadata.name, node });
      }
    }
  }
  return out.sort((a, b) => a.port - b.port || compareText(a.namespace, b.namespace) || compareText(a.pod, b.pod));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function podPortRefusal(conflict: PodPortConflict): ProxyRefusal {
  return {
    code: 'E-PX-PODPORT',
    errorCode: ErrorCode.DEPLOY_FAILED,
    message: `Port ${conflict.port} is already published by pod ${conflict.namespace}/${conflict.pod} on ${conflict.node}`,
    suggestion: 'Remove that workload or its published port, then deploy again.',
  };
}

const SCHEDULING_HINTS = ["didn't have free ports", "didn't match Pod's node affinity/selector"];

/** FailedScheduling messages that explain a Traefik pod stuck Pending, appended to E-PX-HELM. */
export function schedulingFailures(events: readonly Event[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    const message = event.message;
    if (event.reason !== 'FailedScheduling' || !message || !SCHEDULING_HINTS.some((hint) => message.includes(hint))) continue;
    if (!out.includes(message)) out.push(message);
  }
  return out;
}

export interface IngressFact {
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { ingressClassName?: string };
}

const MAX_CLASSLESS_NAMES = 5;

/**
 * W-PX-CLASSLESS-INGRESS: with `proxy.default_ingress_class`, Ingress objects that name no class
 * outside Dockflow stack namespaces are published on 80/443 (C24).
 */
export function classlessIngressWarning(ingresses: readonly IngressFact[], stackNamespaces: ReadonlySet<string>): ProxyWarning | null {
  const names = ingresses
    .filter((ingress) => !ingress.spec?.ingressClassName && !ingress.metadata.annotations?.['kubernetes.io/ingress.class'])
    .map((ingress) => ({ namespace: ingress.metadata.namespace ?? 'default', name: ingress.metadata.name }))
    .filter((ingress) => !stackNamespaces.has(ingress.namespace))
    .map((ingress) => `${ingress.namespace}/${ingress.name}`)
    .sort();
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_CLASSLESS_NAMES).join(', ') + (names.length > MAX_CLASSLESS_NAMES ? ', ...' : '');
  return {
    code: 'W-PX-CLASSLESS-INGRESS',
    message: `\`proxy.default_ingress_class\` publishes ${names.length} Ingress object(s) that set no ingressClassName on ports 80 and 443: ${shown}`,
    suggestion: 'Set `ingressClassName` on those objects, or set `proxy.default_ingress_class: false` and add `ingressClassName: traefik` where routing is wanted.',
  };
}
