/**
 * User management utilities
 *
 * Note: These functions expect to run as root (the remote setup binary
 * is launched with `sudo`, the k3s node step runs as root), so no individual
 * `sudo` calls are needed. Every process and file access goes through a
 * HostRunner (argv only, never a shell), so the k3s node step reuses them.
 */

import { dirname } from 'path';
import { NGINX_SITES_ENABLED } from '../../constants';
import { K3S_SUDOERS_HEADER, renderK3sSudoers } from '../../services/orchestrator/kubernetes/k3s/sudoers';
import { CLIError, ErrorCode } from '../../utils/errors';
import { createSpinner, printInfo, printSuccess, printWarning } from '../../utils/output';
import { SUDOERS_K3S_FILE } from './k3s/constants';
import { firstLineOf, type HostRunner, type HostUser, localHostRunner } from './k3s/host-runner';
import { promptPassword } from './prompts';
import type { SetupOrchestrator } from './types';

export const SUDOERS_DIR = '/etc/sudoers.d';
export const SUDOERS_FILE_MODE = 0o440;
/** First line of `/etc/sudoers.d/<user>` when Dockflow wrote it (design-05 13.3). */
export const USER_SUDOERS_HEADER = '# Managed by Dockflow (dockflow setup). Changes are overwritten.';
const DOCKFLOW_HEADER_PREFIX = '# Managed by Dockflow';
/** The root-equivalent rules older versions wrote; `prepare` removes them and reports leftovers (K57b). */
export const LEGACY_SUDO_MARKERS: readonly string[] = ['k3s ctr -n k8s.io images *', 'node-token'];
// Rule shapes older Dockflow versions wrote into /etc/sudoers.d/<user> (user.ts before K57b)
const LEGACY_RULE_SHAPES: readonly RegExp[] = [
  /^\S+ ALL=\(ALL\) NOPASSWD: \S*nginx -t, \S*nginx -s reload$/,
  /^\S+ ALL=\(ALL\) NOPASSWD: \S*k3s ctr -n k8s\.io images \*$/,
  /^\S+ ALL=\(ALL\) NOPASSWD: \S*cat \/var\/lib\/rancher\/k3s\/server\/node-token$/,
];
const COMMAND_TIMEOUT_MS = 60_000;
const PASSWORD_CHECK_TIMEOUT_MS = 30_000;
/** nobody: `su` run by root authenticates nothing (pam_rootok), run by nobody it asks PAM */
const UNPRIVILEGED_ID = 65534;

export const userMessages = {
  sudoersInvalid: (user: string, key: string, output: string): string =>
    `The generated sudoers rules for ${user} are invalid on ${key}: ${output}`,
  sudoersBrokenAfterRemoval: (path: string, key: string, output: string): string =>
    `The sudoers configuration on ${key} does not parse after removing ${path}: ${output}`,
  sudoersSuggestion: 'Run `visudo -c` on the host and fix the file it names, then run setup again.',
  serviceAccessFailed: (label: string, detail: string): string => `Service access: ${label} failed: ${detail}`,
  rootDeployUser: (key: string): string => `The deploy user on ${key} is root; Dockflow recommends a dedicated user`,
  userSudoersForeign: (path: string, key: string): string =>
    `${path} on ${key} was edited outside Dockflow, so it is left unchanged (its nginx rules are not rewritten)`,
  legacySudoRules: (key: string, files: readonly string[]): { message: string; suggestion: string } => ({
    message: `Legacy root-equivalent sudo rules are still present on ${key} (${files.join(', ')})`,
    suggestion: `Inspect them with \`sudo cat ${files[0] ?? `${SUDOERS_DIR}/<file>`}\` and delete them; Dockflow no longer needs them.`,
  }),
  createUserFailed: (user: string, detail: string): string => `Failed to create user ${user}: ${detail}`,
  passwordUnverified: (user: string, reason: string): string =>
    `The password of ${user} could not be verified on this host (${reason})`,
} as const;

function detailOf(result: { exitCode: number; stderr: string; stdout: string; timedOut: boolean }): string {
  if (result.timedOut) return 'timed out';
  return firstLineOf(result.stderr) || firstLineOf(result.stdout) || `exit ${result.exitCode}`;
}

