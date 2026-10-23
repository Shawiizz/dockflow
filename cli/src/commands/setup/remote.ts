/**
 * Remote setup: runs `dockflow setup` on a Linux server over SSH, from another machine.
 */

import * as fs from 'fs';
import { join, resolve } from 'path';
import { Client as SSHClient } from 'ssh2';
import { printIntro, printOutro, printSection, printError, printInfo, printBlank, printDim, createSpinner } from '../../utils/output';
import { sshExec, sshExecChannel, executeInteractiveSSH, presentedHostKey, raw, sh } from '../../utils/ssh';
import { hostKeyCheck } from '../../utils/host-key';
import { CLIError, ConnectionError, ErrorCode } from '../../utils/errors';
import type { ConnectionInfo, SSHExecResult } from '../../types';
import { isKeyConnection } from '../../types';
import { normalizePrivateKey } from '../../utils/ssh-keys';
import { DOCKFLOW_RELEASE_URL } from './constants';
import { DEFAULT_SSH_PORT, DOCKFLOW_VERSION } from '../../constants';
import {
  MAKE_TEMP_DIR_COMMAND,
  archFromMachine,
  installUploadCommand,
  expectedBinaryVersion,
  printsVersion,
  removeDirCommand,
  tempDirFrom,
  verifiedDownloadCommand,
  type RemoteArch,
} from './forward';
import { prompt, promptPassword, selectMenu, promptMultiline } from './prompts';
import { parseConnectionString } from './connection';
import type { RemoteSetupOptions } from './types';

type Exec = (conn: ConnectionInfo, command: string) => Promise<SSHExecResult>;

/** What the operator should read for a failed SSH connection. */
export function connectionFailureMessage(message: string, target: { host: string; port: number; privateKey?: string }): string {
  if (message.includes('ECONNREFUSED')) return `Connection refused on ${target.host}:${target.port}. Is SSH running on that port?`;
  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
    return `Host "${target.host}" not found. Check the hostname or IP address.`;
  }
  if (message.includes('ETIMEDOUT') || message.includes('Timed out')) {
    return `Connection to ${target.host}:${target.port} timed out. Check firewall rules and network access.`;
  }
  if (message.includes('authentication') || message.includes('All configured authentication methods failed')) {
    return target.privateKey
      ? 'Authentication failed. Check that the SSH key is correct and authorized on the server.'
      : 'Authentication failed. Check the username and password.';
  }
  return `SSH error: ${message}`;
}

/** Throws for a machine Dockflow publishes no binary for. */
export async function detectRemoteArch(conn: ConnectionInfo, exec: Exec = sshExec): Promise<RemoteArch> {
  const result = await exec(conn, 'uname -m');
  const machine = result.stdout.trim();
  const arch = result.exitCode === 0 ? archFromMachine(machine) : null;
  if (arch === null) {
    throw new ConnectionError(
      `Unsupported architecture ${machine || 'unknown'} on ${conn.host}`,
      'Dockflow publishes binaries for amd64 (x86_64) and arm64 (aarch64) Linux servers.',
    );
  }
  return arch;
}

/**
 * A private `mktemp -d` directory (0700, owned by the connecting user) in place of a fixed path in
 * a world-writable directory: no other local user can pre-create or swap the binary that setup
 * then runs as root.
 */
export async function makeTempDir(conn: ConnectionInfo, exec: Exec = sshExec): Promise<string> {
  const result = await exec(conn, MAKE_TEMP_DIR_COMMAND);
  const dir = result.exitCode === 0 ? tempDirFrom(result.stdout) : null;
  if (dir === null) {
    const reason = result.stderr.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() || `exit ${result.exitCode}`;
    throw new ConnectionError(
      `Could not create a temporary directory on ${conn.host} (${reason})`,
      'Check that the connecting user can write under $TMPDIR or /tmp.',
    );
  }
  return dir;
}

/**
 * Puts a password in a file only its owner can read, sent on the channel's stdin: it is in no
 * command line, local or remote.
 */
