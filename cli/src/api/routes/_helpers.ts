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

export { getAllNodeConnections };

/** Docker service/stack/container names: alphanumeric, underscore, hyphen and dot, starting with an alphanumeric. */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Whether a Docker resource name (service, stack, container, accessory) is safe to interpolate
 * into a shell command: non-empty and free of shell metacharacters.
 */
export function isValidDockerName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && DOCKER_NAME_RE.test(name);
}

export interface ManagerConnection extends SSHKeyConnection {
  /** `<project>-<env>`, the name of the app stack on the cluster */
  stackName: string;
}

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

  const connection = getFullConnectionInfo(env, manager.name);
  return connection && { ...connection, stackName: getStackName(env) ?? '' };
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

/** The requested environment, else the first configured one; null when there is none. */
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
