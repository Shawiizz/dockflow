/**
 * Swarm helpers shared by the swarm modules: task listing, container lookup across nodes, and the
 * errors of failed docker reads.
 */

import type { SSHKeyConnection } from '../../types';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printDebug } from '../../utils/output';
import { DockerError, ErrorCode } from '../../utils/errors';

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

/** `<stack>_<service>`; a compose name may hold `_` itself (`web_app`), so only the stack prefix says it is qualified. */
export function qualifyServiceName(stackName: string, serviceName: string): string {
  return serviceName.startsWith(`${stackName}_`) ? serviceName : `${stackName}_${serviceName}`;
}

/** Races every node for the first container matching `labelFilter`: the node hosting a Swarm container is not known. */
async function findContainerByLabel(
  labelFilter: string,
  conns: SSHKeyConnection[],
  { includeStopped = false }: { includeStopped?: boolean } = {},
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  const psFlag = includeStopped ? '-a' : '';
  const cmd = `docker ps ${psFlag} --filter ${shellQuote(labelFilter)} --format '{{.ID}}' | head -n1`;

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

/** The running and historical tasks of a service, as the manager lists them; empty when the listing fails. */
export async function listSwarmTasks(
  stackName: string,
  serviceName: string,
  conn: SSHKeyConnection,
): Promise<SwarmTask[]> {
  const cmd =
    `docker service ps ${shellQuote(qualifyServiceName(stackName, serviceName))} --no-trunc ` +
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

/** The container backing a Swarm task, stopped ones included. */
export function findContainerForTask(
  taskId: string,
  conns: SSHKeyConnection[],
): Promise<{ containerId: string; connection: SSHKeyConnection } | null> {
  return findContainerByLabel(`label=com.docker.swarm.task.id=${taskId}`, conns, { includeStopped: true });
}

/** A running container of a service; `serviceName` may be bare or already qualified. */
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

const NOTHING_FOUND = /nothing found in stack/i;

/** A docker read that failed, said in terms of what to fix on the node. */
export function dockerQueryError(host: string, result: { stdout: string; stderr: string; exitCode: number }, what: string): DockerError {
  const text = `${result.stderr}\n${result.stdout}`;
  const suggestion = `Check Docker on ${host} with \`dockflow ssh <env>\`.`;
  if (/Cannot connect to the Docker daemon/i.test(text)) return new DockerError(`Docker is not running on ${host}`, { code: ErrorCode.DOCKER_NOT_AVAILABLE, suggestion });
  if (result.exitCode === 127 || /docker: (command )?not found/i.test(text)) return new DockerError(`Docker is not installed on ${host}`, { code: ErrorCode.DOCKER_NOT_AVAILABLE, suggestion });
  if (/not a swarm manager/i.test(text)) return new DockerError(`${host} is not a Swarm manager`, { suggestion });
  if (/permission denied.*docker/i.test(text)) return new DockerError(`The SSH user of ${host} is not allowed to use Docker`, { suggestion });
  const detail = text.split('\n').map((line) => line.trim()).find(Boolean) ?? `exit ${result.exitCode}`;
  return new DockerError(`${what} failed on ${host}: ${detail}`, { suggestion });
}

/** Runs a read-only docker command; null when docker says the stack holds nothing. */
export async function runDockerQuery(connection: SSHKeyConnection, command: string, what: string): Promise<string | null> {
  const result = await sshExec(connection, command);
  if (NOTHING_FOUND.test(result.stderr) || NOTHING_FOUND.test(result.stdout)) return null;
  if (result.exitCode !== 0) throw dockerQueryError(connection.host, result, what);
  return result.stdout;
}
