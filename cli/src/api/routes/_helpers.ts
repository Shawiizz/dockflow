/**
 * Shared API route helpers (design-06 8.1). `getManagerConnection`/`ManagerConnection` are gone:
 * every route that talks to a deployed stack now goes through `withOrchestrator`, which resolves
 * one bundle per request instead of a raw SSH connection (the old `stackName = project_name` bug —
 * every route below `target.stackName`, never `config.project_name` alone).
 */

import type { DockflowConfig } from '../../utils/config';
import { getAvailableEnvironments, getAllNodeConnections } from '../../utils/servers';
import { openOrchestrator } from '../../services/orchestrator/factory';
import { timestampKey } from '../../services/orchestrator/kubernetes/status/logs';
import type { LogLine, LogSink, Orchestrator, ServiceInfo, StackRef, StackRole } from '../../services/orchestrator/interfaces';
import { CLIError, ConfigError, ConnectionError, ErrorCode, OrchestratorUnavailableError, UnsupportedOperationError } from '../../utils/errors';
import type { LogEntry } from '../types';

export { getAllNodeConnections };

/**
 * `jsonResponse`/`errorResponse` are defined here rather than imported from `../server`: that
 * module pulls in `routes/index.ts`, which imports every route, including `servers.ts`,
 * `resources.ts`, `metrics.ts` and `backup.ts` — still the pre-rewrite files, owned by the
 * remaining-routes package that has not run yet (it depends on this package). Those files still
 * reference symbols this rewrite removed (`getManagerConnection`, `checkManagerStatus`), so loading
 * `../server` throws at link time instead of the tsc-only diagnostic GATE-UNIT expects for
 * not-yet-merged dependents. Same behaviour as `server.ts`'s copies, kept local so this package's
 * own routes and tests never load that graph.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Docker name validation regex.
 * Docker service/stack/container names: alphanumeric, underscores, hyphens, dots.
 * Must start with alphanumeric. Kept as is (design-06 8.1): compose names, Swarm full names
 * (`<stack>_<svc>`) and Kubernetes object names all match it.
 */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Validate a Docker resource name (service, stack, container, accessory).
 * Returns true if the name is safe to interpolate into shell commands.
 * Rejects empty strings and anything with shell metacharacters.
 */
export function isValidDockerName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && DOCKER_NAME_RE.test(name);
}

/**
 * Parse an integer query parameter, clamped to [min, max]. Returns `fallback`
 * when the value is missing or not a number, so a bogus `?lines=abc` can never
 * reach a shell command as e.g. `--tail NaN`.
 */
export function parseIntParam(raw: string | null, fallback: number, min = 1, max = 100_000): number {
  const parsed = parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Resolve the default environment (from query param or first available)
 */
export function resolveEnvironment(envFilter: string | null): string | null {
  if (envFilter) return envFilter;
  const environments = getAvailableEnvironments();
  return environments[0] || null;
}

// ---------------------------------------------------------------------------
// Orchestrator context (DESIGN-CORE 6.4, design-06 8.1)
// ---------------------------------------------------------------------------

export interface ApiContext {
  env: string;
  config: DockflowConfig;
  orchestrator: Orchestrator;
  stackName: string;
  appRef: StackRef;
  accessoryRef: StackRef;
}

/** The API server is long-lived: resolving a control plane through several managers costs a probe. */
const API_TARGET_CACHE_MS = 30_000;

interface CachedTarget {
  server: string;
  at: number;
}

const targetCache = new Map<string, CachedTarget>();

let opener: typeof openOrchestrator = openOrchestrator;

/** tests only */
export function __setOrchestratorOpenerForTests(nextOpener: typeof openOrchestrator | null): void {
  opener = nextOpener ?? openOrchestrator;
  targetCache.clear();
}

/**
 * resolveEnvironment(env query) -> openOrchestrator -> handler; every thrown error goes through
 * apiErrorResponse. Caches the resolved control plane per env for `API_TARGET_CACHE_MS` by passing
 * it as `server` to `openOrchestrator` (no probe, target.ts step 2); an `OrchestratorUnavailableError`
 * or `ConnectionError` evicts the entry so the next request probes again.
 */
export async function withOrchestrator(url: URL, handler: (ctx: ApiContext) => Promise<Response>): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) {
    return apiErrorResponse(new CLIError('No environments configured', ErrorCode.ENV_NOT_FOUND, 'Add servers to servers.yml.'));
  }

  const cached = targetCache.get(env);
  const server = cached && Date.now() - cached.at < API_TARGET_CACHE_MS ? cached.server : undefined;

  try {
    const { config, orchestrator } = await opener(env, { server });
    targetCache.set(env, { server: orchestrator.target.controlPlane.name, at: Date.now() });
    const ctx: ApiContext = {
      env,
      config,
      orchestrator,
      stackName: orchestrator.target.stackName,
      appRef: { project: orchestrator.target.project, env, role: 'app' },
      accessoryRef: { project: orchestrator.target.project, env, role: 'accessory' },
    };
    return await handler(ctx);
  } catch (error) {
    if (error instanceof OrchestratorUnavailableError || error instanceof ConnectionError) {
      targetCache.delete(env);
    }
    return apiErrorResponse(error);
  }
}

