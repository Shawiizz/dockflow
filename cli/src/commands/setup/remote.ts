/**
 * Remote setup functionality (Windows/macOS -> Linux)
 */

import * as fs from 'fs';
import { printIntro, printOutro, printSection, printError, printInfo, printBlank, printDim, createSpinner } from '../../utils/output';
import { sshExec, sshExecStream } from '../../utils/ssh';
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
 * Prompt for remote connection info.
 * If `prefilled` is provided (e.g. from user@host parsing), only the auth method is prompted.
 * Otherwise, full interactive prompts are shown.
 */
export async function promptRemoteConnection(prefilled?: RemoteSetupOptions): Promise<RemoteSetupOptions | null> {
  printSection('Remote Connection');
  printBlank();

  let host: string;
  let port: number;
  let user: string;

  if (prefilled) {
    // Already have host/user from CLI target — just need auth
    host = prefilled.host;
    port = prefilled.port;
    user = prefilled.user;
    printInfo(`Target: ${user}@${host}:${port}`);
    printBlank();
  } else {
    const choice = await selectMenu('How do you want to connect?', [
      'Enter connection details manually (host, user, password/key)',
      'Use an existing Dockflow connection string',
      'Cancel'
    ]);

    if (choice === 2) return null;

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
        password: conn.password,
      };
    }

    printBlank();
    const hostInput = await prompt('Server IP or hostname');
    if (!hostInput) { printError('Host is required'); return null; }
    host = hostInput;

    const portStr = await prompt('SSH port', '22');
    port = parseInt(portStr, 10) || 22;

    const userInput = await prompt('SSH username', 'root');
    if (!userInput) { printError('Username is required'); return null; }
    user = userInput;

    printBlank();
  }

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
    if (!password) { printError('Password is required'); return null; }
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
  printIntro('Remote Setup');
  printBlank();
  printInfo(`Target: ${opts.user}@${opts.host}:${opts.port}`);
  printBlank();

  const testSpinner = createSpinner();
  testSpinner.start('Testing SSH connection...');

  if (!opts.privateKey && !opts.password) {
    testSpinner.fail('No authentication method provided');
    return;
  }

  const base = { host: opts.host, port: opts.port, user: opts.user };
  const conn: ConnectionInfo = opts.privateKey
    ? { ...base, privateKey: opts.privateKey, ...(opts.password ? { password: opts.password } : {}) }
    : { ...base, password: opts.password! };

  try {
    const result = await sshExec(conn, 'echo ok');
    if (result.exitCode !== 0 || !result.stdout.includes('ok')) {
      testSpinner.fail('SSH connection failed');
      printError('Connected but command execution failed. Check that the user has shell access.');
      return;
    }
  } catch (err: unknown) {
    testSpinner.fail('SSH connection failed');
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED')) {
      printError(`Connection refused on ${opts.host}:${opts.port}. Is SSH running on that port?`);
    } else if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
      printError(`Host "${opts.host}" not found. Check the hostname or IP address.`);
    } else if (msg.includes('ETIMEDOUT') || msg.includes('Timed out')) {
      printError(`Connection to ${opts.host}:${opts.port} timed out. Check firewall rules and network access.`);
    } else if (msg.includes('authentication') || msg.includes('All configured authentication methods failed')) {
      printError(opts.privateKey
        ? 'Authentication failed. Check that the SSH key is correct and authorized on the server.'
        : 'Authentication failed. Check the username and password.');
    } else {
      printError(`SSH error: ${msg}`);
    }
    return;
  }

  testSpinner.succeed('SSH connection successful');

  const archSpinner = createSpinner();
  archSpinner.start('Detecting server architecture...');
  const arch = await detectRemoteArch(conn);
  archSpinner.succeed(`Server architecture: ${arch}`);

  const binaryName = `dockflow-linux-${arch}`;
  const downloadUrl = `${DOCKFLOW_RELEASE_URL}/${binaryName}`;
  const remotePath = '/tmp/dockflow';

  const downloadSpinner = createSpinner();
  downloadSpinner.start('Downloading Dockflow CLI to remote server...');

  const downloadCmd = `curl -fsSL "${downloadUrl}" -o ${remotePath} && chmod +x ${remotePath}`;
  const downloadResult = await sshExec(conn, downloadCmd);

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

  await sshExecStream(conn, `${remotePath} setup`);

  printBlank();
  printDim('─'.repeat(60));

  const cleanupSpinner = createSpinner();
  cleanupSpinner.start('Cleaning up...');
  await sshExec(conn, `rm -f ${remotePath}`);
  cleanupSpinner.succeed('Cleanup complete');

  printBlank();
  printOutro('Remote setup completed');
}
