/**
 * Audit Service
 *
 * Appends structured audit log entries on the remote manager.
 * Each stack has its own log file at /var/lib/dockflow/audit/{stack}.log.
 * Lines are pipe-delimited: timestamp | result | version | performer | message
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from '../utils/ssh';
import { DOCKFLOW_AUDIT_DIR } from '../constants';
import { getPerformer } from '../utils/config';

export class AuditService {
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
    await done;

    return line;
  }
}
