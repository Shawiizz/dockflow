/**
 * Services API Routes
 *
 * GET /api/services               - List Docker stack services
 * GET /api/services/:name/logs    - Get service logs
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig } from '../../utils/config';
import {
  resolveServersForEnvironment,
  getAvailableEnvironments,
  getServerPrivateKey,
} from '../../utils/servers';
import type { ServiceInfo, ServicesListResponse, LogEntry, LogsResponse } from '../types';

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
      if (running === total && total > 0) state = 'running';
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
 * Get SSH connection to manager server for a given environment
 */
function getManagerConnection(env: string) {
  const servers = resolveServersForEnvironment(env);
  const manager = servers.find((s) => s.role === 'manager');
  if (!manager) return null;

  const privateKey = getServerPrivateKey(env, manager.name);
  if (!privateKey) return null;

  return {
    host: manager.host,
    port: manager.port,
    user: manager.user,
    privateKey,
    stackName: loadConfig({ silent: true })?.project_name || '',
  };
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
    const sshCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-i', conn.privateKey,
      '-p', String(conn.port),
      `${conn.user}@${conn.host}`,
      `docker service ls --filter name=${stackName} --format "table {{.ID}}  {{.Name}}  {{.Mode}}  {{.Replicas}}  {{.Image}}  {{.Ports}}"`,
    ];

    const proc = Bun.spawn(sshCmd, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return jsonResponse({
        services: [],
        stackName,
        total: 0,
        message: stderr.trim() || 'Failed to list services.',
      } satisfies ServicesListResponse);
    }

    const services = parseServiceLs(output, stackName);

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
 * Get logs for a specific service
 */
async function getServiceLogs(serviceName: string, url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  const lines = parseInt(url.searchParams.get('lines') || '100', 10);

  const config = loadConfig({ silent: true });
  if (!config) {
    return errorResponse('No config.yml found', 404);
  }

  const environments = getAvailableEnvironments();
  const env = envFilter || environments[0];

  if (!env) {
    return errorResponse('No environments configured', 404);
  }

  const conn = getManagerConnection(env);
  if (!conn) {
    return errorResponse('No manager server with credentials found', 404);
  }

  try {
    const sshCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-i', conn.privateKey,
      '-p', String(conn.port),
      `${conn.user}@${conn.host}`,
      `docker service logs --tail ${lines} --timestamps --no-trunc ${serviceName} 2>&1`,
    ];

    const proc = Bun.spawn(sshCmd, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const logEntries: LogEntry[] = output
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
