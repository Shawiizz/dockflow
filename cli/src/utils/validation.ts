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
  getManagersForEnvironment,
  findActiveManager,
} from './servers';
import { printWarning } from './output';
import { loadSecrets } from './secrets';
import {
  CLIError,
  ConnectionError,
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

export interface ServerChoice {
  /** any server of the environment may be named or picked, workers included (`dockflow ssh`) */
  anyServer?: boolean;
}

/**
 * The server a command talks to: the named one, which must be a manager unless `anyServer`, or the
 * first manager this machine has credentials for (a worker listed first used to be picked).
 */
export function chooseServer(
  env: string,
  servers: readonly { name: string; role: string }[],
  serverName: string | undefined,
  choice: ServerChoice,
  hasCredentials: (name: string) => boolean,
): { name: string } | ValidationError {
  const eligible = choice.anyServer ? servers : servers.filter((s) => s.role === 'manager');
  if (serverName) {
    const named = servers.find((s) => s.name === serverName);
    if (named && eligible.includes(named)) return { name: named.name };
    return {
      type: ValidationErrorType.NO_SERVERS_FOR_ENV,
      message: named
        ? `Server "${serverName}" is a worker; this command runs on a manager`
        : `No server named "${serverName}" for environment ${env}`,
      suggestion: `${choice.anyServer ? 'Servers' : 'Managers'}: ${eligible.map((s) => s.name).join(', ') || 'none'}`,
    };
  }
  if (eligible.length === 0) {
    return {
      type: ValidationErrorType.NO_SERVERS_FOR_ENV,
      message: `No manager for environment ${env}`,
      suggestion: 'Give one of its servers role: manager in servers.yml',
    };
  }
  return { name: (eligible.find((s) => hasCredentials(s.name)) ?? eligible[0]).name };
}

/**
 * Validate environment and return context or error
 * Does NOT exit process - caller decides what to do on failure
 */
export function validateEnvironment(env: string, serverName?: string, choice: ServerChoice = {}): EnvironmentContext | ValidationError {
  // Load secrets from .env.dockflow or CI environment
  loadSecrets();

  // Check config exists
  const layout = getLayout();
  const flat = layout.type === 'flat';

  const config = loadConfig({ strict: true });
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

  const chosen = chooseServer(resolvedEnv, servers, serverName, choice, (name) => getFullConnectionInfo(resolvedEnv, name) !== null);
  if ('type' in chosen) return chosen;
  const targetServerName = chosen.name;

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
export function validateEnv(env: string, serverName?: string, choice: ServerChoice = {}): EnvironmentContext {
  const result = validateEnvironment(env, serverName, choice);

  if (isValidationError(result)) {
    throw toCliError(result);
  }

  return result;
}

/**
 * `validateEnv` for a command that talks to Swarm: with several managers and none named, the one
 * that takes Swarm commands now (the leader first), so a manager down does not stop the command.
 */
export async function resolveEnv(env: string, serverName?: string): Promise<EnvironmentContext> {
  const ctx = validateEnv(env, serverName);
  if (serverName) return ctx;

  const managers = getManagersForEnvironment(ctx.env);
  if (managers.length < 2) return ctx;

  const active = await findActiveManager(ctx.env, managers);
  if (!active) {
    throw new ConnectionError(
      `No manager of ${ctx.env} takes Swarm commands`,
      `Managers tried: ${managers.map((m) => `${m.name} (${m.host})`).join(', ')}`,
    );
  }
  if (active.failedManagers.length > 0) {
    printWarning(`Using ${active.manager.name}; not available: ${active.failedManagers.join(', ')}`);
  }
  const connection = getFullConnectionInfo(ctx.env, active.manager.name);
  return connection ? { ...ctx, connection, serverName: active.manager.name } : ctx;
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
