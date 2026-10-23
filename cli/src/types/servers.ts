/**
 * The shapes of servers.yml and of its resolved form. An environment has one or more managers
 * (several for HA) and workers; deploys go to the active manager, with failover to the next one.
 */

export type EnvVars = Record<string, string>;

/** A manager receives deployments and orchestrates the Swarm; a worker joins it and runs containers. */
export type ServerRole = 'manager' | 'worker';

export interface ServerConfig {
  /** default: manager */
  role?: ServerRole;
  /** can be overridden by a CI secret */
  host?: string;
  /** Private IP of the server: Swarm traffic between nodes goes through it, SSH still uses `host` */
  private_host?: string;
  /** Environment tags this server belongs to (e.g., production, staging) */
  tags: string[];
  /** overrides defaults.user */
  user?: string;
  /** overrides defaults.port */
  port?: number;
  env?: EnvVars;
}

export interface ServerDefaults {
  user: string;
  port: number;
}

export interface EnvByTag {
  /** Variables applied to all environments */
  all?: EnvVars;
  /** Variables for specific tags (production, staging, etc.) */
  [tag: string]: EnvVars | undefined;
}

export interface ServersConfig {
  /** keyed by server name */
  servers: Record<string, ServerConfig>;
  defaults?: ServerDefaults;
  env?: EnvByTag;
}

/** A server with its connection settled and its variables merged. */
export interface ResolvedServer {
  /** key in servers.yml */
  name: string;
  role: ServerRole;
  host: string;
  port: number;
  user: string;
  /** Private IP Swarm advertises and joins through, when servers.yml sets one */
  privateHost?: string;
  /** Pinned SSH host key fingerprint, when the connection string or a secret carries one */
  hostKey?: string;
  /** Merged environment variables (all → tag → server → CI) */
  env: EnvVars;
  tags: string[];
}

export interface ResolvedDeployment {
  /** the deployment target: the first manager listed, until findActiveManager picks another */
  manager: ResolvedServer;
  /** all managers, for failover */
  managers: ResolvedServer[];
  /** workers, which get the image when there is no registry */
  workers: ResolvedServer[];
  environment: string;
}

export const SERVER_DEFAULTS: ServerDefaults = {
  user: 'dockflow',
  port: 22,
};

/** A server as templates see it in `{{ servers.<name> }}`: no private host, host key or key. */
export interface SafeServer {
  /** key in servers.yml */
  name: string;
  role: ServerRole;
  /** hydrated from CI secrets */
  host: string;
  port: number;
  user: string;
  tags: string[];
  /** merged variables, with lowercased keys */
  env: EnvVars;
}

/** The server being deployed to, as `{{ current }}`. */
export interface CurrentServer extends SafeServer {
  is_current: true;
}

/** What `{{ current }}`, `{{ servers }}` and `{{ cluster }}` hold in a template. */
export interface TemplateContext {
  current: CurrentServer;
  /** all servers of the environment, by name */
  servers: Record<string, SafeServer>;
  cluster: {
    /** total number of nodes */
    size: number;
    manager_count: number;
    worker_count: number;
    /** hostnames or IPs */
    managers: string[];
    /** hostnames or IPs */
    workers: string[];
  };
}
