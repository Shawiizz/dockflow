/**
 * User management utilities
 *
 * Note: These functions expect to run as root (the remote setup binary
 * is launched with `sudo`), so no individual `sudo` calls are needed.
 */

import { spawnSync } from 'child_process';
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

  result = spawnSync('usermod', ['-aG', 'sudo', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    result = spawnSync('usermod', ['-aG', 'wheel', username], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  // Add user to docker group (if docker is installed)
  spawnSync('usermod', ['-aG', 'docker', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const userHome = `/home/${username}`;
  const userSSHDir = `${userHome}/.ssh`;

  spawnSync('mkdir', ['-p', userSSHDir], { encoding: 'utf-8' });
  // Always ensure the provided key is in authorized_keys (append if not already present)
  spawnSync('sh', ['-c', `touch ${userSSHDir}/authorized_keys && grep -qF "${publicKey}" ${userSSHDir}/authorized_keys || echo "${publicKey}" >> ${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });
  spawnSync('chown', ['-R', `${username}:${username}`, userSSHDir], { encoding: 'utf-8' });
  spawnSync('chmod', ['700', userSSHDir], { encoding: 'utf-8' });
  spawnSync('chmod', ['600', `${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });

  const sudoersContent = `${username} ALL=(ALL) NOPASSWD: ALL`;
  spawnSync('sh', ['-c', `echo "${sudoersContent}" > /etc/sudoers.d/${username}`], { encoding: 'utf-8' });
  spawnSync('chmod', ['440', `/etc/sudoers.d/${username}`], { encoding: 'utf-8' });

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
