/**
 * Shared API route helpers
 */

import { loadConfig } from '../../utils/config';
import {
  resolveServersForEnvironment,
  getAvailableEnvironments,
  getServerPrivateKey,
} from '../../utils/servers';
import { DEFAULT_SSH_PORT } from '../../constants';

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
