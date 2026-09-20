/**
 * Application-wide constants
 */

// Read version from root package.json (single source of truth)
import rootPackageJson from '../../package.json';

export const DOCKFLOW_VERSION = rootPackageJson.version;

/**
 * GitHub repository URLs
 */
export const DOCKFLOW_RELEASE_URL = 'https://github.com/Shawiizz/dockflow/releases/latest/download';

/**
 * Directory paths
 */
export const DOCKFLOW_STACKS_DIR = '/var/lib/dockflow/stacks';
/** The stack a release re-applies on rollback, as the orchestrator received it. */
export const RELEASE_STACK_FILE = 'stack.yml';
export const DOCKFLOW_LOCKS_DIR = '/var/lib/dockflow/locks';
export const DOCKFLOW_AUDIT_DIR = '/var/lib/dockflow/audit';
export const DOCKFLOW_METRICS_DIR = '/var/lib/dockflow/metrics';
export const DOCKFLOW_BACKUPS_DIR = '/var/lib/dockflow/backups';
export const DOCKFLOW_ACCESSORIES_DIR = '/var/lib/dockflow/accessories';
export const DOCKFLOW_UPLOAD_BACKUPS_DIR = '/var/lib/dockflow/upload-backups';
export const NGINX_SITES_ENABLED = '/etc/nginx/sites-enabled';

/**
 * Default values
 */
export const DEFAULT_SSH_PORT = 22;

/**
 * File paths (relative to project root)
 */
export const DOCKFLOW_LOCAL_DIR = '.dockflow';
export const DOCKFLOW_HOOKS_DIR = '.dockflow/hooks';
/** Where a project keeps its own plugins, one directory each. */
export const DOCKFLOW_PLUGINS_DIR = '.dockflow/plugins';
/** Prefix of the in-memory keys holding instance-rendered plugin files. Nothing is written there. */
export const DOCKFLOW_PLUGIN_INSTANCES_DIR = '.dockflow/plugins/.instances';
export const ENV_FILE_PATH = '.env.dockflow';

/**
 * CLI magic numbers
 */
/** Minutes after which a deployment lock is considered stale */
export const LOCK_STALE_THRESHOLD_MINUTES = 30;
/** Max polling attempts when waiting for stack removal */
export const STACK_REMOVAL_MAX_ATTEMPTS = 30;
/** Delay (ms) between stack removal polling attempts */
export const STACK_REMOVAL_POLL_INTERVAL_MS = 2000;

/** Outer convergence deadline (s) of a deploy, on every orchestrator */
export const CONVERGENCE_TIMEOUT_S = 300;
/** Default polling interval (s) for convergence checks */
export const CONVERGENCE_INTERVAL_S = 5;

/**
 * SSH connection defaults
 */
/** Timeout (ms) for SSH handshake */
export const SSH_READY_TIMEOUT_MS = 10000;
/** Interval (ms) between SSH keepalive packets */
export const SSH_KEEPALIVE_INTERVAL_MS = 15000;
/** Max missed keepalives before declaring connection dead */
export const SSH_KEEPALIVE_COUNT_MAX = 3;

/**
 * SSH connection retry settings
 */
/** Number of connection attempts before giving up */
export const SSH_CONNECT_RETRIES = 3;
/** Base delay (ms) before first retry — doubles on each attempt (exponential backoff) */
export const SSH_CONNECT_RETRY_BASE_DELAY_MS = 1000;

/**
 * Traefik defaults
 */
export const TRAEFIK_STACK_NAME = 'traefik';
export const TRAEFIK_NETWORK_NAME = 'traefik-public';
export const TRAEFIK_CERTS_VOLUME = 'traefik-certs';
export const TRAEFIK_IMAGE = 'traefik:v3.6';

/**
 * Orchestrator-neutral waits. Kubernetes-specific constants live in
 * services/orchestrator/kubernetes/constants.ts, which neutral code never imports.
 */
/** Pods must stay ready with unchanged restart counts this long (HealthOptions.stabilityS) */
export const HEALTH_STABILITY_WINDOW_S = 10;
/** Defaults of health_checks.timeout / health_checks.interval */
export const DEFAULT_HEALTHCHECK_TIMEOUT_S = 120;
export const DEFAULT_HEALTHCHECK_INTERVAL_S = 5;
/** Wait budget of scale, restart, rollback <service> and accessories restart */
export const CONTROL_WAIT_TIMEOUT_S = 300;
/** Wait budget of stop, accessories stop, accessories remove and volumes rm */
export const DELETE_WAIT_TIMEOUT_S = 120;
/** `status` per-environment budget with one manager (core 8.6 per-command budget table) */
export const STATUS_BUDGET_SINGLE_MANAGER_MS = 8000;
/** `status` per-environment budget with several managers: failover probing needs the extra time */
export const STATUS_BUDGET_MULTI_MANAGER_MS = 20000;
/** Backup data files without metadata are pruned only past this age: a backup being written has none yet */
export const BACKUP_ORPHAN_GRACE_H = 24;

/** Pull secret name, fixed before any remote call so offline renders reference the same name */
export const REGISTRY_PULL_SECRET_NAME = 'dockflow-registry';
