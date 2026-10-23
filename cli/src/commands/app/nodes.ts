/**
 * Day-2 commands that read or clean every node: a service's containers run wherever Swarm put
 * them, workers and other managers included.
 */

import type { SSHKeyConnection } from '../../types';
import { getAllNodes } from '../../utils/validation';
import { printDebug, printDim, printWarning } from '../../utils/output';
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

export type NodeOutcome<N, T> =
  | { node: N; ok: true; value: T }
  | { node: N; ok: false; error: string };

/** Runs `run` on every node at once; a node that fails is an outcome, not an exception. */
export async function settleOnEveryNode<N, T>(nodes: readonly N[], run: (node: N) => Promise<T>): Promise<NodeOutcome<N, T>[]> {
  return Promise.all(
    nodes.map(async (node): Promise<NodeOutcome<N, T>> => {
      try {
        return { node, ok: true, value: await run(node) };
      } catch (error) {
        return { node, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/**
 * Runs `fn` on every node at once. A node that fails is reported and left out; only when every
 * node failed does the command fail.
 */
export async function onEveryNode<T>(nodes: readonly NodeRef[], fn: (node: NodeRef) => Promise<T>): Promise<{ node: NodeRef; value: T }[]> {
  const results: { node: NodeRef; value: T }[] = [];
  const failures: string[] = [];
  for (const outcome of await settleOnEveryNode(nodes, fn)) {
    if (outcome.ok) results.push({ node: outcome.node, value: outcome.value });
    else failures.push(`${outcome.node.name}: ${outcome.error}`);
  }
  if (results.length === 0 && failures.length > 0) {
    throw new ConnectionError(`No node answered:\n  ${failures.join('\n  ')}`);
  }
  for (const failure of failures) printWarning(`Skipped ${failure}`);
  return results;
}

/**
 * For data every node keeps a copy of (history, metrics): the first node, in order, that answers
 * with something. Says which node it read when that is not the first.
 */
export async function readFromFirstNode<T>(
  nodes: readonly NodeRef[],
  read: (node: NodeRef) => Promise<T>,
  isEmpty: (value: T) => boolean,
): Promise<{ node: NodeRef; value: T } | null> {
  for (const [index, node] of nodes.entries()) {
    try {
      const value = await read(node);
      if (isEmpty(value)) continue;
      if (index > 0) printDim(`Read from ${node.name}`);
      return { node, value };
    } catch (error) {
      printDebug(`${node.name} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
