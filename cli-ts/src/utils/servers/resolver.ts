/**
 * Server resolution utilities
 * 
 * Resolves server configurations from servers.yml and merges with CI secrets.
 * Handles environment/tag matching and connection info resolution.
 */

import { loadServersConfig } from '../config';
import { parseConnectionString } from '../connection-parser';
import type { 
  ServersConfig, 
  ServerConfig, 
  ResolvedServer, 
  ResolvedDeployment,
  EnvVars,
  SSHKeyConnection,
} from '../../types';
import { SERVER_DEFAULTS } from '../../types/servers';
import { 
  getCISecret, 
  serverNameToEnvKey, 
  mergeEnvVars,
  getServerPrivateKey,
  getServerPassword,
} from './ci-secrets';

/**
 * Resolve connection info for a server
 * Priority: servers.yml -> CI individual secrets -> CI connection string
 */
function resolveConnection(
  env: string,
  serverName: string,
  serverConfig: ServerConfig,
  defaults: { user: string; port: number }
): { host: string; port: number; user: string } | null {
  // Check for full connection string override first (highest priority)
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success) {
      return {
        host: result.data.host,
        port: result.data.port,
        user: result.data.user,
      };
    }
  }
  
  // Resolve individual components
  const host = getCISecret(env, serverName, 'HOST') ?? serverConfig.host;
  const userFromCI = getCISecret(env, serverName, 'USER');
  const portFromCI = getCISecret(env, serverName, 'PORT');
  
  // Host is required
  if (!host) {
    return null;
  }
  
  return {
    host,
    user: userFromCI ?? serverConfig.user ?? defaults.user,
    port: portFromCI ? parseInt(portFromCI, 10) : (serverConfig.port ?? defaults.port),
  };
}

/**
 * Resolve all servers for a given environment/tag
 */
export function resolveServersForEnvironment(environment: string): ResolvedServer[] {
  const config = loadServersConfig();
  if (!config) {
    return [];
  }
  
  const defaults = {
    user: config.defaults?.user ?? SERVER_DEFAULTS.user,
    port: config.defaults?.port ?? SERVER_DEFAULTS.port,
  };
  
  const resolvedServers: ResolvedServer[] = [];
  
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    // Check if this server has the requested tag
    if (!serverConfig.tags.includes(environment)) {
      continue;
    }
    
    // Resolve connection info
    const connection = resolveConnection(environment, serverName, serverConfig, defaults);
    if (!connection) {
      console.warn(`Warning: Server "${serverName}" has no host configured and no CI secret found.`);
      console.warn(`  Expected CI secret: ${environment.toUpperCase()}_${serverNameToEnvKey(serverName)}_CONNECTION`);
      console.warn(`  If this repo is in a GitHub organization, fork the dockflow repository to your organization.`);
      console.warn(`  See: https://dockflow.shawiizz.dev/getting-started#copy-ci-config-file`);
      continue;
    }
    
    // Merge environment variables
    const envVars = mergeEnvVars(config, environment, serverName, serverConfig.env);
    
    resolvedServers.push({
      name: serverName,
      role: serverConfig.role ?? 'manager',
      host: connection.host,
      port: connection.port,
      user: connection.user,
      env: envVars,
      tags: serverConfig.tags,
    });
  }
  
  return resolvedServers;
}

/**
 * Resolve a specific server by name
 */
export function resolveServerByName(serverName: string, environment: string): ResolvedServer | null {
  const config = loadServersConfig();
  if (!config) {
    return null;
  }
  
  const serverConfig = config.servers[serverName];
  if (!serverConfig) {
    return null;
  }
  
  // Verify the server has the requested tag
  if (!serverConfig.tags.includes(environment)) {
    return null;
  }
  
  const defaults = {
    user: config.defaults?.user ?? SERVER_DEFAULTS.user,
    port: config.defaults?.port ?? SERVER_DEFAULTS.port,
  };
  
  const connection = resolveConnection(environment, serverName, serverConfig, defaults);
  if (!connection) {
    return null;
  }
  
  const envVars = mergeEnvVars(config, environment, serverName, serverConfig.env);
  
  return {
    name: serverName,
    role: serverConfig.role ?? 'manager',
    host: connection.host,
    port: connection.port,
    user: connection.user,
    env: envVars,
    tags: serverConfig.tags,
  };
}

/**
 * Get ALL manager servers for an environment (for multi-manager HA)
 */
export function getManagersForEnvironment(environment: string): ResolvedServer[] {
  const servers = resolveServersForEnvironment(environment);
  return servers.filter(s => s.role === 'manager');
}

/**
 * Get worker servers for an environment
 */
export function getWorkersForEnvironment(environment: string): ResolvedServer[] {
  const servers = resolveServersForEnvironment(environment);
  return servers.filter(s => s.role === 'worker');
}

/**
 * Resolve complete deployment info for an environment
 * Returns manager(s) and workers, ready for deployment
 * 
 * Multi-manager support:
 * - If multiple managers defined, the first one is used as primary target
 * - Use findActiveManager() for failover detection
 */
export function resolveDeploymentForEnvironment(environment: string): ResolvedDeployment | null {
  const managers = getManagersForEnvironment(environment);
  if (managers.length === 0) {
    return null;
  }
  
  const workers = getWorkersForEnvironment(environment);
  
  return {
    manager: managers[0],  // Primary manager (first in list)
    managers,              // All managers for failover
    workers,
    environment,
  };
}

/**
 * Get list of all available environments (tags) from servers.yml
 */
export function getAvailableEnvironments(): string[] {
  const config = loadServersConfig();
  if (!config) {
    return [];
  }
  
  const tags = new Set<string>();
  for (const serverConfig of Object.values(config.servers)) {
    for (const tag of serverConfig.tags) {
      tags.add(tag);
    }
  }
  
  return Array.from(tags).sort();
}

/**
 * Get server names for a specific environment
 */
export function getServerNamesForEnvironment(environment: string): string[] {
  const config = loadServersConfig();
  if (!config) {
    return [];
  }
  
  return Object.entries(config.servers)
    .filter(([_, serverConfig]) => serverConfig.tags.includes(environment))
    .map(([name]) => name);
}

/**
 * Build full connection info (with private key) for a server
 */
export function getFullConnectionInfo(env: string, serverName: string): SSHKeyConnection | null {
  const server = resolveServerByName(serverName, env);
  if (!server) {
    return null;
  }
  
  const privateKey = getServerPrivateKey(env, serverName);
  if (!privateKey) {
    return null;
  }
  
  const password = getServerPassword(env, serverName);
  
  return {
    host: server.host,
    port: server.port,
    user: server.user,
    privateKey,
    password,
  };
}

/**
 * Get environment variables for a given environment (for build mode)
 * This doesn't require SSH connection, just merges env vars from servers.yml + CI secrets
 * Uses the first server with the matching tag to get the env vars
 */
export function getEnvVarsForEnvironment(environment: string): EnvVars {
  const config = loadServersConfig();
  if (!config) {
    return {};
  }
  
  // Find the first server with this environment tag
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.tags.includes(environment)) {
      return mergeEnvVars(config, environment, serverName, serverConfig.env);
    }
  }
  
  // No server found with this tag, just return global env vars
  const result: EnvVars = {};
  
  if (config.env?.all) {
    Object.assign(result, config.env.all);
  }
  
  if (config.env?.[environment]) {
    Object.assign(result, config.env[environment]);
  }
  
  return result;
}
