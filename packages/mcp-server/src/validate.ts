import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// The rules are the ones `dockflow validate` applies (cli/src/schemas): this tool must never refuse
// a file the CLI accepts, nor accept one it refuses. test-corpus/configs.yaml holds the files both
// validators are checked against.

export type ConfigFileType = 'root' | 'config' | 'servers';

export interface ValidationResult {
  valid: boolean;
  /** One `<path>: <message>` line per issue, in path order */
  errors: string[];
}

export const FILE_NAMES: Record<ConfigFileType, string> = {
  root: 'dockflow.yml',
  config: 'config.yml',
  servers: 'servers.yml',
};

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const ENV_VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^(?=.*:)[0-9a-fA-F:.]+$/;
const HOST_NAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ROUTE_PATH_RE = /^\/[^\s`$]*$/;
const PORT_SPEC_RE = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/i;

const REGISTRY_TYPES = ['local', 'dockerhub', 'ghcr', 'gitlab', 'custom'];

const PORT_MESSAGE =
  'must be a port or a range within 1-65535, with /tcp or /udp when needed: 443, 51820/udp, 8000-8010/tcp';
const IP_MESSAGE = 'must be an IP address or a CIDR range, e.g. 173.245.48.0/20';

type Segment = string | number;
type Path = Segment[];
type Doc = Record<string, unknown>;

class Issues {
  readonly list: Array<{ path: Path; message: string }> = [];

  add(path: Path, message: string): void {
    this.list.push({ path, message });
  }
}

function isMap(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The CLI's notation: `proxy.routes[0].service`, `root` for the document itself */
function formatPath(path: Path): string {
  if (path.length === 0) return 'root';
  return path.map((segment, i) => (typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`)).join('');
}

