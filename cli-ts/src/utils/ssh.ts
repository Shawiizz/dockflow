/**
 * SSH utilities using the ssh2 library.
 * Supports key-based and password-based authentication.
 * No temporary key files needed — keys are passed directly in memory.
 */

import { Client as SSHClient } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { ConnectionInfo, SSHExecResult } from '../types';
import { isKeyConnection } from '../types';
import { normalizePrivateKey } from './ssh-keys';
import { DEFAULT_SSH_PORT } from '../constants';

/**
 * Create and connect an ssh2 client
 */
function connectClient(conn: ConnectionInfo): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();

    client.on('ready', () => resolve(client));
    client.on('error', (err) => reject(err));

    const config: ConnectConfig = {
      host: conn.host,
      port: conn.port || DEFAULT_SSH_PORT,
      username: conn.user,
      hostVerifier: () => true,
      readyTimeout: 10000,
    };

    if (isKeyConnection(conn)) {
      config.privateKey = normalizePrivateKey(conn.privateKey);
    }

    if ('password' in conn && conn.password) {
      config.password = conn.password;
    }

    client.connect(config);
  });
}

/**
 * Execute a command via SSH (returns collected output)
 */
export async function sshExec(
  conn: ConnectionInfo,
  command: string
): Promise<SSHExecResult> {
  const client = await connectClient(conn);

  try {
    return await new Promise<SSHExecResult>((resolve, reject) => {
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

        stream.on('close', (code: number) => {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          });
        });
      });
    });
  } finally {
    client.end();
  }
}

/**
 * Execute a command via SSH (streaming output to console)
 */
export async function sshExecStream(
  conn: ConnectionInfo,
  command: string,
  options: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  } = {}
): Promise<SSHExecResult> {
  const client = await connectClient(conn);

  try {
    return await new Promise<SSHExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          const str = data.toString();
          stdout += str;
          if (options.onStdout) {
            options.onStdout(str);
          } else {
            process.stdout.write(str);
          }
        });

        stream.stderr.on('data', (data: Buffer) => {
          const str = data.toString();
          stderr += str;
          if (options.onStderr) {
            options.onStderr(str);
          } else {
            process.stderr.write(str);
          }
        });

        stream.on('close', (code: number) => {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          });
        });
      });
    });
  } finally {
    client.end();
  }
}

/**
 * Open an interactive SSH session
 */
export async function sshShell(conn: ConnectionInfo): Promise<number> {
  const client = await connectClient(conn);

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

      // Enable raw mode so keystrokes are sent immediately
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.pipe(stream);
      stream.pipe(process.stdout);
      stream.stderr.pipe(process.stderr);

      // Handle terminal resize
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
 * Execute an interactive command via SSH (e.g., docker exec -it)
 */
export async function executeInteractiveSSH(
  conn: ConnectionInfo,
  command: string
): Promise<number> {
  const client = await connectClient(conn);

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

      // Enable raw mode so keystrokes are sent immediately
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.pipe(stream);
      stream.pipe(process.stdout);
      stream.stderr.pipe(process.stderr);

      // Handle terminal resize
      const onResize = () => {
        stream.setWindow(
          process.stdout.rows || 24,
          process.stdout.columns || 80,
          0, 0,
        );
      };
      process.stdout.on('resize', onResize);

      stream.on('close', (code: number) => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.unpipe(stream);
        process.stdin.pause();
        process.stdout.removeListener('resize', onResize);
        client.end();
        resolve(code ?? 0);
      });
    });
  });
}

/**
 * Test SSH connection
 */
export async function testConnection(conn: ConnectionInfo): Promise<boolean> {
  try {
    const result = await sshExecStream(conn, 'echo ok', {
      onStdout: () => {},
      onStderr: () => {},
    });
    return result.exitCode === 0 && result.stdout.trim() === 'ok';
  } catch {
    return false;
  }
}
