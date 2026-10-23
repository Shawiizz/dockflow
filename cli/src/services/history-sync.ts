/**
 * History sync — replicates audit and metrics entries from the manager to the other Swarm nodes
 * over SSH. Best-effort: failures are warnings and never block a deploy.
 */

import type { SSHKeyConnection } from '../types';
import { sh, sshExec } from '../utils/ssh';
import { printWarning, printDebug } from '../utils/output';
import { DOCKFLOW_AUDIT_DIR, DOCKFLOW_METRICS_DIR } from '../constants';

/** Appends one audit and one metrics entry on a node. A failure is a warning, never a throw. */
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
    await sshExec(targetConnection, sh`mkdir -p ${DOCKFLOW_AUDIT_DIR} ${metricsDir}`);

    const writes = await Promise.all([
      sshExec(targetConnection, sh`cat >> ${auditFile}`, { stdin: `${auditEntry}\n` }),
      sshExec(targetConnection, sh`cat >> ${metricsFile}`, { stdin: `${metricsEntry}\n` }),
    ]);
    const refused = writes.find((write) => write.exitCode !== 0);
    if (refused) throw new Error(refused.stderr.trim() || `exit ${refused.exitCode}`);
  } catch (error) {
    printWarning(`History sync failed for ${targetConnection.host}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Syncs the entries to every non-manager node in parallel. Never throws. */
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
