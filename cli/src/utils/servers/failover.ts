/**
 * Manager failover: which manager of an environment can take Swarm commands now.
 */

import { sshExec } from '../ssh';
import { printError, printSuccess, printWarning } from '../output';
import type { SSHKeyConnection, ResolvedServer } from '../../types';
import { getFullConnectionInfo } from './resolver';

/**
 * - leader: the Raft leader
 * - reachable: a manager that takes Swarm commands
 * - unready: Docker answers, but the node cannot take Swarm commands (not a manager, or no quorum)
 * - unreachable: no answer over SSH or from Docker
 */
export type ManagerStatus = 'leader' | 'reachable' | 'unready' | 'unreachable';

export async function checkManagerStatus(connection: SSHKeyConnection): Promise<ManagerStatus> {
  try {
    const result = await sshExec(connection,
      'docker info --format "{{.Swarm.ControlAvailable}}" 2>/dev/null || echo "error"'
    );

    if (result.exitCode !== 0 || result.stdout.trim() === 'error') {
      return 'unreachable';
    }

    if (result.stdout.trim().toLowerCase() !== 'true') return 'unready';

    const leaderCheck = await sshExec(connection,
      'docker node inspect self --format "{{.ManagerStatus.Leader}}" 2>/dev/null || echo "false"'
    );
    return leaderCheck.stdout.trim().toLowerCase() === 'true' ? 'leader' : 'reachable';
  } catch {
    return 'unreachable';
  }
}

export interface ActiveManagerResult {
  manager: ResolvedServer;
  status: 'leader' | 'reachable';
  /** `name (reason)` of each manager that cannot be used */
  failedManagers: string[];
  /** names of the managers that cannot be used */
  unavailable: string[];
}

export interface FindActiveManagerOptions {
  /** print each manager's status */
  verbose?: boolean;
  /** pick the leader over earlier managers that also answer (default: true) */
  preferLeader?: boolean;
}

const FAILURE_LABEL: Record<'unready' | 'unreachable', string> = {
  unready: 'cannot take Swarm commands',
  unreachable: 'unreachable',
};

/**
 * Probes every manager at once and returns the leader, or else the first manager in the given
 * order that takes Swarm commands (it forwards to the leader). Null when none does.
 */
export async function findActiveManager(
  env: string,
  managers: ResolvedServer[],
  options: FindActiveManagerOptions = {}
): Promise<ActiveManagerResult | null> {
  const { verbose = false, preferLeader = true } = options;

  const probes = await Promise.all(managers.map(async (manager) => {
    const connection = getFullConnectionInfo(env, manager.name);
    const status: ManagerStatus | 'no-key' = connection ? await checkManagerStatus(connection) : 'no-key';
    return { manager, status };
  }));

  const failedManagers: string[] = [];
  for (const { manager, status } of probes) {
    if (status === 'no-key') {
      if (verbose) printWarning(`${manager.name}: No SSH key configured`);
      failedManagers.push(`${manager.name} (no SSH key)`);
    } else if (status === 'unready' || status === 'unreachable') {
      if (verbose) printError(`${manager.name} (${manager.host}): ${FAILURE_LABEL[status]}`);
      failedManagers.push(`${manager.name} (${FAILURE_LABEL[status]})`);
    } else if (verbose) {
      printSuccess(`${manager.name} (${manager.host}): ${status === 'leader' ? 'LEADER' : 'reachable'}`);
    }
  }

  const chosen = pickActiveManager(probes, preferLeader);
  const unavailable = probes.filter((p) => p.status !== 'leader' && p.status !== 'reachable').map((p) => p.manager.name);
  return chosen ? { ...chosen, failedManagers, unavailable } : null;
}

/** The leader (when preferred), else the first manager in order that takes Swarm commands. */
export function pickActiveManager<T>(
  probes: readonly { manager: T; status: ManagerStatus | 'no-key' }[],
  preferLeader = true,
): { manager: T; status: 'leader' | 'reachable' } | null {
  const usable = probes.filter(
    (p): p is { manager: T; status: 'leader' | 'reachable' } => p.status === 'leader' || p.status === 'reachable',
  );
  return (preferLeader ? usable.find((p) => p.status === 'leader') : undefined) ?? usable[0] ?? null;
}
