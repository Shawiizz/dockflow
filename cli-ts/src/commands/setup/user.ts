/**
 * User management utilities
 */

import { spawnSync } from 'child_process';
import ora from 'ora';
import { printError, printWarning, printSuccess, printInfo } from '../../utils/output';
import { promptPassword } from './prompts';

/**
 * Create deployment user with sudo privileges
 */
export function createDeployUser(username: string, password: string, publicKey: string): boolean {
  const spinner = ora(`Creating user ${username}...`).start();

  let result = spawnSync('sudo', ['useradd', '-m', '-s', '/bin/bash', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0 && !result.stderr.includes('already exists')) {
    spinner.fail(`Failed to create user: ${result.stderr}`);
    return false;
  }

  const chpasswd = spawnSync('sudo', ['chpasswd'], {
    input: `${username}:${password}`,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (chpasswd.status !== 0) {
    spinner.fail(`Failed to set password: ${chpasswd.stderr}`);
    return false;
  }

  result = spawnSync('sudo', ['usermod', '-aG', 'sudo', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    result = spawnSync('sudo', ['usermod', '-aG', 'wheel', username], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  const userHome = `/home/${username}`;
  const userSSHDir = `${userHome}/.ssh`;

  spawnSync('sudo', ['mkdir', '-p', userSSHDir], { encoding: 'utf-8' });
  spawnSync('sudo', ['sh', '-c', `echo "${publicKey}" > ${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });
  spawnSync('sudo', ['chown', '-R', `${username}:${username}`, userSSHDir], { encoding: 'utf-8' });
  spawnSync('sudo', ['chmod', '700', userSSHDir], { encoding: 'utf-8' });
  spawnSync('sudo', ['chmod', '600', `${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });

  const sudoersContent = `${username} ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker-compose, /usr/bin/systemctl`;
  spawnSync('sudo', ['sh', '-c', `echo "${sudoersContent}" > /etc/sudoers.d/${username}`], { encoding: 'utf-8' });
  spawnSync('sudo', ['chmod', '440', `/etc/sudoers.d/${username}`], { encoding: 'utf-8' });

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

  const isRoot = process.getuid?.() === 0;

  let result;
  if (isRoot) {
    result = spawnSync('sudo', ['-u', username, 'bash', '-c', `echo '${password}' | /bin/su --command true - '${username}'`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } else {
    result = spawnSync('bash', ['-c', `echo '${password}' | /bin/su --command true - '${username}'`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

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
        printError(`Invalid password. ${maxAttempts - attempts} attempts remaining.`);
      }
    }
  }

  printError('Too many failed attempts');
  process.exit(1);
}
