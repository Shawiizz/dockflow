import { describe, expect, it } from 'bun:test';
import { incrementVersion } from '../utils/version';

describe('incrementVersion', () => {
  it('increments patch', () => {
    expect(incrementVersion('1.0.0')).toBe('1.0.1');
    expect(incrementVersion('2.3.9')).toBe('2.3.10');
  });

  it('increments numeric suffix after letter', () => {
    expect(incrementVersion('1.0.0-beta2')).toBe('1.0.0-beta3');
    expect(incrementVersion('1.0.0-rc1')).toBe('1.0.0-rc2');
  });

  it('appends 2 to plain pre-release label', () => {
    expect(incrementVersion('1.0.0-beta')).toBe('1.0.0-beta2');
  });

  it('increments dash-number suffix', () => {
    expect(incrementVersion('1.0.0-2')).toBe('1.0.0-3');
    expect(incrementVersion('main-abc123-2')).toBe('main-abc123-3');
  });

  it('branch-SHA pattern → appends -2', () => {
    expect(incrementVersion('main-abc12345')).toBe('main-abc12345-2');
    expect(incrementVersion('develop-f3a1b2c8')).toBe('develop-f3a1b2c8-2');
  });

  it('fallback → appends -2', () => {
    expect(incrementVersion('custom')).toBe('custom-2');
  });
});
