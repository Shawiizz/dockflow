import type { SSHKeyConnection } from '../../types';
import type { OrchestratorService } from './interface';
import type { HealthBackend } from './health-interface';
import type { LogsBackend } from './logs-interface';

export type OrchestratorType = 'swarm' | 'k3s';

/**
 * Factory for orchestrator backends.
 *
 * Concrete backend implementations (SwarmOrchestratorService, K3sOrchestratorService, etc.)
 * are wired in subsequent phases. This file exposes the factory surface the rest of the
 * codebase will call into — until a backend is registered, calls throw at runtime.
 */
export function createOrchestrator(
  _type: OrchestratorType,
  _conn: SSHKeyConnection,
): OrchestratorService {
  throw new Error('Orchestrator backends not yet wired — implement in Phase 3+');
}

export function createHealthBackend(
  _type: OrchestratorType,
  _conn: SSHKeyConnection,
): HealthBackend {
  throw new Error('Health backends not yet wired — implement in Phase 3+');
}

export function createLogsBackend(
  _type: OrchestratorType,
  _conn: SSHKeyConnection,
): LogsBackend {
  throw new Error('Logs backends not yet wired — implement in Phase 3+');
}
