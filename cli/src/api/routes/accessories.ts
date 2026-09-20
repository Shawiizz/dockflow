/**
 * Accessories API Routes (design-06 8.2)
 *
 * GET  /api/accessories              - List configured accessories (accessories.yml + config.helm accessory releases)
 * GET  /api/accessories/status?env=  - Live status merged with accessories.yml
 * POST /api/accessories/:name/restart?env=     - Restart an accessory
 * POST /api/accessories/:name/stop?env=        - Stop an accessory (records replicas-before-stop)
 * GET  /api/accessories/:name/logs?env=&lines= - Get accessory logs
 */

import { loadConfig, getLayout } from '../../utils/config';
import { formatReplicas } from '../../services/orchestrator/format';
import type { ServiceInfo as CoreServiceInfo } from '../../services/orchestrator/interfaces';
import {
  collectLogEntries,
  errorResponse,
  isValidDockerName,
  jsonResponse,
  parseIntParam,
  resolveApiService,
  withOrchestrator,
} from './_helpers';
import * as Compose from '../../services/compose';
import type { AccessoryInfo, AccessoriesResponse } from '../types';
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

/** Accessory-role Helm releases of `config.helm`, shown beside the compose accessories (design-06 8.2). */
function helmAccessories(): AccessoryInfo[] {
  const config = loadConfig({ silent: true });
  const releases = config?.helm?.releases ?? [];
  return releases
    .filter((release) => release.role === 'accessory')
    .map((release) => ({ name: release.name, image: `chart ${release.chart}@${release.version}` }));
}

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
 * List configured accessories from accessories.yml and accessory-role Helm releases
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

  const accessories = [...readAccessoriesFromFile(), ...helmAccessories()];

  return jsonResponse({
    accessories,
    total: accessories.length,
    message: accessories.length === 0 ? 'No accessories.yml found.' : undefined,
  } satisfies AccessoriesResponse);
}

const SERVICE_STATE_TO_ACCESSORY_STATUS: Record<CoreServiceInfo['state'], NonNullable<AccessoryStatusInfo['status']>> = {
  running: 'running',
  stopped: 'stopped',
  converging: 'starting',
  degraded: 'error',
};

/**
 * Get live accessories status, merged with accessories.yml + accessory-role Helm releases by name
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

  const fileAccessories: AccessoryStatusInfo[] = [...readAccessoriesFromFile(), ...helmAccessories()].map((acc) => ({
    ...acc,
    status: 'unknown',
  }));

  return withOrchestrator(url, async (ctx) => {
    const live = await ctx.orchestrator.stack.getServices(ctx.accessoryRef);
    const byName = new Map(live.map((service) => [service.name, service]));
    const accessories: AccessoryStatusInfo[] = fileAccessories.map((acc) => {
      const service = byName.get(acc.name);
      if (!service) return acc;
      return {
        ...acc,
        status: SERVICE_STATE_TO_ACCESSORY_STATUS[service.state],
        replicas: formatReplicas(service),
        replicasRunning: service.replicas.running,
        replicasDesired: service.replicas.desired,
      };
    });
    return jsonResponse({ accessories, total: accessories.length } satisfies AccessoriesStatusResponse);
  });
}

/**
 * Restart an accessory
 */
async function restartAccessory(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid accessory name', 400);

  return withOrchestrator(url, async (ctx) => {
    await ctx.orchestrator.stack.restart(ctx.accessoryRef, name, { wait: false, timeoutS: 0 });
    return jsonResponse({
      success: true,
      message: `Accessory "${name}" restarted successfully`,
    } satisfies AccessoryActionResponse);
  });
}

/**
 * Stop an accessory. Never `scale(..., 0)`: `stack.stop` records `P/replicas-before-stop`.
 */
async function stopAccessory(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid accessory name', 400);

  return withOrchestrator(url, async (ctx) => {
    await ctx.orchestrator.stack.stop(ctx.accessoryRef, [name], { wait: false, timeoutS: 0 });
    return jsonResponse({
      success: true,
      message: `Accessory "${name}" stopped successfully`,
    } satisfies AccessoryActionResponse);
  });
}

/**
 * Get logs for a specific accessory, with real timestamps (as the services logs route).
 */
async function getAccessoryLogs(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid accessory name', 400);
  const lines = parseIntParam(url.searchParams.get('lines'), 100, 1, 10000);

  return withOrchestrator(url, async (ctx) => {
    const { service } = await resolveApiService(ctx, name, ['accessory']);
    const entries = await collectLogEntries(ctx.orchestrator.containers, ctx.accessoryRef, service.name, service.replicas.desired, lines);
    return jsonResponse({ logs: entries, service: service.name, lines: entries.length } satisfies LogsResponse);
  });
}
