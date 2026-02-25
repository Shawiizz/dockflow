/**
 * Non-interactive setup flow
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { printHeader, printSection, printSuccess, printError, printInfo, printWarning, printBlank, colors } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { checkDependencies, installDependencies, detectPackageManager } from './dependencies';
import { detectPublicIP, detectSSHPort, getCurrentUser } from './network';
import { generateSSHKey, addToAuthorizedKeys } from './ssh-keys';
import { createDeployUser } from './user';
import { displayConnectionInfo } from './connection';
import { ensureDockflowRepo, installAnsibleRoles, runAnsiblePlaybook } from './ansible';
import { DOCKFLOW_DIR } from './constants';
import type { SetupOptions, HostConfig } from './types';

/**
 * Run non-interactive setup
 */
export async function runNonInteractiveSetup(options: SetupOptions): Promise<void> {
  printHeader('Machine Setup (Non-Interactive)');
  printBlank();

  const deps = checkDependencies();
  if (!deps.ok) {
    printInfo('Missing required dependencies, attempting automatic installation...');
    deps.missing.forEach(m => printWarning(`  - ${m}`));
    printBlank();
    
    const pm = detectPackageManager();
    if (pm) {
      const success = installDependencies(deps.missingDeps);
      if (!success) {
        throw new CLIError(
          'Failed to install dependencies automatically',
          ErrorCode.COMMAND_FAILED
        );
      }
      printBlank();

      // Re-check dependencies
      const recheck = checkDependencies();
      if (!recheck.ok) {
        throw new CLIError(
          `Some dependencies are still missing: ${recheck.missing.join(', ')}`,
          ErrorCode.VALIDATION_FAILED
        );
      }
    } else {
      throw new CLIError(
        `Could not detect package manager. Please install dependencies manually: ${deps.missing.join(', ')}`,
        ErrorCode.COMMAND_FAILED
      );
    }
  }

  const publicHost = options.host || detectPublicIP();
  const sshPort = parseInt(options.port || detectSSHPort().toString(), 10);
  const currentUser = getCurrentUser();

  let deployUser: string;
  let deployPassword: string | undefined;
  let privateKeyPath: string;
  let needsUserSetup = false;

  if (options.user && options.user !== currentUser) {
    deployUser = options.user;
    deployPassword = options.password;
    needsUserSetup = true;

    if (options.generateKey || !options.sshKey) {
      privateKeyPath = path.join(os.homedir(), '.ssh', `${deployUser}_key`);
      const keyResult = generateSSHKey(privateKeyPath, `dockflow-${deployUser}`);
      if (!keyResult.success) {
        throw new CLIError(
          `Failed to generate SSH key: ${keyResult.error}`,
          ErrorCode.COMMAND_FAILED
        );
      }
      printSuccess(`SSH key generated at ${privateKeyPath}`);
    } else {
      privateKeyPath = options.sshKey;
    }
  } else {
    deployUser = currentUser;
    deployPassword = options.password;

    if (options.sshKey) {
      privateKeyPath = options.sshKey;
    } else {
      privateKeyPath = path.join(os.homedir(), '.ssh', 'dockflow_key');
      if (!fs.existsSync(privateKeyPath) || options.generateKey) {
        const keyResult = generateSSHKey(privateKeyPath, `dockflow-${currentUser}`);
        if (!keyResult.success) {
          throw new CLIError(
            `Failed to generate SSH key: ${keyResult.error}`,
            ErrorCode.COMMAND_FAILED
          );
        }
        addToAuthorizedKeys(`${privateKeyPath}.pub`);
        printSuccess('SSH key generated and added to authorized_keys');
      }
    }
  }

  printSection('Configuration');
  console.log(`${colors.info('Public Host:')} ${publicHost}`);
  console.log(`${colors.info('SSH Port:')} ${sshPort}`);
  console.log(`${colors.info('Deployment User:')} ${deployUser}`);
  console.log(`${colors.info('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  console.log(`${colors.info('Skip Docker Install:')} ${options.skipDockerInstall ? 'Yes' : 'No'}`);
  console.log(`${colors.info('Install Portainer:')} ${options.portainer ? 'Yes' : 'No'}`);
  printBlank();

  let ansibleDir: string;
  try {
    ansibleDir = await ensureDockflowRepo();
  } catch (error) {
    throw new CLIError(
      'Cannot proceed without the Dockflow framework',
      ErrorCode.CONFIG_NOT_FOUND
    );
  }

  if (needsUserSetup && deployPassword) {
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      throw new CLIError(
        'Failed to create deployment user',
        ErrorCode.COMMAND_FAILED
      );
    }
  }

  await installAnsibleRoles(DOCKFLOW_DIR);

  const config: HostConfig = {
    publicHost,
    sshPort,
    deployUser,
    deployPassword,
    privateKeyPath,
    skipDockerInstall: options.skipDockerInstall || false,
    portainer: {
      install: options.portainer || false,
      port: parseInt(options.portainerPort || '9000', 10),
      password: options.portainerPassword,
      domain: options.portainerDomain
    }
  };

  printBlank();
  const success = await runAnsiblePlaybook(config, ansibleDir);

  if (success) {
    printBlank();
    printHeader('Setup Complete');
    printSuccess('The machine has been successfully configured!');

    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo(config, privateKey);
  } else {
    throw new CLIError(
      'Setup failed',
      ErrorCode.COMMAND_FAILED
    );
  }
}
