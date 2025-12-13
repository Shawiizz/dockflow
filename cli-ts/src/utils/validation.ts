/**
 * Environment Validation Helpers
 * 
 * Provides reusable validation for deployment environment configuration,
 * returning typed errors instead of exiting the process.
 */

import { loadConfig, getConnectionInfo, getStackName, type DockflowConfig } from './config';
import { printError, printInfo } from './output';
import type { SSHKeyConnection } from '../types';

/**
 * Validation result containing all necessary deployment context
 */
export interface EnvironmentContext {
  config: DockflowConfig;
  stackName: string;
  connection: SSHKeyConnection;
  env: string;
}

/**
 * Validation error types
 */
export enum ValidationErrorType {
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  PROJECT_NAME_MISSING = 'PROJECT_NAME_MISSING',
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
 */
export function validateEnvironment(env: string): EnvironmentContext | ValidationError {
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

  // Check connection
  const connection = getConnectionInfo(env);
  if (!connection) {
    return {
      type: ValidationErrorType.CONNECTION_NOT_FOUND,
      message: `.env.dockflow not found or ${env.toUpperCase()}_CONNECTION missing`,
      suggestion: `Add connection string to .env.dockflow:\n  ${env.toUpperCase()}_CONNECTION=<base64-encoded-string>`,
    };
  }

  return { config, stackName, connection, env };
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
export async function validateEnvOrExit(env: string): Promise<EnvironmentContext> {
  const result = validateEnvironment(env);
  
  if (isValidationError(result)) {
    printError(result.message);
    if (result.suggestion) {
      printInfo(result.suggestion);
    }
    process.exit(1);
  }
  
  return result;
}
