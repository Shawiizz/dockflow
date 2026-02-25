/**
 * Command Error Handling
 * 
 * Provides centralized error handling for CLI commands.
 * This module ensures consistent error messages and exit behavior
 * across all commands.
 */

import { printError, printWarning, printInfo, printSuccess, printBlank, printRaw, colors } from './output';

/**
 * CLI Error codes for different failure scenarios
 */
export enum ErrorCode {
  // General errors (1-9)
  UNKNOWN = 1,
  INTERRUPTED = 2,
  COMMAND_FAILED = 3,
  
  // Configuration errors (10-19)
  CONFIG_NOT_FOUND = 10,
  CONFIG_INVALID = 11,
  SERVERS_NOT_FOUND = 12,
  
  // Environment errors (20-29)
  ENV_NOT_FOUND = 20,
  NO_SERVERS_FOR_ENV = 21,
  
  // Connection errors (30-39)
  CONNECTION_FAILED = 30,
  SSH_KEY_NOT_FOUND = 31,
  SSH_AUTH_FAILED = 32,
  
  // Docker errors (40-49)
  DOCKER_NOT_AVAILABLE = 40,
  STACK_NOT_FOUND = 41,
  SERVICE_NOT_FOUND = 42,
  CONTAINER_NOT_FOUND = 43,
  
  // Deployment errors (50-59)
  DEPLOY_FAILED = 50,
  DEPLOY_LOCKED = 51,
  ROLLBACK_FAILED = 52,
  HEALTH_CHECK_FAILED = 53,
  
  // Validation errors (60-69)
  VALIDATION_FAILED = 60,
  INVALID_ARGUMENT = 61,
}

/**
 * Base CLI error class with structured information
 */
export class CLIError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode = ErrorCode.UNKNOWN,
    public readonly suggestion?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'CLIError';
  }

  /**
   * Create error from unknown thrown value
   */
  static from(error: unknown, code: ErrorCode = ErrorCode.UNKNOWN): CLIError {
    if (error instanceof CLIError) {
      return error;
    }
    if (error instanceof Error) {
      return new CLIError(error.message, code, undefined, error);
    }
    return new CLIError(String(error), code);
  }
}

/**
 * Specific error types for common scenarios
 */
export class ConfigError extends CLIError {
  constructor(message: string, suggestion?: string) {
    super(message, ErrorCode.CONFIG_INVALID, suggestion);
    this.name = 'ConfigError';
  }
}

export class ConnectionError extends CLIError {
  constructor(message: string, suggestion?: string) {
    super(message, ErrorCode.CONNECTION_FAILED, suggestion);
    this.name = 'ConnectionError';
  }
}

export class DockerError extends CLIError {
  constructor(message: string, options?: { code?: ErrorCode; suggestion?: string } | ErrorCode) {
    if (typeof options === 'number') {
      // Legacy: second param is ErrorCode
      super(message, options, undefined);
    } else {
      // New: second param is options object
      super(message, options?.code ?? ErrorCode.DOCKER_NOT_AVAILABLE, options?.suggestion);
    }
    this.name = 'DockerError';
  }
}

export class DeployError extends CLIError {
  constructor(message: string, code: ErrorCode = ErrorCode.DEPLOY_FAILED, suggestion?: string) {
    super(message, code, suggestion);
    this.name = 'DeployError';
  }
}

export class ValidationError extends CLIError {
  constructor(message: string, suggestion?: string) {
    super(message, ErrorCode.VALIDATION_FAILED, suggestion);
    this.name = 'ValidationError';
  }
}

/**
 * Format error for display
 */
export function formatError(error: CLIError): string {
  const lines: string[] = [];
  
  lines.push(colors.error(`Error: ${error.message}`));
  
  if (error.suggestion) {
    lines.push(colors.dim(`  → ${error.suggestion}`));
  }
  
  if (process.env.DEBUG && error.cause) {
    lines.push(colors.dim(`  Caused by: ${error.cause.message}`));
    if (error.cause.stack) {
      lines.push(colors.dim(error.cause.stack));
    }
  }
  
  return lines.join('\n');
}

/**
 * Handle error and exit process
 * This is the ONLY place that should call process.exit for errors
 */
export function handleError(error: unknown): never {
  const cliError = CLIError.from(error);
  
  printBlank();
  printRaw(formatError(cliError));
  printBlank();
  
  process.exit(cliError.code);
}

/**
 * Type for async command action handlers
 */
export type CommandAction<T extends unknown[] = unknown[]> = (...args: T) => Promise<void>;

/**
 * Wrap a command action with error handling
 * 
 * This wrapper:
 * 1. Catches all errors thrown by the action
 * 2. Converts them to CLIError if needed
 * 3. Formats and displays the error
 * 4. Exits with appropriate code
 * 
 * Usage:
 * ```typescript
 * .action(withErrorHandler(async (env, options) => {
 *   // Command logic - just throw errors, don't call process.exit
 *   if (!valid) throw new ValidationError('Invalid input');
 * }))
 * ```
 */
export function withErrorHandler<T extends unknown[]>(
  action: CommandAction<T>
): CommandAction<T> {
  return async (...args: T): Promise<void> => {
    try {
      await action(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

/**
 * Exit successfully with optional message
 */
export function exitSuccess(message?: string): never {
  if (message) {
    printSuccess(message);
  }
  process.exit(0);
}

/**
 * Assert condition or throw CLIError
 */
export function assertOrThrow(
  condition: unknown,
  message: string,
  code: ErrorCode = ErrorCode.VALIDATION_FAILED,
  suggestion?: string
): asserts condition {
  if (!condition) {
    throw new CLIError(message, code, suggestion);
  }
}

/**
 * Wrap Result type errors into CLIError
 */
export function unwrapOrThrow<T>(
  result: { success: true; data: T } | { success: false; error: Error },
  code: ErrorCode = ErrorCode.UNKNOWN,
  suggestion?: string
): T {
  if (result.success) {
    return result.data;
  }
  throw new CLIError(result.error.message, code, suggestion, result.error);
}
