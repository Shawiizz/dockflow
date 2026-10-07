import { describe, expect, it } from 'bun:test';
import { arrangeLogLines, LogLineBuffer, parseDockerLogLines, splitServiceLogsContext, splitTimestamp, timestampKey } from '../utils/docker-logs';

const TASK = 'shop-production_web.1.k2j3h4g5f6d7s8a9q1w2e3r4t';

describe('splitTimestamp', () => {
  it('cuts the RFC3339 timestamp off a line', () => {
    expect(splitTimestamp('2026-01-15T10:30:00.123456789Z Server started')).toEqual({
      timestamp: '2026-01-15T10:30:00.123456789Z',
      text: 'Server started',
    });
  });

  it('reads an offset and keeps the spaces of the message', () => {
    expect(splitTimestamp('2026-01-15T10:30:00+02:00   indented')).toEqual({ timestamp: '2026-01-15T10:30:00+02:00', text: '  indented' });
  });

  it('has no timestamp when the line does not start with one', () => {
    expect(splitTimestamp('plain log line')).toEqual({ timestamp: null, text: 'plain log line' });
    expect(splitTimestamp('error: 2026-01-15T10:30:00Z later')).toEqual({ timestamp: null, text: 'error: 2026-01-15T10:30:00Z later' });
  });

  it('keeps an empty message', () => {
    expect(splitTimestamp('2026-01-15T10:30:00Z')).toEqual({ timestamp: '2026-01-15T10:30:00Z', text: '' });
  });
});

describe('splitServiceLogsContext', () => {
  it('cuts the padded task and node context', () => {
    expect(splitServiceLogsContext(`${TASK}@manager1    | hello | world`)).toEqual({ task: TASK, node: 'manager1', text: 'hello | world' });
  });

  it('leaves a line that only looks like an address', () => {
    expect(splitServiceLogsContext('user@example.com | sent')).toBeNull();
    expect(splitServiceLogsContext('plain text')).toBeNull();
  });
});

describe('parseDockerLogLines', () => {
  it('parses RFC3339-prefixed lines into timestamp + message', () => {
    const out = parseDockerLogLines('2026-01-15T10:30:00.123456789Z Server started on :8080', 'web');
    expect(out).toEqual([{ timestamp: '2026-01-15T10:30:00.123456789Z', message: 'Server started on :8080', service: 'web' }]);
  });

  it('leaves a line without a timestamp undated instead of stamping it now', () => {
    const out = parseDockerLogLines('plain log line', 'web');
    expect(out).toEqual([{ timestamp: null, message: 'plain log line', service: 'web' }]);
  });

  it('strips the task context written before the timestamp', () => {
    const out = parseDockerLogLines(`${TASK}@manager1    | 2026-01-15T10:30:00Z ready`, 'web');
    expect(out).toEqual([{ timestamp: '2026-01-15T10:30:00Z', message: 'ready', service: 'web', instance: 'shop-production_web.1' }]);
  });

  it('strips the task context written after the timestamp', () => {
    const out = parseDockerLogLines(`2026-01-15T10:30:00Z ${TASK}@manager1    | ready`, 'web');
    expect(out).toEqual([{ timestamp: '2026-01-15T10:30:00Z', message: 'ready', service: 'web', instance: 'shop-production_web.1' }]);
  });

  it('skips empty and whitespace-only lines and drops carriage returns', () => {
    const out = parseDockerLogLines('\n2026-01-01T00:00:00Z a\r\n\n   \n2026-01-01T00:00:01Z b\n', 'svc');
    expect(out.map((l) => l.message)).toEqual(['a', 'b']);
  });

  it('empty input yields empty array', () => {
    expect(parseDockerLogLines('', 'svc')).toEqual([]);
    expect(parseDockerLogLines('   \n  ', 'svc')).toEqual([]);
  });
});

