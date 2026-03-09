/**
 * SSH Fallback utility
 *
 * Tries to execute an SSH command on multiple nodes in order,
 * returning the result from the first node that succeeds.
 * Used for reading history/metrics that are replicated across all cluster nodes.
 */

import { sshExec } from './ssh';
import { printDebug } from './output';
import type { SSHKeyConnection, SSHExecResult } from '../types';

/**
 * Execute an SSH command with fallback across multiple nodes.
 * Tries each connection in order until one succeeds and returns non-empty stdout.
 *
 * @param connections - Ordered list of SSH connections to try (managers first, then workers)
 * @param command - The command to execute
 * @returns The first successful result, or the last failure
 */
export async function sshExecWithFallback(
  connections: SSHKeyConnection[],
  command: string
): Promise<SSHExecResult> {
  let lastResult: SSHExecResult = { stdout: '', stderr: '', exitCode: 1 };

  for (const conn of connections) {
    try {
      const result = await sshExec(conn, command);
      if (result.stdout.trim()) {
        return result;
      }
      lastResult = result;
    } catch (error) {
      printDebug(`Fallback: node ${conn.host} unreachable, trying next...`);
      lastResult = {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  return lastResult;
}
