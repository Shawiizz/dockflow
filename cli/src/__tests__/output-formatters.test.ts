import { describe, expect, it } from 'bun:test';
import { formatDuration, formatBytes, formatRelativeTime } from '../utils/output';

describe('formatDuration', () => {
  it('seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('minutes with remaining seconds', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  it('hours with remaining minutes', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(7320)).toBe('2h 2m');
  });
});

describe('formatBytes', () => {
  it('zero and negative values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('bytes / KB / MB / GB boundaries', () => {
    expect(formatBytes(500)).toBe('500.0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('caps at TB for huge values', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });
});

describe('formatRelativeTime', () => {
  it('under a minute → just now', () => {
    expect(formatRelativeTime(new Date(Date.now() - 10_000).toISOString())).toBe('just now');
  });

  it('minutes ago', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });

  it('hours ago', () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });

  it('days ago', () => {
    expect(formatRelativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });

  it('over a week → locale date string', () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    expect(formatRelativeTime(old.toISOString())).toBe(old.toLocaleDateString());
  });
});
