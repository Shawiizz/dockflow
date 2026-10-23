/** Routes to list servers and environments, read one server and probe its connectivity. */

import { jsonResponse, errorResponse } from '../server';
import { loadServersConfig } from '../../utils/config';
import {
  resolveServersForEnvironment,
  getAvailableEnvironments,
  getServerPrivateKey,
  checkManagerStatus
} from '../../utils/servers';
import type { ResolvedServer } from '../../types';
import { sshExec } from '../../utils/ssh';
import { withTimeout } from './_helpers';
import type { ServerConnectionStatus, ServerStatus, SwarmStatus } from '../types';

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

export async function handleServersRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/servers' && method === 'GET') {
    return listServers(url);
  }

  if (pathname === '/api/servers/environments' && method === 'GET') {
    return listEnvironments();
  }

  const statusMatch = pathname.match(/^\/api\/servers\/([^/]+)\/status$/);
  if (statusMatch && method === 'GET') {
    return checkServerStatus(statusMatch[1], url);
  }

  const serverMatch = pathname.match(/^\/api\/servers\/([^/]+)$/);
  if (serverMatch && method === 'GET') {
    return getServer(serverMatch[1], url);
  }

  return errorResponse('Endpoint not found', 404);
}

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

async function listEnvironments(): Promise<Response> {
  const environments = getAvailableEnvironments();

  return jsonResponse({
    environments,
    total: environments.length,
  });
}

async function getServer(serverName: string, url: URL): Promise<Response> {
  const serversConfig = loadServersConfig();
  if (!serversConfig) {
    return errorResponse('No servers.yml found', 404);
  }

  const serverConfig = serversConfig.servers[serverName];
  if (!serverConfig) {
    return errorResponse(`Server "${serverName}" not found`, 404);
  }

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

/** How long the status route waits for a server before calling it offline. */
const STATUS_PROBE_TIMEOUT_MS = 10_000;

/** A server answers over SSH, and when it is a manager Docker answers too: anything but `unreachable` is online. */
export function connectivityStatus(sshReachable: boolean, swarmStatus?: SwarmStatus): ServerConnectionStatus {
  if (!sshReachable || swarmStatus === 'unreachable') return 'offline';
  return 'online';
}

async function checkServerStatus(serverName: string, url: URL): Promise<Response> {
  const env = url.searchParams.get('env');

  const serversConfig = loadServersConfig();
  if (!serversConfig) {
    return errorResponse('No servers.yml found', 404);
  }

  const environments = env ? [env] : getAvailableEnvironments();
  let resolvedServer: ResolvedServer | null = null;
  let resolvedEnv = '';

  for (const e of environments) {
    const servers = resolveServersForEnvironment(e);
    const found = servers.find(s => s.name === serverName);
    if (found) {
      resolvedServer = found;
      resolvedEnv = e;
      break;
    }
  }

  if (!resolvedServer) {
    return errorResponse(`Server "${serverName}" not found`, 404);
  }

  const privateKey = getServerPrivateKey(resolvedEnv, serverName);
  if (!privateKey) {
    return jsonResponse({
      ...toServerStatus(resolvedServer),
      status: 'unknown',
      message: 'No connection credentials available. Set up .env.dockflow or CI secrets.',
    });
  }

  const connection = {
    host: resolvedServer.host,
    port: resolvedServer.port,
    user: resolvedServer.user,
    privateKey,
    hostKey: resolvedServer.hostKey,
  };

  try {
    const probe = await withTimeout(sshExec(connection, 'true'), STATUS_PROBE_TIMEOUT_MS, `${serverName} did not answer`);
    const sshReachable = probe.exitCode === 0;
    const swarmStatus: SwarmStatus | undefined =
      sshReachable && resolvedServer.role === 'manager' ? await checkManagerStatus(connection) : undefined;

    const status = connectivityStatus(sshReachable, swarmStatus);
    return jsonResponse({
      ...toServerStatus(resolvedServer),
      status,
      swarmStatus,
      ...(sshReachable ? {} : { error: probe.stderr.trim() || 'SSH command failed' }),
    } satisfies ServerStatus);
  } catch (error) {
    return jsonResponse({
      ...toServerStatus(resolvedServer),
      status: 'offline',
      error: error instanceof Error ? error.message : 'Connection failed',
    } satisfies ServerStatus);
  }
}
