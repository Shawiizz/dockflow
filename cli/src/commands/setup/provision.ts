/**
 * Host provisioning — pure TypeScript replacement for the former Ansible
 * playbook: Docker install, /var/lib/dockflow, nginx, Portainer.
 *
 * Runs locally on the target Linux host (local setup mode — the remote setup
 * flow ships the binary and re-executes it on the server). Privileged
 * commands go through sudo, like the rest of the setup flow. Every step is
 * idempotent: it checks the current state before changing anything.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { printSection, printInfo, printSuccess, printWarning, printDim, printBlank } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { commandExists, detectPackageManager, getDistroName } from './dependencies';
import type { HostConfig } from './types';

const DOCKFLOW_BASE_DIR = '/var/lib/dockflow';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Nginx vhost proxying a domain to the local Portainer HTTP port. */
export function buildPortainerVhost(domain: string, port: number): string {
  return [
    'server {',
    '    listen 80;',
    `    server_name ${domain};`,
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${port};`,
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Extract the bcrypt hash from `htpasswd -niB admin` output
 * ("admin:$2y$..."). Tolerates noise lines (e.g. docker pull output);
 * returns null when no credential line is found.
 */
export function parseHtpasswdHash(output: string): string | null {
  for (const line of output.trim().split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const hash = line.slice(idx + 1).trim();
    if (hash.startsWith('$')) return hash;
  }
  return null;
}

/** Package name for nginx per package manager (same everywhere today). */
export function nginxPackageFor(_pm: string): string {
  return 'nginx';
}

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run a command via sudo, streaming output to the console. */
function sudoRun(args: string[], opts?: { quiet?: boolean; input?: string }): RunResult {
  const result = spawnSync('sudo', args, {
    encoding: 'utf-8',
    stdio: opts?.quiet || opts?.input !== undefined
      ? ['pipe', 'pipe', 'pipe']
      : ['inherit', 'inherit', 'inherit'],
    input: opts?.input,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// Provisioning steps
// ---------------------------------------------------------------------------

/** Create /var/lib/dockflow owned by the deploy user (mode 0750). */
function ensureDockflowDir(deployUser: string): void {
  const result = sudoRun([
    'sh', '-c',
    `mkdir -p '${DOCKFLOW_BASE_DIR}' && chown '${deployUser}:${deployUser}' '${DOCKFLOW_BASE_DIR}' && chmod 0750 '${DOCKFLOW_BASE_DIR}'`,
  ], { quiet: true });

  if (!result.ok) {
    throw new CLIError(
      `Failed to prepare ${DOCKFLOW_BASE_DIR}: ${result.stderr.trim()}`,
      ErrorCode.COMMAND_FAILED,
    );
  }
  printSuccess(`${DOCKFLOW_BASE_DIR} ready (owner: ${deployUser})`);
}

/**
 * Install Docker via Docker's official multi-distro convenience script.
 * Idempotent: skipped when docker is already present.
 */
function installDocker(): void {
  if (commandExists('docker')) {
    printSuccess('Docker already installed — skipping');
    return;
  }

  printInfo(`Installing Docker via get.docker.com (${getDistroName()})...`);

  const downloader = commandExists('curl')
    ? 'curl -fsSL https://get.docker.com'
    : commandExists('wget')
      ? 'wget -qO- https://get.docker.com'
      : null;

  if (!downloader) {
    throw new CLIError(
      'Neither curl nor wget is available to download the Docker install script',
      ErrorCode.COMMAND_FAILED,
      'Install curl and re-run setup.',
    );
  }

  const install = sudoRun(['sh', '-c', `${downloader} | sh`]);
  if (!install.ok || !commandExists('docker')) {
    throw new CLIError(
      'Docker installation failed',
      ErrorCode.COMMAND_FAILED,
      'Check the output above. You can install Docker manually and re-run setup with --skip-docker-install.',
    );
  }

  // Enable + start the daemon (best effort — non-systemd hosts manage it themselves)
  if (commandExists('systemctl')) {
    const enable = sudoRun(['systemctl', 'enable', '--now', 'docker'], { quiet: true });
    if (!enable.ok) {
      printWarning(`Could not enable the Docker service: ${enable.stderr.trim()}`);
    }
  } else {
    printWarning('systemctl not found — make sure the Docker daemon is started and enabled at boot.');
  }

  printSuccess('Docker installed');
}

/**
 * Install and enable nginx. Writes the Portainer vhost when a domain is set.
 */
function installNginx(config: HostConfig): void {
  if (!commandExists('nginx')) {
    const pm = detectPackageManager();
    if (!pm) {
      throw new CLIError(
        'Could not detect a package manager to install nginx',
        ErrorCode.COMMAND_FAILED,
      );
    }

    printInfo(`Installing nginx (${pm})...`);
    const installCmds: Record<string, string[]> = {
      apt: ['apt-get', 'install', '-y', nginxPackageFor(pm)],
      yum: ['yum', 'install', '-y', nginxPackageFor(pm)],
      dnf: ['dnf', 'install', '-y', nginxPackageFor(pm)],
      pacman: ['pacman', '-S', '--noconfirm', nginxPackageFor(pm)],
      zypper: ['zypper', 'install', '-y', nginxPackageFor(pm)],
      apk: ['apk', 'add', nginxPackageFor(pm)],
    };
    const install = sudoRun(installCmds[pm]);
    if (!install.ok || !commandExists('nginx')) {
      throw new CLIError('nginx installation failed', ErrorCode.COMMAND_FAILED);
    }
  } else {
    printSuccess('nginx already installed — skipping install');
  }

  // Debian-style layout: drop the default site so dockflow vhosts take over
  if (fs.existsSync('/etc/nginx/sites-enabled/default')) {
    sudoRun(['rm', '-f', '/etc/nginx/sites-enabled/default'], { quiet: true });
  }

  // Portainer vhost (only when Portainer is installed with a domain)
  if (config.portainer.install && config.portainer.domain) {
    const vhostDir = fs.existsSync('/etc/nginx/sites-enabled')
      ? '/etc/nginx/sites-enabled'
      : '/etc/nginx/conf.d';
    const vhostPath = `${vhostDir}/portainer${vhostDir.endsWith('conf.d') ? '.conf' : ''}`;
    const vhost = buildPortainerVhost(config.portainer.domain, config.portainer.port);

    const write = sudoRun(['sh', '-c', `cat > '${vhostPath}'`], { quiet: true, input: vhost });
    if (!write.ok) {
      throw new CLIError(`Failed to write ${vhostPath}: ${write.stderr.trim()}`, ErrorCode.COMMAND_FAILED);
    }
    printSuccess(`Portainer vhost written (${config.portainer.domain} → :${config.portainer.port})`);
  }

  // Validate config before (re)starting
  const test = sudoRun(['nginx', '-t'], { quiet: true });
  if (!test.ok) {
    throw new CLIError(
      `nginx configuration test failed:\n${test.stderr.trim() || test.stdout.trim()}`,
      ErrorCode.COMMAND_FAILED,
    );
  }

  if (commandExists('systemctl')) {
    const enable = sudoRun(['systemctl', 'enable', '--now', 'nginx'], { quiet: true });
    if (!enable.ok) {
      printWarning(`Could not enable nginx: ${enable.stderr.trim()}`);
    }
    sudoRun(['systemctl', 'reload', 'nginx'], { quiet: true });
  }

  printSuccess('nginx configured');
}

/**
 * Run Portainer CE as a standalone container (volume + bcrypt admin password).
 */
function installPortainer(config: HostConfig): void {
  const { port, password } = config.portainer;

  if (!password) {
    throw new CLIError(
      'Portainer requires an admin password',
      ErrorCode.INVALID_ARGUMENT,
      'Pass --portainer-password or enter one in the interactive setup.',
    );
  }

  printInfo('Setting up Portainer...');

  const volume = sudoRun(['docker', 'volume', 'create', 'portainer_data'], { quiet: true });
  if (!volume.ok) {
    throw new CLIError(`Failed to create portainer_data volume: ${volume.stderr.trim()}`, ErrorCode.COMMAND_FAILED);
  }

  // Hash the admin password with bcrypt inside a throwaway httpd container.
  // -i reads the password from stdin so it never appears in process args.
  const hashRun = sudoRun(
    ['docker', 'run', '--rm', '-i', 'httpd:2.4-alpine', 'htpasswd', '-niB', 'admin'],
    { quiet: true, input: `${password}\n` },
  );
  const hash = parseHtpasswdHash(hashRun.stdout);
  if (!hashRun.ok || !hash) {
    throw new CLIError(
      `Failed to hash the Portainer admin password: ${hashRun.stderr.trim()}`,
      ErrorCode.COMMAND_FAILED,
    );
  }

  // Recreate the container (parity with the previous behavior)
  sudoRun(['docker', 'rm', '-f', 'portainer'], { quiet: true });

  const run = sudoRun([
    'docker', 'run', '-d',
    '--name', 'portainer',
    '--restart', 'always',
    '-p', '8000:8000',
    '-p', '9443:9443',
    '-p', `${port}:9000`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', 'portainer_data:/data',
    'portainer/portainer-ce:lts',
    `--admin-password=${hash}`,
  ], { quiet: true });

  if (!run.ok) {
    throw new CLIError(`Failed to start Portainer: ${run.stderr.trim()}`, ErrorCode.COMMAND_FAILED);
  }

  printSuccess(`Portainer running on port ${port}`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Provision the host: Docker, /var/lib/dockflow, optional nginx + Portainer.
 * Throws CLIError on the first failing step.
 */
export function provisionHost(config: HostConfig): void {
  printSection('Provisioning host');
  printBlank();

  if (config.skipDockerInstall) {
    printDim('Docker install skipped (--skip-docker-install)');
  } else {
    installDocker();
  }

  ensureDockflowDir(config.deployUser);

  if (config.installNginx) {
    installNginx(config);
  }

  if (config.portainer.install) {
    installPortainer(config);
  }

  printBlank();
  printSuccess('Host provisioning complete');
}
