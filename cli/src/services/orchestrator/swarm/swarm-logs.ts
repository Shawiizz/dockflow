/**
 * Swarm logs backend.
 *
 * Thin wrapper that implements LogsBackend by delegating to LogsService.
 * No log-streaming logic lives here.
 */

import type { SSHKeyConnection } from '../../../types';
import { createLogsService } from '../../logs-service';
import type { LogsBackend, LogsOptions } from '../logs-interface';

export class SwarmLogsBackend implements LogsBackend {
  constructor(private readonly conn: SSHKeyConnection) {}

  async streamLogs(
    stackName: string,
    serviceName: string,
    options: LogsOptions,
    onData: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const logs = createLogsService(this.conn, stackName);
    try {
      await logs.streamServiceLogs(
        serviceName,
        {
          follow: options.follow,
          tail: options.tail,
          since: options.since,
          timestamps: options.timestamps,
        },
        {
          onStdout: (data) => {
            for (const line of data.split('\n')) {
              if (line.length > 0) onData(line);
            }
          },
          onStderr: (data) => {
            for (const line of data.split('\n')) {
              if (line.length > 0) onData(line);
            }
          },
        },
      );
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
