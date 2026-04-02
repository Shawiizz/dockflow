/**
 * SSH utilities using the ssh2 library.
 * Supports key-based and password-based authentication.
 * No temporary key files needed — keys are passed directly in memory.
 *
 * Connection pooling: a module-level pool reuses SSH connections per host.
 * Multiple exec() calls multiplex over a single TCP connection via SSH channels.
 * Interactive sessions (sshShell, executeInteractiveSSH) bypass the pool.
 */

import { Client as SSHClient } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { ConnectionInfo, SSHExecResult } from '../types';
import { isKeyConnection } from '../types';
import { normalizePrivateKey } from './ssh-keys';
import { DEFAULT_SSH_PORT } from '../constants';
import { printDebug } from './output';

// ─── Pool types ───────────────────────────────────────────────

type PoolEntryState = 'connecting' | 'connected' | 'closed';

interface PoolEntry {
  client: SSHClient;
  state: PoolEntryState;
  /** Shared promise — all concurrent callers await the same handshake */
  readyPromise: Promise<SSHClient>;
  activeChannels: number;
}

// ─── Pool state (module-level singleton) ──────────────────────

const pool = new Map<string, PoolEntry>();
let exitHandlerRegistered = false;

function poolKey(conn: ConnectionInfo): string {
  return `${conn.host}:${conn.port || DEFAULT_SSH_PORT}:${conn.user}`;
}

function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanup = () => { closeAllConnections(); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('not connected') ||
    msg.includes('channel open failure') ||
    msg.includes('no response from server') ||
    msg.includes('socket closed') ||
    msg.includes('connection lost') ||
    msg.includes('keepalive timeout') ||
    msg.includes('timed out while waiting for handshake') ||
    msg.includes('read econnreset') ||
    msg.includes('econnreset')
  );
}

function evictClient(conn: ConnectionInfo, client: SSHClient): void {
  const key = poolKey(conn);
  const entry = pool.get(key);
  if (entry && entry.client === client) {
    entry.state = 'closed';
    pool.delete(key);
    try { client.end(); } catch { /* already dead */ }
  }
}

// ─── Pool client acquisition ──────────────────────────────────

function buildConnectConfig(conn: ConnectionInfo, keepalive: boolean): ConnectConfig {
  const config: ConnectConfig = {
    host: conn.host,
    port: conn.port || DEFAULT_SSH_PORT,
    username: conn.user,
    hostVerifier: () => true,
    readyTimeout: 10000,
  };

  if (keepalive) {
    config.keepaliveInterval = 15000;
    config.keepaliveCountMax = 3;
  }

  if (isKeyConnection(conn)) {
    config.privateKey = normalizePrivateKey(conn.privateKey);
  }

  if ('password' in conn && conn.password) {
    config.password = conn.password;
  }

  return config;
}

/**
 * Get or create a pooled SSH client for the given connection.
 * Concurrent callers for the same host share a single handshake.
 */
async function getPooledClient(conn: ConnectionInfo): Promise<SSHClient> {
  ensureExitHandler();

  const key = poolKey(conn);
  const existing = pool.get(key);

  // Reuse connected client
  if (existing && existing.state === 'connected') {
    return existing.client;
  }

  // Wait on in-progress connection
  if (existing && existing.state === 'connecting') {
    return existing.readyPromise;
  }

  // Dead entry — clean up
  if (existing) {
    pool.delete(key);
  }

  // Create new client and store BEFORE connecting (race avoidance)
  const client = new SSHClient();

  const readyPromise = new Promise<SSHClient>((resolve, reject) => {
    client.on('ready', () => {
      const entry = pool.get(key);
      if (entry && entry.client === client) {
        entry.state = 'connected';
      }
      resolve(client);
    });

    client.on('error', (err) => {
      const entry = pool.get(key);
      if (entry && entry.client === client) {
        pool.delete(key);
      }
      reject(err);
    });
  });

  // Handle unexpected close (server drops connection)
  client.on('close', () => {
    const entry = pool.get(key);
    if (entry && entry.client === client) {
      entry.state = 'closed';
    }
  });

  const entry: PoolEntry = {
    client,
    state: 'connecting',
    readyPromise,
    activeChannels: 0,
  };

  pool.set(key, entry);
  printDebug(`SSH pool: connecting to ${key}`);
  client.connect(buildConnectConfig(conn, true));

  return readyPromise;
}

/**
 * Create a dedicated (non-pooled) SSH client for interactive sessions.
 */
function connectDedicatedClient(conn: ConnectionInfo): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    client.on('ready', () => resolve(client));
    client.on('error', (err) => reject(err));
    client.connect(buildConnectConfig(conn, false));
  });
}

// ─── Low-level exec on a connected client ─────────────────────

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
      const chunks: Buffer[] = options?.collectBinary ? [] : [];

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

      stream.on('close', (code: number) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
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
): Promise<SSHExecResult> {
  return new Promise<SSHExecResult>((resolve, reject) => {
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
}

function execWithInputOnClient(
  client: SSHClient,
  command: string,
  input: Buffer,
): Promise<SSHExecResult> {
  return new Promise<SSHExecResult>((resolve, reject) => {
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

      // Write input data with backpressure handling
      const CHUNK = 64 * 1024;
      let offset = 0;
      const writeNext = () => {
        while (offset < input.length) {
          const end = Math.min(offset + CHUNK, input.length);
          const slice = input.subarray(offset, end);
          offset = end;
          if (offset >= input.length) {
            stream.end(slice);
            return;
          }
          if (!stream.write(slice)) {
            stream.once('drain', writeNext);
            return;
          }
        }
        stream.end();
      };
      writeNext();
    });
  });
}

// ─── Public API (signatures unchanged) ────────────────────────

/**
 * Execute a command via SSH (returns collected output).
 * Uses connection pooling — one TCP connection per unique host.
 */
export async function sshExec(
  conn: ConnectionInfo,
  command: string,
  options?: { collectBinary?: boolean },
): Promise<SSHExecResult> {
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
): Promise<SSHExecResult> {
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

/**
 * Execute a command via SSH, piping binary data to its stdin.
 * Uses connection pooling.
 */
export async function sshExecWithInput(
  conn: ConnectionInfo,
  command: string,
  input: Buffer,
): Promise<SSHExecResult> {
  const client = await getPooledClient(conn);

  try {
    return await execWithInputOnClient(client, command, input);
  } catch (err) {
    if (isTransportError(err)) {
      evictClient(conn, client);
      const fresh = await getPooledClient(conn);
      return await execWithInputOnClient(fresh, command, input);
    }
    throw err;
  }
}

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

// ─── Pool management ──────────────────────────────────────────

/**
 * Close all pooled SSH connections. Idempotent.
 * Called automatically by withErrorHandler after every CLI command.
 */
export function closeAllConnections(): void {
  for (const [, entry] of pool) {
    try {
      if (entry.state !== 'closed') {
        entry.client.end();
      }
    } catch {
      // Client may already be dead
    }
    entry.state = 'closed';
  }
  pool.clear();
}

/**
 * Reset pool state for testing.
 */
export function _resetPoolForTesting(): void {
  closeAllConnections();
  exitHandlerRegistered = false;
}

// ─── Utilities ────────────────────────────────────────────────

/**
 * Shell-escape a value for safe use inside single quotes in SSH commands
 */
export function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
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
