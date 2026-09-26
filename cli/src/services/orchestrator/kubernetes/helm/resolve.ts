// config.helm -> ResolvedHelmRelease[] (DESIGN-CORE 2.5, design-04 3.3 and 3.4). Runs before the
// lock, in `dockflow validate` and in `deploy --dry-run`: pure, no SSH, no clock. Values are read
// from the rendered map (Nunjucks already ran) with Helm's YAML rules, merged like `helm -f`, and
// hashed; credentials stay on the resolved release and never reach a record.

import { posix } from 'path';
import { isRenderedPath } from '../../../../schemas/config.schema';
import type { DockflowConfig, HelmConfig, HelmReleaseConfig } from '../../../../utils/config';
import { ConfigError, ValidationError } from '../../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import type { Diagnostic } from '../../diagnostics';
import type { HelmChartSource, HelmReleaseRecord, ResolvedHelmRelease, StackRole } from '../../interfaces';
import { M } from '../../messages';
import { HELM_DEFAULT_TIMEOUT, K8S_PROXY_RELEASE, K8S_SYSTEM_NAMESPACE } from '../constants';
import { DNS_LABEL_RE, parseDurationMs } from '../model/units';
import { serviceNameFor } from '../naming';
import {
  type HelmValuesResult,
  inlineHelmValuesReader,
  isSensitiveKeyPath,
  isValuesMap,
  joinKeyPath,
  mergeHelmValues,
  parseHelmValues,
} from './values-yaml';

export type ValuesFileLookup =
  | { kind: 'found'; text: string; rendered: boolean }
  | { kind: 'missing' }
  | { kind: 'outside-project' };

export interface HelmResolveInput {
  helm: HelmConfig | undefined;
  role: StackRole;
  stackNamespace: string;
  /** rendered config file (config.yml or dockflow.yml); values are re-read from it with Helm YAML rules */
  configSource: { file: string; text: string };
  /** called with the POSIX-normalized project path of each values file */
  readValuesFile(path: string): ValuesFileLookup;
  composeServices: { app: string[]; accessory: string[] };
  noServices: boolean;
  /** config.templates: a values file outside .dockflow/ must be listed there to be rendered */
  templates?: DockflowConfig['templates'];
  /** compose file of each role as named in messages; default docker-compose.yml / accessories.yml */
  composeFiles?: { app: string; accessory: string };
}

export interface HelmResolveResult {
  /** requested role, config order */
  releases: ResolvedHelmRelease[];
  /** both roles validated */
  diagnostics: Diagnostic[];
  /** string leaves under sensitive key paths and auth passwords, for the bundle Redactor */
  sensitiveValues: string[];
}

const RESERVED_NAME_PREFIX = 'dockflow-';
const RESERVED_NAMESPACES = new Set([K8S_SYSTEM_NAMESPACE, 'kube-public', 'kube-node-lease']);
const CHART_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OCI_REF_RE = /^oci:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/;
const CHART_DIGEST_RE = /^[a-f0-9]{64}$/;
const TIMEOUT_MIN_MS = 30_000;
const TIMEOUT_MAX_MS = 3_600_000;
const MAX_LISTED_ERRORS = 20;
const DEFAULT_COMPOSE_FILES = { app: 'docker-compose.yml', accessory: 'accessories.yml' } as const;

/**
 * The ConfigError of design-04 3.3 layer 2. `diagnostics` keeps every finding, warnings included,
 * so `dockflow validate` can print them one by one instead of parsing the suggestion.
 */
export class HelmConfigError extends ConfigError {
  readonly diagnostics: Diagnostic[];

  constructor(file: string, diagnostics: Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const lines = errors.slice(0, MAX_LISTED_ERRORS).map((d) => `${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`);
    if (errors.length > MAX_LISTED_ERRORS) lines.push(`... and ${errors.length - MAX_LISTED_ERRORS} more`);
    super(`${file}: ${errors.length} Helm configuration error(s)`, lines.join('\n'));
    this.diagnostics = diagnostics;
  }
}

/**
 * Validates the releases of both roles (design-04 3.3) and resolves those of `input.role`. Any
 * error throws one HelmConfigError listing up to 20 of them; warnings come back in `diagnostics`.
 */
