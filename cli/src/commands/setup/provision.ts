/**
 * Host provisioning — pure TypeScript replacement for the former Ansible
 * playbook: Docker install, /var/lib/dockflow, the filter of published ports, nginx.
 *
 * Runs locally on the target Linux host (local setup mode — the remote setup
 * flow ships the binary and re-executes it on the server). Setup enforces
 * root before provisioning starts, so commands run directly (no sudo binary
 * required). Every step is idempotent: it checks the current state before
 * changing anything.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { printSection, printInfo, printSuccess, printWarning, printDim, printBlank } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { commandExists, detectPackageManager, getDistroName } from './dependencies';
import { configurePublicPorts } from './public-ports';
import type { HostConfig } from './types';

const DOCKFLOW_BASE_DIR = '/var/lib/dockflow';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

/**
 * Run a privileged command, streaming output to the console unless quiet.
 * Setup enforces root before provisioning starts (see setup/index.ts), so no
 * sudo prefix is needed — which also keeps minimal systems without a sudo
 * binary working.
 */
function run(args: string[], opts?: { quiet?: boolean; input?: string }): RunResult {
  const result = spawnSync(args[0], args.slice(1), {
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
  const result = run([
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

  const install = run(['sh', '-c', `${downloader} | sh`]);
  if (!install.ok || !commandExists('docker')) {
    throw new CLIError(
      'Docker installation failed',
      ErrorCode.COMMAND_FAILED,
      'Check the output above. You can install Docker manually and re-run setup with --skip-docker-install.',
    );
  }

  // Enable + start the daemon (best effort — non-systemd hosts manage it themselves)
  if (commandExists('systemctl')) {
    const enable = run(['systemctl', 'enable', '--now', 'docker'], { quiet: true });
    if (!enable.ok) {
      printWarning(`Could not enable the Docker service: ${enable.stderr.trim()}`);
    }
  } else {
    printWarning('systemctl not found — make sure the Docker daemon is started and enabled at boot.');
  }

  printSuccess('Docker installed');
}

/** Install and enable nginx. */
function installNginx(): void {
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
    const install = run(installCmds[pm]);
    if (!install.ok || !commandExists('nginx')) {
      throw new CLIError('nginx installation failed', ErrorCode.COMMAND_FAILED);
    }
  } else {
    printSuccess('nginx already installed — skipping install');
  }

  // Debian-style layout: drop the default site so dockflow vhosts take over
  if (fs.existsSync('/etc/nginx/sites-enabled/default')) {
    run(['rm', '-f', '/etc/nginx/sites-enabled/default'], { quiet: true });
  }

  // Validate config before (re)starting
  const test = run(['nginx', '-t'], { quiet: true });
  if (!test.ok) {
    throw new CLIError(
      `nginx configuration test failed:\n${test.stderr.trim() || test.stdout.trim()}`,
      ErrorCode.COMMAND_FAILED,
    );
  }

  if (commandExists('systemctl')) {
    const enable = run(['systemctl', 'enable', '--now', 'nginx'], { quiet: true });
    if (!enable.ok) {
      printWarning(`Could not enable nginx: ${enable.stderr.trim()}`);
    }
    run(['systemctl', 'reload', 'nginx'], { quiet: true });
  }

  printSuccess('nginx configured');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Provision the host: Docker, /var/lib/dockflow, optional nginx.
 * Throws CLIError on the first failing step.
 */
export function provisionHost(config: HostConfig): void {
  printSection('Provisioning host');
  printBlank();

  if (config.skipDockerInstall) {
    printDim('Docker install skipped (--skip-docker-install)');
  } else if (config.orchestrator === 'k3s') {
    printDim('Docker install skipped: k3s uses containerd (run `dockflow setup k3s <env>` afterwards to install the cluster)');
  } else {
    installDocker();
  }

  ensureDockflowDir(config.deployUser);

  if (config.orchestrator === 'k3s') {
    printDim('Published-port filter skipped: k3s does not publish ports through Docker');
  } else {
    configurePublicPorts(config.portFilter);
  }

  if (config.installNginx) {
    installNginx();
  }

  printBlank();
  printSuccess('Host provisioning complete');
}
