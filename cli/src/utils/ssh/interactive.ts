/**
 * Interactive sessions on a dedicated connection that bypasses the pool: a login shell, a command
 * on a raw-mode PTY, and a command on a PTY with the local terminal left in cooked mode.
 */

import type { ConnectionInfo } from '../../types';
import { channelResult } from './exit-status';
import { connectDedicatedClient } from './connect';

/** A login shell with the local terminal in raw mode; resolves with exit code 0 when it closes. */
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

/** A command on a PTY with the local terminal in raw mode; resolves with the command's exit code. */
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
 * A command on a PTY, so the remote process sees a terminal (colours, prompts), while the local
 * terminal stays in cooked mode and keeps handling line editing and Ctrl+C.
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
