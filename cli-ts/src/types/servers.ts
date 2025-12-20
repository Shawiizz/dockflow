/**
 * Server configuration type definitions for servers.yml
 * 
 * Architecture: Docker Swarm cluster with manager(s) and workers
 * - One or more managers per environment (multi-manager for HA)
 * - Workers join the swarm and receive workloads automatically
 * - Deploy command targets the active leader manager
 * - If multiple managers: automatic failover to next available
 */

/**
 * Environment variables dictionary
 */
export type EnvVars = Record<string, string>;

/**
 * Server role in the Swarm cluster
 * - manager: Receives deployments, orchestrates the cluster
 * - worker: Joins the swarm, runs containers distributed by manager
 */
export type ServerRole = 'manager' | 'worker';

/**
 * Server definition in servers.yml
 */
export interface ServerConfig {
  /** Role in Swarm cluster: manager or worker (default: manager) */
  role?: ServerRole;
  /** Server hostname or IP (can be overridden by CI secret) */
  host?: string;
  /** Environment tags this server belongs to (e.g., production, staging) */
  tags: string[];
  /** SSH user (overrides defaults.user) */
  user?: string;
  /** SSH port (overrides defaults.port) */
  port?: number;
  /** Server-specific environment variables */
  env?: EnvVars;
}

/**
 * Default SSH configuration
 */
export interface ServerDefaults {
  /** Default SSH user */
  user: string;
  /** Default SSH port */
  port: number;
}

/**
 * Environment variables grouped by tag
 */
export interface EnvByTag {
  /** Variables applied to all environments */
  all?: EnvVars;
  /** Variables for specific tags (production, staging, etc.) */
  [tag: string]: EnvVars | undefined;
}

/**
 * Complete servers.yml configuration
 */
export interface ServersConfig {
  /** Server definitions keyed by server name */
  servers: Record<string, ServerConfig>;
  /** Default SSH settings */
  defaults?: ServerDefaults;
  /** Environment variables by tag */
  env?: EnvByTag;
}

/**
 * Resolved server with all variables merged
 */
export interface ResolvedServer {
  /** Server name (key in servers.yml) */
  name: string;
  /** Role in Swarm cluster */
  role: ServerRole;
  /** Server hostname or IP */
  host: string;
  /** SSH port */
  port: number;
  /** SSH user */
  user: string;
  /** Merged environment variables (all → tag → server → CI) */
  env: EnvVars;
  /** Tags this server belongs to */
  tags: string[];
}

/**
 * Result of resolving servers for a deployment
 */
export interface ResolvedDeployment {
  /** The active manager server (deployment target) - leader or first reachable */
  manager: ResolvedServer;
  /** All manager servers (for failover info) */
  managers: ResolvedServer[];
  /** Worker servers (for image distribution if no registry) */
  workers: ResolvedServer[];
  /** The environment/tag being deployed */
  environment: string;
}

/**
 * Default values for server configuration
 */
export const SERVER_DEFAULTS: ServerDefaults = {
  user: 'dockflow',
  port: 22,
};