// ---------------------------------------------------------------------------
// Sudoers files (design-05 13.2, 13.3)
// ---------------------------------------------------------------------------

export function userSudoersPath(username: string): string {
  return `${SUDOERS_DIR}/${username}`;
}

/** `.name.tmp` in the same directory: sudo never reads a name containing `.` */
export function sudoersTempPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return `${dirname(path)}/.${name}.tmp`;
}

/** lines of a sudoers file holding one of the legacy root-equivalent rules */
export function legacyRulesIn(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#') && LEGACY_SUDO_MARKERS.some((marker) => line.includes(marker)));
}

/**
 * `/etc/sudoers.d/<user>` belongs to Dockflow when it carries the header, or when every rule line has
 * a shape older Dockflow versions wrote there (they overwrote the file unconditionally).
 */
export function isDockflowUserSudoers(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines[0]?.startsWith(DOCKFLOW_HEADER_PREFIX)) return true;
  return lines.filter((line) => line !== '' && !line.startsWith('#')).every((line) => LEGACY_RULE_SHAPES.some((shape) => shape.test(line)));
}

/** Files under /etc/sudoers.d still holding a legacy rule (the `legacySudoRules` probe, 4.1). */
export async function findLegacySudoRules(runner: HostRunner = localHostRunner): Promise<string[]> {
  const names = (await runner.readDir(SUDOERS_DIR)) ?? [];
  const files: string[] = [];
  for (const name of [...names].sort()) {
    const path = `${SUDOERS_DIR}/${name}`;
    const info = await runner.stat(path);
    if (info?.type !== 'file') continue;
    const content = await runner.readFile(path);
    if (content !== null && legacyRulesIn(content.toString('utf8')).length > 0) files.push(path);
  }
  return files;
}

export interface SudoersWriteOptions {
  runner?: HostRunner;
  /** servers.yml key (or host) named in messages */
  key?: string;
  /** the user the rules are for, named in messages */
  user?: string;
}

/**
 * Writes a sudoers file the only safe way (13.2): temp file 0440 root:root, `visudo -cf` on it, then
 * an atomic rename. An invalid file never replaces the existing one; an identical file is not
 * rewritten.
 */
