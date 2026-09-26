// Topology planning of k3s setup (design-05 2, 4.1, 4.2). Pure: servers.yml, config.yml and the
// flags become a K3sClusterPlan before any SSH (buildClusterPlan); the node inspections turn it into
// the decisions of every node (finalizeClusterPlan); buildNodePlan cuts the stdin document of one
// node operation out of both.

import { utils as sshUtils } from 'ssh2';
import { k3sTopologyIssues, type TopologyServer } from '../../../schemas/servers.schema';
import { K8S_STORAGE_CLASS } from '../../../services/orchestrator/kubernetes/constants';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';
import { nodeNameFor } from '../../../services/orchestrator/kubernetes/naming';
import { HELM_PIN } from '../../../services/orchestrator/kubernetes/versions';
import type { ResolvedServer } from '../../../types/servers';
import type { DockflowConfig } from '../../../utils/config';
import { CLIError, ConfigError, ConnectionError, ErrorCode, ValidationError } from '../../../utils/errors';
import { classifyConfigDrift, MANAGED_CONFIG_KEYS, type RenderedK3sConfig, renderK3sConfig } from './config';
import {
  AGENT_MIN_MEMORY_BYTES,
  CNI_BRIDGE_IFACE,
  DEPLOY_KEY_COMMENT,
  FLANNEL_IFACE,
  K3S_API_PORT,
  K3S_SQLITE_DB_DIR,
  LOCAL_PATH_STORAGE_CLASS,
  SERVER_MIN_CPUS,
  SERVER_MIN_MEMORY_BYTES,
  SETUP_PARALLEL_NODES,
  VAR_LIB_MIN_FREE_BYTES,
} from './constants';
import { type SetupProblem, setupMessages } from './messages';
import { type ClusterTokens, NO_TOKENS, type NodeTokens, tokensFor } from './tokens';

// ---------------------------------------------------------------------------
// Types (design-05 2.3, 3.4, 4.1)
// ---------------------------------------------------------------------------

export type K3sNodeRole = 'server-init' | 'server' | 'agent';
export type FlannelBackend = 'vxlan' | 'wireguard-native';
export type AddressMode = 'private' | 'public';
export type Datastore = 'sqlite' | 'etcd';
export type NodeArch = 'amd64' | 'arm64';
export type NodeOperation = 'inspect' | 'prepare' | 'install' | 'control-plane' | 'read-tokens' | 'finalize' | 'reset';
export type FirewallTool = 'ufw' | 'firewalld';
export type NodeActionKind = 'install' | 'repair' | 'noop' | 'start' | 'reconfigure' | 'upgrade' | 'convert-to-etcd';

export const FLANNEL_BACKENDS: readonly FlannelBackend[] = ['vxlan', 'wireguard-native'];

export interface K3sNodeSpec {
  /** servers.yml key */
  key: string;
  /** nodeNameFor(key) */
  nodeName: string;
  role: K3sNodeRole;
  ssh: { host: string; port: number };
  deployUser: string;
  /** authorized_keys line derived from the deploy key; null in local mode without a key */
  deployPublicKey: string | null;
  /** servers.yml private_host */
  privateHost: string | null;
  /** host as written after CI overrides, when it is not an IP literal */
  hostName: string | null;
  /** host when it is an IPv4 literal */
  hostIp: string | null;
  nodeLabels: Record<string, string>;
}

/** The flags finalizeClusterPlan and the node steps act on. */
export interface K3sPlanFlags {
  sharedCluster: boolean;
  skipFirewall: boolean;
  skipNetworkCheck: boolean;
  rotateDeployToken: boolean;
  convertDatastore: boolean;
  /** a terminal can confirm, so the datastore conversion may be consented to at the prompt (15.5) */
  interactive: boolean;
}

export interface K3sClusterPlan {
  schema: 1;
  /** '' in local single-host mode */
  env: string;
  project: string | null;
  dockflowVersion: string;
  /**
   * Host ports Dockflow's own Traefik binds on control-plane nodes (design-04 2.2/2.4):
   * http = proxy.enabled, https = proxy.enabled && proxy.acme !== false. Never opened on agents.
   */
  proxyPorts: { http: boolean; https: boolean };
  /** servers first (servers.yml order), then agents (servers.yml order) */
  nodes: K3sNodeSpec[];
  requestedBackend: FlannelBackend | null;
  flags: K3sPlanFlags;
}

/** The cluster-mode flags of design-05 1.2 after defaults (built by the CLI layer). */
export interface K3sSetupOptions {
  sshUser: string;
  dryRun: boolean;
  yes: boolean;
  upgrade: boolean;
  convertDatastore: boolean;
  sharedCluster: boolean;
  /** raw `--flannel-backend` value, validated by buildClusterPlan */
  flannelBackend: string | null;
  skipFirewall: boolean;
  skipNetworkCheck: boolean;
  skipReachabilityCheck: boolean;
  insecureHostKey: boolean;
  requireHostKey: boolean;
  rotateDeployToken: boolean;
  binary: string | null;
  dev: boolean;
  /** stdin and stdout are a terminal */
  interactive: boolean;
}

