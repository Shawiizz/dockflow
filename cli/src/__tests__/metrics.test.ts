import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { calculateMetricsSummary, fetchMetricsWithFallback, parseJsonlLines, pruneMetricsOnAllNodes } from '../services/metrics';
import type { DeploymentMetric } from '../services/metrics';
import type { ClusterNodeRef } from '../services/orchestrator/interfaces';
import * as ssh from '../utils/ssh';

function fakeNode(name: string, host: string): ClusterNodeRef {
  return { name, role: 'manager', host, privateHost: host, connection: { host, port: 22, user: 'deploy', privateKey: 'test-only-key' } };
}

function metric(overrides: Partial<DeploymentMetric>): DeploymentMetric {
  return {
    id: 'id-1',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: 'production',
    branch: 'main',
    status: 'success',
    duration_ms: 10_000,
    performer: 'ci',
    build_skipped: false,
    accessories_deployed: false,
    node_count: 1,
    ...overrides,
  };
}

describe('parseJsonlLines', () => {
  it('parses one object per line', () => {
    const out = parseJsonlLines<{ a: number }>('{"a":1}\n{"a":2}\n');
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('empty or whitespace input → empty array', () => {
    expect(parseJsonlLines('')).toEqual([]);
    expect(parseJsonlLines('  \n  ')).toEqual([]);
  });

  it('skips malformed lines but keeps valid ones', () => {
    const out = parseJsonlLines<{ a: number }>('{"a":1}\nnot json\n{"a":3}\n');
    expect(out).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('skips blank lines between entries', () => {
    const out = parseJsonlLines<{ a: number }>('{"a":1}\n\n\n{"a":2}');
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('calculateMetricsSummary', () => {
  it('empty input gives zeroed summary', () => {
    const summary = calculateMetricsSummary([]);
    expect(summary.total_deployments).toBe(0);
    expect(summary.success_rate).toBe(0);
    expect(summary.avg_duration_ms).toBe(0);
    expect(summary.last_deployment).toBeUndefined();
    expect(summary.most_deployed_versions).toEqual([]);
  });

  it('counts statuses and computes success rate', () => {
    const metrics = [
      metric({ status: 'success' }),
      metric({ status: 'success' }),
      metric({ status: 'failed' }),
      metric({ status: 'rolled_back' }),
    ];
    const summary = calculateMetricsSummary(metrics);
    expect(summary.total_deployments).toBe(4);
    expect(summary.successful).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.rolled_back).toBe(1);
    expect(summary.success_rate).toBe(50);
  });

  it('avg duration only counts successful deployments', () => {
    const metrics = [
      metric({ status: 'success', duration_ms: 10_000 }),
      metric({ status: 'success', duration_ms: 20_000 }),
      metric({ status: 'failed', duration_ms: 500_000 }), // ignored
    ];
    expect(calculateMetricsSummary(metrics).avg_duration_ms).toBe(15_000);
  });

  it('last_deployment is the most recent by timestamp', () => {
    const old = metric({ id: 'old', timestamp: '2026-01-01T00:00:00Z' });
    const recent = metric({ id: 'recent', timestamp: '2026-06-01T00:00:00Z' });
    const summary = calculateMetricsSummary([old, recent]);
    expect(summary.last_deployment!.id).toBe('recent');
  });

  it('time windows: 24h / 7d / 30d', () => {
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const metrics = [
      metric({ timestamp: hoursAgo(1) }),       // in all windows
      metric({ timestamp: hoursAgo(48) }),      // 7d + 30d
      metric({ timestamp: hoursAgo(24 * 20) }), // 30d only
      metric({ timestamp: hoursAgo(24 * 60) }), // outside all windows
    ];
    const summary = calculateMetricsSummary(metrics);
    expect(summary.deployments_last_24h).toBe(1);
    expect(summary.deployments_last_7d).toBe(2);
    expect(summary.deployments_last_30d).toBe(3);
  });

  it('most_deployed_versions sorted by count, capped at 5', () => {
    const metrics = [
      ...Array(3).fill(0).map(() => metric({ version: 'v3' })),
      ...Array(2).fill(0).map(() => metric({ version: 'v2' })),
      metric({ version: 'a' }),
      metric({ version: 'b' }),
      metric({ version: 'c' }),
      metric({ version: 'd' }),
    ];
    const summary = calculateMetricsSummary(metrics);
    expect(summary.most_deployed_versions).toHaveLength(5);
    expect(summary.most_deployed_versions[0]).toEqual({ version: 'v3', count: 3 });
    expect(summary.most_deployed_versions[1]).toEqual({ version: 'v2', count: 2 });
  });
});

// design-06 3.19 / R-S4-04: reads and --prune no longer target the first manager only.
describe('fetchMetricsWithFallback', () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  it('falls back past an unreachable node and stops at the first non-empty result', async () => {
    const a = fakeNode('server-1', '10.0.0.1');
    const b = fakeNode('server-2', '10.0.0.2');
    const c = fakeNode('server-3', '10.0.0.3');
    const hosts: string[] = [];
    spy = spyOn(ssh, 'sshExec').mockImplementation(async (conn) => {
      hosts.push(conn.host);
      if (conn.host === a.host) throw new Error('connection refused');
      if (conn.host === b.host) return { exitCode: 0, stdout: '{"id":"m1"}\n', stderr: '' };
      return { exitCode: 0, stdout: '{"id":"m2"}\n', stderr: '' };
    });

    const result = await fetchMetricsWithFallback([a, b, c], 'shop-production', 20);

    expect(result.node?.name).toBe('server-2');
    expect(result.metrics).toEqual([{ id: 'm1' } as unknown as DeploymentMetric]);
    expect(hosts).toEqual([a.host, b.host]); // never reaches the third node once one answers
  });

  it('every node unreachable or empty gives no metrics and a null node', async () => {
    const a = fakeNode('server-1', '10.0.0.1');
    const b = fakeNode('server-2', '10.0.0.2');
    spy = spyOn(ssh, 'sshExec').mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = await fetchMetricsWithFallback([a, b], 'shop-production');

    expect(result.metrics).toEqual([]);
    expect(result.node).toBeNull();
  });
});

describe('pruneMetricsOnAllNodes', () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  it('runs on every reachable node and reports the failure of one without dropping the others', async () => {
    const a = fakeNode('server-1', '10.0.0.1');
    const b = fakeNode('server-2', '10.0.0.2');
    spy = spyOn(ssh, 'sshExec').mockImplementation(async (conn, command) => {
      if (conn.host === a.host) throw new Error('node unreachable');
      if (command.startsWith('wc -l')) return { exitCode: 0, stdout: '1500\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const outcomes = await pruneMetricsOnAllNodes([a, b], 'shop-production', 1000);

    expect(outcomes).toHaveLength(2);
    const failed = outcomes.find((o) => o.node === 'server-1');
    expect(failed?.removed).toBe(0);
    expect(failed?.error).toBeDefined();
    expect(outcomes.find((o) => o.node === 'server-2')).toEqual({ node: 'server-2', removed: 500 });
  });
});