export async function writeSudoersFile(path: string, content: string, options: SudoersWriteOptions = {}): Promise<'written' | 'unchanged'> {
  const runner = options.runner ?? localHostRunner;
  const key = options.key ?? 'this host';
  const current = await runner.stat(path);
  if (current?.type === 'file' && current.mode === SUDOERS_FILE_MODE && current.uid === 0 && current.gid === 0) {
    const bytes = await runner.readFile(path);
    if (bytes !== null && bytes.toString('utf8') === content) return 'unchanged';
  }
  const tmp = sudoersTempPath(path);
  await runner.remove(tmp);
  await runner.writeFile(tmp, content, { mode: SUDOERS_FILE_MODE, uid: 0, gid: 0 });
  const check = await runner.run(['visudo', '-cf', tmp], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (check.exitCode !== 0 || check.timedOut) {
    await runner.remove(tmp);
    const output = [check.stdout, check.stderr].map((text) => text.trim()).filter((text) => text !== '').join(' ') || `exit ${check.exitCode}`;
    throw new CLIError(
      userMessages.sudoersInvalid(options.user ?? path.slice(path.lastIndexOf('/') + 1), key, output),
      ErrorCode.COMMAND_FAILED,
      userMessages.sudoersSuggestion,
    );
  }
  try {
    await runner.rename(tmp, path);
  } catch (error) {
    await runner.remove(tmp);
    throw error;
  }
  return 'written';
}

/** Removes a sudoers file, then checks that the whole configuration still parses. */
async function removeSudoersFile(runner: HostRunner, path: string, key: string): Promise<void> {
  await runner.remove(path);
  const check = await runner.run(['visudo', '-c'], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (check.exitCode !== 0 || check.timedOut) {
    throw new CLIError(userMessages.sudoersBrokenAfterRemoval(path, key, detailOf(check)), ErrorCode.COMMAND_FAILED, userMessages.sudoersSuggestion);
  }
}

/** `/etc/sudoers.d/dockflow-k3s` is removed only when Dockflow wrote it (its first line is the header). */
async function removeK3sSudoers(runner: HostRunner, key: string): Promise<void> {
  const content = await runner.readFile(SUDOERS_K3S_FILE);
  if (content === null) return;
  if (content.toString('utf8').split(/\r?\n/)[0] !== K3S_SUDOERS_HEADER) return;
  await removeSudoersFile(runner, SUDOERS_K3S_FILE, key);
}

/**
 * `/etc/sudoers.d/<user>` is always rewritten with exactly `rules`, or removed when there are none
 * (K57b): that is what drops the legacy rules on hosts without nginx. A file edited by the operator
 * is left byte-identical; its legacy lines are reported by findLegacySudoRules.
 */
async function syncUserSudoers(
  runner: HostRunner,
  username: string,
  rules: readonly string[],
  key: string,
  onWarning: (message: string) => void,
): Promise<void> {
  const path = userSudoersPath(username);
  const current = await runner.readFile(path);
  if (current !== null && !isDockflowUserSudoers(current.toString('utf8'))) {
    if (rules.length > 0) onWarning(userMessages.userSudoersForeign(path, key));
    return;
  }
  if (rules.length > 0) {
    await writeSudoersFile(path, `${USER_SUDOERS_HEADER}\n${rules.join('\n')}\n`, { runner, key, user: username });
  } else if (current !== null) {
    await removeSudoersFile(runner, path, key);
  }
}

// ---------------------------------------------------------------------------
// Service access (design-05 13.3, 19.3)
// ---------------------------------------------------------------------------

export interface ServiceAccessOptions {
  runner?: HostRunner;
  /** servers.yml key (or host) named in messages; default `this host` */
  key?: string;
  /** receives the warnings (root deploy user, a hand-edited sudoers file) */
  onWarning?: (message: string) => void;
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
 * Configures the deploy user's group memberships and sudo rules for `orchestrator`, and returns the
 * rules written to `/etc/sudoers.d/<user>` (nginx rules only, never k3s rules). Docker group only
 * on Swarm; on k3s the image commands go to `/etc/sudoers.d/dockflow-k3s` (rendered by
 * kubernetes/k3s/sudoers.ts), on Swarm a Dockflow-written copy of that file is removed. Failures
 * throw: a missing sudo rule would only surface at the next deploy.
 *
 * Safe to call multiple times. Must be called AFTER nginx is installed.
 */
export async function configureServiceAccess(
  username: string,
  orchestrator: SetupOrchestrator,
  options: ServiceAccessOptions = {},
): Promise<string[]> {
  const runner = options.runner ?? localHostRunner;
  const key = options.key ?? 'this host';
  const onWarning = options.onWarning ?? printWarning;
  const rules: string[] = [];

  const mustRun = async (label: string, argv: string[]): Promise<void> => {
    const result = await runner.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new CLIError(userMessages.serviceAccessFailed(label, detailOf(result)), ErrorCode.COMMAND_FAILED);
    }
  };

  // docker: the socket group is Swarm's; k3s runs its own containerd
  if (orchestrator === 'swarm' && (await runner.run(['getent', 'group', 'docker'])).exitCode === 0) {
    await mustRun('docker group membership', ['usermod', '-aG', 'docker', username]);
  }

  // nginx: group-write on sites-enabled + restricted sudo for test/reload only
  const which = await runner.run(['which', 'nginx']);
  const nginxBin = which.exitCode === 0 ? which.stdout.trim().split(/\r?\n/)[0] : '';
  if (nginxBin && (await runner.stat(NGINX_SITES_ENABLED))?.type === 'directory') {
    const dump = await runner.run([nginxBin, '-T'], { timeoutMs: COMMAND_TIMEOUT_MS });
    const nginxUser = dump.exitCode === 0 ? nginxUserFrom(dump.stdout) : null;
    const nginxGroup = nginxUser ?? ((await runner.run(['getent', 'group', 'nginx'])).exitCode === 0 ? 'nginx' : 'www-data');
    await mustRun('nginx group membership', ['usermod', '-aG', nginxGroup, username]);
    await mustRun('sites-enabled group ownership', ['chgrp', '-R', '--', nginxGroup, NGINX_SITES_ENABLED]);
    await mustRun('sites-enabled group permissions', ['chmod', '-R', 'g+rwX', '--', NGINX_SITES_ENABLED]);
    rules.push(`${username} ALL=(ALL) NOPASSWD: ${nginxBin} -t, ${nginxBin} -s reload`);
  }

  await syncUserSudoers(runner, username, rules, key, onWarning);

  if (orchestrator === 'k3s' && username !== 'root') {
    await writeSudoersFile(SUDOERS_K3S_FILE, renderK3sSudoers(username), { runner, key, user: username });
  } else {
    if (orchestrator === 'k3s') onWarning(userMessages.rootDeployUser(key));
    await removeK3sSudoers(runner, key);
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Deploy user (design-05 4.3, 19.3)
// ---------------------------------------------------------------------------

export interface DeployUserOptions {
  runner?: HostRunner;
  /** the password of a newly created user; ignored for an existing one */
  password?: string;
  /** cluster mode: `usermod -p '*'`, usable with key authentication only */
  passwordless?: boolean;
  onWarning?: (message: string) => void;
}

export interface DeployUserResult {
  user: HostUser;
  created: boolean;
  /** the key line was appended to authorized_keys */
  keyAdded: boolean;
}

/** the base64 blob of an authorized_keys line (`<type> <blob> [comment]`) */
export function keyBlobOf(publicKey: string): string {
  const fields = publicKey.trim().split(/\s+/);
  return fields.length >= 2 ? fields[1] : fields[0] ?? '';
}

/**
 * Creates the deploy user when absent (`useradd -m -U -s /bin/bash`, then the password through
 * chpasswd's stdin or `usermod -p '*'`), and appends the key to `~/.ssh/authorized_keys` when its
 * blob is absent: files handled directly, the key never reaches a command line. The home comes from
 * `getent passwd`. An existing user's password is never changed.
 */
export async function ensureDeployUser(username: string, publicKey: string, options: DeployUserOptions = {}): Promise<DeployUserResult> {
  const runner = options.runner ?? localHostRunner;
  let user = await runner.lookupUser(username);
  let created = false;
  if (user === null) {
    const add = await runner.run(['useradd', '-m', '-U', '-s', '/bin/bash', username], { timeoutMs: COMMAND_TIMEOUT_MS });
    if (add.exitCode !== 0 || add.timedOut) {
      throw new CLIError(userMessages.createUserFailed(username, detailOf(add)), ErrorCode.COMMAND_FAILED);
    }
    created = true;
    const secret = options.passwordless
      ? await runner.run(['usermod', '-p', '*', username], { timeoutMs: COMMAND_TIMEOUT_MS })
      : options.password !== undefined
        ? await runner.run(['chpasswd'], { input: `${username}:${options.password}\n`, timeoutMs: COMMAND_TIMEOUT_MS })
        : null;
    if (secret !== null && (secret.exitCode !== 0 || secret.timedOut)) {
      throw new CLIError(userMessages.createUserFailed(username, detailOf(secret)), ErrorCode.COMMAND_FAILED);
    }
    user = await runner.lookupUser(username);
    if (user === null) throw new CLIError(userMessages.createUserFailed(username, 'getent passwd does not know it'), ErrorCode.COMMAND_FAILED);
  } else if (options.password !== undefined) {
    (options.onWarning ?? printWarning)(`User ${username} already exists — password left unchanged`);
  }

  const sshDir = `${user.home}/.ssh`;
  const keysPath = `${sshDir}/authorized_keys`;
  const dirInfo = await runner.stat(sshDir);
  if (dirInfo?.type !== 'directory' || dirInfo.mode !== 0o700 || dirInfo.uid !== user.uid || dirInfo.gid !== user.gid) {
    await runner.mkdir(sshDir, { mode: 0o700, uid: user.uid, gid: user.gid });
  }
  const current = (await runner.readFile(keysPath))?.toString('utf8') ?? null;
  const blob = keyBlobOf(publicKey);
  const keyAdded = blob !== '' && !(current ?? '').split(/\r?\n/).some((line) => line.split(/\s+/).includes(blob));
  if (keyAdded || current === null) {
    const base = current === null || current === '' || current.endsWith('\n') ? (current ?? '') : `${current}\n`;
    await runner.writeFile(keysPath, keyAdded ? `${base}${publicKey.trim()}\n` : base, { mode: 0o600, uid: user.uid, gid: user.gid });
  } else {
    const info = await runner.stat(keysPath);
    if (info !== null && (info.mode !== 0o600 || info.uid !== user.uid || info.gid !== user.gid)) {
      await runner.chmod(keysPath, 0o600);
      await runner.chown(keysPath, user.uid, user.gid);
    }
  }
  return { user, created, keyAdded };
}

/**
 * Create the deployment user of a local setup (spinner output). Group memberships and sudo rules
 * are configured afterwards by configureServiceAccess, once Docker or nginx exist.
 */
export async function createDeployUser(
  username: string,
  password: string,
  publicKey: string,
  options: { runner?: HostRunner; passwordless?: boolean } = {},
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start(`Creating user ${username}...`);
  try {
    await ensureDeployUser(username, publicKey, {
      runner: options.runner,
      password: options.passwordless ? undefined : password,
      passwordless: options.passwordless,
    });
  } catch (error) {
    spinner.fail(error instanceof Error ? error.message : String(error));
    return false;
  }
  spinner.succeed(`User ${username} created successfully`);
  return true;
}

// ---------------------------------------------------------------------------
// Password check (design-05 19.3, K57a)
// ---------------------------------------------------------------------------

export type PasswordCheck = { verdict: boolean } | { verdict: 'unverified'; reason: string };

/** `su -c true - <user>`, run through setpriv as nobody when the caller is root (pam_rootok) */
export function passwordCheckArgv(username: string, effectiveUid: number): string[] {
  const argv = ['su', '-c', 'true', '-', username];
  if (effectiveUid !== 0) return argv;
  return ['setpriv', `--reuid=${UNPRIVILEGED_ID}`, `--regid=${UNPRIVILEGED_ID}`, '--clear-groups', '--', ...argv];
}

/**
 * Checks a user's password without a shell: the user name is one argv element and the password
 * only travels on su's stdin, so it is in no process listing and no quote can break out.
 */
export async function checkUserPassword(username: string, password: string, runner: HostRunner = localHostRunner): Promise<PasswordCheck> {
  if (!username || !password) return { verdict: false };
  const argv = passwordCheckArgv(username, runner.effectiveUid());
  const result = await runner.run(argv, { input: `${password}\n`, timeoutMs: PASSWORD_CHECK_TIMEOUT_MS });
  if (result.exitCode === 127) return { verdict: 'unverified', reason: `${argv[0]} is not installed` };
  if (result.timedOut) return { verdict: 'unverified', reason: 'su did not answer' };
  if (/must be run from a terminal/i.test(result.stderr)) return { verdict: 'unverified', reason: 'su needs a terminal' };
  return { verdict: result.exitCode === 0 };
}

/** true / false, or 'unverified' when this host cannot check it (never a silent true) */
export async function validateUserPassword(
  username: string,
  password: string,
  runner: HostRunner = localHostRunner,
): Promise<boolean | 'unverified'> {
  return (await checkUserPassword(username, password, runner)).verdict;
}

/**
 * Prompt for user password with validation
 */
export async function promptAndValidateUserPassword(username: string, runner: HostRunner = localHostRunner): Promise<string> {
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
    const check = await checkUserPassword(username, password, runner);
    if (check.verdict === 'unverified') {
      printWarning(userMessages.passwordUnverified(username, check.reason));
      return password;
    }
    if (check.verdict) {
      printSuccess('Password validated');
      return password;
    }
    attempts++;
    if (attempts < maxAttempts) {
      printWarning(`Invalid password. ${maxAttempts - attempts} attempts remaining.`);
    }
  }

  throw new CLIError(
    'Too many failed password attempts',
    ErrorCode.VALIDATION_FAILED
  );
}
