import { describe, expect, it } from 'bun:test';
import {
  CLIError,
  ConfigError,
  ConnectionError,
  DeployError,
  ValidationError,
  BackupError,
  DockerError,
  ErrorCode,
  formatError,
} from '../utils/errors';

describe('CLIError hierarchy', () => {
  it('subclasses carry their default error codes', () => {
    expect(new ConfigError('x').code).toBe(ErrorCode.CONFIG_INVALID);
    expect(new ConnectionError('x').code).toBe(ErrorCode.CONNECTION_FAILED);
    expect(new DeployError('x').code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(new ValidationError('x').code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(new BackupError('x').code).toBe(ErrorCode.BACKUP_FAILED);
    expect(new DockerError('x').code).toBe(ErrorCode.DOCKER_NOT_AVAILABLE);
  });

  it('DeployError accepts a custom code', () => {
    const err = new DeployError('x', ErrorCode.HEALTH_CHECK_FAILED);
    expect(err.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
  });

  it('all subclasses are instanceof CLIError and Error', () => {
    for (const err of [new ConfigError('x'), new DeployError('x'), new BackupError('x')]) {
      expect(err).toBeInstanceOf(CLIError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe('CLIError.from', () => {
  it('returns CLIError instances unchanged', () => {
    const original = new ConfigError('cfg');
    expect(CLIError.from(original)).toBe(original);
  });

  it('wraps plain Error preserving message and cause', () => {
    const plain = new Error('boom');
    const wrapped = CLIError.from(plain, ErrorCode.DEPLOY_FAILED);
    expect(wrapped.message).toBe('boom');
    expect(wrapped.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(wrapped.cause).toBe(plain);
  });

  it('stringifies non-Error values', () => {
    expect(CLIError.from('oops').message).toBe('oops');
    expect(CLIError.from(42).message).toBe('42');
  });
});

describe('formatError', () => {
  it('includes the message', () => {
    expect(formatError(new CLIError('something failed'))).toContain('something failed');
  });

  it('includes the suggestion when present', () => {
    const out = formatError(new ConfigError('bad config', 'Run dockflow init'));
    expect(out).toContain('Run dockflow init');
  });

  it('shows cause for unexpected errors', () => {
    const cause = new Error('root cause');
    const err = new CLIError('wrapper', ErrorCode.UNKNOWN, undefined, cause);
    expect(formatError(err, true)).toContain('root cause');
  });
});
