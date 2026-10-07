/**
 * User management utilities
 *
 * Note: These functions expect to run as root (the remote setup binary
 * is launched with `sudo`), so no individual `sudo` calls are needed.
 * Commands go by argv, never through a shell.
 */

import { closeSync, constants, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
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
const PASSWORD_CHECK_TIMEOUT_MS = 30_000;
const UNPRIVILEGED_ID = 65534;

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

/** sudo skips every file of /etc/sudoers.d whose name contains a dot, so a dotted user name is spelled out. */
export function userSudoersPath(sudoersDir: string, username: string): string {
  return `${sudoersDir}/${username.replace(/\./g, '_dot_')}`;
}

/**
 * `/etc/sudoers.d/<user>` is written with exactly `rules`, or removed when there are none. A file
 * the operator edited is left byte-identical.
 */
function syncUserSudoers(username: string, rules: readonly string[], host: HostEnv): void {
  const path = userSudoersPath(host.sudoersDir, username);
  // older versions wrote the dotted name, which sudo never read
  const unread = `${host.sudoersDir}/${username}`;
  if (unread !== path && lstatSync(unread, { throwIfNoEntry: false })?.isFile() && isDockflowUserSudoers(readFileSync(unread, 'utf8'))) {
    rmSync(unread, { force: true });
  }
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
      `Service access: could not update ${userSudoersPath(host.sudoersDir, username)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Deploy user
// ---------------------------------------------------------------------------

export interface HostUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** a `getent passwd` line: name:x:uid:gid:gecos:home:shell */
export function parsePasswdLine(line: string): HostUser | null {
  const fields = line.trim().split(':');
  if (fields.length < 7) return null;
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || fields[5] === '') return null;
  return { name: fields[0], uid, gid, home: fields[5] };
}

export function lookupUser(username: string, runCommand: CommandRunner = run): HostUser | null {
  const result = runCommand(['getent', 'passwd', username], { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });
  return result.ok ? parsePasswdLine(result.stdout.split('\n')[0] ?? '') : null;
}

/** The user as the system knows it (home, uid, gid), or an error naming it. */
export function requireUser(username: string, runCommand: CommandRunner = run): HostUser {
  const user = lookupUser(username, runCommand);
  if (user === null) {
    throw new CLIError(`User ${username} does not exist on this machine`, ErrorCode.VALIDATION_FAILED);
  }
  return user;
}

/** the base64 blob of an authorized_keys line (`<type> <blob> [comment]`) */
export function keyBlobOf(publicKey: string): string {
  return publicKey.trim().split(/\s+/)[1] ?? '';
}

// The deploy user owns its home, so root must never follow a link it planted there.
// Platforms without these flags (Windows, where only the tests run) take 0.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

function refuseLink(path: string, error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    throw new CLIError(
      `Refusing to touch ${path}: it is a symbolic link or not a directory`,
      ErrorCode.COMMAND_FAILED,
      'Remove it, or fix the home of the deploy user, then run setup again.',
    );
  }
  throw error;
}

/** `~/.ssh` as a real directory, mode 0700, owned by the user */
function prepareSshDir(path: string, user: HostUser): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    return refuseLink(path, error);
  }
  try {
    fchmodSync(fd, 0o700);
    fchownSync(fd, user.uid, user.gid);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `publicKey` to the user's authorized_keys unless a line already holds its blob, whatever
 * its comment. The key is data in a file, never part of a command. Returns whether it was added.
 */
export function authorizeKey(user: HostUser, publicKey: string): boolean {
  const key = publicKey.trim();
  const blob = keyBlobOf(key);
  if (blob === '' || /[\r\n]/.test(key)) {
    throw new CLIError('The public key is not a single "<type> <key> [comment]" line', ErrorCode.VALIDATION_FAILED);
  }
  const sshDir = `${user.home}/.ssh`;
  const keysPath = `${sshDir}/authorized_keys`;
  prepareSshDir(sshDir, user);
  let fd: number;
  try {
    fd = openSync(keysPath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600);
  } catch (error) {
    return refuseLink(keysPath, error);
  }
  try {
    const current = readFileSync(fd, 'utf8');
    const present = current.split(/\r?\n/).some((line) => line.split(/\s+/).includes(blob));
    if (!present) writeSync(fd, `${current === '' || current.endsWith('\n') ? '' : '\n'}${key}\n`);
    fchmodSync(fd, 0o600);
    fchownSync(fd, user.uid, user.gid);
    return !present;
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates the deploy user when absent (`useradd -m -U -s /bin/bash`, the password through
 * chpasswd's stdin) and authorizes the key in the home `getent passwd` reports. An existing user's
 * password is never changed.
 */
export function ensureDeployUser(
  username: string,
  password: string,
  publicKey: string,
  host: Pick<HostEnv, 'run'> = localHost,
): { user: HostUser; created: boolean; keyAdded: boolean } {
  const fail = (what: string, result: Parameters<typeof detailOf>[0]): never => {
    throw new CLIError(`${what}: ${detailOf(result)}`, ErrorCode.COMMAND_FAILED);
  };
  let user = lookupUser(username, host.run);
  const created = user === null;
  if (user === null) {
    // chpasswd reads one "user:password" per line: a newline would set another account's password
    if (/[\r\n]/.test(password)) throw new CLIError('The password cannot contain a line break', ErrorCode.VALIDATION_FAILED);
    const add = host.run(['useradd', '-m', '-U', '-s', '/bin/bash', '--', username], { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });
    if (!add.ok) fail(`Failed to create user ${username}`, add);
    const chpasswd = host.run(['chpasswd'], { quiet: true, input: `${username}:${password}\n`, timeoutMs: COMMAND_TIMEOUT_MS });
    if (!chpasswd.ok) fail(`Failed to set the password of ${username}`, chpasswd);
    user = lookupUser(username, host.run);
    if (user === null) throw new CLIError(`Created user ${username}, but getent passwd does not know it`, ErrorCode.COMMAND_FAILED);
  } else {
    printWarning(`User ${username} already exists — password left unchanged`);
  }

  // Docker may not be installed yet: configureServiceAccess runs again once it is
  host.run(['usermod', '-aG', 'docker', username], { quiet: true, timeoutMs: COMMAND_TIMEOUT_MS });

  return { user, created, keyAdded: authorizeKey(user, publicKey) };
}

/**
 * Create deployment user with docker group access and service permissions.
 */
export function createDeployUser(username: string, password: string, publicKey: string): boolean {
  const spinner = createSpinner();
  spinner.start(`Creating user ${username}...`);

  let created: boolean;
  try {
    ({ created } = ensureDeployUser(username, password, publicKey));
  } catch (error) {
    spinner.fail(error instanceof Error ? error.message : String(error));
    return false;
  }

  // Configure service access — best-effort at user creation time.
  // configureServiceAccess() must be called again post-provisioning if
  // nginx or the filter of published ports is installed after this point.
  configureServiceAccess(username);

  spinner.succeed(created ? `User ${username} created successfully` : `User ${username} is ready`);
  return true;
}

export type PasswordCheck = { verdict: boolean } | { verdict: 'unverified'; reason: string };

/** `su -c true - <user>`, run by nobody when the caller is root: su run by root authenticates nothing (pam_rootok). */
export function passwordCheckArgv(username: string, effectiveUid: number): string[] {
  const argv = ['su', '-c', 'true', '-', username];
  if (effectiveUid !== 0) return argv;
  return ['setpriv', `--reuid=${UNPRIVILEGED_ID}`, `--regid=${UNPRIVILEGED_ID}`, '--clear-groups', '--', ...argv];
}

/**
 * Checks a user's password without a shell: the user name is one argv element and the password
 * travels on su's stdin only, so it is in no process listing and no quote can break out. A host that
 * cannot run the check answers 'unverified', never a silent yes.
 */
export function checkUserPassword(
  username: string,
  password: string,
  runCommand: CommandRunner = run,
  effectiveUid: number = process.geteuid?.() ?? -1,
): PasswordCheck {
  if (!username || !password) return { verdict: false };
  const argv = passwordCheckArgv(username, effectiveUid);
  const result = runCommand(argv, { quiet: true, input: `${password}\n`, timeoutMs: PASSWORD_CHECK_TIMEOUT_MS });
  if (result.exitCode === 127) return { verdict: 'unverified', reason: `${argv[0]} is not installed` };
  if (result.timedOut) return { verdict: 'unverified', reason: 'su did not answer' };
  if (/must be run from a terminal/i.test(result.stderr)) return { verdict: 'unverified', reason: 'su needs a terminal' };
  return { verdict: result.ok };
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
    const check = checkUserPassword(username, password);
    if (check.verdict === 'unverified') {
      printWarning(`The password of ${username} could not be verified on this host (${check.reason}); using it as typed`);
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
