/**
 * Reads server credentials and overrides from CI environment variables, named
 * `<ENV>_<SERVER>_<VAR>` (such as PRODUCTION_MAIN_HOST) or `<ENV>_<VAR>` for every server.
 */

import { parseConnectionString } from '../connection-parser';
import { isHostKeyFingerprint } from '../host-key';
import { ConfigError } from '../errors';
import type { ServersConfig, EnvVars } from '../../types';

/** `main_server` -> `MAIN_SERVER`, as it appears in a CI variable name. */
export function serverNameToEnvKey(name: string): string {
  return name.toUpperCase();
}

/**
 * `<ENV>_<SERVER>_<VAR>` when it is set and not empty, else `<ENV>_<VAR>`. A null server name
 * reads only the shared one.
 */
export function getCISecret(env: string, serverName: string | null, varName: string): string | undefined {
  const envUpper = env.toUpperCase();
  const serverKey = serverName ? serverNameToEnvKey(serverName) : null;

  if (serverKey) {
    const keyName = `${envUpper}_${serverKey}_${varName}`;
    const serverSpecific = process.env[keyName];
    if (serverSpecific !== undefined && serverSpecific !== '') {
      return serverSpecific;
    }
  }

  return process.env[`${envUpper}_${varName}`];
}

/** The key of the CONNECTION string when it parses, else the SSH_PRIVATE_KEY secret. */
export function getServerPrivateKey(env: string, serverName: string): string | undefined {
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success) {
      return result.data.privateKey;
    }
  }

  return getCISecret(env, serverName, 'SSH_PRIVATE_KEY');
}

/** The sudo password of the CONNECTION string when it parses, else the PASSWORD secret. */
export function getServerPassword(env: string, serverName: string): string | undefined {
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success) {
      return result.data.password;
    }
  }

  return getCISecret(env, serverName, 'PASSWORD');
}

/**
 * The pinned host key fingerprint: the CONNECTION string's hostKey, else the HOST_KEY secret.
 * Undefined means the server is not pinned; a HOST_KEY that is no fingerprint throws.
 */
export function getServerHostKey(env: string, serverName: string): string | undefined {
  const connectionString = getCISecret(env, serverName, 'CONNECTION');
  if (connectionString) {
    const result = parseConnectionString(connectionString);
    if (result.success && result.data.hostKey) {
      return result.data.hostKey;
    }
  }

  const hostKey = getCISecret(env, serverName, 'HOST_KEY');
  if (hostKey === undefined) return undefined;
  if (!isHostKeyFingerprint(hostKey)) {
    throw new ConfigError(
      `${env.toUpperCase()}_${serverNameToEnvKey(serverName)}_HOST_KEY is not a host key fingerprint`,
      'Use the SHA256:<base64> form that `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the server.',
    );
  }
  return hostKey;
}

/**
 * Layers a server's variables: `env.all`, `env.<tag>`, the server's own `env`, then the CI
 * variables `<ENV>_<VAR>` and `<ENV>_<SERVER>_<VAR>`, each layer overriding the one before.
 * Connection settings (host, user, key, password...) are never taken as variables.
 */
export function mergeEnvVars(
  config: ServersConfig,
  tag: string,
  serverName: string,
  serverEnv: EnvVars | undefined
): EnvVars {
  const result: EnvVars = {};

  if (config.env?.all) {
    Object.assign(result, config.env.all);
  }

  if (config.env?.[tag]) {
    Object.assign(result, config.env[tag]);
  }

  if (serverEnv) {
    Object.assign(result, serverEnv);
  }

  const envUpper = tag.toUpperCase();
  const serverKey = serverNameToEnvKey(serverName);

  const connectionSettings = ['CONNECTION', 'HOST', 'USER', 'PORT', 'SSH_PRIVATE_KEY', 'PASSWORD', 'HOST_KEY'];
  const globalVars: EnvVars = {};
  const serverVars: EnvVars = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const serverMatch = key.match(new RegExp(`^${envUpper}_${serverKey}_([A-Z][A-Z0-9_]*)$`));
    if (serverMatch) {
      if (!connectionSettings.includes(serverMatch[1])) serverVars[serverMatch[1]] = value;
      continue;
    }
    const globalMatch = key.match(new RegExp(`^${envUpper}_([A-Z][A-Z0-9_]*)$`));
    if (globalMatch && !connectionSettings.includes(globalMatch[1])) globalVars[globalMatch[1]] = value;
  }
  // the server's own variables win, whatever order process.env lists them in
  Object.assign(result, globalVars, serverVars);

  return result;
}
