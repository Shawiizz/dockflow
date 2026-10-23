/**
 * Raw exec channels on a pooled connection, for callers that pipe data through the remote command:
 * one collecting stdout and stderr, one leaving the output to the caller.
 */

import type { Client as SSHClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import type { ConnectionInfo } from '../../types';
import { channelResult } from './exit-status';
import { getPooledClient } from './pool';

export interface SSHChannelHandle {
  /** writable stdin, readable stdout */
  stream: ClientChannel;
  /** resolves when the channel closes, with the collected stdout and stderr */
  done: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Opens an exec channel on the pooled connection for piping data into the command; the caller owns the stream. */
export async function sshExecChannel(
  conn: ConnectionInfo,
  command: string,
): Promise<SSHChannelHandle> {
  const client = await getPooledClient(conn);
  return openChannelOnClient(client, command);
}

export function openChannelOnClient(
  client: Pick<SSHClient, 'exec'>,
  command: string,
): Promise<SSHChannelHandle> {
  return new Promise<SSHChannelHandle>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const done = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolveDone) => {
          // under Bun, ssh2 streams may not emit 'close' after stream.end() but always emit
          // 'exit': take whichever comes first, once the output already received is delivered
          let resolved = false;
          const finish = (code?: number | null, signal?: string) => {
            if (resolved) return;
            resolved = true;
            setImmediate(() => resolveDone(channelResult(stdout, stderr, code, signal)));
          };
          stream.on('exit', finish);
          stream.on('close', finish);
        },
      );

      resolve({ stream, done });
    });
  });
}

export interface SSHUnbufferedChannelHandle {
  /** Writable stdin, readable stdout and `stream.stderr`: the caller must consume both. */
  stream: ClientChannel;
  /** Settles on the exit status, possibly before stdout has been read to the end. */
  done: Promise<{ exitCode: number }>;
}

/** `sshExecChannel` without collecting the output, for streams too long to hold in memory. */
export async function sshExecChannelUnbuffered(
  conn: ConnectionInfo,
  command: string,
): Promise<SSHUnbufferedChannelHandle> {
  return openUnbufferedChannelOnClient(await getPooledClient(conn), command);
}

export function openUnbufferedChannelOnClient(
  client: Pick<SSHClient, 'exec'>,
  command: string,
): Promise<SSHUnbufferedChannelHandle> {
  return new Promise<SSHUnbufferedChannelHandle>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const done = new Promise<{ exitCode: number }>((resolveDone) => {
        let resolved = false;
        const finish = (code?: number | null, signal?: string) => {
          if (resolved) return;
          resolved = true;
          resolveDone({ exitCode: channelResult('', '', code, signal).exitCode });
        };
        stream.on('exit', finish);
        stream.on('close', finish);
      });
      resolve({ stream, done });
    });
  });
}
