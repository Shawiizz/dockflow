/**
 * Running a command over a pooled connection and collecting its output (sshExec), or streaming it
 * to the console or to callbacks (sshExecStream); a dead pooled connection is replaced once.
 */

import type { Client as SSHClient } from 'ssh2';
import { StringDecoder } from 'string_decoder';
import type { ConnectionInfo, SSHExecResult } from '../../types';
import { channelResult } from './exit-status';
import { isTransportError } from './connect';
import { evictClient, getPooledClient } from './pool';
import { sshExecChannel } from './channels';

function execOnClient(
  client: SSHClient,
  command: string,
  options?: { collectBinary?: boolean },
): Promise<SSHExecResult> {
  return new Promise<SSHExecResult>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      const chunks: Buffer[] = [];

      stream.on('data', (data: Buffer) => {
        if (options?.collectBinary) {
          chunks.push(data);
        } else {
          stdout += data.toString();
        }
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on('close', (code?: number | null, signal?: string) => {
        resolve({
          ...channelResult(stdout, stderr, code, signal),
          binaryOutput: options?.collectBinary ? Buffer.concat(chunks) : undefined,
        });
      });
    });
  });
}

function execStreamOnClient(
  client: SSHClient,
  command: string,
  options: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  } = {},
): Promise<{ exitCode: number }> {
  return new Promise<{ exitCode: number }>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      // nothing is kept: a followed stream runs for hours. One decoder per stream, as a chunk can
      // end in the middle of a multi-byte character.
      const forward = (source: NodeJS.ReadableStream, sink: ((data: string) => void) | undefined, fallback: NodeJS.WriteStream) => {
        const decoder = new StringDecoder('utf8');
        const write = (text: string) => {
          if (!text) return;
          if (sink) sink(text);
          else fallback.write(text);
        };
        source.on('data', (data: Buffer) => write(decoder.write(data)));
        source.on('end', () => write(decoder.end()));
      };
      forward(stream, options.onStdout, process.stdout);
      forward(stream.stderr, options.onStderr, process.stderr);

      stream.on('close', (code?: number | null, signal?: string) => {
        resolve({ exitCode: channelResult('', '', code, signal).exitCode });
      });
    });
  });
}

/**
 * Execute a command via SSH (returns collected output).
 * Uses connection pooling — one TCP connection per unique host.
 */
/** Runs `command` and collects its output; `stdin`, when given, is written to its standard input. */
export async function sshExec(
  conn: ConnectionInfo,
  command: string,
  options?: { collectBinary?: boolean; stdin?: string | Buffer },
): Promise<SSHExecResult> {
  if (options?.stdin !== undefined) {
    const { stream, done } = await sshExecChannel(conn, command);
    stream.end(options.stdin);
    return done;
  }
  const client = await getPooledClient(conn);

  try {
    return await execOnClient(client, command, options);
  } catch (err) {
    if (isTransportError(err)) {
      evictClient(conn, client);
      const fresh = await getPooledClient(conn);
      return await execOnClient(fresh, command, options);
    }
    throw err;
  }
}

/**
 * Execute a command via SSH (streaming output to console).
 * Uses connection pooling.
 */
export async function sshExecStream(
  conn: ConnectionInfo,
  command: string,
  options: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  } = {}
): Promise<{ exitCode: number }> {
  const client = await getPooledClient(conn);

  try {
    return await execStreamOnClient(client, command, options);
  } catch (err) {
    if (isTransportError(err)) {
      evictClient(conn, client);
      const fresh = await getPooledClient(conn);
      return await execStreamOnClient(fresh, command, options);
    }
    throw err;
  }
}