export function resolveHelmReleases(input: HelmResolveInput): HelmResolveResult {
  const diagnostics: Diagnostic[] = [];
  const configs = input.helm?.releases ?? [];
  const readInline = inlineHelmValuesReader(input.configSource.text);

  const globalTimeout = input.helm?.timeout;
  if (globalTimeout !== undefined && timeoutMs(globalTimeout) === null) {
    diagnostics.push(timeoutDiagnostic('helm.timeout'));
  }
  if (input.noServices && configs.some((release) => (release.role ?? 'app') === 'app')) {
    diagnostics.push({
      severity: 'error',
      code: 'helm.no-services',
      path: 'no_services',
      message: 'no_services cannot be combined with Helm releases of role app',
      hint: 'Remove `no_services`, because Helm releases are deployed like services.',
    });
  }

  const releases: ResolvedHelmRelease[] = [];
  const sensitive = new Set<string>();
  configs.forEach((config, index) => {
    const resolved = resolveOne(input, config, index, readInline, diagnostics);
    if (resolved === null) return;
    // both roles: a secret of the other role must not leak through this bundle's output either
    collectSensitive(resolved.values, '', sensitive);
    if (resolved.auth) sensitive.add(resolved.auth.password);
    if (resolved.role === input.role) releases.push(resolved);
  });

  if (diagnostics.some((d) => d.severity === 'error')) throw new HelmConfigError(input.configSource.file, diagnostics);
  return { releases, diagnostics, sensitiveValues: [...sensitive] };
}

function resolveOne(
  input: HelmResolveInput,
  config: HelmReleaseConfig,
  index: number,
  readInline: ReturnType<typeof inlineHelmValuesReader>,
  diagnostics: Diagnostic[],
): ResolvedHelmRelease | null {
  const at = (field: string): string => `helm.releases[${index}].${field}`;
  const errorsBefore = diagnostics.filter((d) => d.severity === 'error').length;
  const error = (code: string, field: string, message: string, hint?: string): void => {
    diagnostics.push(hint === undefined ? { severity: 'error', code, path: at(field), message } : { severity: 'error', code, path: at(field), message, hint });
  };
  const role: StackRole = config.role ?? 'app';

  checkName(input, config.name, error);
  const chart = checkChart(config, error, diagnostics, at);
  const namespace = checkNamespace(input, config.namespace, error, diagnostics, at);

  const timeoutText = config.timeout ?? input.helm?.timeout ?? HELM_DEFAULT_TIMEOUT;
  const ms = timeoutMs(timeoutText);
  if (config.timeout !== undefined && ms === null) diagnostics.push(timeoutDiagnostic(at('timeout')));

  if (config.digest !== undefined && !CHART_DIGEST_RE.test(config.digest)) {
    error('helm.chart-digest', 'digest', M.chartDigest, `Copy it from \`dockflow helm status <env> ${config.name}\`, or from \`sha256sum\` of the chart archive.`);
  }

  const layers: Record<string, unknown>[] = [];
  (config.values_files ?? []).forEach((file, j) => {
    const parsed = readValuesFile(input, file, at(`values_files[${j}]`), diagnostics);
    if (parsed) layers.push(parsed);
  });
  const inline = readInline(index, { path: at('values'), file: null });
  if (inline) {
    diagnostics.push(...inline.diagnostics);
    layers.push(inline.values);
  } else if (isValuesMap(config.values)) {
    layers.push(config.values);
  }

  if (diagnostics.filter((d) => d.severity === 'error').length > errorsBefore) return null;
  if (chart === null || ms === null) return null;

  const values = mergeHelmValues(...layers);
  return {
    name: config.name,
    role,
    namespace,
    chart,
    version: config.version,
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: Math.ceil(ms / 1000),
    auth: config.auth ? { username: config.auth.username, password: config.auth.password } : null,
    declaredDigest: config.digest ?? null,
  };
}

type ReportError = (code: string, field: string, message: string, hint?: string) => void;

