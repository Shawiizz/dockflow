/**
 * Services API Routes
 *
 * GET  /api/services               - List Docker stack services
 * GET  /api/services/:name/logs    - Get service logs
 * POST /api/services/:name/restart - Restart a service
 * POST /api/services/:name/stop    - Stop a service (scale to 0)
 * POST /api/services/:name/scale   - Scale a service (body: { replicas })
 * POST /api/services/:name/rollback - Rollback a service
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig } from '../../utils/config';
import { getAvailableEnvironments } from '../../utils/servers';
import { sshExec } from '../../utils/ssh';
import { getManagerConnection, resolveEnvironment } from './_helpers';
import type {
  ServiceInfo,
  ServicesListResponse,
  ServiceActionResponse,
  LogEntry,
  LogsResponse,
} from '../types';

/**
 * Handle /api/services/* routes
 */
export async function handleServicesRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/services
  if (pathname === '/api/services' && method === 'GET') {
    return listServices(url);
  }

  // POST /api/services/:name/restart
  const restartMatch = pathname.match(/^\/api\/services\/([^/]+)\/restart$/);
  if (restartMatch && method === 'POST') {
    return restartService(restartMatch[1], url);
  }

  // POST /api/services/:name/stop
  const stopMatch = pathname.match(/^\/api\/services\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return stopService(stopMatch[1], url);
  }

  // POST /api/services/:name/scale
  const scaleMatch = pathname.match(/^\/api\/services\/([^/]+)\/scale$/);
  if (scaleMatch && method === 'POST') {
    return scaleService(scaleMatch[1], url, req);
  }

  // POST /api/services/:name/rollback
  const rollbackMatch = pathname.match(/^\/api\/services\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'POST') {
    return rollbackService(rollbackMatch[1], url);
  }

  // GET /api/services/:name/logs
  const logsMatch = pathname.match(/^\/api\/services\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    return getServiceLogs(logsMatch[1], url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * Parse `docker service ls` output into ServiceInfo objects
 */
function parseServiceLs(output: string, stackName: string): ServiceInfo[] {
  const lines = output.trim().split('\n');
  if (lines.length <= 1) return []; // header only

  return lines.slice(1).map((line) => {
    const parts = line.split(/\s{2,}/);
    const id = parts[0] || '';
    const name = parts[1] || '';
    const mode = parts[2] || '';
    const replicasStr = parts[3] || '0/0';
    const image = parts[4] || '';
    const portsStr = parts[5] || '';

    const [running, total] = replicasStr.split('/').map(Number);

    let state: ServiceInfo['state'] = 'unknown';
    if (!isNaN(running) && !isNaN(total)) {
      if (total === 0) state = 'stopped';
      else if (running === total) state = 'running';
      else if (running === 0) state = 'stopped';
      else state = 'error'; // partial
    }

    return {
      id,
      name,
      image,
      replicas: total || 0,
      replicasRunning: running || 0,
      state,
      ports: portsStr ? portsStr.split(',').map((p: string) => p.trim()) : [],
    };
  });
}

/**
 * List Docker services running on the swarm
 */
async function listServices(url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  const config = loadConfig({ silent: true });

  if (!config) {
    return jsonResponse({
      services: [],
      stackName: '',
      total: 0,
      message: 'No config.yml found.',
    } satisfies ServicesListResponse);
  }

  const stackName = config.project_name;
  const environments = getAvailableEnvironments();
  const env = envFilter || environments[0];

  if (!env) {
    return jsonResponse({
      services: [],
      stackName,
      total: 0,
      message: 'No environments configured.',
    } satisfies ServicesListResponse);
  }

  const conn = getManagerConnection(env);
  if (!conn) {
    return jsonResponse({
      services: [],
      stackName,
      total: 0,
      message: 'No manager server with credentials found for this environment.',
    } satisfies ServicesListResponse);
  }

  try {
    const command = `docker service ls --filter name=${stackName} --format "table {{.ID}}  {{.Name}}  {{.Mode}}  {{.Replicas}}  {{.Image}}  {{.Ports}}"`;
    const result = await sshExec(conn, command);

    if (result.exitCode !== 0) {
      return jsonResponse({
        services: [],
        stackName,
        total: 0,
        message: result.stderr.trim() || 'Failed to list services.',
      } satisfies ServicesListResponse);
    }

    const services = parseServiceLs(result.stdout, stackName);

    return jsonResponse({
      services,
      stackName,
      total: services.length,
    } satisfies ServicesListResponse);
  } catch (error) {
    return jsonResponse({
      services: [],
      stackName,
      total: 0,
      message: error instanceof Error ? error.message : 'Failed to list services.',
    } satisfies ServicesListResponse);
  }
}

/**
 * Restart a Docker service
 */
async function restartService(serviceName: string, url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const result = await sshExec(conn, `docker service update --force --detach ${serviceName}`);
    const success = result.exitCode === 0;
    return jsonResponse({
      success,
      message: success ? `Service ${serviceName} restarted` : (result.stderr.trim() || 'Failed to restart service'),
      output: result.stdout.trim() || undefined,
    } satisfies ServiceActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to restart service', 500);
  }
}

/**
 * Stop a Docker service (scale to 0)
 */
async function stopService(serviceName: string, url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const result = await sshExec(conn, `docker service scale --detach ${serviceName}=0`);
    const success = result.exitCode === 0;
    return jsonResponse({
      success,
      message: success ? `Service ${serviceName} stopped` : (result.stderr.trim() || 'Failed to stop service'),
      output: result.stdout.trim() || undefined,
    } satisfies ServiceActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to stop service', 500);
  }
}

/**
 * Scale a Docker service
 */
async function scaleService(serviceName: string, url: URL, req: Request): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  let replicas: number;
  try {
    const body = await req.json();
    replicas = parseInt(body.replicas, 10);
    if (isNaN(replicas) || replicas < 0) {
      return errorResponse('Invalid replicas value: must be a non-negative number', 400);
    }
  } catch {
    return errorResponse('Invalid request body: expected { replicas: number }', 400);
  }

  try {
    const result = await sshExec(conn, `docker service scale --detach ${serviceName}=${replicas}`);
    const success = result.exitCode === 0;
    return jsonResponse({
      success,
      message: success ? `Service ${serviceName} scaled to ${replicas}` : (result.stderr.trim() || 'Failed to scale service'),
      output: result.stdout.trim() || undefined,
    } satisfies ServiceActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to scale service', 500);
  }
}

/**
 * Rollback a Docker service
 */
async function rollbackService(serviceName: string, url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const result = await sshExec(conn, `docker service rollback --detach ${serviceName}`);
    const success = result.exitCode === 0;
    return jsonResponse({
      success,
      message: success ? `Service ${serviceName} rolled back` : (result.stderr.trim() || 'Failed to rollback service'),
      output: result.stdout.trim() || undefined,
    } satisfies ServiceActionResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to rollback service', 500);
  }
}

/**
 * Get logs for a specific service
 */
async function getServiceLogs(serviceName: string, url: URL): Promise<Response> {
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

  try {
    const command = `docker service logs --tail ${lines} --timestamps --no-trunc ${serviceName} 2>&1`;
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
            service: serviceName,
          };
        }
        return {
          timestamp: new Date().toISOString(),
          message: line,
          service: serviceName,
        };
      });

    return jsonResponse({
      logs: logEntries,
      service: serviceName,
      lines: logEntries.length,
    } satisfies LogsResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get logs',
      500,
    );
  }
}
