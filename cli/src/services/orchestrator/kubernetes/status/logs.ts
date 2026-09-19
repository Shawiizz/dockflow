// Pure log helpers shared by both orchestrators (design-06 3.1, DESIGN-CORE 6.9 items 10-11): the one
// `--since` grammar and its renderings, `--tail` validation, timestamp splitting, `--prefix` line
// parsing, the merge of several pods' lines, and the printer's prefix rule. No I/O, no clock: the
// local zone is a parameter.

import { ValidationError } from '../../../../utils/errors';
import type { LogLine, ServiceInfo } from '../../interfaces';
import type { Pod } from '../resources/core';

// ---------------------------------------------------------------------------
// --since
// ---------------------------------------------------------------------------

/** Neutral parse result; each backend renders it for its own CLI. */
export type SinceSpec =
  | { kind: 'duration'; goDuration: string }
  /** `iso` is RFC3339 in UTC; `unixSeconds` keeps the raw value of the unix form (docker takes it as is) */
  | { kind: 'instant'; iso: string; unixSeconds: string | null };

/**
 * Minutes east of UTC of the CLI machine (`-date.getTimezoneOffset()`), or a function giving it
 * for an instant, so a date on the other side of a daylight-saving change gets its own offset.
 */
export type LocalOffset = number | ((at: Date) => number);

export const SINCE_ERROR_MESSAGE =
  '--since must be a duration (30m, 2h, 1h30m, 2d), a date (2026-09-17), a timestamp (2026-09-17T10:00:00Z) or unix seconds';

const GO_DURATION = /^([0-9]+(\.[0-9]+)?(ns|us|µs|ms|s|m|h))+$/;
const DAYS = /^([0-9]+)d$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const UNIX_SECONDS = /^(\d{9,})(?:\.(\d+))?$/;

/** Largest instant a JavaScript Date holds */
const MAX_MS = 8.64e15;

function sinceError(): ValidationError {
  return new ValidationError(SINCE_ERROR_MESSAGE);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Milliseconds of a UTC wall-clock time; years below 100 are not shifted to the 1900s. */
function wallMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  t.setUTCHours(hour, minute, second, 0);
  // a day past the end of the month rolls over
  return t.getUTCDate() === day ? t.getTime() : null;
}

