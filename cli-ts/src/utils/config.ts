/**
 * Configuration utilities
 * Handles reading config.yml and .env.dockflow
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

export interface DockflowConfig {
  project_name: string;
  registry?: {
    type: string;
    url?: string;
    username?: string;
    password?: string;
  };
  options?: {
    remote_build?: boolean;
    environmentize?: boolean;
    enable_debug_logs?: boolean;
  };
  health_checks?: {
    enabled?: boolean;
    on_failure?: string;
    endpoints?: Array<{
      url: string;
      expected_status?: number;
    }>;
  };
  hooks?: {
    'pre-build'?: string;
    'post-build'?: string;
    'pre-deploy'?: string;
    'post-deploy'?: string;
  };
}

export interface ConnectionInfo {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  password?: string;
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
 * Parse connection string from .env.dockflow
 */
export function getConnectionInfo(env: string): ConnectionInfo | null {
  const envFile = join(getProjectRoot(), '.env.dockflow');
  
  if (!existsSync(envFile)) {
    return null;
  }
  
  try {
    const content = readFileSync(envFile, 'utf-8');
    const varName = `${env.toUpperCase()}_CONNECTION`;
    
    // Find the connection string
    const match = content.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    if (!match) {
      return null;
    }
    
    // Decode base64
    const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
    const connectionInfo = JSON.parse(decoded) as ConnectionInfo;
    
    return connectionInfo;
  } catch (error) {
    console.error(`Error reading .env.dockflow: ${error}`);
    return null;
  }
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
  return 'shawiizz/dockflow-ci:latest';
}
