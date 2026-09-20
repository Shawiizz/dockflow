/**
 * SSH connection type definitions
 */

import type { HostVerifier, SyncHostVerifier } from 'ssh2';

/**
 * Base SSH connection information
 */
export interface SSHConnectionInfo {
  host: string;
  port: number;
  user: string;
  /**
   * Host key check for this connection only (design-05 3.5, K60). Every existing caller omits it
   * and keeps today's accept-anything behaviour (`utils/ssh.ts` `buildConnectConfig`); only the
   * setup transport passes one.
   */
  hostVerifier?: HostVerifier | SyncHostVerifier;
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

/** The node topology type every orchestrator uses (DESIGN-CORE 1.2): superseded ClusterNode/ClusterConnection. */
export type { ClusterNodeRef } from '../services/orchestrator/interfaces';

/**
 * SSH command execution result
 */
export interface SSHExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Raw binary stdout — only populated when collectBinary is true */
  binaryOutput?: Buffer;
}
