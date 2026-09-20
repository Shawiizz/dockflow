/**
 * Remote setup functionality (Windows/macOS -> Linux), and the two primitives the k3s cluster
 * transport (`k3s/transport.ts`) reuses over its own dedicated, host-key-verified connections:
 * `deliverBinary` (verified binary delivery into a private temp dir, design-05 3.3, K57c) and
 * `runNodeStep` (the `--k3s-plan` JSON-line protocol, design-05 3.4).
 */

import * as fs from 'fs';
import { join, resolve } from 'path';
import { Client as SSHClient } from 'ssh2';
import { printIntro, printOutro, printSection, printError, printInfo, printBlank, printDim, createSpinner } from '../../utils/output';
import { sshExec, sshExecChannelDedicated, executeInteractiveSSH } from '../../utils/ssh';
import type { ConnectionInfo } from '../../types';
import { isKeyConnection } from '../../types';
import { normalizePrivateKey } from '../../utils/ssh-keys';
import { ConnectionError } from '../../utils/errors';
import { archFromMachine, type NodeBinary, nodeBinaryDeliveryScript, parseDeliveryFailure, resolveNodeBinary } from './k3s/install';
import type { NodeArch, K3sNodePlan } from './k3s/plan';
import { DOCKFLOW_RELEASE_URL } from './constants';
import { DEFAULT_SSH_PORT, DOCKFLOW_VERSION } from '../../constants';
import { prompt, promptPassword, selectMenu, promptMultiline } from './prompts';
import { parseConnectionString } from './connection';
import type { RemoteSetupOptions } from './types';

/** `uname -m` -> the pinned architecture, or the refusal of design-05 3.3 (K57c). */
export async function detectRemoteArch(conn: ConnectionInfo): Promise<NodeArch> {
  const result = await sshExec(conn, 'uname -m');
  const arch = archFromMachine(result.stdout);
  if (arch === null) {
    throw new ConnectionError(
      `Unsupported architecture ${result.stdout.trim()} on ${conn.host}; k3s nodes must be amd64 or arm64`,
      'Use an amd64 (x86_64) or arm64 (aarch64) machine.',
    );
  }
  return arch;
}

/** the bun --target suffix for a pinned architecture ('x64', not 'amd64') */
function bunTargetArch(arch: NodeArch): 'x64' | 'arm64' {
  return arch === 'amd64' ? 'x64' : 'arm64';
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
    hostVerifier: conn.hostVerifier ?? (() => true),
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
        // 0700: the file lands in a private per-connection temp dir and is verified before use
        // (design-05 3.3); a world- or group-readable upload would defeat that privacy.
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

    client.on('error', reject);
    client.connect(config as never);
  });
}

// ---------------------------------------------------------------------------
// Shared primitives (design-05 3.3, 3.4): reused by runRemoteSetup below and by
// k3s/transport.ts's cluster SetupTransport over its own dedicated, host-key-verified
// connections. Every interpolated shell value is shellQuote()d; nothing here builds a command
// string outside curlArgs()/nodeBinaryDeliveryScript().
// ---------------------------------------------------------------------------

/**
 * A private `mktemp -d` directory (0700, owned by the connecting user), replacing a fixed
 * world-writable path: no local user can swap the binary between download and execution (F28).
 */
export async function makeTempDir(conn: ConnectionInfo): Promise<string> {
  const result = await sshExec(conn, 'mktemp -d "${TMPDIR:-/tmp}/dockflow-setup.XXXXXXXX"', { requireExitStatus: true });
  if (result.exitCode !== 0 || result.stdout.trim() === '') {
    throw new ConnectionError(
      `Could not create a temporary directory on ${conn.host} (${(result.stderr.split(/\r?\n/).find((l) => l.trim()) ?? '').trim() || `exit ${result.exitCode}`})`,
      'Check that the connecting user can write under $TMPDIR or /tmp.',
    );
  }
  return result.stdout.trim();
}

/** Best-effort `rm -rf` of a temp dir created by makeTempDir; never throws. */
export async function cleanupTempDir(conn: ConnectionInfo, dir: string): Promise<void> {
  try {
    await sshExec(conn, `rm -rf -- ${shellQuoteOf(dir)}`);
  } catch {
    /* cleanup is best effort */
  }
}

