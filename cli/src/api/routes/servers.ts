/**
 * Servers API Routes (design-06 8.2)
 *
 * GET /api/servers - List all servers with their status
 * GET /api/servers/:name - Get a specific server
 * GET /api/servers/:name/status - Check server connectivity, and control-plane status for managers
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig, loadServersConfig } from '../../utils/config';
import { resolveServersForEnvironment, getAvailableEnvironments, getFullConnectionInfo } from '../../utils/servers';
import { probeControlPlane } from '../../services/orchestrator/target';
import type { ClusterNodeRef, ControlPlaneProbe, OrchestratorKind } from '../../services/orchestrator/interfaces';
import { sshExec } from '../../utils/ssh';
import type { ResolvedServer } from '../../types';
import type { ControlPlaneStatus, ServerStatus, SwarmStatus } from '../types';

/** bounded so an unreachable server never stalls the status poll (design-06 8.2) */
const SERVER_STATUS_TIMEOUT_MS = 10_000;
const TIMED_OUT = Symbol('server-status-timeout');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms))]);
}

/**
 * Convert ResolvedServer to ServerStatus
 */
function toServerStatus(server: ResolvedServer): ServerStatus {
  return {
    name: server.name,
    role: server.role,
    host: server.host,
    port: server.port,
    user: server.user,
    tags: server.tags,
    status: 'unknown',
    env: server.env,
  };
}

/**
 * Handle /api/servers/* routes
 */
export async function handleServersRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;
  
  // GET /api/servers - List all servers
  if (pathname === '/api/servers' && method === 'GET') {
    return listServers(url);
  }
  
  // GET /api/servers/environments - List available environments
  if (pathname === '/api/servers/environments' && method === 'GET') {
    return listEnvironments();
  }
  
  // GET /api/servers/:name/status - Check server status
  const statusMatch = pathname.match(/^\/api\/servers\/([^/]+)\/status$/);
  if (statusMatch && method === 'GET') {
    return checkServerStatus(statusMatch[1], url);
  }
  
  // GET /api/servers/:name - Get specific server
  const serverMatch = pathname.match(/^\/api\/servers\/([^/]+)$/);
  if (serverMatch && method === 'GET') {
    return getServer(serverMatch[1], url);
  }
  
  return errorResponse('Endpoint not found', 404);
}

/**
 * List all servers, optionally filtered by environment
 */
async function listServers(url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  
  const serversConfig = loadServersConfig();
  if (!serversConfig) {
    return jsonResponse({ 
      servers: [], 
      environments: [],
      message: 'No servers.yml found. Run "dockflow init" to create one.',
    });
  }
  
  const environments = getAvailableEnvironments();
  const allServers: ServerStatus[] = [];
  const seenServers = new Set<string>();
  
  for (const env of environments) {
    if (envFilter && env !== envFilter) continue;
    
    const servers = resolveServersForEnvironment(env);
    for (const server of servers) {
      if (seenServers.has(server.name)) continue;
      seenServers.add(server.name);
      allServers.push(toServerStatus(server));
    }
  }
  
  return jsonResponse({
    servers: allServers,
    environments,
    total: allServers.length,
  });
}

/**
 * List available environments
 */
async function listEnvironments(): Promise<Response> {
  const environments = getAvailableEnvironments();
  
  return jsonResponse({
    environments,
    total: environments.length,
  });
}

/**
 * Get a specific server by name
 */
async function getServer(serverName: string, url: URL): Promise<Response> {
  const serversConfig = loadServersConfig();
  if (!serversConfig) {
    return errorResponse('No servers.yml found', 404);
  }
  
  const serverConfig = serversConfig.servers[serverName];
  if (!serverConfig) {
    return errorResponse(`Server "${serverName}" not found`, 404);
  }
  
  // Find which environment this server belongs to
  const environments = getAvailableEnvironments();
  let resolvedServer: ResolvedServer | null = null;
  
  for (const env of environments) {
    const servers = resolveServersForEnvironment(env);
    const found = servers.find(s => s.name === serverName);
    if (found) {
      resolvedServer = found;
      break;
    }
  }
  
  if (!resolvedServer) {
    return errorResponse(`Could not resolve server "${serverName}"`, 404);
  }
  
  return jsonResponse(toServerStatus(resolvedServer));
}

