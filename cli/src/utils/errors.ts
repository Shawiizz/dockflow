/**
 * Command Error Handling
 * 
 * Provides centralized error handling for CLI commands.
 * This module ensures consistent error messages and exit behavior
 * across all commands.
 */

import type { Diagnostic } from '../services/orchestrator/diagnostics';
import { printBlank, colors } from './output';
import { closeAllConnections } from './ssh';
import { loadConfig } from './config';

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
  
  // Orchestrator errors (40-49)
  DOCKER_NOT_AVAILABLE = 40,
  STACK_NOT_FOUND = 41,
  SERVICE_NOT_FOUND = 42,
  CONTAINER_NOT_FOUND = 43,
  ORCHESTRATOR_UNAVAILABLE = 44,

  // Deployment errors (50-59)
  DEPLOY_FAILED = 50,
  DEPLOY_LOCKED = 51,
  ROLLBACK_FAILED = 52,
  HEALTH_CHECK_FAILED = 53,
  
  // Validation errors (60-69)
  VALIDATION_FAILED = 60,
  INVALID_ARGUMENT = 61,
  UNSUPPORTED_OPERATION = 62,

  // Backup errors (70-79)
  BACKUP_FAILED = 70,
  BACKUP_NOT_FOUND = 71,
  RESTORE_FAILED = 72,
  BACKUP_CONFIG_MISSING = 73,
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
  constructor(message: string, options?: { code?: ErrorCode; suggestion?: string }) {
    super(message, options?.code ?? ErrorCode.DOCKER_NOT_AVAILABLE, options?.suggestion);
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

export class BackupError extends CLIError {
  constructor(message: string, options?: { code?: ErrorCode; suggestion?: string }) {
    super(message, options?.code ?? ErrorCode.BACKUP_FAILED, options?.suggestion);
    this.name = 'BackupError';
  }
}

/** kubectl/helm/docker missing, kubeconfig unreadable, API unreachable, identity rejected. */
export class OrchestratorUnavailableError extends CLIError {
  constructor(message: string, suggestion?: string, cause?: Error) {
    super(message, ErrorCode.ORCHESTRATOR_UNAVAILABLE, suggestion, cause);
    this.name = 'OrchestratorUnavailableError';
  }
}

/** Raised by requireCapability / requireCapabilityFor before any remote work. */
export class UnsupportedOperationError extends CLIError {
  constructor(message: string, suggestion?: string) {
    super(message, ErrorCode.UNSUPPORTED_OPERATION, suggestion);
    this.name = 'UnsupportedOperationError';
  }
}

/**
 * A user command inside a container exited non-zero. Not a CLIError: ErrorCode values double as
 * process exit codes, so a container's 62 would read as UNSUPPORTED_OPERATION. withErrorHandler
 * passes the code through as process.exitCode instead.
 */
export class ExecExitError extends Error {
  constructor(public readonly exitCode: number) {
    super(`Command exited with code ${exitCode}`);
    this.name = 'ExecExitError';
  }
}

const MAX_LISTED_DIAGNOSTICS = 20;

/**
 * Compose or x-dockflow problems found at render. Declared here and re-exported by
 * services/orchestrator/diagnostics.ts: the reverse (a class extending CLIError in a module this
 * one re-exports from) is an import cycle that throws whenever this module loads first.
 */
export class ComposeTranslationError extends CLIError {
  constructor(
    message: string,
    suggestion: string,
    public readonly diagnostics: Diagnostic[],
  ) {
    super(message, ErrorCode.VALIDATION_FAILED, suggestion);
    this.name = 'ComposeTranslationError';
  }

  static fromDiagnostics(file: string, kind: string, diagnostics: Diagnostic[]): ComposeTranslationError {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const lines = errors
      .slice(0, MAX_LISTED_DIAGNOSTICS)
      .map((d) => `${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`);
    if (errors.length > MAX_LISTED_DIAGNOSTICS) {
      lines.push(`... and ${errors.length - MAX_LISTED_DIAGNOSTICS} more`);
    }
    return new ComposeTranslationError(
      `${file} cannot be deployed with orchestrator: ${kind} (${errors.length} error(s))`,
      lines.join('\n'),
      diagnostics,
    );
  }
}

/**
 * Format error for display
 *
 * Stack trace visibility:
 * - Unexpected errors (non-CLIError): always shown
 * - Expected errors (CLIError): shown only when DEBUG or CI is set
 */
export function formatError(error: CLIError, isUnexpected = false): string {
  const lines: string[] = [];

  lines.push(colors.error(`Error: ${error.message}`));

  if (error.suggestion) {
    lines.push(colors.dim(`  → ${error.suggestion}`));
  }

  const showStack = isUnexpected || process.env.DEBUG || process.env.CI;

  if (showStack && error.cause) {
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
  const isUnexpected = !(error instanceof CLIError);
  const cliError = CLIError.from(error);

  printBlank();
  process.stderr.write(formatError(cliError, isUnexpected) + '\n');
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
      // The container already wrote its own stderr; return normally so the finally still runs.
      if (error instanceof ExecExitError) {
        process.exitCode = error.exitCode;
        return;
      }
      handleError(error);
    } finally {
      closeAllConnections();
    }
  };
}

/** Wraps withErrorHandler and blocks execution when the project is configured as no_services. */
export function withServicesRequired<T extends unknown[]>(
  action: CommandAction<T>
): CommandAction<T> {
  return withErrorHandler(async (...args: T): Promise<void> => {
    if (loadConfig()?.no_services) {
      throw new DeployError(
        'This command requires services',
        ErrorCode.VALIDATION_FAILED,
        'This project is configured as no_services and has no services.',
      );
    }
    await action(...args);
  });
}
