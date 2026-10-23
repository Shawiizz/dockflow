// the version is only ever written in the root package.json
import rootPackageJson from '../../package.json';

export const DOCKFLOW_VERSION = rootPackageJson.version;

export const DOCKFLOW_RELEASE_URL = 'https://github.com/Shawiizz/dockflow/releases/latest/download';

export const DOCKFLOW_STACKS_DIR = '/var/lib/dockflow/stacks';
/** The stack a release re-applies on rollback, as the swarm received it. */
export const RELEASE_STACK_FILE = 'stack.yml';
export const DOCKFLOW_LOCKS_DIR = '/var/lib/dockflow/locks';
export const DOCKFLOW_AUDIT_DIR = '/var/lib/dockflow/audit';
export const DOCKFLOW_METRICS_DIR = '/var/lib/dockflow/metrics';
export const DOCKFLOW_BACKUPS_DIR = '/var/lib/dockflow/backups';
/** Backup data files without metadata are pruned only past this age: a backup being written has none yet */
export const BACKUP_ORPHAN_GRACE_H = 24;
export const DOCKFLOW_ACCESSORIES_DIR = '/var/lib/dockflow/accessories';
export const DOCKFLOW_UPLOAD_BACKUPS_DIR = '/var/lib/dockflow/upload-backups';
export const NGINX_SITES_ENABLED = '/etc/nginx/sites-enabled';

/** The script that filters internet traffic to published container ports on Swarm hosts, installed by setup */
export const PUBLIC_PORTS_BIN = '/usr/local/sbin/dockflow-public-ports';
/** The public ports each project recorded, one file per project (root-owned) */
export const PUBLIC_PORTS_STATE_DIR = '/etc/dockflow/public-ports';
export const PUBLIC_PORTS_UNIT = 'dockflow-public-ports.service';
export const PUBLIC_PORTS_UNIT_PATH = `/etc/systemd/system/${PUBLIC_PORTS_UNIT}`;
/** Left by `setup --no-port-filter`, so deploys know the host is unfiltered on purpose */
export const PUBLIC_PORTS_OFF_MARKER = '/etc/dockflow/public-ports.off';

export const DEFAULT_SSH_PORT = 22;

// the paths below are relative to the project root
export const DOCKFLOW_LOCAL_DIR = '.dockflow';
export const DOCKFLOW_HOOKS_DIR = '.dockflow/hooks';
/** Where a project keeps its own plugins, one directory each. */
export const DOCKFLOW_PLUGINS_DIR = '.dockflow/plugins';
/** Prefix of the in-memory keys holding instance-rendered plugin files. Nothing is written there. */
export const DOCKFLOW_PLUGIN_INSTANCES_DIR = '.dockflow/plugins/.instances';
export const ENV_FILE_PATH = '.env.dockflow';

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

/** Timeout (ms) for SSH handshake */
export const SSH_READY_TIMEOUT_MS = 10000;
/** Interval (ms) between SSH keepalive packets */
export const SSH_KEEPALIVE_INTERVAL_MS = 15000;
/** Max missed keepalives before declaring connection dead */
export const SSH_KEEPALIVE_COUNT_MAX = 3;

/** Number of connection attempts before giving up */
export const SSH_CONNECT_RETRIES = 3;
/** Base delay (ms) before first retry — doubles on each attempt (exponential backoff) */
export const SSH_CONNECT_RETRY_BASE_DELAY_MS = 1000;

export const TRAEFIK_STACK_NAME = 'traefik';
export const TRAEFIK_NETWORK_NAME = 'traefik-public';
export const TRAEFIK_CERTS_VOLUME = 'traefik-certs';
export const TRAEFIK_IMAGE = 'traefik:v3.6';
/** Read-only proxy of the Docker API that Traefik reads Swarm through; pinned, as it holds the socket */
export const SOCKET_PROXY_IMAGE =
  'tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459';
