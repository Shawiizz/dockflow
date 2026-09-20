import { describe, expect, it } from 'bun:test';
import { parseIntParam } from '../api/routes/_helpers';
import { normalizeEnv, normalizeStringArray } from '../api/routes/accessories';
import { mapMetricStatus } from '../api/routes/deploy';
import { dockerSinceValue, parseSince, splitTimestamp } from '../services/orchestrator/kubernetes/status/logs';
import { parseDockerStatsLine } from '../services/orchestrator/swarm/swarm-utils';

describe('parseIntParam', () => {
  it('returns the fallback for missing or non-numeric input', () => {
    expect(parseIntParam(null, 100)).toBe(100);
    expect(parseIntParam('abc', 100)).toBe(100);
    expect(parseIntParam('', 50)).toBe(50);
  });

  it('parses valid integers and clamps to [min, max]', () => {
    expect(parseIntParam('5', 100, 1, 10000)).toBe(5);
    expect(parseIntParam('999999', 100, 1, 10000)).toBe(10000);
    expect(parseIntParam('0', 100, 1, 10000)).toBe(1);
    expect(parseIntParam('-4', 100, 1, 10000)).toBe(1);
  });
});

describe('normalizeEnv', () => {
  it('normalizes the compose map form', () => {
    expect(normalizeEnv({ POSTGRES_USER: 'app', POSTGRES_PORT: 5432 })).toEqual({
      POSTGRES_USER: 'app',
      POSTGRES_PORT: '5432',
    });
  });

  it('normalizes the compose KEY=value list form', () => {
    expect(normalizeEnv(['POSTGRES_USER=app', 'POSTGRES_PASSWORD=secret=with=equals'])).toEqual({
      POSTGRES_USER: 'app',
      POSTGRES_PASSWORD: 'secret=with=equals',
    });
  });

  it('returns undefined for missing or malformed input', () => {
    expect(normalizeEnv(undefined)).toBeUndefined();
    expect(normalizeEnv(null)).toBeUndefined();
    expect(normalizeEnv('not-an-object')).toBeUndefined();
  });
});

describe('normalizeStringArray', () => {
  it('stringifies each array entry', () => {
    expect(normalizeStringArray(['5432:5432', 6379])).toEqual(['5432:5432', '6379']);
  });

  it('returns undefined for non-array input', () => {
    expect(normalizeStringArray(undefined)).toBeUndefined();
    expect(normalizeStringArray('5432:5432')).toBeUndefined();
  });
});

describe('mapMetricStatus', () => {
  it('maps known statuses', () => {
    expect(mapMetricStatus('success')).toBe('success');
    expect(mapMetricStatus('failed')).toBe('failed');
    expect(mapMetricStatus('rolled_back')).toBe('failed');
  });

  it('falls back to pending for unknown or missing statuses', () => {
    expect(mapMetricStatus(undefined)).toBe('pending');
    expect(mapMetricStatus('weird')).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// K05 regression guards: the API's log and stats routes depend on these shared,
// pure functions to fill real data instead of the placeholders the old Swarm-only
// routes printed. The Swarm backend's own use of them is covered by
// swarm-read.test.ts (U-SWARM-13, U-SWARM-16); these guard the pure grammar the
// API layer's mapping (services.ts, accessories.ts) is built on.
// ---------------------------------------------------------------------------

describe('log timestamp splitting and --since rendering (U-SWARM-16)', () => {
  it('splits the leading RFC3339Nano token `--timestamps` adds', () => {
    expect(splitTimestamp('2026-01-01T00:00:01.000000000Z hello world')).toEqual({
      timestamp: '2026-01-01T00:00:01.000000000Z',
      text: 'hello world',
    });
  });

  it('leaves a line without a leading timestamp whole', () => {
    expect(splitTimestamp('no timestamp here')).toEqual({ timestamp: null, text: 'no timestamp here' });
  });

  it('renders `--since 2d` as `48h` in docker grammar (K62b): Go durations have no day unit', () => {
    const spec = parseSince('2d', 0);
    expect(dockerSinceValue(spec)).toBe('48h');
  });

  it('rejects `--since 10` instead of reading it as a 1970 timestamp', () => {
    expect(() => parseSince('10', 0)).toThrow();
  });
});

describe('Swarm container stats fill netIO/blockIO (U-SWARM-13)', () => {
  it('parseDockerStatsLine never leaves Net I/O or Block I/O null on a normal docker stats row', () => {
    const line =
      '{"BlockIO":"1.5MB / 0B","CPUPerc":"1.23%","Container":"abc","ID":"abc","MemPerc":"2.27%","MemUsage":"45.2MiB / 1.94GiB","Name":"shop-production_web.2.x2x4qabcdef","NetIO":"1.2kB / 648B","PIDs":"3"}';

    const stats = parseDockerStatsLine(line, { scope: 'shop-production', role: 'app', node: 'worker-1' });

    expect(stats?.netIO).toBe('1.2kB / 648B');
    expect(stats?.blockIO).toBe('1.5MB / 0B');
  });
});