export interface NodeStateFile {
  schema: 1;
  managedBy: 'dockflow';
  dockflowVersion: string;
  envs: string[];
  nodeName: string;
  /** `server` for the bootstrap and the joining servers alike; `clusterInit` tells them apart */
  role: 'server' | 'agent';
  clusterInit: boolean;
  datastore: Datastore | null;
  flannelBackend: FlannelBackend;
  k3sVersion: string;
  configSha256: string;
  restartSha256: string;
  caSha256: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface K3sNodeInspection {
  os: {
    id: string;
    versionId: string;
    kernel: string;
    arch: NodeArch;
    systemd: boolean;
    selinux: 'enforcing' | 'permissive' | 'disabled' | 'absent';
  };
  resources: { cpus: number; memoryBytes: number; varLibFreeBytes: number };
  network: { localIpv4: string[]; resolvedHost: string | null; defaultRouteIp: string | null };
  /** curl, tar, sha256sum, ip, systemctl, visudo; `packageManager` installs them in prepare */
  commands: { missing: string[]; packageManager: string | null };
  k3s: {
    /** `k3s --version` first line */
    binaryVersion: string | null;
    unit: 'k3s' | 'k3s-agent' | null;
    activeState: string | null;
    subState: string | null;
    managed: boolean;
    state: NodeStateFile | null;
    dropinSha256: string | null;
    /** recomputed from the drop-in on disk */
    restartSha256: string | null;
    /** the parsed 50-dockflow.yaml on disk (paths only, never a token), for drift (7.3) */
    dropin: Record<string, unknown> | null;
    /** config.yaml and other drop-ins */
    foreignConfig: { file: string; keys: string[] }[];
    /** names only */
    unitEnvK3sVars: string[];
    /** sha256 of the credential part */
    tokenFingerprints: { token: string | null; agentToken: string | null };
    caSha256: string | null;
    datastore: Datastore | null;
    /** servers: GET /readyz with the admin kubeconfig */
    apiReady: boolean | null;
    /** servers with apiReady: a dockflow-netcheck DaemonSet left behind by an interrupted setup */
    netcheckPresent: boolean | null;
    /** servers with apiReady: every StorageClass carrying the default annotation */
    defaultStorageClasses: { name: string; createdAt: string }[] | null;
  };
  helmVersion: string | null;
  firewall: { ufw: 'active' | 'inactive' | 'absent'; firewalld: 'running' | 'stopped' | 'absent' };
  portsInUse: { port: number; proto: 'tcp' | 'udp'; process: string }[];
  swarmActive: boolean;
  dockerPresent: boolean;
  nmCloudSetupEnabled: boolean;
  wireguardAvailable: boolean;
  /** 2 when /sys/fs/cgroup is the unified hierarchy */
  cgroupVersion: 1 | 2;
  cgroupMemory: boolean;
  ntpSynchronized: boolean | null;
  deployUser: { exists: boolean; uid: number | null; home: string | null; keyAuthorized: boolean };
  /** files containing the removed rules */
  legacySudoRules: string[];
}

/** Filled after inspection (finalizeClusterPlan). */
export interface K3sNodeNetwork {
  privateIp: string | null;
  publicIp: string | null;
  nodeIp: string | null;
  nodeExternalIp: string | null;
  /** addresses of all other nodes, sorted */
  peerSources: string[];
  /** addresses of the other servers, sorted (etcd rule) */
  serverPeerSources: string[];
  /** interfaces the pod/service CIDR rules are bound to: `cni0` and the flannel interface (F33, 14.1) */
  cniInterfaces: string[];
}

export interface NodeAction {
  kind: NodeActionKind;
  /** config keys whose change requires a restart (reconfigure, upgrade, convert-to-etcd) */
  changedKeys: string[];
  fromVersion: string | null;
  /** the version the node runs after this run */
  toVersion: string;
}

export interface Refusal {
  node: string | null;
  message: string;
  suggestion: string;
}

export interface PlanWarning {
  node: string | null;
  level: 'warn' | 'info';
  message: string;
  suggestion: string | null;
}

export interface K3sResolvedCluster {
  /**
   * The plan with resolved roles: on an existing cluster the node that bootstrapped it (sticky
   * cluster-init, or the SQLite server) is `server-init` and every other manager `server`, whatever
   * the servers.yml order.
   */
  plan: K3sClusterPlan;
  addressMode: AddressMode;
  flannelBackend: FlannelBackend;
  datastore: Datastore;
  fresh: boolean;
  clusterInitNode: string | null;
  network: Record<string, K3sNodeNetwork>;
  /**
   * `server:` of each node's drop-in: null only on the node that bootstraps the cluster (or when no
   * server answers). Nodes that install use it to join; joined nodes keep it for their restarts.
   */
  joinUrls: Record<string, string | null>;
  actions: Record<string, NodeAction>;
  refusals: Refusal[];
  warnings: PlanWarning[];
}

/** One element of `cluster.nodes` in a node plan. */
export interface K3sPlanNodeSummary {
  key: string;
  nodeName: string;
  role: K3sNodeRole;
  nodeIp: string | null;
  nodeLabels: Record<string, string>;
}

export interface DownloadPin {
  url: string;
  sha256: string;
}

/** The stdin document of one node operation (3.4); tokens only inside `install`. */
export interface K3sNodePlan {
  schema: 1;
  operation: NodeOperation;
  dockflowVersion: string;
  env: string;
  node: K3sNodeSpec;
  /** absent for inspect */
  cluster?: {
    addressMode: AddressMode;
    flannelBackend: FlannelBackend;
    datastore: Datastore;
    clusterInit: boolean;
    network: K3sNodeNetwork;
    joinUrl: string | null;
    action: NodeAction;
    proxyPorts: { http: boolean; https: boolean };
    /** chosen by the coordinator (14.0); the node step never picks the tool itself */
    firewallTool: FirewallTool | null;
    /** every plan node, for labels and verification */
    nodes: K3sPlanNodeSummary[];
    /** what the node saves before its binary or datastore changes (15.3, 15.4) */
    datastoreBackup: DatastoreBackup | null;
  };
  pins: {
    k3s: { version: string; binary: DownloadPin; installScript: DownloadPin };
    helm: { version: string; archive: DownloadPin } | null;
  };
  /** install only: joining servers get both, agents only the agent token */
  tokens: NodeTokens;
  options: {
    skipFirewall: boolean;
    skipNetworkCheck: boolean;
    rotateDeployToken: boolean;
    deleteVolumes: boolean;
    /** the coordinator already checked the acknowledgement; the node step records it in state.json */
    sharedCluster: boolean;
  };
}

// ---------------------------------------------------------------------------
// Addresses and versions
// ---------------------------------------------------------------------------

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_LABEL_MAX = 63;
// servers.yml key rule, reused for --node-name (1.2)
const SERVER_KEY = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;
// what useradd accepts and sudoers can name without escaping (2.1)
const LINUX_USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

/** RFC 1918 and carrier-grade NAT ranges (2.2). */
export function isPrivateIpv4(ip: string): boolean {
  return inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16) || inCidr(ip, '100.64.0.0', 10);
}

/** Loopback, link-local, this-network, multicast and broadcast addresses never carry cluster traffic. */
export function isUnusableClusterAddress(ip: string): boolean {
  return (
    inCidr(ip, '127.0.0.0', 8) ||
    inCidr(ip, '169.254.0.0', 16) ||
    inCidr(ip, '0.0.0.0', 8) ||
    inCidr(ip, '224.0.0.0', 4) ||
    ip === '255.255.255.255'
  );
}

function compareIps(a: string, b: string): number {
  return ipv4ToInt(a) - ipv4ToInt(b);
}

export interface K3sVersion {
  major: number;
  minor: number;
  patch: number;
  k3s: number;
  /** normalized: `v1.36.4+k3s1` */
  text: string;
}

/** Parses `k3s version v1.36.4+k3s1 (abcdef)` or a bare version (15.2). */
export function parseK3sVersion(text: string): K3sVersion | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)(?:[-+]k3s(\d+))?/.exec(text);
  if (match === null) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const k3s = match[4] === undefined ? 0 : Number(match[4]);
  return { major, minor, patch, k3s, text: `v${major}.${minor}.${patch}${match[4] === undefined ? '' : `+k3s${k3s}`}` };
}

