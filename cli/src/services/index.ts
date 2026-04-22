/**
 * Services barrel export
 *
 * Service layer for deploy/operate flows. Stack lifecycle and exec
 * are handled through the orchestrator layer
 * (`services/orchestrator/*`) — not re-exported here.
 */

// Deployment metrics
export * from './metrics';

// Deployment locks
export * from './lock';

// Backup & restore
export * from './backup';

// Audit logging
export * from './audit';

// History sync across nodes
export * from './history-sync';

// Compose manipulation (template rendering, image tagging, deploy config injection)
export * from './compose';

// Health checks (internal via StackBackend + HTTP endpoints)
export * from './health-check';

// Release lifecycle (create, rollback, cleanup)
export * from './release';

// Docker image builds (local + remote)
export * from './build';

// Image distribution to Swarm nodes + registry
export * from './distribution';

// Deploy hooks (pre/post build/deploy)
export * from './hook';

// Nginx template deployment
export * from './nginx';