function checkName(input: HelmResolveInput, name: string, error: ReportError): void {
  if (name.startsWith(RESERVED_NAME_PREFIX)) {
    error('helm.reserved-name', 'name', `Helm release name "${name}" is reserved: names starting with dockflow- belong to Dockflow`, 'Rename the release.');
  }
  const files = input.composeFiles ?? DEFAULT_COMPOSE_FILES;
  for (const role of ['app', 'accessory'] as const) {
    const service = input.composeServices[role].find((svc) => svc === name || serviceNameFor(svc).value === name);
    if (service === undefined) continue;
    error(
      'helm.name-collision',
      'name',
      `Helm release "${name}" has the same name as the compose service "${service}" in ${files[role]}`,
      'Rename the release or the service, because `--only`, `dockflow rollback <env> <name>` and their Kubernetes objects would collide.',
    );
    return;
  }
}

function checkChart(
  config: HelmReleaseConfig,
  error: ReportError,
  diagnostics: Diagnostic[],
  at: (field: string) => string,
): HelmChartSource | null {
  const chart = config.chart;
  if (chart.startsWith('oci://')) {
    // the zod rules of DESIGN-CORE 7.1 are repeated here for callers that skip the schema
    const repoSet = config.repo !== undefined;
    if (repoSet) error('helm.repo-with-oci', 'repo', M.helmRepoWithOci);
    if (OCI_REF_RE.test(chart)) return repoSet ? null : { kind: 'oci', ref: chart };
    error(
      'helm.oci-ref',
      'chart',
      `chart "${chart}" must be oci://<registry>/<path>/<chart> without a tag or digest`,
      'Put the chart version in `version:` and the archive\'s sha256 in `digest:`.',
    );
    return null;
  }

  let valid = true;
  const repo = config.repo;
  if (repo !== undefined) {
    const scheme = repoScheme(repo);
    if (scheme === null) {
      error('helm.repo-scheme', 'repo', M.helmRepoUrl, "Use the repository's https:// URL.");
      valid = false;
    } else if (scheme === 'http') {
      diagnostics.push({
        severity: 'warning',
        code: 'helm.repo-plaintext',
        path: at('repo'),
        message: M.helmRepoPlaintext(repo),
        hint: 'Serve the repository over HTTPS, or pin the archive with `digest:`.',
      });
      if (config.auth) {
        error('helm.repo-auth-plaintext', 'auth', `auth for ${config.name} would send the repository password in clear text over http://`, 'Serve the repository over HTTPS, or remove `auth`.');
        valid = false;
      }
    }
    if (chart.includes('/')) {
      const part = chart.slice(chart.lastIndexOf('/') + 1);
      error(
        'helm.repo-alias',
        'chart',
        `chart "${chart}" looks like a repository alias; Dockflow has no repository aliases`,
        `Set \`chart: ${part}\` and \`repo: <repository URL>\`.`,
      );
      return null;
    }
  }
  if (!CHART_NAME_RE.test(chart)) {
    error('helm.chart-name', 'chart', `chart "${chart}" is not a valid chart name`);
    return null;
  }
  if (repo === undefined) {
    error('helm.repo-required', 'repo', M.helmRepoRequired);
    return null;
  }
  return valid ? { kind: 'repo', repo, chart } : null;
}

function repoScheme(repo: string): 'https' | 'http' | null {
  try {
    const protocol = new URL(repo).protocol;
    return protocol === 'https:' ? 'https' : protocol === 'http:' ? 'http' : null;
  } catch {
    return null;
  }
}

function checkNamespace(
  input: HelmResolveInput,
  namespace: string | undefined,
  error: ReportError,
  diagnostics: Diagnostic[],
  at: (field: string) => string,
): string {
  if (namespace === undefined) return input.stackNamespace;
  if (!DNS_LABEL_RE.test(namespace)) {
    error('helm.namespace-invalid', 'namespace', `namespace "${namespace}" is not a valid Kubernetes namespace name`, 'Use lowercase letters, digits and hyphens (at most 63 characters).');
  } else if (RESERVED_NAMESPACES.has(namespace) || (namespace.startsWith(RESERVED_NAME_PREFIX) && namespace !== input.stackNamespace)) {
    error('helm.namespace-reserved', 'namespace', `namespace "${namespace}" is reserved`, 'Omit `namespace` to use the stack namespace, or choose another name.');
  } else if (namespace === 'kube-system') {
    diagnostics.push({
      severity: 'warning',
      code: 'helm.namespace-kube-system',
      path: at('namespace'),
      message: "the release shares kube-system with the cluster's own components",
    });
  }
  return namespace;
}

