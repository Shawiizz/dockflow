/** Parses and validates the base64 SSH connection strings that CI/CD deployments carry. */

import { DEFAULT_SSH_PORT } from '../constants';
import type { SSHKeyConnection, Result } from '../types';
import { ok, err } from '../types';
import { normalizePrivateKey, isValidPrivateKey } from './ssh-keys';
import { isHostKeyFingerprint } from './host-key';

export class ConnectionParseError extends Error {
  constructor(message: string, public readonly code: ConnectionParseErrorCode) {
    super(message);
    this.name = 'ConnectionParseError';
  }
}

export enum ConnectionParseErrorCode {
  INVALID_BASE64 = 'INVALID_BASE64',
  INVALID_JSON = 'INVALID_JSON',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  INVALID_PRIVATE_KEY = 'INVALID_PRIVATE_KEY',
  INVALID_PORT = 'INVALID_PORT',
  INVALID_HOST_KEY = 'INVALID_HOST_KEY',
}

interface RawConnectionData {
  host?: unknown;
  port?: unknown;
  user?: unknown;
  privateKey?: unknown;
  password?: unknown;
  hostKey?: unknown;
}

/**
 * Parses a base64 connection string into an SSH connection. A bad string comes back as an err
 * carrying a ConnectionParseErrorCode, never as a throw.
 */
export function parseConnectionString(connectionString: string): Result<SSHKeyConnection, ConnectionParseError> {
  let json: string;
  try {
    json = Buffer.from(connectionString, 'base64').toString('utf-8');
  } catch {
    return err(new ConnectionParseError(
      'Failed to decode base64 connection string',
      ConnectionParseErrorCode.INVALID_BASE64
    ));
  }

  let data: RawConnectionData;
  try {
    data = JSON.parse(json);
  } catch {
    return err(new ConnectionParseError(
      'Failed to parse JSON from connection string',
      ConnectionParseErrorCode.INVALID_JSON
    ));
  }

  if (typeof data.host !== 'string' || !data.host) {
    return err(new ConnectionParseError(
      'Connection string missing required field: host',
      ConnectionParseErrorCode.MISSING_REQUIRED_FIELD
    ));
  }

  if (typeof data.user !== 'string' || !data.user) {
    return err(new ConnectionParseError(
      'Connection string missing required field: user',
      ConnectionParseErrorCode.MISSING_REQUIRED_FIELD
    ));
  }

  if (typeof data.privateKey !== 'string' || !data.privateKey) {
    return err(new ConnectionParseError(
      'Connection string missing required field: privateKey',
      ConnectionParseErrorCode.MISSING_REQUIRED_FIELD
    ));
  }

  let port = DEFAULT_SSH_PORT;
  if (data.port !== undefined) {
    const parsedPort = typeof data.port === 'string' ? parseInt(data.port, 10) : data.port;
    if (typeof parsedPort !== 'number' || isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return err(new ConnectionParseError(
        `Invalid port: ${data.port}`,
        ConnectionParseErrorCode.INVALID_PORT
      ));
    }
    port = parsedPort;
  }

  if (data.hostKey !== undefined && !isHostKeyFingerprint(data.hostKey)) {
    return err(new ConnectionParseError(
      'Invalid hostKey: expected a fingerprint like SHA256:<base64>, as ssh-keygen -lf prints it',
      ConnectionParseErrorCode.INVALID_HOST_KEY
    ));
  }

  const normalizedKey = normalizePrivateKey(data.privateKey);
  if (!isValidPrivateKey(normalizedKey)) {
    return err(new ConnectionParseError(
      'Invalid SSH private key format',
      ConnectionParseErrorCode.INVALID_PRIVATE_KEY
    ));
  }

  const connection: SSHKeyConnection = {
    host: data.host,
    port,
    user: data.user,
    privateKey: normalizedKey,
  };

  if (typeof data.password === 'string' && data.password) {
    connection.password = data.password;
  }

  if (data.hostKey !== undefined) {
    connection.hostKey = data.hostKey as string;
  }

  return ok(connection);
}

/** The inverse of parseConnectionString; the password and hostKey are left out when unset. */
export function generateConnectionString(conn: SSHKeyConnection): string {
  const data = {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    privateKey: conn.privateKey,
    ...(conn.password && { password: conn.password }),
    ...(conn.hostKey && { hostKey: conn.hostKey }),
  };

  return Buffer.from(JSON.stringify(data)).toString('base64');
}