function comparePaths(a: Path, b: Path): number {
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

function finish(issues: Issues): ValidationResult {
  const ordered = [...issues.list].sort((a, b) => comparePaths(a.path, b.path));
  const errors = [...new Set(ordered.map((issue) => `${formatPath(issue.path)}: ${issue.message}`))];
  return { valid: errors.length === 0, errors };
}

function parseDocument(content: string): Doc | string {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    return `YAML parse error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return isMap(parsed) ? parsed : 'Root must be a YAML object';
}

function run(content: string, check: (doc: Doc, issues: Issues) => void): ValidationResult {
  const doc = parseDocument(content);
  if (typeof doc === 'string') return { valid: false, errors: [doc] };
  const issues = new Issues();
  check(doc, issues);
  return finish(issues);
}

function checkString(doc: Doc, key: string, path: Path, issues: Issues): void {
  if (doc[key] !== undefined && typeof doc[key] !== 'string') issues.add([...path, key], 'must be a string');
}

function checkBoolean(doc: Doc, key: string, path: Path, issues: Issues): void {
  if (doc[key] !== undefined && typeof doc[key] !== 'boolean') issues.add([...path, key], 'must be true or false');
}

function isPort(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function checkPort(doc: Doc, path: Path, issues: Issues): void {
  if (doc.port !== undefined && !isPort(doc.port)) issues.add([...path, 'port'], 'must be an integer between 1 and 65535');
}

function checkUser(doc: Doc, path: Path, issues: Issues): void {
  const { user } = doc;
  if (user !== undefined && (typeof user !== 'string' || user.length < 1 || user.length > 32)) {
    issues.add([...path, 'user'], 'must be a user name of 1 to 32 characters');
  }
}

/** An IPv4 or IPv6 address, or a CIDR range of one */
function isIpOrCidr(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [address = '', prefix, extra] = value.split('/');
  if (extra !== undefined) return false;
  const v4 = IPV4_RE.test(address);
  if (!v4 && !(IPV6_RE.test(address) && address.split('::').length <= 2)) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128);
}

function isPortSpec(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const match = PORT_SPEC_RE.exec(String(value).trim());
  if (!match) return false;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  return from >= 1 && to <= 65535 && from <= to;
}

function checkIpList(value: unknown, path: Path, issues: Issues): void {
  if (!Array.isArray(value)) {
    issues.add(path, 'must be a list of addresses');
    return;
  }
  value.forEach((item: unknown, i: number) => {
    if (!isIpOrCidr(item)) issues.add([...path, i], IP_MESSAGE);
  });
}

// ---------------------------------------------------------------------------------------------
// config.yml

function checkConfig(doc: Doc, issues: Issues): void {
  checkProjectName(doc.project_name, issues);
  if (doc.container_engine !== undefined && doc.container_engine !== 'docker' && doc.container_engine !== 'podman') {
    issues.add(['container_engine'], 'must be "docker" or "podman"');
  }
  checkRegistry(doc.registry, issues);
  checkProxy(doc.proxy, issues);
  checkFirewall(doc.firewall, issues);
}

function checkProjectName(name: unknown, issues: Issues): void {
  if (name === undefined || name === null) {
    issues.add(['project_name'], 'required');
  } else if (typeof name !== 'string') {
    issues.add(['project_name'], 'must be a string');
  } else {
    if (name.length < 1) issues.add(['project_name'], 'Project name is required');
    if (name.length > 63) issues.add(['project_name'], 'Project name must be 63 characters or less (DNS label limit)');
    if (!PROJECT_NAME_RE.test(name)) {
      issues.add(
        ['project_name'],
        'Project name must contain only lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.',
      );
    }
  }
}

function checkRegistry(registry: unknown, issues: Issues): void {
  if (registry === undefined) return;
  if (!isMap(registry)) {
    issues.add(['registry'], 'must be an object');
    return;
  }
  const path: Path = ['registry'];
  if (registry.type === undefined) {
    issues.add(['registry', 'type'], 'required');
  } else if (typeof registry.type !== 'string' || !REGISTRY_TYPES.includes(registry.type)) {
    issues.add(['registry', 'type'], `must be one of ${REGISTRY_TYPES.join(', ')}`);
  }
  for (const key of ['url', 'username', 'password', 'namespace', 'token']) checkString(registry, key, path, issues);
  checkBoolean(registry, 'enabled', path, issues);
  const tags = registry.additional_tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== 'string'))) {
    issues.add(['registry', 'additional_tags'], 'must be a list of strings');
  }
  if (registry.type === 'custom' && !registry.url) issues.add(['registry'], 'Custom registry type requires a URL');
}

function checkDomainMap(value: unknown, path: Path, issues: Issues, rule?: (domain: string) => boolean, message?: string): void {
  if (!isMap(value)) {
    issues.add(path, 'must be a map of environments to domains');
    return;
  }
  for (const [env, domain] of Object.entries(value)) {
    if (typeof domain !== 'string') issues.add([...path, env], 'must be a string');
    else if (rule && !rule(domain)) issues.add([...path, env], message ?? 'is not valid');
  }
}

function checkProxy(proxy: unknown, issues: Issues): void {
  if (proxy === undefined) return;
  if (!isMap(proxy)) {
    issues.add(['proxy'], 'must be an object');
    return;
  }
  const path: Path = ['proxy'];
  checkBoolean(proxy, 'enabled', path, issues);
  checkBoolean(proxy, 'acme', path, issues);
  if (proxy.email !== undefined && (typeof proxy.email !== 'string' || !z.email().safeParse(proxy.email).success)) {
    issues.add(['proxy', 'email'], 'must be an email address');
  }
  if (proxy.domains !== undefined) checkDomainMap(proxy.domains, ['proxy', 'domains'], issues);

  const dashboard = proxy.dashboard;
  if (dashboard !== undefined) {
    if (!isMap(dashboard)) {
      issues.add(['proxy', 'dashboard'], 'must be an object');
    } else {
      checkBoolean(dashboard, 'enabled', ['proxy', 'dashboard'], issues);
      checkString(dashboard, 'domain', ['proxy', 'dashboard'], issues);
      if (dashboard.enabled === true && !dashboard.domain) {
        issues.add(['proxy', 'dashboard'], 'proxy.dashboard.domain is required when proxy.dashboard.enabled is true');
      }
    }
  }

  if (proxy.routes !== undefined) checkRoutes(proxy.routes, issues);
  if (proxy.trusted_ips !== undefined) checkIpList(proxy.trusted_ips, ['proxy', 'trusted_ips'], issues);
}

function checkRoutes(routes: unknown, issues: Issues): void {
  if (!Array.isArray(routes)) {
    issues.add(['proxy', 'routes'], 'must be a list');
    return;
  }
  routes.forEach((route: unknown, i: number) => {
    const path: Path = ['proxy', 'routes', i];
    if (!isMap(route)) {
      issues.add(path, 'must be an object');
      return;
    }
    if (typeof route.service !== 'string' || route.service === '') issues.add([...path, 'service'], 'must be a service name');
    if (route.domains === undefined) {
      issues.add([...path, 'domains'], 'required');
    } else {
      checkDomainMap(route.domains, [...path, 'domains'], issues, (domain) => HOST_NAME_RE.test(domain), 'must be a domain name, e.g. panel.example.com');
    }
    if (route.path !== undefined && (typeof route.path !== 'string' || !ROUTE_PATH_RE.test(route.path))) {
      issues.add([...path, 'path'], 'must start with / and contain no spaces, backticks or $');
    }
    checkPort(route, path, issues);
  });
}

function checkFirewall(firewall: unknown, issues: Issues): void {
  if (firewall === undefined) return;
  if (!isMap(firewall)) {
    issues.add(['firewall'], 'must be an object');
    return;
  }
  const ports = firewall.public_ports;
  if (ports === undefined) return;
  if (!Array.isArray(ports)) {
    issues.add(['firewall', 'public_ports'], 'must be a list');
    return;
  }
  ports.forEach((entry: unknown, i: number) => {
    const path: Path = ['firewall', 'public_ports', i];
    if (!isMap(entry)) {
      if (!isPortSpec(entry)) issues.add(path, PORT_MESSAGE);
      return;
    }
    const extra = Object.keys(entry).filter((key) => key !== 'port' && key !== 'from');
    if (extra.length > 0) issues.add(path, `Unrecognized key${extra.length > 1 ? 's' : ''}: ${extra.map((key) => `"${key}"`).join(', ')}`);
    if (!isPortSpec(entry.port)) issues.add([...path, 'port'], PORT_MESSAGE);
    if (entry.from !== undefined) {
      if (Array.isArray(entry.from) && entry.from.length === 0) issues.add([...path, 'from'], 'must list at least one address');
      else checkIpList(entry.from, [...path, 'from'], issues);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// servers.yml

function checkTags(tags: unknown, path: Path, issues: Issues): void {
  if (!Array.isArray(tags)) {
    issues.add(path, 'required, must be a non-empty list of environment tags');
    return;
  }
  if (tags.length === 0) issues.add(path, 'At least one tag is required');
  tags.forEach((tag: unknown, i: number) => {
    if (typeof tag !== 'string') {
      issues.add([...path, i], 'must be a string');
      return;
    }
    if (tag.length < 1) issues.add([...path, i], 'Tag cannot be empty');
    if (tag.length > 50) issues.add([...path, i], 'Tag must be 50 characters or less');
    if (!TAG_RE.test(tag)) issues.add([...path, i], 'Tags must be lowercase alphanumeric with hyphens');
  });
}

/** A map of variable names to strings; `null` stands for no variables */
function checkEnvVars(env: unknown, path: Path, issues: Issues): void {
  if (env === null) return;
  if (!isMap(env)) {
    issues.add(path, 'must be a map of variable names to strings');
    return;
  }
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_VAR_NAME_RE.test(name)) {
      issues.add([...path, name], 'Environment variable names must start with a letter and contain only letters, numbers, and underscores');
    }
    if (typeof value !== 'string') issues.add([...path, name], 'must be a string');
  }
}

function checkServers(servers: unknown, issues: Issues): void {
  if (!isMap(servers)) {
    issues.add(['servers'], 'must be a map of server names to servers');
    return;
  }
  if (Object.keys(servers).length === 0) {
    issues.add(['servers'], 'At least one server must be defined');
    return;
  }

  for (const [name, server] of Object.entries(servers)) {
    const path: Path = ['servers', name];
    if (name.length < 1) issues.add(path, 'Server name cannot be empty');
    if (name.length > 63) issues.add(path, 'Server name must be 63 characters or less');
    if (!SERVER_NAME_RE.test(name)) issues.add(path, 'Server name must be lowercase alphanumeric with hyphens or underscores');
    if (!isMap(server)) {
      issues.add(path, 'must be an object');
      continue;
    }
    if (server.role !== undefined && server.role !== 'manager' && server.role !== 'worker') {
      issues.add([...path, 'role'], 'must be "manager" or "worker"');
    }
    checkString(server, 'host', path, issues);
    checkTags(server.tags, [...path, 'tags'], issues);
    checkUser(server, path, issues);
    checkPort(server, path, issues);
    if (server.env !== undefined) checkEnvVars(server.env, [...path, 'env'], issues);
  }
}

function checkDefaults(defaults: unknown, issues: Issues): void {
  if (defaults === undefined) return;
  if (!isMap(defaults)) {
    issues.add(['defaults'], 'must be an object');
    return;
  }
  checkUser(defaults, ['defaults'], issues);
  checkPort(defaults, ['defaults'], issues);
}

function checkEnvByTag(env: unknown, issues: Issues): void {
  if (env === undefined) return;
  if (!isMap(env)) {
    issues.add(['env'], 'must be a map of tags to variables');
    return;
  }
  for (const [tag, vars] of Object.entries(env)) checkEnvVars(vars, ['env', tag], issues);
}

function checkManagers(servers: Doc, issues: Issues): void {
  const withManager = new Set<string>();
  const all = new Set<string>();
  for (const server of Object.values(servers)) {
    if (!isMap(server) || !Array.isArray(server.tags)) continue;
    for (const tag of server.tags) {
      if (typeof tag !== 'string') continue;
      all.add(tag);
      if ((server.role ?? 'manager') === 'manager') withManager.add(tag);
    }
  }
  if ([...all].some((tag) => !withManager.has(tag))) {
    issues.add([], 'Each environment tag must have at least one manager server');
  }
}

function checkServersPart(doc: Doc, issues: Issues): void {
  if (doc.servers === undefined) issues.add(['servers'], 'required');
  else checkServers(doc.servers, issues);
  checkDefaults(doc.defaults, issues);
  checkEnvByTag(doc.env, issues);
  if (isMap(doc.servers)) checkManagers(doc.servers, issues);
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** Validates a config.yml, or a dockflow.yml when the content has a `servers` block. */
export function validateConfig(content: string): ValidationResult {
  return run(content, (doc, issues) => {
    checkConfig(doc, issues);
    if (doc.servers !== undefined) checkServersPart(doc, issues);
  });
}

export function validateServersOnly(content: string): ValidationResult {
  return run(content, checkServersPart);
}

/** `root` for a dockflow.yml, `servers` for a servers.yml, `config` otherwise */
export function detectFileType(content: string): ConfigFileType {
  const doc = parseDocument(content);
  if (typeof doc === 'string') return 'config';
  if (doc.servers !== undefined && doc.project_name !== undefined) return 'root';
  if (doc.servers !== undefined) return 'servers';
  return 'config';
}

export function validateFile(content: string, type: ConfigFileType): ValidationResult {
  if (type === 'servers') return validateServersOnly(content);
  if (type === 'config') return run(content, checkConfig);
  return run(content, (doc, issues) => {
    checkConfig(doc, issues);
    checkServersPart(doc, issues);
  });
}

export function formatValidationResult(result: ValidationResult, filename: string): string {
  if (result.valid) return `✓ ${filename} is valid.`;
  const lines = [`✗ ${filename} has ${result.errors.length} error(s):\n`];
  for (const error of result.errors) lines.push(`  → ${error}`);
  return lines.join('\n');
}
