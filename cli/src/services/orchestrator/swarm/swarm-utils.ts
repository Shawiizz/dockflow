/**
 * Shared helpers for Swarm operations that search across nodes.
 */

import type { SSHKeyConnection } from '../../../types';
import { sshExec } from '../../../utils/ssh';
import { printDebug } from '../../../utils/output';

export interface SwarmTask {
  id: string;
  node: string;
  slot: string;
  desiredState: string;
  currentState: string;
  error?: string;
}

function dedupeConnections(conns: SSHKeyConnection[]): SSHKeyConnection[] {
  const seen = new Set<string>();
  return conns.filter(c => {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function qualifyServiceName(stackName: string, serviceName: string): string {
  return serviceName.includes('_') ? serviceName : `${stackName}_${serviceName}`;
}

/**
 * Race every node in parallel for the first container matching `labelFilter`.
 * Used to locate a Swarm-managed container without knowing which node hosts it.
 */
async function findContainerByLabel(
  labelFilter: string,
  conns: SSHKeyConnection[],
  { includeStopped = false }: { includeStopped?: boolean } = {},
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  const psFlag = includeStopped ? '-a' : '';
  const cmd = `docker ps ${psFlag} --filter '${labelFilter}' --format '{{.ID}}' | head -n1`;

  const promises = dedupeConnections(conns).map(async (connection) => {
    const result = await sshExec(connection, cmd);
    const containerId = result.stdout.trim();
    if (!containerId) throw new Error('not found');
    return { containerId, connection };
  });

  try {
    return await Promise.any(promises);
  } catch (e) {
    printDebug(`Container not found for ${labelFilter}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** List Swarm tasks (running + historical) for a service via the manager. */
export async function listSwarmTasks(
  stackName: string,
  serviceName: string,
  conn: SSHKeyConnection,
): Promise<SwarmTask[]> {
  const cmd =
    `docker service ps ${qualifyServiceName(stackName, serviceName)} --no-trunc ` +
    `--format '{{.ID}}\t{{.Node}}\t{{.Name}}\t{{.DesiredState}}\t{{.CurrentState}}\t{{.Error}}' 2>/dev/null`;

  const result = await sshExec(conn, cmd);
  if (result.exitCode !== 0) return [];

  const tasks: SwarmTask[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, node, name, desiredState, currentState, error] = trimmed.split('\t');
    const slot = name?.split('.').pop() ?? '?';
    tasks.push({ id, node, slot, desiredState, currentState, error: error || undefined });
  }
  return tasks;
}

/** Locate the container (including stopped) backing a specific Swarm task. */
export function findContainerForTask(
  taskId: string,
  conns: SSHKeyConnection[],
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  return findContainerByLabel(`label=com.docker.swarm.task.id=${taskId}`, conns, { includeStopped: true });
}

/** Locate a running container for a Swarm service. `serviceName` may be bare or already qualified. */
export function findSwarmContainer(
  stackName: string,
  serviceName: string,
  conn: SSHKeyConnection,
  allConnections: SSHKeyConnection[] = [],
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  return findContainerByLabel(
    `label=com.docker.swarm.service.name=${qualifyServiceName(stackName, serviceName)}`,
    [conn, ...allConnections],
  );
}
