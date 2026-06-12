/**
 * User management utilities
 *
 * Note: These functions expect to run as root (the remote setup binary
 * is launched with `sudo`), so no individual `sudo` calls are needed.
 */

import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { printWarning, printSuccess, printInfo, createSpinner } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { promptPassword } from './prompts';

const K3S_TOKEN_PATH = '/var/lib/rancher/k3s/server/node-token';
const NGINX_SITES_ENABLED = '/etc/nginx/sites-enabled';

/**
 * Configure nginx group access and deploy-time sudoers for a deploy user.
 *
 * Safe to call multiple times — writes are idempotent.
 * Must be called AFTER nginx/k3s are installed, so call it again
 * post-provisioning if those services were installed during setup.
 */
export function configureServiceAccess(username: string): void {
  const sudoersRules: string[] = [];

  /** Run a privileged config command; failures must be visible, not silent. */
  const tryRun = (label: string, cmd: string, args: string[]): void => {
    const result = spawnSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe' });
    if (result.status !== 0) {
      printWarning(`Service access: ${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
  };

  // docker: group membership for socket access. The group only exists once
  // Docker is installed, which happens AFTER user creation — this re-run
  // post-provisioning is what actually grants the access.
  if (spawnSync('getent', ['group', 'docker'], { encoding: 'utf-8', stdio: 'pipe' }).status === 0) {
    tryRun('docker group membership', 'usermod', ['-aG', 'docker', username]);
  }

  // nginx: group-write on sites-enabled + restricted sudo for test/reload only
  const nginxBin = spawnSync('which', ['nginx'], { encoding: 'utf-8', stdio: 'pipe' }).stdout.trim();
  if (nginxBin && spawnSync('test', ['-d', NGINX_SITES_ENABLED], { encoding: 'utf-8', stdio: 'pipe' }).status === 0) {
    const nginxUser = spawnSync('sh', ['-c', "nginx -T 2>/dev/null | awk '/^user[[:space:]]/{gsub(\";\",\"\",$2); print $2; exit}'"], { encoding: 'utf-8', stdio: 'pipe' }).stdout.trim();
    const nginxGroup = nginxUser || (spawnSync('getent', ['group', 'nginx'], { encoding: 'utf-8', stdio: 'pipe' }).status === 0 ? 'nginx' : 'www-data');
    tryRun('nginx group membership', 'usermod', ['-aG', nginxGroup, username]);
    tryRun('sites-enabled group ownership', 'chgrp', ['-R', nginxGroup, NGINX_SITES_ENABLED]);
    tryRun('sites-enabled group permissions', 'chmod', ['-R', 'g+rwX', NGINX_SITES_ENABLED]);
    sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${nginxBin} -t, ${nginxBin} -s reload`);
  }

  // k3s: deploy-time image operations (import/export/ls) + one-time token read.
  // Fallback to /usr/local/bin/k3s — the k3s installer always uses that path.
  const k3sBin = spawnSync('which', ['k3s'], { encoding: 'utf-8', stdio: 'pipe' }).stdout.trim() || '/usr/local/bin/k3s';
  sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${k3sBin} ctr -n k8s.io images *`);
  const catBin = spawnSync('which', ['cat'], { encoding: 'utf-8', stdio: 'pipe' }).stdout.trim() || '/bin/cat';
  sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${catBin} ${K3S_TOKEN_PATH}`);

  try {
    writeFileSync(`/etc/sudoers.d/${username}`, sudoersRules.join('\n') + '\n', { mode: 0o440 });
  } catch (error) {
    printWarning(
      `Service access: could not write /etc/sudoers.d/${username}: ${error instanceof Error ? error.message : String(error)}`,
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
  // nginx/k3s are installed after this point.
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
