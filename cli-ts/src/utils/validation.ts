/**
 * Environment Validation Helpers
 * 
 * Provides reusable validation for deployment environment configuration,
 * returning typed errors instead of exiting the process.
 */

import { loadConfig, getStackName, hasServersConfig, type DockflowConfig } from './config';
import { 
  resolveServersForEnvironment, 
  getFullConnectionInfo,
  getServerNamesForEnvironment,
  getAvailableEnvironments
} from './servers';
import { printError, printInfo } from './output';
import { loadSecrets } from './secrets';
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
 * Validation error types
 */
export enum ValidationErrorType {
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  PROJECT_NAME_MISSING = 'PROJECT_NAME_MISSING',
  SERVERS_NOT_FOUND = 'SERVERS_NOT_FOUND',
  NO_SERVERS_FOR_ENV = 'NO_SERVERS_FOR_ENV',
  CONNECTION_NOT_FOUND = 'CONNECTION_NOT_FOUND',
}

/**
 * Validation error with actionable message
 */
export interface ValidationError {
  type: ValidationErrorType;
  message: string;
  suggestion?: string;
}

/**
 * Validate environment and return context or null
 * Does NOT exit process - caller decides what to do on failure
 * Uses the first server for the environment by default
 */
export function validateEnvironment(env: string, serverName?: string): EnvironmentContext | ValidationError {
  // Load secrets from .env.dockflow or CI environment
  loadSecrets();

  // Check config exists
  const config = loadConfig();
  if (!config) {
    return {
      type: ValidationErrorType.CONFIG_NOT_FOUND,
      message: '.deployment/config.yml not found',
      suggestion: 'Run "dockflow init" to create project structure',
    };
  }

  // Check project name
  const stackName = getStackName(env);
  if (!stackName) {
    return {
      type: ValidationErrorType.PROJECT_NAME_MISSING,
      message: 'project_name not found in config.yml',
      suggestion: 'Add project_name to your .deployment/config.yml',
    };
  }

  // Check servers.yml exists
  if (!hasServersConfig()) {
    return {
      type: ValidationErrorType.SERVERS_NOT_FOUND,
      message: '.deployment/servers.yml not found',
      suggestion: 'Create servers.yml to define your deployment servers',
    };
  }

  // Get servers for this environment
  const servers = resolveServersForEnvironment(env);
  if (servers.length === 0) {
    const availableEnvs = getAvailableEnvironments();
    return {
      type: ValidationErrorType.NO_SERVERS_FOR_ENV,
      message: `No servers found with tag "${env}"`,
      suggestion: availableEnvs.length > 0 
        ? `Available environments: ${availableEnvs.join(', ')}`
        : 'Add servers with the appropriate tags to servers.yml',
    };
  }

  // Use specified server or first server
  const targetServerName = serverName || servers[0].name;
  
  // Get full connection info (with private key)
  const connection = getFullConnectionInfo(env, targetServerName);
  if (!connection) {
    return {
      type: ValidationErrorType.CONNECTION_NOT_FOUND,
      message: `No SSH credentials found for server "${targetServerName}"`,
      suggestion: `Add CI secret: ${env.toUpperCase()}_${targetServerName.toUpperCase()}_CONNECTION\n  or: ${env.toUpperCase()}_${targetServerName.toUpperCase()}_SSH_PRIVATE_KEY`,
    };
  }

  return { config, stackName, connection, env, serverName: targetServerName };
}

/**
 * Type guard for ValidationError
 */
export function isValidationError(result: EnvironmentContext | ValidationError): result is ValidationError {
  return 'type' in result && 'message' in result;
}

/**
 * Validate environment with process exit on failure
 * For backwards compatibility with existing command handlers
 */
export async function validateEnvOrExit(env: string, serverName?: string): Promise<EnvironmentContext> {
  const result = validateEnvironment(env, serverName);
  
  if (isValidationError(result)) {
    printError(result.message);
    if (result.suggestion) {
      printInfo(result.suggestion);
    }
    process.exit(1);
  }
  
  return result;
}
