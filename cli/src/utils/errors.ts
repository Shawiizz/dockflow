/** The CLI's error types, how an error is shown, and the one place a failing command exits. */

import { printBlank, colors } from './output';
import { closeAllConnections } from './ssh';
import { loadConfig } from './config';

/** Doubles as the process exit code, grouped by tens. */
export enum ErrorCode {
  // General errors (1-9), and 130 for an interrupt
  UNKNOWN = 1,
  INTERRUPTED = 130,
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
  HOST_KEY_CHANGED = 33,

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

  // Backup errors (70-79)
  BACKUP_FAILED = 70,
  BACKUP_NOT_FOUND = 71,
  RESTORE_FAILED = 72,
  BACKUP_CONFIG_MISSING = 73,
}

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

  /** A CLIError passes through unchanged; anything else is wrapped with `code`. */
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

export class ConfigError extends CLIError {
  constructor(message: string, suggestion?: string) {
    super(message, ErrorCode.CONFIG_INVALID, suggestion);
    this.name = 'ConfigError';
  }
}

export class ConnectionError extends CLIError {
  constructor(message: string, suggestion?: string, code: ErrorCode = ErrorCode.CONNECTION_FAILED) {
    super(message, code, suggestion);
    this.name = 'ConnectionError';
  }
}

export class DockerError extends CLIError {
  constructor(message: string, options?: { code?: ErrorCode; suggestion?: string }) {
    super(message, options?.code ?? ErrorCode.COMMAND_FAILED, options?.suggestion);
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

/** The cause and its stack are shown for unexpected errors, and for expected ones only when DEBUG or CI is set. */
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
 * A command run inside a container exited non-zero. Not a CLIError: error codes double as exit
 * codes, so a container's 62 would read as INVALID_ARGUMENT. Its code is passed on silently.
 */
export class ExecExitError extends Error {
  constructor(public readonly exitCode: number) {
    super(`Command exited with code ${exitCode}`);
    this.name = 'ExecExitError';
  }
}

/** Prints the error and exits with its code; the one place a failing command exits. */
export function handleError(error: unknown): never {
  if (error instanceof ExecExitError) process.exit(error.exitCode);
  const isUnexpected = !(error instanceof CLIError);
  const cliError = CLIError.from(error);

  printBlank();
  process.stderr.write(formatError(cliError, isUnexpected) + '\n');
  printBlank();

  process.exit(cliError.code);
}

export type CommandAction<T extends unknown[] = unknown[]> = (...args: T) => Promise<void>;

/**
 * Wraps a command action: whatever it throws goes through handleError, and the SSH connections
 * are closed afterwards either way. The action throws instead of calling process.exit.
 */
export function withErrorHandler<T extends unknown[]>(
  action: CommandAction<T>
): CommandAction<T> {
  return async (...args: T): Promise<void> => {
    try {
      await action(...args);
    } catch (error) {
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
        'This command requires Docker services',
        ErrorCode.VALIDATION_FAILED,
        'This project is configured as no_services and has no Docker services.',
      );
    }
    await action(...args);
  });
}
