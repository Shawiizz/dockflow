/** Routes for the accessories: the definitions in accessories.yml, their live Swarm status, restart, stop and logs. */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig, getAccessoriesStackName, getLayout } from '../../utils/config';
import { getManagerConnection, resolveEnvironment, isValidDockerName, parseIntParam } from './_helpers';
import { shellQuote, sshExec } from '../../utils/ssh';
import { readServiceLogs, resolvePartialStates, stateFromReplicas } from './services';
import * as Compose from '../../services/compose';
import type { AccessoryInfo, AccessoriesResponse, ServiceInfo } from '../types';
import type { AccessoryStatusInfo, AccessoriesStatusResponse, AccessoryActionResponse, LogsResponse } from '../types';

/** Normalizes compose `environment:` (map or `KEY=value` list form) into a plain string map. */
export function normalizeEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const result: Record<string, string> = {};
    for (const entry of raw) {
      const [key, ...rest] = String(entry).split('=');
      if (key) result[key] = rest.join('=');
    }
    return result;
  }
  if (typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }
  return undefined;
}

export function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((v) => String(v));
}

/**
 * Read accessory definitions straight from accessories.yml (Docker Compose format) —
 * accessories are never defined under `accessories:` in config.yml, that field doesn't
 * exist. See docs/app/en/configuration/accessories/page.mdx.
 */
function readAccessoriesFromFile(): AccessoryInfo[] {
  const accessoriesPath = getLayout().accessoriesPath;
  if (!accessoriesPath) return [];

  let compose: Compose.ParsedCompose;
  try {
    compose = Compose.load(accessoriesPath);
  } catch {
    return [];
  }

  return Object.entries(compose.services).map(([name, svc]) => ({
    name,
    image: typeof svc.image === 'string' ? svc.image : undefined,
    volumes: normalizeStringArray(svc.volumes),
    ports: normalizeStringArray(svc.ports),
    env: normalizeEnv(svc.environment),
  }));
}

export async function handleAccessoriesRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/accessories' && method === 'GET') {
    return listAccessories();
  }

  if (pathname === '/api/accessories/status' && method === 'GET') {
    return getAccessoriesStatus(url);
  }

  const restartMatch = pathname.match(/^\/api\/accessories\/([^/]+)\/restart$/);
  if (restartMatch && method === 'POST') {
    return restartAccessory(decodeURIComponent(restartMatch[1]), url);
  }

  const stopMatch = pathname.match(/^\/api\/accessories\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return stopAccessory(decodeURIComponent(stopMatch[1]), url);
  }

  const logsMatch = pathname.match(/^\/api\/accessories\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    return getAccessoryLogs(decodeURIComponent(logsMatch[1]), url);
  }

  return errorResponse('Endpoint not found', 404);
}

async function listAccessories(): Promise<Response> {
  const config = loadConfig({ silent: true });

  if (!config) {
    return jsonResponse({
      accessories: [],
      total: 0,
      message: 'No config.yml found.',
    } satisfies AccessoriesResponse & { message?: string });
  }

  const accessories = readAccessoriesFromFile();

  return jsonResponse({
    accessories,
    total: accessories.length,
    message: accessories.length === 0 ? 'No accessories.yml found.' : undefined,
  } satisfies AccessoriesResponse);
}

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

  const conn = await getManagerConnection(env);
  if (!conn) {
    return errorResponse('No manager server with credentials found', 404);
  }

  const accStackName = getAccessoriesStackName(env);
  if (!accStackName) {
    return errorResponse('Cannot determine accessories stack name', 500);
  }

  const accessories: AccessoryStatusInfo[] = readAccessoriesFromFile().map((acc) => ({
    ...acc,
    status: 'unknown',
  }));

  try {
    const command = `docker service ls --filter ${shellQuote(`label=com.docker.stack.namespace=${accStackName}`)} --format '{{.Name}}|{{.Replicas}}|{{.Mode}}'`;
    const result = await sshExec(conn, command);

    if (result.exitCode === 0 && result.stdout.trim()) {
      const lines = result.stdout.trim().split('\n').filter((l) => l.trim());
      const tracked: { name: string; state: ServiceInfo['state']; acc: AccessoryStatusInfo }[] = [];

      for (const line of lines) {
        const [serviceName, replicas, mode] = line.split('|');
        if (!serviceName || !replicas) continue;

        const prefix = `${accStackName}_`;
        if (!serviceName.startsWith(prefix)) continue;

        const acc = accessories.find((a) => a.name === serviceName.slice(prefix.length));
        if (!acc) continue;

        acc.replicas = replicas;

        const counts = stateFromReplicas(replicas, mode);
        if (counts.state === 'unknown') continue;
        acc.replicasRunning = counts.running;
        acc.replicasDesired = counts.total;
        tracked.push({ name: serviceName, state: counts.state, acc });
      }

      await resolvePartialStates(conn, tracked);
      for (const { state, acc } of tracked) acc.status = state === 'paused' || state === 'unknown' ? 'unknown' : state;
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

async function restartAccessory(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid accessory name', 400);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = await getManagerConnection(env);
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

async function stopAccessory(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid accessory name', 400);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = await getManagerConnection(env);
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

async function getAccessoryLogs(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid accessory name', 400);
  const envFilter = url.searchParams.get('env');
  const lines = parseIntParam(url.searchParams.get('lines'), 100, 1, 10000);

  const config = loadConfig({ silent: true });
  if (!config) {
    return errorResponse('No config.yml found', 404);
  }

  const env = resolveEnvironment(envFilter);
  if (!env) {
    return errorResponse('No environments configured', 404);
  }

  const conn = await getManagerConnection(env);
  if (!conn) {
    return errorResponse('No manager server with credentials found', 404);
  }

  const accStackName = getAccessoriesStackName(env);
  if (!accStackName) {
    return errorResponse('Cannot determine accessories stack name', 500);
  }

  try {
    const read = await readServiceLogs(conn, accStackName, `${accStackName}_${name}`, name, lines);
    if ('error' in read) return errorResponse(read.error, read.status);

    return jsonResponse({
      logs: read.logs,
      service: name,
      lines: read.logs.length,
    } satisfies LogsResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get logs',
      500,
    );
  }
}
