/**
 * Utils barrel export
 */

// Core utilities
export * from './config';
export * from './output';
export * from './git';
export * from './version';

// Error handling
export * from './errors';

// Server resolution utilities
export * from './servers';

// SSH and connection utilities
export * from './ssh-keys';
export * from './connection-parser';
export { sshExec, sshExecStream, sshShell, executeInteractiveSSH, testConnection } from './ssh';

// Secrets loading (for CI environments)
export * from './secrets';

// Validation helpers - exclude ValidationError to avoid conflict with errors.ts
export { 
  validateEnvironment, 
  validateEnv, 
  validateEnvOrExit, 
  isValidationError,
  ValidationErrorType,
  type EnvironmentContext,
  type ValidationError as LegacyValidationError 
} from './validation';
