/**
 * Types and interfaces for setup commands
 */

import type { FlannelBackend } from './k3s/plan';

export type SetupOrchestrator = 'swarm' | 'k3s';

/**
 * Everything `dockflow setup` and `dockflow setup k3s <env>` parse (design-05 1.2, 19.1). No
 * Commander defaults: they are applied when the options are turned into setup or reset options.
 */
export interface SetupOptions {
  host?: string;
  port?: string;
  user?: string;
  /** remote: SSH password; local: sudo password; cluster mode: bootstrap password or key passphrase */
  password?: string;
  sshKey?: string;
  generateKey?: boolean;
  skipDockerInstall?: boolean;
  orchestrator?: SetupOrchestrator;
  nginx?: boolean;
  portainer?: boolean;
  portainerPort?: string;
  portainerPassword?: string;
  portainerDomain?: string;
  yes?: boolean;
  /** remote: path of the SSH private key; cluster mode: the bootstrap key */
  key?: string;
  connection?: string;
  deployPassword?: string;
  /** build the local CLI and upload it instead of downloading the release binary */
  dev?: boolean;

  // Cluster mode (--env or `setup k3s <env>`)
  env?: string;
  sshUser?: string;
  dryRun?: boolean;
  upgrade?: boolean;
  convertDatastore?: boolean;
  sharedCluster?: boolean;
  flannelBackend?: string;
  skipFirewall?: boolean;
  skipNetworkCheck?: boolean;
  skipReachabilityCheck?: boolean;
  insecureHostKey?: boolean;
  requireHostKey?: boolean;
  rotateDeployToken?: boolean;
  reset?: boolean;
  /** with --reset: only these servers.yml keys (repeatable) */
  node?: string[];
  deleteVolumes?: boolean;
  /** with --reset in a non-TTY session: must equal the environment */
  confirm?: string;
  /** hidden: a local Linux Dockflow binary used on the nodes instead of the release */
  binary?: string;

  // Local and remote single-host k3s
  nodeName?: string;
  privateHost?: string;

  /** hidden node-step mode: `-` (the plan on stdin) */
  k3sPlan?: string;
}

/** The node identity of a single-host k3s setup (local mode, design-05 4.8). */
export interface HostK3sConfig {
  nodeName: string;
  privateHost: string | null;
  flannelBackend: FlannelBackend | null;
}

export interface HostConfig {
  publicHost: string;
  sshPort: number;
  deployUser: string;
  deployPassword?: string;
  privateKeyPath: string;
  skipDockerInstall: boolean;
  orchestrator: SetupOrchestrator;
  installNginx: boolean;
  portainer: PortainerConfig;
  /** set when orchestrator is k3s */
  k3s?: HostK3sConfig;
}

export interface PortainerConfig {
  install: boolean;
  port: number;
  password?: string;
  domain?: string;
}

export interface RemoteSetupOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  dev?: boolean;
  /** Flags to forward to the remote `dockflow setup` command */
  forwardFlags?: string[];
}

export interface Dependency {
  name: string;
  command: string;
  description: string;
  packages: {
    apt?: string[];      // Debian, Ubuntu
    yum?: string[];      // RHEL, CentOS, Fedora (old)
    dnf?: string[];      // Fedora, RHEL 8+
    pacman?: string[];   // Arch Linux
    zypper?: string[];   // openSUSE
    apk?: string[];      // Alpine Linux
  };
}

export interface DependencyCheckResult {
  ok: boolean;
  missing: string[];
  missingDeps: Dependency[];
}

export interface SSHKeyResult {
  success: boolean;
  error?: string;
}

export interface ConnectionOptions {
  host?: string;
  port?: string;
  user?: string;
  key?: string;
}
