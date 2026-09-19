/**
 * Host provisioning — pure TypeScript replacement for the former Ansible
 * playbook: Docker install, /var/lib/dockflow, nginx, Portainer.
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
import type { HostRunner } from './k3s/host-runner';
import type { HostConfig } from './types';

export const DOCKFLOW_BASE_DIR = '/var/lib/dockflow';
export const DOCKFLOW_BASE_DIR_MODE = 0o750;

export const provisionMessages = {
  dockerSkippedK3s: 'Docker install skipped: k3s runs its own containerd',
  portainerWithK3s: 'Portainer requires Docker and is not supported with --orchestrator k3s',
  nginxWithK3s:
    "nginx serves ports 80 and 443 of this host; Dockflow's Traefik needs them on k3s once proxy.enabled is set, so keep proxy.enabled off while nginx serves this host",
  dockflowDirFailed: (detail: string): string => `Failed to prepare ${DOCKFLOW_BASE_DIR}: ${detail}`,
} as const;

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

export interface RunOptions {
  /** capture the output instead of streaming it to the console */
  quiet?: boolean;
  input?: string | Uint8Array;
  /** the child is killed after this long and the result reports timedOut */
  timeoutMs?: number;
  /** the child's whole environment (replaces process.env) */
  env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  ok: boolean;
  /** 127 when the binary does not exist, 124 after a timeout */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// install.sh and package managers print a lot; the default 1 MiB buffer would kill them
const RUN_MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_EXIT = 124;
const NOT_FOUND_EXIT = 127;

/**
 * Run a privileged command by argv (no shell), streaming output to the console unless quiet.
 * Setup enforces root before provisioning starts (see setup/index.ts), so no
 * sudo prefix is needed — which also keeps minimal systems without a sudo
 * binary working. The k3s HostRunner reuses it for every node-step process.
 */
export function run(args: readonly string[], opts: RunOptions = {}): RunResult {
  const captured = opts.quiet || opts.input !== undefined;
  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf-8',
    stdio: captured ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    input: opts.input,
    timeout: opts.timeoutMs,
    env: opts.env ? { ...opts.env } : undefined,
    maxBuffer: RUN_MAX_BUFFER,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = code === 'ETIMEDOUT';
  let exitCode = result.status ?? 1;
  let stderr = result.stderr ?? '';
  if (timedOut) {
    exitCode = TIMEOUT_EXIT;
  } else if (code === 'ENOENT') {
    exitCode = NOT_FOUND_EXIT;
    stderr = `${args[0]}: command not found`;
  }
  return { ok: exitCode === 0 && !timedOut, exitCode, stdout: result.stdout ?? '', stderr, timedOut };
}

// ---------------------------------------------------------------------------
// Provisioning steps
// ---------------------------------------------------------------------------

type CommandRunner = Pick<HostRunner, 'run'>;

const localCommands: CommandRunner = {
  async run(argv, options) {
    const result = run(argv, { quiet: true, input: options?.input, timeoutMs: options?.timeoutMs });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
  },
};

/**
 * Create /var/lib/dockflow owned by the deploy user (mode 0750). Argv only: the user name never
 * reaches a shell. The k3s node step passes its HostRunner.
 */
export async function ensureDockflowDir(deployUser: string, runner: CommandRunner = localCommands): Promise<void> {
  const owner = `${deployUser}:${deployUser}`;
  const steps: string[][] = [
    ['mkdir', '-p', '--', DOCKFLOW_BASE_DIR],
    ['chown', '--', owner, DOCKFLOW_BASE_DIR],
    ['chmod', '--', DOCKFLOW_BASE_DIR_MODE.toString(8).padStart(4, '0'), DOCKFLOW_BASE_DIR],
  ];
  for (const argv of steps) {
    const result = await runner.run(argv);
    if (result.exitCode !== 0) {
      throw new CLIError(
        provisionMessages.dockflowDirFailed(result.stderr.trim() || `${argv[0]} exited with ${result.exitCode}`),
        ErrorCode.COMMAND_FAILED,
      );
    }
  }
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

  // Portainer vhost (only when Portainer is installed with a domain)
  if (config.portainer.install && config.portainer.domain) {
    const vhostDir = fs.existsSync('/etc/nginx/sites-enabled')
      ? '/etc/nginx/sites-enabled'
      : '/etc/nginx/conf.d';
    const vhostPath = `${vhostDir}/portainer${vhostDir.endsWith('conf.d') ? '.conf' : ''}`;
    const vhost = buildPortainerVhost(config.portainer.domain, config.portainer.port);

    const write = run(['sh', '-c', `cat > '${vhostPath}'`], { quiet: true, input: vhost });
    if (!write.ok) {
      throw new CLIError(`Failed to write ${vhostPath}: ${write.stderr.trim()}`, ErrorCode.COMMAND_FAILED);
    }
    printSuccess(`Portainer vhost written (${config.portainer.domain} -> :${config.portainer.port})`);
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

  // Portainer only applies --admin-password on a fresh data volume — warn on
  // re-runs with an existing one, or the new password is silently ignored.
  if (run(['docker', 'volume', 'inspect', 'portainer_data'], { quiet: true }).ok) {
    printWarning(
      'portainer_data volume already exists — the admin password only applies on first initialization and will NOT be changed.',
    );
  }

  const volume = run(['docker', 'volume', 'create', 'portainer_data'], { quiet: true });
  if (!volume.ok) {
    throw new CLIError(`Failed to create portainer_data volume: ${volume.stderr.trim()}`, ErrorCode.COMMAND_FAILED);
  }

  // Hash the admin password with bcrypt inside a throwaway httpd container.
  // -i reads the password from stdin so it never appears in process args.
  const hashRun = run(
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
  run(['docker', 'rm', '-f', 'portainer'], { quiet: true });

  const startResult = run([
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

  if (!startResult.ok) {
    throw new CLIError(`Failed to start Portainer: ${startResult.stderr.trim()}`, ErrorCode.COMMAND_FAILED);
  }

  printSuccess(`Portainer running on port ${port}`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Provision the host: Docker, /var/lib/dockflow, optional nginx + Portainer.
 * Throws CLIError on the first failing step. On k3s the cluster itself is installed afterwards
 * by the local k3s branch of flow.ts.
 */
export async function provisionHost(config: HostConfig): Promise<void> {
  printSection('Provisioning host');
  printBlank();

  if (config.orchestrator === 'k3s' && config.portainer.install) {
    throw new CLIError(provisionMessages.portainerWithK3s, ErrorCode.INVALID_ARGUMENT);
  }

  if (config.orchestrator === 'k3s') {
    // --skip-docker-install is accepted and has nothing to skip on k3s
    printDim(provisionMessages.dockerSkippedK3s);
  } else if (config.skipDockerInstall) {
    printDim('Docker install skipped (--skip-docker-install)');
  } else {
    installDocker();
  }

  await ensureDockflowDir(config.deployUser);
  printSuccess(`${DOCKFLOW_BASE_DIR} ready (owner: ${config.deployUser})`);

  if (config.installNginx) {
    installNginx(config);
    if (config.orchestrator === 'k3s') printWarning(provisionMessages.nginxWithK3s);
  }

  if (config.portainer.install) {
    installPortainer(config);
  }

  printBlank();
  printSuccess('Host provisioning complete');
}
