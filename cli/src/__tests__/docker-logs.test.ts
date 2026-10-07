import { describe, expect, it } from 'bun:test';
import { LogLineBuffer, parseDockerLogLines } from '../utils/docker-logs';

describe('parseDockerLogLines', () => {
  it('parses RFC3339-prefixed lines into timestamp + message', () => {
    const out = parseDockerLogLines('2026-01-15T10:30:00.123456789Z Server started on :8080', 'web');
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe('2026-01-15T10:30:00.123456789Z');
    expect(out[0].message).toBe('Server started on :8080');
    expect(out[0].service).toBe('web');
  });

  it('lines without timestamp fall back to now', () => {
    const before = Date.now();
    const out = parseDockerLogLines('plain log line', 'web');
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('plain log line');
    expect(new Date(out[0].timestamp).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('skips empty and whitespace-only lines', () => {
    const out = parseDockerLogLines('\n2026-01-01T00:00:00Z a\n\n   \n2026-01-01T00:00:01Z b\n', 'svc');
    expect(out.map(l => l.message)).toEqual(['a', 'b']);
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
