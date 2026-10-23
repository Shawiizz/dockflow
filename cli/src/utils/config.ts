/** Loads, validates, caches and writes the project config, in the flat or the standard layout. */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, parse as parsePath } from 'path';
import os from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ServersConfig } from '../types';
import type { BackupDbType } from '../api/types';
export type { BackupDbType };
import { printError, printRaw } from './output';
import { ConfigError } from './errors';
import {
  validateConfig as validateConfigSchema,
  validateServersConfig as validateServersSchema,
  validateRootConfig,
  formatValidationErrors,
} from '../schemas';
import type { RootConfig, ValidationIssue } from '../schemas';

export interface RegistryConfig {
  type: 'local' | 'dockerhub' | 'ghcr' | 'gitlab' | 'custom';
  url?: string;
  username?: string;
  password?: string;
  enabled?: boolean;
  namespace?: string;
  token?: string;
  additional_tags?: string[];
}

export interface BuildOptions {
  remote_build?: boolean;
  image_auto_tag?: boolean;
  enable_debug_logs?: boolean;
}

export interface HealthCheckEndpoint {
  url: string;
  name?: string;
  expected_status?: number;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS';
  timeout?: number;
  validate_certs?: boolean;
  retries?: number;
  retry_delay?: number;
  remote?: boolean;
}

export interface HealthCheckConfig {
  enabled?: boolean;
  on_failure?: 'notify' | 'rollback' | 'fail' | 'ignore';
  timeout?: number;
  interval?: number;
  startup_delay?: number;
  wait_for_internal?: boolean;
  endpoints?: HealthCheckEndpoint[];
}

export const HOOK_PHASES = [
  'pre-build',
  'post-build',
  'pre-upload',
  'post-upload',
  'pre-deploy',
  'post-deploy',
  'on-failure',
] as const;

export type HookPhase = (typeof HOOK_PHASES)[number];

/**
 * One thing a phase runs. `run` is an inline command, `script` a file path
 * relative to the project root — exactly one of the two.
 *
 * `fatal` and `timeout` fall back to the values on HooksConfig when omitted,
 * so a single critical entry can abort the deploy while its neighbours only warn.
 */
export interface HookEntry {
  /** Shown in the deploy output; defaults to the script path or the entry index. */
  name?: string;
  run?: string;
  script?: string;
  fatal?: boolean;
  timeout?: number;
}

/** A bare string is shorthand for `{ run: <string> }`. */
export type HookEntryInput = string | HookEntry;

export interface HooksConfig {
  enabled?: boolean;
  /** Default timeout, in seconds, for entries that do not set their own. */
  timeout?: number;
  /** Default fatality for entries that do not set their own. */
  fatal?: boolean;
  'pre-build'?: HookEntryInput[];
  'post-build'?: HookEntryInput[];
  'pre-upload'?: HookEntryInput[];
  'post-upload'?: HookEntryInput[];
  'pre-deploy'?: HookEntryInput[];
  'post-deploy'?: HookEntryInput[];
  'on-failure'?: HookEntryInput[];
}

export interface StackManagementConfig {
  keep_releases?: number;
  cleanup_on_failure?: boolean;
}

export interface LockConfig {
  stale_threshold_minutes?: number;
}

export interface BackupAccessoryConfig {
  type: BackupDbType;
  dump_command?: string;
  restore_command?: string;
  dump_options?: string;
  restore_options?: string;
  exclude_volumes?: string[];
  include_bind_mounts?: boolean;
}

export interface BackupConfig {
  retention_count?: number;
  compression?: 'gzip' | 'none';
  accessories?: Record<string, BackupAccessoryConfig>;
  services?: Record<string, BackupAccessoryConfig>;
}

export interface TemplateFileConfig {
  src: string;
  dest: string;
}

export interface ProxyDashboardConfig {
  enabled?: boolean;
  domain?: string;
}

/** A route Traefik serves for one service of docker-compose.yml or accessories.yml */
export interface ProxyRoute {
  service: string;
  /** domain per environment; the route is left out of the others */
  domains: Record<string, string>;
  /** path prefix the requests must start with */
  path?: string;
  /** container port the requests go to; the service's first port when absent */
  port?: number;
}

export interface ProxyConfig {
  enabled?: boolean;
  email?: string;
  acme?: boolean;
  domains?: Record<string, string>;
  /** services routed on their own domains; they get no route on `domains` */
  routes?: ProxyRoute[];
  dashboard?: ProxyDashboardConfig;
  /** CDN or load balancer addresses whose X-Forwarded-* headers Traefik keeps */
  trusted_ips?: string[];
}

