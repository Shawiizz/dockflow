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

/**
 * Docker configuration
 */
export const ANSIBLE_DOCKER_IMAGE = 'shawiizz/dockflow-ci:latest';

/**
 * Default values
 */
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_TIMEOUT = 10;
export const DEFAULT_VERSION = '1.0.0';

/**
 * File paths (relative to project root)
 */
export const CONFIG_PATH = '.deployment/config.yml';
export const SERVERS_PATH = '.deployment/servers.yml';
export const ENV_FILE_PATH = '.env.dockflow';
export const DOCKER_DIR = '.deployment/docker';
export const HOOKS_DIR = '.deployment/hooks';
export const TEMPLATES_DIR = '.deployment/templates';
