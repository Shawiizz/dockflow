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
  /** all concurrent callers await the same handshake */
  readyPromise: Promise<SSHClient>;
  /** Abandons the handshake and its retries (closeAllConnections), which would otherwise keep the process alive */
  abort: AbortController;
}

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

/** The pooled client for this host and pin; concurrent callers share one handshake, with its retries. */
export async function getPooledClient(conn: ConnectionInfo): Promise<SSHClient> {
  ensureExitHandler();

  const key = poolKey(conn);
  const existing = pool.get(key);

  if (existing && existing.state === 'connected') {
    return existing.client;
  }

  if (existing && existing.state === 'connecting') {
    return existing.readyPromise;
  }

  if (existing) {
    pool.delete(key);
  }

  const abort = new AbortController();
  const readyPromise = connectWithRetry(conn, true, abort.signal).then((client) => {
    // a closed connection leaves the pool
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

  // the entry exists before the client does, so concurrent callers find it and wait on
  // readyPromise; a placeholder client stands in until the real one replaces it
  const placeholderClient = new SSHClient();
  const entry: PoolEntry = {
    client: placeholderClient,
    state: 'connecting',
    readyPromise,
    abort,
  };
  pool.set(key, entry);

  printDebug(`SSH pool: connecting to ${key}`);

  readyPromise.then((client) => {
    const current = pool.get(key);
    if (current && current.client === placeholderClient) {
      current.client = client;
      current.state = 'connected';
    }
  }).catch(() => { /* the failure is thrown to the callers through readyPromise */ });

  return readyPromise;
}

/** Closes every pooled connection and abandons pending handshakes; safe to call twice. withErrorHandler calls it after each command. */
export function closeAllConnections(): void {
  for (const [, entry] of pool) {
    entry.abort.abort();
    try {
      if (entry.state !== 'closed') {
        entry.client.destroy();
      }
    } catch {
      // the client may already be dead
    }
    entry.state = 'closed';
  }
  pool.clear();
}
