/**
 * Interactive sessions on a dedicated connection that bypasses the pool: a login shell, a command
 * on a raw-mode PTY, and a command on a PTY with the local terminal left in cooked mode.
 */

import type { ConnectionInfo } from '../../types';
import { channelResult } from './exit-status';
import { connectDedicatedClient } from './connect';

/**
 * Open an interactive SSH session (NOT pooled — dedicated connection).
 */
export async function sshShell(conn: ConnectionInfo): Promise<number> {
  const client = await connectDedicatedClient(conn);

  return new Promise((resolve, reject) => {
    const ptyOptions = {
      term: process.env.TERM || 'xterm-256color',
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    };

    client.shell(ptyOptions, (err, stream) => {
      if (err) {
        client.end();
        reject(err);
        return;
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.pipe(stream);
      stream.pipe(process.stdout);
      stream.stderr.pipe(process.stderr);

      const onResize = () => {
        stream.setWindow(
          process.stdout.rows || 24,
          process.stdout.columns || 80,
          0, 0,
        );
      };
      process.stdout.on('resize', onResize);

      stream.on('close', () => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.unpipe(stream);
        process.stdin.pause();
        process.stdout.removeListener('resize', onResize);
        client.end();
        resolve(0);
      });
    });
  });
}

/**
 * Execute an interactive command via SSH (NOT pooled — dedicated connection).
 */
export async function executeInteractiveSSH(
  conn: ConnectionInfo,
  command: string
): Promise<number> {
  const client = await connectDedicatedClient(conn);

  return new Promise((resolve, reject) => {
    const ptyOptions = {
      term: 'xterm-256color',
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    };

    client.exec(command, { pty: ptyOptions }, (err, stream) => {
      if (err) {
        client.end();
        reject(err);
        return;
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.pipe(stream);
      stream.pipe(process.stdout);
      stream.stderr.pipe(process.stderr);

      const onResize = () => {
        stream.setWindow(
          process.stdout.rows || 24,
          process.stdout.columns || 80,
          0, 0,
        );
      };
      process.stdout.on('resize', onResize);

      stream.on('close', (code?: number | null, signal?: string) => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.unpipe(stream);
        process.stdin.pause();
        process.stdout.removeListener('resize', onResize);
        client.end();
        resolve(channelResult('', '', code, signal).exitCode);
      });
    });
  });
}

/**
 * Execute a command via SSH with a PTY but without raw stdin mode.
 * The PTY ensures the remote process sees a terminal (colours, prompts),
 * while cooked-mode stdin lets the local terminal handle line editing,
 * Ctrl+C, etc. — which prevents issues with sub-processes like Ansible.
 *
 * NOT pooled — dedicated connection.
 */
export async function executePtySSH(
  conn: ConnectionInfo,
  command: string,
): Promise<number> {
  const client = await connectDedicatedClient(conn);

  return new Promise((resolve, reject) => {
    const ptyOptions = {
      term: process.env.TERM || 'xterm-256color',
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    };

    client.exec(command, { pty: ptyOptions }, (err, stream) => {
      if (err) {
        client.end();
        reject(err);
        return;
      }

      // Pipe stdin in normal (cooked) mode — no setRawMode
      process.stdin.resume();
      process.stdin.pipe(stream);
      stream.pipe(process.stdout);
      stream.stderr.pipe(process.stderr);

      const onResize = () => {
        stream.setWindow(
          process.stdout.rows || 24,
          process.stdout.columns || 80,
          0, 0,
        );
      };
      process.stdout.on('resize', onResize);

      stream.on('close', (code?: number | null, signal?: string) => {
        process.stdin.unpipe(stream);
        process.stdin.pause();
        process.stdout.removeListener('resize', onResize);
        client.end();
        resolve(channelResult('', '', code, signal).exitCode);
      });
    });
  });
}
