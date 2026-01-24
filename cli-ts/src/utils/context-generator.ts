/**
 * Context Generator for Ansible
 * 
 * Generates a structured JSON context file that Ansible consumes via --extra-vars.
 * This replaces the old approach of exporting shell variables and generating YAML.
 * 
 * Benefits:
 * - No shell variable pollution (PATH, HOME, etc.)
 * - Proper handling of multiline values (SSH keys)
 * - Type-safe structured data
 * - Single source of truth
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ResolvedServer, ResolvedDeployment, TemplateContext } from '../types';

/**
 * SSH connection info for Ansible
 */
export interface ConnectionContext {
  host: string;
  port: number;
  user: string;
  private_key: string;
  password?: string;
}

/**
 * Worker connection info for image distribution
 */
export interface WorkerContext {
  name: string;
  host: string;
  port: number;
  user: string;
  private_key: string;
}

/**
 * Deployment options passed to Ansible
 */
export interface DeploymentOptions {
  skip_build: boolean;
  skip_docker_install: boolean;
  force_deploy: boolean;
  deploy_app: boolean;
  deploy_accessories: boolean;
  skip_accessories: boolean;
  services?: string;
}

/**
 * Complete Ansible context - everything Ansible needs in one JSON
 */
export interface AnsibleContext {
  // Deployment metadata
  env: string;
  version: string;
  branch_name: string;
  server_name: string;
  server_role: string;
  
  // SSH connection to manager
  connection: ConnectionContext;
  
  // Workers for image distribution (when no registry)
  workers: WorkerContext[];
  workers_count: number;
  
  // Template context (current, servers, cluster)
  current: TemplateContext['current'];
  servers: TemplateContext['servers'];
  cluster: TemplateContext['cluster'];
  
  // User environment variables (from servers.yml + CI secrets)
  // These are flattened for backward compatibility with {{ var_name }}
  user_env: Record<string, string>;
  
  // Deployment options
  options: DeploymentOptions;
}

/**
 * Build context for deploy command
 */
export interface BuildDeployContextParams {
  env: string;
  version: string;
  branchName: string;
  deployment: ResolvedDeployment;
  templateContext: TemplateContext;
  managerPrivateKey: string;
  managerPassword?: string;
  workers: Array<{
    server: ResolvedServer;
    privateKey: string;
  }>;
  options: {
    skipBuild?: boolean;
    skipDockerInstall?: boolean;
    force?: boolean;
    deployApp: boolean;
    forceAccessories: boolean;
    skipAccessories: boolean;
    services?: string;
  };
}

/**
 * Build the complete Ansible context for deployment
 */
export function buildDeployContext(params: BuildDeployContextParams): AnsibleContext {
  const { env, version, branchName, deployment, templateContext, managerPrivateKey, managerPassword, workers, options } = params;
  const manager = deployment.manager;

  // Build worker contexts
  const workerContexts: WorkerContext[] = workers.map(w => ({
    name: w.server.name,
    host: w.server.host,
    port: w.server.port,
    user: w.server.user,
    private_key: w.privateKey,
  }));

  // Flatten user env vars for backward compatibility
  // Templates can use {{ db_host }} instead of {{ current.env.DB_HOST }}
  const userEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(manager.env)) {
    userEnv[key.toLowerCase()] = value;
  }

  return {
    env,
    version,
    branch_name: branchName,
    server_name: manager.name,
    server_role: 'manager',
    
    connection: {
      host: manager.host,
      port: manager.port,
      user: manager.user,
      private_key: managerPrivateKey,
      password: managerPassword,
    },
    
    workers: workerContexts,
    workers_count: workerContexts.length,
    
    current: templateContext.current,
    servers: templateContext.servers,
    cluster: templateContext.cluster,
    
    user_env: userEnv,
    
    options: {
      skip_build: options.skipBuild || false,
      skip_docker_install: options.skipDockerInstall || false,
      force_deploy: options.force || false,
      deploy_app: options.deployApp,
      deploy_accessories: options.forceAccessories,
      skip_accessories: options.skipAccessories,
      services: options.services,
    },
  };
}

/**
 * Context for build command (simpler, no SSH needed)
 */
export interface BuildContext {
  env: string;
  version: string;
  branch_name: string;
  
  // Template context
  current: TemplateContext['current'];
  servers: TemplateContext['servers'];
  cluster: TemplateContext['cluster'];
  
  // User environment variables
  user_env: Record<string, string>;
  
  // Build options
  options: {
    skip_hooks: boolean;
    services?: string;
  };
}

/**
 * Build context for build command
 */
export interface BuildBuildContextParams {
  env: string;
  branchName: string;
  templateContext: TemplateContext;
  userEnv: Record<string, string>;
  options: {
    skipHooks?: boolean;
    services?: string;
  };
}

/**
 * Build the Ansible context for build command
 */
export function buildBuildContext(params: BuildBuildContextParams): BuildContext {
  const { env, branchName, templateContext, userEnv, options } = params;

  // Flatten user env vars to lowercase
  const flattenedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(userEnv)) {
    flattenedEnv[key.toLowerCase()] = value;
  }

  return {
    env,
    version: 'build',
    branch_name: branchName,
    
    current: templateContext.current,
    servers: templateContext.servers,
    cluster: templateContext.cluster,
    
    user_env: flattenedEnv,
    
    options: {
      skip_hooks: options.skipHooks || false,
      services: options.services,
    },
  };
}

/**
 * Write context to a JSON file
 * Returns the path to the file
 */
export function writeContextFile(context: AnsibleContext | BuildContext, filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(context, null, 2), 'utf-8');
  return filePath;
}

/**
 * Generate a temporary file path for the context on the host
 * This will be mounted into the container
 */
export function getHostContextPath(): string {
  const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
  return `${tmpDir}/dockflow_context_${Date.now()}.json`;
}
