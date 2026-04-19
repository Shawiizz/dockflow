/**
 * Backend factories.
 *
 * Each factory returns the concrete backend for the chosen orchestrator.
 * Consumers (commands, services) only ever see the interface — switching
 * orchestrators is a single config field flip.
 */

import type { SSHKeyConnection } from '../../types';
import type { StackBackend, ContainerBackend, ProxyBackend } from './interfaces';
import { SwarmStackBackend } from './swarm/swarm-stack';
import { SwarmContainerBackend } from './swarm/swarm-container';
import { SwarmProxyBackend } from './swarm/swarm-proxy';
import { K3sStackBackend } from './k3s/k3s-stack';
import { K3sContainerBackend } from './k3s/k3s-container';
import { K3sProxyBackend } from './k3s/k3s-proxy';

export type OrchestratorType = 'swarm' | 'k3s';

export function createStackBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
): StackBackend {
  return type === 'k3s'
    ? new K3sStackBackend(conn)
    : new SwarmStackBackend(conn);
}

export function createContainerBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
  allConnections?: SSHKeyConnection[],
): ContainerBackend {
  return type === 'k3s'
    ? new K3sContainerBackend(conn)
    : new SwarmContainerBackend(conn, allConnections || [conn]);
}

export function createProxyBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
): ProxyBackend {
  return type === 'k3s'
    ? new K3sProxyBackend(conn)
    : new SwarmProxyBackend(conn);
}