export async function writePasswordFile(conn: ConnectionInfo, path: string, password: string, open: typeof sshExecChannel = sshExecChannel): Promise<void> {
  const { stream, done } = await open(conn, sh`umask 077 && cat > ${path}`);
  stream.end(password);
  const result = await done;
  if (result.exitCode !== 0) {
    throw new CLIError(
      `Could not write the password file on ${conn.host}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      ErrorCode.COMMAND_FAILED,
    );
  }
}

/** Removes a directory made by makeTempDir; a failure only leaves a temporary directory behind. */
export async function cleanupTempDir(conn: ConnectionInfo, dir: string, exec: Exec = sshExec): Promise<void> {
  try {
    await exec(conn, removeDirCommand(dir));
  } catch {
    // the directory is private to the connecting user and sits under the temporary directory
  }
}

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

/** Uploads over SFTP on a connection of its own, as a binary stream. */
async function uploadFile(
  conn: ConnectionInfo,
  localPath: string,
  remotePath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const fileSize = fs.statSync(localPath).size;

  const client = new SSHClient();
  const hostKey = hostKeyCheck(conn);
  const config: Record<string, unknown> = {
    host: conn.host,
    port: conn.port || DEFAULT_SSH_PORT,
    username: conn.user,
    hostVerifier: hostKey.verify,
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
        const writeStream = sftp.createWriteStream(remotePath, { mode: 0o700 });
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

    client.on('error', (e) => reject(hostKey.failure() ?? e));
    client.connect(config as never);
  });
}

/**
 * Asks for the missing connection details; with `prefilled` (host and user from the target) only
 * the auth method is asked. Null when the operator cancels or gives an unusable answer.
 */
export async function promptRemoteConnection(prefilled?: RemoteSetupOptions): Promise<RemoteSetupOptions | null> {
  printSection('Remote Connection');
  printBlank();

  let host: string;
  let port: number;
  let user: string;
  const devMode = prefilled?.dev;

  if (prefilled) {
    // host and user came from the target: only the auth method is missing
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
        hostKey: conn.hostKey,
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
    throw new CLIError('No authentication method provided', ErrorCode.INVALID_ARGUMENT, 'Pass an SSH key (-k), a password or a connection string.');
  }

  const base = { host: opts.host, port: opts.port, user: opts.user, hostKey: opts.hostKey };
  const conn: ConnectionInfo = opts.privateKey
    ? { ...base, privateKey: opts.privateKey, ...(opts.password ? { password: opts.password } : {}) }
    : { ...base, password: opts.password! };

  try {
    const result = await sshExec(conn, 'echo ok');
    if (result.exitCode !== 0 || !result.stdout.includes('ok')) {
      throw new ConnectionError('Connected but command execution failed', 'Check that the user has shell access.');
    }
  } catch (err: unknown) {
    testSpinner.fail('SSH connection failed');
    if (err instanceof ConnectionError) throw err;
    throw new ConnectionError(connectionFailureMessage(err instanceof Error ? err.message : String(err), opts));
  }

  testSpinner.succeed('SSH connection successful');

  if (conn.hostKey === undefined) {
    conn.hostKey = presentedHostKey(conn);
    if (conn.hostKey) {
      printInfo(`Trusting host key ${conn.hostKey} (first connection); compare it with \`ssh-keygen -lf\` on the server if you can.`);
    }
  }

  const archSpinner = createSpinner();
  archSpinner.start('Detecting server architecture...');
  let arch: RemoteArch;
  try {
    arch = await detectRemoteArch(conn);
  } catch (err) {
    archSpinner.fail('Unsupported server architecture');
    throw err;
  }
  archSpinner.succeed(`Server architecture: ${arch}`);

  const dir = await makeTempDir(conn);
  const remotePath = `${dir}/dockflow`;

  let exitCode: number;
  try {
    if (opts.dev) {
      const buildSpinner = createSpinner();
      buildSpinner.start(`Building CLI binary (linux-${arch})...`);
      try {
        const binaryPath = await buildLocalBinary(arch);
        const size = fs.statSync(binaryPath).size;
        buildSpinner.succeed(`Binary built (${(size / 1024 / 1024).toFixed(1)} MB)`);

        const localHash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
        const uploadSpinner = createSpinner();
        uploadSpinner.start('Uploading binary to remote server... 0%');
        await uploadFile(conn, binaryPath, `${dir}/dockflow.part`, (pct) => {
          uploadSpinner.text = `Uploading binary to remote server... ${pct}%`;
        });
        const installed = await sshExec(conn, installUploadCommand(dir, localHash));
        if (installed.exitCode !== 0) {
          uploadSpinner.fail('Uploaded binary rejected');
          throw new CLIError(installed.stderr.trim() || 'The uploaded binary could not be verified', ErrorCode.COMMAND_FAILED);
        }
        uploadSpinner.succeed('Binary uploaded and verified');
      } catch (err) {
        if (err instanceof CLIError) throw err;
        buildSpinner.fail('Build/upload failed');
        throw new CLIError(`Build or upload failed: ${err instanceof Error ? err.message : String(err)}`, ErrorCode.COMMAND_FAILED);
      }
    } else {
      // pinned to this CLI's version (dev builds fall back to the latest release) and checked
      // against the SHA-256 its release publishes
      const binaryName = `dockflow-linux-${arch}`;

      const downloadSpinner = createSpinner();
      downloadSpinner.start('Downloading Dockflow CLI to remote server...');

      const downloadCmd = verifiedDownloadCommand(DOCKFLOW_RELEASE_URL, DOCKFLOW_VERSION, binaryName, remotePath);
      const downloadResult = await sshExec(conn, downloadCmd);

      if (downloadResult.exitCode !== 0) {
        downloadSpinner.fail('Failed to download Dockflow CLI');
        throw new CLIError(
          `Could not download the Dockflow binary on ${opts.host}: ${downloadResult.stderr.trim() || `exit ${downloadResult.exitCode}`}`,
          ErrorCode.COMMAND_FAILED,
          'Check that the server can reach github.com, then run the same command again.',
        );
      }

      downloadSpinner.succeed('Dockflow CLI downloaded and verified');
    }

    const expectedVersion = expectedBinaryVersion(DOCKFLOW_VERSION, opts.dev === true);
    const version = await sshExec(conn, sh`${remotePath} --version`);
    if (version.exitCode !== 0 || (expectedVersion !== null && !printsVersion(version.stdout, expectedVersion))) {
      throw new CLIError(
        `The Dockflow binary on ${opts.host} prints ${version.stdout.split(/\r?\n/)[0]?.trim() || 'no version'}, expected ${expectedVersion ?? 'a version'}`,
        ErrorCode.COMMAND_FAILED,
        'Run the same command again; if it persists, the server may not run Linux binaries of this architecture.',
      );
    }

    printBlank();
    printSection('Running setup on remote server');
    printDim('─'.repeat(60));
    printBlank();

    // root runs the binary directly (sudo may not exist on minimal systems); other users go
    // through sudo
    const flags = [...(opts.forwardFlags ?? [])];
    if (conn.hostKey) flags.push('--host-key', sh`${conn.hostKey}`);
    if (opts.deployPassword) {
      const passwordFile = `${dir}/deploy-password`;
      await writePasswordFile(conn, passwordFile, opts.deployPassword);
      flags.push('--password-file', sh`${passwordFile}`);
    }
    const sudoPrefix = opts.user === 'root' ? '' : 'sudo ';
    // every flag is a literal or a value already quoted by sh (buildForwardFlags and the pushes above)
    const remoteCmd = flags.length
      ? sh`${raw(sudoPrefix)}${remotePath} setup ${raw(flags.join(' '))}`
      : sh`${raw(sudoPrefix)}${remotePath} setup`;
    exitCode = await executeInteractiveSSH(conn, remoteCmd);

    printBlank();
    printDim('─'.repeat(60));
  } finally {
    const cleanupSpinner = createSpinner();
    cleanupSpinner.start('Cleaning up...');
    await cleanupTempDir(conn, dir);
    cleanupSpinner.succeed('Cleanup complete');
  }

  if (exitCode !== 0) {
    throw new CLIError(
      `Setup failed on ${opts.host} (exit code ${exitCode})`,
      ErrorCode.COMMAND_FAILED,
      'Its output above says what went wrong; fix it, then run the same command again: setup is idempotent.',
    );
  }

  printBlank();
  printOutro('Remote setup completed');
}
