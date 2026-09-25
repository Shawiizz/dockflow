import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { fetchAuditWithFallback } from '../services/audit';
import type { ClusterNodeRef } from '../services/orchestrator/interfaces';
import * as ssh from '../utils/ssh';

function fakeNode(name: string, host: string): ClusterNodeRef {
  return { name, role: 'manager', host, privateHost: host, connection: { host, port: 22, user: 'deploy', privateKey: 'test-only-key' } };
}

// design-06 3.19 / R-S4-04: reads no longer target the first manager only.
describe('fetchAuditWithFallback', () => {
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
      if (conn.host === b.host) return { exitCode: 0, stdout: '2026-01-01T00:00:00Z | DEPLOYED | 1.0.0 | ci | \n', stderr: '' };
      return { exitCode: 0, stdout: '2026-01-02T00:00:00Z | DEPLOYED | 2.0.0 | ci | \n', stderr: '' };
    });

    const result = await fetchAuditWithFallback([a, b, c], 'shop-production', 20);

    expect(result.node?.name).toBe('server-2');
    expect(result.raw).toContain('1.0.0');
    expect(hosts).toEqual([a.host, b.host]); // never reaches the third node once one answers
  });

  it('every node unreachable or empty gives no data and a null node', async () => {
    const a = fakeNode('server-1', '10.0.0.1');
    const b = fakeNode('server-2', '10.0.0.2');
    spy = spyOn(ssh, 'sshExec').mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = await fetchAuditWithFallback([a, b], 'shop-production', 20);

    expect(result.raw).toBeNull();
    expect(result.node).toBeNull();
  });

  it('the first manager answering needs no fallback', async () => {
    const a = fakeNode('server-1', '10.0.0.1');
    spy = spyOn(ssh, 'sshExec').mockImplementation(async () => ({ exitCode: 0, stdout: '2026-01-01T00:00:00Z | DEPLOYED | 1.0.0 | ci | \n', stderr: '' }));

    const result = await fetchAuditWithFallback([a], 'shop-production', 20);

    expect(result.node?.name).toBe('server-1');
  });
});
