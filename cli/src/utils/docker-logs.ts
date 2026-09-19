/**
 * Raw Swarm log text: complete lines out of SSH chunks, and the `<task>@<node>    | ` context that
 * `docker service logs` writes in front of each line. Timestamps are split by the container backend
 * with the `splitTimestamp` shared with Kubernetes, so nothing here stamps a line with the current
 * time.
 */

/** Cuts a chunked stream into lines; a partial last line waits for the next chunk. */
export class LogLineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map(stripCarriageReturn);
  }

  /** the unterminated last line, once the stream ended */
  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest === '' ? [] : [stripCarriageReturn(rest)];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export interface ServiceLogsContext {
  /** `<service>.<slot>.<task id>` as docker printed it */
  task: string;
  node: string;
  /** the rest of the line, after `| ` */
  text: string;
}

// docker pads the context to a common width, then writes " | "
const SERVICE_LOGS_CONTEXT = /^(\S+)@(\S+?)\s*\| ?([\s\S]*)$/;

/** Splits the context of a `docker service logs` line; null when the line has none. */
export function splitServiceLogsContext(line: string): ServiceLogsContext | null {
  const match = SERVICE_LOGS_CONTEXT.exec(line);
  if (!match) return null;
  return { task: match[1], node: match[2], text: match[3] };
}
