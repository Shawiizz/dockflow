/**
 * Non-interactive setup flow
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { printIntro, printSection, printSuccess, printBlank, printRaw, colors } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { detectPublicIP, detectSSHPort, getCurrentUser } from './network';
import { generateSSHKey, addToAuthorizedKeys } from './key-files';
import { createDeployUser, } from './user';
import { ensureSetupDependencies, completeSetup } from './flow';
import type { SetupOptions, HostConfig } from './types';

/**
 * Run non-interactive setup
 */
export async function runNonInteractiveSetup(options: SetupOptions): Promise<void> {
  printIntro('Machine Setup (Non-Interactive)');
  printBlank();

  await ensureSetupDependencies();

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
  printRaw(`${colors.info('Public Host:')} ${publicHost}`);
  printRaw(`${colors.info('SSH Port:')} ${sshPort}`);
  printRaw(`${colors.info('Deployment User:')} ${deployUser}`);
  printRaw(`${colors.info('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  printRaw(`${colors.info('Skip Docker Install:')} ${options.skipDockerInstall ? 'Yes' : 'No'}`);
  printRaw(`${colors.info('Install Nginx:')} ${options.nginx ? 'Yes' : 'No'}`);
  printRaw(`${colors.info('Install Portainer:')} ${options.portainer ? 'Yes' : 'No'}`);
  printBlank();

  if (needsUserSetup && deployPassword) {
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      throw new CLIError(
        'Failed to create deployment user',
        ErrorCode.COMMAND_FAILED
      );
    }
  }

  const config: HostConfig = {
    publicHost,
    sshPort,
    deployUser,
    deployPassword,
    privateKeyPath,
    skipDockerInstall: options.skipDockerInstall || false,
    orchestrator: options.orchestrator || 'swarm',
    installNginx: options.nginx || false,
    portainer: {
      install: options.portainer || false,
      port: parseInt(options.portainerPort || '9000', 10),
      password: options.portainerPassword,
      domain: options.portainerDomain
    }
  };

  printBlank();
  completeSetup(config);
}
