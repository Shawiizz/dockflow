/**
 * Shared API route helpers
 */

import { loadConfig } from '../../utils/config';
import {
  getAvailableEnvironments,
  getServerPrivateKey,
  resolveServersForEnvironment,
  getAllNodeConnections,
} from '../../utils/servers';
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
  stackName: string;
}

/**
 * Get SSH connection to manager server for a given environment.
 * Returns null if no manager or credentials found.
 */
export function getManagerConnection(env: string): ManagerConnection | null {
  const servers = resolveServersForEnvironment(env);
  const manager = servers.find((s) => s.role === 'manager');
  if (!manager) return null;

  const privateKey = getServerPrivateKey(env, manager.name);
  if (!privateKey) return null;

  return {
    host: manager.host,
    port: manager.port || DEFAULT_SSH_PORT,
    user: manager.user,
    privateKey,
    stackName: loadConfig({ silent: true })?.project_name || '',
  };
}

/**
 * Resolve the default environment (from query param or first available)
 */
export function resolveEnvironment(envFilter: string | null): string | null {
  if (envFilter) return envFilter;
  const environments = getAvailableEnvironments();
  return environments[0] || null;
}
