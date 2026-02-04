/**
 * Project API Routes
 * 
 * GET /api/project - Get current project info
 * GET /api/project/connection - Check connection status
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig, loadServersConfig, getProjectRoot } from '../../utils/config';
import { getAvailableEnvironments } from '../../utils/servers';
import { existsSync } from 'fs';
import { join, basename } from 'path';

/**
 * Handle /api/project/* routes
 */
export async function handleProjectRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;
  
  // GET /api/project - Get project info
  if (pathname === '/api/project' && method === 'GET') {
    return getProjectInfo();
  }
  
  // GET /api/project/connection - Check if connection credentials exist
  if (pathname === '/api/project/connection' && method === 'GET') {
    return checkConnection();
  }
  
  return errorResponse('Endpoint not found', 404);
}

/**
 * Get project information
 */
async function getProjectInfo(): Promise<Response> {
  const projectRoot = getProjectRoot();
  const dockflowDir = join(projectRoot, '.dockflow');
  
  const hasDockflow = existsSync(dockflowDir);
  const config = loadConfig({ silent: true });
  const serversConfig = loadServersConfig();
  const environments = getAvailableEnvironments();
  
  // Check for various config files
  const hasConfig = existsSync(join(dockflowDir, 'config.yml'));
  const hasServers = existsSync(join(dockflowDir, 'servers.yml'));
  const hasDocker = existsSync(join(dockflowDir, 'docker'));
  const hasEnvFile = existsSync(join(projectRoot, '.env.dockflow'));
  
  return jsonResponse({
    projectRoot,
    projectName: config?.project_name || basename(projectRoot),
    hasDockflow,
    hasConfig,
    hasServers,
    hasDocker,
    hasEnvFile,
    environments,
    serverCount: serversConfig ? Object.keys(serversConfig.servers).length : 0,
    config: config ? {
      project_name: config.project_name,
      registry: config.registry?.type,
      remote_build: config.options?.remote_build,
      health_checks_enabled: config.health_checks?.enabled,
    } : null,
  });
}

/**
 * Check connection status
 */
async function checkConnection(): Promise<Response> {
  const projectRoot = getProjectRoot();
  const envFilePath = join(projectRoot, '.env.dockflow');
  
  const hasEnvFile = existsSync(envFilePath);
  
  // Check for CI environment variables
  const hasCISecrets = Object.keys(process.env).some(key => 
    key.endsWith('_CONNECTION') || key.endsWith('_SSH_KEY')
  );
  
  // Get list of servers that have credentials
  const serversConfig = loadServersConfig();
  const serversWithCreds: string[] = [];
  const serversWithoutCreds: string[] = [];
  
  if (serversConfig) {
    const { getServerPrivateKey, getAvailableEnvironments } = await import('../../utils/servers');
    const envs = getAvailableEnvironments();
    
    for (const serverName of Object.keys(serversConfig.servers)) {
      // Try each environment to find credentials for this server
      const hasKey = envs.some(env => !!getServerPrivateKey(env, serverName));
      if (hasKey) {
        serversWithCreds.push(serverName);
      } else {
        serversWithoutCreds.push(serverName);
      }
    }
  }
  
  return jsonResponse({
    hasEnvFile,
    hasCISecrets,
    serversWithCredentials: serversWithCreds,
    serversMissingCredentials: serversWithoutCreds,
    ready: serversWithCreds.length > 0,
    message: serversWithCreds.length > 0 
      ? `Ready to connect to ${serversWithCreds.length} server(s)`
      : 'No connection credentials found. Create .env.dockflow or set CI secrets.',
  });
}
