// Parsers for helm output and Helm storage metadata (design-04 3.5.4, 3.6). Pure: helm stdout is
// parsed in memory and never logged, and manifest text never leaves this module (3.14).

import { parseAllDocuments } from 'yaml';
import { DeployError } from '../../../../utils/errors';
import type { HelmChartSource, HelmManifestObject, HelmReleaseStatus, HelmStatus, StackRole } from '../../interfaces';
import { KUBE_KEYS, LABELS } from '../constants';

// ---------------------------------------------------------------------------
// Statuses and times
// ---------------------------------------------------------------------------

const HELM_STATUSES: ReadonlySet<string> = new Set<HelmStatus>([
  'deployed',
  'failed',
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'superseded',
  'uninstalling',
  'uninstalled',
]);

/** Anything Helm adds later parses as 'unknown'. */
export function parseHelmStatus(value: unknown): HelmStatus {
  return typeof value === 'string' && HELM_STATUSES.has(value) ? (value as HelmStatus) : 'unknown';
}

export function isPendingStatus(status: string): boolean {
  return status === 'pending-install' || status === 'pending-upgrade' || status === 'pending-rollback';
}

// `helm list` prints Go's time.String(): "2026-09-17 10:11:12.123456789 +0000 UTC"
const GO_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? ([+-])(\d{2})(\d{2})(?: [A-Za-z0-9+-]+)?$/;
// `helm history -o json` prints RFC 3339 with nanoseconds
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** Helm list and history times -> ISO 8601 UTC with milliseconds (truncated); unparseable -> null. */
export function parseHelmTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const go = GO_TIME_RE.exec(text);
  if (go) return isoFrom(go.slice(1, 8), go[8], go[9], go[10]);
  const rfc = RFC3339_RE.exec(text);
  if (rfc) return rfc[8] ? isoFrom(rfc.slice(1, 8), '+', '00', '00') : isoFrom(rfc.slice(1, 8), rfc[9], rfc[10], rfc[11]);
  return null;
}

