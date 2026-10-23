export interface SSHConnectionInfo {
  host: string;
  port: number;
  user: string;
  /** Pinned host key fingerprint (`SHA256:...`): a server presenting another key is refused */
  hostKey?: string;
}

export interface SSHKeyConnection extends SSHConnectionInfo {
  privateKey: string;
  /** for sudo on the server */
  password?: string;
}

export interface SSHPasswordConnection extends SSHConnectionInfo {
  password: string;
}

export type ConnectionInfo = SSHKeyConnection | SSHPasswordConnection;

export function isKeyConnection(conn: ConnectionInfo): conn is SSHKeyConnection {
  return 'privateKey' in conn;
}

/** A cluster node: its SSH connection and the name shown for it. */
export interface ClusterNode {
  connection: SSHKeyConnection;
  name: string;
}

/** Full SSH topology of a deployment target. */
export interface ClusterConnection {
  manager: ClusterNode;
  workers: ClusterNode[];
  /** Swarm managers other than the active leader. */
  otherManagers: ClusterNode[];
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** raw stdout, only when `collectBinary` was asked for */
  binaryOutput?: Buffer;
}
