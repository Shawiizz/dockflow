export interface LogsOptions {
  follow: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
}

/**
 * Abstraction du streaming de logs.
 * - Swarm : `docker service logs` (agrégation multi-replica native)
 * - k3s   : `kubectl logs -l app={service}` (agrégation via label selector)
 */
export interface LogsBackend {
  streamLogs(
    stackName: string,
    serviceName: string,
    options: LogsOptions,
    onData: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void>;
}
