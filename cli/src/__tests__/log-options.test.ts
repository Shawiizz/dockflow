import { describe, expect, it } from 'bun:test';
import { dockerSinceValue, parseCountOption, parseSince, parseTailOption, SINCE_ERROR_MESSAGE } from '../utils/log-options';
import { ValidationError } from '../utils/errors';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

describe('parseSince', () => {
  // [input, local offset (minutes east of UTC), docker value]
  const table: [string, number, string][] = [
    ['30m', 0, '30m'],
    ['1h30m', 0, '1h30m'],
    ['500ms', 0, '500ms'],
    ['90s', 0, '90s'],
    ['1h', 0, '1h'],
    ['2d', 0, '48h'],
    ['2026-09-17', -120, '2026-09-17T02:00:00Z'],
    ['2026-09-17', 0, '2026-09-17T00:00:00Z'],
    ['2026-09-17', 330, '2026-09-16T18:30:00Z'],
    ['2026-01-01', 0, '2026-01-01T00:00:00Z'],
    ['2026-09-17T10:00', 120, '2026-09-17T08:00:00Z'],
    ['2026-09-17T10:00:30', 0, '2026-09-17T10:00:30Z'],
    ['2026-01-01T10:00:00Z', 330, '2026-01-01T10:00:00Z'],
    ['2026-09-17T10:00:00.123456789Z', 0, '2026-09-17T10:00:00.123456789Z'],
    ['2026-09-17T10:00:00+02:00', 0, '2026-09-17T08:00:00Z'],
    ['2026-09-17T10:00:00-05:30', 0, '2026-09-17T15:30:00Z'],
    ['1758100000', 0, '1758100000'],
    ['1758100000.5', 0, '1758100000.5'],
  ];
  for (const [raw, offset, docker] of table) {
    it(`${raw} (offset ${offset}) -> ${docker}`, () => {
      expect(dockerSinceValue(parseSince(raw, offset))).toBe(docker);
    });
  }

  it('returns the parsed form', () => {
    expect(parseSince('2d', 0)).toEqual({ kind: 'duration', goDuration: '48h' });
    expect(parseSince('2026-09-17', 0)).toEqual({ kind: 'instant', iso: '2026-09-17T00:00:00Z', unixSeconds: null });
    expect(parseSince('1758100000', 0)).toEqual({ kind: 'instant', iso: '2025-09-17T09:06:40Z', unixSeconds: '1758100000' });
  });

  it('re-reads the local offset at the resulting instant across a daylight-saving change', () => {
    // UTC+1 until 2026-03-29T01:00Z, UTC+2 after
    const paris = (at: Date) => (at.getTime() >= Date.UTC(2026, 2, 29, 1) ? 120 : 60);
    expect(dockerSinceValue(parseSince('2026-03-29', paris))).toBe('2026-03-28T23:00:00Z');
    expect(dockerSinceValue(parseSince('2026-03-30', paris))).toBe('2026-03-29T22:00:00Z');
    expect(dockerSinceValue(parseSince('2026-03-29T01:30', paris))).toBe('2026-03-29T00:30:00Z');
  });

  const rejected = ['yesterday', '10', '1h-5m', '', '-5m', '2d3h', '1.5d', '2026-02-30', '2026-13-01', '2026-09-17T24:00', '2026-09-17 10:00', '12345678'];
  for (const raw of rejected) {
    it(`rejects ${JSON.stringify(raw)} with one message`, () => {
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
});

describe('parseCountOption', () => {
  it('reads a positive count', () => {
    expect(parseCountOption('50', '--lines')).toBe(50);
  });

  it('refuses anything else, naming the option', () => {
    for (const raw of ['abc', '0', '-3', '2.5', '']) {
      expect(() => parseCountOption(raw, '--lines')).toThrow('--lines must be a positive integer');
    }
  });
});
