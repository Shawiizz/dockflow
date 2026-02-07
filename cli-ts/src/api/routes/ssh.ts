/**
 * SSH WebSocket Route Handler
 *
 * Upgrades HTTP connections to WebSocket for interactive SSH sessions.
 * Uses the ssh2 library for direct SSH connections (no temp key files needed).
 */

import { Client as SSHClient, type ClientChannel } from 'ssh2';
import { loadServersConfig } from '../../utils/config';
import {
  resolveServersForEnvironment,
  getAvailableEnvironments,
  getServerPrivateKey,
} from '../../utils/servers';
import { normalizePrivateKey } from '../../utils/ssh-keys';
import { DEFAULT_SSH_PORT } from '../../constants';

/** Active SSH sessions keyed by a unique ID */
const activeSessions = new Map<string, { client: SSHClient; stream: ClientChannel | null }>();

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
 * Bun WebSocket handlers for SSH sessions.
 * Attach these to Bun.serve({ websocket: sshWebSocketHandlers })
 */
export const sshWebSocketHandlers = {
  open(ws: any) {
    const serverName = ws.data?.serverName;
    if (!serverName) {
      ws.send(JSON.stringify({ type: 'error', message: 'No server specified' }));
      ws.close();
      return;
    }

    const conn = resolveServerConnection(serverName);
    if (!conn) {
      ws.send(JSON.stringify({ type: 'error', message: `Cannot connect to "${serverName}": no credentials found` }));
      ws.close();
      return;
    }

    const sessionId = `${serverName}-${Date.now()}`;
    const client = new SSHClient();

    activeSessions.set(sessionId, { client, stream: null });
    ws.data.sessionId = sessionId;

    client.on('ready', () => {
      client.shell(
        { term: 'xterm-256color', rows: 24, cols: 80 },
        (shellErr, stream) => {
          if (shellErr) {
            ws.send(JSON.stringify({ type: 'error', message: `Shell error: ${shellErr.message}` }));
            client.end();
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
            activeSessions.delete(sessionId);
            try {
              ws.send(JSON.stringify({ type: 'exit', code: 0 }));
              ws.close();
            } catch {
              // WebSocket may already be closed
            }
            client.end();
          });
        },
      );
    });

    client.on('error', (err) => {
      activeSessions.delete(sessionId);
      try {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
      } catch {
        // Ignore
      }
    });

    client.on('close', () => {
      activeSessions.delete(sessionId);
      try {
        ws.send(JSON.stringify({ type: 'exit', code: 0 }));
        ws.close();
      } catch {
        // WebSocket may already be closed
      }
    });

    // Connect using ssh2 - private key is passed directly as a string
    client.connect({
      host: conn.host,
      port: conn.port,
      username: conn.user,
      privateKey: normalizePrivateKey(conn.privateKey),
      // Skip host key verification (same behavior as StrictHostKeyChecking=no)
      hostVerifier: () => true,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
    });
  },

  message(ws: any, message: string | Buffer) {
    const sessionId = ws.data?.sessionId;
    const session = sessionId ? activeSessions.get(sessionId) : null;
    if (!session?.stream) return;

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

  close(ws: any) {
    const sessionId = ws.data?.sessionId;
    const session = sessionId ? activeSessions.get(sessionId) : null;
    if (session) {
      session.stream?.close();
      session.client.end();
      activeSessions.delete(sessionId);
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
