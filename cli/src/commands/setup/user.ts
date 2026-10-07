/**
 * User management utilities
 *
 * Note: These functions expect to run as root (the remote setup binary
 * is launched with `sudo`), so no individual `sudo` calls are needed.
 * Commands go by argv, never through a shell.
 */

import { spawnSync } from 'child_process';
import { closeSync, fchmodSync, fchownSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { dirname } from 'path';
import { printWarning, printSuccess, printInfo, createSpinner } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { promptPassword } from './prompts';
import { run, type CommandRunner } from './provision';
import { NGINX_SITES_ENABLED, PUBLIC_PORTS_BIN } from '../../constants';

export const SUDOERS_DIR = '/etc/sudoers.d';
export const SUDOERS_FILE_MODE = 0o440;
/** First line of `/etc/sudoers.d/<user>` when Dockflow wrote it. */
export const USER_SUDOERS_HEADER = '# Managed by Dockflow (dockflow setup). Changes are overwritten.';
const DOCKFLOW_HEADER_PREFIX = '# Managed by Dockflow';
// Rules older versions wrote there without a header: the file is still Dockflow's if it holds nothing else
const DOCKFLOW_RULE_SHAPES: readonly RegExp[] = [
  /^\S+ ALL=\(ALL\) NOPASSWD: \S*nginx -t, \S*nginx -s reload$/,
  /^\S+ ALL=\(ALL\) NOPASSWD: \/usr\/local\/sbin\/dockflow-public-ports$/,
];
const COMMAND_TIMEOUT_MS = 60_000;

/** What the functions of this file act on; tests point it at a scratch directory and a fake `run`. */
export interface HostEnv {
  run: CommandRunner;
  sudoersDir: string;
  /** owner of the sudoers files */
  sudoersOwner: { uid: number; gid: number };
  sitesEnabled: string;
  publicPortsBin: string;
  warn: (message: string) => void;
}

const localHost: HostEnv = {
  run,
  sudoersDir: SUDOERS_DIR,
  sudoersOwner: { uid: 0, gid: 0 },
  sitesEnabled: NGINX_SITES_ENABLED,
  publicPortsBin: PUBLIC_PORTS_BIN,
  warn: printWarning,
};

function detailOf(result: { exitCode: number; stderr: string; stdout: string; timedOut: boolean }): string {
  if (result.timedOut) return 'timed out';
  const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`;
}

// ---------------------------------------------------------------------------
// Sudoers files
// ---------------------------------------------------------------------------

/** `.name.tmp` in the same directory: sudo never reads a name containing `.` */
export function sudoersTempPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return `${dirname(path)}/.${name}.tmp`;
}

/**
 * `/etc/sudoers.d/<user>` belongs to Dockflow when it carries the header, or when every line is a
 * rule shape older Dockflow versions wrote there (they overwrote the file unconditionally).
 * Anything else, a comment included, is the operator's.
 */
export function isDockflowUserSudoers(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines[0]?.startsWith(DOCKFLOW_HEADER_PREFIX)) return true;
  return lines.filter((line) => line !== '').every((line) => DOCKFLOW_RULE_SHAPES.some((shape) => shape.test(line)));
}

function sudoersFileIsCurrent(path: string, content: string, owner: HostEnv['sudoersOwner']): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || (info.mode & 0o7777) !== SUDOERS_FILE_MODE || info.uid !== owner.uid || info.gid !== owner.gid) return false;
  return readFileSync(path, 'utf8') === content;
}

/**
 * Writes a sudoers file the only safe way: temp file 0440 root:root, `visudo -cf` on it, then an
 * atomic rename. Rules visudo rejects never replace the existing file; identical content is not
 * rewritten.
 */
export function writeSudoersFile(path: string, content: string, host: HostEnv = localHost): 'written' | 'unchanged' {
  if (sudoersFileIsCurrent(path, content, host.sudoersOwner)) return 'unchanged';
  const tmp = sudoersTempPath(path);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, 'wx', SUDOERS_FILE_MODE);
  try {
    writeSync(fd, content);
    fchmodSync(fd, SUDOERS_FILE_MODE);
    fchownSync(fd, host.sudoersOwner.uid, host.sudoersOwner.gid);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  const check = host.run(['visudo', '-cf', tmp], { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });
  if (!check.ok) {
    rmSync(tmp, { force: true });
    throw new CLIError(
      `visudo rejected the sudoers rules for ${path}: ${detailOf(check)}`,
      ErrorCode.COMMAND_FAILED,
      'The existing file is unchanged. Run `visudo -c` on the host and fix the file it names, then run setup again.',
    );
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return 'written';
}

/** Removes a sudoers file, then checks that the whole sudoers configuration still parses. */
function removeSudoersFile(path: string, host: HostEnv): void {
  rmSync(path, { force: true });
  const check = host.run(['visudo', '-c'], { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });
  if (!check.ok) {
    throw new CLIError(
      `The sudoers configuration does not parse after removing ${path}: ${detailOf(check)}`,
      ErrorCode.COMMAND_FAILED,
      'Run `visudo -c` on the host and fix the file it names.',
    );
  }
}

/**
 * `/etc/sudoers.d/<user>` is written with exactly `rules`, or removed when there are none. A file
 * the operator edited is left byte-identical.
 */
function syncUserSudoers(username: string, rules: readonly string[], host: HostEnv): void {
  const path = `${host.sudoersDir}/${username}`;
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info !== undefined && !(info.isFile() && isDockflowUserSudoers(readFileSync(path, 'utf8')))) {
    if (rules.length > 0) {
      host.warn(
        `Service access: ${path} was edited outside Dockflow, so it is left unchanged. Delete it to let Dockflow manage the rules for ${username}.`,
      );
    }
    return;
  }
  if (rules.length > 0) writeSudoersFile(path, `${USER_SUDOERS_HEADER}\n${rules.join('\n')}\n`, host);
  else if (info !== undefined) removeSudoersFile(path, host);
}

/** the `user` directive of `nginx -T` output */
export function nginxUserFrom(configDump: string): string | null {
  for (const line of configDump.split(/\r?\n/)) {
    const match = /^\s*user\s+([^\s;]+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Configure nginx group access and deploy-time sudoers for a deploy user.
 *
 * Safe to call multiple times — writes are idempotent.
 * Must be called AFTER nginx and the filter of published ports are installed, so call it again
 * post-provisioning if they were installed during setup.
 */
export function configureServiceAccess(username: string, overrides: Partial<HostEnv> = {}): void {
  const host: HostEnv = { ...localHost, ...overrides };
  const sudoersRules: string[] = [];

  /** Run a privileged config command; failures must be visible, not silent. */
  const tryRun = (label: string, argv: string[]): void => {
    const result = host.run(argv, { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });
    if (!result.ok) {
      host.warn(`Service access: ${label} failed: ${detailOf(result)}`);
    }
  };

  // docker: group membership for socket access. The group only exists once
  // Docker is installed, which happens AFTER user creation — this re-run
  // post-provisioning is what actually grants the access.
  if (host.run(['getent', 'group', 'docker'], { quiet: true }).ok) {
    tryRun('docker group membership', ['usermod', '-aG', 'docker', username]);
  }

  // nginx: group-write on sites-enabled + restricted sudo for test/reload only
  const nginxBin = host.run(['which', 'nginx'], { quiet: true }).stdout.trim();
  if (nginxBin && statSync(host.sitesEnabled, { throwIfNoEntry: false })?.isDirectory()) {
    const dump = host.run([nginxBin, '-T'], { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });
    const nginxUser = dump.ok ? nginxUserFrom(dump.stdout) : null;
    const nginxGroup = nginxUser ?? (host.run(['getent', 'group', 'nginx'], { quiet: true }).ok ? 'nginx' : 'www-data');
    tryRun('nginx group membership', ['usermod', '-aG', nginxGroup, username]);
    tryRun('sites-enabled group ownership', ['chgrp', '-R', '--', nginxGroup, host.sitesEnabled]);
    tryRun('sites-enabled group permissions', ['chmod', '-R', 'g+rwX', '--', host.sitesEnabled]);
    sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${nginxBin} -t, ${nginxBin} -s reload`);
  }

  // deploys record the project's public ports in the filter of published ports
  if (statSync(host.publicPortsBin, { throwIfNoEntry: false }) !== undefined) {
    sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${host.publicPortsBin}`);
  }

  try {
    syncUserSudoers(username, sudoersRules, host);
  } catch (error) {
    host.warn(
      `Service access: could not update ${host.sudoersDir}/${username}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Create deployment user with docker group access and service permissions.
 */
export function createDeployUser(username: string, password: string, publicKey: string): boolean {
  const spinner = createSpinner();
  spinner.start(`Creating user ${username}...`);

  let result = spawnSync('useradd', ['-m', '-s', '/bin/bash', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const userAlreadyExists = result.status !== 0 && result.stderr.includes('already exists');
  if (result.status !== 0 && !userAlreadyExists) {
    spinner.fail(`Failed to create user: ${result.stderr}`);
    return false;
  }

  // Only set the password on a freshly created user — re-running setup must
  // never silently reset an existing user's password.
  if (userAlreadyExists) {
    printWarning(`User ${username} already exists — password left unchanged`);
  } else {
    const chpasswd = spawnSync('chpasswd', [], {
      input: `${username}:${password}`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (chpasswd.status !== 0) {
      spinner.fail(`Failed to set password: ${chpasswd.stderr}`);
      return false;
    }
  }

  // Add user to docker group (if docker is installed)
  spawnSync('usermod', ['-aG', 'docker', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const userHome = `/home/${username}`;
  const userSSHDir = `${userHome}/.ssh`;

  spawnSync('mkdir', ['-p', userSSHDir], { encoding: 'utf-8' });
  spawnSync('sh', ['-c', `touch ${userSSHDir}/authorized_keys && grep -qF "${publicKey}" ${userSSHDir}/authorized_keys || echo "${publicKey}" >> ${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });
  spawnSync('chown', ['-R', `${username}:${username}`, userSSHDir], { encoding: 'utf-8' });
  spawnSync('chmod', ['700', userSSHDir], { encoding: 'utf-8' });
  spawnSync('chmod', ['600', `${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });

  // Configure service access — best-effort at user creation time.
  // configureServiceAccess() must be called again post-provisioning if
  // nginx or the filter of published ports is installed after this point.
  configureServiceAccess(username);

  spinner.succeed(`User ${username} created successfully`);
  return true;
}

/**
 * Validate user password by testing it with su
 */
export async function validateUserPassword(username: string, password: string): Promise<boolean> {
  if (!username || !password) {
    return false;
  }

  const result = spawnSync('bash', ['-c', `echo '${password}' | /bin/su --command true - '${username}'`], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return result.status === 0;
}

/**
 * Prompt for user password with validation
 */
export async function promptAndValidateUserPassword(username: string): Promise<string> {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const password = await promptPassword(`Password for user ${username}`);

    if (!password) {
      printWarning('Password cannot be empty');
      attempts++;
      continue;
    }

    printInfo('Validating password...');
    if (await validateUserPassword(username, password)) {
      printSuccess('Password validated');
      return password;
    } else {
      attempts++;
      if (attempts < maxAttempts) {
        printWarning(`Invalid password. ${maxAttempts - attempts} attempts remaining.`);
      }
    }
  }

  throw new CLIError(
    'Too many failed password attempts',
    ErrorCode.VALIDATION_FAILED
  );
}
