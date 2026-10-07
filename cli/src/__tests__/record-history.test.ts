import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { recordHistory } from '../commands/deploy-phases';
import type { DeployContext } from '../commands/deploy-context';
import * as HistorySync from '../services/history-sync';
import * as output from '../utils/output';

const node = (name: string) => ({ name, connection: { host: name, port: 22, user: 'deploy', privateKey: '' } });
const warnings: string[] = [];
const warn = spyOn(output, 'printWarning').mockImplementation((message: string) => {
  warnings.push(message);
});

afterEach(() => {
  warnings.length = 0;
  warn.mockClear();
});

function context(metricsFail: boolean) {
  const written: { nodeCount?: number } = {};
  const ctx = {
    stackName: 'shop-production',
    env: 'production',
    deployVersion: '1.4.2',
    branchName: 'main',
    options: {},
    skipAccessories: false,
    cluster: { manager: node('manager-1'), otherManagers: [node('manager-2')], workers: [node('worker-1')] },
    audit: { writeEntry: async () => 'audit line' },
    metrics: {
      writeDeployment: async (params: { nodeCount: number }) => {
        written.nodeCount = params.nodeCount;
        if (metricsFail) throw new Error('disk full');
        return '{"metric":1}';
      },
    },
  } as unknown as DeployContext;
  return { ctx, written };
}

describe('recordHistory', () => {
  it('writes the audit and the metrics, then copies them to every node but the deploying manager', async () => {
    const sync = spyOn(HistorySync, 'syncToAllNodes').mockResolvedValue(undefined);
    try {
      const { ctx, written } = context(false);
      await recordHistory(ctx, 'success', 1200, 'Deployed 1.4.2');
      expect(written.nodeCount).toBe(3);
      const [connections, stack, audit, metrics] = sync.mock.calls[0];
      expect(connections.map((c) => c.host)).toEqual(['manager-2', 'worker-1']);
      expect([stack, audit, metrics]).toEqual(['shop-production', 'audit line', '{"metric":1}']);
      expect(warnings).toEqual([]);
    } finally {
      sync.mockRestore();
    }
  });

  it('a failed write is a warning, and what was written is still copied', async () => {
    const sync = spyOn(HistorySync, 'syncToAllNodes').mockResolvedValue(undefined);
    try {
      const { ctx } = context(true);
      await recordHistory(ctx, 'failed', 1200, 'Deploy failed');
      expect(warnings).toEqual(['Metrics write failed: disk full']);
      expect(sync.mock.calls[0].slice(2)).toEqual(['audit line', '']);
    } finally {
      sync.mockRestore();
    }
  });
});
