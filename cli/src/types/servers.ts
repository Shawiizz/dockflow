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
 * Server role in the cluster
 * - manager: Swarm manager / k3s server; receives deployments, orchestrates the cluster
 * - worker: Swarm worker / k3s agent; runs the workloads the managers schedule
 */
export type ServerRole = 'manager' | 'worker';

/**
 * Server definition in servers.yml
 */
export interface ServerConfig {
  /** Role in the cluster: manager or worker (default: manager) */
  role?: ServerRole;
  /** Server hostname or IP (can be overridden by CI secret) */
  host?: string;
  /** Private IP used for cluster traffic (k3s node-ip, firewall sources, join address); defaults to host */
  private_host?: string;
  /** Kubernetes node labels applied by dockflow setup (k3s only) */
  node_labels?: Record<string, string>;
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
  /** Role in the cluster */
  role: ServerRole;
  /** Server hostname or IP */
  host: string;
  /** Address for cluster traffic: servers.yml private_host, else host */
  privateHost: string;
  /**
   * servers.yml private_host as written (null when absent). k3s setup derives the address mode from it
   * (design-05 2.2), which `privateHost` cannot tell apart from the fallback to host.
   */
  declaredPrivateHost: string | null;
  /** servers.yml node_labels ({} when absent) */
  nodeLabels: Record<string, string>;
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

/**
 * Safe server info for Jinja2 templates (no sensitive data)
 * This is what's available in {{ servers.servername }}
 */
export interface SafeServer {
  /** Server name (key in servers.yml) */
  name: string;
  /** Role in the cluster */
  role: ServerRole;
  /** Server hostname or IP (hydrated from CI secrets) */
  host: string;
  /** Address for cluster traffic: servers.yml private_host, else host */
  private_host: string;
  /** SSH port */
  port: number;
  /** SSH user */
  user: string;
  /** Tags this server belongs to */
  tags: string[];
  /** Merged environment variables (no secrets like passwords) */
  env: EnvVars;
}

/**
 * Current server context for Jinja2 templates
 * This is what's available in {{ current }}
 */
export interface CurrentServer extends SafeServer {
  /** Indicates this is the current deployment target */
  is_current: true;
}

/**
 * Complete template context for Jinja2 rendering
 * Combines current server, all servers, and cluster metadata
 */
export interface TemplateContext {
  /** Current server being deployed to */
  current: CurrentServer;
  /** All servers in this environment (keyed by name) - hydrated with CI secrets */
  servers: Record<string, SafeServer>;
  /** Cluster metadata */
  cluster: {
    /** Total number of nodes in the environment */
    size: number;
    /** Number of manager nodes */
    manager_count: number;
    /** Number of worker nodes */
    worker_count: number;
    /** List of manager hostnames/IPs */
    managers: string[];
    /** List of worker hostnames/IPs */
    workers: string[];
  };
}
