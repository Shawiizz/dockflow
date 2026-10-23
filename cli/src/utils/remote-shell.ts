/**
 * A shell on a server: what the file-based stores (lock, releases) run their commands through.
 * Tests replace it with a local `sh` over a temporary directory.
 */

import type { SSHExecResult, SSHKeyConnection } from '../types';
import { sshExec } from './ssh';
import type { ShellCommand } from './ssh';

export interface RemoteShell {
  /** runs `command`, `stdin` written to its standard input */
  run(command: ShellCommand, stdin?: string): Promise<SSHExecResult>;
}

export function sshShell(connection: SSHKeyConnection): RemoteShell {
  return {
    run: (command: ShellCommand, stdin?: string): Promise<SSHExecResult> => sshExec(connection, command, { stdin }),
  };
}
