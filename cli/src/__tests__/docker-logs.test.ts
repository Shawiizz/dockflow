import { describe, expect, it } from 'bun:test';
import { LogLineBuffer, splitServiceLogsContext } from '../utils/docker-logs';

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

describe('splitServiceLogsContext', () => {
  it('splits the padded task and node context of docker service logs', () => {
    expect(splitServiceLogsContext('shop-production_web.2.x2x4qabcdef@worker-1    | GET / 200')).toEqual({
      task: 'shop-production_web.2.x2x4qabcdef',
      node: 'worker-1',
      text: 'GET / 200',
    });
  });

  it('keeps pipes inside the message', () => {
    expect(splitServiceLogsContext('web.1.abc@manager-1 | a | b')?.text).toBe('a | b');
  });

  it('keeps a timestamp that follows the context in the text', () => {
    expect(splitServiceLogsContext('web.2.x2x4q@worker-1    | 2026-09-17T10:00:00.123456789Z GET /')).toEqual({
      task: 'web.2.x2x4q',
      node: 'worker-1',
      text: '2026-09-17T10:00:00.123456789Z GET /',
    });
  });

  it('returns null for a line without context', () => {
    expect(splitServiceLogsContext('plain log line')).toBeNull();
    expect(splitServiceLogsContext('2026-09-17T10:00:00Z web.2.x@worker-1    | GET /')).toBeNull();
  });
});
