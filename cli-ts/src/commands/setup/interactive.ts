/**
 * Interactive setup flow
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { printHeader, printSection, printSuccess, printError, printInfo, printWarning } from '../../utils/output';
import { checkDependencies, displayDependencyStatus, installDependencies, detectPackageManager } from './dependencies';
import { detectPublicIP, detectSSHPort, getCurrentUser } from './network';
import { prompt, promptPassword, confirm, selectMenu } from './prompts';
import { generateSSHKey, addToAuthorizedKeys, listSSHKeys } from './ssh-keys';
import { createDeployUser, promptAndValidateUserPassword } from './user';
import { displayConnectionInfo } from './connection';
import { ensureDockflowRepo, installAnsibleRoles, runAnsiblePlaybook } from './ansible';
import { DOCKFLOW_DIR } from './constants';
import type { HostConfig } from './types';

/**
 * Run interactive setup wizard
 */
export async function runInteractiveSetup(): Promise<void> {
  printHeader('Machine Setup Wizard');
  console.log('');

  displayDependencyStatus();

  const deps = checkDependencies();
  if (!deps.ok) {
    printWarning('Missing required dependencies:');
    deps.missing.forEach(m => console.log(chalk.yellow(`  - ${m}`)));
    console.log('');

    const pm = detectPackageManager();
    if (pm) {
      const shouldInstall = await confirm('Install missing dependencies automatically?', true);
      if (shouldInstall) {
        console.log('');
        const success = installDependencies(deps.missingDeps);
        if (!success) {
          printError('Failed to install dependencies. Please install them manually and try again.');
          process.exit(1);
        }
        console.log('');
        
        // Re-check dependencies
        const recheck = checkDependencies();
        if (!recheck.ok) {
          printError('Some dependencies are still missing:');
          recheck.missing.forEach(m => console.log(chalk.red(`  - ${m}`)));
          process.exit(1);
        }
      } else {
        printInfo('Please install the missing dependencies and try again.');
        process.exit(1);
      }
    } else {
      printError('Could not detect package manager. Please install dependencies manually:');
      deps.missing.forEach(m => console.log(chalk.red(`  - ${m}`)));
      process.exit(1);
    }
  }

  printSuccess('All dependencies satisfied');
  console.log('');

  const detectedIP = detectPublicIP();
  const detectedPort = detectSSHPort();
  const currentUser = getCurrentUser();

  printSection('Server Configuration');

  const publicHost = await prompt('Public IP/Hostname (for connection string)', detectedIP);
  const sshPortStr = await prompt('SSH Port', detectedPort.toString());
  const sshPort = parseInt(sshPortStr, 10) || 22;

  console.log('');
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
        process.exit(0);
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
      printError(`Failed to generate SSH key: ${keyResult.error}`);
      process.exit(1);
    }
  } else if (userChoice === 1) {
    deployUser = await prompt('Existing username', currentUser);

    const existingKeys = listSSHKeys(deployUser);
    const userHome = deployUser === 'root' ? '/root' : `/home/${deployUser}`;
    const defaultKeyPath = path.join(userHome, '.ssh', 'dockflow_key');

    if (existingKeys.length > 0) {
      console.log('');
      const keyChoice = await selectMenu('SSH Key Selection:', [
        'Generate new SSH key',
        'Use existing SSH key',
      ]);

      if (keyChoice === 1) {
        console.log('');
        console.log(chalk.cyan('Available keys:'));
        existingKeys.forEach((k, i) => console.log(`  ${i + 1}) ${k}`));
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
          printError(`Failed to generate SSH key: ${keyResult.error}`);
          process.exit(1);
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
        printError(`Failed to generate SSH key: ${keyResult.error}`);
        process.exit(1);
      }
    }

    if (await confirm('Does the user require a password for sudo?', false)) {
      deployPassword = await promptAndValidateUserPassword(deployUser);
    }
  } else {
    console.log('');
    deployUser = await prompt('Deployment username', 'dockflow');
    
    const existingKeys = listSSHKeys(deployUser);
    const userHome = deployUser === 'root' ? '/root' : `/home/${deployUser}`;
    if (existingKeys.length === 0) {
      printError(`No SSH keys found in ${userHome}/.ssh/`);
      process.exit(1);
    }
    
    console.log('');
    console.log(chalk.cyan('Available keys:'));
    existingKeys.forEach((k, i) => console.log(`  ${i + 1}) ${k}`));
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
      portainer: { install: false, port: 9000 }
    }, privateKey);
    
    process.exit(0);
  }

  console.log('');
  printSection('Optional Services');

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

  console.log('');
  printHeader('Configuration Summary');
  console.log('');
  console.log(`${chalk.cyan('Target:')} Local Machine`);
  console.log(`${chalk.cyan('Public Host:')} ${publicHost}`);
  console.log(`${chalk.cyan('SSH Port:')} ${sshPort}`);
  console.log(`${chalk.cyan('Deployment User:')} ${deployUser}`);
  console.log(`${chalk.cyan('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  console.log(`${chalk.cyan('Install Portainer:')} ${portainerConfig.install ? 'Yes' : 'No'}`);
  if (portainerConfig.install) {
    console.log(`${chalk.cyan('Portainer Port:')} ${portainerConfig.port}`);
    if (portainerConfig.domain) {
      console.log(`${chalk.cyan('Portainer Domain:')} ${portainerConfig.domain}`);
    }
  }
  console.log('');

  if (!await confirm('Proceed with this configuration?', true)) {
    printWarning('Setup cancelled');
    process.exit(0);
  }

  console.log('');
  let ansibleDir: string;
  try {
    ansibleDir = await ensureDockflowRepo();
  } catch (error) {
    printError('Cannot proceed without the Dockflow framework');
    process.exit(1);
  }

  if (needsUserSetup && deployPassword) {
    console.log('');
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      printError('Failed to create deployment user');
      process.exit(1);
    }
  }

  console.log('');
  await installAnsibleRoles(DOCKFLOW_DIR);

  console.log('');
  const config: HostConfig = {
    publicHost,
    sshPort,
    deployUser,
    deployPassword,
    privateKeyPath,
    skipDockerInstall: false,
    portainer: portainerConfig
  };

  const success = await runAnsiblePlaybook(config, ansibleDir);

  if (success) {
    console.log('');
    printHeader('Setup Complete');
    console.log('');
    printSuccess('The machine has been successfully configured!');

    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo(config, privateKey);
    
    process.exit(0);
  } else {
    printError('Setup failed. Please check the errors above.');
    process.exit(1);
  }
}
