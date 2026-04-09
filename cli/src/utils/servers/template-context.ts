/**
 * Template context builder for Jinja2 rendering
 * 
 * Builds the complete context object that Ansible/Jinja2 uses:
 * - {{ current }} - The current server being deployed to
 * - {{ servers }} - All servers in the environment
 * - {{ cluster }} - Cluster metadata (size, managers, workers)
 */

import type { 
  ResolvedServer, 
  SafeServer, 
  CurrentServer, 
  TemplateContext 
} from '../../types';
import { resolveServersForEnvironment } from './resolver';

/**
 * Convert a ResolvedServer to a SafeServer for template access
 * Environment variable keys are lowercased for Jinja2 compatibility
 */
function toSafeServer(server: ResolvedServer): SafeServer {
  // Lowercase all env keys for Jinja2 templates
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

/**
 * Build the complete template context for Jinja2 rendering
 * 
 * This provides:
 * - {{ current }} - The current server being deployed to
 * - {{ servers }} - All servers in the environment (hydrated with CI secrets)
 * - {{ cluster }} - Cluster metadata (size, managers, workers)
 * 
 * All environment variables from servers.yml and CI secrets are available.
 * 
 * @param environment - The environment/tag being deployed
 * @param currentServerName - The name of the current deployment target
 * @returns Complete template context, or null if server not found
 */
export function buildTemplateContext(
  environment: string,
  currentServerName: string
): TemplateContext | null {
  // Get all servers for this environment (already hydrated with CI secrets)
  const allServers = resolveServersForEnvironment(environment);
  
  if (allServers.length === 0) {
    return null;
  }
  
  // Find the current server
  const currentResolved = allServers.find(s => s.name === currentServerName);
  if (!currentResolved) {
    return null;
  }
  
  // Build the current server context
  const current: CurrentServer = {
    ...toSafeServer(currentResolved),
    is_current: true,
  };
  
  // Build servers map (keyed by name)
  const servers: Record<string, SafeServer> = {};
  for (const server of allServers) {
    servers[server.name] = toSafeServer(server);
  }
  
  // Build cluster metadata
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