/** A published port the internet may reach: `443`, `51820/udp`, `8000-8010/tcp`, or with the addresses it answers */
export type PublicPort = number | string | { port: number | string; from?: string[] };

export interface FirewallConfig {
  /** published container ports the internet may reach on the servers `dockflow setup` filters */
  public_ports?: PublicPort[];
}

export interface WebhookConfig {
  url: string;
  on?: Array<'success' | 'failure' | 'always'>;
  secret?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface NotificationsConfig {
  webhooks?: WebhookConfig[];
}

export interface PluginUse {
  /** A plugin name, or a path starting with ./ or ../ */
  use: string;
  /** Instance id; defaults to the plugin name. */
  id?: string;
  with?: Record<string, string | number | boolean>;
}

export interface UploadItem {
  src: string;
  /**
   * How the upload is named in the output. Set by plugin expansion, whose sources
   * are in-memory keys that read like paths but match no file. Not a config key.
   */
  label?: string;
  dest: string;
  service?: string | string[];
  permissions?: string;
  owner?: string;
  exclude?: string[];
  compress?: boolean;
}

export interface DockflowConfig {
  project_name: string;
  container_engine?: 'docker' | 'podman';
  registry?: RegistryConfig;
  options?: BuildOptions;
  stack_management?: StackManagementConfig;
  health_checks?: HealthCheckConfig;
  hooks?: HooksConfig;
  lock?: LockConfig;
  backup?: BackupConfig;
  templates?: (string | TemplateFileConfig)[];
  plugins?: PluginUse[];
  proxy?: ProxyConfig;
  firewall?: FirewallConfig;
  notifications?: NotificationsConfig;
  uploads?: UploadItem[];
  no_services?: boolean;
}

/**
 * Get the project root directory.
 * Traverses up from cwd looking for dockflow.yml or .dockflow/.
 * Falls back to cwd if none is found (e.g. before `dockflow init`).
 */
export function getProjectRoot(): string {
  let dir = process.cwd();
  const { root } = parsePath(dir);
  while (dir !== root) {
    if (existsSync(join(dir, 'dockflow.yml')) || existsSync(join(dir, '.dockflow'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  if (existsSync(join(root, 'dockflow.yml')) || existsSync(join(root, '.dockflow'))) {
    return root;
  }
  return process.cwd();
}

/** Where the project's files are; computed once per process, so build paths from it. */
export interface ProjectLayout {
  /** 'flat'  → dockflow.yml at root; 'standard' → .dockflow/ directory */
  type: 'flat' | 'standard';
  root: string;
  /** dockflow.yml or .dockflow/config.yml */
  configPath: string;
  /** dockflow.yml or .dockflow/servers.yml */
  serversPath: string;
  /** null when the project has no compose file */
  composePath: string | null;
  /** null when the project has no accessories file */
  accessoriesPath: string | null;
}

let _layoutCache: ProjectLayout | undefined;

/** Resolves the project layout once and caches it. */
export function getLayout(): ProjectLayout {
  if (_layoutCache) return _layoutCache;

  const root = getProjectRoot();
  const flat = existsSync(join(root, 'dockflow.yml'));

  const composePath = (() => {
    if (flat) {
      if (existsSync(join(root, 'docker-compose.yml'))) return join(root, 'docker-compose.yml');
      if (existsSync(join(root, 'docker-compose.yaml'))) return join(root, 'docker-compose.yaml');
    }
    if (existsSync(join(root, '.dockflow', 'docker', 'docker-compose.yml'))) return join(root, '.dockflow', 'docker', 'docker-compose.yml');
    if (existsSync(join(root, '.dockflow', 'docker', 'docker-compose.yaml'))) return join(root, '.dockflow', 'docker', 'docker-compose.yaml');
    return null;
  })();

  const accessoriesPath = (() => {
    if (flat) {
      if (existsSync(join(root, 'accessories.yml'))) return join(root, 'accessories.yml');
      if (existsSync(join(root, 'accessories.yaml'))) return join(root, 'accessories.yaml');
    }
    if (existsSync(join(root, '.dockflow', 'docker', 'accessories.yml'))) return join(root, '.dockflow', 'docker', 'accessories.yml');
    return null;
  })();

  return (_layoutCache = flat
    ? {
        type: 'flat',
        root,
        configPath: join(root, 'dockflow.yml'),
        serversPath: join(root, 'dockflow.yml'),
        composePath,
        accessoriesPath,
      }
    : {
        type: 'standard',
        root,
        configPath: join(root, '.dockflow', 'config.yml'),
        serversPath: join(root, '.dockflow', 'servers.yml'),
        composePath,
        accessoriesPath,
      });
}

// undefined = not yet loaded, null = absent/invalid, RootConfig = loaded and valid
let _rootConfigCache: RootConfig | null | undefined = undefined;
/** why an existing dockflow.yml was rejected, thrown by strict loads */
let _rootConfigRejection: ConfigError | null = null;

/** Loads and caches dockflow.yml; null when it is absent or invalid (the reason lands in _rootConfigRejection). */
function loadRootConfig(projectRoot: string): RootConfig | null {
  if (_rootConfigCache !== undefined) return _rootConfigCache;

  const rootConfigPath = join(projectRoot, 'dockflow.yml');
  if (!existsSync(rootConfigPath)) {
    return (_rootConfigCache = null);
  }

  try {
    const content = readFileSync(rootConfigPath, 'utf-8');
    const parsed = parseYaml(content);
    const result = validateRootConfig(parsed);
    if (!result.success) {
      printRaw(formatValidationErrors(result.error, 'dockflow.yml'));
      _rootConfigRejection = invalidFileError('dockflow.yml', result.error);
      return (_rootConfigCache = null);
    }
    return (_rootConfigCache = result.data);
  } catch (error) {
    printError(`Error reading dockflow.yml: ${error}`);
    _rootConfigRejection = unreadableFileError('dockflow.yml', error);
    return (_rootConfigCache = null);
  }
}

/** Returns true when the project uses the flat layout (dockflow.yml at root). */
export function hasDockflowYml(): boolean {
  return getLayout().type === 'flat';
}

export function getAccessoriesPath(): string | null {
  return getLayout().accessoriesPath;
}

export interface LoadConfigOptions {
  /** Enable schema validation (default: true) */
  validate?: boolean;
  /** Suppress validation error output (default: false) */
  silent?: boolean;
  /** Parse from string instead of reading from disk */
  content?: string;
  /** An existing file that is unreadable or fails validation throws a ConfigError instead of returning null */
  strict?: boolean;
}

function invalidFileError(fileName: string, issues: ValidationIssue[]): ConfigError {
  const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
  return new ConfigError(`${fileName} is invalid:\n${lines.join('\n')}`, `Fix ${fileName}; \`dockflow config validate\` checks it without deploying.`);
}

function unreadableFileError(fileName: string, error: unknown): ConfigError {
  return new ConfigError(`${fileName} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Loads the deployment config from dockflow.yml (flat layout) or .dockflow/config.yml.
 * Returns null when it is missing or invalid, unless `strict` makes an existing bad file throw.
 */
export function loadConfig(options: LoadConfigOptions = {}): DockflowConfig | null {
  const { validate = true, silent = false, strict = false, content: rawContent } = options;

  // When content is provided directly (e.g. dockflow config validate), skip file detection
  if (rawContent === undefined) {
    const layout = getLayout();
    if (layout.type === 'flat') {
      const rootConfig = loadRootConfig(layout.root);
      if (rootConfig) {
        const { servers: _s, defaults: _d, env: _e, ...configPart } = rootConfig;
        return configPart as DockflowConfig;
      }
      if (strict && _rootConfigRejection) throw _rootConfigRejection;
      return null;
    }
    if (!existsSync(layout.configPath)) return null;
  }

  // A rendered dockflow.yml carries the servers too: keep the config part.
  const rendersRoot = rawContent !== undefined && getLayout().type === 'flat';
  const fileName = rendersRoot ? 'dockflow.yml' : 'config.yml';

  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent ?? readFileSync(getLayout().configPath, 'utf-8'));
  } catch (error) {
    if (strict) throw unreadableFileError(fileName, error);
    if (!silent) printError(`Error reading ${fileName}: ${error}`);
    return null;
  }

  if (rendersRoot) {
    const result = validateRootConfig(parsed);
    if (!result.success) {
      if (strict) throw invalidFileError(fileName, result.error);
      if (!silent) printRaw(formatValidationErrors(result.error, fileName));
      return null;
    }
    const { servers: _s, defaults: _d, env: _e, ...configPart } = result.data;
    return configPart as DockflowConfig;
  }

  if (!validate) return parsed as DockflowConfig;
  const result = validateConfigSchema(parsed);
  if (result.success) return result.data as DockflowConfig;
  if (strict) throw invalidFileError(fileName, result.error);
  if (!silent) printRaw(formatValidationErrors(result.error, fileName));
  return null;
}

/**
 * Loads the servers config from dockflow.yml (flat layout) or .dockflow/servers.yml.
 * Returns null when it is missing or invalid, unless `strict` makes an existing bad file throw.
 */
export function loadServersConfig(options: LoadConfigOptions = {}): ServersConfig | null {
  const { validate = true, silent = false, strict = false } = options;

  const layout = getLayout();
  if (layout.type === 'flat') {
    const rootConfig = loadRootConfig(layout.root);
    if (rootConfig) {
      return { servers: rootConfig.servers, defaults: rootConfig.defaults, env: rootConfig.env } as ServersConfig;
    }
    if (strict && _rootConfigRejection) throw _rootConfigRejection;
    return null;
  }

  if (!existsSync(layout.serversPath)) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(layout.serversPath, 'utf-8'));
  } catch (error) {
    if (strict) throw unreadableFileError('servers.yml', error);
    if (!silent) printError(`Error reading servers.yml: ${error}`);
    return null;
  }

  if (!validate) return parsed as ServersConfig;
  const result = validateServersSchema(parsed);
  if (result.success) return result.data as ServersConfig;
  if (strict) throw invalidFileError('servers.yml', result.error);
  if (!silent) printRaw(formatValidationErrors(result.error, 'servers.yml'));
  return null;
}

export function hasServersConfig(): boolean {
  const layout = getLayout();
  return layout.type === 'flat' || existsSync(layout.serversPath);
}

export function getProjectName(): string | null {
  const config = loadConfig();
  return config?.project_name ?? null;
}

export function getStackName(env: string): string | null {
  const projectName = getProjectName();
  if (!projectName) return null;
  return `${projectName}-${env}`;
}

/** The accessories live in their own stack, apart from the app's. */
export function getAccessoriesStackName(env: string): string | null {
  const projectName = getProjectName();
  if (!projectName) return null;
  return `${projectName}-${env}-accessories`;
}

/**
 * Absolute path of docker-compose.yml or .yaml: the project root first in flat layout, then
 * .dockflow/docker/. Null when there is none.
 */
export function getComposePath(): string | null {
  return getLayout().composePath;
}

/** The `user@hostname` recorded as the performer in audit and metrics entries. */
export function getPerformer(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? 'ci';
  const hostname = os.hostname();
  return `${user}@${hostname}`;
}

const SERVER_KEYS = ['servers', 'defaults', 'env'] as const;
const CONFIG_KEYS = [
  'project_name', 'swarm', 'container_engine', 'registry', 'proxy',
  'health_checks', 'stack_management', 'hooks', 'lock', 'notifications', 'backup',
  'templates', 'options',
] as const;

/**
 * Write the deployment config. In flat layout, merges with existing server fields in dockflow.yml.
 */
export function writeConfig(data: unknown): void {
  const layout = getLayout();
  if (layout.type === 'flat') {
    const existing = parseYaml(readFileSync(layout.configPath, 'utf-8')) as Record<string, unknown>;
    const serverFields = Object.fromEntries(SERVER_KEYS.filter(k => k in existing).map(k => [k, existing[k]]));
    writeFileSync(layout.configPath, stringifyYaml({ ...(data as object), ...serverFields }, { indent: 2 }), 'utf-8');
  } else {
    writeFileSync(layout.configPath, stringifyYaml(data, { indent: 2 }), 'utf-8');
  }
}

export function writeServersConfig(data: unknown): void {
  const layout = getLayout();
  if (layout.type === 'flat') {
    const existing = parseYaml(readFileSync(layout.serversPath, 'utf-8')) as Record<string, unknown>;
    const configFields = Object.fromEntries(CONFIG_KEYS.filter(k => k in existing).map(k => [k, existing[k]]));
    writeFileSync(layout.serversPath, stringifyYaml({ ...configFields, ...(data as object) }, { indent: 2 }), 'utf-8');
  } else {
    writeFileSync(layout.serversPath, stringifyYaml(data, { indent: 2 }), 'utf-8');
  }
}