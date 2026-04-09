import { jsonResponse, errorResponse } from '../server';
import { getComposePath, loadServersConfig } from '../../utils/config';
import { readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  ComposeFile,
  TopologyResponse,
  TopologyService,
  TopologyServer,
  TopologyConnection,
  TopologyUpdateRequest,
} from '../types';

export async function handleTopologyRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/topology' && method === 'GET') {
    return getTopology();
  }

  if (pathname === '/api/topology' && method === 'PUT') {
    return updateTopology(req);
  }

  return errorResponse('Endpoint not found', 404);
}

async function getTopology(): Promise<Response> {
  try {
    // 1. Load compose
    const composePath = getComposePath();
    let composeServices: Record<string, { image?: string; ports?: string[]; deploy?: { replicas?: number; placement?: { constraints?: string[] } } }> = {};

    if (composePath) {
      const content = readFileSync(composePath, 'utf-8');
      const parsed = parseYaml(content) as ComposeFile;
      composeServices = parsed?.services ?? {};
    }

    // 2. Load servers config
    const serversConfig = loadServersConfig({ silent: true });
    const rawServers = serversConfig?.servers ?? {};

    // 3. Build service list
    const services: TopologyService[] = Object.entries(composeServices).map(([name, svc]) => ({
      name,
      image: svc.image,
      replicas: svc.deploy?.replicas,
      ports: svc.ports,
    }));

    // 4. Build server list
    const servers: TopologyServer[] = Object.entries(rawServers).map(([name, config]) => ({
      name,
      role: config.role ?? 'worker',
      host: config.host,
      tags: config.tags ?? [],
    }));

    // 5. Parse connections from placement constraints
    const connections: TopologyConnection[] = [];
    const servicesWithConstraints = new Set<string>();

    for (const [name, svc] of Object.entries(composeServices)) {
      const constraints = svc.deploy?.placement?.constraints ?? [];
      for (const c of constraints) {
        const match = c.match(/node\.(hostname|role)\s*==\s*(.+)/);
        if (match) {
          servicesWithConstraints.add(name);
          const type = match[1] as 'hostname' | 'role';
          const value = match[2].trim();

          if (type === 'hostname') {
            connections.push({
              serviceName: name,
              serverName: value,
              constraintType: 'hostname',
              constraintValue: value,
              implicit: false,
            });
          } else {
            // For role constraints, find all servers matching the role
            for (const srv of servers) {
              if (srv.role === value) {
                connections.push({
                  serviceName: name,
                  serverName: srv.name,
                  constraintType: 'role',
                  constraintValue: value,
                  implicit: false,
                });
              }
            }
          }
        }
      }
    }

    // 6. Services without constraints can run on any node (implicit)
    for (const name of Object.keys(composeServices)) {
      if (!servicesWithConstraints.has(name)) {
        for (const srv of servers) {
          connections.push({
            serviceName: name,
            serverName: srv.name,
            constraintType: 'role',
            constraintValue: 'any',
            implicit: true,
          });
        }
      }
    }

    const response: TopologyResponse = { services, servers, connections };
    return jsonResponse(response);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to load topology',
      500,
    );
  }
}

async function updateTopology(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as TopologyUpdateRequest;

    if (!Array.isArray(body.connections)) {
      return jsonResponse({ success: false, error: 'Missing "connections" array' }, 400);
    }

    const composePath = getComposePath();
    if (!composePath) {
      return errorResponse('No docker-compose.yml found in .dockflow/docker/', 404);
    }

    // Read the current compose file
    const content = readFileSync(composePath, 'utf-8');
    const compose = parseYaml(content) as ComposeFile;

    if (!compose?.services) {
      return jsonResponse({ success: false, error: 'Invalid compose file: no services' }, 400);
    }

    // Apply connections as placement constraints
    for (const [name, svc] of Object.entries(compose.services)) {
      const serviceConns = body.connections.filter(c => c.serviceName === name);

      if (serviceConns.length > 0) {
        if (!svc.deploy) svc.deploy = {};
        if (!svc.deploy.placement) svc.deploy.placement = {};
        svc.deploy.placement.constraints = serviceConns.map(c =>
          `node.${c.constraintType}==${c.constraintValue}`,
        );
      } else {
        // Remove constraints if no connections for this service
        if (svc.deploy?.placement?.constraints) {
          delete svc.deploy.placement.constraints;
          if (Object.keys(svc.deploy.placement).length === 0) {
            delete svc.deploy.placement;
          }
          if (svc.deploy && Object.keys(svc.deploy).length === 0) {
            delete svc.deploy;
          }
        }
      }
    }

    // Write back
    const yamlContent = stringifyYaml(compose, { indent: 2 });
    writeFileSync(composePath, yamlContent, 'utf-8');

    return jsonResponse({ success: true, message: 'Topology saved to docker-compose.yml' });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update topology',
      500,
    );
  }
}
