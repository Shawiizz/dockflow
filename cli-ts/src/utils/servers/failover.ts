/**
 * Manager failover utilities
 * 
 * Handles multi-manager high availability:
 * - Check manager status (leader/reachable/unreachable)
 * - Find active manager with automatic failover
 */

import { sshExec } from '../ssh';
import { colors } from '../output';
import type { SSHKeyConnection, ResolvedServer } from '../../types';
import { getFullConnectionInfo } from './resolver';

/**
 * Check if a manager is reachable and get its Swarm status
 * Returns: 'leader' | 'reachable' | 'unreachable'
 */
export function checkManagerStatus(
  connection: SSHKeyConnection
): 'leader' | 'reachable' | 'unreachable' {
  try {
    // Quick connectivity check + Swarm leader status
    const result = sshExec(connection, 
      'docker info --format "{{.Swarm.ControlAvailable}}" 2>/dev/null || echo "error"'
    );
    
    if (result.exitCode !== 0 || result.stdout.trim() === 'error') {
      return 'unreachable';
    }
    
    // ControlAvailable = true means this node can accept manager commands
    // It may or may not be the leader, but it can handle deployments
    const controlAvailable = result.stdout.trim().toLowerCase() === 'true';
    
    if (controlAvailable) {
      // Check if this is specifically the leader
      const leaderCheck = sshExec(connection,
        'docker node inspect self --format "{{.ManagerStatus.Leader}}" 2>/dev/null || echo "false"'
      );
      
      if (leaderCheck.stdout.trim().toLowerCase() === 'true') {
        return 'leader';
      }
      return 'reachable';
    }
    
    return 'reachable'; // Node is up but not a manager or Swarm not initialized
  } catch {
    return 'unreachable';
  }
}

/**
 * Result of finding an active manager
 */
export interface ActiveManagerResult {
  manager: ResolvedServer;
  status: 'leader' | 'reachable';
  failedManagers: string[];
}

/**
 * Options for findActiveManager
 */
export interface FindActiveManagerOptions {
  /** Enable verbose output */
  verbose?: boolean;
  /** Prefer leader node (default: true) */
  preferLeader?: boolean;
}

/**
 * Find the active manager for deployment with failover
 * 
 * Strategy:
 * 1. Try each manager in order
 * 2. Prefer the leader if found
 * 3. Fall back to any reachable manager (Swarm will forward to leader)
 * 4. Return null if no managers are reachable
 */
export async function findActiveManager(
  env: string,
  managers: ResolvedServer[],
  options: FindActiveManagerOptions = {}
): Promise<ActiveManagerResult | null> {
  const { verbose = false, preferLeader = true } = options;
  const failedManagers: string[] = [];
  let firstReachable: { manager: ResolvedServer; status: 'leader' | 'reachable' } | null = null;
  
  for (const manager of managers) {
    const connection = getFullConnectionInfo(env, manager.name);
    if (!connection) {
      if (verbose) {
        console.log(`  ${colors.warning('⚠')} ${manager.name}: No SSH key configured`);
      }
      failedManagers.push(`${manager.name} (no SSH key)`);
      continue;
    }
    
    if (verbose) {
      process.stdout.write(`  Checking ${manager.name} (${manager.host})...`);
    }
    
    const status = checkManagerStatus(connection);
    
    if (status === 'unreachable') {
      if (verbose) {
        console.log(colors.error(' ✗ unreachable'));
      }
      failedManagers.push(`${manager.name} (unreachable)`);
      continue;
    }
    
    if (verbose) {
      console.log(status === 'leader' ? colors.success(' ✓ LEADER') : colors.success(' ✓ reachable'));
    }
    
    // If this is the leader and we prefer leader, return immediately
    if (status === 'leader' && preferLeader) {
      return { manager, status, failedManagers };
    }
    
    // Store first reachable manager as fallback
    if (!firstReachable) {
      firstReachable = { manager, status };
    }
    
    // If we found the leader but don't prefer it, keep it as best option
    if (status === 'leader') {
      firstReachable = { manager, status };
    }
  }
  
  // Return first reachable manager if no leader found (or preferLeader=false)
  if (firstReachable) {
    return { ...firstReachable, failedManagers };
  }
  
  return null;
}
