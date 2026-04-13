import type { Result } from '../../types/result';

export interface ExecOptions {
  interactive?: boolean;
  workdir?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Abstraction for command execution inside containers/pods.
 * - Swarm: docker exec via SSH
 * - k3s:   kubectl exec via SSH
 */
export interface ExecBackend {
  exec(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options?: ExecOptions,
  ): Promise<Result<ExecResult, Error>>;

  execStream(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options?: ExecOptions,
    callbacks?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void },
  ): Promise<Result<number, Error>>;

  shell(
    stackName: string,
    serviceName: string,
    shell?: string,
  ): Promise<Result<void, Error>>;

  bash(
    stackName: string,
    serviceName: string,
  ): Promise<Result<void, Error>>;

  copyTo(
    stackName: string,
    serviceName: string,
    localPath: string,
    containerPath: string,
  ): Promise<Result<void, Error>>;

  copyFrom(
    stackName: string,
    serviceName: string,
    containerPath: string,
    localPath: string,
  ): Promise<Result<void, Error>>;
}
