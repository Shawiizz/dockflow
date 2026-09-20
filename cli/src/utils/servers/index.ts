/**
 * Server utilities - barrel export
 *
 * This module provides all server-related functionality:
 * - CI secrets resolution
 * - Server resolution from servers.yml
 * - Template context building for Jinja2
 *
 * Control-plane resolution (`resolveOrchestratorTarget`, `probeControlPlane`) lives in
 * `services/orchestrator/target.ts`, not here: `failover.ts` no longer has those exports.
 */

// CI secrets resolution
export { 
  serverNameToEnvKey,
  getCISecret,
  getServerPrivateKey, 
  getServerPassword,
  mergeEnvVars,
} from './ci-secrets';

// Server resolution
export {
  resolveServersForEnvironment,
  resolveServerByName,
  getManagersForEnvironment,
  getWorkersForEnvironment,
  resolveDeploymentForEnvironment,
  getAvailableEnvironments,
  getServerNamesForEnvironment,
  getFullConnectionInfo,
  getAllNodeConnections,
  getEnvVarsForEnvironment,
} from './resolver';

// Template context
export { buildTemplateContext } from './template-context';
