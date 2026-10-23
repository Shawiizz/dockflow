/**
 * Audit — appends audit log entries on the remote manager, one log file per stack.
 * Lines are pipe-delimited: timestamp | result | version | performer | message
 */

import type { SSHKeyConnection } from '../types';
import { sh, sshExec } from '../utils/ssh';
import { DOCKFLOW_AUDIT_DIR } from '../constants';
import { getPerformer } from '../utils/config';

export class Audit {
  constructor(private readonly connection: SSHKeyConnection) {}

  /** Appends one entry and returns the line written. Throws when the write fails: callers treat the audit as best-effort. */
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

    await sshExec(this.connection, sh`mkdir -p ${DOCKFLOW_AUDIT_DIR}`);
    const writeResult = await sshExec(this.connection, sh`cat >> ${auditFile}`, { stdin: `${line}\n` });
    if (writeResult.exitCode !== 0) {
      // Throw so the caller's best-effort net surfaces a warning instead of
      // silently losing the audit entry.
      throw new Error(`Failed to write audit entry: ${writeResult.stderr.trim() || `exit ${writeResult.exitCode}`}`);
    }

    return line;
  }
}
