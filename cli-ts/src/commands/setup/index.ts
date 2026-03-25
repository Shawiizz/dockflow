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
import { isLinux, displayDependencyStatus } from './dependencies';
import { detectPublicIP, detectSSHPort, getCurrentUser } from './network';
import { prompt } from './prompts';
import { listSSHKeys } from './ssh-keys';
import { displayConnectionInfo, parseConnectionString } from './connection';
import { runInteractiveSetup } from './interactive';
import { runNonInteractiveSetup } from './non-interactive';
import { runRemoteSetup, promptRemoteConnection } from './remote';
import { runSetupSwarm } from './swarm';
import { CLIError, ConfigError, ErrorCode, withErrorHandler } from '../../utils/errors';
import type { SetupOptions, ConnectionOptions, RemoteSetupOptions } from './types';

/** Parse a `user@host[:port]` target string */
function parseTarget(target: string): { user: string; host: string; port: number } | null {
  const match = target.match(/^([^@]+)@([^:]+)(?::(\d+))?$/);
  if (!match) return null;
  return { user: match[1], host: match[2], port: match[3] ? parseInt(match[3], 10) : 22 };
}

/**
 * Register setup commands
 */
export function registerSetupCommand(program: Command): void {
  const setup = program
    .command('setup [target]')
    .description('Setup host machine for deployment (use user@host for remote setup)')
    // Remote options
    .option('-k, --key <path>', 'Path to SSH private key (remote)')
    .option('--connection <string>', 'Dockflow connection string (remote)')
    // Shared options
    .option('--password <password>', 'SSH password (remote) or sudo password (local)')
    // Local non-interactive options
    .option('--host <host>', 'Public IP/hostname for connection string (local)')
    .option('--port <port>', 'SSH port (local)', '22')
    .option('--user <user>', 'Deployment username (local, creates new user if different from current)')
    .option('--ssh-key <path>', 'Path to existing SSH private key (local)')
    .option('--generate-key', 'Generate new SSH key (local)')
    .option('--skip-docker-install', 'Skip Docker installation (local)')
    .option('--portainer', 'Install Portainer (local)')
    .option('--portainer-port <port>', 'Portainer HTTP port (local)', '9000')
    .option('--portainer-password <password>', 'Portainer admin password (local)')
    .option('--portainer-domain <domain>', 'Portainer domain name (local)')
    .option('-y, --yes', 'Skip confirmations (local)')
    .action(withErrorHandler(async (target: string | undefined, options: SetupOptions & { key?: string; connection?: string }) => {
      let remoteOpts: RemoteSetupOptions | null = null;

      if (options.connection) {
        // Connection string mode
        const conn = parseConnectionString(options.connection);
        if (!conn) throw new ConfigError('Invalid connection string');
        remoteOpts = {
          host: conn.host,
          port: conn.port || 22,
          user: conn.user,
          privateKey: conn.privateKey,
          password: conn.password,
        };
      } else if (target) {
        // user@host[:port] mode
        const parsed = parseTarget(target);
        if (!parsed) {
          throw new CLIError(
            `Invalid target format: "${target}"`,
            ErrorCode.INVALID_ARGUMENT,
            'Use the format: dockflow setup user@host[:port]'
          );
        }

        let privateKey: string | undefined;
        if (options.key) {
          if (!fs.existsSync(options.key)) {
            throw new ConfigError(`SSH key file not found: ${options.key}`);
          }
          privateKey = fs.readFileSync(options.key, 'utf-8');
        }

        remoteOpts = {
          host: parsed.host,
          port: parsed.port,
          user: parsed.user,
          password: options.password,
          privateKey,
        };
      }

      // Remote setup
      if (remoteOpts) {
        // If no auth method provided, fall back to interactive prompt
        if (!remoteOpts.privateKey && !remoteOpts.password) {
          remoteOpts = await promptRemoteConnection(remoteOpts);
          if (!remoteOpts) { process.exit(0); }
        }
        await runRemoteSetup(remoteOpts);
        process.exit(0);
      }

      // Local setup (no target)
      if (!isLinux()) {
        throw new CLIError(
          'This command must be run directly on a Linux host.',
          ErrorCode.INVALID_ARGUMENT,
          'Use "dockflow setup user@host" to setup a remote Linux server via SSH.'
        );
      }

      // Detect non-interactive mode: any local-specific flag provided
      const hasLocalFlags = options.host || options.user || options.sshKey || options.generateKey
        || options.skipDockerInstall || options.portainer;

      if (hasLocalFlags) {
        await runNonInteractiveSetup(options);
      } else {
        await runInteractiveSetup();
      }
    }));

  // Swarm cluster setup
  setup
    .command('swarm <env>')
    .description('Initialize Docker Swarm cluster for an environment')
    .action(withErrorHandler(async (env: string) => {
      await runSetupSwarm(env);
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

      const deps = displayDependencyStatus();
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