export function compareK3sVersions(a: K3sVersion, b: K3sVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.k3s - b.k3s;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Flags and deploy keys
// ---------------------------------------------------------------------------

/** The raw flag combinations of design-05 2.1 / 19.1, as far as they can be checked without I/O. */
export interface K3sFlagSet {
  reset?: boolean;
  node?: readonly string[];
  deleteVolumes?: boolean;
  flannelBackend?: string | null;
  binary?: string | null;
  dev?: boolean;
  insecureHostKey?: boolean;
  requireHostKey?: boolean;
}

/** Throws ValidationError on a bad combination; returns the requested flannel backend. */
export function validateK3sFlags(flags: K3sFlagSet): FlannelBackend | null {
  if (!flags.reset) {
    if (flags.node !== undefined && flags.node.length > 0) throw new ValidationError(setupMessages.onlyWithReset('--node'));
    if (flags.deleteVolumes) throw new ValidationError(setupMessages.onlyWithReset('--delete-volumes'));
  }
  if (flags.binary && flags.dev) throw new ValidationError(setupMessages.binaryWithDev);
  if (flags.insecureHostKey && flags.requireHostKey) throw new ValidationError(setupMessages.hostKeyFlags);
  const backend = flags.flannelBackend ?? null;
  if (backend === null) return null;
  const known = FLANNEL_BACKENDS.find((b) => b === backend);
  if (known === undefined) throw new ValidationError(setupMessages.flannelBackendValue);
  return known;
}

/**
 * The authorized_keys line of a deploy private key (2.1, F29), or the reason it cannot be derived.
 * Encrypted keys are refused: setup never asks for the deploy key's passphrase.
 */
export function deployPublicKeyFor(privateKey: string): { line: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = sshUtils.parseKey(privateKey);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const key: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error) return { error: key.message };
  if (key === undefined || key === null || typeof key !== 'object') return { error: 'unrecognized key format' };
  const candidate = key as { isPrivateKey?: () => boolean; getPublicSSH?: () => Buffer; type?: string };
  if (typeof candidate.isPrivateKey !== 'function' || typeof candidate.getPublicSSH !== 'function') {
    return { error: 'unrecognized key format' };
  }
  if (!candidate.isPrivateKey()) return { error: 'this is a public key, not a private key' };
  return { line: `${candidate.type} ${candidate.getPublicSSH().toString('base64')} ${DEPLOY_KEY_COMMENT}` };
}

function raise(kind: typeof ConfigError | typeof ConnectionError, problem: SetupProblem): never {
  throw new kind(problem.message, problem.suggestion);
}

// ---------------------------------------------------------------------------
// buildClusterPlan (2.1)
// ---------------------------------------------------------------------------

export interface BuildClusterPlanInput {
  env: string;
  /** null when config.yml is absent */
  config: DockflowConfig | null;
  /** resolveServersForEnvironment(env): hosts after CI overrides, servers.yml order */
  servers: readonly ResolvedServer[];
  /** deploy private key per servers.yml key */
  deployKeys: Readonly<Record<string, string | undefined>>;
  options: K3sSetupOptions;
  dockflowVersion: string;
  /** environments servers.yml declares, for the no-server message */
  availableEnvironments?: readonly string[];
}

function hostParts(host: string): { hostIp: string | null; hostName: string | null } {
  if (isIpv4(host)) return { hostIp: host, hostName: null };
  // an IPv6 literal is neither: it is refused unless private_host gives the cluster address
  if (host.includes(':')) return { hostIp: null, hostName: null };
  return { hostIp: null, hostName: host };
}

function sortedRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort(compareCodeUnits)) out[key] = record[key];
  return out;
}

function flagsOf(options: K3sSetupOptions): K3sPlanFlags {
  return {
    sharedCluster: options.sharedCluster,
    skipFirewall: options.skipFirewall,
    skipNetworkCheck: options.skipNetworkCheck,
    rotateDeployToken: options.rotateDeployToken,
    convertDatastore: options.convertDatastore,
    interactive: options.interactive,
  };
}

/** servers.yml of one environment -> K3sClusterPlan; throws before any SSH (2.1). */
export function buildClusterPlan(input: BuildClusterPlanInput): K3sClusterPlan {
  const { env, config, options } = input;
  const requestedBackend = validateK3sFlags({
    flannelBackend: options.flannelBackend,
    binary: options.binary,
    dev: options.dev,
    insecureHostKey: options.insecureHostKey,
    requireHostKey: options.requireHostKey,
  });

  if (config !== null && (config.orchestrator ?? 'swarm') !== 'k3s') {
    raise(ConfigError, setupMessages.orchestratorNotK3s(env, config.orchestrator ?? 'swarm'));
  }

  const members = input.servers.filter((server) => server.tags.includes(env));
  if (members.length === 0) {
    const problem = setupMessages.noServers(env, input.availableEnvironments ?? []);
    throw new CLIError(problem.message, ErrorCode.NO_SERVERS_FOR_ENV, problem.suggestion);
  }
  if (!members.some((server) => server.role === 'manager')) raise(ConfigError, setupMessages.noManager(env));

  // the rules `dockflow validate <env>` and the MCP validator share (DESIGN-CORE 7.2)
  const topology: Record<string, TopologyServer> = {};
  for (const server of members) {
    topology[server.name] = { role: server.role, host: server.host, private_host: server.declaredPrivateHost ?? undefined, tags: server.tags };
  }
  const issue = k3sTopologyIssues(topology, env).find((i) => i.severity === 'error');
  if (issue !== undefined) throw new ConfigError(issue.message, issue.hint);

  const privateHostOwners = new Map<string, string>();
  for (const server of members) {
    const nodeName = nodeNameFor(server.name);
    if (nodeName.length > DNS_LABEL_MAX || !DNS_LABEL.test(nodeName)) raise(ConfigError, setupMessages.nodeNameInvalid(server.name, nodeName));

    const privateHost = server.declaredPrivateHost;
    if (privateHost !== null) {
      if (isIpv4(privateHost) && isUnusableClusterAddress(privateHost)) {
        raise(ConfigError, setupMessages.clusterAddressUnusable(server.name, privateHost));
      }
      const owner = privateHostOwners.get(privateHost);
      if (owner !== undefined) raise(ConfigError, setupMessages.duplicatePrivateHost(owner, server.name, privateHost));
      privateHostOwners.set(privateHost, server.name);
    } else if (isIpv4(server.host) && isUnusableClusterAddress(server.host)) {
      raise(ConfigError, setupMessages.clusterAddressUnusable(server.name, server.host));
    } else if (server.host.toLowerCase() === 'localhost') {
      raise(ConfigError, setupMessages.hostIsLocalhost(server.name));
    }
  }

  // Embedded etcd needs the servers on a private network (DV-S1). A public IPv4 host without
  // private_host can never provide one; a host name is only known once resolved on the node (2.2).
  const managers = members.filter((server) => server.role === 'manager');
  const publicOnly = managers
    .filter((server) => server.declaredPrivateHost === null && isIpv4(server.host) && !isPrivateIpv4(server.host))
    .map((server) => server.name);
  if (managers.length > 1 && publicOnly.length > 0) raise(ConfigError, setupMessages.haNeedsPrivateNetwork(publicOnly));

  const specs: K3sNodeSpec[] = [];
  for (const server of members) {
    const privateKey = input.deployKeys[server.name];
    if (privateKey === undefined || privateKey.trim() === '') raise(ConnectionError, setupMessages.deployKeyMissing(env, server.name));
    if (!LINUX_USER_NAME.test(server.user)) raise(ConfigError, setupMessages.deployUserInvalid(server.name, server.user));
    const derived = deployPublicKeyFor(privateKey);
    if ('error' in derived) raise(ConfigError, setupMessages.deployKeyUnparseable(server.name, derived.error));

    specs.push({
      key: server.name,
      nodeName: nodeNameFor(server.name),
      role: server.role === 'manager' ? 'server' : 'agent',
      ssh: { host: server.host, port: server.port },
      deployUser: server.user,
      deployPublicKey: derived.line,
      privateHost: server.declaredPrivateHost,
      ...hostParts(server.host),
      nodeLabels: sortedRecord(server.nodeLabels),
    });
  }

  const servers = specs.filter((spec) => spec.role !== 'agent');
  servers[0] = { ...servers[0], role: 'server-init' };
  const proxy = config?.proxy;
  const http = proxy?.enabled === true;
  return {
    schema: 1,
    env,
    project: config?.project_name ?? null,
    dockflowVersion: input.dockflowVersion,
    proxyPorts: { http, https: http && proxy?.acme !== false },
    nodes: [...servers, ...specs.filter((spec) => spec.role === 'agent')],
    requestedBackend,
    flags: flagsOf(options),
  };
}

