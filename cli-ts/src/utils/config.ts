/**
 * Configuration utilities
 * Handles reading config.yml and servers.yml
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { ANSIBLE_DOCKER_IMAGE } from '../constants';
import type { ServersConfig } from '../types';

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
  environmentize?: boolean;
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

export interface DockflowConfig {
  project_name: string;
  registry?: RegistryConfig;
  options?: BuildOptions;
  health_checks?: HealthCheckConfig;
  hooks?: HooksConfig;
}

/**
 * Get the project root directory (where .deployment folder is)
 */
export function getProjectRoot(): string {
  return process.cwd();
}

/**
 * Load the deployment config from .deployment/config.yml
 */
export function loadConfig(): DockflowConfig | null {
  const configPath = join(getProjectRoot(), '.deployment', 'config.yml');
  
  if (!existsSync(configPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    return parseYaml(content) as DockflowConfig;
  } catch (error) {
    console.error(`Error reading config.yml: ${error}`);
    return null;
  }
}

/**
 * Load the servers config from .deployment/servers.yml
 */
export function loadServersConfig(): ServersConfig | null {
  const serversPath = join(getProjectRoot(), '.deployment', 'servers.yml');
  
  if (!existsSync(serversPath)) {
    return null;
  }
  
  try {
    const content = readFileSync(serversPath, 'utf-8');
    return parseYaml(content) as ServersConfig;
  } catch (error) {
    console.error(`Error reading servers.yml: ${error}`);
    return null;
  }
}

/**
 * Check if servers.yml exists
 */
export function hasServersConfig(): boolean {
  const serversPath = join(getProjectRoot(), '.deployment', 'servers.yml');
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