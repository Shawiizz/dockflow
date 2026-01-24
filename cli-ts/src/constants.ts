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
export const DOCKFLOW_ACCESSORIES_DIR = '/var/lib/dockflow/accessories';
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
  /** Workspace with symlinks (writable .dockflow/) */
  WORKSPACE: '/workspace',
  /** Context JSON file for Ansible */
  CONTEXT: '/tmp/dockflow_context.json',
} as const;

/**
 * Default values
 */
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_TIMEOUT = 10;
export const DEFAULT_VERSION = '1.0.0';

/**
 * File paths (relative to project root)
 */
export const CONFIG_PATH = '.dockflow/config.yml';
export const SERVERS_PATH = '.dockflow/servers.yml';
export const ENV_FILE_PATH = '.env.dockflow';
export const DOCKER_DIR = '.dockflow/docker';
export const HOOKS_DIR = '.dockflow/hooks';
export const TEMPLATES_DIR = '.dockflow/templates';
