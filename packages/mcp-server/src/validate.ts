import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { M } from './shared/messages.js';

// The rules are `dockflow validate`'s (cli/src/schemas), no more and no less, so this tool never
// rejects a file the CLI accepts. Every message the CLI catalogue covers comes from
// ./shared/messages.js, a generated copy of it (cli/scripts/sync-mcp-messages.ts).

export type Orchestrator = 'swarm' | 'k3s';
export type ConfigFileType = 'root' | 'config' | 'servers';

export interface ValidateOptions {
  /** Orchestrator of a servers.yml validated alone; config.yml and dockflow.yml carry their own */
  orchestrator?: Orchestrator;
}

export interface ValidationResult {
  valid: boolean;
  /** One `<path>: <message>` line per issue, in path order */
  errors: string[];
  /** Lines shown after a valid result */
  notes: string[];
}

export const FILE_NAMES: Record<ConfigFileType, string> = {
  root: 'dockflow.yml',
  config: 'config.yml',
  servers: 'servers.yml',
};

export const K3S_NOTE =
  'Note: docker-compose.yml and accessories.yml are checked for Kubernetes with "dockflow validate <env>" (offline).';

/** What a Nunjucks expression stands for: the CLI renders templates before it validates. */
export const TEMPLATE_PLACEHOLDER = 'dockflow-template-value';
const TEMPLATE_EXPRESSION = /\{\{.*?\}\}/g;

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const DURATION_RE = /^([0-9]+(\.[0-9]+)?(ms|s|m|h))+$/;
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const EXACT_SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const CHART_DIGEST_RE = /^[a-f0-9]{64}$/;
const LABEL_KEY_RE =
  /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE_RE = /^(([A-Za-z0-9][-A-Za-z0-9_.]{0,61})?[A-Za-z0-9])?$/;
const KUBERNETES_LABEL_KEY_RE = /(^|\.)(kubernetes\.io|k8s\.io)\//;
const DOCKFLOW_LABEL_PREFIX = 'dockflow.shawiizz.dev/';

const HELM_KEYS = ['timeout', 'releases'];
const HELM_RELEASE_KEYS = [
  'name', 'chart', 'repo', 'version', 'digest', 'role', 'namespace', 'values', 'values_files', 'timeout', 'auth',
];
const K3S_ONLY_PROXY_KEYS = ['manage', 'acme_ca_server', 'acme_ca_bundle', 'default_ingress_class'] as const;
const REGISTRY_TYPES = ['local', 'dockerhub', 'ghcr', 'gitlab', 'custom'];

const IpSchema = z.union([z.ipv4(), z.ipv6()]);
const Ipv6Schema = z.ipv6();

type Segment = string | number;
type Doc = Record<string, unknown>;

interface Issue {
  path: Segment[];
  message: string;
  /** The message already names its location (the k3s topology messages start with it) */
  located: boolean;
}

class Issues {
  readonly list: Issue[] = [];

  add(path: Segment[], message: string): void {
    this.list.push({ path, message, located: false });
  }

  addLocated(path: Segment[], message: string): void {
    this.list.push({ path, message, located: true });
  }
}

