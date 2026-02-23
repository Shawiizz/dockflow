/**
 * Accessories API Routes
 *
 * GET  /api/accessories              - List configured accessories (config only)
 * GET  /api/accessories/status?env=  - Live status from Docker Swarm
 * POST /api/accessories/:name/restart?env=     - Restart an accessory (docker service update --force)
 * POST /api/accessories/:name/stop?env=        - Stop an accessory (docker service scale to 0)
 * GET  /api/accessories/:name/logs?env=&lines= - Get accessory logs
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig } from '../../utils/config';
import { getManagerConnection, resolveEnvironment, getAccessoriesStack } from './_helpers';
import { sshExec } from '../../utils/ssh';
import { getAccessoriesStackName } from '../../utils/config';
import type { AccessoryInfo, AccessoriesResponse } from '../types';
import type { AccessoryStatusInfo, AccessoriesStatusResponse, AccessoryActionResponse, LogEntry, LogsResponse } from '../types';

/**
 * Handle /api/accessories/* routes
 */
export async function handleAccessoriesRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/accessories
  if (pathname === '/api/accessories' && method === 'GET') {
    return listAccessories();
  }

  // GET /api/accessories/status?env=
  if (pathname === '/api/accessories/status' && method === 'GET') {
    return getAccessoriesStatus(url);
  }

  // POST /api/accessories/:name/restart?env=
  const restartMatch = pathname.match(/^\/api\/accessories\/([^/]+)\/restart$/);
  if (restartMatch && method === 'POST') {
    return restartAccessory(decodeURIComponent(restartMatch[1]), url);
  }

  // POST /api/accessories/:name/stop?env=
  const stopMatch = pathname.match(/^\/api\/accessories\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return stopAccessory(decodeURIComponent(stopMatch[1]), url);
  }

  // GET /api/accessories/:name/logs?env=&lines=
  const logsMatch = pathname.match(/^\/api\/accessories\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    return getAccessoryLogs(decodeURIComponent(logsMatch[1]), url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * List configured accessories from config.yml
 */
async function listAccessories(): Promise<Response> {
  const config = loadConfig({ silent: true });

  if (!config) {
    return jsonResponse({
      accessories: [],
      total: 0,
      message: 'No config.yml found.',
    } satisfies AccessoriesResponse & { message?: string });
  }

  const accessoriesConfig = (config as unknown as Record<string, unknown>)['accessories'];
  const accessories: AccessoryInfo[] = [];

  if (accessoriesConfig && typeof accessoriesConfig === 'object') {
    for (const [name, value] of Object.entries(accessoriesConfig as Record<string, unknown>)) {
      const acc = value as Record<string, unknown>;
      accessories.push({
        name,
        image: (acc['image'] as string) || undefined,
        volumes: Array.isArray(acc['volumes']) ? acc['volumes'] as string[] : undefined,
        ports: Array.isArray(acc['ports']) ? acc['ports'] as string[] : undefined,
        env: (acc['env'] && typeof acc['env'] === 'object')
          ? acc['env'] as Record<string, string>
          : undefined,
      });
    }
  }

  return jsonResponse({
    accessories,
    total: accessories.length,
  } satisfies AccessoriesResponse);
}

/**
 * Get live accessories status from Docker Swarm
 */
async function getAccessoriesStatus(url: URL): Promise<Response> {
  const config = loadConfig({ silent: true });
  if (!config) {
    return jsonResponse({
      accessories: [],
      total: 0,
      message: 'No config.yml found.',
    } satisfies AccessoriesStatusResponse);
  }

  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) {
    return errorResponse('No environments configured', 404);
  }

  const conn = getManagerConnection(env);
  if (!conn) {
    return errorResponse('No manager server with credentials found', 404);
  }

  const accStackName = getAccessoriesStackName(env);
  if (!accStackName) {
    return errorResponse('Cannot determine accessories stack name', 500);
  }

  // Get accessories from config
  const accessoriesConfig = (config as unknown as Record<string, unknown>)['accessories'];
  const accessories: AccessoryStatusInfo[] = [];

  if (accessoriesConfig && typeof accessoriesConfig === 'object') {
    for (const [name, value] of Object.entries(accessoriesConfig as Record<string, unknown>)) {
      const acc = value as Record<string, unknown>;
      accessories.push({
        name,
        image: (acc['image'] as string) || undefined,
        volumes: Array.isArray(acc['volumes']) ? acc['volumes'] as string[] : undefined,
        ports: Array.isArray(acc['ports']) ? acc['ports'] as string[] : undefined,
        env: (acc['env'] && typeof acc['env'] === 'object')
          ? acc['env'] as Record<string, string>
          : undefined,
        status: 'unknown',
      });
    }
  }

  try {
    // Get live service data via SSH
    const command = `docker service ls --filter name=${accStackName} --format '{{.Name}}|{{.Replicas}}'`;
    const result = await sshExec(conn, command);

    if (result.exitCode === 0 && result.stdout.trim()) {
      const lines = result.stdout.trim().split('\n').filter((l) => l.trim());

      for (const line of lines) {
        const [serviceName, replicas] = line.split('|');
        if (!serviceName || !replicas) continue;

        // Match config accessories with Docker services by name
        // Docker service name format: ${accStackName}_${accessoryName}
        const prefix = `${accStackName}_`;
        if (!serviceName.startsWith(prefix)) continue;

        const accName = serviceName.slice(prefix.length);
        const acc = accessories.find((a) => a.name === accName);
        if (!acc) continue;

        acc.replicas = replicas;

        // Parse replicas (e.g., "1/1", "0/1")
        const replicasMatch = replicas.match(/^(\d+)\/(\d+)$/);
        if (replicasMatch) {
          acc.replicasRunning = parseInt(replicasMatch[1], 10);
          acc.replicasDesired = parseInt(replicasMatch[2], 10);
          if (acc.replicasDesired === 0) acc.status = 'stopped';
          else if (acc.replicasRunning === acc.replicasDesired) acc.status = 'running';
          else if (acc.replicasRunning === 0) acc.status = 'stopped';
          else acc.status = 'error';
        }
      }
    }

    return jsonResponse({
      accessories,
      total: accessories.length,
    } satisfies AccessoriesStatusResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get accessories status',
      500,
    );
  }
}

/**
 * Restart an accessory (docker service update --force)
 */
async function restartAccessory(name: string, url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  const accStackName = getAccessoriesStackName(env);
  if (!accStackName) return errorResponse('Cannot determine accessories stack name', 500);

  try {
    const result = await sshExec(conn, `docker service update --force --detach ${accStackName}_${name}`);
    const success = result.exitCode === 0;
    return jsonResponse({
      success,
      message: success
        ? `Accessory "${name}" restarted successfully`
        : `Failed to restart accessory "${name}"`,
      output: result.stdout || result.stderr || undefined,
    } satisfies AccessoryActionResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to restart accessory',
      500,
    );
  }
}

/**
 * Stop an accessory (docker service scale to 0)
 */
async function stopAccessory(name: string, url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  const accStackName = getAccessoriesStackName(env);
  if (!accStackName) return errorResponse('Cannot determine accessories stack name', 500);

  try {
    const result = await sshExec(conn, `docker service scale --detach ${accStackName}_${name}=0`);
    const success = result.exitCode === 0;
    return jsonResponse({
      success,
      message: success
        ? `Accessory "${name}" stopped successfully`
        : `Failed to stop accessory "${name}"`,
      output: result.stdout || result.stderr || undefined,
    } satisfies AccessoryActionResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to stop accessory',
      500,
    );
  }
}

/**
 * Get logs for a specific accessory
 */
async function getAccessoryLogs(name: string, url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  const lines = parseInt(url.searchParams.get('lines') || '100', 10);

  const config = loadConfig({ silent: true });
  if (!config) {
    return errorResponse('No config.yml found', 404);
  }

  const env = resolveEnvironment(envFilter);
  if (!env) {
    return errorResponse('No environments configured', 404);
  }

  const conn = getManagerConnection(env);
  if (!conn) {
    return errorResponse('No manager server with credentials found', 404);
  }

  const accStackName = getAccessoriesStackName(env);
  if (!accStackName) {
    return errorResponse('Cannot determine accessories stack name', 500);
  }

  try {
    const command = `docker service logs --tail ${lines} --timestamps ${accStackName}_${name} 2>&1`;
    const result = await sshExec(conn, command);

    const logEntries: LogEntry[] = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        // Docker log format: TIMESTAMP SERVICE.REPLICA@HOST MESSAGE
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)/);
        if (tsMatch) {
          return {
            timestamp: tsMatch[1],
            message: tsMatch[2],
            service: name,
          };
        }
        return {
          timestamp: new Date().toISOString(),
          message: line,
          service: name,
        };
      });

    return jsonResponse({
      logs: logEntries,
      service: name,
      lines: logEntries.length,
    } satisfies LogsResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get logs',
      500,
    );
  }
}
