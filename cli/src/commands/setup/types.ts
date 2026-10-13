/**
 * Types and interfaces for setup commands
 */

export interface SetupOptions {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  /** file holding `password`, so it stays out of the process list */
  passwordFile?: string;
  sshKey?: string;
  generateKey?: boolean;
  skipDockerInstall?: boolean;
  nginx?: boolean;
  /** false with --no-port-filter */
  portFilter?: boolean;
  yes?: boolean;
  /** host key fingerprint written into the connection string instead of the one sshd presents */
  hostKey?: string;
}

export interface HostConfig {
  publicHost: string;
  sshPort: number;
  deployUser: string;
  deployPassword?: string;
  privateKeyPath: string;
  skipDockerInstall: boolean;
  installNginx: boolean;
  /** filter the internet traffic to published container ports */
  portFilter: boolean;
  /** host key fingerprint to pin in the connection string; this machine's sshd key by default */
  hostKey?: string;
}

export interface RemoteSetupOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  /** host key the server must present; trusted on the first connection when absent */
  hostKey?: string;
  /** password of the deploy user the remote setup creates (sent to the server through a file) */
  deployPassword?: string;
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
