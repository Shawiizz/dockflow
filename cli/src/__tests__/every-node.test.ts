import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { onEveryNode } from '../commands/app/nodes';
import * as output from '../utils/output';
import type { SSHKeyConnection } from '../types';

const node = (name: string) => ({ name, connection: { host: name, port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection });
const warned: string[] = [];
const warn = spyOn(output, 'printWarning').mockImplementation((message: string) => {
  warned.push(message);
});

afterEach(() => {
  warned.length = 0;
  warn.mockClear();
});

describe('onEveryNode', () => {
  it('keeps the nodes that answered and names the ones skipped', async () => {
    const results = await onEveryNode([node('manager-1'), node('worker-1')], async (n) => {
      if (n.name === 'worker-1') throw new Error('connect ETIMEDOUT');
      return 3;
    });
    expect(results.map((r) => [r.node.name, r.value])).toEqual([['manager-1', 3]]);
    expect(warned).toEqual(['Skipped worker-1: connect ETIMEDOUT']);
  });

  it('fails when no node answered', async () => {
    await expect(onEveryNode([node('manager-1')], async () => { throw new Error('down'); })).rejects.toThrow('No node answered');
  });
});
