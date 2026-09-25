/**
 * Audit — appends structured audit log entries on the remote manager.
 *
 * Each stack has its own log file at /var/lib/dockflow/audit/{stack}.log.
 * Lines are pipe-delimited: timestamp | result | version | performer | message
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from '../utils/ssh';
import { DOCKFLOW_AUDIT_DIR } from '../constants';
import { getPerformer } from '../utils/config';
import type { ClusterNodeRef } from './orchestrator/interfaces';
import { printDebug } from '../utils/output';

export class Audit {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Append a single audit entry to the stack's audit log.
   *
   * Format: ISO8601 | result | version | performer | message
   *
   * This method is intentionally fire-and-forget from the caller's
   * perspective — wrap calls in try/catch and log warnings on failure.
   */
  async writeEntry(
    stackName: string,
    result: string,
    message: string,
    version: string,
  ): Promise<string> {
    const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
    const performer = getPerformer();
    const timestamp = new Date().toISOString();

    const line = `${timestamp} | ${result} | ${version} | ${performer} | ${message}`;

    await sshExec(this.connection, `mkdir -p "${DOCKFLOW_AUDIT_DIR}"`);
    const { stream, done } = await sshExecChannel(this.connection, `cat >> "${auditFile}"`);
    stream.end(line + '\n');
    const writeResult = await done;
    if (writeResult.exitCode !== 0) {
      // Throw so the caller's best-effort net surfaces a warning instead of
      // silently losing the audit entry.
      throw new Error(`Failed to write audit entry: ${writeResult.stderr.trim() || `exit ${writeResult.exitCode}`}`);
    }

    return line;
  }
}

export interface AuditFallbackResult {
  /** the raw tail of the log file, or null when every node's read failed or found nothing */
  raw: string | null;
  /** node the log was read from; null alongside a null raw */
  node: ClusterNodeRef | null;
}

/**
 * design-06 3.19 / R-S4-04: the same manager-then-worker fallback `metrics` uses (fetchMetricsWithFallback)
 * — a deploy can land its audit log on any manager under failover (D20), so `history`/`audit` must not
 * hide it behind whichever node happens to be first.
 */
export async function fetchAuditWithFallback(
  nodes: readonly ClusterNodeRef[],
  stackName: string,
  lines: number,
): Promise<AuditFallbackResult> {
  const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;

  for (const node of nodes) {
    try {
      const result = await sshExec(node.connection, `tail -n ${lines} "${auditFile}" 2>/dev/null`);
      if (result.stdout.trim()) return { raw: result.stdout, node };
    } catch (error) {
      printDebug(`Audit: node ${node.name} unreachable, trying next...`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { raw: null, node: null };
}
