import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  CLIError,
  ConfigError,
  ConnectionError,
  DeployError,
  ValidationError,
  BackupError,
  DockerError,
  ErrorCode,
  ExecExitError,
  OrchestratorUnavailableError,
  UnsupportedOperationError,
  ComposeTranslationError,
  formatError,
  withErrorHandler,
} from '../utils/errors';
import { ComposeTranslationError as DiagnosticsComposeTranslationError } from '../services/orchestrator/diagnostics';

describe('CLIError hierarchy', () => {
  it('subclasses carry their default error codes', () => {
    expect(new ConfigError('x').code).toBe(ErrorCode.CONFIG_INVALID);
    expect(new ConnectionError('x').code).toBe(ErrorCode.CONNECTION_FAILED);
    expect(new DeployError('x').code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(new ValidationError('x').code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(new BackupError('x').code).toBe(ErrorCode.BACKUP_FAILED);
    expect(new DockerError('x').code).toBe(ErrorCode.DOCKER_NOT_AVAILABLE);
    expect(new OrchestratorUnavailableError('x').code).toBe(ErrorCode.ORCHESTRATOR_UNAVAILABLE);
    expect(new UnsupportedOperationError('x').code).toBe(ErrorCode.UNSUPPORTED_OPERATION);
  });

  it('DeployError accepts a custom code', () => {
    const err = new DeployError('x', ErrorCode.HEALTH_CHECK_FAILED);
    expect(err.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
  });

  it('all subclasses are instanceof CLIError and Error', () => {
    for (const err of [
      new ConfigError('x'),
      new DeployError('x'),
      new BackupError('x'),
      new OrchestratorUnavailableError('x'),
      new UnsupportedOperationError('x'),
    ]) {
      expect(err).toBeInstanceOf(CLIError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe('orchestrator error codes', () => {
  it('adds 44 and 62 and leaves the existing codes unchanged', () => {
    expect(ErrorCode.ORCHESTRATOR_UNAVAILABLE).toBe(44);
    expect(ErrorCode.UNSUPPORTED_OPERATION).toBe(62);
    expect(ErrorCode.DOCKER_NOT_AVAILABLE).toBe(40);
    expect(ErrorCode.CONTAINER_NOT_FOUND).toBe(43);
    expect(ErrorCode.DEPLOY_FAILED).toBe(50);
    expect(ErrorCode.ROLLBACK_FAILED).toBe(52);
    expect(ErrorCode.HEALTH_CHECK_FAILED).toBe(53);
    expect(ErrorCode.VALIDATION_FAILED).toBe(60);
    expect(ErrorCode.INVALID_ARGUMENT).toBe(61);
    expect(ErrorCode.RESTORE_FAILED).toBe(72);
    expect(ErrorCode.BACKUP_CONFIG_MISSING).toBe(73);
  });

  it('OrchestratorUnavailableError keeps its suggestion and cause', () => {
    const cause = new Error('connection refused');
    const err = new OrchestratorUnavailableError(
      'Namespace dockflow-system is missing on srv-1',
      'Re-run `dockflow setup k3s production`.',
      cause,
    );
    expect(err.name).toBe('OrchestratorUnavailableError');
    expect(err.suggestion).toBe('Re-run `dockflow setup k3s production`.');
    expect(err.cause).toBe(cause);
  });

  it('UnsupportedOperationError carries message and suggestion', () => {
    const err = new UnsupportedOperationError('dockflow volumes list is not supported with orchestrator: swarm', 'Do this.');
    expect(err.name).toBe('UnsupportedOperationError');
    expect(err.message).toBe('dockflow volumes list is not supported with orchestrator: swarm');
    expect(err.suggestion).toBe('Do this.');
  });

  it('ComposeTranslationError is re-exported from the diagnostics module', () => {
    expect(ComposeTranslationError).toBe(DiagnosticsComposeTranslationError);
    expect(new ComposeTranslationError('m', 's', []).code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

describe('ExecExitError', () => {
  it('carries the container exit code outside the ErrorCode space', () => {
    const err = new ExecExitError(62);
    expect(err.exitCode).toBe(62);
    expect(err.message).toBe('Command exited with code 62');
    expect(err.name).toBe('ExecExitError');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CLIError);
  });
});

describe('withErrorHandler', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('passes an ExecExitError through as process.exitCode and returns normally', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code}) called`);
    });
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const code of [3, 62]) {
        process.exitCode = 0;
        await withErrorHandler(async () => {
          throw new ExecExitError(code);
        })();
        expect(process.exitCode).toBe(code);
      }
      expect(exit).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it('still exits with the ErrorCode of any other error', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code}) called`);
    });
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const action = withErrorHandler(async () => {
        throw new UnsupportedOperationError('dockflow exec --user is not supported with orchestrator: k3s');
      });
      await expect(action()).rejects.toThrow('process.exit(62) called');
      expect(exit).toHaveBeenCalledWith(62);
    } finally {
      exit.mockRestore();
      write.mockRestore();
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
