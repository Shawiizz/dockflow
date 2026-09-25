// Paths, modes and timeouts of k3s provisioning (design-05 4.0, 6.1, 15.6). Together with
// services/orchestrator/kubernetes/k3s, the only code that names k3s paths. Kubernetes constants
// (`K8S_STORAGE_CLASS`, `HELM_CHARTS_DIR`, the kubeconfig path) are imported where used, never
// redeclared here.

import { K3S_BINARY_PATH } from '../../../services/orchestrator/kubernetes/k3s/distribution';

export const K3S_BINARY = K3S_BINARY_PATH;
export const K3S_ADMIN_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
export const K3S_CONFIG_DIR = '/etc/rancher/k3s';
export const K3S_CONFIG_DROPIN_DIR = '/etc/rancher/k3s/config.yaml.d';
export const K3S_CONFIG_DROPIN = '/etc/rancher/k3s/config.yaml.d/50-dockflow.yaml';
export const K3S_DOCKFLOW_DIR = '/etc/rancher/k3s/dockflow';
export const K3S_TOKEN_FILE = '/etc/rancher/k3s/dockflow/token';
export const K3S_AGENT_TOKEN_FILE = '/etc/rancher/k3s/dockflow/agent-token';
export const K3S_NODE_STATE_FILE = '/etc/rancher/k3s/dockflow/state.json';
export const K3S_FIREWALL_STATE_FILE = '/etc/rancher/k3s/dockflow/firewall.json';
export const K3S_DATA_DIR = '/var/lib/rancher/k3s';
export const K3S_SERVER_TOKEN = '/var/lib/rancher/k3s/server/token';
export const K3S_SERVER_AGENT_TOKEN = '/var/lib/rancher/k3s/server/agent-token';
export const K3S_SERVER_CA = '/var/lib/rancher/k3s/server/tls/server-ca.crt';
export const K3S_STORAGE_DIR = '/var/lib/rancher/k3s/storage';
export const K3S_SQLITE_DB_DIR = '/var/lib/rancher/k3s/server/db';
export const K3S_ETCD_DIR = '/var/lib/rancher/k3s/server/db/etcd';
/** k3s-owned: its deploy controller re-applies these files, Dockflow never writes there (F30) */
export const K3S_MANIFESTS_DIR = '/var/lib/rancher/k3s/server/manifests';
/** content-addressed download cache, root 0700, files named by their sha256 (5.1) */
export const DOWNLOAD_CACHE_DIR = '/var/cache/dockflow/sha256';
export const PRESERVED_DIR = '/var/lib/dockflow-preserved';
export const SETUP_LOCK_FILE = '/run/dockflow-k3s-setup.lock';
export const HELM_BIN_DIR = '/usr/local/lib/dockflow/bin';
export const SUDOERS_K3S_FILE = '/etc/sudoers.d/dockflow-k3s';

export const K3S_API_PORT = 6443;
export const POD_CIDR = '10.42.0.0/16';
export const SERVICE_CIDR = '10.43.0.0/16';
export const CNI_BRIDGE_IFACE = 'cni0';
export const FLANNEL_IFACE = { vxlan: 'flannel.1', 'wireguard-native': 'flannel-wg' } as const;
export const NETCHECK_DAEMONSET = 'dockflow-netcheck';
/** the StorageClass k3s ships as default (F19) */
export const LOCAL_PATH_STORAGE_CLASS = 'local-path';
export const IS_DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
/** the only bundled component Dockflow disables (D16) */
export const K3S_DISABLED_COMPONENTS: readonly string[] = ['traefik'];
export const SECRETS_ENCRYPTION_PROVIDER = 'secretbox';
export const K3S_KUBECONFIG_MODE = '0600';

/** directory holding the token files and state.json (C15) */
export const K3S_DOCKFLOW_DIR_MODE = 0o700;
export const K3S_SECRET_FILE_MODE = 0o600;
/** the drop-in holds no secret, only the -file forms of the tokens */
export const K3S_CONFIG_DROPIN_MODE = 0o600;
/** random bytes of the agent token Dockflow generates on the first server (6.1) */
export const AGENT_TOKEN_BYTES = 32;
/** comment of the authorized_keys line derived from the deploy key (2.1) */
export const DEPLOY_KEY_COMMENT = 'dockflow-deploy';
export const NODE_STATE_SCHEMA = 1;
export const NODE_STATE_MANAGED_BY = 'dockflow';
/** the node step reads at most this much of its stdin plan (3.4) */
export const NODE_PLAN_MAX_BYTES = 1024 * 1024;

export const SETUP_PARALLEL_NODES = 4;

// Timeouts (15.6)
export const NODE_STEP_GUARD_S = {
  inspect: 120,
  prepare: 1200,
  install: 1200,
  'control-plane': 600,
  'read-tokens': 60,
  finalize: 900,
  reset: 900,
} as const;
export const K3S_SERVER_START_TIMEOUT_S = 300;
export const K3S_AGENT_START_TIMEOUT_S = 180;
export const NODE_READY_TIMEOUT_S = 180;
export const NODE_READY_UPGRADE_TIMEOUT_S = 300;
export const DEPLOYER_TOKEN_TIMEOUT_S = 60;
/** first boot pulls the CoreDNS, local-path and metrics-server images */
export const SYSTEM_COMPONENTS_TIMEOUT_S = 300;
export const NETWORK_CHECK_TIMEOUT_S = 180;
/**
 * How long each cross-node probe keeps retrying: on a fresh cluster CoreDNS and the Service rules
 * of a node that just joined lag the netcheck pods' own readiness by a few seconds.
 */
export const NETWORK_CHECK_RETRY_S = 60;
export const NETWORK_CHECK_RETRY_INTERVAL_MS = 3000;
export const DOWNLOAD_MAX_TIME_S = 900;
export const REACHABILITY_PROBE_TIMEOUT_S = 3;
export const NETCHECK_CLEANUP_TIMEOUT_S = 60;

/** The one curl flag set of every download, node-side and coordinator-side (5.1, K57c). */
export const CURL_FLAGS: readonly string[] = [
  '-fsSL',
  '--proto',
  '=https',
  '--tlsv1.2',
  '--retry',
  '3',
  '--retry-delay',
  '2',
  '--connect-timeout',
  '20',
  '--max-time',
  String(DOWNLOAD_MAX_TIME_S),
];

// Preflight thresholds (4.1)
export const SERVER_MIN_MEMORY_BYTES = 1.8 * 1024 ** 3;
export const SERVER_MIN_CPUS = 2;
export const AGENT_MIN_MEMORY_BYTES = 512 * 1024 ** 2;
export const VAR_LIB_MIN_FREE_BYTES = 10 * 1024 ** 3;
