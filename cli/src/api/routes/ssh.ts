/**
 * SSH WebSocket Route Handler (design-06 8.2)
 *
 * Upgrades HTTP connections to WebSocket for interactive SSH sessions.
 * Uses the ssh2 library for direct SSH connections (no temp key files needed).
 *
 * Supports two modes:
 * 1. Shell mode (/ws/ssh/:serverName) - Interactive SSH shell to a specific server (unchanged)
 * 2. Exec mode (/ws/exec/:serviceName?env=) - PTY session in a service instance, through
 *    `ContainerBackend.interactiveCommand` (`docker exec -it` on Swarm, `kubectl exec -it` on k3s)
 */

import type { ServerWebSocket } from 'bun';
import { Client as SSHClient, type ClientChannel } from 'ssh2';
import { loadServersConfig } from '../../utils/config';
import { resolveServersForEnvironment, getAvailableEnvironments, getServerPrivateKey } from '../../utils/servers';
import { normalizePrivateKey } from '../../utils/ssh-keys';
import { openOrchestrator } from '../../services/orchestrator/factory';
import { DEFAULT_SSH_PORT, SSH_READY_TIMEOUT_MS, SSH_KEEPALIVE_INTERVAL_MS } from '../../constants';
import { isValidDockerName, resolveApiService, type ApiContext } from './_helpers';
import type { SSHKeyConnection } from '../../types';

/** Data attached to each WebSocket during upgrade */
export interface WSData {
  sessionId?: string;
  serverName?: string;
  serviceName?: string;
  env?: string;
  mode?: string;
}

/** Active SSH session state */
interface SSHSession {
  client: SSHClient;
  stream: ClientChannel | null;
  lastActivity: number;
}

/** Active SSH sessions keyed by a unique ID */
const activeSessions = new Map<string, SSHSession>();

/** Heartbeat interval (30s) */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Idle timeout (15 minutes) */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Watchdog scan interval (60s) */
const WATCHDOG_INTERVAL_MS = 60_000;

/** Track WebSocket references for heartbeat */
const activeWebSockets = new Map<string, ServerWebSocket<WSData>>();

/** Watchdog interval handle */
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the watchdog and heartbeat timers.
 * Called lazily on first connection.
 */