function isMap(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The CLI's path notation: `helm.releases[0].name`, `root` for the document itself */
function formatPath(path: Segment[]): string {
  if (path.length === 0) return 'root';
  return path.map((segment, i) => (typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`)).join('');
}

function comparePaths(a: Segment[], b: Segment[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function finish(issues: Issues, orchestrator: Orchestrator | undefined): ValidationResult {
  const ordered = [...issues.list].sort((a, b) => comparePaths(a.path, b.path));
  const errors = [...new Set(ordered.map((i) => (i.located ? i.message : `${formatPath(i.path)}: ${i.message}`)))];
  const valid = errors.length === 0;
  return { valid, errors, notes: valid && orchestrator === 'k3s' ? [K3S_NOTE] : [] };
}

function failure(message: string): ValidationResult {
  return { valid: false, errors: [message], notes: [] };
}

/** Replaces every `{{ ... }}` expression with a plain placeholder so the document parses as YAML */
export function stubTemplates(content: string): string {
  return content.replace(TEMPLATE_EXPRESSION, TEMPLATE_PLACEHOLDER);
}

function parseDocument(content: string): Doc | string {
  let parsed: unknown;
  try {
    parsed = parseYaml(stubTemplates(content));
  } catch (e) {
    return `YAML parse error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return isMap(parsed) ? parsed : 'Root must be a YAML object';
}

function unknownKeys(value: Doc, allowed: readonly string[], path: Segment[], issues: Issues): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return;
  const names = extra.map((key) => `"${key}"`).join(', ');
  issues.add(path, extra.length === 1 ? `Unrecognized key: ${names}` : `Unrecognized keys: ${names}`);
}

function normalizeProjectPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, '/'));
}

/** Only files under .dockflow/ and `templates` destinations are rendered, so only they can be read */
function isRenderedPath(path: string, templates: unknown): boolean {
  const target = normalizeProjectPath(path);
  if (target.startsWith('.dockflow/')) return true;
  if (!Array.isArray(templates)) return false;
  return templates.some((entry) => {
    const dest = typeof entry === 'string' ? entry : isMap(entry) && typeof entry.dest === 'string' ? entry.dest : null;
    return dest !== null && normalizeProjectPath(dest) === target;
  });
}