/** The server/agent order of a run (3.2): servers one at a time, bootstrap server first; agents in parallel. */
export function installSequence(plan: K3sClusterPlan): { servers: K3sNodeSpec[]; agents: K3sNodeSpec[]; agentConcurrency: number } {
  const servers = plan.nodes.filter((node) => node.role !== 'agent');
  const init = servers.filter((node) => node.role === 'server-init');
  return {
    servers: [...init, ...servers.filter((node) => node.role !== 'server-init')],
    agents: plan.nodes.filter((node) => node.role === 'agent'),
    agentConcurrency: SETUP_PARALLEL_NODES,
  };
}

// ---------------------------------------------------------------------------
// buildLocalPlan (4.8)
// ---------------------------------------------------------------------------

/** Default `--node-name`: the short host name through nodeNameFor (1.2). */
export function localNodeNameFor(hostname: string): string {
  return nodeNameFor(hostname.split('.')[0] ?? hostname);
}

export interface LocalPlanInput {
  nodeName: string;
  deployUser: string;
  deployPublicKey: string | null;
  privateHost: string | null;
  publicHost: string | null;
  requestedBackend: FlannelBackend | null;
  dockflowVersion: string;
  sshPort?: number;
  flags?: Partial<K3sPlanFlags>;
}

/** The plan of `dockflow setup --orchestrator k3s` on one host: a single bootstrap server. */
export function buildLocalPlan(input: LocalPlanInput): K3sClusterPlan {
  if (!SERVER_KEY.test(input.nodeName) || input.nodeName.length > DNS_LABEL_MAX) {
    const problem = setupMessages.localNodeNameInvalid(input.nodeName);
    throw new ValidationError(problem.message, problem.suggestion);
  }
  if (!LINUX_USER_NAME.test(input.deployUser)) {
    const problem = setupMessages.localDeployUserInvalid(input.deployUser);
    throw new ValidationError(problem.message, problem.suggestion);
  }
  if (input.privateHost !== null && (!isIpv4(input.privateHost) || isUnusableClusterAddress(input.privateHost))) {
    const problem = setupMessages.localPrivateHostInvalid(input.privateHost);
    throw new ValidationError(problem.message, problem.suggestion);
  }
  const host = input.publicHost ?? 'localhost';
  const flags: K3sPlanFlags = {
    sharedCluster: false,
    skipFirewall: false,
    // one node: there is no cross-node path to check
    skipNetworkCheck: true,
    rotateDeployToken: false,
    convertDatastore: false,
    interactive: false,
    ...input.flags,
  };
  return {
    schema: 1,
    env: '',
    project: null,
    dockflowVersion: input.dockflowVersion,
    proxyPorts: { http: false, https: false },
    nodes: [
      {
        key: input.nodeName,
        nodeName: nodeNameFor(input.nodeName),
        role: 'server-init',
        ssh: { host, port: input.sshPort ?? 22 },
        deployUser: input.deployUser,
        deployPublicKey: input.deployPublicKey,
        privateHost: input.privateHost,
        ...(input.publicHost === null ? { hostIp: null, hostName: null } : hostParts(input.publicHost)),
        nodeLabels: {},
      },
    ],
    requestedBackend: input.requestedBackend,
    flags,
  };
}

// ---------------------------------------------------------------------------
// finalizeClusterPlan (2.2, 4.1, 4.2)
// ---------------------------------------------------------------------------

interface NodeAddresses {
  privateIp: string | null;
  publicIp: string | null;
  /** a host name that resolved to loopback on the node */
  loopback: string | null;
}

function addressesOf(node: K3sNodeSpec, inspection: K3sNodeInspection): NodeAddresses {
  const resolvedRaw = node.hostName !== null ? inspection.network.resolvedHost : null;
  const resolvedIp = resolvedRaw !== null && isIpv4(resolvedRaw) ? resolvedRaw : null;
  const resolved = resolvedIp !== null && !isUnusableClusterAddress(resolvedIp) ? resolvedIp : null;
  const hostIp = node.hostIp !== null && !isUnusableClusterAddress(node.hostIp) ? node.hostIp : null;
  const privateOf = (ip: string | null): string | null => (ip !== null && isPrivateIpv4(ip) ? ip : null);
  const publicOf = (ip: string | null): string | null => (ip !== null && !isPrivateIpv4(ip) ? ip : null);
  return {
    privateIp: node.privateHost ?? privateOf(hostIp) ?? privateOf(resolved),
    publicIp: publicOf(hostIp) ?? publicOf(resolved),
    loopback: resolvedIp !== null && resolved === null ? resolvedIp : null,
  };
}

const K3S_PROCESS = /^k3s/;

function isForeignProcess(process: string): boolean {
  return !K3S_PROCESS.test(process);
}

function portsFor(role: K3sNodeRole, backend: FlannelBackend): { port: number; proto: 'tcp' | 'udp' }[] {
  const flannel = backend === 'vxlan' ? { port: 8472, proto: 'udp' as const } : { port: 51820, proto: 'udp' as const };
  if (role === 'agent') return [{ port: 10250, proto: 'tcp' }, flannel];
  return [
    { port: K3S_API_PORT, proto: 'tcp' },
    { port: 10250, proto: 'tcp' },
    { port: 2379, proto: 'tcp' },
    { port: 2380, proto: 'tcp' },
    flannel,
  ];
}