describe('LogLineBuffer', () => {
  it('returns the complete lines of a chunk', () => {
    const buffer = new LogLineBuffer();
    expect(buffer.push('first\nsecond\n')).toEqual(['first', 'second']);
    expect(buffer.flush()).toEqual([]);
  });

  it('keeps a line split across chunks whole', () => {
    const buffer = new LogLineBuffer();
    expect(buffer.push('GET /hea')).toEqual([]);
    expect(buffer.push('lth 200\nPOST')).toEqual(['GET /health 200']);
    expect(buffer.push(' /login 302\n')).toEqual(['POST /login 302']);
  });

  it('strips the carriage return of CRLF output', () => {
    const buffer = new LogLineBuffer();
    expect(buffer.push('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('keeps empty lines, which the caller decides about', () => {
    expect(new LogLineBuffer().push('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('hands out the unterminated last line on flush, once', () => {
    const buffer = new LogLineBuffer();
    expect(buffer.push('done\npartial')).toEqual(['done']);
    expect(buffer.flush()).toEqual(['partial']);
    expect(buffer.flush()).toEqual([]);
  });
});

describe('timestampKey', () => {
  it('orders RFC3339Nano timestamps whose fractions have different lengths', () => {
    const a = timestampKey('2026-01-15T10:30:00.5Z');
    const b = timestampKey('2026-01-15T10:30:00.123456789Z');
    expect(a && b && a[1] > b[1]).toBe(true);
  });

  it('takes the offset into account', () => {
    expect(timestampKey('2026-01-15T12:00:00+02:00')).toEqual(timestampKey('2026-01-15T10:00:00Z'));
  });

  it('is null for text that is not a timestamp', () => {
    expect(timestampKey('yesterday')).toBeNull();
  });
});

describe('arrangeLogLines', () => {
  const line = (timestamp: string | null, message: string, instance?: string) => ({ timestamp, message, service: 'web', instance });

  it('sorts the lines of several tasks by time', () => {
    const out = arrangeLogLines(
      [
        line('2026-01-15T10:00:02Z', 'c', 'shop-production_web.1'),
        line('2026-01-15T10:00:01.5Z', 'b', 'shop-production_web.2'),
        line('2026-01-15T10:00:01.25Z', 'a', 'shop-production_web.1'),
      ],
      'shop-production',
    );
    expect(out.map((l) => l.message)).toEqual(['a', 'b', 'c']);
  });

  it('labels the lines by task when the output has several, and by service otherwise', () => {
    const several = arrangeLogLines(
      [line('2026-01-15T10:00:00Z', 'a', 'shop-production_web.1'), line('2026-01-15T10:00:01Z', 'b', 'shop-production_web.2')],
      'shop-production',
    );
    expect(several.map((l) => l.service)).toEqual(['web.1', 'web.2']);

    const one = arrangeLogLines([line('2026-01-15T10:00:00Z', 'a', 'shop-production_web.1')], 'shop-production');
    expect(one.map((l) => l.service)).toEqual(['web']);
  });

  it('dates an undated line like the line before it', () => {
    const out = arrangeLogLines([line('2026-01-15T10:00:00Z', 'first'), line(null, 'continued')], 'shop-production');
    expect(out.map((l) => l.timestamp)).toEqual(['2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z']);
  });

  it('dates a leading undated line like the first dated one', () => {
    const out = arrangeLogLines([line(null, 'orphan'), line('2026-01-15T10:00:00Z', 'first')], 'shop-production');
    expect(out.map((l) => l.timestamp)).toEqual(['2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z']);
  });

  it('uses the given time only when no line has a timestamp', () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    expect(arrangeLogLines([line(null, 'x')], 'shop-production', now)[0].timestamp).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps the order of lines with the same timestamp', () => {
    const out = arrangeLogLines([line('2026-01-15T10:00:00Z', '1'), line('2026-01-15T10:00:00Z', '2'), line('2026-01-15T10:00:00Z', '3')], 's');
    expect(out.map((l) => l.message)).toEqual(['1', '2', '3']);
  });
});