function formatUtcSeconds(ms: number): string {
  const t = new Date(ms);
  return (
    `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

function offsetAt(local: LocalOffset, ms: number): number {
  return typeof local === 'number' ? local : local(new Date(ms));
}

/** Local wall-clock time -> UTC milliseconds, the offset re-read at the resulting instant. */
function localToUtc(wall: number, local: LocalOffset): number {
  const guess = wall - offsetAt(local, wall) * 60_000;
  return wall - offsetAt(local, guess) * 60_000;
}

function instant(ms: number, fraction: string | undefined, unixSeconds: string | null): SinceSpec {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) throw sinceError();
  const digits = fraction ? `.${fraction.slice(0, 9)}` : '';
  return { kind: 'instant', iso: `${formatUtcSeconds(ms)}${digits}Z`, unixSeconds };
}

/**
 * The only `--since` validator (K62b), one grammar for both orchestrators: a Go duration (kept as
 * written), `<n>d` (as `<n*24>h`: Go durations have no day unit), a date (local midnight), an
 * RFC3339 timestamp (local time when it has no zone) or unix seconds (9 digits or more, so `10`
 * is not read as a 1970 timestamp).
 */
export function parseSince(raw: string, localOffset: LocalOffset): SinceSpec {
  if (GO_DURATION.test(raw)) return { kind: 'duration', goDuration: raw };
  const days = DAYS.exec(raw);
  if (days) {
    const hours = Number(days[1]) * 24;
    if (!Number.isSafeInteger(hours)) throw sinceError();
    return { kind: 'duration', goDuration: `${hours}h` };
  }
  const date = DATE.exec(raw);
  if (date) {
    const wall = wallMs(Number(date[1]), Number(date[2]), Number(date[3]), 0, 0, 0);
    if (wall === null) throw sinceError();
    return instant(localToUtc(wall, localOffset), undefined, null);
  }
  const ts = TIMESTAMP.exec(raw);
  if (ts) {
    const wall = wallMs(Number(ts[1]), Number(ts[2]), Number(ts[3]), Number(ts[4]), Number(ts[5]), Number(ts[6] ?? '0'));
    if (wall === null) throw sinceError();
    const zone = ts[8];
    let utc: number;
    if (zone === undefined) {
      utc = localToUtc(wall, localOffset);
    } else if (zone === 'Z') {
      utc = wall;
    } else {
      const sign = zone.startsWith('-') ? -1 : 1;
      const hours = Number(zone.slice(1, 3));
      const minutes = Number(zone.slice(4, 6));
      if (hours > 23 || minutes > 59) throw sinceError();
      utc = wall - sign * (hours * 60 + minutes) * 60_000;
    }
    return instant(utc, ts[7], null);
  }
  const unix = UNIX_SECONDS.exec(raw);
  if (unix) return instant(Number(unix[1]) * 1000, unix[2], raw);
  throw sinceError();
}

/** `--since=<duration>` or `--since-time=<RFC3339>` */
export function kubectlSinceFlag(spec: SinceSpec): string {
  return spec.kind === 'duration' ? `--since=${spec.goDuration}` : `--since-time=${spec.iso}`;
}

/** docker's `--since` value: Go duration, unix seconds as written, else RFC3339 in UTC */
export function dockerSinceValue(spec: SinceSpec): string {
  return spec.kind === 'duration' ? spec.goDuration : (spec.unixSeconds ?? spec.iso);
}

// ---------------------------------------------------------------------------
// --tail
// ---------------------------------------------------------------------------

/** `all` or a non-negative integer (`--tail all` used to reach the remote CLI as `--tail NaN`). */
export function parseTailOption(raw: string | undefined, fallback: number): number | 'all' {
  if (raw === undefined) return fallback;
  if (raw === 'all') return 'all';
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new ValidationError('--tail must be a non-negative integer or all', 'Use for example `--tail 100` or `--tail all`.');
}

/** Always explicit: with a selector kubectl defaults to 10 lines. */
export function kubectlTailFlag(tail: number | 'all'): string {
  return tail === 'all' ? '--tail=-1' : `--tail=${tail}`;
}

/** `--max-log-requests`: at least kubectl's default of 5, never fewer than the pods followed. */
export function maxLogRequestsFlag(podCount: number): string {
  return `--max-log-requests=${Math.max(5, podCount)}`;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const LEADING_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))(?: ([\s\S]*))?$/;

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Splits the leading RFC3339Nano token that `--timestamps` adds; lines without one are kept whole. */
export function splitTimestamp(line: string): { timestamp: string | null; text: string } {
  const clean = stripCarriageReturn(line);
  const match = LEADING_TIMESTAMP.exec(clean);
  if (!match) return { timestamp: null, text: clean };
  return { timestamp: match[1], text: match[2] ?? '' };
}

/** Log lines of one container read without `--follow`; the trailing newline adds no empty line. */
export function logLinesFromOutput(stdout: string, source: { service: string; instance: string }): LogLine[] {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => ({ service: source.service, instance: source.instance, ...splitTimestamp(line) }));
}

export interface PrefixedLogLine {
  pod: string;
  container: string;
  timestamp: string | null;
  text: string;
}

const POD_PREFIX = /^\[pod\/([^/\]]+)\/([^\]]+)\] ([\s\S]*)$/;

/** `[pod/<pod>/<container>] <timestamp> <text>` as `kubectl logs --prefix` prints it; null when malformed. */
export function parsePrefixedLine(line: string): PrefixedLogLine | null {
  const match = POD_PREFIX.exec(stripCarriageReturn(line));
  if (!match) return null;
  return { pod: match[1], container: match[2], ...splitTimestamp(match[3]) };
}

export function toLogLine(line: PrefixedLogLine, service: string): LogLine {
  return { service, instance: line.pod, text: line.text, timestamp: line.timestamp };
}

/** Pods whose logs can be read: not terminating, a container started (a crash-looping one keeps its last run). */
export function isLogCandidate(pod: Pod, includeTerminated: boolean): boolean {
  if (pod.metadata.deletionTimestamp) return false;
  const phase = pod.status?.phase;
  if (!includeTerminated && (phase === 'Succeeded' || phase === 'Failed')) return false;
  return (pod.status?.containerStatuses ?? []).some((c) => c.state?.running || c.state?.terminated || c.lastState?.terminated);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const TIMESTAMP_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** [epoch seconds, nanoseconds]: string order fails on RFC3339Nano, which trims trailing zeros */
type TimeKey = readonly [number, number];

export function timestampKey(timestamp: string): TimeKey | null {
  const m = TIMESTAMP_PARTS.exec(timestamp);
  if (!m) return null;
  const wall = wallMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (wall === null) return null;
  let offsetMinutes = 0;
  if (m[8] !== 'Z') {
    const sign = m[8].startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6)));
  }
  const nanos = Number((m[7] ?? '').padEnd(9, '0'));
  return [(wall - offsetMinutes * 60_000) / 1000, nanos];
}

function compareKeys(a: TimeKey, b: TimeKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * Merges the lines of several pods by timestamp. Each stream keeps its own order (a pod's previous
 * run before its current one); equal timestamps keep stream order; a line without timestamp stays
 * right after its predecessor, and leading ones come first.
 */
export function mergeLogLines(streams: readonly (readonly LogLine[])[]): LogLine[] {
  const keys = streams.map((lines) => lines.map((l) => (l.timestamp === null ? null : timestampKey(l.timestamp))));
  const heads = streams.map(() => 0);
  const out: LogLine[] = [];
  const drainUntimed = (i: number): void => {
    while (heads[i] < streams[i].length && keys[i][heads[i]] === null) out.push(streams[i][heads[i]++]);
  };
  streams.forEach((_, i) => {
    drainUntimed(i);
  });
  for (;;) {
    let best = -1;
    let bestKey: TimeKey | null = null;
    for (let i = 0; i < streams.length; i++) {
      const key = keys[i][heads[i]];
      if (heads[i] >= streams[i].length || !key) continue;
      if (bestKey === null || compareKeys(key, bestKey) < 0) {
        best = i;
        bestKey = key;
      }
    }
    if (best === -1) return out;
    out.push(streams[best][heads[best]++]);
    drainUntimed(best);
  }
}

// ---------------------------------------------------------------------------
// Printer rules
// ---------------------------------------------------------------------------

export interface PrefixRuleInput {
  /** the service asked for; null for the whole role */
  service: Pick<ServiceInfo, 'mode' | 'replicas'> | null;
  allTasks: boolean;
  /** an instance picked with --pick */
  instance: string | undefined;
  noPrefix: boolean;
}

/** Lines carry the instance label when they can come from several instances. */
export function logPrefixEnabled(input: PrefixRuleInput): boolean {
  if (input.noPrefix || input.instance !== undefined) return false;
  const s = input.service;
  return s === null || input.allTasks || s.mode === 'global' || s.replicas.desired > 1;
}

export const LOG_PREFIX_COLOR_COUNT = 6;

/** Stable color slot per instance: index in first-seen order, modulo the palette size. */
export class LogPrefixColors {
  private readonly slots = new Map<string, number>();

  slotOf(instance: string): number {
    let slot = this.slots.get(instance);
    if (slot === undefined) {
      slot = this.slots.size % LOG_PREFIX_COLOR_COUNT;
      this.slots.set(instance, slot);
    }
    return slot;
  }
}
