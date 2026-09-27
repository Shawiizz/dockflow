// KubernetesHelmBackend (design-04 3.5-3.9, D17, PD-3, PD-4, PD-9). Talks to Helm over the bundle's
// HelmExecutor bound to the control plane and reads Helm's storage Secrets (labels only, never the
// payload) over the bundle's KubeExecutor. Chart bytes are pinned and pulled through
// runtime/chart-archive.ts; values travel on stdin only (DESIGN-CORE 8.4 R2); every mutating call is
// announced through HelmEventSink before it runs (backends never print, DESIGN-CORE 1.1).
//
// Every listing this file issues names every status (HELM_LIST_EVERY_STATUS), so a release stuck
// `pending-*` or `uninstalling` is observed by planning and by `dockflow helm status`/`list`
// whatever the default of the pinned Helm (4.3 lists every status; fixtures/helm/helm-list).

import { DOCKFLOW_VERSION } from '../../../../constants';
import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { DeployError, ErrorCode } from '../../../../utils/errors';
import type { Redactor } from '../../../../utils/redact';
import type {
  HelmBackend,
  HelmEventSink,
  HelmManifestObject,
  HelmPlanEntry,
  HelmReleaseRecord,
  HelmReleaseStatus,
  HelmUpgradeResult,
  ResolvedHelmRelease,
  StackRole,
} from '../../interfaces';
import { K8S_REQUEST_TIMEOUT_S, LABELS } from '../constants';
import type { Clock, KubernetesBundleDeps } from '../deps';
import type { K8sDistribution } from '../distribution';
import {
  type NamespaceOwner,
  type ObservedRelease,
  planRelease,
  previousRevisionOf,
  recoveryWarning,
} from '../helm/plan';
import {
  historyFacts,
  isPendingStatus,
  parseDeployedValues,
  parseHelmHistory,
  parseHelmList,
  parseHelmStatus,
  parseManifestObjects,
  parseReleaseSecretNames,
  releaseOwnerFromLabels,
  splitChartString,
} from '../helm/parse';
import { helmRedactions, helmSpecHash } from '../helm/resolve';
import { helmValuesStdin } from '../helm/values-yaml';
import type { Namespace } from '../resources/core';
import { chartDisplayOf, type ChartArchiveDeps, resolveChartArchive } from '../runtime/chart-archive';
import { classifyKubectlFailure, KubeError, kubeErrorToCliError, type KubeErrorContext } from '../runtime/errors';
import { HELM_LIST_EVERY_STATUS, type HelmExecutor, type HelmResult } from '../runtime/helm';
import { type HelmCallContext, helmKubeErrorToCliError, helmResultToCliError } from '../runtime/helm-errors';
import type { KubeExecutor } from '../runtime/kubectl';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** design-04 3.4.4: chart source and version unchanged, so a previous digest is still trustworthy. */
function sameChartPin(record: Pick<HelmReleaseRecord, 'chart' | 'version'>, release: Pick<ResolvedHelmRelease, 'chart' | 'version'>): boolean {
  if (record.chart.kind !== release.chart.kind) return false;
  const sameSource =
    record.chart.kind === 'repo' && release.chart.kind === 'repo'
      ? record.chart.repo === release.chart.repo && record.chart.chart === release.chart.chart
      : record.chart.kind === 'oci' && release.chart.kind === 'oci' && record.chart.ref === release.chart.ref;
  return sameSource && record.version.replace(/^v/, '') === release.version.replace(/^v/, '');
}

interface HelmListRow {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  appVersion: string | null;
  updated: string | null;
}

/**
 * `helm upgrade --install` of a release as every deploy runs it (3.5): values on stdin, rollback on
 * failure, and the ownership and spec-hash labels on the release storage.
 */
export function helmUpgradeArgs(
  release: ResolvedHelmRelease,
  archivePath: string,
  options: { historyMax: number; stackId: string; description?: string },
  extra: string[] = [],
): string[] {
  const args = ['upgrade', '--install', release.name, archivePath, '-n', release.namespace];
  if (release.namespace !== options.stackId) args.push('--create-namespace');
  args.push(
    '--values',
    '-',
    '--reset-values',
    '--rollback-on-failure',
    '--wait=watcher',
    '--wait-for-jobs',
    '--timeout',
    `${release.timeoutS}s`,
    '--history-max',
    String(options.historyMax),
    '--force-conflicts',
    '--description',
    options.description ?? `Dockflow ${DOCKFLOW_VERSION}`,
    '--labels',
    `${LABELS.stack}=${options.stackId},${LABELS.role}=${release.role},${LABELS.specHash}=${helmSpecHash(release)}`,
  );
  args.push(...extra);
  return args;
}

