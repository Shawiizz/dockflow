/**
 * Logs Service
 * 
 * Handles log retrieval and streaming for Docker Swarm services.
 * Provides various output modes and filtering options.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecStream } from '../utils/ssh';
import { createStackService } from './stack-service';

/**
 * Log retrieval options
 */
export interface LogOptions {
  /** Number of lines to show (default: 100) */
  tail?: number;
  /** Follow log output in real-time */
  follow?: boolean;
  /** Show timestamps */
  timestamps?: boolean;
  /** Filter by since (e.g., "1h", "2023-01-01") */
  since?: string;
  /** Show raw output without formatting */
  raw?: boolean;
}

/**
 * Log output entry
 */
export interface LogEntry {
  service: string;
  output: string;
}

/**
 * Logs Service - manages log operations for stacks
 */
export class LogsService {
  private readonly stackService;

  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string
  ) {
    this.stackService = createStackService(connection, stackName);
  }

  /**
   * Build the docker logs command with options
   */
  private buildLogsCommand(serviceName: string, options: LogOptions = {}): string {
    const parts = ['docker service logs'];
    
    if (options.follow) {
      parts.push('-f');
    }
    
    parts.push(`--tail ${options.tail ?? 100}`);
    
    if (options.timestamps) {
      parts.push('--timestamps');
    }
    
    if (options.since) {
      parts.push(`--since ${options.since}`);
    }
    
    if (options.raw) {
      parts.push('--raw');
    }
    
    parts.push(serviceName);
    parts.push('2>&1');
    
    return parts.join(' ');
  }

  /**
   * Stream logs for a specific service
   */
  async streamServiceLogs(
    serviceName: string,
    options: LogOptions = {},
    callbacks?: {
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    }
  ): Promise<void> {
    const fullName = serviceName.includes('_') 
      ? serviceName 
      : `${this.stackName}_${serviceName}`;
      
    const cmd = this.buildLogsCommand(fullName, options);
    await sshExecStream(this.connection, cmd, callbacks);
  }

  /**
   * Get logs for a specific service (non-streaming)
   */
  async getServiceLogs(serviceName: string, options: LogOptions = {}): Promise<string> {
    const fullName = serviceName.includes('_') 
      ? serviceName 
      : `${this.stackName}_${serviceName}`;
      
    // Force non-follow for getting logs
    const cmd = this.buildLogsCommand(fullName, { ...options, follow: false });
    const result = await sshExec(this.connection, cmd);

    return result.stdout;
  }

  /**
   * Stream logs for all services in the stack
   * Note: Only first service in follow mode, all services otherwise
   */
  async streamAllLogs(
    options: LogOptions = {},
    onServiceStart?: (serviceName: string) => void
  ): Promise<void> {
    const services = await this.stackService.getFullServiceNames();
    
    if (services.length === 0) {
      throw new Error(`No services found for stack ${this.stackName}`);
    }

    if (options.follow) {
      // Follow mode - only first service
      onServiceStart?.(services[0]);
      await this.streamServiceLogs(services[0], options);
    } else {
      // Show logs from all services
      for (const service of services) {
        onServiceStart?.(service);
        await this.streamServiceLogs(service, options);
      }
    }
  }

  /**
   * Get logs for all services (non-streaming)
   */
  async getAllLogs(options: LogOptions = {}): Promise<LogEntry[]> {
    const services = await this.stackService.getFullServiceNames();
    const entries: LogEntry[] = [];

    for (const service of services) {
      const output = await this.getServiceLogs(service, { ...options, follow: false });
      entries.push({ service, output });
    }

    return entries;
  }

  /**
   * Search logs for a pattern
   */
  async searchLogs(
    pattern: string,
    options: { tail?: number; caseSensitive?: boolean } = {}
  ): Promise<LogEntry[]> {
    const services = await this.stackService.getFullServiceNames();
    const entries: LogEntry[] = [];
    const grepFlag = options.caseSensitive ? '' : '-i';

    for (const service of services) {
      const cmd = `docker service logs --tail ${options.tail ?? 500} ${service} 2>&1 | grep ${grepFlag} "${pattern}" || true`;
      const result = await sshExec(this.connection, cmd);

      if (result.stdout.trim()) {
        entries.push({ service, output: result.stdout });
      }
    }

    return entries;
  }
}

/**
 * Parsed log line with timestamp
 */
export interface ParsedLogLine {
  timestamp: string;
  message: string;
  service: string;
}

/**
 * Parse Docker log output into structured entries.
 * Shared between CLI and API routes.
 */
export function parseDockerLogLines(stdout: string, serviceName: string): ParsedLogLine[] {
  return stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)/);
      if (tsMatch) {
        return { timestamp: tsMatch[1], message: tsMatch[2], service: serviceName };
      }
      return { timestamp: new Date().toISOString(), message: line, service: serviceName };
    });
}

/**
 * Factory function to create a LogsService
 */
export function createLogsService(
  connection: SSHKeyConnection,
  stackName: string
): LogsService {
  return new LogsService(connection, stackName);
}
