/**
 * Interactive setup flow
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { printIntro, printSection, printSuccess, printInfo, printWarning, printBlank, printRaw, colors } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { displayDependencyStatus, } from './dependencies';
import { detectPublicIP, detectSSHPort, getCurrentUser } from './network';
import { prompt, promptPassword, confirm, selectMenu } from './prompts';
import { generateSSHKey, addToAuthorizedKeys, authorizeKeyForUser, listSSHKeys } from './key-files';
import { createDeployUser, promptAndValidateUserPassword, } from './user';
import { displayConnectionInfo } from './connection';
import { ensureSetupDependencies, completeSetup } from './flow';
import type { HostConfig, SetupOrchestrator } from './types';

/**
 * Run interactive setup wizard
 */
export async function runInteractiveSetup(options?: { skipDockerInstall?: boolean; orchestrator?: SetupOrchestrator; portainer?: boolean; portainerPort?: string; portainerPassword?: string }): Promise<void> {
  printIntro('Machine Setup Wizard');
  printBlank();

  displayDependencyStatus();
  await ensureSetupDependencies(() => confirm('Install missing dependencies automatically?', true));

  printSuccess('All dependencies satisfied');
  printBlank();

  const detectedIP = detectPublicIP();
  const detectedPort = detectSSHPort();
  const currentUser = getCurrentUser();

  printSection('Server Configuration');

  const publicHost = await prompt('Public IP/Hostname (for connection string)', detectedIP);
  const sshPortStr = await prompt('SSH Port', detectedPort.toString());
  const sshPort = parseInt(sshPortStr, 10) || 22;

  printBlank();
  printSection('Deployment User');

  const userChoice = await selectMenu('What would you like to do?', [
    'Create a new deployment user',
    'Use an existing user (configure SSH key)',
    'Display connection string for existing setup'
  ]);

  let deployUser: string;
  let deployPassword: string | undefined;
  let privateKeyPath: string;
  let needsUserSetup = false;

  if (userChoice === 0) {
    deployUser = await prompt('New username', 'dockflow');
    
    const userExists = spawnSync('id', [deployUser], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (userExists.status === 0) {
      printWarning(`User '${deployUser}' already exists on this system.`);
      const continueAnyway = await confirm('Continue with this user anyway?', true);
      if (!continueAnyway) {
        return;
      }
      needsUserSetup = false;
    } else {
      deployPassword = await promptPassword('Password for new user');
      needsUserSetup = true;
    }

    const keyPath = path.join(os.homedir(), '.ssh', `${deployUser}_key`);
    printInfo(`Generating SSH key at ${keyPath}...`);

    const keyResult = generateSSHKey(keyPath, `dockflow-${deployUser}`);
    if (keyResult.success) {
      printSuccess('SSH key generated');
      privateKeyPath = keyPath;
    } else {
      throw new CLIError(
        `Failed to generate SSH key: ${keyResult.error}`,
        ErrorCode.COMMAND_FAILED
      );
    }

    // Existing user: createDeployUser won't run, so the new key must be
    // authorized here or the emitted connection string would not work.
    if (!needsUserSetup) {
      if (authorizeKeyForUser(`${keyPath}.pub`, deployUser)) {
        printSuccess(`Key authorized for existing user ${deployUser}`);
      } else {
        throw new CLIError(
          `Failed to authorize the new key for ${deployUser}`,
          ErrorCode.COMMAND_FAILED
        );
      }
    }
  } else if (userChoice === 1) {
    deployUser = await prompt('Existing username', currentUser);

    const existingKeys = listSSHKeys(deployUser);
    const userHome = deployUser === 'root' ? '/root' : `/home/${deployUser}`;
    const defaultKeyPath = path.join(userHome, '.ssh', 'dockflow_key');

    if (existingKeys.length > 0) {
      printBlank();
      const keyChoice = await selectMenu('SSH Key Selection:', [
        'Generate new SSH key',
        'Use existing SSH key',
      ]);

      if (keyChoice === 1) {
        printBlank();
        printInfo('Available keys:');
        existingKeys.forEach((k, i) => printRaw(`  ${i + 1}) ${k}`));
        const keyIdxStr = await prompt('Select key number', '1');
        const keyIdx = parseInt(keyIdxStr, 10) - 1;
        privateKeyPath = existingKeys[keyIdx] || existingKeys[0];
      } else {
        privateKeyPath = defaultKeyPath;
        printInfo(`Generating SSH key at ${privateKeyPath}...`);

        const keyResult = generateSSHKey(privateKeyPath, `dockflow-${currentUser}`);
        if (keyResult.success) {
          printSuccess('SSH key generated');
          addToAuthorizedKeys(`${privateKeyPath}.pub`);
          printSuccess('Key added to authorized_keys');
        } else {
          throw new CLIError(
            `Failed to generate SSH key: ${keyResult.error}`,
            ErrorCode.COMMAND_FAILED
          );
        }
      }
    } else {
      privateKeyPath = defaultKeyPath;
      printInfo(`Generating SSH key at ${privateKeyPath}...`);

      const keyResult = generateSSHKey(privateKeyPath, `dockflow-${currentUser}`);
      if (keyResult.success) {
        printSuccess('SSH key generated');
        addToAuthorizedKeys(`${privateKeyPath}.pub`);
        printSuccess('Key added to authorized_keys');
      } else {
        throw new CLIError(
          `Failed to generate SSH key: ${keyResult.error}`,
          ErrorCode.COMMAND_FAILED
        );
      }
    }

    if (await confirm('Does the user require a password for sudo?', false)) {
      deployPassword = await promptAndValidateUserPassword(deployUser);
    }
  } else {
    printBlank();
    deployUser = await prompt('Deployment username', 'dockflow');
    
    const existingKeys = listSSHKeys(deployUser);
    const userHome = deployUser === 'root' ? '/root' : `/home/${deployUser}`;
    if (existingKeys.length === 0) {
      throw new CLIError(
        `No SSH keys found in ${userHome}/.ssh/`,
        ErrorCode.CONFIG_NOT_FOUND
      );
    }
    
    printBlank();
    printInfo('Available keys:');
    existingKeys.forEach((k, i) => printRaw(`  ${i + 1}) ${k}`));
    const keyIdxStr = await prompt('Select key number', '1');
    const keyIdx = parseInt(keyIdxStr, 10) - 1;
    privateKeyPath = existingKeys[keyIdx] || existingKeys[0];
    
    deployPassword = await promptAndValidateUserPassword(deployUser);
    
    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo({
      publicHost,
      sshPort,
      deployUser,
      deployPassword,
      privateKeyPath,
      skipDockerInstall: false,
      orchestrator: 'swarm',
      installNginx: false,
      portainer: { install: false, port: 9000 }
    }, privateKey);
    
    return;  // Early return for display-only option
  }

  printBlank();
  printSection('Optional Services');

  let installNginx = false;
  if (await confirm('Install Nginx (reverse proxy)?', true)) {
    installNginx = true;
  }

  let portainerConfig = {
    install: false,
    port: 9000,
    password: undefined as string | undefined,
    domain: undefined as string | undefined
  };

  if (await confirm('Install Portainer (container management UI)?', false)) {
    portainerConfig.install = true;
    portainerConfig.password = await promptPassword('Portainer admin password');
    const portStr = await prompt('Portainer HTTP port', '9000');
    portainerConfig.port = parseInt(portStr, 10) || 9000;
    const domain = await prompt('Portainer domain (optional, press Enter to skip)', '');
    if (domain) {
      portainerConfig.domain = domain;
    }
  }

  printBlank();
  printSection('Configuration Summary');
  printBlank();
  printRaw(`${colors.info('Target:')} Local Machine`);
  printRaw(`${colors.info('Public Host:')} ${publicHost}`);
  printRaw(`${colors.info('SSH Port:')} ${sshPort}`);
  printRaw(`${colors.info('Deployment User:')} ${deployUser}`);
  printRaw(`${colors.info('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  printRaw(`${colors.info('Install Nginx:')} ${installNginx ? 'Yes' : 'No'}`);
  printRaw(`${colors.info('Install Portainer:')} ${portainerConfig.install ? 'Yes' : 'No'}`);
  if (portainerConfig.install) {
    printRaw(`${colors.info('Portainer Port:')} ${portainerConfig.port}`);
    if (portainerConfig.domain) {
      printRaw(`${colors.info('Portainer Domain:')} ${portainerConfig.domain}`);
    }
  }
  printBlank();

  if (!await confirm('Proceed with this configuration?', true)) {
    printWarning('Setup cancelled');
    return;  // User cancelled
  }

  if (needsUserSetup && deployPassword) {
    printBlank();
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      throw new CLIError(
        'Failed to create deployment user',
        ErrorCode.COMMAND_FAILED
      );
    }
  }

  printBlank();
  const config: HostConfig = {
    publicHost,
    sshPort,
    deployUser,
    deployPassword,
    privateKeyPath,
    skipDockerInstall: options?.skipDockerInstall || false,
    orchestrator: options?.orchestrator || 'swarm',
    installNginx,
    portainer: portainerConfig
  };

  completeSetup(config);
}
