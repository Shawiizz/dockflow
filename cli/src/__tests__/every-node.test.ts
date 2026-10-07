import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { onEveryNode, readFromFirstNode } from '../commands/app/nodes';
import * as output from '../utils/output';
import type { SSHKeyConnection } from '../types';

const node = (name: string) => ({ name, connection: { host: name, port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection });
const warned: string[] = [];
const dimmed: string[] = [];
spyOn(output, 'printDim').mockImplementation((message: string) => {
  dimmed.push(message);
});
const warn = spyOn(output, 'printWarning').mockImplementation((message: string) => {
  warned.push(message);
});

afterEach(() => {
  warned.length = 0;
  dimmed.length = 0;
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

describe('readFromFirstNode', () => {
  it('skips a node that does not answer or has nothing, and says which node it read', async () => {
    const found = await readFromFirstNode(
      [node('manager-1'), node('manager-2'), node('worker-1')],
      async (n) => {
        if (n.name === 'manager-1') throw new Error('connect ECONNREFUSED');
        return n.name === 'manager-2' ? '' : 'entries';
      },
      (value) => value === '',
    );
    expect(found?.node.name).toBe('worker-1');
    expect(found?.value).toBe('entries');
    expect(dimmed).toEqual(['Read from worker-1']);
  });

  it('reads the first node quietly, and gives null when every node is empty', async () => {
    expect((await readFromFirstNode([node('manager-1')], async () => 'x', (v) => v === ''))?.value).toBe('x');
    expect(dimmed).toEqual([]);
    expect(await readFromFirstNode([node('manager-1'), node('worker-1')], async () => '', (v) => v === '')).toBeNull();
  });
});