function isHttpsUrl(value: string, protocols: readonly string[]): boolean {
  try {
    const url = new URL(value.trim());
    return protocols.includes(url.protocol.replace(/:$/, ''));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// config.yml

/** The orchestrator the file declares; `swarm` when absent (the CLI default), undefined when invalid */
function checkConfig(doc: Doc, issues: Issues): Orchestrator | undefined {
  const name = doc.project_name;
  if (name === undefined || name === null || name === '') {
    issues.add(['project_name'], 'Project name is required');
  } else if (typeof name !== 'string') {
    issues.add(['project_name'], 'must be a string');
  } else if (name.length > 63) {
    issues.add(['project_name'], 'Project name must be 63 characters or less (DNS label limit)');
  } else if (!PROJECT_NAME_RE.test(name)) {
    issues.add(
      ['project_name'],
      'Project name must contain only lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.',
    );
  }

  let orchestrator: Orchestrator | undefined = 'swarm';
  if (doc.orchestrator !== undefined) {
    if (doc.orchestrator === 'swarm' || doc.orchestrator === 'k3s') {
      orchestrator = doc.orchestrator;
    } else {
      issues.add(['orchestrator'], 'must be "swarm" or "k3s"');
      orchestrator = undefined;
    }
  }

  if (doc.container_engine !== undefined && doc.container_engine !== 'docker' && doc.container_engine !== 'podman') {
    issues.add(['container_engine'], 'must be "docker" or "podman"');
  }

  checkRegistry(doc.registry, issues);
  checkOptions(doc.options, orchestrator, issues);
  checkProxy(doc.proxy, orchestrator, doc.templates, issues);
  checkHelm(doc.helm, orchestrator, doc.templates, issues);
  return orchestrator;
}

function checkRegistry(registry: unknown, issues: Issues): void {
  if (registry === undefined) return;
  if (!isMap(registry)) {
    issues.add(['registry'], 'must be an object');
    return;
  }
  if (registry.type === undefined) {
    issues.add(['registry', 'type'], 'required');
  } else if (typeof registry.type !== 'string' || !REGISTRY_TYPES.includes(registry.type)) {
    issues.add(['registry', 'type'], `must be one of ${REGISTRY_TYPES.join(', ')}`);
  } else if (registry.type === 'custom' && !registry.url) {
    issues.add(['registry'], 'Custom registry type requires a URL');
  }
}

function checkOptions(options: unknown, orchestrator: Orchestrator | undefined, issues: Issues): void {
  if (options === undefined) return;
  if (!isMap(options)) {
    issues.add(['options'], 'must be an object');
    return;
  }
  const remoteBuild = options.remote_build;
  if (remoteBuild !== undefined && typeof remoteBuild !== 'boolean') {
    issues.add(['options', 'remote_build'], 'must be true or false');
  }
  if (orchestrator === 'k3s' && remoteBuild === true) issues.add(['options', 'remote_build'], M.remoteBuildK3s);
}

function checkProxy(proxy: unknown, orchestrator: Orchestrator | undefined, templates: unknown, issues: Issues): void {
  if (proxy === undefined) return;
  if (!isMap(proxy)) {
    issues.add(['proxy'], 'must be an object');
    return;
  }
  const at = (key: string): Segment[] => ['proxy', key];

  for (const key of ['enabled', 'acme', 'manage', 'default_ingress_class']) {
    if (proxy[key] !== undefined && typeof proxy[key] !== 'boolean') issues.add(at(key), 'must be true or false');
  }

  if (proxy.manage === false && proxy.enabled !== true) issues.add(at('manage'), M.proxyManageNeedsEnabled);

  const server = proxy.acme_ca_server;
  if (server !== undefined && (typeof server !== 'string' || !isHttpsUrl(server, ['https']))) {
    issues.add(at('acme_ca_server'), M.acmeCaServerHttps);
  }
  const bundle = proxy.acme_ca_bundle;
  if (bundle !== undefined && (typeof bundle !== 'string' || bundle === '')) {
    issues.add(at('acme_ca_bundle'), M.acmeCaBundlePath);
  }
  if (proxy.acme === false) {
    for (const key of ['acme_ca_server', 'acme_ca_bundle']) {
      if (proxy[key] !== undefined) issues.add(at(key), M.acmeCaNeedsAcme);
    }
  }
  if (bundle !== undefined && server === undefined) issues.add(at('acme_ca_bundle'), M.acmeCaBundleNeedsServer);
  if (typeof bundle === 'string' && bundle !== '' && !isRenderedPath(bundle, templates)) {
    issues.add(at('acme_ca_bundle'), M.acmeCaBundleUnrendered(bundle));
  }

  if (orchestrator === 'swarm') {
    // Only values that differ from the defaults: Swarm's Traefik has no such setting
    const written: Record<(typeof K3S_ONLY_PROXY_KEYS)[number], boolean> = {
      manage: proxy.manage === false,
      acme_ca_server: server !== undefined,
      acme_ca_bundle: bundle !== undefined,
      default_ingress_class: proxy.default_ingress_class === true,
    };
    for (const key of K3S_ONLY_PROXY_KEYS) {
      if (written[key]) issues.add(at(key), M.proxyKeyRequiresK3s(`proxy.${key}`));
    }
  }

  const dashboard = proxy.dashboard;
  if (isMap(dashboard) && dashboard.enabled === true && !dashboard.domain) {
    issues.add(['proxy', 'dashboard'], 'proxy.dashboard.domain is required when proxy.dashboard.enabled is true');
  }
}

function checkHelm(helm: unknown, orchestrator: Orchestrator | undefined, templates: unknown, issues: Issues): void {
  if (helm === undefined) return;
  if (orchestrator === 'swarm') issues.add(['helm'], M.helmRequiresK3s);
  if (!isMap(helm)) {
    issues.add(['helm'], 'must be an object');
    return;
  }
  unknownKeys(helm, HELM_KEYS, ['helm'], issues);
  if (helm.timeout !== undefined && (typeof helm.timeout !== 'string' || !DURATION_RE.test(helm.timeout))) {
    issues.add(['helm', 'timeout'], M.duration);
  }
  if (helm.releases === undefined) return;
  if (!Array.isArray(helm.releases)) {
    issues.add(['helm', 'releases'], 'must be a list');
    return;
  }

  const seen = new Set<string>();
  helm.releases.forEach((release: unknown, i: number) => {
    const at = (...rest: Segment[]): Segment[] => ['helm', 'releases', i, ...rest];
    if (!isMap(release)) {
      issues.add(at(), 'must be an object');
      return;
    }
    unknownKeys(release, HELM_RELEASE_KEYS, at(), issues);
    checkRelease(release, at, templates, issues);

    if (typeof release.name === 'string') {
      if (seen.has(release.name)) issues.add(at('name'), M.helmDuplicateName(release.name));
      seen.add(release.name);
    }
    if (typeof release.chart === 'string') {
      const oci = release.chart.startsWith('oci://');
      if (oci && release.repo !== undefined) issues.add(at('repo'), M.helmRepoWithOci);
      if (!oci && release.repo === undefined) issues.add(at('repo'), M.helmRepoRequired);
    }
  });
}

function checkRelease(release: Doc, at: (...rest: Segment[]) => Segment[], templates: unknown, issues: Issues): void {
  const { name, chart, repo, version, digest, role, namespace, values, timeout, auth } = release;

  if (name === undefined) {
    issues.add(at('name'), 'required');
  } else if (typeof name !== 'string') {
    issues.add(at('name'), M.helmName);
  } else {
    if (name.length > 53) issues.add(at('name'), M.helmNameTooLong);
    if (!DNS_LABEL_RE.test(name)) issues.add(at('name'), M.helmName);
  }

  if (chart === undefined) issues.add(at('chart'), 'required');
  else if (typeof chart !== 'string' || chart === '') issues.add(at('chart'), M.helmChart);

  if (repo !== undefined && (typeof repo !== 'string' || !isHttpsUrl(repo, ['http', 'https']))) {
    issues.add(at('repo'), M.helmRepoUrl);
  }
  if (typeof version !== 'string' || !EXACT_SEMVER_RE.test(version)) issues.add(at('version'), M.exactVersion);
  if (digest !== undefined && (typeof digest !== 'string' || !CHART_DIGEST_RE.test(digest))) {
    issues.add(at('digest'), M.chartDigest);
  }
  if (role !== undefined && role !== 'app' && role !== 'accessory') issues.add(at('role'), 'must be "app" or "accessory"');
  if (namespace !== undefined && (typeof namespace !== 'string' || namespace.length > 63 || !DNS_LABEL_RE.test(namespace))) {
    issues.add(at('namespace'), M.namespaceLabel);
  }
  if (values !== undefined && !isMap(values)) issues.add(at('values'), 'must be a map of chart values');

  const files = release.values_files;
  if (files !== undefined && !Array.isArray(files)) {
    issues.add(at('values_files'), 'must be a list');
  } else if (Array.isArray(files)) {
    files.forEach((file: unknown, j: number) => {
      if (typeof file !== 'string' || file === '') issues.add(at('values_files', j), M.valuesFilePath);
      else if (!isRenderedPath(file, templates)) issues.add(at('values_files', j), M.valuesFileUnrendered(file));
    });
  }

  if (timeout !== undefined && (typeof timeout !== 'string' || !DURATION_RE.test(timeout))) {
    issues.add(at('timeout'), M.duration);
  }
  if (auth !== undefined) {
    if (!isMap(auth)) {
      issues.add(at('auth'), 'must be an object with username and password');
    } else {
      for (const field of ['username', 'password']) {
        const value = auth[field];
        if (typeof value !== 'string' || value === '') issues.add(at('auth', field), M.helmAuthField);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// servers.yml

interface TopologyServer {
  role: unknown;
  host: unknown;
  private_host: unknown;
  tags: string[];
}

/** The generic servers.yml rules; returns the servers the k3s topology rules can read. */
function checkServers(servers: unknown, issues: Issues): Map<string, TopologyServer> {
  const topology = new Map<string, TopologyServer>();
  if (!isMap(servers)) {
    issues.add(['servers'], 'must be a map of server names to servers');
    return topology;
  }
  if (Object.keys(servers).length === 0) {
    issues.add(['servers'], 'At least one server must be defined');
    return topology;
  }

  const tagsWithManager = new Set<string>();
  const allTags: string[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const at = (...rest: Segment[]): Segment[] => ['servers', name, ...rest];
    if (name.length > 63) issues.add(at(), 'Server name must be 63 characters or less');
    else if (!SERVER_NAME_RE.test(name)) issues.add(at(), 'Server name must be lowercase alphanumeric with hyphens or underscores');
    if (!isMap(raw)) {
      issues.add(at(), 'must be an object');
      continue;
    }

    if (raw.role !== undefined && raw.role !== 'manager' && raw.role !== 'worker') {
      issues.add(at('role'), 'must be "manager" or "worker"');
    }
    if (raw.host !== undefined && typeof raw.host !== 'string') issues.add(at('host'), 'must be a string');
    checkSshFields(raw, at, issues);
    if (raw.private_host !== undefined && !IpSchema.safeParse(raw.private_host).success) {
      issues.add(at('private_host'), M.privateHostIp);
    }
    checkNodeLabels(raw.node_labels, at, issues);

    const tags = checkTags(raw.tags, at, issues);
    if (tags === null) continue;
    for (const tag of tags) {
      if (!allTags.includes(tag)) allTags.push(tag);
      if ((raw.role ?? 'manager') === 'manager') tagsWithManager.add(tag);
    }
    topology.set(name, { role: raw.role, host: raw.host, private_host: raw.private_host, tags });
  }

  for (const tag of allTags) {
    if (!tagsWithManager.has(tag)) issues.add(['servers'], `tag "${tag}" has no manager server`);
  }
  return topology;
}

/** `user` and `port` of a server or of `defaults` */
function checkSshFields(value: Doc, at: (...rest: Segment[]) => Segment[], issues: Issues): void {
  const { user, port } = value;
  if (user !== undefined && (typeof user !== 'string' || user.length < 1 || user.length > 32)) {
    issues.add(at('user'), 'must be a user name of 1 to 32 characters');
  }
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    issues.add(at('port'), 'must be an integer between 1 and 65535');
  }
}

function checkDefaults(defaults: unknown, issues: Issues): void {
  if (defaults === undefined) return;
  if (!isMap(defaults)) {
    issues.add(['defaults'], 'must be an object');
    return;
  }
  checkSshFields(defaults, (...rest) => ['defaults', ...rest], issues);
}

/** The server's tags when they are a list of strings, whatever their format */
function checkTags(tags: unknown, at: (...rest: Segment[]) => Segment[], issues: Issues): string[] | null {
  if (!Array.isArray(tags)) {
    issues.add(at('tags'), 'required, must be a non-empty list of environment tags');
    return null;
  }
  if (tags.length === 0) issues.add(at('tags'), 'At least one tag is required');
  tags.forEach((tag: unknown, i: number) => {
    if (typeof tag !== 'string') issues.add(at('tags', i), 'must be a string');
    else if (tag === '') issues.add(at('tags', i), 'Tag cannot be empty');
    else if (tag.length > 50) issues.add(at('tags', i), 'Tag must be 50 characters or less');
    else if (!TAG_RE.test(tag)) issues.add(at('tags', i), 'Tags must be lowercase alphanumeric with hyphens');
  });
  return tags.filter((tag): tag is string => typeof tag === 'string');
}

function checkNodeLabels(labels: unknown, at: (...rest: Segment[]) => Segment[], issues: Issues): void {
  if (labels === undefined) return;
  if (!isMap(labels)) {
    issues.add(at('node_labels'), 'must be a map of label keys to values');
    return;
  }
  for (const [key, value] of Object.entries(labels)) {
    // One message per key, the first rule it breaks, as the CLI reports it
    if (key.length > 253) issues.add(at('node_labels', key), M.labelKeyTooLong);
    else if (!LABEL_KEY_RE.test(key)) issues.add(at('node_labels', key), M.labelKey);
    else if (KUBERNETES_LABEL_KEY_RE.test(key) || key.startsWith(DOCKFLOW_LABEL_PREFIX)) {
      issues.add(at('node_labels', key), M.labelKeyReserved);
    }

    if (typeof value === 'string' && value.length > 63) issues.add(at('node_labels', key), M.labelValueTooLong);
    else if (typeof value !== 'string' || !LABEL_VALUE_RE.test(value)) issues.add(at('node_labels', key), M.labelValue);
  }
}

/** Kubernetes node name of a servers.yml key (the CLI's nodeNameFor) */
function nodeNameFor(key: string): string {
  return key.toLowerCase().replace(/_/g, '-');
}

/**
 * The k3s rules that need no node, enforced by `dockflow setup` and `dockflow validate <env>` for
 * each environment; here for every tag of the file at once.
 */
function checkTopology(servers: Map<string, TopologyServer>, issues: Issues): void {
  const tags = [...new Set([...servers.values()].flatMap((server) => server.tags))];
  for (const tag of tags) {
    const members = [...servers].filter(([, server]) => server.tags.includes(tag));

    // An embedded-etcd cluster of 2n members tolerates no more failures than one of 2n - 1
    const managers = members.filter(([, server]) => (server.role ?? 'manager') === 'manager').length;
    if (managers >= 2 && managers % 2 === 0) issues.addLocated(['servers'], M.managerCount(tag, managers));

    const owners = new Map<string, string>();
    for (const [key] of members) {
      const node = nodeNameFor(key);
      const owner = owners.get(node);
      if (owner === undefined) owners.set(node, key);
      else issues.addLocated(['servers', key], M.duplicateNode(owner, key, node));
    }
  }

  for (const [key, server] of servers) {
    if (server.tags.length === 0) continue;
    const field = server.private_host !== undefined ? 'private_host' : 'host';
    const address = server[field];
    if (typeof address === 'string' && Ipv6Schema.safeParse(address).success) {
      issues.addLocated(['servers', key, field], M.privateHostIpv6K3s(key));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** Validates a config.yml, or a dockflow.yml when the content has a `servers` block. */
export function validateConfig(content: string): ValidationResult {
  const doc = parseDocument(content);
  if (typeof doc === 'string') return failure(doc);

  const issues = new Issues();
  const orchestrator = checkConfig(doc, issues);
  if (doc.servers !== undefined) {
    const servers = checkServers(doc.servers, issues);
    checkDefaults(doc.defaults, issues);
    if (orchestrator === 'k3s') checkTopology(servers, issues);
  }
  return finish(issues, orchestrator);
}

/** Validates a servers.yml; the k3s rules apply only when the orchestrator is given. */
export function validateServersOnly(content: string, options: ValidateOptions = {}): ValidationResult {
  const doc = parseDocument(content);
  if (typeof doc === 'string') return failure(doc);

  const issues = new Issues();
  if (doc.servers === undefined || doc.servers === null) {
    issues.add(['servers'], 'required');
  } else {
    const servers = checkServers(doc.servers, issues);
    if (options.orchestrator === 'k3s') checkTopology(servers, issues);
  }
  checkDefaults(doc.defaults, issues);
  return finish(issues, options.orchestrator);
}

/** `root` for a dockflow.yml, `servers` for a servers.yml, `config` otherwise */
export function detectFileType(content: string): ConfigFileType {
  const doc = parseDocument(content);
  if (typeof doc === 'string') return 'config';
  if (doc.servers !== undefined && doc.project_name !== undefined) return 'root';
  if (doc.servers !== undefined) return 'servers';
  return 'config';
}

export function validateFile(content: string, type: ConfigFileType, options: ValidateOptions = {}): ValidationResult {
  return type === 'servers' ? validateServersOnly(content, options) : validateConfig(content);
}

export function formatValidationResult(result: ValidationResult, filename: string): string {
  if (result.valid) return [`✓ ${filename} is valid.`, ...result.notes].join('\n');
  const lines = [`✗ ${filename} has ${result.errors.length} error(s):\n`];
  for (const error of result.errors) lines.push(`  → ${error}`);
  return lines.join('\n');
}