const RHEL_FAMILY = new Set(['rhel', 'centos', 'rocky', 'almalinux', 'ol']);

function isRhelBefore84(os: K3sNodeInspection['os']): boolean {
  if (!RHEL_FAMILY.has(os.id)) return false;
  const [major, minor] = os.versionId.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  return major < 8 || (major === 8 && (Number.isFinite(minor) ? minor : 0) < 4);
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function firewallReason(inspection: K3sNodeInspection, skip: boolean): string | null {
  if (skip) return '--skip-firewall';
  const reasons: string[] = [];
  if (inspection.firewall.ufw === 'inactive') reasons.push('ufw is installed but inactive');
  if (inspection.firewall.firewalld === 'stopped') reasons.push('firewalld is installed but stopped');
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function isRunning(inspection: K3sNodeInspection): boolean {
  return inspection.k3s.activeState === 'active' && inspection.k3s.subState === 'running';
}

function isReadyServer(inspection: K3sNodeInspection): boolean {
  return inspection.k3s.managed && inspection.k3s.activeState === 'active' && inspection.k3s.apiReady === true;
}

function installedDatastore(inspection: K3sNodeInspection): Datastore | null {
  return inspection.k3s.datastore ?? inspection.k3s.state?.datastore ?? null;
}

function pluralKeys(keys: readonly string[]): string {
  return `${keys.join(', ')} ${keys.length === 1 ? 'has' : 'have'} no private_host`;
}

function unresolved(plan: K3sClusterPlan, refusals: Refusal[]): K3sResolvedCluster {
  const network: Record<string, K3sNodeNetwork> = {};
  const joinUrls: Record<string, string | null> = {};
  const actions: Record<string, NodeAction> = {};
  for (const node of plan.nodes) {
    network[node.key] = {
      privateIp: null,
      publicIp: null,
      nodeIp: null,
      nodeExternalIp: null,
      peerSources: [],
      serverPeerSources: [],
      cniInterfaces: [],
    };
    joinUrls[node.key] = null;
    actions[node.key] = { kind: 'noop', changedKeys: [], fromVersion: null, toVersion: K3S_PIN.version };
  }
  return {
    plan,
    addressMode: 'private',
    flannelBackend: plan.requestedBackend ?? 'vxlan',
    datastore: 'sqlite',
    fresh: true,
    clusterInitNode: null,
    network,
    joinUrls,
    actions,
    refusals,
    warnings: [],
  };
}

/** Decides addresses, pod network, datastore, join URLs and each node's action from the inspections. */
export function finalizeClusterPlan(
  plan: K3sClusterPlan,
  inspections: Readonly<Record<string, K3sNodeInspection | undefined>>,
): K3sResolvedCluster {
  const missing = plan.nodes.filter((node) => inspections[node.key] === undefined);
  if (missing.length > 0) {
    return unresolved(
      plan,
      missing.map((node) => ({ node: node.key, ...setupMessages.inspectionMissing(node.key) })),
    );
  }
  const inspectionOf = (key: string): K3sNodeInspection => inspections[key] as K3sNodeInspection;
  const { env } = plan;
  const refusals: Refusal[] = [];
  const warnings: PlanWarning[] = [];
  const refuse = (node: string | null, problem: SetupProblem): void => {
    refusals.push({ node, message: problem.message, suggestion: problem.suggestion });
  };
  const warn = (node: string | null, message: string, suggestion: string | null = null, level: 'warn' | 'info' = 'warn'): void => {
    warnings.push({ node, level, message, suggestion });
  };

  // Addresses and address mode (2.2)
  const addresses = new Map<string, NodeAddresses>();
  const unaddressed = new Set<string>();
  for (const node of plan.nodes) {
    const found = addressesOf(node, inspectionOf(node.key));
    addresses.set(node.key, found);
    if (found.privateIp === null && found.publicIp === null) {
      unaddressed.add(node.key);
      if (found.loopback !== null && node.hostName !== null) {
        refuse(node.key, setupMessages.hostResolvesToLoopback(node.key, node.hostName, found.loopback));
      } else {
        refuse(node.key, setupMessages.noReachableAddress(node.key));
      }
    }
  }
  const addressOf = (key: string): NodeAddresses => addresses.get(key) as NodeAddresses;
  const addressMode: AddressMode = plan.nodes.every((node) => addressOf(node.key).privateIp !== null) ? 'private' : 'public';
  const withoutPrivate = plan.nodes.filter((node) => addressOf(node.key).privateIp === null).map((node) => node.key);
  const serverNodes = plan.nodes.filter((node) => node.role !== 'agent');
  if (addressMode === 'public') {
    for (const node of plan.nodes) {
      if (unaddressed.has(node.key) || addressOf(node.key).publicIp !== null) continue;
      refuse(node.key, setupMessages.noPublicAddress(node.key, withoutPrivate));
    }
    const privatelessServers = serverNodes.filter((node) => addressOf(node.key).privateIp === null).map((node) => node.key);
    if (serverNodes.length > 1 && privatelessServers.length > 0) refuse(null, setupMessages.haNeedsPrivateNetwork(privatelessServers));
  }

  // Existing cluster, pod network and datastore
  const managed = plan.nodes.filter((node) => inspectionOf(node.key).k3s.managed);
  const fresh = managed.length === 0;
  const computedBackend: FlannelBackend = addressMode === 'private' ? 'vxlan' : 'wireguard-native';
  let flannelBackend: FlannelBackend = plan.requestedBackend ?? computedBackend;
  let backendReason = plan.requestedBackend !== null ? '--flannel-backend' : pluralKeys(withoutPrivate);
  let backendRefused = false;
  if (!fresh) {
    const installed = managed.map((node) => inspectionOf(node.key).k3s.state?.flannelBackend).find((b) => b !== undefined);
    if (installed !== undefined) {
      if (plan.requestedBackend !== null && plan.requestedBackend !== installed) {
        backendRefused = true;
        refuse(null, setupMessages.flannelChange(env, installed, plan.requestedBackend, '--flannel-backend'));
      } else if (plan.requestedBackend === null && installed === 'vxlan' && computedBackend === 'wireguard-native' && plan.nodes.length > 1) {
        // one node has no pod traffic to protect; with several, public addresses need WireGuard
        backendRefused = true;
        refuse(null, setupMessages.flannelChange(env, installed, computedBackend, pluralKeys(withoutPrivate)));
      }
      flannelBackend = installed;
      backendReason = plan.requestedBackend !== null ? '--flannel-backend' : addressMode === 'public' ? pluralKeys(withoutPrivate) : 'every node has a private_host';
    }
  }

  const managedServers = serverNodes.filter((node) => inspectionOf(node.key).k3s.managed);
  const datastore: Datastore =
    serverNodes.length > 1 || managedServers.some((node) => installedDatastore(inspectionOf(node.key)) === 'etcd') ? 'etcd' : 'sqlite';

  // The node that bootstraps the cluster, and cluster-init (sticky on an existing cluster)
  let initNode: string | null;
  let clusterInitNode: string | null;
  if (fresh) {
    initNode = serverNodes.find((node) => node.role === 'server-init')?.key ?? serverNodes[0]?.key ?? null;
    clusterInitNode = serverNodes.length > 1 ? initNode : null;
  } else {
    const sticky = managedServers.find((node) => inspectionOf(node.key).k3s.state?.clusterInit === true)?.key ?? null;
    const sqlite = managedServers.find((node) => installedDatastore(inspectionOf(node.key)) === 'sqlite')?.key ?? null;
    initNode = sticky ?? sqlite;
    clusterInitNode = sticky ?? (datastore === 'etcd' ? sqlite : null);
  }
  const nodes: K3sNodeSpec[] = plan.nodes.map((node) => {
    if (node.role === 'agent') return node;
    return { ...node, role: node.key === initNode ? 'server-init' : 'server' };
  });
  const resolvedPlan: K3sClusterPlan = { ...plan, nodes };

  // Network of each node
  const network: Record<string, K3sNodeNetwork> = {};
  for (const node of nodes) {
    const own = addressOf(node.key);
    const local = inspectionOf(node.key).network.localIpv4;
    const peersOf = (candidates: readonly K3sNodeSpec[]): string[] => {
      const found = new Set<string>();
      for (const other of candidates) {
        if (other.key === node.key) continue;
        const theirs = addressOf(other.key);
        if (theirs.privateIp !== null) found.add(theirs.privateIp);
        if (theirs.publicIp !== null) found.add(theirs.publicIp);
      }
      return [...found].sort(compareIps);
    };
    network[node.key] = {
      privateIp: own.privateIp,
      publicIp: own.publicIp,
      nodeIp: own.privateIp ?? (own.publicIp !== null && local.includes(own.publicIp) ? own.publicIp : null),
      nodeExternalIp: addressMode === 'public' ? own.publicIp : null,
      peerSources: peersOf(nodes),
      serverPeerSources: peersOf(nodes.filter((other) => other.role !== 'agent')),
      cniInterfaces: [CNI_BRIDGE_IFACE, FLANNEL_IFACE[flannelBackend]],
    };
  }

  // Join URLs: the bootstrap server of a fresh cluster, else the first ready managed server
  const joinCandidates = fresh
    ? nodes.filter((node) => node.key === initNode)
    : nodes.filter((node) => node.role !== 'agent' && isReadyServer(inspectionOf(node.key)));
  const joinUrl = (server: K3sNodeSpec, joiner: K3sNodeSpec): string | null => {
    const theirs = addressOf(server.key);
    const address = addressMode === 'public' && joiner.role === 'agent' ? theirs.publicIp : theirs.privateIp;
    return address === null ? null : `https://${address}:${K3S_API_PORT}`;
  };
  const joinUrls: Record<string, string | null> = {};
  for (const node of nodes) {
    const server = node.key === initNode ? undefined : joinCandidates.find((candidate) => candidate.key !== node.key);
    joinUrls[node.key] = server === undefined ? null : joinUrl(server, node);
  }

  // Actions (4.2)
  const pin = parseK3sVersion(K3S_PIN.version) as K3sVersion;
  const minimum = parseK3sVersion(K3S_PIN.minimumServerVersion) as K3sVersion;
  const caVotes = new Map<string, number>();
  for (const node of managedServers) {
    const ca = inspectionOf(node.key).k3s.caSha256;
    if (ca !== null) caVotes.set(ca, (caVotes.get(ca) ?? 0) + 1);
  }
  let clusterCa: string | null = null;
  for (const [ca, votes] of caVotes) {
    if (clusterCa === null || votes > (caVotes.get(clusterCa) ?? 0)) clusterCa = ca;
  }

  const renders = new Map<string, RenderedK3sConfig>();
  const actions: Record<string, NodeAction> = {};
  const serverVersionsAfter: K3sVersion[] = [];
  const refusedNodes = new Set<string>();
  for (const node of nodes) {
    const inspection = inspectionOf(node.key);
    const { k3s } = inspection;
    const render = renderK3sConfig(node, {
      env,
      addressMode,
      flannelBackend,
      clusterInit: node.key === clusterInitNode,
      network: network[node.key],
      joinUrl: joinUrls[node.key],
    });
    renders.set(node.key, render);

    const installed = k3s.binaryVersion === null ? null : parseK3sVersion(k3s.binaryVersion);
    const action = (kind: NodeActionKind, changedKeys: string[] = [], after: K3sVersion | null = pin): NodeAction => ({
      kind,
      changedKeys,
      fromVersion: installed?.text ?? null,
      toVersion: (after ?? pin).text,
    });
    const problems: SetupProblem[] = [];
    let decided: NodeAction | null = null;
    const state = k3s.state;
    const family = node.role === 'agent' ? 'agent' : 'server';

    if (k3s.binaryVersion === null && k3s.unit === null && state === null) decided = action('install');
    else if (state === null) problems.push(setupMessages.unmanagedK3s(node.key, env));
    else if (k3s.binaryVersion === null) decided = action('repair');
    else if (state.role !== family) problems.push(setupMessages.roleChanged(node.key, state.role, family === 'agent' ? 'worker' : 'manager', env));
    else if (state.nodeName !== node.nodeName) problems.push(setupMessages.nodeRenamed(node.key, state.nodeName, node.nodeName));
    else if (k3s.caSha256 !== null && clusterCa !== null && k3s.caSha256 !== clusterCa) {
      problems.push(setupMessages.foreignCluster(node.key, k3s.caSha256, clusterCa));
    } else if (installed === null) problems.push(setupMessages.unknownVersion(node.key, k3s.binaryVersion));
    else if (compareK3sVersions(installed, pin) > 0) {
      problems.push(setupMessages.downgrade(node.key, installed.text, pin.text, plan.dockflowVersion));
    } else if (installed.major !== pin.major || compareK3sVersions(installed, minimum) < 0 || pin.minor - installed.minor > 1) {
      problems.push(setupMessages.minorSkip(node.key, installed.text, pin.text, installed.minor + 1));
    } else if (node.role === 'agent' && serverVersionsAfter.some((server) => compareK3sVersions(installed, server) > 0)) {
      problems.push(setupMessages.agentNewerThanServers(node.key));
    } else {
      const installedStore = installedDatastore(inspection);
      const drift =
        k3s.dropin === null
          ? { refusals: [], restart: Object.keys(render.restartKeys), rewrite: [], convertToEtcd: false }
          : classifyConfigDrift({
              key: node.key,
              env,
              etcdMember: node.role !== 'agent' && installedStore === 'etcd',
              sqliteInit: node.key === initNode && installedStore === 'sqlite',
              existing: k3s.dropin,
              rendered: render.values,
              backendReason,
              // the cluster-level refusal already names the pod network change
              ignore: backendRefused ? ['flannel-backend', 'flannel-external-ip'] : [],
            });
      // A refuse-class drift is refused whatever the version, and the one-way conversion wins over an
      // upgrade so it is never applied without its own consent (15.5); the upgrade follows next run.
      if (drift.refusals.length > 0) problems.push(...drift.refusals);
      else if (node.key === clusterInitNode && installedStore === 'sqlite' && datastore === 'etcd') {
        decided = action('convert-to-etcd', drift.restart, installed);
      } else if (compareK3sVersions(installed, pin) < 0) decided = action('upgrade', drift.restart);
      else if (drift.restart.length > 0) decided = action('reconfigure', drift.restart, installed);
      else if (!isRunning(inspection)) decided = action('start', [], installed);
      else decided = action('noop', [], installed);
    }

    for (const problem of problems) refuse(node.key, problem);
    if (decided === null) {
      refusedNodes.add(node.key);
      decided = action('noop', [], installed);
    }
    actions[node.key] = decided;
    if (node.role !== 'agent' && !refusedNodes.has(node.key)) {
      const after = parseK3sVersion(decided.toVersion);
      if (after !== null) serverVersionsAfter.push(after);
    }
  }

  // Preflight (4.1)
  const otherEnvs = new Set<string>();
  const foreignDefaults = new Set<string>();
  let netcheckLeft = false;
  for (const node of nodes) {
    const inspection = inspectionOf(node.key);
    const isServer = node.role !== 'agent';
    const kind = actions[node.key].kind;

    if (!inspection.os.systemd) refuse(node.key, setupMessages.noSystemd(node.key));
    if (inspection.commands.missing.length > 0 && inspection.commands.packageManager === null) {
      refuse(node.key, setupMessages.missingCommands(node.key, inspection.commands.missing));
    }
    // v1 first: its memory controller is usually enabled, and the fix is the hierarchy, not a kernel flag
    if (inspection.cgroupVersion === 1) refuse(node.key, setupMessages.cgroupV1(node.key));
    else if (!inspection.cgroupMemory) refuse(node.key, setupMessages.cgroupMemory(node.key));
    if (inspection.swarmActive) refuse(node.key, setupMessages.swarmActive(node.key));
    if (inspection.nmCloudSetupEnabled && isRhelBefore84(inspection.os)) refuse(node.key, setupMessages.nmCloudSetup(node.key));

    if ((kind === 'install' || kind === 'repair') && !refusedNodes.has(node.key)) {
      for (const wanted of portsFor(node.role, flannelBackend)) {
        const holder = inspection.portsInUse.find((p) => p.port === wanted.port && p.proto === wanted.proto && isForeignProcess(p.process));
        if (holder !== undefined) refuse(node.key, setupMessages.portInUse(node.key, holder.port, holder.proto, holder.process || 'an unknown process'));
      }
    }
    if (isServer) {
      const proxyPorts = [...(plan.proxyPorts.http ? [80] : []), ...(plan.proxyPorts.https ? [443] : [])];
      for (const port of proxyPorts) {
        const holder = inspection.portsInUse.find((p) => p.port === port && p.proto === 'tcp' && isForeignProcess(p.process));
        if (holder !== undefined) refuse(node.key, setupMessages.proxyPortInUse(node.key, port, holder.process || 'an unknown process'));
      }
    }

    const others = (inspection.k3s.state?.envs ?? []).filter((other) => other !== env && other !== '');
    for (const other of others) otherEnvs.add(other);
    if (others.length > 0 && !plan.flags.sharedCluster) refuse(node.key, setupMessages.otherEnvironment(node.key, others.join(', '), env));

    const { ufw, firewalld } = inspection.firewall;
    if (ufw === 'active' && firewalld === 'running' && !plan.flags.skipFirewall) {
      refuse(node.key, setupMessages.bothFirewalls(node.key));
    } else if (plan.flags.skipFirewall || (ufw !== 'active' && firewalld !== 'running')) {
      const problem = setupMessages.noFirewall(node.key, env, firewallReason(inspection, plan.flags.skipFirewall));
      warn(node.key, problem.message, problem.suggestion);
    }

    const { privateIp } = network[node.key];
    if (privateIp !== null && !inspection.network.localIpv4.includes(privateIp)) {
      refuse(node.key, setupMessages.privateIpNotLocal(node.key, privateIp));
    }
    if (flannelBackend === 'wireguard-native' && !inspection.wireguardAvailable) refuse(node.key, setupMessages.wireguardMissing(node.key));

    const managedKeys = new Set(MANAGED_CONFIG_KEYS);
    for (const foreign of inspection.k3s.foreignConfig) {
      const clashing = foreign.keys.filter((k) => managedKeys.has(k)).sort(compareCodeUnits);
      const other = foreign.keys.filter((k) => !managedKeys.has(k)).sort(compareCodeUnits);
      if (clashing.length > 0) refuse(node.key, setupMessages.foreignConfigManaged(foreign.file, node.key, clashing));
      if (other.length > 0) warn(node.key, setupMessages.foreignConfigOther(foreign.file, node.key, other));
    }
    if (inspection.k3s.unitEnvK3sVars.length > 0) {
      const unit = inspection.k3s.unit ?? (isServer ? 'k3s' : 'k3s-agent');
      warn(node.key, setupMessages.unitEnvOverrides(unit, node.key, inspection.k3s.unitEnvK3sVars));
    }

    const { cpus, memoryBytes, varLibFreeBytes } = inspection.resources;
    if (isServer && (memoryBytes < SERVER_MIN_MEMORY_BYTES || cpus < SERVER_MIN_CPUS)) {
      warn(node.key, setupMessages.lowResourcesServer(node.key, `${gib(memoryBytes)} GiB`, `${cpus} ${cpus === 1 ? 'CPU' : 'CPUs'}`));
    } else if (!isServer && memoryBytes < AGENT_MIN_MEMORY_BYTES) {
      warn(node.key, setupMessages.lowResourcesAgent(node.key, `${gib(memoryBytes)} GiB`));
    }
    if (varLibFreeBytes < VAR_LIB_MIN_FREE_BYTES) warn(node.key, setupMessages.lowDisk(node.key, gib(varLibFreeBytes)));
    if (isServer && inspection.ntpSynchronized === false) warn(node.key, setupMessages.clockNotSynchronized(node.key));
    if (inspection.dockerPresent) warn(node.key, setupMessages.dockerPresent(node.key));
    if (inspection.os.selinux === 'enforcing') warn(node.key, setupMessages.selinuxEnforcing(node.key), null, 'info');

    if (isServer && inspection.k3s.netcheckPresent === true) netcheckLeft = true;
    for (const storageClass of isServer ? (inspection.k3s.defaultStorageClasses ?? []) : []) {
      if (storageClass.name !== K8S_STORAGE_CLASS && storageClass.name !== LOCAL_PATH_STORAGE_CLASS) foreignDefaults.add(storageClass.name);
    }
    if (kind === 'convert-to-etcd' && !plan.flags.interactive && !plan.flags.convertDatastore) {
      refuse(node.key, setupMessages.convertNeedsConsent(env, node.key));
    }
  }

  // Cluster-level rows
  for (const name of [...foreignDefaults].sort(compareCodeUnits)) refuse(null, setupMessages.foreignDefaultStorageClass(env, name));
  const joiners = nodes.filter((node) => {
    const kind = actions[node.key].kind;
    return (kind === 'install' || kind === 'repair') && node.key !== initNode && !refusedNodes.has(node.key);
  });
  if (!fresh && joiners.length > 0 && joinCandidates.length === 0) {
    refuse(null, setupMessages.noServerAnswering(env, managedServers.map((node) => node.key)));
  }
  if (netcheckLeft) {
    const problem = setupMessages.netcheckLeftOver(env);
    warn(null, problem.message, problem.suggestion);
  }
  if (otherEnvs.size > 0 && plan.flags.sharedCluster) {
    warn(null, setupMessages.sharedCluster([...new Set([...otherEnvs, env])].sort(compareCodeUnits)));
  }

  const order = new Map(nodes.map((node, index) => [node.key, index]));
  const rank = (node: string | null): number => (node === null ? nodes.length : (order.get(node) ?? nodes.length));
  refusals.sort((a, b) => rank(a.node) - rank(b.node));
  warnings.sort((a, b) => rank(a.node) - rank(b.node));

  return {
    plan: resolvedPlan,
    addressMode,
    flannelBackend,
    datastore,
    fresh,
    clusterInitNode,
    network,
    joinUrls,
    actions,
    refusals,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// buildNodePlan (2.3, 3.4)
// ---------------------------------------------------------------------------

export interface NodePlanRequest {
  operation: NodeOperation;
  /** servers.yml key */
  node: string;
  /** from `uname -m` on the node (3.3) */
  arch: NodeArch;
  /** inspect: the plan of buildClusterPlan */
  plan: K3sClusterPlan;
  /** every other operation */
  cluster?: K3sResolvedCluster;
  /** install only; read from the first server or issued by the bootstrap install */
  tokens?: ClusterTokens | null;
  firewallTool?: FirewallTool | null;
  deleteVolumes?: boolean;
}

/** The server that saves the pre-upgrade etcd snapshot: the first to upgrade, bootstrap server first (15.3). */
export function firstUpgradingServer(cluster: K3sResolvedCluster): string | null {
  const servers = installSequence(cluster.plan).servers;
  return servers.find((node) => cluster.actions[node.key]?.kind === 'upgrade')?.key ?? null;
}

/** An etcd snapshot, or a copy of the SQLite `db` directory taken with k3s stopped; named `dockflow-pre-<to version>`. */
export interface DatastoreBackup {
  kind: 'etcd-snapshot' | 'sqlite-copy';
  name: string;
}

/**
 * 15.3 / 15.4: the first server to upgrade saves its datastore before its binary changes, and the
 * SQLite server a conversion to etcd changes saves its `db` directory first; every other node, none.
 */
export function datastoreBackupFor(cluster: K3sResolvedCluster, key: string): DatastoreBackup | null {
  const action = cluster.actions[key];
  if (action === undefined) return null;
  const name = `dockflow-pre-${action.toVersion.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  if (action.kind === 'convert-to-etcd') return { kind: 'sqlite-copy', name };
  if (action.kind !== 'upgrade' || firstUpgradingServer(cluster) !== key) return null;
  return { kind: cluster.datastore === 'etcd' ? 'etcd-snapshot' : 'sqlite-copy', name };
}

/** Where a `sqlite-copy` backup lives: beside the `db` directory it copies (`db-dockflow-pre-<version>`). */
export function sqliteCopyPath(name: string): string {
  return `${K3S_SQLITE_DB_DIR}-${name}`;
}

function pinOf(download: DownloadPin): DownloadPin {
  return { url: download.url, sha256: download.sha256 };
}

/** The stdin document of one node operation. Only `install` carries tokens, and only the ones the role needs. */
export function buildNodePlan(request: NodePlanRequest): K3sNodePlan {
  const cluster = request.cluster;
  if (request.operation !== 'inspect' && cluster === undefined) {
    throw new Error(`The ${request.operation} plan of ${request.node} needs the resolved cluster`);
  }
  const source = cluster?.plan ?? request.plan;
  const node = source.nodes.find((candidate) => candidate.key === request.node);
  if (node === undefined) throw new Error(`${request.node} is not a node of this plan`);

  const nodePlan: K3sNodePlan = {
    schema: 1,
    operation: request.operation,
    dockflowVersion: source.dockflowVersion,
    env: source.env,
    node: { ...node, ssh: { ...node.ssh }, nodeLabels: { ...node.nodeLabels } },
    pins: {
      k3s: { version: K3S_PIN.version, binary: pinOf(K3S_PIN.binaries[request.arch]), installScript: pinOf(K3S_PIN.installScript) },
      helm: node.role === 'agent' ? null : { version: HELM_PIN.version, archive: pinOf(HELM_PIN.archives[request.arch]) },
    },
    tokens: request.operation === 'install' ? tokensFor(node.role, request.tokens ?? null) : { ...NO_TOKENS },
    options: {
      skipFirewall: source.flags.skipFirewall,
      skipNetworkCheck: source.flags.skipNetworkCheck,
      rotateDeployToken: source.flags.rotateDeployToken,
      deleteVolumes: request.deleteVolumes ?? false,
      sharedCluster: source.flags.sharedCluster,
    },
  };
  if (request.operation !== 'inspect' && cluster !== undefined) {
    nodePlan.cluster = {
      addressMode: cluster.addressMode,
      flannelBackend: cluster.flannelBackend,
      datastore: cluster.datastore,
      clusterInit: cluster.clusterInitNode === node.key,
      network: { ...cluster.network[node.key] },
      joinUrl: cluster.joinUrls[node.key] ?? null,
      action: { ...cluster.actions[node.key], changedKeys: [...cluster.actions[node.key].changedKeys] },
      proxyPorts: { ...source.proxyPorts },
      firewallTool: request.firewallTool ?? null,
      nodes: source.nodes.map((n) => ({
        key: n.key,
        nodeName: n.nodeName,
        role: n.role,
        nodeIp: cluster.network[n.key]?.nodeIp ?? null,
        nodeLabels: { ...n.nodeLabels },
      })),
      datastoreBackup: datastoreBackupFor(cluster, node.key),
    };
  }
  return nodePlan;
}