function ensureTimersStarted(): void {
  if (heartbeatInterval) return;

  // Heartbeat: ping all active WebSockets every 30s
  heartbeatInterval = setInterval(() => {
    for (const [sessionId, ws] of activeWebSockets) {
      try {
        ws.ping();
      } catch {
        // WebSocket already dead — will be cleaned up by watchdog
        cleanupSession(sessionId);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Watchdog: scan for idle/stale sessions every 60s
  watchdogInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        cleanupSession(sessionId);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

/**
 * Clean up a session by ID: close stream, end SSH client, remove from maps
 */
function cleanupSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.stream?.close();
    session.client.end();
    activeSessions.delete(sessionId);
  }

  const ws = activeWebSockets.get(sessionId);
  if (ws) {
    try {
      ws.close();
    } catch {
      // Already closed
    }
    activeWebSockets.delete(sessionId);
  }

  // Stop timers when no sessions remain
  if (activeSessions.size === 0) {
    stopTimers();
  }
}

/**
 * Stop the watchdog and heartbeat timers
 */
export function stopTimers(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

/**
 * Resolve connection info for a server by name
 */
function resolveServerConnection(serverName: string) {
  const serversConfig = loadServersConfig();
  if (!serversConfig) return null;

  const environments = getAvailableEnvironments();

  for (const env of environments) {
    const servers = resolveServersForEnvironment(env);
    const found = servers.find(s => s.name === serverName);
    if (!found) continue;

    const privateKey = getServerPrivateKey(env, serverName);
    if (!privateKey) continue;

    return {
      host: found.host,
      port: found.port || DEFAULT_SSH_PORT,
      user: found.user,
      privateKey,
    };
  }
  return null;
}

/**
 * Resolve the service (app role first, then accessory) and open a PTY session on a dedicated SSH
 * connection through `ContainerBackend.interactiveCommand` — one `openOrchestrator` per session,
 * like every other failover-at-start command (design-06 6). Session bookkeeping (the map entry,
 * resize, the heartbeat/watchdog) is unchanged; only how the remote command is found changes.
 */
async function connectExecSession(
  ws: ServerWebSocket<WSData>,
  sessionId: string,
  client: SSHClient,
  env: string,
  serviceName: string,
): Promise<void> {
  let target: { connection: SSHKeyConnection; command: string };
  try {
    const { config, orchestrator } = await openOrchestrator(env, {});
    const ctx: ApiContext = {
      env,
      config,
      orchestrator,
      stackName: orchestrator.target.stackName,
      appRef: { project: orchestrator.target.project, env, role: 'app' },
      accessoryRef: { project: orchestrator.target.project, env, role: 'accessory' },
    };
    const { ref, service } = await resolveApiService(ctx, serviceName, ['app', 'accessory']);
    target = await orchestrator.containers.interactiveCommand(ref, { service: service.name }, '/bin/sh');
  } catch (error) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
    } catch {
      // WebSocket may already be closed
    }
    cleanupSession(sessionId);
    return;
  }

  client.on('ready', () => {
    client.exec(target.command, { pty: { term: 'xterm-256color', rows: 24, cols: 80 } }, (execErr, execStream) => {
      if (execErr) {
        ws.send(JSON.stringify({ type: 'error', message: `Exec error: ${execErr.message}` }));
        client.end();
        return;
      }

      const session = activeSessions.get(sessionId);
      if (session) session.stream = execStream;

      ws.send(JSON.stringify({ type: 'connected', service: serviceName }));

      execStream.on('data', (data: Buffer) => {
        try {
          ws.send(data);
        } catch {
          // WebSocket may be closed
        }
      });

      execStream.stderr?.on('data', (data: Buffer) => {
        try {
          ws.send(data);
        } catch {
          // WebSocket may be closed
        }
      });

      execStream.on('close', () => {
        try {
          ws.send(JSON.stringify({ type: 'exit', code: 0 }));
        } catch {
          // WebSocket may already be closed
        }
        cleanupSession(sessionId);
      });
    });
  });

  client.on('error', (err) => {
    try {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    } catch {
      // Ignore
    }
    cleanupSession(sessionId);
  });

  client.on('close', () => {
    try {
      ws.send(JSON.stringify({ type: 'exit', code: 0 }));
    } catch {
      // WebSocket may already be closed
    }
    cleanupSession(sessionId);
  });

  client.connect({
    host: target.connection.host,
    port: target.connection.port,
    username: target.connection.user,
    privateKey: normalizePrivateKey(target.connection.privateKey),
    hostVerifier: () => true,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
  });
}

/**
 * Bun WebSocket handlers for SSH sessions.
 * Attach these to Bun.serve({ websocket: sshWebSocketHandlers })
 */
export const sshWebSocketHandlers = {
  open(ws: ServerWebSocket<WSData>) {
    ensureTimersStarted();

    // ── Exec mode: PTY session in a service instance (design-06 8.2) ──
    if (ws.data?.mode === 'exec') {
      const serviceName = ws.data.serviceName;
      const env = ws.data.env;

      if (!serviceName || !isValidDockerName(serviceName)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid service name' }));
        ws.close();
        return;
      }

      if (!env) {
        ws.send(JSON.stringify({ type: 'error', message: 'No environment specified' }));
        ws.close();
        return;
      }

      const sessionId = `exec-${serviceName}-${Date.now()}`;
      const client = new SSHClient();

      activeSessions.set(sessionId, { client, stream: null, lastActivity: Date.now() });
      ws.data.sessionId = sessionId;
      activeWebSockets.set(sessionId, ws);

      void connectExecSession(ws, sessionId, client, env, serviceName);
      return;
    }

    // ── Shell mode: interactive SSH shell to a server ──
    const serverName = ws.data?.serverName;
    if (!serverName || !isValidDockerName(serverName)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid server name' }));
      ws.close();
      return;
    }

    const connShell = resolveServerConnection(serverName);
    if (!connShell) {
      ws.send(JSON.stringify({ type: 'error', message: `Cannot connect to "${serverName}": no credentials found` }));
      ws.close();
      return;
    }

    const sessionId = `${serverName}-${Date.now()}`;
    const client2 = new SSHClient();

    activeSessions.set(sessionId, { client: client2, stream: null, lastActivity: Date.now() });
    ws.data.sessionId = sessionId;
    activeWebSockets.set(sessionId, ws);

    client2.on('ready', () => {
      client2.shell(
        { term: 'xterm-256color', rows: 24, cols: 80 },
        (shellErr, stream) => {
          if (shellErr) {
            ws.send(JSON.stringify({ type: 'error', message: `Shell error: ${shellErr.message}` }));
            client2.end();
            return;
          }

          // Store stream reference for resize
          const session = activeSessions.get(sessionId);
          if (session) {
            session.stream = stream;
          }

          ws.send(JSON.stringify({ type: 'connected', server: serverName }));

          stream.on('data', (data: Buffer) => {
            try {
              ws.send(data);
            } catch {
              // WebSocket may be closed
            }
          });

          stream.stderr?.on('data', (data: Buffer) => {
            try {
              ws.send(data);
            } catch {
              // WebSocket may be closed
            }
          });

          stream.on('close', () => {
            try {
              ws.send(JSON.stringify({ type: 'exit', code: 0 }));
            } catch {
              // WebSocket may already be closed
            }
            cleanupSession(sessionId);
          });
        },
      );
    });

    client2.on('error', (err) => {
      try {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      } catch {
        // Ignore
      }
      cleanupSession(sessionId);
    });

    client2.on('close', () => {
      try {
        ws.send(JSON.stringify({ type: 'exit', code: 0 }));
      } catch {
        // WebSocket may already be closed
      }
      cleanupSession(sessionId);
    });

    // Connect using ssh2 - private key is passed directly as a string
    client2.connect({
      host: connShell.host,
      port: connShell.port,
      username: connShell.user,
      privateKey: normalizePrivateKey(connShell.privateKey),
      hostVerifier: () => true,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
    });
  },

  message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
    const sessionId = ws.data?.sessionId;
    const session = sessionId ? activeSessions.get(sessionId) : null;
    if (!session?.stream) return;

    // Update activity timestamp
    session.lastActivity = Date.now();

    if (typeof message === 'string') {
      // Check for resize commands
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          session.stream.setWindow(parsed.rows, parsed.cols, parsed.rows * 20, parsed.cols * 9);
          return;
        }
      } catch {
        // Not JSON, treat as terminal input
      }
      session.stream.write(message);
    } else {
      session.stream.write(message);
    }
  },

  close(ws: ServerWebSocket<WSData>) {
    const sessionId = ws.data?.sessionId;
    if (sessionId) {
      cleanupSession(sessionId);
    }
  },
};

/**
 * Parse server name from WebSocket URL path
 * Expected: /ws/ssh/:serverName
 */
export function parseSSHServerName(pathname: string): string | null {
  const match = pathname.match(/^\/ws\/ssh\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Parse service name from exec WebSocket URL path
 * Expected: /ws/exec/:serviceName
 */
export function parseExecServiceName(pathname: string): { serviceName: string } | null {
  const match = pathname.match(/^\/ws\/exec\/([^/?]+)/);
  return match ? { serviceName: decodeURIComponent(match[1]) } : null;
}
