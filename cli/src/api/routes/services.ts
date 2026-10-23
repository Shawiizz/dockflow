/** Routes for the Swarm services of an environment: list, logs, restart, stop, scale and rollback. */

import { jsonResponse, errorResponse } from '../server';
import { getAccessoriesStackName, getStackName, loadConfig } from '../../utils/config';
import { getAvailableEnvironments } from '../../utils/servers';
import { sh, sshExec, type ShellCommand } from '../../utils/ssh';
import { arrangeLogLines, parseDockerLogLines } from '../../utils/docker-logs';
import type { SSHExecResult } from '../../types';
import { createEnvLock, type Lock } from '../../services/lock';
import { ErrorCode } from '../../utils/errors';
import {
  getApiStacks,
  getManagerConnection,
  isValidDockerName,
  parseIntParam,
  type ResolvedService,
  resolveApiService,
  resolveEnvironment,
} from './_helpers';
import type { ManagerConnection } from './_helpers';
import type {
  ServiceInfo,
  ServicesListResponse,
  ServiceActionResponse,
  LogEntry,
  LogsResponse,
} from '../types';

export async function handleServicesRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/services' && method === 'GET') {
    return listServices(url);
  }

  const restartMatch = pathname.match(/^\/api\/services\/([^/]+)\/restart$/);
  if (restartMatch && method === 'POST') {
    return restartService(restartMatch[1], url);
  }

  const stopMatch = pathname.match(/^\/api\/services\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return stopService(stopMatch[1], url);
  }

  const scaleMatch = pathname.match(/^\/api\/services\/([^/]+)\/scale$/);
  if (scaleMatch && method === 'POST') {
    return scaleService(scaleMatch[1], url, req);
  }

  const rollbackMatch = pathname.match(/^\/api\/services\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'POST') {
    return rollbackService(rollbackMatch[1], url);
  }

  const logsMatch = pathname.match(/^\/api\/services\/([^/]+)\/logs$/);
  if (logsMatch && method === 'GET') {
    return getServiceLogs(logsMatch[1], url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * State of a service from the replicas column of `docker service ls` ("1/2", "0/1 (1/1 completed)").
 *
 * A count below the wanted one is ambiguous from this table alone: it is the normal, transient
 * shape of a service that is still converging as much as the shape of a crash-looping one, and
 * that includes 0/N. It is provisionally 'starting'; `resolvePartialStates` inspects the tasks to
 * tell the two apart. A job has no running tasks once it completed, which is not a failure.
 */
export function stateFromReplicas(replicas: string, mode = ''): { running: number; total: number; state: ServiceInfo['state'] } {
  const match = replicas.match(/^(\d+)\/(\d+)/);
  if (!match) return { running: 0, total: 0, state: 'unknown' };

  const running = Number(match[1]);
  const total = Number(match[2]);
  if (mode.endsWith('-job')) return { running, total, state: running > 0 ? 'running' : 'stopped' };
  if (total === 0) return { running, total, state: 'stopped' };
  return { running, total, state: running === total ? 'running' : 'starting' };
}

/** Parse `docker service ls` output into ServiceInfo objects. */
export function parseServiceLs(output: string, stackName: string, role?: ServiceInfo['role']): ServiceInfo[] {
  const lines = output.trim().split('\n');
  if (lines.length <= 1) return []; // header only

  return lines.slice(1).map((line) => {
    const parts = line.split(/\s{2,}/);
    const id = parts[0] || '';
    const name = parts[1] || '';
    const mode = parts[2] || '';
    const image = parts[4] || '';
    const portsStr = parts[5] || '';

    const { running, total, state } = stateFromReplicas(parts[3] || '0/0', mode);

    return {
      id,
      name,
      image,
      replicas: total,
      replicasRunning: running,
      state,
      ports: portsStr ? portsStr.split(',').map((p: string) => p.trim()) : [],
      service: name.startsWith(`${stackName}_`) ? name.slice(stackName.length + 1) : name,
      mode: mode || undefined,
      role,
    };
  });
}

/** Task states that mean the task is never coming up on its own — a real failure, not convergence. */
const FAILED_TASK_STATE_PREFIXES = ['failed', 'rejected'];

/**
 * Classify a task's `{{.CurrentState}}` string ("Running 3 seconds ago", "Pending 4 seconds
 * ago", "Failed 2 seconds ago") as a failure or normal convergence progress.
 */
export function classifyTaskState(currentState: string): 'failed' | 'converging' {
  const normalized = currentState.trim().toLowerCase();
  return FAILED_TASK_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ? 'failed'
    : 'converging';
}

/**
 * Resolve services provisionally marked 'starting' by parseServiceLs into either
 * 'starting' (still converging, no failed tasks) or 'error' (a task has actually
 * failed/been rejected) — mutates the passed-in services in place.
 */
export async function resolvePartialStates(
  conn: ManagerConnection,
  services: { name: string; state: ServiceInfo['state'] }[],
  exec: (conn: ManagerConnection, command: ShellCommand) => Promise<SSHExecResult> = sshExec,
): Promise<void> {
  const partial = services.filter((s) => s.state === 'starting');
  if (partial.length === 0) return;

  await Promise.all(
    partial.map(async (service) => {
      const result = await exec(
        conn,
        sh`docker service ps ${service.name} --filter 'desired-state=running' --format '{{.CurrentState}}' --no-trunc 2>/dev/null`,
      );
      const taskStates = result.stdout.trim().split('\n').filter(Boolean);
      const hasFailure = taskStates.some((state) => classifyTaskState(state) === 'failed');
      service.state = hasFailure ? 'error' : 'starting';
    }),
  );
}

/**
 * `docker service ls` for the services of one stack. The label matches the stack exactly,
 * where `--filter name=` is a prefix match that also lists other environments and the accessories.
 */
export function serviceListCommand(stackName: string): ShellCommand {
  return sh`docker service ls --filter ${`label=com.docker.stack.namespace=${stackName}`} --format "table {{.ID}}  {{.Name}}  {{.Mode}}  {{.Replicas}}  {{.Image}}  {{.Ports}}"`;
}

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

  const environments = getAvailableEnvironments();
  const env = envFilter || environments[0];

  if (!env) return errorResponse('No environments configured', 404);

  const stackName = getStackName(env) ?? config.project_name;
  const accessoriesStackName = getAccessoriesStackName(env) ?? `${stackName}-accessories`;

  const conn = await getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const listed = await Promise.all(
      [stackName, accessoriesStackName].map((stack) => sshExec(conn, serviceListCommand(stack))),
    );

    const failed = listed.find((result) => result.exitCode !== 0);
    if (failed) return errorResponse(failed.stderr.trim() || 'Failed to list services', 502);

    const services = [
      ...parseServiceLs(listed[0].stdout, stackName, 'app'),
      ...parseServiceLs(listed[1].stdout, accessoriesStackName, 'accessory'),
    ];
    await resolvePartialStates(conn, services);

    return jsonResponse({
      services,
      stackName,
      total: services.length,
    } satisfies ServicesListResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to list services', 500);
  }
}

async function restartService(serviceName: string, url: URL): Promise<Response> {
  if (!isValidDockerName(serviceName)) return errorResponse('Invalid service name', 400);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = await getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const target = await resolveRequestedService(conn, env, serviceName);
    if (!target) return errorResponse(`Service ${serviceName} not found`, 404);
    const result = await sshExec(conn, sh`docker service update --force --detach ${target.name}`);
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

async function stopService(serviceName: string, url: URL): Promise<Response> {
  if (!isValidDockerName(serviceName)) return errorResponse('Invalid service name', 400);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = await getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const target = await resolveRequestedService(conn, env, serviceName);
    if (!target) return errorResponse(`Service ${serviceName} not found`, 404);
    const result = await sshExec(conn, sh`docker service scale --detach ${target.name}=0`);
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

async function scaleService(serviceName: string, url: URL, req: Request): Promise<Response> {
  if (!isValidDockerName(serviceName)) return errorResponse('Invalid service name', 400);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = await getManagerConnection(env);
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
    const target = await resolveRequestedService(conn, env, serviceName);
    if (!target) return errorResponse(`Service ${serviceName} not found`, 404);
    const result = await sshExec(conn, sh`docker service scale --detach ${target.name}=${replicas}`);
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

/** The service a request names, in the app or accessories stack of the environment. */
async function resolveRequestedService(conn: ManagerConnection, env: string, raw: string): Promise<ResolvedService | null> {
  const stacks = getApiStacks(env);
  if (!stacks) return null;
  return resolveApiService(raw, stacks, async (name) => {
    const result = await sshExec(conn, sh`docker service inspect ${name} --format '{{.ID}}'`);
    return result.exitCode === 0;
  });
}

type ApiLock = Pick<Lock, 'acquire' | 'release'>;

/** Runs `run` while holding the deploy lock; a lock held by a deploy answers 409 without running it. */
export async function withDeployLock(lock: ApiLock, message: string, run: () => Promise<Response>): Promise<Response> {
  const acquired = await lock.acquire({ message });
  if (!acquired.success) {
    const status = acquired.error.code === ErrorCode.DEPLOY_LOCKED ? 409 : 500;
    return jsonResponse({ success: false, message: acquired.error.message, error: acquired.error.message } satisfies ServiceActionResponse, status);
  }
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

/**
 * Rollback a Docker service. Takes the deploy lock like a deploy does, and refuses accessories,
 * which have no release history.
 */
async function rollbackService(serviceName: string, url: URL): Promise<Response> {
  if (!isValidDockerName(serviceName)) return errorResponse('Invalid service name', 400);
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = await getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    const target = await resolveRequestedService(conn, env, serviceName);
    if (!target) return errorResponse(`Service ${serviceName} not found`, 404);

    if (target.role === 'accessory') {
      const message = `${target.service} is an accessory; accessories have no release history. Change accessories.yml and deploy with --accessories.`;
      return jsonResponse({ success: false, message, error: message } satisfies ServiceActionResponse, 501);
    }

    const staleThreshold = loadConfig({ silent: true })?.lock?.stale_threshold_minutes;
    const lock = await createEnvLock(env, conn.stackName, staleThreshold);
    return await withDeployLock(lock, `Rolling back ${target.service} via WebUI`, async () => {
      const result = await sshExec(conn, sh`docker service rollback --detach ${target.name}`);
      const success = result.exitCode === 0;
      return jsonResponse({
        success,
        message: success ? `Service ${serviceName} rolled back` : (result.stderr.trim() || 'Failed to rollback service'),
        output: result.stdout.trim() || undefined,
      } satisfies ServiceActionResponse);
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to rollback service', 500);
  }
}

export function serviceLogsCommand(nativeName: string, lines: number): ShellCommand {
  // stderr of the containers reaches docker's own stderr: merged, so a docker failure is told by the exit status
  return sh`docker service logs --tail ${lines} --timestamps --no-trunc ${nativeName} 2>&1`;
}

/** Log entries of a Swarm service, or the failure to answer with. */
export async function readServiceLogs(
  conn: ManagerConnection,
  stackName: string,
  nativeName: string,
  service: string,
  lines: number,
  exec: (conn: ManagerConnection, command: ShellCommand) => Promise<SSHExecResult> = sshExec,
): Promise<{ logs: LogEntry[] } | { error: string; status: number }> {
  const result = await exec(conn, serviceLogsCommand(nativeName, lines));
  if (result.exitCode !== 0) {
    const reason = result.stdout.trim().split('\n')[0] || result.stderr.trim() || 'Failed to get logs';
    return /no such service/i.test(reason) ? { error: `Service ${service} not found`, status: 404 } : { error: reason, status: 500 };
  }
  return { logs: arrangeLogLines(parseDockerLogLines(result.stdout, service), stackName) };
}

async function getServiceLogs(serviceName: string, url: URL): Promise<Response> {
  if (!isValidDockerName(serviceName)) return errorResponse('Invalid service name', 400);
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

  try {
    const target = await resolveRequestedService(conn, env, serviceName);
    const stacks = getApiStacks(env);
    if (!target || !stacks) return errorResponse(`Service ${serviceName} not found`, 404);

    const read = await readServiceLogs(conn, target.role === 'app' ? stacks.app : stacks.accessories, target.name, target.service, lines);
    if ('error' in read) return errorResponse(read.error, read.status);

    return jsonResponse({
      logs: read.logs,
      service: target.service,
      lines: read.logs.length,
    } satisfies LogsResponse);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get logs',
      500,
    );
  }
}
