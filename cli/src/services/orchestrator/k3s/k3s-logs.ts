/**
 * k3s logs backend.
 *
 * Implements LogsBackend by streaming logs via kubectl logs with label selectors.
 * Aggregates logs from all pods matching the service name.
 */

import type { SSHKeyConnection } from '../../../types';
import { sshExecStream } from '../../../utils/ssh';
import { K3S_DOCKFLOW_KUBECONFIG, K3S_NAMESPACE_PREFIX } from '../../../constants';
import type { LogsBackend, LogsOptions } from '../logs-interface';

export class K3sLogsBackend implements LogsBackend {
  private readonly kube = `kubectl --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`;

  constructor(private readonly conn: SSHKeyConnection) {}

  async streamLogs(
    stackName: string,
    serviceName: string,
    options: LogsOptions,
    onData: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const ns = `${K3S_NAMESPACE_PREFIX}-${stackName}`;
    const flags = [
      options.follow ? '-f' : '',
      options.tail != null ? `--tail=${options.tail}` : '',
      options.since ? `--since=${options.since}` : '',
      options.timestamps ? '--timestamps' : '',
    ]
      .filter(Boolean)
      .join(' ');

    try {
      await sshExecStream(
        this.conn,
        `${this.kube} logs -n ${ns} -l app=${serviceName} ${flags}`,
        {
          onStdout: (data) => {
            for (const line of data.split('\n')) {
              if (line.length > 0) onData(line);
            }
          },
          onStderr: (data) => {
            for (const line of data.split('\n')) {
              if (line.length > 0) onError(new Error(line));
            }
          },
        },
      );
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
