/**
 * Setup commands - Configure host machines for deployment
 * 
 * This module provides commands to:
 * - Setup a local Linux host for deployment
 * - Setup a remote Linux host via SSH
 * - Setup Docker Swarm cluster (manager + workers)
 * - Check dependencies
 * - Generate connection strings
 */

import type { Command } from 'commander';
import * as fs from 'fs';
import { printHeader, printSuccess, printWarning, printInfo, printBlank, printRaw } from '../../utils/output';
import { isLinux, checkDependencies, displayDependencyStatus } from './dependencies';
import { detectPublicIP, detectSSHPort, getCurrentUser } from './network';
import { prompt } from './prompts';
import { listSSHKeys } from './ssh-keys';
import { displayConnectionInfo, parseConnectionString } from './connection';
import { runInteractiveSetup } from './interactive';
import { runNonInteractiveSetup } from './non-interactive';
import { runRemoteSetup, promptRemoteConnection } from './remote';
import { runSetupSwarm } from './swarm';
import { CLIError, ConfigError, ErrorCode, withErrorHandler } from '../../utils/errors';
import type { SetupOptions, RemoteOptions, ConnectionOptions, RemoteSetupOptions } from './types';

/**
 * Register setup commands
 */
export function registerSetupCommand(program: Command): void {
  const setup = program
    .command('setup')
    .description('Setup host machine for deployment');

  // Interactive mode (default) - local setup on Linux only
  setup
    .command('interactive', { isDefault: true })
    .description('Run interactive setup wizard on the local machine')
    .action(withErrorHandler(async () => {
      if (!isLinux()) {
        throw new CLIError(
          'This command must be run directly on a Linux host.',
          ErrorCode.INVALID_ARGUMENT,
          'Use "dockflow setup remote" to setup a remote Linux server via SSH.'
        );
      }

      await runInteractiveSetup();
    }));

  // Remote mode - setup a remote Linux server via SSH
  setup
    .command('remote')
    .description('Run setup on a remote Linux server via SSH')
    .option('--host <host>', 'Remote server IP or hostname')
    .option('--port <port>', 'SSH port', '22')
    .option('--user <user>', 'SSH username')
    .option('--password <password>', 'SSH password')
    .option('--key <path>', 'Path to SSH private key')
    .option('--connection <string>', 'Dockflow connection string')
    .action(withErrorHandler(async (options: RemoteOptions) => {
      let remoteOpts: RemoteSetupOptions | null = null;
      
      if (options.connection) {
        const conn = parseConnectionString(options.connection);
        if (!conn) {
          throw new ConfigError('Invalid connection string');
        }
        remoteOpts = {
          host: conn.host,
          port: conn.port || 22,
          user: conn.user,
          privateKey: conn.privateKey,
          password: conn.password
        };
      } else if (options.host && options.user) {
        let privateKey: string | undefined;
        if (options.key) {
          if (!fs.existsSync(options.key)) {
            throw new ConfigError(`SSH key file not found: ${options.key}`);
          }
          privateKey = fs.readFileSync(options.key, 'utf-8');
        }
        
        remoteOpts = {
          host: options.host,
          port: parseInt(options.port || '22', 10),
          user: options.user,
          password: options.password,
          privateKey
        };
      } else {
        remoteOpts = await promptRemoteConnection();
      }
      
      if (!remoteOpts) {
        process.exit(0);
      }
      
      await runRemoteSetup(remoteOpts);
      process.exit(0);
    }));

  // Swarm cluster setup
  setup
    .command('swarm <env>')
    .description('Initialize Docker Swarm cluster for an environment')
    .action(withErrorHandler(async (env: string) => {
      await runSetupSwarm(env);
    }));

  // Non-interactive mode - local setup with CLI options
  setup
    .command('auto')
    .description('Run non-interactive setup with command-line options')
    .option('--host <host>', 'Public IP/hostname for connection string')
    .option('--port <port>', 'SSH port', '22')
    .option('--user <user>', 'Deployment username (creates new user if different from current)')
    .option('--password <password>', 'Password for new user or sudo')
    .option('--ssh-key <path>', 'Path to existing SSH private key')
    .option('--generate-key', 'Generate new SSH key')
    .option('--skip-docker-install', 'Skip Docker installation')
    .option('--portainer', 'Install Portainer')
    .option('--portainer-port <port>', 'Portainer HTTP port', '9000')
    .option('--portainer-password <password>', 'Portainer admin password')
    .option('--portainer-domain <domain>', 'Portainer domain name')
    .option('-y, --yes', 'Skip confirmations')
    .action(withErrorHandler(async (options: SetupOptions) => {
      if (!isLinux()) {
        throw new CLIError(
          'The "auto" command must be run directly on the target Linux host.',
          ErrorCode.INVALID_ARGUMENT,
          'Use "dockflow setup remote" to run setup on a remote server via SSH.'
        );
      }

      await runNonInteractiveSetup(options);
    }));

  // Check dependencies
  setup
    .command('check')
    .description('Check if all dependencies are installed')
    .action(withErrorHandler(async () => {
      printHeader('Dependency Check');
      printBlank();

      if (!isLinux()) {
        printWarning('Not running on Linux - some checks may not be accurate');
        printBlank();
      }

      displayDependencyStatus();

      const deps = checkDependencies();
      if (deps.ok) {
        printSuccess('All required dependencies are installed');
      } else {
        throw new CLIError(
          'Missing dependencies: ' + deps.missing.join(', '),
          ErrorCode.VALIDATION_FAILED
        );
      }
    }));

  // Show connection string for existing setup
  setup
    .command('connection')
    .description('Display connection string for existing deployment user')
    .option('--host <host>', 'Server IP/hostname')
    .option('--port <port>', 'SSH port', '22')
    .option('--user <user>', 'Deployment username')
    .option('--key <path>', 'Path to SSH private key')
    .action(withErrorHandler(async (options: ConnectionOptions) => {
      let host = options.host;
      let port = parseInt(options.port || '22', 10);
      let user = options.user;
      let keyPath = options.key;

      if (!host) {
        host = await prompt('Server IP/hostname', detectPublicIP());
      }
      if (!options.port) {
        const portStr = await prompt('SSH port', detectSSHPort().toString());
        port = parseInt(portStr, 10);
      }
      if (!user) {
        user = await prompt('Deployment username', getCurrentUser());
      }
      if (!keyPath) {
        const keys = listSSHKeys();
        if (keys.length > 0) {
          printBlank();
        printInfo('Available keys:');
          keys.forEach((k, i) => printRaw(`  ${i + 1}) ${k}`));
          const keyIdxStr = await prompt('Select key number', '1');
          const keyIdx = parseInt(keyIdxStr, 10) - 1;
          keyPath = keys[keyIdx] || keys[0];
        } else {
          keyPath = await prompt('Path to SSH private key');
        }
      }

      if (!fs.existsSync(keyPath)) {
        throw new ConfigError(`SSH key not found: ${keyPath}`);
      }

      const privateKey = fs.readFileSync(keyPath, 'utf-8');

      displayConnectionInfo({
        publicHost: host,
        sshPort: port,
        deployUser: user,
        privateKeyPath: keyPath,
        skipDockerInstall: false,
        portainer: { install: false, port: 9000 }
      }, privateKey);
    }));
}

// Re-export types for convenience
export * from './types';
