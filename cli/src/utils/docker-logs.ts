/**
 * Docker log parsing helpers.
 *
 * Shared between the CLI's ContainerBackend and the API routes that surface raw
 * `docker service logs` / `docker logs` output.
 */

export interface ParsedLogLine {
  timestamp: string;
  message: string;
  service: string;
}

/**
 * Parse Docker log output into structured entries.
 * Lines lacking an RFC3339 timestamp prefix fall back to `now`.
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
