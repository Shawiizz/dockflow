/**
 * History Sync — audit/metrics replication module.
 *
 * Replicates audit and metrics entries from the manager node
 * to all other Swarm nodes via SSH. Best-effort only — failures
 * are logged as warnings and never block a deploy.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from '../utils/ssh';
import { printWarning, printDebug } from '../utils/output';
import { DOCKFLOW_AUDIT_DIR, DOCKFLOW_METRICS_DIR } from '../constants';

/**
 * Sync a single audit + metrics entry to one remote node.
 */
export async function syncToNode(
  targetConnection: SSHKeyConnection,
  stackName: string,
  auditEntry: string,
  metricsEntry: string,
): Promise<void> {
  const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
  const metricsDir = `${DOCKFLOW_METRICS_DIR}/${stackName}`;
  const metricsFile = `${metricsDir}/deployments.json`;

  try {
    await sshExec(targetConnection, `mkdir -p "${DOCKFLOW_AUDIT_DIR}" "${metricsDir}"`);

    const [auditHandle, metricsHandle] = await Promise.all([
      sshExecChannel(targetConnection, `cat >> "${auditFile}"`),
      sshExecChannel(targetConnection, `cat >> "${metricsFile}"`),
    ]);

    auditHandle.stream.end(auditEntry + '\n');
    metricsHandle.stream.end(metricsEntry + '\n');

    await Promise.all([auditHandle.done, metricsHandle.done]);
  } catch (error) {
    printWarning(`History sync failed for ${targetConnection.host}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sync audit + metrics entries to all non-manager nodes.
 * Best-effort — never throws.
 */
export async function syncToAllNodes(
  otherConnections: SSHKeyConnection[],
  stackName: string,
  auditEntry: string,
  metricsEntry: string,
): Promise<void> {
  if (otherConnections.length === 0) {
    printDebug('No other nodes to sync history to');
    return;
  }

  printDebug(`Syncing history to ${otherConnections.length} node(s)`);

  const results = await Promise.allSettled(
    otherConnections.map((conn) =>
      syncToNode(conn, stackName, auditEntry, metricsEntry),
    ),
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    printWarning(`History sync failed on ${failed.length}/${otherConnections.length} node(s)`);
  }
}
