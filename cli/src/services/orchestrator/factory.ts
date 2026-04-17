import type { SSHKeyConnection } from '../../types';
import type { OrchestratorService, TraefikBackend } from './interface';
import type { HealthBackend } from './health-interface';
import type { LogsBackend } from './logs-interface';
import type { ExecBackend } from './exec-interface';
import { SwarmOrchestratorService } from './swarm/swarm-orchestrator';
import { SwarmHealthBackend } from './swarm/swarm-health';
import { SwarmLogsBackend } from './swarm/swarm-logs';
import { SwarmExecBackend } from './swarm/swarm-exec';
import { K3sOrchestratorService } from './k3s/k3s-orchestrator';
import { K3sHealthBackend } from './k3s/k3s-health';
import { K3sLogsBackend } from './k3s/k3s-logs';
import { K3sExecBackend } from './k3s/k3s-exec';
import { TraefikService } from '../traefik-service';
import { K3sTraefikService } from '../k3s-traefik-service';

export type OrchestratorType = 'swarm' | 'k3s';

export function createOrchestrator(
  type: OrchestratorType,
  conn: SSHKeyConnection,
): OrchestratorService {
  return type === 'k3s'
    ? new K3sOrchestratorService(conn)
    : new SwarmOrchestratorService(conn);
}

export function createHealthBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
): HealthBackend {
  return type === 'k3s'
    ? new K3sHealthBackend(conn)
    : new SwarmHealthBackend(conn);
}

export function createLogsBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
): LogsBackend {
  return type === 'k3s'
    ? new K3sLogsBackend(conn)
    : new SwarmLogsBackend(conn);
}

export function createExecBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
  allConnections?: SSHKeyConnection[],
): ExecBackend {
  return type === 'k3s'
    ? new K3sExecBackend(conn)
    : new SwarmExecBackend(conn, allConnections || [conn]);
}

export function createTraefikBackend(
  type: OrchestratorType,
  conn: SSHKeyConnection,
): TraefikBackend {
  return type === 'k3s'
    ? new K3sTraefikService(conn)
    : new TraefikService(conn);
}
