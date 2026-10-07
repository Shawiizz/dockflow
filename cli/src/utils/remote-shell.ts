/**
 * A shell on a server: what the file-based stores (lock, releases) run their commands through.
 * Tests replace it with a local `sh` over a temporary directory.
 */

import type { SSHExecResult, SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from './ssh';

export interface RemoteShell {
  /** runs `command`, `stdin` written to its standard input */
  run(command: string, stdin?: string): Promise<SSHExecResult>;
}

export function sshShell(connection: SSHKeyConnection): RemoteShell {
  return {
    async run(command: string, stdin?: string): Promise<SSHExecResult> {
      if (stdin === undefined) return sshExec(connection, command);
      const { stream, done } = await sshExecChannel(connection, command);
      stream.end(stdin);
      return done;
    },
  };
}
