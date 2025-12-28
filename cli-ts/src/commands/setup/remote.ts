/**
 * Remote setup functionality (Windows/macOS -> Linux)
 */

import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { printHeader, printSection, printError, printSuccess, printInfo } from '../../utils/output';
import { sshExec, sshExecStream, testConnection } from '../../utils/ssh';
import type { SSHKeyConnection as ConnectionInfo } from '../../types';
import { DOCKFLOW_RELEASE_URL } from './constants';
import { prompt, promptPassword, selectMenu, promptMultiline } from './prompts';
import { parseConnectionString } from './connection';
import type { RemoteSetupOptions } from './types';

/**
 * Detect remote server architecture
 */
async function detectRemoteArch(conn: ConnectionInfo): Promise<'x64' | 'arm64'> {
  const result = sshExec(conn, 'uname -m');
  const arch = result.stdout.trim();
  
  if (arch === 'aarch64' || arch === 'arm64') {
    return 'arm64';
  }
  return 'x64';
}

/**
 * Execute SSH command with password (requires sshpass on local machine)
 */
function sshExecWithPassword(host: string, port: number, user: string, password: string, command: string): { stdout: string; stderr: string; exitCode: number } {
  const hasSshpass = spawnSync('which', ['sshpass'], { encoding: 'utf-8' }).status === 0 ||
                     spawnSync('where', ['sshpass'], { encoding: 'utf-8', shell: true }).status === 0;
  
  if (!hasSshpass) {
    const result = spawnSync('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'PreferredAuthentications=password',
      '-o', 'PubkeyAuthentication=no',
      '-p', port.toString(),
      `${user}@${host}`,
      command
    ], {
      encoding: 'utf-8',
      input: password + '\n',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status ?? 1
    };
  }
  
  const result = spawnSync('sshpass', [
    '-p', password,
    'ssh',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-p', port.toString(),
    `${user}@${host}`,
    command
  ], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1
  };
}

/**
 * Execute SSH command with password and stream output
 */
async function sshExecWithPasswordStream(
  host: string, 
  port: number, 
  user: string, 
  password: string, 
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const hasSshpass = spawnSync('which', ['sshpass'], { encoding: 'utf-8' }).status === 0 ||
                     spawnSync('where', ['sshpass'], { encoding: 'utf-8', shell: true }).status === 0;
  
  return new Promise((resolve, reject) => {
    let proc;
    
    if (hasSshpass) {
      proc = spawn('sshpass', [
        '-p', password,
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-tt',
        '-p', port.toString(),
        `${user}@${host}`,
        command
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } else {
      proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'PreferredAuthentications=keyboard-interactive,password',
        '-o', 'PubkeyAuthentication=no',
        '-tt',
        '-p', port.toString(),
        `${user}@${host}`,
        command
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      proc.stdin.write(password + '\n');
    }
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      const str = data.toString();
      stdout += str;
      process.stdout.write(str);
    });
    
    proc.stderr.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      if (!str.toLowerCase().includes('password')) {
        process.stderr.write(str);
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
    
    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1
      });
    });
  });
}

/**
 * Prompt for remote connection info
 */
export async function promptRemoteConnection(): Promise<RemoteSetupOptions | null> {
  printSection('Remote Connection');
  console.log('');
  
  const choice = await selectMenu('How do you want to connect?', [
    'Enter connection details manually (host, user, password/key)',
    'Use an existing Dockflow connection string',
    'Cancel'
  ]);
  
  if (choice === 2) {
    return null;
  }
  
  if (choice === 1) {
    console.log('');
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
  
  console.log('');
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
  
  console.log('');
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
    console.log(chalk.gray('Paste your private key, then press Enter twice:'));
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
  console.log('');
  console.log(chalk.cyan('Target:'), `${opts.user}@${opts.host}:${opts.port}`);
  console.log('');
  
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
    const result = sshExecWithPassword(opts.host, opts.port, opts.user, opts.password, 'echo ok');
    if (result.exitCode !== 0 || !result.stdout.includes('ok')) {
      testSpinner.fail('SSH connection failed');
      printError('Could not connect to the remote server. Check your credentials.');
      printInfo('Note: Password authentication requires "sshpass" to be installed on your local machine.');
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
    const archResult = sshExecWithPassword(opts.host, opts.port, opts.user, opts.password, 'uname -m');
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
    downloadResult = sshExec(conn, downloadCmd);
  } else {
    downloadResult = sshExecWithPassword(opts.host, opts.port, opts.user, opts.password!, downloadCmd);
  }
  
  if (downloadResult.exitCode !== 0) {
    downloadSpinner.fail('Failed to download Dockflow CLI');
    printError(downloadResult.stderr || 'Download failed');
    return;
  }
  
  downloadSpinner.succeed('Dockflow CLI downloaded');
  
  console.log('');
  printSection('Running setup on remote server');
  console.log(chalk.gray('─'.repeat(60)));
  console.log('');
  
  const setupCmd = `${remotePath} setup`;
  
  if (conn) {
    await sshExecStream(conn, setupCmd);
  } else {
    await sshExecWithPasswordStream(opts.host, opts.port, opts.user, opts.password!, setupCmd);
  }
  
  console.log('');
  console.log(chalk.gray('─'.repeat(60)));
  
  const cleanupSpinner = ora('Cleaning up...').start();
  if (conn) {
    sshExec(conn, `rm -f ${remotePath}`);
  } else {
    sshExecWithPassword(opts.host, opts.port, opts.user, opts.password!, `rm -f ${remotePath}`);
  }
  cleanupSpinner.succeed('Cleanup complete');
  
  console.log('');
  printSuccess('Remote setup completed');
  printInfo('Copy the connection string displayed above and add it to your CI/CD secrets.');
}
