/**
 * Configuration utilities
 * Handles reading config.yml and servers.yml with schema validation
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, parse as parsePath } from 'path';
import os from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ServersConfig } from '../types';
import type { BackupDbType } from '../api/types';
export type { BackupDbType };
import { printError, printRaw } from './output';
import {
  validateConfig as validateConfigSchema,
  validateServersConfig as validateServersSchema,
  validateRootConfig,
  formatValidationErrors,
} from '../schemas';
import type { RootConfig } from '../schemas';

/**
 * Dockflow configuration schema
 */
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

export interface HooksConfig {
  enabled?: boolean;
  timeout?: number;
  'pre-build'?: string;
  'post-build'?: string;
  'pre-deploy'?: string;
  'post-deploy'?: string;
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

export interface ProxyConfig {
  enabled?: boolean;
  email?: string;
  acme?: boolean;
  domains?: Record<string, string>;
  dashboard?: ProxyDashboardConfig;
}

export interface AccessoryConfig {
  image?: string;
  volumes?: string[];
  ports?: string[];
  env?: Record<string, string>;
  deploy?: Record<string, unknown>;
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

export interface DockflowConfig {
  project_name: string;
  orchestrator?: 'swarm' | 'k3s';
  container_engine?: 'docker' | 'podman';
  registry?: RegistryConfig;
  options?: BuildOptions;
  stack_management?: StackManagementConfig;
  health_checks?: HealthCheckConfig;
  hooks?: HooksConfig;
  lock?: LockConfig;
  backup?: BackupConfig;
  templates?: (string | TemplateFileConfig)[];
  accessories?: Record<string, AccessoryConfig>;
  proxy?: ProxyConfig;
  notifications?: NotificationsConfig;
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

/**
 * Fully resolved layout description — single source of truth for all file paths.
 * Computed once per process from the filesystem; never construct paths elsewhere.
 */
export interface ProjectLayout {
  /** 'flat'  → dockflow.yml at root; 'standard' → .dockflow/ directory */
  type: 'flat' | 'standard';
  root: string;
  /** Absolute path to the config source (dockflow.yml or .dockflow/config.yml) */
  configPath: string;
  /** Absolute path to the servers source (dockflow.yml or .dockflow/servers.yml) */
  serversPath: string;
  /** Absolute path to docker-compose file, or null if absent */
  composePath: string | null;
  /** Absolute path to accessories.yml file, or null if absent */
  accessoriesPath: string | null;
}

let _layoutCache: ProjectLayout | undefined;

/**
 * Resolve and cache the project layout.
 * All layout-aware code should call this instead of hasDockflowYml() + manual joins.
 */
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

/**
 * Load and cache dockflow.yml if present.
 * Returns null when dockflow.yml does not exist or fails validation.
 */
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
      return (_rootConfigCache = null);
    }
    return (_rootConfigCache = result.data);
  } catch (error) {
    printError(`Error reading dockflow.yml: ${error}`);
    return (_rootConfigCache = null);
  }
}

/** Returns true when the project uses the flat layout (dockflow.yml at root). */
export function hasDockflowYml(): boolean {
  return getLayout().type === 'flat';
}

/** Returns the absolute path to accessories.yml, or null if absent. */
export function getAccessoriesPath(): string | null {
  return getLayout().accessoriesPath;
}

/**
 * Configuration loading options
 */
export interface LoadConfigOptions {
  /** Enable schema validation (default: true) */
  validate?: boolean;
  /** Suppress validation error output (default: false) */
  silent?: boolean;
  /** Parse from string instead of reading from disk */
  content?: string;
}

/**
 * Load the deployment config from dockflow.yml (flat layout) or .dockflow/config.yml
 * @param options - Loading options (validate, silent)
 * @returns Loaded config or null if not found/invalid
 */
