/**
 * The context Nunjucks templates render with: `current` (the server being deployed to),
 * `servers` (all of the environment, by name) and `cluster` (sizes and hosts of managers and workers).
 */

import type { 
  ResolvedServer, 
  SafeServer, 
  CurrentServer, 
  TemplateContext 
} from '../../types';
import { resolveServersForEnvironment } from './resolver';

/** The template view of a server: env keys lowercased, and no private host or host key. */
function toSafeServer(server: ResolvedServer): SafeServer {
  const lowerEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    lowerEnv[key.toLowerCase()] = value;
  }
  
  return {
    name: server.name,
    role: server.role,
    host: server.host,
    port: server.port,
    user: server.user,
    tags: [...server.tags],
    env: lowerEnv,
  };
}

/** Null when the environment has no server or none is named `currentServerName`. */
export function buildTemplateContext(
  environment: string,
  currentServerName: string
): TemplateContext | null {
  const allServers = resolveServersForEnvironment(environment);
  
  if (allServers.length === 0) {
    return null;
  }
  
  const currentResolved = allServers.find(s => s.name === currentServerName);
  if (!currentResolved) {
    return null;
  }
  
  const current: CurrentServer = {
    ...toSafeServer(currentResolved),
    is_current: true,
  };
  
  const servers: Record<string, SafeServer> = {};
  for (const server of allServers) {
    servers[server.name] = toSafeServer(server);
  }
  
  const managers = allServers.filter(s => s.role === 'manager');
  const workers = allServers.filter(s => s.role === 'worker');
  
  const cluster = {
    size: allServers.length,
    manager_count: managers.length,
    worker_count: workers.length,
    managers: managers.map(m => m.host),
    workers: workers.map(w => w.host),
  };
  
  return {
    current,
    servers,
    cluster,
  };
}
