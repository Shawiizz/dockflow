import { describe, expect, it } from 'bun:test';
import type { LogLine } from '../../../services/orchestrator/interfaces';
import type { Pod } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  dockerSinceValue,
  isLogCandidate,
  kubectlSinceFlag,
  kubectlTailFlag,
  LOG_PREFIX_COLOR_COUNT,
  LogPrefixColors,
  logLinesFromOutput,
  logPrefixEnabled,
  maxLogRequestsFlag,
  mergeLogLines,
  parsePrefixedLine,
  parseSince,
  parseTailOption,
  SINCE_ERROR_MESSAGE,
  splitTimestamp,
  timestampKey,
  toLogLine,
} from '../../../services/orchestrator/kubernetes/status/logs';
import { ValidationError } from '../../../utils/errors';
import { loadKubectlList } from '../support/kubectl-fixtures';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

function podNamed(scenario: string, name: string): Pod {
  const pod = loadKubectlList<Pod>(scenario, 'pods').items.find((p) => p.metadata.name === name);
  if (!pod) throw new Error(`no pod ${name} in ${scenario}`);
  return pod;
}

describe('parseSince', () => {
  // one table drives both renderings (K62b): [input, local offset (minutes east of UTC), kubectl flag, docker value]
  const table: [string, number, string, string][] = [
    ['30m', 0, '--since=30m', '30m'],
    ['1h30m', 0, '--since=1h30m', '1h30m'],
    ['500ms', 0, '--since=500ms', '500ms'],
    ['90s', 0, '--since=90s', '90s'],
    ['1h', 0, '--since=1h', '1h'],
    ['2d', 0, '--since=48h', '48h'],
    ['2026-09-17', -120, '--since-time=2026-09-17T02:00:00Z', '2026-09-17T02:00:00Z'],
    ['2026-09-17', 0, '--since-time=2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'],
    ['2026-09-17', 330, '--since-time=2026-09-16T18:30:00Z', '2026-09-16T18:30:00Z'],
    ['2026-01-01', 0, '--since-time=2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    ['2026-09-17T10:00', 120, '--since-time=2026-09-17T08:00:00Z', '2026-09-17T08:00:00Z'],
    ['2026-09-17T10:00:30', 0, '--since-time=2026-09-17T10:00:30Z', '2026-09-17T10:00:30Z'],
    ['2026-01-01T10:00:00Z', 330, '--since-time=2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z'],
    ['2026-09-17T10:00:00.123456789Z', 0, '--since-time=2026-09-17T10:00:00.123456789Z', '2026-09-17T10:00:00.123456789Z'],
    ['2026-09-17T10:00:00+02:00', 0, '--since-time=2026-09-17T08:00:00Z', '2026-09-17T08:00:00Z'],
    ['2026-09-17T10:00:00-05:30', 0, '--since-time=2026-09-17T15:30:00Z', '2026-09-17T15:30:00Z'],
    ['1758100000', 0, '--since-time=2025-09-17T09:06:40Z', '1758100000'],
    ['1758100000.5', 0, '--since-time=2025-09-17T09:06:40.5Z', '1758100000.5'],
  ];
  for (const [raw, offset, kubectl, docker] of table) {
    it(`${raw} (offset ${offset}) -> ${kubectl} / ${docker}`, () => {
      const spec = parseSince(raw, offset);
      expect(kubectlSinceFlag(spec)).toBe(kubectl);
      expect(dockerSinceValue(spec)).toBe(docker);
    });
  }

  it('returns a neutral result', () => {
    expect(parseSince('2d', 0)).toEqual({ kind: 'duration', goDuration: '48h' });
    expect(parseSince('2026-09-17', 0)).toEqual({ kind: 'instant', iso: '2026-09-17T00:00:00Z', unixSeconds: null });
    expect(parseSince('1758100000', 0)).toEqual({ kind: 'instant', iso: '2025-09-17T09:06:40Z', unixSeconds: '1758100000' });
  });

  it('re-reads the local offset at the resulting instant across a daylight-saving change', () => {
    // UTC+1 until 2026-03-29T01:00Z, UTC+2 after
    const paris = (at: Date) => (at.getTime() >= Date.UTC(2026, 2, 29, 1) ? 120 : 60);
    expect(kubectlSinceFlag(parseSince('2026-03-29', paris))).toBe('--since-time=2026-03-28T23:00:00Z');
    expect(kubectlSinceFlag(parseSince('2026-03-30', paris))).toBe('--since-time=2026-03-29T22:00:00Z');
    expect(kubectlSinceFlag(parseSince('2026-03-29T01:30', paris))).toBe('--since-time=2026-03-29T00:30:00Z');
  });

  const rejected = ['yesterday', '10', '1h-5m', '', '-5m', '2d3h', '1.5d', '2026-02-30', '2026-13-01', '2026-09-17T24:00', '2026-09-17 10:00', '12345678'];
  for (const raw of rejected) {
    it(`rejects ${JSON.stringify(raw)} with the one message of both orchestrators`, () => {
      const error = thrown(() => parseSince(raw, 0));
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe(SINCE_ERROR_MESSAGE);
    });
  }

  it('the message names every accepted form', () => {
    expect(SINCE_ERROR_MESSAGE).toBe(
      '--since must be a duration (30m, 2h, 1h30m, 2d), a date (2026-09-17), a timestamp (2026-09-17T10:00:00Z) or unix seconds',
    );
  });
});

describe('--tail', () => {
  it('parseTailOption accepts all and non-negative integers, falls back when absent', () => {
    expect(parseTailOption('all', 100)).toBe('all');
    expect(parseTailOption('0', 100)).toBe(0);
    expect(parseTailOption('100', 20)).toBe(100);
    expect(parseTailOption(undefined, 100)).toBe(100);
  });

  for (const raw of ['-1', '1.5', 'abc', 'NaN', '', '1e3', '99999999999999999999']) {
    it(`parseTailOption rejects ${JSON.stringify(raw)}`, () => {
      const error = thrown(() => parseTailOption(raw, 100));
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe('--tail must be a non-negative integer or all');
      expect((error as ValidationError).suggestion).toBe('Use for example `--tail 100` or `--tail all`.');
    });
  }

  it('renders an explicit kubectl flag (U-STATUS-LOGS-02)', () => {
    expect(kubectlTailFlag(parseTailOption('100', 20))).toBe('--tail=100');
    expect(kubectlTailFlag(parseTailOption('all', 20))).toBe('--tail=-1');
    expect(kubectlTailFlag(0)).toBe('--tail=0');
  });

  it('--max-log-requests covers every followed pod, never below kubectl default (U-STATUS-LOGS-04)', () => {
    expect(maxLogRequestsFlag(1)).toBe('--max-log-requests=5');
    expect(maxLogRequestsFlag(5)).toBe('--max-log-requests=5');
    expect(maxLogRequestsFlag(12)).toBe('--max-log-requests=12');
  });
});

describe('splitTimestamp', () => {
  it('splits the leading RFC3339Nano token', () => {
    expect(splitTimestamp('2026-01-01T00:15:00.123456789Z GET /health 200')).toEqual({
      timestamp: '2026-01-01T00:15:00.123456789Z',
      text: 'GET /health 200',
    });
    expect(splitTimestamp('2026-01-01T00:15:00+02:00 local')).toEqual({ timestamp: '2026-01-01T00:15:00+02:00', text: 'local' });
  });

  it('keeps a line without timestamp whole, strips a trailing CR, and keeps an empty message', () => {
    expect(splitTimestamp('plain line')).toEqual({ timestamp: null, text: 'plain line' });
    expect(splitTimestamp('2026-01-01 not a token')).toEqual({ timestamp: null, text: '2026-01-01 not a token' });
    expect(splitTimestamp('2026-01-01T00:15:00Z hello\r')).toEqual({ timestamp: '2026-01-01T00:15:00Z', text: 'hello' });
    expect(splitTimestamp('2026-01-01T00:15:00Z')).toEqual({ timestamp: '2026-01-01T00:15:00Z', text: '' });
    expect(splitTimestamp('2026-01-01T00:15:00Z   indented')).toEqual({ timestamp: '2026-01-01T00:15:00Z', text: '  indented' });
  });

  it('turns one container output into log lines', () => {
    const out = '2026-01-01T00:15:00Z one\n2026-01-01T00:15:01Z two\r\n\n';
    expect(logLinesFromOutput(out, { service: 'web', instance: 'web-7c9f-abcde' })).toEqual([
      { service: 'web', instance: 'web-7c9f-abcde', timestamp: '2026-01-01T00:15:00Z', text: 'one' },
      { service: 'web', instance: 'web-7c9f-abcde', timestamp: '2026-01-01T00:15:01Z', text: 'two' },
      { service: 'web', instance: 'web-7c9f-abcde', timestamp: null, text: '' },
    ]);
    expect(logLinesFromOutput('', { service: 'web', instance: 'x' })).toEqual([]);
  });
});

describe('parsePrefixedLine', () => {
  it('parses the --prefix form (U-STATUS-LOGS-03)', () => {
    const line = parsePrefixedLine('[pod/web-7c9f-abcde/web] 2026-01-01T00:15:00.5Z hello');
    expect(line).toEqual({ pod: 'web-7c9f-abcde', container: 'web', timestamp: '2026-01-01T00:15:00.5Z', text: 'hello' });
    if (!line) throw new Error('unparsed');
    expect(toLogLine(line, 'web')).toEqual({ service: 'web', instance: 'web-7c9f-abcde', text: 'hello', timestamp: '2026-01-01T00:15:00.5Z' });
  });

  it('keeps dashes in the container name and `] ` inside the message', () => {
    expect(parsePrefixedLine('[pod/api-847f8bf66c-5ghhb/log-shipper] 2026-01-01T00:15:00Z [info] ] shipped')).toEqual({
      pod: 'api-847f8bf66c-5ghhb',
      container: 'log-shipper',
      timestamp: '2026-01-01T00:15:00Z',
      text: '[info] ] shipped',
    });
  });

  it('accepts a line without timestamp and strips CRLF', () => {
    expect(parsePrefixedLine('[pod/db-0/db] ready to accept connections\r')).toEqual({
      pod: 'db-0',
      container: 'db',
      timestamp: null,
      text: 'ready to accept connections',
    });
  });

  it('returns null for a malformed prefix', () => {
    expect(parsePrefixedLine('pod/web-1/web hello')).toBeNull();
    expect(parsePrefixedLine('[pod/web-1] hello')).toBeNull();
    expect(parsePrefixedLine('[deployment/web/web] hello')).toBeNull();
    expect(parsePrefixedLine('[pod/web-1/web]hello')).toBeNull();
    expect(parsePrefixedLine('error: unable to retrieve container logs')).toBeNull();
  });
});

describe('isLogCandidate', () => {
  it('keeps pods with a started container, a crash-looping one included', () => {
    expect(isLogCandidate(podNamed('rollout-complete', 'web-b655d585b-7jdgc'), false)).toBe(true);
    expect(isLogCandidate(podNamed('crashloop', 'web-app-fbf7d977d-dqwf8'), false)).toBe(true);
  });

  it('leaves out terminating pods and pods whose container never started', () => {
    expect(isLogCandidate(podNamed('terminating-pods', 'web-585567c7ff-pbh4z'), true)).toBe(false);
    expect(isLogCandidate(podNamed('unschedulable-resources', 'web-6db8d4bf7-jhghd'), true)).toBe(false);
    expect(isLogCandidate(podNamed('image-pull-backoff', 'web-679ff8548-l5hvb'), true)).toBe(false);
  });

  it('keeps finished pods only with includeTerminated', () => {
    const done = podNamed('job-complete', 'migrate-8d802302-rcg26');
    expect(isLogCandidate(done, false)).toBe(false);
    expect(isLogCandidate(done, true)).toBe(true);
  });
});

describe('mergeLogLines', () => {
  const line = (instance: string, timestamp: string | null, text: string): LogLine => ({ service: 'web', instance, timestamp, text });

  it('interleaves pods by timestamp (U-STATUS-LOGS-03)', () => {
    const a = [line('a', '2026-01-01T00:00:01Z', 'a1'), line('a', '2026-01-01T00:00:03Z', 'a3')];
    const b = [line('b', '2026-01-01T00:00:02Z', 'b2'), line('b', '2026-01-01T00:00:04Z', 'b4')];
    expect(mergeLogLines([a, b]).map((l) => l.text)).toEqual(['a1', 'b2', 'a3', 'b4']);
  });

  it('compares instants, not strings: trimmed nanoseconds and zone offsets', () => {
    const a = [line('a', '2026-01-01T00:00:00.5Z', 'half')];
    const b = [line('b', '2026-01-01T00:00:00.123456789Z', 'early')];
    const c = [line('c', '2026-01-01T01:00:00.2+01:00', 'zoned')];
    expect(mergeLogLines([a, b, c]).map((l) => l.text)).toEqual(['early', 'zoned', 'half']);
  });

  it('is stable for equal timestamps', () => {
    const t = '2026-01-01T00:00:01Z';
    const a = [line('a', t, 'a1'), line('a', t, 'a2')];
    const b = [line('b', t, 'b1')];
    expect(mergeLogLines([a, b]).map((l) => l.text)).toEqual(['a1', 'a2', 'b1']);
    expect(mergeLogLines([b, a]).map((l) => l.text)).toEqual(['b1', 'a1', 'a2']);
  });

  it('keeps a line without timestamp right after its predecessor, leading ones first', () => {
    const a = [line('a', null, 'banner'), line('a', '2026-01-01T00:00:02Z', 'a2'), line('a', null, 'a2 continued')];
    const b = [line('b', '2026-01-01T00:00:01Z', 'b1'), line('b', '2026-01-01T00:00:03Z', 'b3')];
    expect(mergeLogLines([a, b]).map((l) => l.text)).toEqual(['banner', 'b1', 'a2', 'a2 continued', 'b3']);
  });

  it('keeps a pod previous run before its current run', () => {
    const previous = [line('a', '2026-01-01T00:00:05Z', 'crash 1'), line('a', '2026-01-01T00:00:06Z', 'exit 1')];
    const current = [line('a', '2026-01-01T00:00:07Z', 'start 2')];
    const other = [line('b', '2026-01-01T00:00:06.5Z', 'b')];
    expect(mergeLogLines([[...previous, ...current], other]).map((l) => l.text)).toEqual(['crash 1', 'exit 1', 'b', 'start 2']);
  });

  it('handles empty input', () => {
    expect(mergeLogLines([])).toEqual([]);
    expect(mergeLogLines([[], []])).toEqual([]);
  });

  it('timestampKey reads seconds and nanoseconds in UTC', () => {
    expect(timestampKey('1970-01-01T00:00:01.000000002Z')).toEqual([1, 2]);
    expect(timestampKey('1970-01-01T01:00:00+01:00')).toEqual([0, 0]);
    expect(timestampKey('not a time')).toBeNull();
  });
});

describe('printer rules', () => {
  const svc = (mode: 'replicated' | 'global' | 'job', desired: number) => ({ mode, replicas: { running: desired, desired } });
  const input = { allTasks: false, instance: undefined, noPrefix: false };

  it('prefixes lines that can come from several instances', () => {
    expect(logPrefixEnabled({ ...input, service: null })).toBe(true);
    expect(logPrefixEnabled({ ...input, service: svc('replicated', 2) })).toBe(true);
    expect(logPrefixEnabled({ ...input, service: svc('global', 1) })).toBe(true);
    expect(logPrefixEnabled({ ...input, service: svc('replicated', 1), allTasks: true })).toBe(true);
    expect(logPrefixEnabled({ ...input, service: svc('replicated', 1) })).toBe(false);
  });

  it('never prefixes a picked instance or with --no-prefix', () => {
    expect(logPrefixEnabled({ ...input, service: svc('replicated', 3), instance: 'web-7c9f-abcde' })).toBe(false);
    expect(logPrefixEnabled({ ...input, service: null, noPrefix: true })).toBe(false);
  });

  it('assigns stable colors in first-seen order, cycling through the palette', () => {
    const colors = new LogPrefixColors();
    const seen = ['web.a', 'web.b', 'web.a', 'db.0', 'web.c', 'web.d', 'web.e', 'web.f', 'web.b'].map((i) => colors.slotOf(i));
    expect(seen).toEqual([0, 1, 0, 2, 3, 4, 5, 0, 1]);
    expect(LOG_PREFIX_COLOR_COUNT).toBe(6);
  });
});
