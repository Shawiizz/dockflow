// `--since` and `--tail` of the log commands: validated here, before anything reaches a server.

import { ValidationError } from './errors';

/** A parsed `--since`, rendered for docker by `dockerSinceValue`. */
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

/** Largest instant a JavaScript Date holds. */
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
 * The only `--since` validator: a Go duration (kept as written), `<n>d` (as `<n*24>h`: Go
 * durations have no day unit), a date (local midnight), an RFC3339 timestamp (local time when it
 * has no zone) or unix seconds (9 digits or more, so `10` is not read as a 1970 timestamp).
 * Throws a ValidationError for anything else.
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

/** docker's `--since` value: Go duration, unix seconds as written, else RFC3339 in UTC */
export function dockerSinceValue(spec: SinceSpec): string {
  return spec.kind === 'duration' ? spec.goDuration : (spec.unixSeconds ?? spec.iso);
}

/** The CLI machine's zone, re-read at each instant. */
export const LOCAL_OFFSET: LocalOffset = (at) => -at.getTimezoneOffset();

/** A positive count given to `flag`, refused here rather than reaching the server as `NaN`. */
export function parseCountOption(raw: string, flag: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  throw new ValidationError(`${flag} must be a positive integer`, `Use for example \`${flag} 50\`.`);
}

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
