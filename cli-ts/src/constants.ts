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

/**
 * Docker configuration
 */
export const ANSIBLE_DOCKER_IMAGE = 'shawiizz/dockflow-ci:latest';

/**
 * Container paths (inside the Docker container)
 */
export const CONTAINER_PATHS = {
  /** Dockflow framework root */
  DOCKFLOW: '/tmp/dockflow',
  /** User project mounted read-only */
  PROJECT: '/project',
  /** Workspace with overlayfs (writable view of /project) */
  WORKSPACE: '/workspace/merged',
  /** Context JSON file for Ansible */
  CONTEXT: '/tmp/dockflow_context.json',
} as const;

/**
 * Default values
 */
export const DEFAULT_SSH_PORT = 22;

/**
 * File paths (relative to project root)
 */
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
