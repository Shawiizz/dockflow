// Messages of k3s provisioning (design-05 2, 4.1, 4.2, 4.6, 7.3, 12.5, 15.5, 17.2), one builder per
// message so the setup code and its tests share every text. Style of DESIGN-CORE 8.1: the message is
// one sentence without a trailing period, the suggestion full imperative sentences. User-facing
// names are servers.yml keys.

import { serverNameToEnvKey } from '../../../utils/servers/ci-secrets';
import { K3S_BINARY, K3S_SQLITE_DB_DIR } from './constants';

export interface SetupProblem {
  message: string;
  suggestion: string;
}

const LINUX_USER_NAME_HINT =
  'Use a user name of lowercase letters, digits, `_` and `-` that starts with a letter or `_` (at most 32 characters).';

function list(items: readonly string[]): string {
  return items.join(', ');
}

export const setupMessages = {
  // Flag combinations (ValidationError, design-05 2.1 and 19.1)
  onlyWithReset: (flag: string): string => `${flag} is only valid with --reset`,
  flannelBackendValue: '--flannel-backend must be vxlan or wireguard-native',
  binaryWithDev: '--binary and --dev cannot be combined',
  hostKeyFlags: '--insecure-host-key and --require-host-key cannot be combined',
  binaryInvalid: (path: string): SetupProblem => ({
    message: `--binary ${path} is not a Linux Dockflow binary`,
    suggestion: 'Point `--binary` at a compiled Linux binary of the same Dockflow version, or drop the flag to download the release.',
  }),
  passwordNeedsHostKey: (keys: readonly string[]): SetupProblem => ({
    message: `Password bootstrap needs a recorded SSH host key for ${list(keys)} when no terminal can confirm it`,
    suggestion: 'Record the host keys once from a terminal, set `<ENV>_<KEY>_HOST_KEY`, or pass `--insecure-host-key` knowingly.',
  }),

  // Plan validation before any SSH (ConfigError unless noted, design-05 2.1)
  orchestratorNotK3s: (env: string, orchestrator: string): SetupProblem => ({
    message: `config.yml sets orchestrator: ${orchestrator}; k3s setup needs orchestrator: k3s`,
    suggestion: `Set orchestrator: k3s in .dockflow/config.yml, or run dockflow setup swarm ${env}.`,
  }),
  noServers: (env: string, available: readonly string[]): SetupProblem => ({
    message: `No servers found with tag "${env}"`,
    suggestion:
      available.length > 0 ? `Available environments: ${list(available)}` : 'Add servers with the appropriate tags to servers.yml.',
  }),
  noManager: (env: string): SetupProblem => ({
    message: `Environment ${env} has no manager (k3s server)`,
    suggestion: 'Declare at least one server with role: manager.',
  }),
  nodeNameInvalid: (key: string, nodeName: string): SetupProblem => ({
    message: `servers.${key} does not map to a Kubernetes node name (${nodeName})`,
    suggestion: 'Rename the server in `servers.yml` using lowercase letters, digits and `-`.',
  }),
  clusterAddressUnusable: (key: string, address: string): SetupProblem => ({
    message: `servers.${key}: ${address} cannot be used as a cluster address`,
    suggestion: 'Set private_host to an address the other nodes can reach.',
  }),
  hostIsLocalhost: (key: string): SetupProblem => ({
    message: `servers.${key}.host is localhost; k3s needs the address other nodes use to reach ${key}`,
    suggestion: 'Set private_host.',
  }),
  duplicatePrivateHost: (first: string, second: string, address: string): SetupProblem => ({
    message: `Servers ${first} and ${second} declare the same private_host ${address}`,
    suggestion: 'Set private_host of each server to an address of its own network interface.',
  }),
  /** ConnectionError */
  deployKeyMissing: (env: string, key: string): SetupProblem => {
    const prefix = env.toUpperCase();
    return {
      message: `No deploy SSH key for ${key} (${prefix}_${serverNameToEnvKey(key)}_CONNECTION or ${prefix}_SSH_PRIVATE_KEY)`,
      suggestion:
        'Setup authorizes the deploy key on every node and checks the deploy identity with it. Add the key to .env.dockflow or CI secrets first.',
    };
  },
  deployKeyUnparseable: (key: string, reason: string): SetupProblem => ({
    message: `The deploy key for ${key} cannot be parsed (${reason})`,
    suggestion: `Use an unencrypted OpenSSH or PEM private key as the deploy key of ${key}.`,
  }),
  deployUserInvalid: (key: string, user: string): SetupProblem => ({
    message: `servers.${key}.user ${user} is not a valid Linux user name`,
    suggestion: LINUX_USER_NAME_HINT,
  }),

  // Addresses and address mode (design-05 2.2)
  hostResolvesToLoopback: (key: string, name: string, address: string): SetupProblem => ({
    message: `servers.${key}.host ${name} resolves to ${address} on ${key}; set private_host`,
    suggestion: `Set private_host of ${key} to the address the other nodes use to reach it.`,
  }),
  noReachableAddress: (key: string): SetupProblem => ({
    message: `${key} has no private_host and no public address reachable by the other nodes`,
    suggestion: `Set private_host of ${key}, or set its host to an address the other nodes can reach.`,
  }),
  haNeedsPrivateNetwork: (keys: readonly string[]): SetupProblem => ({
    message: `High availability needs the servers on a private network: ${list(keys)} ${keys.length === 1 ? 'has' : 'have'} no private_host (k3s does not support embedded etcd over public addresses)`,
    suggestion: 'Set private_host on every manager to an address of a network they share.',
  }),
  noPublicAddress: (key: string, withoutPrivate: readonly string[]): SetupProblem => ({
    message: `${key} has no public address, but the nodes must talk over public addresses because ${list(withoutPrivate)} ${withoutPrivate.length === 1 ? 'has' : 'have'} no private_host`,
    suggestion: `Set private_host on every node to an address of a network they share, or set the host of ${key} to its public address.`,
  }),
  privateIpNotLocal: (key: string, address: string): SetupProblem => ({
    message: `private_host ${address} is not assigned to any network interface on ${key}`,
    suggestion: `Set private_host of ${key} to an address of one of its network interfaces.`,
  }),

  // Local single-host mode (ValidationError, design-05 1.2)
  localNodeNameInvalid: (name: string): SetupProblem => ({
    message: `--node-name ${name} is not a valid node name`,
    suggestion: 'Use lowercase letters, digits, `-` and `_`, starting and ending with a letter or digit (at most 63 characters).',
  }),
  localDeployUserInvalid: (user: string): SetupProblem => ({
    message: `--user ${user} is not a valid Linux user name`,
    suggestion: LINUX_USER_NAME_HINT,
  }),
  localPrivateHostInvalid: (address: string): SetupProblem => ({
    message: `--private-host ${address} must be an IPv4 address the other nodes can reach`,
    suggestion: "Pass the host's private IPv4 address, or omit --private-host.",
  }),

  // Preflight refusals and warnings (design-05 4.1)
  inspectionMissing: (key: string): SetupProblem => ({
    message: `No inspection result for ${key}`,
    suggestion: 'Run the setup again.',
  }),
  noSystemd: (key: string): SetupProblem => ({
    message: `k3s setup needs systemd on ${key}`,
    suggestion: 'Use a Linux distribution that runs systemd as its init system.',
  }),
  missingCommands: (key: string, commands: readonly string[]): SetupProblem => ({
    message: `${key} is missing ${list(commands)} and no supported package manager was found`,
    suggestion: 'Install them and re-run.',
  }),
  cgroupMemory: (key: string): SetupProblem => ({
    message: `The memory cgroup controller is disabled on ${key}`,
    suggestion: 'Add cgroup_memory=1 cgroup_enable=memory to the kernel command line and reboot.',
  }),
  swarmActive: (key: string): SetupProblem => ({
    message: `${key} is part of a Docker Swarm; k3s and Swarm cannot share a host`,
    suggestion: `Run docker swarm leave --force on ${key} (or remove it from this environment).`,
  }),
  nmCloudSetup: (key: string): SetupProblem => ({
    message: `nm-cloud-setup is enabled on ${key}, which breaks k3s networking on this release`,
    suggestion: `Run systemctl disable nm-cloud-setup.service nm-cloud-setup.timer and reboot ${key}.`,
  }),
  portInUse: (key: string, port: number, proto: string, process: string): SetupProblem => ({
    message: `Port ${port}/${proto} on ${key} is used by ${process}`,
    suggestion: `Stop ${process} or free the port.`,
  }),
  proxyPortInUse: (key: string, port: number, process: string): SetupProblem => ({
    message: `Port ${port}/tcp on ${key} is used by ${process}, so Traefik could not receive traffic there (proxy.enabled)`,
    suggestion: `Stop ${process}, or set \`proxy.enabled: false\` and keep the host nginx plugin.`,
  }),
  otherEnvironment: (key: string, other: string, env: string): SetupProblem => ({
    message: `${key} already serves Dockflow environment ${other}, which would share one cluster-admin identity with ${env}`,
    suggestion:
      'Use separate clusters for separate environments, or pass `--shared-cluster` to accept that a deploy key of either environment administers both.',
  }),
  bothFirewalls: (key: string): SetupProblem => ({
    message: `${key} runs both ufw and firewalld, and Dockflow cannot tell which one filters its traffic`,
    suggestion:
      'Stop one of them (`systemctl disable --now firewalld` or `ufw disable`), or re-run with `--skip-firewall` and open the flows yourself.',
  }),
  foreignDefaultStorageClass: (env: string, name: string): SetupProblem => ({
    message: `StorageClass ${name} on ${env} is marked default, so chart volumes could land on it instead of dockflow-local`,
    suggestion: `Remove the annotation (\`kubectl annotate storageclass ${name} storageclass.kubernetes.io/is-default-class=false --overwrite\`) and run setup again.`,
  }),
  convertNeedsConsent: (env: string, key: string): SetupProblem => ({
    message: `Adding managers to ${env} converts the datastore of ${key} from SQLite to embedded etcd, which cannot be undone`,
    suggestion: `Re-run with \`--convert-datastore\` once you have a copy of \`${K3S_SQLITE_DB_DIR}\` off the host.`,
  }),
  wireguardMissing: (key: string): SetupProblem => ({
    message: `WireGuard is not available on ${key}, and flannel needs it because nodes talk over public addresses`,
    suggestion:
      'Install the WireGuard kernel module (kernel 5.6+ has it built in), or give every node a private_host on a shared network.',
  }),
  /** `reason` names an installed-but-idle tool or `--skip-firewall`, null when no tool is installed */
  noFirewall: (key: string, env: string, reason: string | null): SetupProblem => ({
    message: `No host firewall is managed on ${key}, so 6443, 10250, 2379-2380 and 8472 stay open unless your provider firewall blocks them${reason === null ? '' : ` (${reason})`}`,
    suggestion: `Allow only the flows printed at the end of this run and deny those ports from every other source, then re-check with \`dockflow setup k3s ${env} --dry-run\`.`,
  }),
  netcheckLeftOver: (env: string): SetupProblem => ({
    message: `A dockflow-netcheck DaemonSet from an interrupted setup is still running on ${env}`,
    suggestion:
      'It is removed at the end of this run; remove it now with `k3s kubectl delete daemonset -n dockflow-system dockflow-netcheck` if this run does not reach that step.',
  }),
  lowResourcesServer: (key: string, memory: string, cpus: string): string =>
    `${key} has ${memory}/${cpus}; k3s recommends 2 CPUs and 2 GB for servers`,
  lowResourcesAgent: (key: string, memory: string): string => `${key} has ${memory}; k3s recommends at least 512 MB for agents`,
  lowDisk: (key: string, gib: string): string => `${key} has ${gib} GiB free under /var/lib (images and volumes live there)`,
  clockNotSynchronized: (key: string): string => `The clock of ${key} is not NTP-synchronized; etcd and certificates need accurate time`,
  dockerPresent: (key: string): string =>
    `Docker is installed on ${key}; k3s uses its own containerd and Docker images are not visible to the cluster`,
  selinuxEnforcing: (key: string): string =>
    `SELinux is enforcing on ${key}; the k3s install script installs the signed k3s-selinux package from rpm.rancher.io`,
  foreignConfigManaged: (file: string, key: string, keys: readonly string[]): SetupProblem => ({
    message: `${file} on ${key} sets ${list(keys)}, which Dockflow manages in 50-dockflow.yaml`,
    suggestion: `Remove those keys from ${file}.`,
  }),
  foreignConfigOther: (file: string, key: string, keys: readonly string[]): string =>
    `${file} on ${key} adds k3s settings Dockflow does not manage: ${list(keys)}`,
  unitEnvOverrides: (unit: string, key: string, names: readonly string[]): string =>
    `/etc/systemd/system/${unit}.env on ${key} sets ${list(names)}; they override the Dockflow configuration`,
  sharedCluster: (envs: readonly string[]): string =>
    `Environments ${list(envs)} share this cluster and one cluster-admin identity: a deploy key of either administers both`,

  // Node actions (design-05 4.2)
  unmanagedK3s: (key: string, env: string): SetupProblem => ({
    message: `k3s is already installed on ${key} but not by Dockflow`,
    suggestion: `Uninstall it with /usr/local/bin/k3s-uninstall.sh (or k3s-agent-uninstall.sh) on ${key}, which deletes that node's cluster data, then re-run dockflow setup k3s ${env}.`,
  }),
  roleChanged: (key: string, installed: 'server' | 'agent', declared: string, env: string): SetupProblem => ({
    message: `${key} is a k3s ${installed} but servers.yml declares ${declared}`,
    suggestion: `Changing a node's role requires a reset: dockflow setup k3s ${env} --reset --node ${key}, then run setup again.`,
  }),
  nodeRenamed: (key: string, registered: string, expected: string): SetupProblem => ({
    message: `${key} is registered as node ${registered} but servers.yml key ${key} maps to ${expected}; node names cannot change`,
    suggestion: `Rename the servers.yml key back, or reset the node with --reset --node ${key}.`,
  }),
  foreignCluster: (key: string, nodeCa: string, clusterCa: string): SetupProblem => ({
    message: `${key} belongs to another k3s cluster (CA ${nodeCa.slice(0, 8)}, cluster CA ${clusterCa.slice(0, 8)})`,
    suggestion: `Reset ${key} with --reset --node ${key}, or remove it from this environment.`,
  }),
  downgrade: (key: string, installed: string, pin: string, dockflowVersion: string): SetupProblem => ({
    message: `${key} runs k3s ${installed}, newer than ${pin} pinned by Dockflow ${dockflowVersion}; downgrades are not supported`,
    suggestion: `Use a Dockflow release that pins ${installed} or later.`,
  }),
  minorSkip: (key: string, installed: string, pin: string, nextMinor: number): SetupProblem => ({
    message: `${key} runs k3s ${installed}; Kubernetes cannot skip minor versions to reach ${pin}`,
    suggestion: `Run the setup of the Dockflow release that pins k3s v1.${nextMinor} first, then this one.`,
  }),
  agentNewerThanServers: (key: string): SetupProblem => ({
    message: `Agent ${key} would run a newer k3s than the servers`,
    suggestion: 'Upgrade the servers first: run setup once every server is reachable and upgradable.',
  }),
  unknownVersion: (key: string, text: string): SetupProblem => ({
    message: `k3s on ${key} reports an unknown version (${text})`,
    suggestion: `Run ${K3S_BINARY} --version on ${key}; if it fails, reset the node with --reset --node ${key}.`,
  }),
  noServerAnswering: (env: string, servers: readonly string[]): SetupProblem => ({
    message: `No k3s server of ${env} is answering; start k3s on a server before adding or changing nodes`,
    suggestion: `Run systemctl status k3s on ${list(servers)}.`,
  }),

  // Configuration drift (design-05 7.3)
  etcdNodeIpChange: (key: string, from: string, to: string): SetupProblem => ({
    message: `${key} is an etcd member; its node-ip cannot change from ${from} to ${to}`,
    suggestion: `Reset the server with --reset --node ${key} and set it up again.`,
  }),
  flannelChange: (env: string, installed: string, wanted: string, reason: string): SetupProblem => ({
    message: `The flannel backend of ${env} is ${installed}; Dockflow would now use ${wanted} (${reason})`,
    suggestion: `Changing the pod network backend needs every node reset. Keep the addresses that led to ${installed}, or reset the environment with --reset.`,
  }),
  encryptionChange: (key: string, from: string, to: string): SetupProblem => ({
    message: `Secrets encryption settings of ${key} differ from Dockflow's (${from} -> ${to})`,
    suggestion: 'Follow the k3s secrets-encrypt key rotation procedure, then re-run setup.',
  }),
  encryptionProviderMigration: (key: string, from: string, to: string): SetupProblem => ({
    message: `Secrets encryption settings of ${key} differ from Dockflow's (${from} -> ${to})`,
    suggestion:
      'Run k3s secrets-encrypt rotate-keys after setting secrets-encryption-provider: secretbox on every server (k3s migration procedure), then re-run setup.',
  }),
  disabledComponents: (key: string, components: readonly string[]): SetupProblem => ({
    message: `${key} disables ${components.length > 0 ? list(components) : 'nothing'}; Dockflow requires exactly [traefik]`,
    suggestion: `Reset ${key} with --reset --node ${key}, or restore disable: [traefik] in its 50-dockflow.yaml by hand.`,
  }),

  // Tokens (design-05 4.6, C15)
  tokensEqual: (env: string): SetupProblem => ({
    message: `The agent token of ${env} equals the server token`,
    suggestion: 'Reset the cluster; Dockflow never hands the server token to agents.',
  }),
  tokenMalformed: (env: string, which: 'server' | 'agent'): SetupProblem => ({
    message: `The ${which} token of ${env} is not a k3s secure token`,
    suggestion: `Check ${which === 'server' ? '/var/lib/rancher/k3s/server/token' : '/var/lib/rancher/k3s/server/agent-token'} on the first server; it must start with K10.`,
  }),

  // Confirmation and outcome (design-05 15.5, 17.2)
  restartConfirm: (keys: readonly string[], reasons: readonly string[]): string =>
    `This will restart k3s on ${list(keys)} (${list(reasons)}). Pods keep running; each node's API is unavailable for about 30 seconds. Continue?`,
  convertConfirm: (key: string, copyPath: string): string =>
    `${key} converts from SQLite to embedded etcd. This cannot be undone without resetting the node. A copy of the datastore is kept at ${copyPath}. Continue?`,
  setupCancelled: 'Setup cancelled; nothing was changed',
  refusals: (env: string, refusals: readonly { node: string | null; message: string; suggestion: string }[]): SetupProblem => ({
    message: `k3s setup of ${env} cannot proceed (${refusals.length} ${refusals.length === 1 ? 'problem' : 'problems'})`,
    suggestion: refusals.map((r) => `${r.node ?? env}: ${r.message} (${r.suggestion})`).join('\n'),
  }),
} as const;