/** `leader`/`ready`/`unready` pass through; `unreachable` covers a probe that could not decide either way. */
function toControlPlaneStatus(status: ControlPlaneProbe['status']): ControlPlaneStatus {
  return status === 'leader' || status === 'ready' || status === 'unready' ? status : 'unreachable';
}

function toSwarmStatus(status: ControlPlaneProbe['status']): SwarmStatus {
  if (status === 'leader') return 'leader';
  if (status === 'ready') return 'reachable';
  return 'unreachable';
}

/**
 * Check server connectivity, and — for a manager — control-plane status. `sshExec(conn, 'true')`
 * bounded to `SERVER_STATUS_TIMEOUT_MS`: a failure or timeout answers `status: 'offline'` without
 * ever probing the control plane, since a server that cannot be reached is not one either.
 */
async function checkServerStatus(serverName: string, url: URL): Promise<Response> {
  const env = url.searchParams.get('env');

  const serversConfig = loadServersConfig();
  if (!serversConfig) {
    return errorResponse('No servers.yml found', 404);
  }

  // Find the server (and the environment it resolved under, for its connection)
  const environments = env ? [env] : getAvailableEnvironments();
  let resolvedServer: ResolvedServer | null = null;
  let resolvedEnv: string | null = null;

  for (const e of environments) {
    const servers = resolveServersForEnvironment(e);
    const found = servers.find((s) => s.name === serverName);
    if (found) {
      resolvedServer = found;
      resolvedEnv = e;
      break;
    }
  }

  if (!resolvedServer || !resolvedEnv) {
    return errorResponse(`Server "${serverName}" not found`, 404);
  }

  const conn = getFullConnectionInfo(resolvedEnv, serverName);
  if (!conn) {
    return jsonResponse({
      ...toServerStatus(resolvedServer),
      status: 'unknown',
      message: 'No connection credentials available. Set up .env.dockflow or CI secrets.',
    } satisfies ServerStatus);
  }

  let raced: Awaited<ReturnType<typeof sshExec>> | typeof TIMED_OUT;
  try {
    raced = await withTimeout(sshExec(conn, 'true'), SERVER_STATUS_TIMEOUT_MS);
  } catch (error) {
    return jsonResponse({
      ...toServerStatus(resolvedServer),
      status: 'offline',
      error: error instanceof Error ? error.message : 'Connection failed',
    } satisfies ServerStatus);
  }

  if (raced === TIMED_OUT || raced.exitCode !== 0) {
    return jsonResponse({
      ...toServerStatus(resolvedServer),
      status: 'offline',
      error: raced === TIMED_OUT ? 'Connection timed out' : raced.stderr.trim() || 'Command failed',
    } satisfies ServerStatus);
  }

  if (resolvedServer.role !== 'manager') {
    return jsonResponse({ ...toServerStatus(resolvedServer), status: 'online' } satisfies ServerStatus);
  }

  const kind: OrchestratorKind = loadConfig({ silent: true })?.orchestrator ?? 'swarm';
  const nodeRef: ClusterNodeRef = {
    name: resolvedServer.name,
    role: resolvedServer.role,
    host: resolvedServer.host,
    privateHost: resolvedServer.privateHost,
    connection: conn,
  };
  const probe = await probeControlPlane(kind, nodeRef);

  return jsonResponse({
    ...toServerStatus(resolvedServer),
    status: 'online',
    controlPlaneStatus: toControlPlaneStatus(probe.status),
    swarmStatus: kind === 'swarm' ? toSwarmStatus(probe.status) : undefined,
  } satisfies ServerStatus);
}
