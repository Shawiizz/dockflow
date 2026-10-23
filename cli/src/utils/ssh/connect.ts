/**
 * Making one SSH connection: connect config and host key wiring, retries with exponential backoff
 * on transient errors, and the classification of connection errors (authentication, retryable,
 * transport). Nothing here keeps a connection: see pool.ts and interactive.ts.
 */

import { Client as SSHClient } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { ConnectionInfo } from '../../types';
import { isKeyConnection } from '../../types';
import { normalizePrivateKey } from '../ssh-keys';
import { DEFAULT_SSH_PORT, SSH_READY_TIMEOUT_MS, SSH_KEEPALIVE_INTERVAL_MS, SSH_KEEPALIVE_COUNT_MAX, SSH_CONNECT_RETRIES, SSH_CONNECT_RETRY_BASE_DELAY_MS } from '../../constants';
import { printDebug } from '../output';
import { ConnectionError, ErrorCode } from '../errors';
import { hostKeyCheck, type HostKeyCheck } from '../host-key';

const presentedHostKeys = new Map<string, string>();

export function serverKey(conn: ConnectionInfo): string {
  return `${conn.host}:${conn.port || DEFAULT_SSH_PORT}:${conn.user}`;
}

/** Fingerprint of the host key the server presented on the last connection made to it. */
export function presentedHostKey(conn: ConnectionInfo): string | undefined {
  return presentedHostKeys.get(serverKey(conn));
}

/** A wrong key, user or password, matched by ssh2's messages. */
function isAuthenticationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('all configured authentication methods failed') ||
    msg.includes('permission denied') ||
    msg.includes('authentication failed') ||
    msg.includes('no supported authentication methods')
  );
}

/** Transient network failures are worth another try; authentication failures and host key refusals are not. */
function isRetryableConnectionError(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof ConnectionError || isAuthenticationError(err)) return false;
  const msg = err.message.toLowerCase();
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

/** The pooled connection died under a command: the pool replaces it and the command runs again. */
export function isTransportError(err: unknown): boolean {
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

function buildConnectConfig(conn: ConnectionInfo, keepalive: boolean, hostKey: HostKeyCheck): ConnectConfig {
  const config: ConnectConfig = {
    host: conn.host,
    port: conn.port || DEFAULT_SSH_PORT,
    username: conn.user,
    hostVerifier: hostKey.verify,
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

/** One attempt: rejects with the host key failure when the pinned key was refused, else with ssh2's error. */
function attemptConnect(conn: ConnectionInfo, keepalive: boolean, signal?: AbortSignal): Promise<SSHClient> {
  return new Promise<SSHClient>((resolve, reject) => {
    const client = new SSHClient();
    const hostKey = hostKeyCheck(conn);
    const abandon = (): void => {
      client.destroy();
      reject(new Error(`SSH connection to ${conn.host} was abandoned: every connection is being closed`));
    };
    if (signal?.aborted) {
      abandon();
      return;
    }
    signal?.addEventListener('abort', abandon, { once: true });
    client.on('ready', () => {
      signal?.removeEventListener('abort', abandon);
      const presented = hostKey.presented();
      if (presented) presentedHostKeys.set(serverKey(conn), presented);
      resolve(client);
    });
    client.on('error', (err) => {
      signal?.removeEventListener('abort', abandon);
      try { client.end(); } catch { /* never connected */ }
      reject(hostKey.failure() ?? err);
    });
    client.connect(buildConnectConfig(conn, keepalive, hostKey));
  });
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Retries transient errors with exponential backoff; authentication failures are not retried, and nothing is once `signal` aborts. */
export async function connectWithRetry(
  conn: ConnectionInfo,
  keepalive: boolean,
  signal?: AbortSignal,
  retries = SSH_CONNECT_RETRIES,
  baseDelayMs = SSH_CONNECT_RETRY_BASE_DELAY_MS,
): Promise<SSHClient> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await attemptConnect(conn, keepalive, signal);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && !signal?.aborted && isRetryableConnectionError(err)) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        printDebug(
          `SSH connection to ${conn.host} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(delay, signal);
      } else {
        break;
      }
    }
  }
  throw connectionFailure(conn, lastErr);
}

/** A refused key or user is told apart from an unreachable host: only `dockflow setup` fixes it. */
export function connectionFailure(conn: ConnectionInfo, err: unknown): unknown {
  if (!isAuthenticationError(err)) return err;
  return new ConnectionError(
    `SSH authentication as ${conn.user} on ${conn.host} was refused: ${(err as Error).message}`,
    'The server no longer accepts this key or user. Re-run `dockflow setup` on the server, then update the connection string.',
    ErrorCode.SSH_AUTH_FAILED,
  );
}

/** A client of its own for an interactive session: not pooled, no keepalive; the caller closes it. */
export function connectDedicatedClient(conn: ConnectionInfo): Promise<SSHClient> {
  return connectWithRetry(conn, false);
}
