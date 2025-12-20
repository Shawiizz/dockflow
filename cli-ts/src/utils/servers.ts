/**
 * Server resolution utilities
 * Handles resolving servers and merging environment variables from servers.yml + CI secrets
 * 
 * Architecture: Docker Swarm cluster per environment
 * - One or more managers per environment (multi-manager for HA)
 * - Zero or more workers (join the swarm, receive workloads)
 * - Deploy targets the leader manager, with failover to other managers
 */

import { loadServersConfig } from './config';
import { parseConnectionString } from './connection-parser';
import { sshExec } from './ssh';
import type { 
  ServersConfig, 
  ServerConfig, 
  ResolvedServer, 
  ResolvedDeployment,
  EnvVars,
  SSHKeyConnection,
  ServerRole
} from '../types';
import { SERVER_DEFAULTS } from '../types/servers';

/**
 * Convert server name to CI secret format
 * e.g., "main_server" -> "MAIN_SERVER"
 */
export function serverNameToEnvKey(name: string): string {
  return name.toUpperCase();
}

/**
 * Get CI secret value from environment
 * Checks for ENV_SERVERNAME_VARNAME pattern
 */
function getCISecret(env: string, serverName: string | null, varName: string): string | undefined {
  const envUpper = env.toUpperCase();
  const serverKey = serverName ? serverNameToEnvKey(serverName) : null;
  
  // Priority: ENV_SERVERNAME_VAR > ENV_VAR
  if (serverKey) {
    const keyName = `${envUpper}_${serverKey}_${varName}`;
    const serverSpecific = process.env[keyName];
    if (serverSpecific !== undefined && serverSpecific !== '') {
      return serverSpecific;
    }
  }
  
  return process.env[`${envUpper}_${varName}`];
}

/**
 * Merge environment variables with proper priority
 * Priority: all -> tag -> server.env -> CI (ENV_VAR) -> CI (ENV_SERVER_VAR)
 */
function mergeEnvVars(
  config: ServersConfig,
  tag: string,
  serverName: string,
  serverEnv: EnvVars | undefined
): EnvVars {
  const result: EnvVars = {};
  
  // 1. Start with env.all
  if (config.env?.all) {
    Object.assign(result, config.env.all);
  }
  
  // 2. Override with env.[tag]
  if (config.env?.[tag]) {
    Object.assign(result, config.env[tag]);
  }
  
  // 3. Override with server-specific env
  if (serverEnv) {
    Object.assign(result, serverEnv);
  }
  
  // 4. Override with CI secrets (ENV_VARNAME and ENV_SERVERNAME_VARNAME)
  // We need to check all possible variables from the merged result
  // Plus any CI secrets that might add new variables
  const envUpper = tag.toUpperCase();
  const serverKey = serverNameToEnvKey(serverName);
  
  // Check all environment variables for CI overrides
  for (const [key, value] of Object.entries(process.env)) {
    // Match ENV_VARNAME pattern (but not ENV_SERVERNAME_VARNAME or system vars)
    const globalMatch = key.match(new RegExp(`^${envUpper}_([A-Z][A-Z0-9_]*)$`));
    if (globalMatch) {
      const varName = globalMatch[1];
      // Skip connection-related vars and server-specific vars
      if (!varName.startsWith(serverKey + '_') && 
          !['CONNECTION', 'HOST', 'USER', 'PORT', 'SSH_PRIVATE_KEY', 'PASSWORD'].includes(varName)) {
        result[varName] = value!;
      }
    }
    
    // Match ENV_SERVERNAME_VARNAME pattern
    const serverMatch = key.match(new RegExp(`^${envUpper}_${serverKey}_([A-Z][A-Z0-9_]*)$`));
    if (serverMatch) {
      const varName = serverMatch[1];
      // Skip connection-related vars
      if (!['CONNECTION', 'HOST', 'USER', 'PORT', 'SSH_PRIVATE_KEY', 'PASSWORD'].includes(varName)) {
        result[varName] = value!;
      }
    }
  }
  
  return result;
}

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
 * Get SSH private key for a server from CI secrets
 */
export function getServerPrivateKey(env: string, serverName: string): string | undefined {
  // Check for connection string first
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success) {
      return result.data.privateKey;
    }
  }
  
  // Fall back to individual SSH key secret
  return getCISecret(env, serverName, 'SSH_PRIVATE_KEY');
}

/**
 * Get password for a server from CI secrets (for sudo)
 */
