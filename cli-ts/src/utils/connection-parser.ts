/**
 * Connection String Parser
 * 
 * Handles parsing and validation of base64-encoded SSH connection strings
 * used for CI/CD deployment configurations.
 */

import { DEFAULT_SSH_PORT } from '../constants';
import type { SSHKeyConnection, Result } from '../types';
import { ok, err } from '../types';
import { normalizePrivateKey, isValidPrivateKey } from './ssh-keys';

/**
 * Error types for connection parsing
 */
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
}

/**
 * Raw connection data before validation
 */
interface RawConnectionData {
  host?: unknown;
  port?: unknown;
  user?: unknown;
  privateKey?: unknown;
  password?: unknown;
}

/**
 * Parse a base64-encoded connection string.
 * Returns a Result type for explicit error handling.
 */
export function parseConnectionString(connectionString: string): Result<SSHKeyConnection, ConnectionParseError> {
  // Step 1: Decode base64
  let json: string;
  try {
    json = Buffer.from(connectionString, 'base64').toString('utf-8');
  } catch {
    return err(new ConnectionParseError(
      'Failed to decode base64 connection string',
      ConnectionParseErrorCode.INVALID_BASE64
    ));
  }

  // Step 2: Parse JSON
  let data: RawConnectionData;
  try {
    data = JSON.parse(json);
  } catch {
    return err(new ConnectionParseError(
      'Failed to parse JSON from connection string',
      ConnectionParseErrorCode.INVALID_JSON
    ));
  }

  // Step 3: Validate required fields
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

  // Step 4: Validate port if provided
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

  // Step 5: Normalize and validate private key
  const normalizedKey = normalizePrivateKey(data.privateKey);
  if (!isValidPrivateKey(normalizedKey)) {
    return err(new ConnectionParseError(
      'Invalid SSH private key format',
      ConnectionParseErrorCode.INVALID_PRIVATE_KEY
    ));
  }

  // Step 6: Build connection object
  const connection: SSHKeyConnection = {
    host: data.host,
    port,
    user: data.user,
    privateKey: normalizedKey,
  };

  // Add optional password
  if (typeof data.password === 'string' && data.password) {
    connection.password = data.password;
  }

  return ok(connection);
}

/**
 * Generate a base64-encoded connection string
 */
export function generateConnectionString(conn: SSHKeyConnection): string {
  const data = {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    privateKey: conn.privateKey,
    ...(conn.password && { password: conn.password }),
  };

  return Buffer.from(JSON.stringify(data)).toString('base64');
}

/**
 * Parse connection string with legacy null return for backwards compatibility
 * @deprecated Use parseConnectionString instead for proper error handling
 */
export function parseConnectionStringLegacy(connectionString: string): SSHKeyConnection | null {
  const result = parseConnectionString(connectionString);
  return result.success ? result.data : null;
}
