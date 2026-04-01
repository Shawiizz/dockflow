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
   *
   * Both writes are wrapped individually so a failure in one
   * does not prevent the other from executing.
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

    // Audit
    try {
      const escapedAudit = shellEscape(auditEntry);
      await sshExec(
        targetConnection,
        `mkdir -p "${DOCKFLOW_AUDIT_DIR}" && echo '${escapedAudit}' >> "${auditFile}"`,
      );
    } catch (error) {
      printWarning(`History sync (audit) failed for ${targetConnection.host}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Metrics
    try {
      const escapedMetrics = shellEscape(metricsEntry);
      await sshExec(
        targetConnection,
        `mkdir -p "${metricsDir}" && echo '${escapedMetrics}' >> "${metricsFile}"`,
      );
    } catch (error) {
      printWarning(`History sync (metrics) failed for ${targetConnection.host}: ${error instanceof Error ? error.message : String(error)}`);
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