export function loadConfig(options: LoadConfigOptions = {}): DockflowConfig | null {
  const { validate = true, silent = false, content: rawContent } = options;

  // When content is provided directly (e.g. dockflow config validate), skip file detection
  if (rawContent === undefined) {
    const layout = getLayout();
    if (layout.type === 'flat') {
      const rootConfig = loadRootConfig(layout.root);
      if (rootConfig) {
        const { servers: _s, defaults: _d, env: _e, ...configPart } = rootConfig;
        return configPart as DockflowConfig;
      }
      return null;
    }
    if (!existsSync(layout.configPath)) return null;
  }

  let content: string;
  if (rawContent !== undefined) {
    content = rawContent;
  } else {
    content = readFileSync(getLayout().configPath, 'utf-8');
  }

  try {
    const parsed = parseYaml(content);

    if (validate) {
      const result = validateConfigSchema(parsed);
      if (!result.success) {
        if (!silent) {
          printRaw(formatValidationErrors(result.error, 'config.yml'));
        }
        return null;
      }
      return result.data as DockflowConfig;
    }

    return parsed as DockflowConfig;
  } catch (error) {
    if (!silent) {
      printError(`Error reading config.yml: ${error}`);
    }
    return null;
  }
}

/**
 * Load the servers config from dockflow.yml (flat layout) or .dockflow/servers.yml
 * @param options - Loading options (validate, silent)
 * @returns Loaded config or null if not found/invalid
 */
export function loadServersConfig(options: LoadConfigOptions = {}): ServersConfig | null {
  const { validate = true, silent = false } = options;

  const layout = getLayout();
  if (layout.type === 'flat') {
    const rootConfig = loadRootConfig(layout.root);
    if (rootConfig) {
      return { servers: rootConfig.servers, defaults: rootConfig.defaults, env: rootConfig.env } as ServersConfig;
    }
    return null;
  }

  if (!existsSync(layout.serversPath)) return null;

  try {
    const content = readFileSync(layout.serversPath, 'utf-8');
    const parsed = parseYaml(content);

    if (validate) {
      const result = validateServersSchema(parsed);
      if (!result.success) {
        if (!silent) {
          printRaw(formatValidationErrors(result.error, 'servers.yml'));
        }
        return null;
      }
      return result.data as ServersConfig;
    }

    return parsed as ServersConfig;
  } catch (error) {
    if (!silent) {
      printError(`Error reading servers.yml: ${error}`);
    }
    return null;
  }
}

/**
 * Check if servers config is available (either via dockflow.yml or servers.yml)
 */
export function hasServersConfig(): boolean {
  const layout = getLayout();
  return layout.type === 'flat' || existsSync(layout.serversPath);
}

/**
 * Get project name from config
 */
export function getProjectName(): string | null {
  const config = loadConfig();
  return config?.project_name ?? null;
}

/**
 * Get stack name for an environment
 */
export function getStackName(env: string): string | null {
  const projectName = getProjectName();
  if (!projectName) return null;
  return `${projectName}-${env}`;
}

/**
 * Get accessories stack name (separate from main app stack)
 */
export function getAccessoriesStackName(env: string): string | null {
  const projectName = getProjectName();
  if (!projectName) return null;
  return `${projectName}-${env}-accessories`;
}

/**
 * Get the path to the docker-compose file (.yml or .yaml).
 * In flat layout mode (dockflow.yml present), looks at the project root.
 * Otherwise looks in .dockflow/docker/.
 * Returns null if neither exists.
 */
/** Returns the absolute path to docker-compose.yml, or null if absent. */
export function getComposePath(): string | null {
  return getLayout().composePath;
}

/**
 * Get the performer string for audit/metrics entries.
 * Format: "user@hostname" — consistent across all call sites.
 */
export function getPerformer(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? 'ci';
  const hostname = os.hostname();
  return `${user}@${hostname}`;
}

const SERVER_KEYS = ['servers', 'defaults', 'env'] as const;
const CONFIG_KEYS = [
  'project_name', 'orchestrator', 'container_engine', 'registry', 'proxy',
  'health_checks', 'stack_management', 'hooks', 'lock', 'notifications', 'backup',
  'templates', 'accessories', 'options',
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