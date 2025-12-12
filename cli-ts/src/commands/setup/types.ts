/**
 * Types and interfaces for setup commands
 */

export interface SetupOptions {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  sshKey?: string;
  generateKey?: boolean;
  skipDockerInstall?: boolean;
  portainer?: boolean;
  portainerPort?: string;
  portainerPassword?: string;
  portainerDomain?: string;
  yes?: boolean;
}

export interface HostConfig {
  publicHost: string;
  sshPort: number;
  deployUser: string;
  deployPassword?: string;
  privateKeyPath: string;
  skipDockerInstall: boolean;
  portainer: PortainerConfig;
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

export interface RemoteOptions {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  key?: string;
  connection?: string;
}

export interface ConnectionOptions {
  host?: string;
  port?: string;
  user?: string;
  key?: string;
}