function isoFrom(parts: string[], sign: string, offsetHours: string, offsetMinutes: string): string | null {
  const [year, month, day, hour, minute, second] = parts.slice(0, 6).map(Number);
  const millis = Number((parts[6] ?? '').padEnd(3, '0').slice(0, 3));
  const oh = Number(offsetHours);
  const om = Number(offsetMinutes);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || oh > 23 || om > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(local);
  // Date.UTC rolls 2026-02-31 over to March: refuse instead of shifting the date
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const offsetMs = (sign === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  return new Date(local - offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// helm list / history / get values (F17)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function revisionOf(value: unknown): number | null {
  const revision = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

/**
 * `helm list -o json` rows: the revision arrives as a string, and `role` stays null because a list
 * row carries no labels (the backend knows it from the selector it listed with).
 */
export function parseHelmList(json: unknown): HelmReleaseStatus[] {
  if (!Array.isArray(json)) return [];
  const rows: HelmReleaseStatus[] = [];
  for (const item of json) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.namespace !== 'string') continue;
    const revision = revisionOf(item.revision);
    if (revision === null) continue;
    rows.push({
      name: item.name,
      namespace: item.namespace,
      role: null,
      revision,
      status: parseHelmStatus(item.status),
      chart: typeof item.chart === 'string' ? item.chart : '',
      appVersion: stringOrNull(item.app_version),
      updated: parseHelmTime(item.updated),
    });
  }
  return rows;
}

export type HelmHistoryEntry = HelmReleaseStatus & { description: string | null };

/**
 * `helm history -o json` rows of one release, newest first. Descriptions quote Kubernetes errors,
 * which can echo values, so they pass through `redact` before anything else sees them.
 */
export function parseHelmHistory(
  json: unknown,
  release: { name: string; namespace: string },
  redact: (text: string) => string = (text) => text,
): HelmHistoryEntry[] {
  if (!Array.isArray(json)) return [];
  const rows: HelmHistoryEntry[] = [];
  for (const item of json) {
    if (!isRecord(item)) continue;
    const revision = revisionOf(item.revision);
    if (revision === null) continue;
    const description = stringOrNull(item.description);
    rows.push({
      name: release.name,
      namespace: release.namespace,
      role: null,
      revision,
      status: parseHelmStatus(item.status),
      chart: typeof item.chart === 'string' ? item.chart : '',
      appVersion: stringOrNull(item.app_version),
      updated: parseHelmTime(item.updated),
      description: description === null ? null : redact(description),
    });
  }
  return rows.sort((a, b) => b.revision - a.revision);
}

/**
 * What planning needs from a history (O7, 3.7.1): the last revision that was successfully
 * deployed, and when the latest revision went pending.
 */
export function historyFacts(history: readonly Pick<HelmReleaseStatus, 'revision' | 'status' | 'updated'>[]): {
  lastDeployedRevision: number | null;
  pendingSince: string | null;
} {
  let latest: Pick<HelmReleaseStatus, 'revision' | 'status' | 'updated'> | null = null;
  let lastDeployedRevision: number | null = null;
  for (const entry of history) {
    if (latest === null || entry.revision > latest.revision) latest = entry;
    if ((entry.status === 'deployed' || entry.status === 'superseded') && (lastDeployedRevision === null || entry.revision > lastDeployedRevision)) {
      lastDeployedRevision = entry.revision;
    }
  }
  return { lastDeployedRevision, pendingSince: latest !== null && isPendingStatus(latest.status) ? latest.updated : null };
}

/** `helm get values -o json`: `null` means no user values. */
export function parseDeployedValues(json: unknown): Record<string, unknown> {
  if (json === null || json === undefined) return {};
  if (!isRecord(json)) throw new DeployError('The deployed values of a Helm release are not a map');
  return json;
}

// ---------------------------------------------------------------------------
// Chart names
// ---------------------------------------------------------------------------

const CHART_STRING_RE = /^(.*)-(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/;

/** `helm list` prints `<chart name>-<chart version>` as one string. */
export function splitChartString(chart: string): { name: string; version: string | null } {
  const match = CHART_STRING_RE.exec(chart);
  return match ? { name: match[1], version: match[2] } : { name: chart, version: null };
}

/** The chart name Helm records for a source: the repository chart, or the last OCI path segment. */
export function desiredChartName(chart: HelmChartSource): string {
  if (chart.kind === 'repo') return chart.chart;
  return chart.ref.slice(chart.ref.lastIndexOf('/') + 1);
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * SemVer precedence of two chart versions (a leading `v` ignored, build metadata ignored):
 * negative, zero or positive; null when either is not a SemVer.
 */
export function compareChartVersions(a: string, b: string): number | null {
  const x = SEMVER_RE.exec(a.trim());
  const y = SEMVER_RE.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePrerelease(x[4] ?? null, y[4] ?? null);
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (i >= left.length) return -1;
    if (i >= right.length) return 1;
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln) return -1;
    if (rn) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** Chart versions compared the way config.yml writes them: `v1.2.3` equals `1.2.3`. */
export function sameChartVersion(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return a.replace(/^v/, '') === b.replace(/^v/, '');
}

// ---------------------------------------------------------------------------
// Helm storage Secrets (names and labels only: a payload read transfers user values, F29)
// ---------------------------------------------------------------------------

/** `sh.helm.release.v1.<name>.v<revision>`, Helm's storage contract */
export function helmStorageSecretName(name: string, revision: number): string {
  return `sh.helm.release.v1.${name}.v${revision}`;
}

const STORAGE_SECRET_RE = /^secret\/sh\.helm\.release\.v1\.(.+)\.v(\d+)$/;

/** `kubectl get secrets -o name` lines of Helm storage Secrets; other lines are ignored. */
export function parseReleaseSecretNames(stdout: string): { name: string; revision: number }[] {
  const out: { name: string; revision: number }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = STORAGE_SECRET_RE.exec(line.trim());
    if (!match) continue;
    const revision = Number(match[2]);
    if (Number.isSafeInteger(revision) && revision > 0) out.push({ name: match[1], revision });
  }
  return out;
}

/** Ownership labels of a release (written by `--labels`, carried by every storage Secret). */
export function releaseOwnerFromLabels(labels: Record<string, string> | undefined): { stackId: string; role: StackRole } | null {
  const stackId = labels?.[LABELS.stack];
  const role = labels?.[LABELS.role];
  if (!stackId || (role !== 'app' && role !== 'accessory')) return null;
  return { stackId, role };
}

/** Deployed or superseded revisions of one release carrying a spec hash (3.5.4, read with `-o name`). */
export function specRevisionsSelector(name: string, specHash: string): string {
  return `owner=helm,name=${name},status in (deployed,superseded),${LABELS.specHash}=${specHash}`;
}

/** The skip predicate, batched per namespace: deployed revisions whose spec hash is one of these. */
export function deployedSpecSelector(specHashes: readonly string[]): string {
  const hashes = [...new Set(specHashes)].sort();
  return `owner=helm,status=deployed,${LABELS.specHash} in (${hashes.join(',')})`;
}

// ---------------------------------------------------------------------------
// Manifests (`helm get manifest`)
// ---------------------------------------------------------------------------

/**
 * Objects of a release manifest. Helm keeps an object on uninstall when its resource-policy
 * annotation, trimmed and lowercased, is `keep` (F20). YAML errors throw without quoting the
 * source, which may hold rendered secrets.
 */
export function parseManifestObjects(text: string): HelmManifestObject[] {
  const objects: HelmManifestObject[] = [];
  for (const doc of parseAllDocuments(text)) {
    const error = doc.errors[0];
    if (error) {
      const line = error.linePos?.[0]?.line;
      throw new DeployError(`A Helm release manifest is not valid YAML (${error.code}${line === undefined ? '' : ` at line ${line}`})`);
    }
    const value: unknown = doc.toJS();
    if (!isRecord(value) || typeof value.kind !== 'string' || value.kind === '') continue;
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    if (typeof metadata.name !== 'string' || metadata.name === '') continue;
    const annotations = isRecord(metadata.annotations) ? metadata.annotations : {};
    const policy = annotations[KUBE_KEYS.helmResourcePolicy];
    objects.push({
      kind: value.kind,
      name: metadata.name,
      namespace: typeof metadata.namespace === 'string' && metadata.namespace !== '' ? metadata.namespace : null,
      keep: typeof policy === 'string' && policy.trim().toLowerCase() === 'keep',
      claimTemplates: value.kind === 'StatefulSet' ? claimTemplateNames(value.spec) : [],
    });
  }
  return objects;
}

function claimTemplateNames(spec: unknown): string[] {
  if (!isRecord(spec) || !Array.isArray(spec.volumeClaimTemplates)) return [];
  const names: string[] = [];
  for (const template of spec.volumeClaimTemplates) {
    if (isRecord(template) && isRecord(template.metadata) && typeof template.metadata.name === 'string') {
      names.push(template.metadata.name);
    }
  }
  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** PVCs a StatefulSet creates from a claim template: `<claim>-<statefulSet>-<ordinal>`. */
export function statefulSetClaimPattern(claim: string, statefulSet: string): RegExp {
  return new RegExp(`^${escapeRegExp(claim)}-${escapeRegExp(statefulSet)}-\\d+$`);
}
