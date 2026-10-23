/** Turns the servers of servers.yml into the ones an environment (a tag) deploys to, with CI secrets applied. */

import { loadServersConfig } from '../config';

let _config: ServersConfig | null | undefined;
function getConfig(): ServersConfig | null {
  if (_config === undefined) _config = loadServersConfig({ strict: true });
  return _config;
}
import { parseConnectionString } from '../connection-parser';
import { printWarning } from '../output';
import type {
  ServersConfig,
  ServerConfig,
  ResolvedServer,
  ResolvedDeployment,
  EnvVars,
  SSHKeyConnection,
  ServerRole,
} from '../../types';
import { SERVER_DEFAULTS } from '../../types/servers';
import {
  getCISecret,
  serverNameToEnvKey,
  mergeEnvVars,
  getServerPrivateKey,
  getServerPassword,
  getServerHostKey,
} from './ci-secrets';

/**
 * A CI CONNECTION string wins outright; otherwise each of host, user and port comes from its CI
 * variable, then servers.yml, then the defaults. Null when no host is known.
 */
function resolveConnection(
  env: string,
  serverName: string,
  serverConfig: ServerConfig,
  defaults: { user: string; port: number }
): { host: string; port: number; user: string } | null {
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success) {
      return {
        host: result.data.host,
        port: result.data.port,
        user: result.data.user,
      };
    }
  }

  const host = getCISecret(env, serverName, 'HOST') ?? serverConfig.host;
  const userFromCI = getCISecret(env, serverName, 'USER');
  const portFromCI = getCISecret(env, serverName, 'PORT');

  if (!host) {
    return null;
  }

  return {
    host,
    user: userFromCI ?? serverConfig.user ?? defaults.user,
    port: portFromCI ? parseInt(portFromCI, 10) : (serverConfig.port ?? defaults.port),
  };
}

/** The servers tagged with the environment; one without a host is skipped with a warning. */
export function resolveServersForEnvironment(environment: string): ResolvedServer[] {
  const config = getConfig();
  if (!config) {
    return [];
  }

  const defaults = {
    user: config.defaults?.user ?? SERVER_DEFAULTS.user,
    port: config.defaults?.port ?? SERVER_DEFAULTS.port,
  };

  const resolvedServers: ResolvedServer[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    if (!serverConfig.tags.includes(environment)) {
      continue;
    }

    const connection = resolveConnection(environment, serverName, serverConfig, defaults);
    if (!connection) {
      printWarning(`Server "${serverName}" has no host configured and no CI secret found.`);
      printWarning(`  Expected CI secret: ${environment.toUpperCase()}_${serverNameToEnvKey(serverName)}_CONNECTION`);
      printWarning(`  See: https://dockflow.shawiizz.dev/getting-started#copy-ci-config-file`);
      continue;
    }

    const envVars = mergeEnvVars(config, environment, serverName, serverConfig.env);

    resolvedServers.push({
      name: serverName,
      role: serverConfig.role ?? 'manager',
      host: connection.host,
      port: connection.port,
      user: connection.user,
      privateHost: serverConfig.private_host,
      hostKey: getServerHostKey(environment, serverName),
      env: envVars,
      tags: serverConfig.tags,
    });
  }

  return resolvedServers;
}

/** Null when the server is unknown, lacks the tag, or has no host. */
export function resolveServerByName(serverName: string, environment: string): ResolvedServer | null {
  const config = getConfig();
  if (!config) {
    return null;
  }

  const serverConfig = config.servers[serverName];
  if (!serverConfig) {
    return null;
  }

  if (!serverConfig.tags.includes(environment)) {
    return null;
  }

  const defaults = {
    user: config.defaults?.user ?? SERVER_DEFAULTS.user,
    port: config.defaults?.port ?? SERVER_DEFAULTS.port,
  };

  const connection = resolveConnection(environment, serverName, serverConfig, defaults);
  if (!connection) {
    return null;
  }

  const envVars = mergeEnvVars(config, environment, serverName, serverConfig.env);

  return {
    name: serverName,
    role: serverConfig.role ?? 'manager',
    host: connection.host,
    port: connection.port,
    user: connection.user,
    privateHost: serverConfig.private_host,
    hostKey: getServerHostKey(environment, serverName),
    env: envVars,
    tags: serverConfig.tags,
  };
}

