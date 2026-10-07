/**
 * Backend factories: consumers (commands, services) only ever see the interfaces.
 */

import type { SSHKeyConnection } from '../../types';
import type { StackBackend, ContainerBackend, ProxyBackend } from './interfaces';
import { SwarmStackBackend } from './swarm/swarm-stack';
import { SwarmContainerBackend } from './swarm/swarm-container';
import { SwarmProxyBackend } from './swarm/swarm-proxy';

export function createStackBackend(conn: SSHKeyConnection): StackBackend {
  return new SwarmStackBackend(conn);
}

export function createContainerBackend(
  conn: SSHKeyConnection,
  allConnections?: SSHKeyConnection[],
): ContainerBackend {
  return new SwarmContainerBackend(conn, allConnections || [conn]);
}

export function createProxyBackend(conn: SSHKeyConnection): ProxyBackend {
  return new SwarmProxyBackend(conn);
}