export function getServerPassword(env: string, serverName: string): string | undefined {
  // Check for connection string first
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success) {
      return result.data.password;
    }
  }
  
  // Fall back to individual password secret
  return getCISecret(env, serverName, 'PASSWORD');
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
      console.warn(`  Expected CI secret: ${environment.toUpperCase()}_${serverNameToEnvKey(serverName)}_HOST`);
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
 * Get the manager server for an environment
 * Returns the first manager (use getManagersForEnvironment for multi-manager)
 */
export function getManagerForEnvironment(environment: string): ResolvedServer | null {
  const managers = getManagersForEnvironment(environment);
  return managers.length > 0 ? managers[0] : null;
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
 * Get all servers (manager + workers) for an environment
 */
export function getAllServersForEnvironment(environment: string): ResolvedServer[] {
  const deployment = resolveDeploymentForEnvironment(environment);
  if (!deployment) {
    return [];
  }
  
  return [deployment.manager, ...deployment.workers];
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
 * Get list of all server names from servers.yml
 */
export function getServerNames(): string[] {
  const config = loadServersConfig();
  if (!config) {
    return [];
  }
  
  return Object.keys(config.servers);
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
 * Check if a manager is reachable and get its Swarm status
 * Returns: 'leader' | 'reachable' | 'unreachable'
 */
export function checkManagerStatus(
  connection: SSHKeyConnection
): 'leader' | 'reachable' | 'unreachable' {
  try {
    // Quick connectivity check + Swarm leader status
    const result = sshExec(connection, 
      'docker info --format "{{.Swarm.ControlAvailable}}" 2>/dev/null || echo "error"'
    );
    
    if (result.exitCode !== 0 || result.stdout.trim() === 'error') {
      return 'unreachable';
    }
    
    // ControlAvailable = true means this node can accept manager commands
    // It may or may not be the leader, but it can handle deployments
    const controlAvailable = result.stdout.trim().toLowerCase() === 'true';
    
    if (controlAvailable) {
      // Check if this is specifically the leader
      const leaderCheck = sshExec(connection,
        'docker node inspect self --format "{{.ManagerStatus.Leader}}" 2>/dev/null || echo "false"'
      );
      
      if (leaderCheck.stdout.trim().toLowerCase() === 'true') {
        return 'leader';
      }
      return 'reachable';
    }
    
    return 'reachable'; // Node is up but not a manager or Swarm not initialized
  } catch {
    return 'unreachable';
  }
}

/**
 * Find the active manager for deployment with failover
 * 
 * Strategy:
 * 1. Try each manager in order
 * 2. Prefer the leader if found
 * 3. Fall back to any reachable manager (Swarm will forward to leader)
 * 4. Return null if no managers are reachable
 */
export async function findActiveManager(
  env: string,
  managers: ResolvedServer[],
  options: { 
    verbose?: boolean;
    preferLeader?: boolean; // Default: true
  } = {}
): Promise<{ 
  manager: ResolvedServer; 
  status: 'leader' | 'reachable';
  failedManagers: string[];
} | null> {
  const { verbose = false, preferLeader = true } = options;
  const failedManagers: string[] = [];
  let firstReachable: { manager: ResolvedServer; status: 'leader' | 'reachable' } | null = null;
  
  for (const manager of managers) {
    const connection = getFullConnectionInfo(env, manager.name);
    if (!connection) {
      if (verbose) {
        console.log(`  ⚠ ${manager.name}: No SSH key configured`);
      }
      failedManagers.push(`${manager.name} (no SSH key)`);
      continue;
    }
    
    if (verbose) {
      process.stdout.write(`  Checking ${manager.name} (${manager.host})...`);
    }
    
    const status = checkManagerStatus(connection);
    
    if (status === 'unreachable') {
      if (verbose) {
        console.log(' ✗ unreachable');
      }
      failedManagers.push(`${manager.name} (unreachable)`);
      continue;
    }
    
    if (verbose) {
      console.log(status === 'leader' ? ' ✓ LEADER' : ' ✓ reachable');
    }
    
    // If this is the leader and we prefer leader, return immediately
    if (status === 'leader' && preferLeader) {
      return { manager, status, failedManagers };
    }
    
    // Store first reachable manager as fallback
    if (!firstReachable) {
      firstReachable = { manager, status };
    }
    
    // If we found the leader but don't prefer it, keep it as best option
    if (status === 'leader') {
      firstReachable = { manager, status };
    }
  }
  
  // Return first reachable manager if no leader found (or preferLeader=false)
  if (firstReachable) {
    return { ...firstReachable, failedManagers };
  }
  
  return null;
}

/**
 * Get the number of managers for an environment
 */
export function getManagerCount(environment: string): number {
  return getManagersForEnvironment(environment).length;
}
