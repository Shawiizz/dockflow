/**
 * Swarm ClusterBackend: the control-plane probe of target resolution (the manager check used before
 * the rewrite: `docker info` ControlAvailable, then the leader flag) and `docker node ls`.
 */

import type { ClusterBackend, ClusterNodeRef, ControlPlaneProbe, NodeInfo, OrchestratorTarget } from '../interfaces';
import { errorText, firstLine, runSwarmQuery, type SwarmSsh, swarmNodeToServer, swarmSsh } from './swarm-utils';

export const SWARM_PROBE_COMMAND = 'docker info --format "{{.Swarm.ControlAvailable}}" 2>/dev/null || echo "error"';
export const SWARM_LEADER_COMMAND = 'docker node inspect self --format "{{.ManagerStatus.Leader}}" 2>/dev/null || echo "false"';
export const SWARM_NODE_LS_COMMAND = "docker node ls --format '{{json .}}'";
export const SWARM_SERVER_VERSION_COMMAND = "docker version --format '{{.Server.Version}}'";

export interface SwarmClusterBackendOptions {
  /** default: the real SSH transport */
  ssh?: SwarmSsh;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

/** One `docker node ls --format '{{json .}}'` row. */
export function parseNodeLsLine(line: string, nodeToServer: ReadonlyMap<string, string>): NodeInfo | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const name = stringField(record, 'Hostname');
  if (!name) return null;
  const version = stringField(record, 'EngineVersion');
  return {
    name,
    server: nodeToServer.get(name) ?? null,
    // ManagerStatus is empty for workers, Leader / Reachable / Unreachable for managers
    role: stringField(record, 'ManagerStatus') === '' ? 'worker' : 'manager',
    ready: stringField(record, 'Status').toLowerCase() === 'ready',
    schedulable: stringField(record, 'Availability').toLowerCase() === 'active',
    version: version === '' ? null : version,
    internalIp: null,
    pressure: [],
  };
}

export class SwarmClusterBackend implements ClusterBackend {
  private readonly ssh: SwarmSsh;

  constructor(
    private readonly target: OrchestratorTarget,
    options: SwarmClusterBackendOptions = {},
  ) {
    this.ssh = options.ssh ?? swarmSsh;
  }

  /**
   * `leader`, `ready` for another manager that can take orchestrator commands, `unready` for a
   * node where Docker answers but Swarm control is not available (not a manager, Swarm not
   * initialised), `unreachable` when SSH or Docker does not answer. Never throws.
   */
  async probe(node: ClusterNodeRef): Promise<ControlPlaneProbe> {
    try {
      const info = await this.ssh.exec(node, SWARM_PROBE_COMMAND);
      const control = info.stdout.trim().toLowerCase();
      if (info.exitCode !== 0 || control === 'error') {
        return { node: node.name, status: 'unreachable', detail: 'docker info failed' };
      }
      if (control !== 'true') {
        return { node: node.name, status: 'unready', detail: 'Swarm control is not available on this node (not a manager)' };
      }
      const leader = await this.ssh.exec(node, SWARM_LEADER_COMMAND);
      return { node: node.name, status: leader.stdout.trim().toLowerCase() === 'true' ? 'leader' : 'ready' };
    } catch (error) {
      return { node: node.name, status: 'unreachable', detail: errorText(error) };
    }
  }

  /** Swarm needs nothing prepared on the cluster before a deploy. */
  async preflight(_needs: { routes: boolean; volumes: boolean; helm: boolean }): Promise<void> {}

  async nodes(): Promise<NodeInfo[]> {
    const stdout = await runSwarmQuery(this.ssh, this.target.controlPlane, this.target.env, SWARM_NODE_LS_COMMAND, 'docker node ls');
    const nodeToServer = swarmNodeToServer(this.target);
    const nodes: NodeInfo[] = [];
    for (const line of (stdout ?? '').split('\n')) {
      if (!line.trim()) continue;
      const node = parseNodeLsLine(line.trim(), nodeToServer);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  async serverVersion(): Promise<string> {
    const stdout = await runSwarmQuery(
      this.ssh,
      this.target.controlPlane,
      this.target.env,
      SWARM_SERVER_VERSION_COMMAND,
      'docker version',
    );
    return firstLine(stdout ?? '');
  }
}
