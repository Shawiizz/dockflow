/**
 * The connection pool: a module-level singleton that reuses one SSH connection per host and pin,
 * so concurrent exec calls multiplex over a single TCP connection through SSH channels.
 */

import { Client as SSHClient } from 'ssh2';
import type { ConnectionInfo } from '../../types';
import { printDebug } from '../output';
import { installSignalHandlers } from '../interrupt';
import { connectWithRetry, serverKey } from './connect';

type PoolEntryState = 'connecting' | 'connected' | 'closed';

interface PoolEntry {
  client: SSHClient;
  state: PoolEntryState;
  /** Shared promise — all concurrent callers await the same handshake */
  readyPromise: Promise<SSHClient>;
  /** Abandons the handshake and its retries (closeAllConnections), which would otherwise keep the process alive */
  abort: AbortController;
}

// ─── Pool state (module-level singleton) ──────────────────────

const pool = new Map<string, PoolEntry>();
const presentedHostKeys = new Map<string, string>();
let exitHandlerRegistered = false;

function poolKey(conn: ConnectionInfo): string {
  // a connection checked against one pin is no answer for a caller holding another
  return `${serverKey(conn)}:${conn.hostKey ?? ''}`;
}

function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  process.on('exit', () => { closeAllConnections(); });
  // signals belong to utils/interrupt: a command cleaning up (deploy) must run before the exit
  installSignalHandlers();
}

export function evictClient(conn: ConnectionInfo, client: SSHClient): void {
  const key = poolKey(conn);
  const entry = pool.get(key);
  if (entry && entry.client === client) {
    entry.state = 'closed';
    pool.delete(key);
    try { client.end(); } catch { /* already dead */ }
  }
}

/**
 * Get or create a pooled SSH client for the given connection.
 * Concurrent callers for the same host share a single handshake.
 * Transient connection errors are retried with exponential backoff.
 */
export async function getPooledClient(conn: ConnectionInfo): Promise<SSHClient> {
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
  const abort = new AbortController();
  const readyPromise = connectWithRetry(conn, true, abort.signal).then((client) => {
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
    abort,
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
 * Close all pooled SSH connections. Idempotent.
 * Called automatically by withErrorHandler after every CLI command.
 */
export function closeAllConnections(): void {
  for (const [, entry] of pool) {
    entry.abort.abort();
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
