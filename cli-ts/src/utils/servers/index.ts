/**
 * Server utilities - barrel export
 * 
 * This module provides all server-related functionality:
 * - CI secrets resolution
 * - Server resolution from servers.yml
 * - Multi-manager failover
 * - Template context building for Jinja2
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
  getEnvVarsForEnvironment,
} from './resolver';

// Manager failover
export {
  checkManagerStatus,
  findActiveManager,
  type ActiveManagerResult,
  type FindActiveManagerOptions,
} from './failover';

// Template context
export { buildTemplateContext } from './template-context';