export function getManagersForEnvironment(environment: string): ResolvedServer[] {
  const servers = resolveServersForEnvironment(environment);
  return servers.filter(s => s.role === 'manager');
}

export function getWorkersForEnvironment(environment: string): ResolvedServer[] {
  const servers = resolveServersForEnvironment(environment);
  return servers.filter(s => s.role === 'worker');
}

/**
 * The managers and workers of an environment, or null when it has no manager. `manager` is the
 * first one listed; findActiveManager picks another when it is down.
 */
export function resolveDeploymentForEnvironment(environment: string): ResolvedDeployment | null {
  const managers = getManagersForEnvironment(environment);
  if (managers.length === 0) {
    return null;
  }

  const workers = getWorkersForEnvironment(environment);

  return {
    manager: managers[0],
    managers,
    workers,
    environment,
  };
}

/** Every tag used in servers.yml, sorted. */
export function getAvailableEnvironments(): string[] {
  const config = getConfig();
  if (!config) {
    return [];
  }

  const tags = new Set<string>();
  for (const serverConfig of Object.values(config.servers)) {
    for (const tag of serverConfig.tags) {
      tags.add(tag);
    }
  }

  return Array.from(tags).sort();
}

export function getServerNamesForEnvironment(environment: string): string[] {
  const config = getConfig();
  if (!config) {
    return [];
  }

  return Object.entries(config.servers)
    .filter(([_, serverConfig]) => serverConfig.tags.includes(environment))
    .map(([name]) => name);
}

/** The server's connection with its private key; null when the server or its key cannot be resolved. */
export function getFullConnectionInfo(env: string, serverName: string): SSHKeyConnection | null {
  const server = resolveServerByName(serverName, env);
  if (!server) {
    return null;
  }

  const privateKey = getServerPrivateKey(env, serverName);
  if (!privateKey) {
    return null;
  }

  const password = getServerPassword(env, serverName);

  return {
    host: server.host,
    port: server.port,
    user: server.user,
    privateKey,
    password,
    hostKey: server.hostKey,
  };
}

/**
 * Connections to every node of the environment, managers first, for reading data that is
 * replicated on all of them (history, metrics). Nodes without SSH credentials are skipped.
 */
export function getAllNodeConnections(environment: string): SSHKeyConnection[] {
  return getAllNodes(environment).map((node) => node.connection);
}

export interface EnvNode {
  /** the server's name in servers.yml */
  name: string;
  role: ServerRole;
  connection: SSHKeyConnection;
}

/** Every node of the environment this machine can reach, managers first. */
export function getAllNodes(environment: string): EnvNode[] {
  const servers = resolveServersForEnvironment(environment);
  const sorted = [
    ...servers.filter(s => s.role === 'manager'),
    ...servers.filter(s => s.role === 'worker'),
  ];

  const nodes: EnvNode[] = [];
  for (const server of sorted) {
    const connection = getFullConnectionInfo(environment, server.name);
    if (connection) nodes.push({ name: server.name, role: server.role, connection });
  }
  return nodes;
}

/**
 * The variables of the first server tagged with the environment, for builds that need no SSH.
 * With no such server, only `env.all` and `env.<environment>` apply.
 */
export function getEnvVarsForEnvironment(environment: string): EnvVars {
  const config = getConfig();
  if (!config) {
    return {};
  }

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.tags.includes(environment)) {
      return mergeEnvVars(config, environment, serverName, serverConfig.env);
    }
  }

  const result: EnvVars = {};

  if (config.env?.all) {
    Object.assign(result, config.env.all);
  }

  if (config.env?.[environment]) {
    Object.assign(result, config.env[environment]);
  }

  return result;
}
