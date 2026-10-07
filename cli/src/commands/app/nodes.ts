/**
 * Day-2 commands that read or clean every node: a service's containers run wherever Swarm put
 * them, workers and other managers included.
 */

import type { SSHKeyConnection } from '../../types';
import { getAllNodes } from '../../utils/validation';
import { printWarning } from '../../utils/output';
import { ConnectionError } from '../../utils/errors';

export interface NodeRef {
  name: string;
  connection: SSHKeyConnection;
}

/** The environment's nodes; the manager in use first, even when it is not in servers.yml order. */
export function nodesOf(env: string, manager: NodeRef): NodeRef[] {
  const others = getAllNodes(env).filter((node) => node.name !== manager.name);
  return [manager, ...others];
}

/**
 * Runs `fn` on every node at once. A node that fails is reported and left out; only when every
 * node failed does the command fail.
 */
export async function onEveryNode<T>(nodes: readonly NodeRef[], fn: (node: NodeRef) => Promise<T>): Promise<{ node: NodeRef; value: T }[]> {
  const settled = await Promise.allSettled(nodes.map(fn));
  const results: { node: NodeRef; value: T }[] = [];
  const failures: string[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') results.push({ node: nodes[index], value: outcome.value });
    else failures.push(`${nodes[index].name}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
  });
  if (results.length === 0 && failures.length > 0) {
    throw new ConnectionError(`No node answered:\n  ${failures.join('\n  ')}`);
  }
  for (const failure of failures) printWarning(`Skipped ${failure}`);
  return results;
}
