import { sshExec } from './ssh';
import { printDebug } from './output';
import type { SSHKeyConnection, SSHExecResult } from '../types';
import type { ShellCommand } from './ssh';

/**
 * Runs a read on each node in turn, for data replicated on all of them (history, metrics), and
 * returns the first result with a non-empty stdout, else the last result or error as exit code 1.
 */
export async function sshExecWithFallback(
  connections: SSHKeyConnection[],
  command: ShellCommand
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
