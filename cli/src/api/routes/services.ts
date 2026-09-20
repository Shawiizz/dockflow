/**
 * Services API Routes (design-06 8.2)
 *
 * GET  /api/services               - List app and accessory services through the orchestrator
 * GET  /api/services/:name/logs    - Get service logs (real timestamps, both orchestrators)
 * POST /api/services/:name/restart - Restart a service
 * POST /api/services/:name/stop    - Stop a service (records replicas-before-stop, never scale-to-0)
 * POST /api/services/:name/scale   - Scale a service (body: { replicas })
 * POST /api/services/:name/rollback - Rollback a service (app role only)
 */

import { loadConfig } from '../../utils/config';
import { formatPorts } from '../../services/orchestrator/format';
import type { ServiceInfo as CoreServiceInfo } from '../../services/orchestrator/interfaces';
import { DeployError, ErrorCode, UnsupportedOperationError } from '../../utils/errors';
import {
  collectLogEntries,
  errorResponse,
  isValidDockerName,
  jsonResponse,
  parseIntParam,
  resolveApiService,
  withOrchestrator,
} from './_helpers';
import type { ServiceInfo, ServicesListResponse, ServiceActionResponse, LogsResponse } from '../types';

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
    return restartService(decodeURIComponent(restartMatch[1]), url);
  }

  // POST /api/services/:name/stop
  const stopMatch = pathname.match(/^\/api\/services\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return stopService(decodeURIComponent(stopMatch[1]), url);
  }

  // POST /api/services/:name/scale
  const scaleMatch = pathname.match(/^\/api\/services\/([^/]+)\/scale$/);
  if (scaleMatch && method === 'POST') {
    return scaleService(decodeURIComponent(scaleMatch[1]), url, req);
  }

  // POST /api/services/:name/rollback
  const rollbackMatch = pathname.match(/^\/api\/services\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'POST') {
    return rollbackService(decodeURIComponent(rollbackMatch[1]), url);
  }

  // GET /api/services/:name/logs
  const logsMatch = pathname.match(/^\/api\/services\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    return getServiceLogs(decodeURIComponent(logsMatch[1]), url);
  }

  return errorResponse('Endpoint not found', 404);
}

// ---------------------------------------------------------------------------
// Mapping core ServiceInfo -> the API's orchestrator-neutral shape (design-06 8.3)
// ---------------------------------------------------------------------------

const SERVICE_STATE: Record<CoreServiceInfo['state'], ServiceInfo['state']> = {
  running: 'running',
  converging: 'starting',
  degraded: 'error',
  stopped: 'stopped',
};

/** `formatPorts` joined text split back into entries, [] when the service publishes nothing. */
function portsList(info: CoreServiceInfo): string[] {
  const joined = formatPorts(info.ports);
  return joined ? joined.split(', ') : [];
}

function toApiServiceInfo(info: CoreServiceInfo): ServiceInfo {
  return {
    id: info.nativeName,
    name: info.name,
    image: info.image,
    replicas: info.replicas.desired,
    replicasRunning: info.replicas.running,
    state: SERVICE_STATE[info.state],
    ports: portsList(info),
    kind: info.kind,
    role: info.role,
    mode: info.mode,
  };
}

/**
 * List app and accessory services running on the stack
 */
async function listServices(url: URL): Promise<Response> {
  const response = await withOrchestrator(url, async (ctx) => {
    const [appServices, accessoryServices] = await Promise.all([
      ctx.orchestrator.stack.getServices(ctx.appRef),
      ctx.orchestrator.stack.getServices(ctx.accessoryRef),
    ]);
    const services = [...appServices, ...accessoryServices].map(toApiServiceInfo);
    return jsonResponse({
      services,
      stackName: ctx.stackName,
      total: services.length,
    } satisfies ServicesListResponse);
  });

  if (response.status !== 503) return response;
  // The list page polls this route continuously; an unreachable control plane degrades to an
  // empty list with a message instead of an error toast (design-06 8.2).
  const body = (await response.json()) as { error?: string };
  const config = loadConfig({ silent: true });
  return jsonResponse({
    services: [],
    stackName: config?.project_name ?? '',
    total: 0,
    message: body.error ?? 'Orchestrator unavailable.',
  } satisfies ServicesListResponse);
}

