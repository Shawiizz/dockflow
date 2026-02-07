/**
 * Exec Service
 * 
 * Handles command execution inside containers.
 * Supports both interactive and non-interactive modes.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecStream, executeInteractiveSSH } from '../utils/ssh';
import { createStackService } from './stack-service';
import { ok, err, type Result } from '../types';

/**
 * Exec options
 */
export interface ExecOptions {
  /** Run in interactive mode with TTY */
  interactive?: boolean;
  /** Working directory inside the container */
  workdir?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** User to run the command as */
  user?: string;
}

/**
 * Exec result
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Exec Service - manages command execution in containers
 */
export class ExecService {
  private readonly stackService;

  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string
  ) {
    this.stackService = createStackService(connection, stackName);
  }

  /**
   * Build docker exec command with options
   */
  private buildExecCommand(
    containerId: string,
    command: string | string[],
    options: ExecOptions = {}
  ): string {
    const parts = ['docker exec'];
    
    if (options.interactive) {
      parts.push('-it');
    }
    
    if (options.workdir) {
      parts.push(`-w ${options.workdir}`);
    }
    
    if (options.user) {
      parts.push(`-u ${options.user}`);
    }
    
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        parts.push(`-e ${key}="${value}"`);
      }
    }
    
    parts.push(containerId);
    
    if (Array.isArray(command)) {
      parts.push(...command);
    } else {
      parts.push(command);
    }
    
    return parts.join(' ');
  }

  /**
   * Execute a command in a service container
   */
  async exec(
    serviceName: string,
    command: string | string[],
    options: ExecOptions = {}
  ): Promise<Result<ExecResult, Error>> {
    const containerId = await this.stackService.findContainerForService(serviceName);
    
    if (!containerId) {
      return err(new Error(`No running container found for service ${serviceName}`));
    }

    const cmd = this.buildExecCommand(containerId, command, options);
    
    try {
      const result = await sshExec(this.connection, cmd);
      return ok({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Execute a command and stream output
   */
  async execStream(
    serviceName: string,
    command: string | string[],
    options: ExecOptions = {},
    callbacks?: {
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    }
  ): Promise<Result<number, Error>> {
    const containerId = await this.stackService.findContainerForService(serviceName);
    
    if (!containerId) {
      return err(new Error(`No running container found for service ${serviceName}`));
    }

    const cmd = this.buildExecCommand(containerId, command, { ...options, interactive: false });
    
    try {
      const result = await sshExecStream(this.connection, cmd, callbacks);
      return ok(result.exitCode);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Open an interactive shell in a container
   */
  async shell(
    serviceName: string,
    shell: string = '/bin/sh'
  ): Promise<Result<void, Error>> {
    const containerId = await this.stackService.findContainerForService(serviceName);
    
    if (!containerId) {
      return err(new Error(`No running container found for service ${serviceName}`));
    }

    // Build the full SSH command for interactive mode
    const dockerCmd = `docker exec -it ${containerId} ${shell}`;
    
    try {
      await executeInteractiveSSH(this.connection, dockerCmd);
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Open a bash shell (falls back to sh if bash not available)
   */
  async bash(serviceName: string): Promise<Result<void, Error>> {
    const containerId = await this.stackService.findContainerForService(serviceName);
    
    if (!containerId) {
      return err(new Error(`No running container found for service ${serviceName}`));
    }

    // Check if bash is available
    const checkResult = await sshExec(
      this.connection,
      `docker exec ${containerId} which bash 2>/dev/null || echo "not_found"`
    );
    
    const shell = checkResult.stdout.trim() === 'not_found' ? '/bin/sh' : '/bin/bash';
    return this.shell(serviceName, shell);
  }

  /**
   * Copy a file into a container
   */
  async copyTo(
    serviceName: string,
    localPath: string,
    containerPath: string
  ): Promise<Result<void, Error>> {
    const containerId = await this.stackService.findContainerForService(serviceName);
    
    if (!containerId) {
      return err(new Error(`No running container found for service ${serviceName}`));
    }

    const result = await sshExec(this.connection, `docker cp ${localPath} ${containerId}:${containerPath}`);
    
    if (result.exitCode !== 0) {
      return err(new Error(`Failed to copy file: ${result.stderr}`));
    }
    
    return ok(undefined);
  }

  /**
   * Copy a file from a container
   */
  async copyFrom(
    serviceName: string,
    containerPath: string,
    localPath: string
  ): Promise<Result<void, Error>> {
    const containerId = await this.stackService.findContainerForService(serviceName);
    
    if (!containerId) {
      return err(new Error(`No running container found for service ${serviceName}`));
    }

    const result = await sshExec(this.connection, `docker cp ${containerId}:${containerPath} ${localPath}`);
    
    if (result.exitCode !== 0) {
      return err(new Error(`Failed to copy file: ${result.stderr}`));
    }
    
    return ok(undefined);
  }
}

/**
 * Factory function to create an ExecService
 */
export function createExecService(
  connection: SSHKeyConnection,
  stackName: string
): ExecService {
  return new ExecService(connection, stackName);
}
