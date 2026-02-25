/**
 * Remote setup functionality (Windows/macOS -> Linux)
 */

import * as fs from 'fs';
import ora from 'ora';
import { printHeader, printSection, printError, printSuccess, printInfo, printBlank, printDim, colors } from '../../utils/output';
import { sshExec, sshExecStream, testConnection } from '../../utils/ssh';
import type { ConnectionInfo } from '../../types';
import { DOCKFLOW_RELEASE_URL } from './constants';
import { prompt, promptPassword, selectMenu, promptMultiline } from './prompts';
import { parseConnectionString } from './connection';
import type { RemoteSetupOptions } from './types';

/**
 * Detect remote server architecture
 */
async function detectRemoteArch(conn: ConnectionInfo): Promise<'x64' | 'arm64'> {
  const result = await sshExec(conn, 'uname -m');
  const arch = result.stdout.trim();
  
  if (arch === 'aarch64' || arch === 'arm64') {
    return 'arm64';
  }
  return 'x64';
}

/**
 * Prompt for remote connection info
 */
export async function promptRemoteConnection(): Promise<RemoteSetupOptions | null> {
  printSection('Remote Connection');
  printBlank();
  
  const choice = await selectMenu('How do you want to connect?', [
    'Enter connection details manually (host, user, password/key)',
    'Use an existing Dockflow connection string',
    'Cancel'
  ]);
  
  if (choice === 2) {
    return null;
  }
  
  if (choice === 1) {
    printBlank();
    const connStr = await prompt('Paste your connection string');
    if (!connStr) {
      printError('Connection string is required');
      return null;
    }
    
    const conn = parseConnectionString(connStr);
    if (!conn) {
      printError('Invalid connection string format');
      return null;
    }
    
    return {
      host: conn.host,
      port: conn.port || 22,
      user: conn.user,
      privateKey: conn.privateKey,
      password: conn.password
    };
  }
  
  printBlank();
  const host = await prompt('Server IP or hostname');
  if (!host) {
    printError('Host is required');
    return null;
  }
  
  const portStr = await prompt('SSH port', '22');
  const port = parseInt(portStr, 10) || 22;
  
  const user = await prompt('SSH username', 'root');
  if (!user) {
    printError('Username is required');
    return null;
  }
  
  printBlank();
  const authChoice = await selectMenu('Authentication method', [
    'Password',
    'SSH private key file',
    'Paste SSH private key'
  ]);
  
  let password: string | undefined;
  let privateKey: string | undefined;
  let privateKeyPath: string | undefined;
  
  if (authChoice === 0) {
    password = await promptPassword('SSH password');
    if (!password) {
      printError('Password is required');
      return null;
    }
  } else if (authChoice === 1) {
    privateKeyPath = await prompt('Path to SSH private key');
    if (!privateKeyPath || !fs.existsSync(privateKeyPath)) {
      printError('SSH key file not found');
      return null;
    }
    privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
  } else {
    printDim('Paste your private key, then press Enter twice:');
    privateKey = await promptMultiline();
    if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
      printError('Invalid SSH private key');
      return null;
    }
  }
  
  return { host, port, user, password, privateKey, privateKeyPath };
}

/**
 * Run remote setup via SSH
 */
export async function runRemoteSetup(opts: RemoteSetupOptions): Promise<void> {
  printHeader('Remote Setup');
  printBlank();
  console.log(colors.info('Target:'), `${opts.user}@${opts.host}:${opts.port}`);
  printBlank();
  
  const testSpinner = ora('Testing SSH connection...').start();
  
  let usePasswordAuth = false;
  let conn: ConnectionInfo | null = null;
  
  if (opts.privateKey) {
    conn = {
      host: opts.host,
      port: opts.port,
      user: opts.user,
      privateKey: opts.privateKey,
      password: opts.password
    };
    
    const connected = await testConnection(conn);
    if (!connected) {
      testSpinner.fail('SSH connection failed');
      printError('Could not connect to the remote server. Check your credentials.');
      return;
    }
  } else if (opts.password) {
    usePasswordAuth = true;
    const result = await sshExec({ host: opts.host, port: opts.port, user: opts.user, password: opts.password }, 'echo ok');
    if (result.exitCode !== 0 || !result.stdout.includes('ok')) {
      testSpinner.fail('SSH connection failed');
      printError('Could not connect to the remote server. Check your credentials.');
      return;
    }
  } else {
    testSpinner.fail('No authentication method provided');
    return;
  }
  
  testSpinner.succeed('SSH connection successful');
  
  const archSpinner = ora('Detecting server architecture...').start();
  let arch: 'x64' | 'arm64' = 'x64';
  
  if (conn) {
    arch = await detectRemoteArch(conn);
  } else if (opts.password) {
    const archResult = await sshExec({ host: opts.host, port: opts.port, user: opts.user, password: opts.password! }, 'uname -m');
    const archStr = archResult.stdout.trim();
    arch = (archStr === 'aarch64' || archStr === 'arm64') ? 'arm64' : 'x64';
  }
  
  archSpinner.succeed(`Server architecture: ${arch}`);
  
  const binaryName = `dockflow-linux-${arch}`;
  const downloadUrl = `${DOCKFLOW_RELEASE_URL}/${binaryName}`;
  const remotePath = '/tmp/dockflow';
  
  const downloadSpinner = ora('Downloading Dockflow CLI to remote server...').start();
  
  const downloadCmd = `curl -fsSL "${downloadUrl}" -o ${remotePath} && chmod +x ${remotePath}`;
  
  let downloadResult;
  if (conn) {
    downloadResult = await sshExec(conn, downloadCmd);
  } else {
    downloadResult = await sshExec({ host: opts.host, port: opts.port, user: opts.user, password: opts.password! }, downloadCmd);
  }
  
  if (downloadResult.exitCode !== 0) {
    downloadSpinner.fail('Failed to download Dockflow CLI');
    printError(downloadResult.stderr || 'Download failed');
    return;
  }
  
  downloadSpinner.succeed('Dockflow CLI downloaded');
  
  printBlank();
  printSection('Running setup on remote server');
  printDim('─'.repeat(60));
  printBlank();
  
  const setupCmd = `${remotePath} setup`;
  
  if (conn) {
    await sshExecStream(conn, setupCmd);
  } else {
    await sshExecStream({ host: opts.host, port: opts.port, user: opts.user, password: opts.password! }, setupCmd);
  }
  
  printBlank();
  printDim('─'.repeat(60));
  
  const cleanupSpinner = ora('Cleaning up...').start();
  if (conn) {
    await sshExec(conn, `rm -f ${remotePath}`);
  } else {
    await sshExec({ host: opts.host, port: opts.port, user: opts.user, password: opts.password! }, `rm -f ${remotePath}`);
  }
  cleanupSpinner.succeed('Cleanup complete');

  printBlank();
  printSuccess('Remote setup completed');
  printInfo('Copy the connection string displayed above and add it to your CI/CD secrets.');
}