/** ms within 30s..1h, else null */
function timeoutMs(text: string): number | null {
  const ms = parseDurationMs(text);
  return typeof ms === 'number' && ms >= TIMEOUT_MIN_MS && ms <= TIMEOUT_MAX_MS ? ms : null;
}

function timeoutDiagnostic(path: string): Diagnostic {
  return { severity: 'error', code: 'helm.timeout-range', path, message: 'timeout must be between 30s and 1h' };
}

function readValuesFile(input: HelmResolveInput, file: string, path: string, diagnostics: Diagnostic[]): Record<string, unknown> | null {
  const error = (code: string, message: string, hint?: string): null => {
    diagnostics.push(hint === undefined ? { severity: 'error', code, path, message } : { severity: 'error', code, path, message, hint });
    return null;
  };
  const outside = (): null => error('helm.values-file-outside', `values file ${file} must be a path inside the project`);
  const unrendered = (): null => error('helm.values-file-unrendered', M.valuesFileUnrendered(file), 'Move it under .dockflow/, or list it in `templates:`.');

  const normalized = normalizeProjectPath(file);
  if (normalized === null) return outside();
  if (!isRenderedPath(normalized, input.templates)) return unrendered();
  const lookup = input.readValuesFile(normalized);
  if (lookup.kind === 'missing') {
    return error('helm.values-file-missing', `values file ${file} not found`, 'Put it under .dockflow/ (it is then rendered with Nunjucks), or check the path.');
  }
  if (lookup.kind === 'outside-project') return outside();
  if (!lookup.rendered) return unrendered();
  const parsed: HelmValuesResult = parseHelmValues(lookup.text, { path, file });
  diagnostics.push(...parsed.diagnostics);
  return parsed.diagnostics.some((d) => d.severity === 'error') ? null : parsed.values;
}

/** POSIX-normalized project-relative path, the key format of the rendered map; null when absolute or escaping the project root */
export function normalizeProjectPath(file: string): string | null {
  const slashed = file.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = posix.normalize(slashed);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** What the Redactor must know of some releases: string leaves under a sensitive key path, chart repository passwords. */
export function helmRedactions(releases: readonly { values: Record<string, unknown>; auth?: ResolvedHelmRelease['auth'] }[]): string[] {
  const out = new Set<string>();
  for (const release of releases) {
    collectSensitive(release.values, '', out);
    if (release.auth) out.add(release.auth.password);
  }
  return [...out];
}

function collectSensitive(value: unknown, keyPath: string, out: Set<string>): void {
  if (typeof value === 'string') {
    if (keyPath !== '' && isSensitiveKeyPath(keyPath)) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectSensitive(item, `${keyPath}[${i}]`, out));
  } else if (isValuesMap(value)) {
    for (const key of Object.keys(value)) collectSensitive(value[key], joinKeyPath(keyPath, key), out);
  }
}

// ---------------------------------------------------------------------------
// Rendered map, records, spec hash
// ---------------------------------------------------------------------------

/** `readValuesFile` over the rendered map, the only source deploy and validate use (3.4.1). */
export function renderedValuesFileLookup(rendered: ReadonlyMap<string, string>): (path: string) => ValuesFileLookup {
  return (path) => {
    const text = rendered.get(path);
    return text === undefined ? { kind: 'missing' } : { kind: 'found', text, rendered: true };
  };
}

/** What `artifact.helm` stores: no credentials, and the pinned archive digest (3.4.4). */
export function helmReleaseRecord(release: ResolvedHelmRelease): HelmReleaseRecord {
  return {
    name: release.name,
    role: release.role,
    namespace: release.namespace,
    chart: structuredClone(release.chart),
    version: release.version,
    values: structuredClone(release.values),
    valuesSha256: release.valuesSha256,
    timeoutS: release.timeoutS,
    chartSha256: release.declaredDigest,
  };
}

/**
 * 32 hex, the Helm release label `P/spec-hash` the skip predicate selects on (PD-3). The full
 * 64-hex checksums live in Dockflow's release record only: a label value holds 63 characters.
 */
export function helmSpecHash(release: Pick<HelmReleaseRecord, 'name' | 'namespace' | 'role' | 'chart' | 'version' | 'values'>): string {
  const spec = {
    chart: release.chart,
    name: release.name,
    namespace: release.namespace,
    role: release.role,
    values: release.values,
    version: release.version.replace(/^v/, ''),
  };
  return sha256Hex(canonicalJson(spec)).slice(0, 32);
}

