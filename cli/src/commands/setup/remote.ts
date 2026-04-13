/**
 * Remote setup functionality (Windows/macOS -> Linux)
 */

import * as fs from 'fs';
import { join, resolve } from 'path';
import { Client as SSHClient } from 'ssh2';
import { printIntro, printOutro, printSection, printError, printInfo, printBlank, printDim, createSpinner } from '../../utils/output';
import { sshExec, executeInteractiveSSH } from '../../utils/ssh';
import type { ConnectionInfo } from '../../types';
import { isKeyConnection } from '../../types';
import { normalizePrivateKey } from '../../utils/ssh-keys';
import { DOCKFLOW_RELEASE_URL } from './constants';
import { DEFAULT_SSH_PORT } from '../../constants';
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
 * Build the CLI binary locally for the target architecture.
 * Returns the path to the built binary.
 */
async function buildLocalBinary(arch: 'x64' | 'arm64'): Promise<string> {
  const cliDir = resolve(join(import.meta.dir, '..', '..', '..'));
  const target = `bun-linux-${arch}`;
  const outfile = join(cliDir, 'dist', `dockflow-linux-${arch}`);

  const proc = Bun.spawn(['bun', 'build', 'src/index.ts', '--compile', `--target=${target}`, `--outfile=${outfile}`], {
    cwd: cliDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Build failed (exit ${exitCode}): ${stderr}`);
  }

  return outfile;
}

/**
 * Upload a local file to a remote host via SFTP (binary stream, no base64 overhead).
 * Creates a dedicated SSH connection for the transfer.
 */
async function uploadFile(
  conn: ConnectionInfo,
  localPath: string,
  remotePath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const fileSize = fs.statSync(localPath).size;

  const client = new SSHClient();
  const config: Record<string, unknown> = {
    host: conn.host,
    port: conn.port || DEFAULT_SSH_PORT,
    username: conn.user,
    hostVerifier: () => true,
    readyTimeout: 30_000,
  };

  if (isKeyConnection(conn)) {
    config.privateKey = normalizePrivateKey(conn.privateKey);
    if (conn.password) config.passphrase = conn.password;
  } else {
    config.password = conn.password;
  }

  await new Promise<void>((resolve, reject) => {
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) { client.end(); reject(err); return; }

        const readStream = fs.createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath, { mode: 0o755 });
        let transferred = 0;

        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          if (onProgress) {
            onProgress(Math.round((transferred / fileSize) * 100));
          }
        });

        writeStream.on('close', () => {
          client.end();
          resolve();
        });

        writeStream.on('error', (e: Error) => {
          client.end();
          reject(e);
        });

        readStream.on('error', (e: Error) => {
          client.end();
          reject(e);
        });

        readStream.pipe(writeStream);
      });
    });

    client.on('error', reject);
    client.connect(config as never);
  });
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
  const devMode = prefilled?.dev;

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
        dev: devMode,
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

  return { host, port, user, password, privateKey, privateKeyPath, dev: devMode };
}

/**
 * Run remote setup via SSH
 */
export async function runRemoteSetup(opts: RemoteSetupOptions): Promise<void> {
  printIntro('Remote Setup');
  printBlank();
  printInfo(`Target: ${opts.user}@${opts.host}:${opts.port}`);
  if (opts.dev) {
    printInfo('Mode: dev (build & upload local binary)');
  }
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

  const remotePath = '/tmp/dockflow';

  if (opts.dev) {
    // Dev mode: build locally and upload
    const archSpinner = createSpinner();
    archSpinner.start('Detecting server architecture...');
    const arch = await detectRemoteArch(conn);
    archSpinner.succeed(`Server architecture: ${arch}`);

    const buildSpinner = createSpinner();
    buildSpinner.start(`Building CLI binary (linux-${arch})...`);
    try {
      const binaryPath = await buildLocalBinary(arch);
      const size = fs.statSync(binaryPath).size;
      buildSpinner.succeed(`Binary built (${(size / 1024 / 1024).toFixed(1)} MB)`);

      // Check if remote already has the same binary (hash comparison)
      const localHash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
      const remoteHashResult = await sshExec(conn, `sha256sum ${remotePath} 2>/dev/null | cut -d' ' -f1`);
      const remoteHash = remoteHashResult.stdout.trim();

      if (localHash === remoteHash) {
        printInfo('Binary unchanged, skipping upload');
      } else {
        const uploadSpinner = createSpinner();
        uploadSpinner.start('Uploading binary to remote server... 0%');
        await uploadFile(conn, binaryPath, remotePath, (pct) => {
          uploadSpinner.text = `Uploading binary to remote server... ${pct}%`;
        });
        uploadSpinner.succeed('Binary uploaded');
      }
    } catch (err) {
      buildSpinner.fail(`Build/upload failed: ${err}`);
      return;
    }
  } else {
    // Release mode: download from GitHub
    const archSpinner = createSpinner();
    archSpinner.start('Detecting server architecture...');
    const arch = await detectRemoteArch(conn);
    archSpinner.succeed(`Server architecture: ${arch}`);

    const binaryName = `dockflow-linux-${arch}`;
    const downloadUrl = `${DOCKFLOW_RELEASE_URL}/${binaryName}`;

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
  }

  printBlank();
  printSection('Running setup on remote server');
  printDim('─'.repeat(60));
  printBlank();

  const remoteCmd = opts.forwardFlags?.length
    ? `sudo ${remotePath} setup ${opts.forwardFlags.join(' ')}`
    : `sudo ${remotePath} setup`;
  await executeInteractiveSSH(conn, remoteCmd);

  printBlank();
  printDim('─'.repeat(60));

  const cleanupSpinner = createSpinner();
  cleanupSpinner.start('Cleaning up...');
  await sshExec(conn, `rm -f ${remotePath}`);
  cleanupSpinner.succeed('Cleanup complete');

  printBlank();
  printOutro('Remote setup completed');
}
