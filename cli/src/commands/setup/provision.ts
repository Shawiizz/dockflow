/**
 * Host provisioning: Docker, /var/lib/dockflow, the filter of published ports, nginx. Runs locally
 * on the target Linux host (the remote setup ships the binary and runs it there), as root, so
 * commands run directly. Every step checks the current state first, so setup can run again.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { printSection, printInfo, printSuccess, printWarning, printDim, printBlank } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { commandExists, detectPackageManager, getDistroName } from './dependencies';
import { configurePublicPorts } from './public-ports';
import type { HostConfig } from './types';

export const DOCKFLOW_BASE_DIR = '/var/lib/dockflow';

/** Package name for nginx per package manager (same everywhere today). */
export function nginxPackageFor(_pm: string): string {
  return 'nginx';
}

export interface RunOptions {
  /** capture the output instead of streaming it to the console */
  quiet?: boolean;
  input?: string;
  /** the child is killed after this long and the result reports timedOut */
  timeoutMs?: number;
  /** output beyond this many bytes kills the child; default 64 MiB */
  maxBuffer?: number;
}

export interface RunResult {
  ok: boolean;
  /** 127 when the binary does not exist, 124 after a timeout */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (args: readonly string[], opts?: RunOptions) => RunResult;

// package managers and install scripts print far more than Node's default 1 MiB
const RUN_MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_EXIT = 124;
const NOT_FOUND_EXIT = 127;

/**
 * Runs a command by argv (no shell), streaming its output unless quiet. There is no sudo prefix:
 * setup enforces root (see setup/index.ts), which also keeps hosts without a sudo binary working.
 */
export function run(args: readonly string[], opts: RunOptions = {}): RunResult {
  const captured = opts.quiet || opts.input !== undefined;
  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf-8',
    stdio: captured ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    input: opts.input,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? RUN_MAX_BUFFER,
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
  } else if (code === 'ENOBUFS') {
    // the output was cut at maxBuffer: whatever the exit status, it is not the command's whole answer
    exitCode = exitCode === 0 ? 1 : exitCode;
    stderr = `${stderr}${stderr ? '\n' : ''}${args[0]}: output larger than ${opts.maxBuffer ?? RUN_MAX_BUFFER} bytes`;
  }
  return { ok: exitCode === 0 && !timedOut, exitCode, stdout: result.stdout ?? '', stderr, timedOut };
}

/** Owned by the deploy user, mode 0750. Argv only: the user name never reaches a shell. */
export function ensureDockflowDir(deployUser: string, runCommand: CommandRunner = run): void {
  const steps = [
    ['mkdir', '-p', '--', DOCKFLOW_BASE_DIR],
    ['chown', '--', `${deployUser}:${deployUser}`, DOCKFLOW_BASE_DIR],
    ['chmod', '--', '0750', DOCKFLOW_BASE_DIR],
  ];
  for (const argv of steps) {
    const result = runCommand(argv, { quiet: true });
    if (!result.ok) {
      throw new CLIError(
        `Failed to prepare ${DOCKFLOW_BASE_DIR}: ${result.stderr.trim() || `${argv[0]} exited with ${result.exitCode}`}`,
        ErrorCode.COMMAND_FAILED,
      );
    }
  }
  printSuccess(`${DOCKFLOW_BASE_DIR} ready (owner: ${deployUser})`);
}

/** Installs Docker with the official convenience script; skipped when docker is already present. */
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

/** Throws CLIError on the first failing step. */
export function provisionHost(config: HostConfig): void {
  printSection('Provisioning host');
  printBlank();

  if (config.skipDockerInstall) {
    printDim('Docker install skipped (--skip-docker-install)');
  } else {
    installDocker();
  }

  ensureDockflowDir(config.deployUser);

  configurePublicPorts(config.portFilter);

  if (config.installNginx) {
    installNginx();
  }

  printBlank();
  printSuccess('Host provisioning complete');
}
