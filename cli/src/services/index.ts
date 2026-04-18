/**
 * Services barrel export
 *
 * Service layer for deploy/operate flows. Stack lifecycle and exec
 * are handled through the orchestrator layer
 * (`services/orchestrator/*`) — not re-exported here.
 */

// Deployment metrics
export * from './metrics-service';

// Deployment locks
export * from './lock-service';

// Backup & restore
export * from './backup-service';

// Audit logging
export * from './audit-service';

// History sync across nodes
export * from './history-sync-service';

// Compose manipulation (template rendering, image tagging, deploy config injection)
export * from './compose-service';

// Health checks (internal via StackBackend + HTTP endpoints)
export * from './health-check-service';

// Release lifecycle (create, rollback, cleanup)
export * from './release-service';

// Docker image builds (local + remote)
export * from './build-service';

// Image distribution to Swarm nodes + registry
export * from './distribution-service';

// Deploy hooks (pre/post build/deploy)
export * from './hook-service';
