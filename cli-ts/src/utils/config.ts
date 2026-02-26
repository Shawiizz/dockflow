/**
 * Configuration utilities
 * Handles reading config.yml and servers.yml with schema validation
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, parse as parsePath } from 'path';
import { parse as parseYaml } from 'yaml';
import { ANSIBLE_DOCKER_IMAGE } from '../constants';
import type { ServersConfig } from '../types';
import { printError, printRaw } from './output';
import {
  validateConfig as validateConfigSchema, 
  validateServersConfig as validateServersSchema,
  formatValidationErrors,
  type ValidationIssue 
} from '../schemas';

/**
 * Dockflow configuration schema
 */
export interface RegistryConfig {
  type: string;
  url?: string;
  username?: string;
  password?: string;
  enabled?: boolean;
  namespace?: string;
  token?: string;
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
  method?: string;
  timeout?: number;
  validate_certs?: boolean;
  retries?: number;
  retry_delay?: number;
}

export interface HealthCheckConfig {
  enabled?: boolean;
  on_failure?: 'notify' | 'rollback' | 'fail';
  startup_delay?: number;
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

export interface TemplateFileConfig {
  src: string;
  dest: string;
}

export interface AccessoryConfig {
  image?: string;
  volumes?: string[];
  ports?: string[];
  env?: Record<string, string>;
  deploy?: Record<string, unknown>;
}

export interface DockflowConfig {
  project_name: string;
  registry?: RegistryConfig;
  options?: BuildOptions;
  stack_management?: StackManagementConfig;
  health_checks?: HealthCheckConfig;
  hooks?: HooksConfig;
  lock?: LockConfig;
  templates?: (string | TemplateFileConfig)[];
  accessories?: Record<string, AccessoryConfig>;
}

/**
 * Get the project root directory (where .dockflow folder is).
 * Traverses up from cwd until a .dockflow/ directory is found.
 * Falls back to cwd if none is found (e.g. before `dockflow init`).
 */
export function getProjectRoot(): string {
  let dir = process.cwd();
  const { root } = parsePath(dir);
  while (dir !== root) {
    if (existsSync(join(dir, '.dockflow'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  // Check root itself
  if (existsSync(join(root, '.dockflow'))) {
    return root;
  }
  // Fallback to cwd (before init, or no .dockflow/ exists yet)
  return process.cwd();
}

/**
 * Configuration loading options
 */
export interface LoadConfigOptions {
  /** Enable schema validation (default: true) */
  validate?: boolean;
  /** Suppress validation error output (default: false) */
  silent?: boolean;
}

/**
 * Load result with optional validation errors
 */
export interface LoadResult<T> {
  data: T | null;
  errors?: ValidationIssue[];
}

/**
 * Load the deployment config from .dockflow/config.yml
 * @param options - Loading options (validate, silent)
 * @returns Loaded config or null if not found/invalid
 */
export function loadConfig(options: LoadConfigOptions = {}): DockflowConfig | null {
  const { validate = true, silent = false } = options;
  const configPath = join(getProjectRoot(), '.dockflow', 'config.yml');
  
  if (!existsSync(configPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
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
 * Load config with detailed result including validation errors
 */
export function loadConfigWithErrors(options: LoadConfigOptions = {}): LoadResult<DockflowConfig> {
  const { validate = true } = options;
  const configPath = join(getProjectRoot(), '.dockflow', 'config.yml');
  
  if (!existsSync(configPath)) {
    return { data: null };
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    
    if (validate) {
      const result = validateConfigSchema(parsed);
      if (!result.success) {
        return { data: null, errors: result.error };
      }
      return { data: result.data as DockflowConfig };
    }
    
    return { data: parsed as DockflowConfig };
  } catch (error) {
    return { 
      data: null, 
      errors: [{ path: 'root', message: `YAML parse error: ${error}`, code: 'parse_error' }] 
    };
  }
}

/**
 * Load the servers config from .dockflow/servers.yml
 * @param options - Loading options (validate, silent)
 * @returns Loaded config or null if not found/invalid
 */
export function loadServersConfig(options: LoadConfigOptions = {}): ServersConfig | null {
  const { validate = true, silent = false } = options;
  const serversPath = join(getProjectRoot(), '.dockflow', 'servers.yml');
  
  if (!existsSync(serversPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(serversPath, 'utf-8');
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
 * Load servers config with detailed result including validation errors
 */
export function loadServersConfigWithErrors(options: LoadConfigOptions = {}): LoadResult<ServersConfig> {
  const { validate = true } = options;
  const serversPath = join(getProjectRoot(), '.dockflow', 'servers.yml');
  
  if (!existsSync(serversPath)) {
    return { data: null };
  }
  
  try {
    const content = readFileSync(serversPath, 'utf-8');
    const parsed = parseYaml(content);
    
    if (validate) {
      const result = validateServersSchema(parsed);
      if (!result.success) {
        return { data: null, errors: result.error };
      }
      return { data: result.data as ServersConfig };
    }
    
    return { data: parsed as ServersConfig };
  } catch (error) {
    return { 
      data: null, 
      errors: [{ path: 'root', message: `YAML parse error: ${error}`, code: 'parse_error' }] 
    };
  }
}

/**
 * Check if servers.yml exists
 */
export function hasServersConfig(): boolean {
  const serversPath = join(getProjectRoot(), '.dockflow', 'servers.yml');
  return existsSync(serversPath);
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
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['docker', 'info'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get the Docker image for Ansible operations
 */
export function getAnsibleDockerImage(): string {
  return ANSIBLE_DOCKER_IMAGE;
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
 * Get the path to the docker-compose file (.yml or .yaml)
 * Returns null if neither exists
 */
export function getComposePath(): string | null {
  const root = getProjectRoot();
  const ymlPath = join(root, '.dockflow', 'docker', 'docker-compose.yml');
  if (existsSync(ymlPath)) return ymlPath;

  const yamlPath = join(root, '.dockflow', 'docker', 'docker-compose.yaml');
  if (existsSync(yamlPath)) return yamlPath;

  return null;
}