/**
 * History Sync Service
 *
 * Replicates audit and metrics entries from the manager node
 * to all other Swarm nodes via SSH. Best-effort only — failures
 * are logged as warnings and never block a deploy.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printWarning, printDebug } from '../utils/output';
import { DOCKFLOW_AUDIT_DIR, DOCKFLOW_METRICS_DIR } from '../constants';

export class HistorySyncService {
  /**
   * Sync a single audit + metrics entry to one remote node.
   * Uses a single SSH call per node for both writes.
   */
  static async syncToNode(
    targetConnection: SSHKeyConnection,
    stackName: string,
    auditEntry: string,
    metricsEntry: string,
  ): Promise<void> {
    const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
    const metricsDir = `${DOCKFLOW_METRICS_DIR}/${stackName}`;
    const metricsFile = `${metricsDir}/deployments.json`;

    const escapedAudit = shellEscape(auditEntry);
    const escapedMetrics = shellEscape(metricsEntry);

    // Single SSH call: create dirs + append both entries independently
    try {
      await sshExec(
        targetConnection,
        `mkdir -p "${DOCKFLOW_AUDIT_DIR}" "${metricsDir}" && ` +
        `printf '%s\\n' '${escapedAudit}' >> "${auditFile}"; ` +
        `printf '%s\\n' '${escapedMetrics}' >> "${metricsFile}"`,
      );
    } catch (error) {
      printWarning(`History sync failed for ${targetConnection.host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sync audit + metrics entries to all non-manager nodes.
   * Uses Promise.allSettled — never throws.
   */
  static async syncToAllNodes(
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
        HistorySyncService.syncToNode(conn, stackName, auditEntry, metricsEntry),
      ),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      printWarning(`History sync failed on ${failed.length}/${otherConnections.length} node(s)`);
    }
  }
}
