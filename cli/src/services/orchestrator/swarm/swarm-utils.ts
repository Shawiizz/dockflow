/**
 * Shared helpers for Swarm operations that search across nodes.
 */

import type { SSHKeyConnection } from '../../../types';
import { sshExec } from '../../../utils/ssh';
import { printDebug } from '../../../utils/output';

/**
 * Find a running container for a Swarm service by searching every node in parallel.
 * Returns the node connection + container ID of whichever node responds first.
 *
 * Accepts `serviceName` either bare (resolved with `${stackName}_` prefix) or
 * already fully-qualified (contains `_`).
 */
export async function findSwarmContainer(
  stackName: string,
  serviceName: string,
  conn: SSHKeyConnection,
  allConnections: SSHKeyConnection[] = [],
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  const fullServiceName = serviceName.includes('_')
    ? serviceName
    : `${stackName}_${serviceName}`;

  const cmd = `docker ps --filter 'label=com.docker.swarm.service.name=${fullServiceName}' --format '{{.ID}}' | head -n1`;

  const seen = new Set<string>();
  const conns: SSHKeyConnection[] = [];
  for (const c of [conn, ...allConnections]) {
    const key = `${c.host}:${c.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      conns.push(c);
    }
  }

  const promises = conns.map(async (connection) => {
    const result = await sshExec(connection, cmd);
    const containerId = result.stdout.trim();
    if (!containerId) throw new Error('not found');
    return { containerId, connection };
  });

  try {
    return await Promise.any(promises);
  } catch (e) {
    printDebug(`Container not found on any node: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
