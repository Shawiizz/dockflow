/**
 * Docker log parsing helpers.
 *
 * Shared by the API routes that surface raw `docker service logs` output.
 */

export interface ParsedLogLine {
  /** RFC3339 as docker wrote it; null when the line carries none */
  timestamp: string | null;
  message: string;
  service: string;
  /** `<service>.<slot>` of the task that wrote the line, when docker printed it */
  instance?: string;
}

const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) ?([\s\S]*)$/;

/** Cuts the leading RFC3339 timestamp off a line; the timestamp is null when there is none. */
export function splitTimestamp(line: string): { timestamp: string | null; text: string } {
  const match = TIMESTAMP_PREFIX.exec(line);
  return match ? { timestamp: match[1], text: match[2] } : { timestamp: null, text: line };
}

export interface ServiceLogsContext {
  /** `<service>.<slot>.<task id>` as docker printed it */
  task: string;
  node: string;
  /** the rest of the line, after `| ` */
  text: string;
}

// docker pads the context to a common width, then writes "| "
const SERVICE_LOGS_CONTEXT = /^([^\s@]+\.[^\s@.]+\.[a-z0-9]+)@(\S+?)\s*\| ?([\s\S]*)$/;

/** Cuts the `<task>@<node>    | ` that `docker service logs` writes in front of a line; null when there is none. */
export function splitServiceLogsContext(line: string): ServiceLogsContext | null {
  const match = SERVICE_LOGS_CONTEXT.exec(line);
  return match ? { task: match[1], node: match[2], text: match[3] } : null;
}

/**
 * Parse `docker service logs --timestamps` output into entries. The task context may come before
 * the timestamp or after it; a line with no timestamp keeps `null` instead of being stamped now.
 */
export function parseDockerLogLines(stdout: string, serviceName: string): ParsedLogLine[] {
  return stdout
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.trim())
    .map((line) => {
      const leading = splitTimestamp(line);
      const context = splitServiceLogsContext(leading.text);
      if (context) {
        const { timestamp, text } = splitTimestamp(context.text);
        return {
          timestamp: leading.timestamp ?? timestamp,
          message: leading.timestamp ? context.text : text,
          service: serviceName,
          instance: context.task.replace(/\.[^.]+$/, ''),
        };
      }
      return { timestamp: leading.timestamp, message: leading.text, service: serviceName };
    });
}

const TIMESTAMP_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** [epoch seconds, nanoseconds]: string order fails on RFC3339Nano, which trims trailing zeros. */
export function timestampKey(timestamp: string): [number, number] | null {
  const match = TIMESTAMP_PARTS.exec(timestamp);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`) / 1000;
  if (Number.isNaN(seconds)) return null;
  return [seconds, Number((match[2] ?? '').padEnd(9, '0').slice(0, 9))];
}

export interface DatedLogLine {
  timestamp: string;
  message: string;
  service: string;
}

/**
 * Lines ready for display: oldest first, every line dated, each labelled by its task when the output
 * holds several (replicas, or tasks that were replaced) and by the service otherwise. A line with
 * no timestamp (a continuation) takes the one of the line before it.
 */
export function arrangeLogLines(lines: ParsedLogLine[], stackName: string, now: Date = new Date()): DatedLogLine[] {
  const instances = new Set(lines.flatMap((line) => (line.instance ? [line.instance] : [])));
  const prefix = `${stackName}_`;
  const firstDated = lines.find((line) => line.timestamp)?.timestamp ?? now.toISOString();

  let previous = firstDated;
  const dated = lines.map((line) => {
    previous = line.timestamp ?? previous;
    const instance = line.instance?.startsWith(prefix) ? line.instance.slice(prefix.length) : line.instance;
    return {
      timestamp: previous,
      message: line.message,
      service: instances.size > 1 && instance ? instance : line.service,
    };
  });

  const keyed = dated.map((line, index) => ({ line, index, key: timestampKey(line.timestamp) }));
  keyed.sort((a, b) => {
    if (!a.key || !b.key) return a.index - b.index;
    return a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index;
  });
  return keyed.map(({ line }) => line);
}

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