/**
 * Restart a service (app or accessory)
 */
async function restartService(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid service name', 400);

  return withOrchestrator(url, async (ctx) => {
    const { ref, service } = await resolveApiService(ctx, name, ['app', 'accessory']);
    await ctx.orchestrator.stack.restart(ref, service.name, { wait: false, timeoutS: 0 });
    return jsonResponse({ success: true, message: `Service ${name} restarted` } satisfies ServiceActionResponse);
  });
}

/**
 * Stop a service. Never `scale(..., 0)`: `stack.stop` records `P/replicas-before-stop`, so
 * `restart` resumes the service at its real replica count instead of guessing 1 (K61).
 */
async function stopService(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid service name', 400);

  return withOrchestrator(url, async (ctx) => {
    const { ref, service } = await resolveApiService(ctx, name, ['app', 'accessory']);
    await ctx.orchestrator.stack.stop(ref, [service.name], { wait: false, timeoutS: 0 });
    const message =
      service.kind === 'helm'
        ? `Helm release ${service.name} was scaled to 0; its next upgrade restores the chart's replica count`
        : `Service ${name} stopped`;
    return jsonResponse({ success: true, message } satisfies ServiceActionResponse);
  });
}

/**
 * Scale a service
 */
async function scaleService(name: string, url: URL, req: Request): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid service name', 400);

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

  return withOrchestrator(url, async (ctx) => {
    const { ref, service } = await resolveApiService(ctx, name, ['app', 'accessory']);
    await ctx.orchestrator.stack.scale(ref, service.name, replicas, { wait: false, timeoutS: 0 });
    return jsonResponse({ success: true, message: `Service ${name} scaled to ${replicas}` } satisfies ServiceActionResponse);
  });
}

/**
 * Rollback a service. App role only: an accessory has no release history (R-12). Takes the deploy
 * lock like the CLI does (design-06 2.8); a deploy already holding it answers 409.
 */
async function rollbackService(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid service name', 400);

  return withOrchestrator(url, async (ctx) => {
    const { ref, service } = await resolveApiService(ctx, name, ['app', 'accessory']);
    if (ref.role !== 'app') {
      throw new UnsupportedOperationError(
        `Service ${service.name} is an accessory; accessories have no release history`,
        'Change accessories.yml and run `dockflow deploy <env> --accessories`.',
      );
    }

    const lock = ctx.orchestrator.lock(ctx.stackName);
    const acquired = await lock.acquire({ message: `Rolling back ${service.name} via WebUI` });
    if (!acquired.success) {
      throw new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED);
    }
    try {
      const { toVersion } = await ctx.orchestrator.stack.rollbackService(ref, service.name, { wait: false, timeoutS: 0 });
      const message = toVersion ? `Service ${name} rolled back to ${toVersion}` : `Service ${name} rolled back`;
      return jsonResponse({ success: true, message } satisfies ServiceActionResponse);
    } finally {
      await lock.release();
    }
  });
}

/**
 * Get logs for a specific service (app or accessory), with real timestamps: both backends fill
 * `LogLine.timestamp` when `timestamps` is set, so the response can be sorted instead of printed
 * in arrival order.
 */
async function getServiceLogs(name: string, url: URL): Promise<Response> {
  if (!isValidDockerName(name)) return errorResponse('Invalid service name', 400);
  const lines = parseIntParam(url.searchParams.get('lines'), 100, 1, 10000);

  return withOrchestrator(url, async (ctx) => {
    const { ref, service } = await resolveApiService(ctx, name, ['app', 'accessory']);
    const entries = await collectLogEntries(ctx.orchestrator.containers, ref, service.name, service.replicas.desired, lines);
    return jsonResponse({ logs: entries, service: service.name, lines: entries.length } satisfies LogsResponse);
  });
}
