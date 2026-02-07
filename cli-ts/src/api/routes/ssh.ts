/**
 * SSH WebSocket Route Handler
 *
 * Upgrades HTTP connections to WebSocket for interactive SSH sessions.
 * Uses the ssh2 library for direct SSH connections (no temp key files needed).
 *
 * Supports two modes:
 * 1. Shell mode (/ws/ssh/:serverName) - Interactive SSH shell to a specific server
 * 2. Exec mode (/ws/exec/:serviceName?env=) - Docker exec into a running container
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
import { getManagerConnection } from './_helpers';

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
    // ── Exec mode: docker exec into a container ──
    if (ws.data?.mode === 'exec') {
      const serviceName = ws.data.serviceName;
      const env = ws.data.env;

      const conn = getManagerConnection(env);
      if (!conn) {
        ws.send(JSON.stringify({ type: 'error', message: `Cannot connect to manager for env "${env}": no credentials found` }));
        ws.close();
        return;
      }

      const sessionId = `exec-${serviceName}-${Date.now()}`;
      const client = new SSHClient();

      activeSessions.set(sessionId, { client, stream: null });
      ws.data.sessionId = sessionId;

      client.on('ready', () => {
        // First find the container for the service
        client.exec(
          `docker ps --filter "label=com.docker.swarm.service.name=${serviceName}" --format '{{.ID}}' | head -n1`,
          (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', message: `Failed to find container: ${err.message}` }));
              client.end();
              return;
            }

            let containerId = '';
            stream.on('data', (data: Buffer) => {
              containerId += data.toString();
            });

            stream.on('close', () => {
              containerId = containerId.trim();
              if (!containerId) {
                ws.send(JSON.stringify({ type: 'error', message: `No container found for service ${serviceName}` }));
                activeSessions.delete(sessionId);
                client.end();
                return;
              }

              // Now exec into the container with PTY
              client.exec(
                `docker exec -it ${containerId} /bin/sh`,
                { pty: { term: 'xterm-256color', rows: 24, cols: 80 } },
                (execErr, execStream) => {
                  if (execErr) {
                    ws.send(JSON.stringify({ type: 'error', message: `Exec error: ${execErr.message}` }));
                    client.end();
                    return;
                  }

                  // Store stream reference for resize
                  const session = activeSessions.get(sessionId);
                  if (session) {
                    session.stream = execStream;
                  }

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

      // Connect using ssh2 with manager credentials
      client.connect({
        host: conn.host,
        port: conn.port,
        username: conn.user,
        privateKey: normalizePrivateKey(conn.privateKey),
        hostVerifier: () => true,
        readyTimeout: 10000,
        keepaliveInterval: 15000,
      });

      return;
    }

    // ── Shell mode: interactive SSH shell to a server ──
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

/**
 * Parse service name from exec WebSocket URL path
 * Expected: /ws/exec/:serviceName
 */
export function parseExecServiceName(pathname: string): { serviceName: string } | null {
  const match = pathname.match(/^\/ws\/exec\/([^/?]+)/);
  return match ? { serviceName: decodeURIComponent(match[1]) } : null;
}
