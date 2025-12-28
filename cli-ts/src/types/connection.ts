/**
 * SSH connection type definitions
 */

/**
 * Base SSH connection information
 */
export interface SSHConnectionInfo {
  host: string;
  port: number;
  user: string;
}

/**
 * SSH connection with key-based authentication
 */
export interface SSHKeyConnection extends SSHConnectionInfo {
  privateKey: string;
  password?: string; // Optional password for sudo
}

/**
 * SSH connection with password authentication
 */
export interface SSHPasswordConnection extends SSHConnectionInfo {
  password: string;
}

/**
 * Union type for all connection types
 */
export type ConnectionInfo = SSHKeyConnection | SSHPasswordConnection;

/**
 * Type guard for key-based connections
 */
export function isKeyConnection(conn: ConnectionInfo): conn is SSHKeyConnection {
  return 'privateKey' in conn;
}

/**
 * Type guard for password-based connections
 */
export function isPasswordConnection(conn: ConnectionInfo): conn is SSHPasswordConnection {
  return !('privateKey' in conn) && 'password' in conn;
}

/**
 * SSH command execution result
 */
export interface SSHExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Default SSH port
 */
export const DEFAULT_SSH_PORT = 22;
