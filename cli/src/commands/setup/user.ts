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

/**
 * Create deployment user with sudo privileges
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

  const chpasswd = spawnSync('chpasswd', [], {
    input: `${username}:${password}`,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (chpasswd.status !== 0) {
    spinner.fail(`Failed to set password: ${chpasswd.stderr}`);
    return false;
  }

  // Add user to docker group (if docker is installed)
  spawnSync('usermod', ['-aG', 'docker', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Add user to nginx group + grant group write on sites-enabled (if nginx is installed)
  const nginxBin = spawnSync('which', ['nginx'], { encoding: 'utf-8', stdio: 'pipe' }).stdout.trim();
  if (nginxBin) {
    const hasNginxGroup = spawnSync('getent', ['group', 'nginx'], { encoding: 'utf-8', stdio: 'pipe' }).status === 0;
    const nginxGroup = hasNginxGroup ? 'nginx' : 'www-data';
    spawnSync('usermod', ['-aG', nginxGroup, username], { encoding: 'utf-8', stdio: 'pipe' });
    const sitesEnabled = '/etc/nginx/sites-enabled';
    if (spawnSync('test', ['-d', sitesEnabled], { encoding: 'utf-8', stdio: 'pipe' }).status === 0) {
      spawnSync('chgrp', ['-R', nginxGroup, sitesEnabled], { encoding: 'utf-8', stdio: 'pipe' });
      spawnSync('chmod', ['-R', 'g+rwX', sitesEnabled], { encoding: 'utf-8', stdio: 'pipe' });
    }
  }

  const userHome = `/home/${username}`;
  const userSSHDir = `${userHome}/.ssh`;

  spawnSync('mkdir', ['-p', userSSHDir], { encoding: 'utf-8' });
  // Always ensure the provided key is in authorized_keys (append if not already present)
  spawnSync('sh', ['-c', `touch ${userSSHDir}/authorized_keys && grep -qF "${publicKey}" ${userSSHDir}/authorized_keys || echo "${publicKey}" >> ${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });
  spawnSync('chown', ['-R', `${username}:${username}`, userSSHDir], { encoding: 'utf-8' });
  spawnSync('chmod', ['700', userSSHDir], { encoding: 'utf-8' });
  spawnSync('chmod', ['600', `${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });

  // Minimal sudoers: only the specific binaries dockflow needs at deploy time
  const sudoersRules: string[] = [];
  if (nginxBin) {
    sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${nginxBin} -t, ${nginxBin} -s reload`);
  }
  const k3sBin = spawnSync('which', ['k3s'], { encoding: 'utf-8', stdio: 'pipe' }).stdout.trim();
  if (k3sBin) {
    sudoersRules.push(`${username} ALL=(ALL) NOPASSWD: ${k3sBin} ctr *`);
  }
  if (sudoersRules.length > 0) {
    writeFileSync(`/etc/sudoers.d/${username}`, sudoersRules.join('\n') + '\n', { mode: 0o440 });
  }

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