/**
 * Name -> {ref, service}: app role first, then accessory role (the order `roles` is given in);
 * matches the compose name, the native name, or a legacy `<scope>_` prefixed Swarm name. 404 when
 * nothing matches any of the given roles.
 */
export async function resolveApiService(
  ctx: ApiContext,
  raw: string,
  roles: StackRole[],
): Promise<{ ref: StackRef; service: ServiceInfo }> {
  for (const role of roles) {
    const ref = role === 'app' ? ctx.appRef : ctx.accessoryRef;
    const services = await ctx.orchestrator.stack.getServices(ref);
    const prefix = `${ctx.orchestrator.naming.scope(ref)}_`;
    const stripped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    const found = services.find((service) => service.name === raw || service.nativeName === raw || service.name === stripped);
    if (found) return { ref, service: found };
  }
  throw new CLIError(`Service ${raw} not found`, ErrorCode.SERVICE_NOT_FOUND, 'Check what is deployed with `dockflow status <env>`.');
}

function compareLogEntries(a: LogEntry, b: LogEntry): number {
  const ka = timestampKey(a.timestamp);
  const kb = timestampKey(b.timestamp);
  if (!ka || !kb) return 0;
  return ka[0] - kb[0] || ka[1] - kb[1];
}

/**
 * Runs `containers.streamLogs` non-following and collects every line and sink warning into a
 * sorted, timestamped API log entry (design-06 8.2): both backends fill `LogLine.timestamp` when
 * `timestamps` is set, so entries can be sorted instead of printed in arrival order. Past one
 * replica, `service` becomes the instance label so lines from different pods/tasks of the same
 * compose service stay distinguishable.
 */
export async function collectLogEntries(
  containers: Pick<Orchestrator['containers'], 'streamLogs'>,
  ref: StackRef,
  service: string,
  desiredReplicas: number,
  lines: number,
): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  const nowIso = new Date().toISOString();
  const sink: LogSink = {
    line: (line: LogLine) => {
      entries.push({ timestamp: line.timestamp ?? nowIso, message: line.text, service: desiredReplicas > 1 ? line.instance : service });
    },
    warn: (message: string) => {
      entries.push({ timestamp: nowIso, message, service: 'dockflow' });
    },
  };
  await containers.streamLogs(ref, service, { follow: false, tail: lines, timestamps: true, includeTerminated: true }, sink);
  entries.sort(compareLogEntries);
  return entries;
}

const NOT_FOUND_CODES = new Set<ErrorCode>([
  ErrorCode.NO_SERVERS_FOR_ENV,
  ErrorCode.ENV_NOT_FOUND,
  ErrorCode.STACK_NOT_FOUND,
  ErrorCode.SERVICE_NOT_FOUND,
  ErrorCode.CONTAINER_NOT_FOUND,
  ErrorCode.BACKUP_NOT_FOUND,
  ErrorCode.BACKUP_CONFIG_MISSING,
  ErrorCode.SSH_KEY_NOT_FOUND,
]);

/** DESIGN-CORE 6.2, design-06 8.1: one place turning every error a route can throw into a Response. */
export function apiErrorResponse(error: unknown): Response {
  if (error instanceof UnsupportedOperationError) {
    return jsonResponse({ success: false, error: error.message, message: error.message, suggestion: error.suggestion }, 501);
  }
  if (error instanceof ConfigError) {
    return jsonResponse({ error: error.message, suggestion: error.suggestion }, 404);
  }
  if (error instanceof OrchestratorUnavailableError || error instanceof ConnectionError) {
    return jsonResponse({ error: error.message, suggestion: error.suggestion }, 503);
  }
  if (error instanceof CLIError) {
    if (error.code === ErrorCode.DEPLOY_LOCKED) {
      return jsonResponse({ success: false, message: error.message }, 409);
    }
    if (error.code === ErrorCode.VALIDATION_FAILED || error.code === ErrorCode.INVALID_ARGUMENT) {
      return jsonResponse({ error: error.message, suggestion: error.suggestion }, 400);
    }
    if (NOT_FOUND_CODES.has(error.code)) {
      return jsonResponse({ error: error.message, suggestion: error.suggestion }, 404);
    }
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
}