/** `helm uninstall` of a release as every uninstall runs it. */
export function helmUninstallArgs(
  namespace: string,
  name: string,
  options: { timeoutS: number; keepHistory?: boolean; description?: string },
): string[] {
  const args = [
    'uninstall',
    name,
    '-n',
    namespace,
    '--wait=watcher',
    '--cascade=foreground',
    '--timeout',
    `${options.timeoutS}s`,
    '--ignore-not-found',
    '--description',
    options.description ?? 'Dockflow uninstall',
  ];
  if (options.keepHistory) args.push('--keep-history');
  return args;
}

/** `helm rollback` of a release to `revision` as `dockflow rollback` runs it. */
export function helmRollbackArgs(
  namespace: string,
  name: string,
  revision: number,
  options: { timeoutS: number; historyMax?: number; description?: string },
): string[] {
  const args = ['rollback', name, String(revision), '-n', namespace, '--wait=watcher', '--wait-for-jobs', '--timeout', `${options.timeoutS}s`];
  if (options.historyMax !== undefined) args.push('--history-max', String(options.historyMax));
  args.push('--force-conflicts', '--description', options.description ?? `Dockflow rollback to revision ${revision}`);
  return args;
}

export interface HelmBackendOptions {
  deps: Pick<KubernetesBundleDeps, 'helm' | 'kubectl' | 'nodeShell' | 'clock' | 'redactor' | 'distribution'>;
  /** environment name, for messages and suggestions */
  env: string;
  /** where upgradeInstall, uninstall and rollback report when the call names no sink */
  events?: HelmEventSink;
}

export class KubernetesHelmBackend implements HelmBackend {
  private readonly helm: HelmExecutor;
  private readonly kubectl: KubeExecutor;
  private readonly clock: Clock;
  private readonly redactor: Redactor;
  private readonly distribution: K8sDistribution;
  private readonly env: string;
  private readonly chartDeps: ChartArchiveDeps;
  private readonly events: HelmEventSink | undefined;

