/**
 * Shared API route helpers
 */

import { getAccessoriesStackName, getStackName } from '../../utils/config';
import {
  getAvailableEnvironments,
  getFullConnectionInfo,
  getServerPrivateKey,
  resolveServersForEnvironment,
  getAllNodeConnections,
  findActiveManager,
} from '../../utils/servers';
import type { SSHKeyConnection } from '../../types';
import type { ServerRole } from '../types';
import { DEFAULT_SSH_PORT } from '../../constants';

export { getAllNodeConnections };

/**
 * Docker name validation regex.
 * Docker service/stack/container names: alphanumeric, underscores, hyphens, dots.
 * Must start with alphanumeric.
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

export interface ManagerConnection {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  /** `<project>-<env>`, the name of the app stack on the cluster */
  stackName: string;
}

/**
 * Get SSH connection to manager server for a given environment.
 * Returns null if no manager or credentials found.
 */
/** The manager chosen per environment, reused for a while: the UI polls, a probe per request would be slow. */
const chosenManagers = new Map<string, { name: string; until: number }>();
const MANAGER_CHOICE_TTL_MS = 30_000;

/**
 * The manager the routes talk to: with several, the leader or else the first that takes Swarm
 * commands, so one manager down does not take the API down with it.
 */
export async function getManagerConnection(env: string): Promise<ManagerConnection | null> {
  const managers = resolveServersForEnvironment(env).filter((s) => s.role === 'manager' && getServerPrivateKey(env, s.name));
  if (managers.length === 0) return null;

  let manager = managers[0];
  if (managers.length > 1) {
    const cached = chosenManagers.get(env);
    const known = cached && cached.until > Date.now() ? managers.find((m) => m.name === cached.name) : undefined;
    if (known) {
      manager = known;
    } else {
      const active = await findActiveManager(env, managers);
      if (active) {
        manager = active.manager;
        chosenManagers.set(env, { name: manager.name, until: Date.now() + MANAGER_CHOICE_TTL_MS });
      }
    }
  }

  return {
    host: manager.host,
    port: manager.port || DEFAULT_SSH_PORT,
    user: manager.user,
    privateKey: getServerPrivateKey(env, manager.name)!,
    stackName: getStackName(env) ?? '',
  };
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

/** Rejects with `message` when `promise` has not settled after `ms`; the timer never keeps the process alive. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiNode {
  name: string;
  role: ServerRole;
  connection: SSHKeyConnection;
}

/** The servers of an environment that have credentials, managers first. */
export function getApiNodes(env: string): ApiNode[] {
  const servers = resolveServersForEnvironment(env);
  const ordered = [...servers.filter((s) => s.role === 'manager'), ...servers.filter((s) => s.role === 'worker')];
  const nodes: ApiNode[] = [];
  for (const server of ordered) {
    const connection = getFullConnectionInfo(env, server.name);
    if (connection) nodes.push({ name: server.name, role: server.role, connection });
  }
  return nodes;
}

export type NodeOutcome<T> =
  | { node: ApiNode; ok: true; value: T }
  | { node: ApiNode; ok: false; error: string };

/** Runs `run` on every node at once; a node that fails is an outcome, not an exception. */
export async function onEveryNode<T>(nodes: ApiNode[], run: (node: ApiNode) => Promise<T>): Promise<NodeOutcome<T>[]> {
  return Promise.all(
    nodes.map(async (node): Promise<NodeOutcome<T>> => {
      try {
        return { node, ok: true, value: await run(node) };
      } catch (error) {
        return { node, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

export interface ApiStacks {
  app: string;
  accessories: string;
}

/** The app stack and the accessories stack of an environment; null without a project name. */
export function getApiStacks(env: string): ApiStacks | null {
  const app = getStackName(env);
  const accessories = getAccessoriesStackName(env);
  return app && accessories ? { app, accessories } : null;
}

export interface ResolvedService {
  /** Swarm service name, `<stack>_<service>` */
  name: string;
  /** name in the compose file */
  service: string;
  role: 'app' | 'accessory';
}

/**
 * A service named in a request: the native Swarm name, or the compose name, which is looked up in
 * the app stack and then in the accessories stack. Null when no such service exists.
 */
export async function resolveApiService(
  raw: string,
  stacks: ApiStacks,
  exists: (nativeName: string) => Promise<boolean>,
): Promise<ResolvedService | null> {
  if (raw.startsWith(`${stacks.accessories}_`)) {
    return { name: raw, service: raw.slice(stacks.accessories.length + 1), role: 'accessory' };
  }
  if (raw.startsWith(`${stacks.app}_`)) {
    return { name: raw, service: raw.slice(stacks.app.length + 1), role: 'app' };
  }
  for (const [role, stack] of [['app', stacks.app], ['accessory', stacks.accessories]] as const) {
    const name = `${stack}_${raw}`;
    if (await exists(name)) return { name, service: raw, role };
  }
  return null;
}
