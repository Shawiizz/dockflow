/**
 * Environment Validation Helpers
 * 
 * Provides reusable validation for deployment environment configuration,
 * returning typed errors instead of exiting the process.
 */

import { loadConfig, getStackName, hasServersConfig, getLayout, type DockflowConfig } from './config';
import {
  resolveServersForEnvironment,
  getFullConnectionInfo,
  getAvailableEnvironments,
  getAllNodeConnections,
} from './servers';
import { loadSecrets } from './secrets';
import {
  CLIError,
  ErrorCode
} from './errors';
import type { SSHKeyConnection } from '../types';

/**
 * Validation result containing all necessary deployment context
 */
export interface EnvironmentContext {
  config: DockflowConfig;
  stackName: string;
  connection: SSHKeyConnection;
  env: string;
  serverName: string;
}

/**
 * Internal validation error types (used by validateEnvironment)
 */
enum ValidationErrorType {
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  PROJECT_NAME_MISSING = 'PROJECT_NAME_MISSING',
  SERVERS_NOT_FOUND = 'SERVERS_NOT_FOUND',
  NO_SERVERS_FOR_ENV = 'NO_SERVERS_FOR_ENV',
  CONNECTION_NOT_FOUND = 'CONNECTION_NOT_FOUND',
}

/**
 * Internal validation error structure
 */
interface ValidationError {
  type: ValidationErrorType;
  message: string;
  suggestion?: string;
}

/**
 * Resolve an environment name from a prefix.
 * Returns the exact env if found, or the unique prefix match.
 * Throws CLIError on ambiguous or no match.
 */
export function resolveEnvironmentPrefix(env: string): string {
  const availableEnvs = getAvailableEnvironments();
  if (availableEnvs.includes(env)) return env;

  const matches = availableEnvs.filter(e => e.startsWith(env));
  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    throw new CLIError(
      `Ambiguous environment prefix "${env}"`,
      ErrorCode.NO_SERVERS_FOR_ENV,
      `Matches: ${matches.join(', ')}`,
    );
  }

  // No match — return as-is and let downstream validation handle the error
  return env;
}

/**
 * Validate environment and return context or error
 * Does NOT exit process - caller decides what to do on failure
 * Uses the first server for the environment by default
 */
export function validateEnvironment(env: string, serverName?: string): EnvironmentContext | ValidationError {
  // Load secrets from .env.dockflow or CI environment
  loadSecrets();

  // Check config exists
  const layout = getLayout();
  const flat = layout.type === 'flat';

  const config = loadConfig();
  if (!config) {
    return {
      type: ValidationErrorType.CONFIG_NOT_FOUND,
      message: flat ? 'dockflow.yml is invalid or missing' : '.dockflow/config.yml not found',
      suggestion: 'Run "dockflow init" to create project structure',
    };
  }

  // Check servers config exists
  if (!hasServersConfig()) {
    return {
      type: ValidationErrorType.SERVERS_NOT_FOUND,
      message: flat ? 'No servers defined in dockflow.yml' : '.dockflow/servers.yml not found',
      suggestion: flat ? 'Add a servers block to dockflow.yml' : 'Create .dockflow/servers.yml to define your deployment servers',
    };
  }

  // Resolve prefix matching (pr → production)
  const resolvedEnv = resolveEnvironmentPrefix(env);

  // Check project name
  const stackName = getStackName(resolvedEnv);
  if (!stackName) {
    return {
      type: ValidationErrorType.PROJECT_NAME_MISSING,
      message: 'project_name not set',
      suggestion: flat ? 'Add project_name to your dockflow.yml' : 'Add project_name to your .dockflow/config.yml',
    };
  }

  // Get servers for this environment
  const servers = resolveServersForEnvironment(resolvedEnv);
  if (servers.length === 0) {
    const envs = getAvailableEnvironments();
    return {
      type: ValidationErrorType.NO_SERVERS_FOR_ENV,
      message: `No servers found with tag "${env}"`,
      suggestion: envs.length > 0
        ? `Available environments: ${envs.join(', ')}`
        : 'Add servers with the appropriate tags to servers.yml',
    };
  }

  // Use specified server or first server
  const targetServerName = serverName || servers[0].name;

  // Get full connection info (with private key)
  const connection = getFullConnectionInfo(resolvedEnv, targetServerName);
  if (!connection) {
    return {
      type: ValidationErrorType.CONNECTION_NOT_FOUND,
      message: `No SSH credentials found for server "${targetServerName}"`,
      suggestion: `Add CI secret: ${resolvedEnv.toUpperCase()}_${targetServerName.toUpperCase()}_CONNECTION\n  or: ${resolvedEnv.toUpperCase()}_${targetServerName.toUpperCase()}_SSH_PRIVATE_KEY`,
    };
  }

  return { config, stackName, connection, env: resolvedEnv, serverName: targetServerName };
}

/**
 * Type guard for ValidationError
 */
export function isValidationError(result: EnvironmentContext | ValidationError): result is ValidationError {
  return 'type' in result && 'message' in result;
}

function toCliError(error: ValidationError): CLIError {
  const codeMap: Record<ValidationErrorType, ErrorCode> = {
    [ValidationErrorType.CONFIG_NOT_FOUND]: ErrorCode.CONFIG_NOT_FOUND,
    [ValidationErrorType.PROJECT_NAME_MISSING]: ErrorCode.CONFIG_INVALID,
    [ValidationErrorType.SERVERS_NOT_FOUND]: ErrorCode.SERVERS_NOT_FOUND,
    [ValidationErrorType.NO_SERVERS_FOR_ENV]: ErrorCode.NO_SERVERS_FOR_ENV,
    [ValidationErrorType.CONNECTION_NOT_FOUND]: ErrorCode.SSH_KEY_NOT_FOUND,
  };
  
  return new CLIError(error.message, codeMap[error.type], error.suggestion);
}

/**
 * Validate environment and throw CLIError on failure
 * Preferred for use with withErrorHandler
 */
export function validateEnv(env: string, serverName?: string): EnvironmentContext {
  const result = validateEnvironment(env, serverName);

  if (isValidationError(result)) {
    throw toCliError(result);
  }

  return result;
}

/**
 * Wrapper that resolves an environment prefix before calling the handler.
 * Composes with withErrorHandler:
 *   .action(withErrorHandler(withResolvedEnv(async (env, service, options) => { ... })))
 *
 * Assumes the first argument is always the env string (Commander positional arg).
 */
export function withResolvedEnv<A extends unknown[]>(
  fn: (env: string, ...args: A) => Promise<void>,
): (env: string, ...args: A) => Promise<void> {
  return (env: string, ...args: A) => fn(resolveEnvironmentPrefix(env), ...args);
}

// Re-export for CLI commands that need all node connections after validateEnv()
export { getAllNodeConnections };