  constructor(options: HelmBackendOptions) {
    this.helm = options.deps.helm;
    this.kubectl = options.deps.kubectl;
    this.clock = options.deps.clock;
    this.redactor = options.deps.redactor;
    this.distribution = options.deps.distribution;
    this.env = options.env;
    this.chartDeps = { helm: this.helm, shell: options.deps.nodeShell(this.helm.node) };
    this.events = options.events;
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  private helmContext(operation: string, release: string, namespace: string, chart: string, timeoutS: number, mutating: boolean): HelmCallContext {
    return { env: this.env, operation, release, namespace, node: this.helm.node.name, mutating, chart, timeoutS, distribution: this.distribution.traits.name };
  }

  private kubeContext(operation: string): KubeErrorContext {
    return { env: this.env, operation, mutating: false, distribution: this.distribution.traits.name };
  }

  /** every non-zero exit and every thrown KubeError re-classified with the Helm-specific rules */
  private async run(args: string[], extra: { stdin?: string; mutating: boolean; timeoutS: number }, context: HelmCallContext): Promise<HelmResult> {
    let result: HelmResult;
    try {
      result = await this.helm.run({ args, stdin: extra.stdin, mutating: extra.mutating, timeoutS: extra.timeoutS, allowFailure: true });
    } catch (error) {
      if (error instanceof KubeError) throw helmKubeErrorToCliError(error, context);
      throw error;
    }
    if (result.exitCode !== 0) throw helmResultToCliError(result, context);
    return result;
  }

  /** like run(), but "release: not found" becomes null instead of throwing */
  private async runOptional(args: string[], extra: { stdin?: string; mutating: boolean; timeoutS: number }, context: HelmCallContext): Promise<HelmResult | null> {
    let result: HelmResult;
    try {
      result = await this.helm.run({ args, stdin: extra.stdin, mutating: extra.mutating, timeoutS: extra.timeoutS, allowFailure: true });
    } catch (error) {
      if (error instanceof KubeError) throw helmKubeErrorToCliError(error, context);
      throw error;
    }
    if (result.exitCode !== 0) {
      if (result.stderr.includes('release: not found')) return null;
      throw helmResultToCliError(result, context);
    }
    return result;
  }

  /** HelmExecutor.json(): null on "release: not found"; a thrown KubeError is re-classified */
  private async json<T>(args: string[], context: HelmCallContext): Promise<T | null> {
    try {
      return await this.helm.json<T>(args);
    } catch (error) {
      if (error instanceof KubeError) throw helmKubeErrorToCliError(error, context);
      throw error;
    }
  }

  private async kubeGetJson<T>(resources: string[], options: { namespace?: string; name?: string; selector?: string }, operation: string): Promise<T[]> {
    try {
      return await this.kubectl.getJson<T>(resources, { ...options, allowNotFound: true });
    } catch (error) {
      if (error instanceof KubeError) throw kubeErrorToCliError(error, this.kubeContext(operation));
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Reads shared by upgradeInstall, plan, status, list, ownerOf
  // -------------------------------------------------------------------------

  /** `list <every status> [-A|-n <ns>] [-l <selector>] [--filter <re>] -o json`, so a `pending-*` or
   * `uninstalling` release stays visible to planning and to `dockflow helm status`/`list` */
  private async helmListRaw(options: { namespace?: string; allNamespaces?: boolean; selector?: string; filter?: string }, release: string): Promise<HelmListRow[]> {
    const args = ['list', ...HELM_LIST_EVERY_STATUS];
    if (options.allNamespaces) args.push('-A');
    else if (options.namespace !== undefined) args.push('-n', options.namespace);
    if (options.selector !== undefined) args.push('-l', options.selector);
    if (options.filter !== undefined) args.push('--filter', options.filter);
    const context = this.helmContext('list', release, options.namespace ?? '*', release, K8S_REQUEST_TIMEOUT_S, false);
    const json = await this.json<unknown>(args, context);
    return json === null ? [] : parseHelmList(json);
  }

  /** the release's storage-secret labels (owner + spec hash), read once per matched revision */
  private async releaseLabels(namespace: string, name: string, revision: number): Promise<Record<string, string> | undefined> {
    const secretName = `sh.helm.release.v1.${name}.v${revision}`;
    const secrets = await this.kubeGetJson<{ metadata: { labels?: Record<string, string> } }>(
      ['secrets'],
      { namespace, name: secretName },
      'read a Helm release label',
    );
    return secrets[0]?.metadata.labels;
  }

  private async ownerLabelsOf(namespace: string, name: string, revision: number): Promise<{ stackId: string; role: StackRole } | null> {
    return releaseOwnerFromLabels(await this.releaseLabels(namespace, name, revision));
  }

  private async namespaceOwnerOf(namespace: string, stackId: string): Promise<NamespaceOwner> {
    if (namespace === stackId) return 'mine';
    const namespaces = await this.kubeGetJson<Namespace>(['namespaces'], { name: namespace }, 'read a namespace');
    const owner = namespaces[0]?.metadata.labels?.[LABELS.stack];
    if (owner === undefined) return 'free';
    return owner === stackId ? 'mine' : { stackName: owner };
  }

  private async observe(
    release: Pick<ResolvedHelmRelease, 'name' | 'namespace' | 'role' | 'chart' | 'version' | 'values'>,
    stackId: string,
  ): Promise<{ observed: ObservedRelease | null; row: HelmListRow | null }> {
    const rows = await this.helmListRaw({ namespace: release.namespace, filter: `^${escapeRegExp(release.name)}$` }, release.name);
    const row = rows.find((candidate) => candidate.name === release.name);
    if (row === undefined) return { observed: null, row: null };
    const labels = await this.releaseLabels(release.namespace, release.name, row.revision);
    const ownerInfo = releaseOwnerFromLabels(labels);
    const owner: ObservedRelease['owner'] =
      ownerInfo === null ? { kind: 'none' } : ownerInfo.stackId === stackId ? { kind: 'me' } : { kind: 'foreign', stackId: ownerInfo.stackId };
    const status = parseHelmStatus(row.status);
    const deployedSpecMatches = status === 'deployed' && labels?.[LABELS.specHash] === helmSpecHash(release);
    let lastDeployedRevision: number | null = null;
    let pendingSince: string | null = null;
    if (status === 'failed' || isPendingStatus(status)) {
      const history = await this.history(release.namespace, release.name, 20);
      const facts = historyFacts(history);
      lastDeployedRevision = facts.lastDeployedRevision;
      pendingSince = facts.pendingSince;
    }
    const observed: ObservedRelease = { name: release.name, namespace: release.namespace, revision: row.revision, status, chart: row.chart, owner, deployedSpecMatches, lastDeployedRevision, pendingSince };
    return { observed, row };
  }

  private async planOne(
    release: ResolvedHelmRelease,
    stackId: string,
    adoptAllowed: boolean,
    now: Date,
  ): Promise<{ entry: HelmPlanEntry; observed: ObservedRelease | null; row: HelmListRow | null }> {
    const namespaceOwner = await this.namespaceOwnerOf(release.namespace, stackId);
    const { observed, row } = await this.observe(release, stackId);
    return { entry: planRelease(release, observed, { now, namespaceOwner, adoptAllowed, env: this.env }), observed, row };
  }

  // -------------------------------------------------------------------------
  // HelmBackend
  // -------------------------------------------------------------------------

  async plan(releases: ResolvedHelmRelease[], stackId: string, options?: { adopt?: string[] }): Promise<HelmPlanEntry[]> {
    const adopt = new Set(options?.adopt ?? []);
    const now = this.clock.now();
    const out: HelmPlanEntry[] = [];
    for (const release of releases) {
      const { entry } = await this.planOne(release, stackId, adopt.has(release.name), now);
      out.push(entry);
    }
    return out;
  }

  async upgradeInstall(
    release: ResolvedHelmRelease,
    options: {
      historyMax: number;
      stackId: string;
      events?: HelmEventSink;
      description?: string;
      adopt?: boolean;
      allowChartDrift?: boolean;
    },
  ): Promise<HelmUpgradeResult> {
    // a rollback re-installs from a stored record the render never saw
    this.redactor.add(helmRedactions([release]));
    const events = options.events ?? this.events;
    const now = this.clock.now();
    const { entry, observed, row } = await this.planOne(release, options.stackId, options.adopt === true, now);
    const display = chartDisplayOf(release.chart, release.version);

    if (entry.action === 'blocked') throw new DeployError(entry.reason, ErrorCode.VALIDATION_FAILED, entry.suggestion);

    if (entry.action === 'skipped') {
      if (observed === null || row === null) {
        throw new DeployError(`Helm release ${release.name} was planned unchanged but is no longer observed in namespace ${release.namespace}`, ErrorCode.DEPLOY_FAILED);
      }
      // built from what planning already read: the skip rule makes no further Helm call (3.6)
      return {
        name: release.name,
        namespace: release.namespace,
        role: release.role,
        revision: observed.revision,
        status: observed.status,
        chart: row.chart,
        appVersion: row.appVersion,
        updated: row.updated,
        changed: false,
        previousRevision: observed.revision,
        chartSha256: release.declaredDigest ?? '',
      };
    }

    if (entry.rollbackTo !== undefined && observed !== null) {
      events?.step(`Recovering Helm release ${release.name} (rollback to revision ${entry.rollbackTo})...`);
      events?.warn(recoveryWarning(observed, entry.rollbackTo).message);
      await this.performRollback(release.namespace, release.name, entry.rollbackTo, {
        timeoutS: release.timeoutS,
        historyMax: options.historyMax,
        description: `Dockflow recovery of ${release.name}`,
      });
    }

    const previousRevision = previousRevisionOf(observed);
    const archive = await resolveChartArchive(this.chartDeps, release, release.declaredDigest, {
      allowDrift: options.allowChartDrift ?? false,
      events,
      env: this.env,
      distribution: this.distribution.traits.name,
    });
    const stdin = helmValuesStdin(release.values);
    const context = this.helmContext(entry.reason === 'adopt' ? 'adopt' : 'upgrade', release.name, release.namespace, display, release.timeoutS, true);

    if (entry.reason === 'adopt') {
      events?.step(`Taking over Helm release ${release.name} (${display})...`);
      await this.run(
        helmUpgradeArgs(release, archive.path, options, ['--dry-run=server', '--hide-secret', '-o', 'json']),
        { stdin, mutating: true, timeoutS: release.timeoutS },
        context,
      );
    } else {
      events?.step(`${entry.action === 'installed' ? 'Installing' : 'Upgrading'} Helm release ${release.name} (${display})...`);
    }
    await this.run(helmUpgradeArgs(release, archive.path, options), { stdin, mutating: true, timeoutS: release.timeoutS }, context);

    const status = await this.status(release.namespace, release.name);
    if (status === null) {
      throw new DeployError(`Helm release ${release.name} was not found in namespace ${release.namespace} right after it was installed`, ErrorCode.DEPLOY_FAILED);
    }
    return {
      ...status,
      changed: true,
      previousRevision,
      chartSha256: archive.sha256,
      ...(entry.reason === 'adopt' ? { adopted: true } : {}),
    };
  }

  async uninstall(namespace: string, name: string, options: { timeoutS: number; keepHistory?: boolean; description?: string; events?: HelmEventSink }): Promise<void> {
    (options.events ?? this.events)?.step(`Uninstalling Helm release ${name}...`);
    const context = this.helmContext('uninstall', name, namespace, name, options.timeoutS, true);
    await this.run(helmUninstallArgs(namespace, name, options), { mutating: true, timeoutS: options.timeoutS }, context);
  }

  async rollback(namespace: string, name: string, revision: number, options: { timeoutS: number; historyMax?: number; description?: string; events?: HelmEventSink }): Promise<HelmReleaseStatus> {
    (options.events ?? this.events)?.step(`Rolling back Helm release ${name} to revision ${revision}...`);
    return this.performRollback(namespace, name, revision, options);
  }

  private async performRollback(
    namespace: string,
    name: string,
    revision: number,
    options: { timeoutS: number; historyMax?: number; description?: string },
  ): Promise<HelmReleaseStatus> {
    const context = this.helmContext('rollback', name, namespace, name, options.timeoutS, true);
    await this.run(helmRollbackArgs(namespace, name, revision, options), { mutating: true, timeoutS: options.timeoutS }, context);
    const status = await this.status(namespace, name);
    if (status === null) {
      throw new DeployError(`Helm release ${name} was not found in namespace ${namespace} after rolling back to revision ${revision}`, ErrorCode.ROLLBACK_FAILED);
    }
    return status;
  }

  async listAll(stackId: string): Promise<HelmReleaseStatus[]> {
    const [app, accessory, any] = await Promise.all([
      this.helmListRaw({ allNamespaces: true, selector: `${LABELS.stack}=${stackId},${LABELS.role}=app` }, '*'),
      this.helmListRaw({ allNamespaces: true, selector: `${LABELS.stack}=${stackId},${LABELS.role}=accessory` }, '*'),
      this.helmListRaw({ allNamespaces: true, selector: `${LABELS.stack}=${stackId}` }, '*'),
    ]);
    const tagged = new Map<string, HelmReleaseStatus>();
    for (const row of app) tagged.set(`${row.namespace}/${row.name}`, { ...row, role: 'app' });
    for (const row of accessory) tagged.set(`${row.namespace}/${row.name}`, { ...row, role: 'accessory' });
    for (const row of any) {
      const key = `${row.namespace}/${row.name}`;
      if (!tagged.has(key)) tagged.set(key, { ...row, role: null });
    }
    return [...tagged.values()].sort(compareRows);
  }

  async list(namespaces: string[], stackId: string | null): Promise<HelmReleaseStatus[]> {
    if (stackId !== null) {
      const owned = await this.listAll(stackId);
      return namespaces.length === 0 ? owned : owned.filter((row) => namespaces.includes(row.namespace));
    }
    if (namespaces.length === 0) {
      return (await this.helmListRaw({ allNamespaces: true }, '*')).map((row) => ({ ...row, role: null })).sort(compareRows);
    }
    const out: HelmReleaseStatus[] = [];
    const seen = new Set<string>();
    for (const namespace of namespaces) {
      for (const row of await this.helmListRaw({ namespace }, '*')) {
        const key = `${row.namespace}/${row.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...row, role: null });
      }
    }
    return out.sort(compareRows);
  }

  async status(namespace: string, name: string): Promise<HelmReleaseStatus | null> {
    const rows = await this.helmListRaw({ namespace, filter: `^${escapeRegExp(name)}$` }, name);
    const row = rows.find((candidate) => candidate.name === name);
    if (row === undefined) return null;
    const owner = await this.ownerLabelsOf(namespace, name, row.revision);
    return { ...row, role: owner?.role ?? null };
  }

  async history(namespace: string, name: string, max = 20): Promise<(HelmReleaseStatus & { description: string | null })[]> {
    const context = this.helmContext('history', name, namespace, name, K8S_REQUEST_TIMEOUT_S, false);
    const json = await this.json<unknown>(['history', name, '-n', namespace, '--max', String(max)], context);
    if (json === null) return [];
    return parseHelmHistory(json, { name, namespace }, (text) => this.redactor.redact(text));
  }

  async deployedValues(namespace: string, name: string, revision?: number): Promise<{ values: Record<string, unknown>; valuesSha256: string } | null> {
    const args = ['get', 'values', name, '-n', namespace, '-o', 'json'];
    if (revision !== undefined) args.push('--revision', String(revision));
    const context = this.helmContext('get values', name, namespace, name, K8S_REQUEST_TIMEOUT_S, false);
    const result = await this.runOptional(args, { mutating: false, timeoutS: K8S_REQUEST_TIMEOUT_S }, context);
    if (result === null) return null;
    let parsed: unknown;
    try {
      parsed = result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
    } catch {
      throw new DeployError(`Helm release ${name} returned values on ${this.helm.node.name} that are not valid JSON`, ErrorCode.DEPLOY_FAILED);
    }
    const values = parseDeployedValues(parsed);
    return { values, valuesSha256: sha256Hex(canonicalJson(values)) };
  }

  async revisionsWithSpec(namespace: string, name: string, specHash?: string): Promise<{ revision: number; version: string; valuesSha256: string | null; status: string }[]> {
    const historyContext = this.helmContext('history', name, namespace, name, K8S_REQUEST_TIMEOUT_S, false);
    const json = await this.json<unknown>(['history', name, '-n', namespace, '--max', '256'], historyContext);
    if (json === null) return [];
    const revisions = parseHelmHistory(json, { name, namespace })
      .filter((entry) => entry.status === 'deployed' || entry.status === 'superseded')
      .map((entry) => ({ revision: entry.revision, version: splitChartString(entry.chart).version ?? '', valuesSha256: null as string | null, status: entry.status }));
    if (specHash === undefined) return revisions;
    const selector = `owner=helm,name=${name},status in (deployed,superseded),${LABELS.specHash}=${specHash}`;
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await this.kubectl.run({ args: ['get', 'secrets', '-l', selector, '-o', 'name'], namespace, mutating: false, allowFailure: true });
    } catch (error) {
      if (error instanceof KubeError) throw kubeErrorToCliError(error, this.kubeContext('read release revisions'));
      throw error;
    }
    if (result.exitCode !== 0) {
      throw kubeErrorToCliError(new KubeError(classifyKubectlFailure(result.exitCode, result.stderr), result.stderr, this.kubectl.node.name, result.exitCode, result.stderr), this.kubeContext('read release revisions'));
    }
    const allowed = new Set(parseReleaseSecretNames(result.stdout).filter((entry) => entry.name === name).map((entry) => entry.revision));
    return revisions.filter((entry) => allowed.has(entry.revision));
  }

  async ownerOf(namespace: string, name: string): Promise<{ stackId: string; role: StackRole } | null> {
    const rows = await this.helmListRaw({ namespace, filter: `^${escapeRegExp(name)}$` }, name);
    const row = rows.find((candidate) => candidate.name === name);
    if (row === undefined) return null;
    return this.ownerLabelsOf(namespace, name, row.revision);
  }

  async manifestObjects(namespace: string, name: string): Promise<HelmManifestObject[]> {
    const context = this.helmContext('get manifest', name, namespace, name, K8S_REQUEST_TIMEOUT_S, false);
    const result = await this.runOptional(['get', 'manifest', name, '-n', namespace], { mutating: false, timeoutS: K8S_REQUEST_TIMEOUT_S }, context);
    return result === null ? [] : parseManifestObjects(result.stdout);
  }

  async pinCharts(releases: ResolvedHelmRelease[], previous: HelmReleaseRecord[], options: { allowChartDrift: boolean }): Promise<ResolvedHelmRelease[]> {
    const byName = new Map(previous.map((record) => [record.name, record]));
    const out: ResolvedHelmRelease[] = [];
    for (const release of releases) {
      if (release.declaredDigest !== null) {
        const archive = await resolveChartArchive(this.chartDeps, release, release.declaredDigest, {
          allowDrift: options.allowChartDrift,
          env: this.env,
          distribution: this.distribution.traits.name,
        });
        out.push({ ...release, declaredDigest: archive.sha256 });
        continue;
      }
      const record = byName.get(release.name);
      if (record !== undefined && record.chartSha256 !== null && sameChartPin(record, release)) {
        out.push({ ...release, declaredDigest: record.chartSha256 });
        continue;
      }
      const archive = await resolveChartArchive(this.chartDeps, release, null, { allowDrift: options.allowChartDrift, env: this.env, distribution: this.distribution.traits.name });
      out.push({ ...release, declaredDigest: archive.sha256 });
    }
    return out;
  }
}

function compareRows(a: HelmReleaseStatus, b: HelmReleaseStatus): number {
  if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
