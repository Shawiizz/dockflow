import { describe, expect, it } from 'bun:test';
import { parseIntParam } from '../api/routes/_helpers';
import { parseServiceLs, classifyTaskState } from '../api/routes/services';
import { normalizeEnv, normalizeStringArray } from '../api/routes/accessories';
import { mapMetricStatus } from '../api/routes/deploy';
import { parseSSHServerName, parseExecServiceName } from '../api/routes/ssh';

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

describe('parseServiceLs', () => {
  const table = [
    'ID      NAME           MODE         REPLICAS   IMAGE           PORTS',
    'abc123  myapp_web      replicated   2/2        nginx:latest    *:80->80/tcp',
    'def456  myapp_worker   replicated   0/1        worker:latest',
    'ghi789  myapp_api      replicated   1/2        api:latest',
  ].join('\n');

  it('parses the docker service ls table into typed rows', () => {
    const rows = parseServiceLs(table, 'myapp');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toMatchObject({ id: 'abc123', name: 'myapp_web', image: 'nginx:latest', replicas: 2, replicasRunning: 2, state: 'running' });
    expect(rows[0].ports).toEqual(['*:80->80/tcp']);
  });

  it('derives state from the replica counts', () => {
    const rows = parseServiceLs(table, 'myapp');
    expect(rows[1].state).toBe('stopped');  // 0/1
    expect(rows[2].state).toBe('starting'); // 1/2 partial — ambiguous until task states are checked
  });

  it('returns empty for header-only or empty output', () => {
    expect(parseServiceLs('ID  NAME  MODE  REPLICAS  IMAGE  PORTS', 'myapp')).toEqual([]);
    expect(parseServiceLs('', 'myapp')).toEqual([]);
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

describe('classifyTaskState', () => {
  it('treats running/starting/pending tasks as still converging', () => {
    expect(classifyTaskState('Running 3 seconds ago')).toBe('converging');
    expect(classifyTaskState('Starting 1 second ago')).toBe('converging');
    expect(classifyTaskState('Pending 4 seconds ago')).toBe('converging');
    expect(classifyTaskState('Preparing 2 seconds ago')).toBe('converging');
  });

  it('treats failed/rejected tasks as a real failure', () => {
    expect(classifyTaskState('Failed 2 seconds ago')).toBe('failed');
    expect(classifyTaskState('Rejected 5 seconds ago')).toBe('failed');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(classifyTaskState('  FAILED 2 seconds ago  ')).toBe('failed');
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

describe('WebSocket path parsers', () => {
  it('parses /ws/ssh/:server', () => {
    expect(parseSSHServerName('/ws/ssh/manager')).toBe('manager');
    expect(parseSSHServerName('/ws/ssh/prod%20node')).toBe('prod node');
  });

  it('rejects malformed ssh paths', () => {
    expect(parseSSHServerName('/ws/ssh/')).toBeNull();
    expect(parseSSHServerName('/ws/ssh/a/b')).toBeNull();
  });

  it('parses /ws/exec/:service and ignores the query string', () => {
    expect(parseExecServiceName('/ws/exec/web?env=prod')).toEqual({ serviceName: 'web' });
    expect(parseExecServiceName('/ws/exec/api')).toEqual({ serviceName: 'api' });
  });

  it('rejects malformed exec paths', () => {
    expect(parseExecServiceName('/ws/exec/')).toBeNull();
  });
});
