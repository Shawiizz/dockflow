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
import type { ClientChannel, ConnectConfig } from 'ssh2';
import type { ConnectionInfo, SSHExecResult } from '../types';
import { isKeyConnection } from '../types';
import { normalizePrivateKey } from './ssh-keys';
import { DEFAULT_SSH_PORT, SSH_READY_TIMEOUT_MS, SSH_KEEPALIVE_INTERVAL_MS, SSH_KEEPALIVE_COUNT_MAX, SSH_CONNECT_RETRIES, SSH_CONNECT_RETRY_BASE_DELAY_MS } from '../constants';
import { printDebug } from './output';

// ─── Pool types ───────────────────────────────────────────────

type PoolEntryState = 'connecting' | 'connected' | 'closed';

interface PoolEntry {
  client: SSHClient;
  state: PoolEntryState;
  /** Shared promise — all concurrent callers await the same handshake */
  readyPromise: Promise<SSHClient>;
}

// ─── Pool state (module-level singleton) ──────────────────────

const pool = new Map<string, PoolEntry>();
let exitHandlerRegistered = false;

// ─── Exit status ──────────────────────────────────────────────

/** Exit code reported for a remote command ended by a signal, as the OpenSSH client does. */
export const SSH_SIGNALLED_EXIT_CODE = 255;

/**
 * The channel closed before the server sent an exit status: the connection dropped or the
 * channel was closed mid-command, so any output received is incomplete.
 */
export class SSHExitStatusError extends Error {
  constructor() {
    super('SSH channel closed without an exit status (connection lost or channel closed mid-command)');
    this.name = 'SSHExitStatusError';
  }
}

/** ssh2 hands over the status, null when a signal ended the command, undefined when none arrived. */
function strictExitCode(code: number | null | undefined): number | undefined {
  if (typeof code === 'number') return code;
  return code === null ? SSH_SIGNALLED_EXIT_CODE : undefined;
}

export interface SSHExecOptions {
  /** Collect stdout as raw bytes in `binaryOutput` instead of text. */
  collectBinary?: boolean;
  /**
   * Reject with SSHExitStatusError when no exit status arrives, and report a signal as
   * SSH_SIGNALLED_EXIT_CODE. Off by default, where both read as exit code 0.
   */
  requireExitStatus?: boolean;
}

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

/**
 * Returns true for errors that are worth retrying (transient network issues).
 * Auth failures (wrong key/password) are NOT retryable.
 */
function isRetryableConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Auth errors — don't retry, would just fail again
  if (
    msg.includes('all configured authentication methods failed') ||
    msg.includes('permission denied') ||
    msg.includes('authentication failed') ||
    msg.includes('no supported authentication methods')
  ) return false;
  // Transient errors — worth retrying
  return (
    msg.includes('timed out while waiting for handshake') ||
    msg.includes('connection refused') ||
    msg.includes('connect econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enetunreach') ||
    msg.includes('socket hang up') ||
    msg.includes('getaddrinfo')
  );
}

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // The command may have run: only a command that never started is sent again
  if (err instanceof SSHExitStatusError) return false;
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
    // Every caller keeps today's accept-anything behaviour byte for byte; only the setup
    // transport passes its own verifier (design-05 3.5, K60).
    hostVerifier: conn.hostVerifier ?? (() => true),
    readyTimeout: SSH_READY_TIMEOUT_MS,
  };

  if (keepalive) {
    config.keepaliveInterval = SSH_KEEPALIVE_INTERVAL_MS;
    config.keepaliveCountMax = SSH_KEEPALIVE_COUNT_MAX;
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
 * Attempt a single SSH connection. Returns a connected client or throws.
 */
function attemptConnect(conn: ConnectionInfo, keepalive: boolean): Promise<SSHClient> {
  return new Promise<SSHClient>((resolve, reject) => {
    const client = new SSHClient();
    client.on('ready', () => resolve(client));
    client.on('error', (err) => {
      try { client.end(); } catch { /* ignore */ }
      reject(err);
    });
    client.connect(buildConnectConfig(conn, keepalive));
  });
}

/**
 * Connect to an SSH host with exponential backoff retry on transient errors.
 * Auth failures are NOT retried.
 */
async function connectWithRetry(
  conn: ConnectionInfo,
  keepalive: boolean,
  retries = SSH_CONNECT_RETRIES,
  baseDelayMs = SSH_CONNECT_RETRY_BASE_DELAY_MS,
): Promise<SSHClient> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await attemptConnect(conn, keepalive);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryableConnectionError(err)) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        printDebug(
          `SSH connection to ${conn.host} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await Bun.sleep(delay);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

/**
 * Get or create a pooled SSH client for the given connection.
 * Concurrent callers for the same host share a single handshake.
 * Transient connection errors are retried with exponential backoff.
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

  // Build the ready promise using retry-aware connect
  const readyPromise = connectWithRetry(conn, true).then((client) => {
    // Register close handler so stale entries are evicted
    client.on('close', () => {
      const entry = pool.get(key);
      if (entry && entry.client === client) {
        pool.delete(key);
      }
    });

    const entry = pool.get(key);
    if (entry && entry.client === client) {
      entry.state = 'connected';
    }
    return client;
  }).catch((err) => {
    pool.delete(key);
    throw err;
  });

  // Placeholder — we don't have the client yet, use a sentinel so concurrent
  // callers await the same handshake. We'll update state to 'connected' once done.
  // We use a temporary SSHClient as placeholder; the real one comes from the promise.
  const placeholderClient = new SSHClient();
  const entry: PoolEntry = {
    client: placeholderClient,
    state: 'connecting',
    readyPromise,
  };
  pool.set(key, entry);

  printDebug(`SSH pool: connecting to ${key}`);

  // Once connected, update the pool entry with the real client
  readyPromise.then((client) => {
    const current = pool.get(key);
    if (current && current.client === placeholderClient) {
      current.client = client;
      current.state = 'connected';
    }
  }).catch(() => { /* already handled above */ });

  return readyPromise;
}

/**
 * Create a dedicated (non-pooled) SSH client for interactive sessions.
 * Uses retry with exponential backoff for transient errors.
 */
function connectDedicatedClient(conn: ConnectionInfo): Promise<SSHClient> {
  return connectWithRetry(conn, false);
}

// ─── Low-level exec on a connected client ─────────────────────

function execOnClient(
  client: SSHClient,
  command: string,
  options?: SSHExecOptions,
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

      stream.on('close', (code: number | null | undefined) => {
        let exitCode = code ?? 0;
        if (options?.requireExitStatus) {
          const status = strictExitCode(code);
          if (status === undefined) {
            reject(new SSHExitStatusError());
            return;
          }
          exitCode = status;
        }
        resolve({
          stdout,
          stderr,
          exitCode,
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

// ─── Public API (signatures unchanged) ────────────────────────

/**
 * Execute a command via SSH (returns collected output).
 * Uses connection pooling — one TCP connection per unique host.
 */
export async function sshExec(
  conn: ConnectionInfo,
  command: string,
  options?: SSHExecOptions,
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

      stream.on('close', (code: number) => {
        process.stdin.unpipe(stream);
        process.stdin.pause();
        process.stdout.removeListener('resize', onResize);
        client.end();
        resolve(code ?? 0);
      });
    });
  });
}

// ─── Raw channel access (for streaming) ──────────────────────

export interface SSHChannelHandle {
  /** The raw SSH channel — writable stdin, readable stdout */
  stream: ClientChannel;
  /** Resolves when the channel closes. stdout and stderr are collected. */
  done: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Open an SSH exec channel and return the raw stream for direct piping.
 * Uses connection pooling. Caller owns the stream lifecycle.
 * stdout and stderr are also collected for `done`; long streams use sshExecChannelUnbuffered.
 */
export async function sshExecChannel(
  conn: ConnectionInfo,
  command: string,
): Promise<SSHChannelHandle> {
  const client = await getPooledClient(conn);
  return openChannelOnClient(client, command);
}

export interface SSHDedicatedChannelHandle extends SSHChannelHandle {
  /** Closes the dedicated client this channel was opened on; the caller owns its lifecycle. */
  close(): void;
}

/**
 * sshExecChannel over a dedicated (non-pooled) client (design-05 3.5): the setup transport uses
 * this and nothing else, so a bootstrap or deploy-key connection with its own `hostVerifier` is
 * never reused unverified through the `host:port:user` pool key.
 */
export async function sshExecChannelDedicated(
  conn: ConnectionInfo,
  command: string,
): Promise<SSHDedicatedChannelHandle> {
  const client = await connectDedicatedClient(conn);
  const handle = await openChannelOnClient(client, command);
  return {
    ...handle,
    close: () => {
      try {
        client.end();
      } catch {
        /* already dead */
      }
    },
  };
}

function openChannelOnClient(
  client: SSHClient,
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
          // Bun's ssh2 streams may not emit 'close' after stream.end(),
          // but 'exit' always fires. Use whichever comes first.
          let resolved = false;
          const finish = (code: number) => {
            if (resolved) return;
            resolved = true;
            resolveDone({ exitCode: code ?? 0, stdout, stderr });
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
  /** Writable stdin and readable stdout, stderr on `stream.stderr`; the caller must consume both. */
  stream: ClientChannel;
  /**
   * Settles on the exit status, possibly before stdout has been read to the end. A signal reads
   * as SSH_SIGNALLED_EXIT_CODE; a channel closed without a status rejects with SSHExitStatusError.
   */
  done: Promise<{ exitCode: number }>;
}

/**
 * sshExecChannel for long streams (image import, backup relay, `logs -f`): no output is kept in
 * memory, and a missing exit status is an error instead of exit code 0.
 * Uses connection pooling; never retried.
 */
export async function sshExecChannelUnbuffered(
  conn: ConnectionInfo,
  command: string,
): Promise<SSHUnbufferedChannelHandle> {
  const client = await getPooledClient(conn);
  return openUnbufferedChannelOnClient(client, command);
}

function openUnbufferedChannelOnClient(
  client: SSHClient,
  command: string,
): Promise<SSHUnbufferedChannelHandle> {
  return new Promise<SSHUnbufferedChannelHandle>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      const done = new Promise<{ exitCode: number }>((resolveDone, rejectDone) => {
        // Same 'exit' or 'close' race as openChannelOnClient; 'close' first means no status came
        let settled = false;
        const settle = (code: number | null | undefined) => {
          if (settled) return;
          settled = true;
          const exitCode = strictExitCode(code);
          if (exitCode === undefined) rejectDone(new SSHExitStatusError());
          else resolveDone({ exitCode });
        };
        stream.on('exit', settle);
        stream.on('close', settle);
      });
      // A caller that abandons the channel must not turn a lost connection into an unhandled rejection
      done.catch(() => {});

      resolve({ stream, done });
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
        entry.client.destroy();
      }
    } catch {
      // Client may already be dead
    }
    entry.state = 'closed';
  }
  pool.clear();
}

// ─── Utilities ────────────────────────────────────────────────

/**
 * Make a value safe to sit *inside* single quotes the caller writes.
 *
 * It adds no quotes of its own — the apostrophe is the only character that can
 * break out of single quoting, so that is all it handles. Reach for shellQuote
 * unless you are quoting only part of a token, such as a path that must keep a
 * live glob next to it.
 *
 * POSIX shells cannot escape an apostrophe inside single quotes, hence the
 * close-escape-reopen dance: `it's` becomes `it'\''s`.
 */
export function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * A value as one complete, quoted shell token — spaces and operators inert.
 *
 * This is the default choice for interpolating a value into a command string.
 */
export function shellQuote(value: string): string {
  return `'${escapeSingleQuotes(value)}'`;
}
