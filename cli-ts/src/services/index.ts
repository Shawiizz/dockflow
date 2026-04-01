/**
 * Services barrel export
 *
 * Service layer for Docker Swarm operations.
 * These services encapsulate SSH commands and provide
 * a clean API for CLI commands.
 */

// Stack management
export * from './stack-service';

// Logs handling
export * from './logs-service';

// Command execution in containers
export * from './exec-service';

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

// Swarm stack deployment, convergence, accessories
export * from './swarm-deploy-service';

// Health checks (Swarm internal + HTTP endpoints)
export * from './health-check-service';

// Release lifecycle (create, rollback, cleanup)
export * from './release-service';

// Docker image builds (local + remote)
export * from './build-service';

// Image distribution to Swarm nodes + registry
export * from './distribution-service';

// Deploy hooks (pre/post build/deploy)
export * from './hook-service';
