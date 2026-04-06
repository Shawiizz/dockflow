/**
 * Application-wide constants
 */

// Read version from root package.json (single source of truth)
import rootPackageJson from '../../package.json';

export const DOCKFLOW_VERSION = rootPackageJson.version;

/**
 * GitHub repository URLs
 */
export const DOCKFLOW_REPO = 'https://github.com/Shawiizz/dockflow.git';
export const DOCKFLOW_RELEASE_URL = 'https://github.com/Shawiizz/dockflow/releases/latest/download';

/**
 * Directory paths
 */
export const DOCKFLOW_DIR = '/opt/dockflow';
export const DOCKFLOW_STACKS_DIR = '/var/lib/dockflow/stacks';
export const DOCKFLOW_LOCKS_DIR = '/var/lib/dockflow/locks';
export const DOCKFLOW_AUDIT_DIR = '/var/lib/dockflow/audit';
export const DOCKFLOW_METRICS_DIR = '/var/lib/dockflow/metrics';
export const DOCKFLOW_BACKUPS_DIR = '/var/lib/dockflow/backups';
export const DOCKFLOW_ACCESSORIES_DIR = '/var/lib/dockflow/accessories';

/**
 * Default values
 */
export const DEFAULT_SSH_PORT = 22;

/**
 * File paths (relative to project root)
 */
export const DOCKFLOW_LOCAL_DIR = '.dockflow';
export const DOCKFLOW_HOOKS_DIR = '.dockflow/hooks';
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

/** Default timeout (s) for waiting for Swarm service convergence */
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
 * Traefik defaults (mirrors ansible/roles/traefik/defaults/main.yml)
 */
export const TRAEFIK_STACK_NAME = 'traefik';
export const TRAEFIK_NETWORK_NAME = 'traefik-public';
export const TRAEFIK_CERTS_VOLUME = 'traefik-certs';
export const TRAEFIK_IMAGE = 'traefik:v3.0';
