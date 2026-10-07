import { describe, expect, it } from 'bun:test';
import { parseIntParam } from '../api/routes/_helpers';
import { parseServiceLs, classifyTaskState } from '../api/routes/services';
import { normalizeEnv, normalizeStringArray } from '../api/routes/accessories';
import { mapMetricStatus } from '../api/routes/deploy';
import { parseAuditLine, parseDockerStatsLine, parseNodeStats } from '../api/routes/metrics';
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

describe('parseAuditLine', () => {
  it('splits the fields the audit service writes and trims them', () => {
    expect(parseAuditLine('2026-01-15T10:30:00.000Z | DEPLOYED | 1.2.3 | ci@runner | Deployment succeeded')).toEqual({
      timestamp: '2026-01-15T10:30:00.000Z',
      action: 'DEPLOYED',
      version: '1.2.3',
      performer: 'ci@runner',
      message: 'Deployment succeeded',
    });
  });

  it('keeps a message that contains the separator', () => {
    expect(parseAuditLine('2026-01-15T10:30:00Z | FAILED | 1.0.0 | me@pc | step a | step b')?.message).toBe('step a | step b');
  });

  it('keeps a pipe inside a field value', () => {
    expect(parseAuditLine('2026-01-15T10:30:00Z | DEPLOYED | v1|rc | me@pc | ok')?.version).toBe('v1|rc');
  });

  it('has no message when the line stops after the performer', () => {
    expect(parseAuditLine('2026-01-15T10:30:00Z | LOCKED | manual-lock | me@pc')?.message).toBeUndefined();
  });

  it('skips lines that are not audit entries', () => {
    expect(parseAuditLine('')).toBeNull();
    expect(parseAuditLine('just text')).toBeNull();
    expect(parseAuditLine(' | DEPLOYED | 1.0.0 | me@pc | x')).toBeNull();
  });
});

describe('parseDockerStatsLine', () => {
  it('reads the fields of a stats line', () => {
    expect(parseDockerStatsLine('S|abc123|shop_web.1.x|0.50%|12MiB / 1GiB|1.17%|1.2kB / 3kB|0B / 4.1kB')).toEqual({
      id: 'abc123',
      name: 'shop_web.1.x',
      cpuPercent: '0.50%',
      memUsage: '12MiB / 1GiB',
      memPercent: '1.17%',
      netIO: '1.2kB / 3kB',
      blockIO: '0B / 4.1kB',
    });
  });

  it('never leaves a column empty', () => {
    expect(parseDockerStatsLine('S|abc123|shop_web.1.x')).toEqual({
      id: 'abc123',
      name: 'shop_web.1.x',
      cpuPercent: '0.00%',
      memUsage: '0B / 0B',
      memPercent: '0.00%',
      netIO: '0B / 0B',
      blockIO: '0B / 0B',
    });
  });

  it('ignores lines that are not stats lines', () => {
    expect(parseDockerStatsLine('')).toBeNull();
    expect(parseDockerStatsLine('C|abc123|shop_web|shop')).toBeNull();
    expect(parseDockerStatsLine('Cannot connect to the Docker daemon')).toBeNull();
    expect(parseDockerStatsLine('S||name')).toBeNull();
  });
});

describe('parseNodeStats', () => {
  const stacks = { app: 'shop-production', accessories: 'shop-production-accessories' };
  const output = [
    'C|aaa111|shop-production_web|shop-production',
    'C|bbb222|shop-production-accessories_db|shop-production-accessories',
    'S|aaa111|shop-production_web.1.t1|0.10%|5MiB / 1GiB|0.50%|1kB / 1kB|0B / 0B',
    'S|bbb222|shop-production-accessories_db.1.t2|2.00%|100MiB / 1GiB|9.77%|2kB / 2kB|1MB / 5MB',
  ].join('\n');

  it('gives each container its node, compose service and role', () => {
    const entries = parseNodeStats(output, 'w1', stacks);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'shop-production_web.1.t1', node: 'w1', service: 'web', role: 'app', cpuPercent: '0.10%' });
    expect(entries[1]).toMatchObject({ name: 'shop-production-accessories_db.1.t2', node: 'w1', service: 'db', role: 'accessory' });
  });

  it('does not expose the container id', () => {
    expect(Object.keys(parseNodeStats(output, 'w1', stacks)[0])).not.toContain('id');
  });

  it('is empty when the node runs none of the stacks', () => {
    expect(parseNodeStats('', 'w1', stacks)).toEqual([]);
  });

  it('keeps a container whose listing line is missing', () => {
    const entries = parseNodeStats('S|zzz|orphan|1.00%|1MiB / 2MiB|50.00%|0B / 0B|0B / 0B', 'w1', stacks);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'orphan', node: 'w1', role: 'app' });
    expect(entries[0].service).toBeUndefined();
  });
});