function shellQuoteOf(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Verified delivery of the Dockflow binary into `dir` (K57c): an upload is SFTP'd into
 * `<dir>/dockflow.part` first (uploadFile, mode 0700), a download fetches it there; either way the
 * hash is checked with `sha256sum -c` before the file is made executable and moved into place, so a
 * failed check leaves no executable behind.
 */
export async function deliverBinary(conn: ConnectionInfo, dir: string, binary: NodeBinary, key: string): Promise<void> {
  if (binary.mode === 'upload') {
    await uploadFile(conn, binary.path, `${dir}/dockflow.part`);
  }
  const script = nodeBinaryDeliveryScript(dir, binary);
  const result = await sshExec(conn, script, { requireExitStatus: true });
  if (result.exitCode !== 0) {
    const problem = parseDeliveryFailure(result, { key, binary });
    throw new ConnectionError(problem.message, problem.suggestion);
  }
}

/** `<dir>/dockflow --version` must print DOCKFLOW_VERSION (3.3's "version" row). */
export async function verifyDeliveredVersion(conn: ConnectionInfo, dir: string, key: string): Promise<void> {
  const result = await sshExec(conn, `${dir}/dockflow --version`);
  const printed = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  if (result.exitCode !== 0 || !printed.includes(DOCKFLOW_VERSION)) {
    throw new ConnectionError(
      `${key} runs Dockflow ${printed || 'unknown'} from ${dir}/dockflow, expected ${DOCKFLOW_VERSION}`,
      'Delete the node’s temporary directory and run setup again.',
    );
  }
}

export interface NodeEvent {
  step: string;
  status: 'start' | 'ok' | 'skip' | 'warn';
  detail?: string;
}

export interface NodeStepHandlers {
  onEvent(event: NodeEvent): void;
}

/** What the node step protocol (3.4) settles to: a printed result, a guard timeout, or a crash. */
export type NodeStepOutcome =
  | { kind: 'result'; result: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'crash'; exitCode: number; stderrTail: string[] };

const STDERR_TAIL_LINES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Runs `<prefix><dir>/dockflow setup --orchestrator k3s --k3s-plan -` over a non-PTY dedicated
 * channel (never the pool, 3.5): the plan JSON is written to stdin and the stream is closed, stdout
 * JSON lines are parsed as they arrive (`dockflowNodeEvent` dispatched live, `dockflowNodeResult`
 * captured), and the channel is closed once `guardS` seconds pass without a result line.
 */
export async function runNodeStep(
  conn: ConnectionInfo,
  dir: string,
  plan: K3sNodePlan,
  handlers: NodeStepHandlers,
  guardS: number,
): Promise<NodeStepOutcome> {
  const prefix = conn.user === 'root' ? '' : 'sudo -n -- ';
  const command = `${prefix}${dir}/dockflow setup --orchestrator k3s --k3s-plan -`;
  const channel = await sshExecChannelDedicated(conn, command);

  let result: Record<string, unknown> | null = null;
  let timedOut = false;
  let settled = false;
  let buffer = '';
  let stderrTail: string[] = [];

  const timer = setTimeout(() => {
    if (!settled) {
      timedOut = true;
      channel.close();
    }
  }, guardS * 1000);

  channel.stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (isRecord(parsed.dockflowNodeEvent)) {
        const event = parsed.dockflowNodeEvent;
        handlers.onEvent({ step: String(event.step), status: event.status as NodeEvent['status'], detail: typeof event.detail === 'string' ? event.detail : undefined });
      } else if (isRecord(parsed.dockflowNodeResult)) {
        result = parsed.dockflowNodeResult;
      }
    }
  });
  channel.stream.stderr.on('data', (chunk: Buffer) => {
    stderrTail = [...stderrTail, ...chunk.toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '')].slice(-STDERR_TAIL_LINES);
  });

  channel.stream.end(JSON.stringify(plan));

  let exitCode = -1;
  try {
    const exit = await channel.done;
    exitCode = exit.exitCode;
  } catch {
    /* a lost connection is reported like any other missing result line */
  } finally {
    clearTimeout(timer);
    settled = true;
    channel.close();
  }

  if (result !== null) return { kind: 'result', result };
  if (timedOut) return { kind: 'timeout' };
  return { kind: 'crash', exitCode, stderrTail };
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

  const archSpinner = createSpinner();
  archSpinner.start('Detecting server architecture...');
  const arch = await detectRemoteArch(conn);
  archSpinner.succeed(`Server architecture: ${arch}`);

  // A private mktemp -d directory (design-05 3.3, F28) replaces the fixed, world-writable
  // /tmp/dockflow path: no local user on the target can swap the binary before it runs as root.
  const dirSpinner = createSpinner();
  dirSpinner.start('Creating a private temporary directory...');
  let dir: string;
  try {
    dir = await makeTempDir(conn);
  } catch (err) {
    dirSpinner.fail('Could not create a temporary directory');
    printError(err instanceof Error ? err.message : String(err));
    return;
  }
  dirSpinner.succeed('Temporary directory ready');
  const remotePath = `${dir}/dockflow`;

  let binary: NodeBinary;
  if (opts.dev) {
    const buildSpinner = createSpinner();
    buildSpinner.start(`Building CLI binary (linux-${bunTargetArch(arch)})...`);
    try {
      const binaryPath = await buildLocalBinary(bunTargetArch(arch));
      const size = fs.statSync(binaryPath).size;
      buildSpinner.succeed(`Binary built (${(size / 1024 / 1024).toFixed(1)} MB)`);
      binary = { mode: 'upload', path: binaryPath, sha256: new Bun.CryptoHasher('sha256').update(fs.readFileSync(binaryPath)).digest('hex') };
    } catch (err) {
      buildSpinner.fail(`Build failed: ${err}`);
      await cleanupTempDir(conn, dir);
      return;
    }
  } else {
    // Pinned to this CLI's version so the binary provisioning the server is the same one the
    // operator runs, and verified against the release's published SHA256SUMS (K57c) before it is
    // ever made executable.
    try {
      const resolved = await resolveNodeBinary({ localBinaries: null, arches: [arch], nodeCount: 1, releaseUrl: DOCKFLOW_RELEASE_URL });
      const forArch = resolved[arch];
      if (forArch === undefined) throw new Error(`no pinned binary for ${arch}`);
      binary = forArch;
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      await cleanupTempDir(conn, dir);
      return;
    }
  }

  const deliverSpinner = createSpinner();
  deliverSpinner.start(binary.mode === 'upload' ? 'Uploading and verifying the Dockflow binary...' : 'Downloading and verifying the Dockflow binary...');
  try {
    await deliverBinary(conn, dir, binary, opts.host);
  } catch (err) {
    deliverSpinner.fail('Binary delivery failed');
    printError(err instanceof Error ? err.message : String(err));
    await cleanupTempDir(conn, dir);
    return;
  }
  try {
    await verifyDeliveredVersion(conn, dir, opts.host);
  } catch (err) {
    deliverSpinner.fail('Binary delivery failed');
    printError(err instanceof Error ? err.message : String(err));
    await cleanupTempDir(conn, dir);
    return;
  }
  deliverSpinner.succeed('Dockflow binary verified');

  printBlank();
  printSection('Running setup on remote server');
  printDim('─'.repeat(60));
  printBlank();

  // root runs the binary directly (sudo may not even exist on minimal
  // systems); other users escalate through sudo.
  const sudoPrefix = opts.user === 'root' ? '' : 'sudo ';
  const remoteCmd = opts.forwardFlags?.length
    ? `${sudoPrefix}${remotePath} setup ${opts.forwardFlags.join(' ')}`
    : `${sudoPrefix}${remotePath} setup`;
  await executeInteractiveSSH(conn, remoteCmd);

  printBlank();
  printDim('─'.repeat(60));

  const cleanupSpinner = createSpinner();
  cleanupSpinner.start('Cleaning up...');
  await cleanupTempDir(conn, dir);
  cleanupSpinner.succeed('Cleanup complete');

  printBlank();
  printOutro('Remote setup completed');
}
