/**
 * Non-interactive setup flow
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { printHeader, printSection, printSuccess, printError, printInfo } from '../../utils/output';
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
  console.log('');

  const deps = checkDependencies();
  if (!deps.ok) {
    printInfo('Missing required dependencies, attempting automatic installation...');
    deps.missing.forEach(m => console.log(chalk.yellow(`  - ${m}`)));
    console.log('');
    
    const pm = detectPackageManager();
    if (pm) {
      const success = installDependencies(deps.missingDeps);
      if (!success) {
        printError('Failed to install dependencies automatically.');
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
      printError('Could not detect package manager. Please install dependencies manually:');
      deps.missing.forEach(m => console.log(chalk.red(`  - ${m}`)));
      process.exit(1);
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
        printError(`Failed to generate SSH key: ${keyResult.error}`);
        process.exit(1);
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
          printError(`Failed to generate SSH key: ${keyResult.error}`);
          process.exit(1);
        }
        addToAuthorizedKeys(`${privateKeyPath}.pub`);
        printSuccess('SSH key generated and added to authorized_keys');
      }
    }
  }

  printSection('Configuration');
  console.log(`${chalk.cyan('Public Host:')} ${publicHost}`);
  console.log(`${chalk.cyan('SSH Port:')} ${sshPort}`);
  console.log(`${chalk.cyan('Deployment User:')} ${deployUser}`);
  console.log(`${chalk.cyan('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  console.log(`${chalk.cyan('Skip Docker Install:')} ${options.skipDockerInstall ? 'Yes' : 'No'}`);
  console.log(`${chalk.cyan('Install Portainer:')} ${options.portainer ? 'Yes' : 'No'}`);
  console.log('');

  let ansibleDir: string;
  try {
    ansibleDir = await ensureDockflowRepo();
  } catch (error) {
    printError('Cannot proceed without the Dockflow framework');
    process.exit(1);
  }

  if (needsUserSetup && deployPassword) {
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      printError('Failed to create deployment user');
      process.exit(1);
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

  console.log('');
  const success = await runAnsiblePlaybook(config, ansibleDir);

  if (success) {
    console.log('');
    printHeader('Setup Complete');
    printSuccess('The machine has been successfully configured!');

    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo(config, privateKey);
    
    process.exit(0);
  } else {
    printError('Setup failed');
    process.exit(1);
  }
}
