/**
 * CI Secrets resolution utilities
 * 
 * Handles resolving secrets from CI environment variables.
 * Supports both connection strings and individual secret overrides.
 * 
 * Pattern: ENV_SERVERNAME_VARNAME (e.g., PRODUCTION_MAIN_HOST)
 */

import { parseConnectionString } from '../connection-parser';
import type { ServersConfig, EnvVars } from '../../types';

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
 * 
 * Priority: ENV_SERVERNAME_VAR > ENV_VAR
 */
export function getCISecret(env: string, serverName: string | null, varName: string): string | undefined {
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
 * Get SSH private key for a server from CI secrets
 * 
 * Checks:
 * 1. CONNECTION string (contains privateKey)
 * 2. SSH_PRIVATE_KEY individual secret
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
 * Merge environment variables with proper priority
 * Priority: all -> tag -> server.env -> CI (ENV_VAR) -> CI (ENV_SERVER_VAR)
 * 
 * @param config - The servers configuration
 * @param tag - The environment tag (e.g., "production")
 * @param serverName - The server name
 * @param serverEnv - Server-specific env vars from servers.yml
 */
export function mergeEnvVars(
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