/**
 * The app releases `--only` records (3.4.5, I18): a release this deploy does not target keeps the
 * record of what is running, never the config values, so a later rollback restores what ran.
 * `resolved` is the releases of this role from config.yml; `targeted` is --only (empty = full deploy).
 */
export function syncNonTargetedHelmRecords(
  resolved: ResolvedHelmRelease[],
  previous: HelmReleaseRecord[] | null,
  targeted: string[],
): ResolvedHelmRelease[] {
  if (targeted.length === 0) return resolved;
  const targets = new Set(targeted);
  const records = new Map((previous ?? []).map((record) => [record.name, record]));
  const out: ResolvedHelmRelease[] = [];
  for (const release of resolved) {
    if (targets.has(release.name)) {
      out.push(release);
      continue;
    }
    const record = records.get(release.name);
    if (record) out.push(fromRecord(record, release.auth));
  }
  const declared = new Set(resolved.map((release) => release.name));
  // --only never removes: a release dropped from config keeps running and stays recorded
  for (const record of previous ?? []) {
    if (!declared.has(record.name)) out.push(fromRecord(record, null));
  }
  return out;
}

function fromRecord(record: HelmReleaseRecord, auth: ResolvedHelmRelease['auth']): ResolvedHelmRelease {
  return {
    name: record.name,
    role: record.role,
    namespace: record.namespace,
    chart: structuredClone(record.chart),
    version: record.version,
    values: structuredClone(record.values),
    valuesSha256: record.valuesSha256,
    timeoutS: record.timeoutS,
    auth,
    declaredDigest: record.chartSha256,
  };
}

/** "postgresql 16.7.4 from https://charts.example.org", "oci://registry.example.com/charts/search 2.4.1" */
export function chartDisplay(chart: HelmChartSource, version: string): string {
  return chart.kind === 'oci' ? `${chart.ref} ${version}` : `${chart.chart} ${version} from ${chart.repo}`;
}

// ---------------------------------------------------------------------------
// --only and --adopt names (design-04 3.3, checked by deploy before the lock)
// ---------------------------------------------------------------------------

/** `--only` accepts compose services of the application and app Helm releases. */
export function checkOnlyNames(names: string[], composeServices: string[], helm: HelmConfig | undefined): void {
  const releases = helm?.releases ?? [];
  const appReleases = releases.filter((r) => (r.role ?? 'app') === 'app').map((r) => r.name);
  const accessories = new Set(releases.filter((r) => r.role === 'accessory').map((r) => r.name));
  const known = new Set([...composeServices, ...appReleases]);

  const accessory = names.find((name) => !known.has(name) && accessories.has(name));
  if (accessory !== undefined) {
    throw new ValidationError(
      `${accessory} is an accessory Helm release; --only targets the application`,
      'Deploy accessories with `dockflow deploy <env> --accessories`.',
    );
  }
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const list = (items: string[]): string => (items.length > 0 ? items.join(', ') : 'none');
    throw new ValidationError(
      `Unknown service or Helm release ${unknown.join(', ')} (services: ${list(composeServices)}; Helm releases: ${list(appReleases)})`,
      'Use exact compose service or Helm release names.',
    );
  }
}

/** `--adopt` names a release declared in config.yml, never Dockflow's own proxy. */
export function checkAdoptNames(names: string[], helm: HelmConfig | undefined): void {
  if (names.includes(K8S_PROXY_RELEASE)) {
    throw new ValidationError(
      `${K8S_PROXY_RELEASE} is Dockflow's own proxy release and is never adopted`,
      'Remove it from `--adopt`; the proxy follows `proxy.*` settings (`dockflow helm status <env> --system`).',
    );
  }
  const declared = new Set((helm?.releases ?? []).map((release) => release.name));
  const unknown = names.find((name) => !declared.has(name));
  if (unknown !== undefined) {
    throw new ValidationError(
      `--adopt names ${unknown}, which is not a Helm release declared in config.yml`,
      `Declare the release in \`helm.releases\` with the chart and version that are running, then re-run with \`--adopt ${unknown}\`.`,
    );
  }
}
