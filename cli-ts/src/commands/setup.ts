/**
 * Setup commands - Configure host machines for deployment
 * Runs on the target Linux host and uses SSH to execute Ansible locally
 * Can also run remotely from Windows/macOS via SSH
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as readline from 'readline';
import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { printError, printSuccess, printInfo, printSection, printHeader, printWarning } from '../utils/output';
import { sshExec, sshExecStream, testConnection } from '../utils/ssh';
import type { ConnectionInfo } from '../utils/config';

// ============================================
// Types
// ============================================

interface SetupOptions {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  sshKey?: string;
  generateKey?: boolean;
  skipDockerInstall?: boolean;
  portainer?: boolean;
  portainerPort?: string;
  portainerPassword?: string;
  portainerDomain?: string;
  yes?: boolean;
}

interface HostConfig {
  publicHost: string;
  sshPort: number;
  deployUser: string;
  deployPassword?: string;
  privateKeyPath: string;
  skipDockerInstall: boolean;
  portainer: {
    install: boolean;
    port: number;
    password?: string;
    domain?: string;
  };
}

// ============================================
// Constants
// ============================================

const DOCKFLOW_REPO = 'https://github.com/Shawiizz/dockflow.git';
const DOCKFLOW_DIR = '/opt/dockflow';
const DOCKFLOW_RELEASE_URL = 'https://github.com/Shawiizz/dockflow/releases/latest/download';

// ============================================
// Remote setup types
// ============================================

interface RemoteSetupOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
}

// ============================================
// Dependency checking
// ============================================

const REQUIRED_DEPENDENCIES = [
  { name: 'ansible', command: 'ansible --version', description: 'Ansible automation tool' },
  { name: 'ansible-playbook', command: 'ansible-playbook --version', description: 'Ansible playbook runner' },
  { name: 'ssh', command: 'ssh -V', description: 'OpenSSH client' },
  { name: 'ssh-keygen', command: 'ssh-keygen -V', description: 'SSH key generator' },
  { name: 'git', command: 'git --version', description: 'Git version control' },
];

const OPTIONAL_DEPENDENCIES = [
  { name: 'ansible-galaxy', command: 'ansible-galaxy --version', description: 'Ansible Galaxy (for roles)' },
];

/**
 * Check if a command exists
 */
function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result.status === 0;
}

/**
 * Check if running on Linux
 */
function isLinux(): boolean {
  return os.platform() === 'linux';
}

/**
 * Check all required dependencies
 */
function checkDependencies(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const dep of REQUIRED_DEPENDENCIES) {
    if (!commandExists(dep.name)) {
      missing.push(`${dep.name} (${dep.description})`);
    }
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

/**
 * Display dependency check results
 */
function displayDependencyStatus(): void {
  printSection('Dependency Check');

  for (const dep of REQUIRED_DEPENDENCIES) {
    const exists = commandExists(dep.name);
    const status = exists ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${status} ${dep.name} - ${dep.description}`);
  }

  console.log('');
  printInfo('Optional:');
  for (const dep of OPTIONAL_DEPENDENCIES) {
    const exists = commandExists(dep.name);
    const status = exists ? chalk.green('✓') : chalk.yellow('○');
    console.log(`  ${status} ${dep.name} - ${dep.description}`);
  }
  console.log('');
}

// ============================================
// Network detection utilities
// ============================================

/**
 * Detect public IP address (IPv4 preferred)
 */
function detectPublicIP(): string {
  // Try IPv4 services first
  const methods = [
    "curl -4 -s --max-time 5 ifconfig.me 2>/dev/null",
    "curl -4 -s --max-time 5 icanhazip.com 2>/dev/null",
    "curl -4 -s --max-time 5 ipecho.net/plain 2>/dev/null",
    "curl -4 -s --max-time 5 api.ipify.org 2>/dev/null",
    "hostname -I 2>/dev/null | awk '{print $1}'"
  ];

  for (const method of methods) {
    const result = spawnSync('sh', ['-c', method], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }

  return '127.0.0.1';
}

/**
 * Detect SSH port
 */
function detectSSHPort(): number {
  const result = spawnSync('sh', ['-c', "ss -tlnp 2>/dev/null | grep sshd | awk '{print $4}' | grep -oE '[0-9]+$' | head -1"], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status === 0 && result.stdout.trim()) {
    const port = parseInt(result.stdout.trim(), 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      return port;
    }
  }

  return 22;
}

/**
 * Get current username
 */
function getCurrentUser(): string {
  return os.userInfo().username;
}

// ============================================
// Interactive prompts
// ============================================

/**
 * Create readline interface
 */
function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * Prompt for input with default value
 */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createRL();
  const defaultStr = defaultValue ? ` [${defaultValue}]` : '';

  return new Promise((resolve) => {
    rl.question(`${chalk.cyan(question)}${defaultStr}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for password (hidden input)
 */
async function promptPassword(question: string): Promise<string> {
  const rl = createRL();

  return new Promise((resolve) => {
    // Disable echo for password input
    process.stdout.write(`${chalk.cyan(question)}: `);

    const stdin = process.stdin;
    const oldRawMode = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let password = '';

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) {
          stdin.setRawMode(oldRawMode ?? false);
        }
        process.stdout.write('\n');
        rl.close();
        resolve(password);
      } else if (c === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else if (c === '\u007F' || c === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += c;
      }
    };

    stdin.on('data', onData);
    stdin.resume();
  });
}

/**
 * Prompt for yes/no confirmation
 */
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const defaultStr = defaultYes ? 'Y/n' : 'y/N';
  const answer = await prompt(`${question} (${defaultStr})`);

  if (!answer) {
    return defaultYes;
  }

  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * Interactive menu selection
 */
async function selectMenu(title: string, options: string[]): Promise<number> {
  console.log('');
  console.log(chalk.cyan(title));

  options.forEach((opt, idx) => {
    console.log(`  ${chalk.yellow(`${idx + 1})`)} ${opt}`);
  });

  const answer = await prompt('Select option', '1');
  const idx = parseInt(answer, 10) - 1;

  if (idx >= 0 && idx < options.length) {
    return idx;
  }

  return 0;
}

// ============================================
// SSH Key management
// ============================================

/**
 * Generate new SSH key pair
 */
function generateSSHKey(keyPath: string, comment: string = 'dockflow'): { success: boolean; error?: string } {
  const dir = path.dirname(keyPath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Remove existing key if present
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
    }
    if (fs.existsSync(`${keyPath}.pub`)) {
      fs.unlinkSync(`${keyPath}.pub`);
    }

    const result = spawnSync('ssh-keygen', [
      '-t', 'ed25519',
      '-f', keyPath,
      '-N', '',
      '-C', comment
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.status === 0) {
      fs.chmodSync(keyPath, 0o600);
      return { success: true };
    }

    return { 
      success: false, 
      error: result.stderr || result.stdout || `Exit code: ${result.status}` 
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Add public key to authorized_keys
 */
function addToAuthorizedKeys(pubKeyPath: string, user?: string): boolean {
  const homeDir = user ? `/home/${user}` : os.homedir();
  const authKeysPath = path.join(homeDir, '.ssh', 'authorized_keys');
  const sshDir = path.dirname(authKeysPath);

  // Read public key
  if (!fs.existsSync(pubKeyPath)) {
    return false;
  }
  const pubKey = fs.readFileSync(pubKeyPath, 'utf-8').trim();

  // Ensure .ssh directory exists
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  // Check if key already in authorized_keys
  if (fs.existsSync(authKeysPath)) {
    const existing = fs.readFileSync(authKeysPath, 'utf-8');
    if (existing.includes(pubKey)) {
      return true; // Already present
    }
  }

  // Append key
  fs.appendFileSync(authKeysPath, `${pubKey}\n`, { mode: 0o600 });
  return true;
}

/**
 * List available SSH keys for a user
 */
function listSSHKeys(username?: string): string[] {
  // Determine the SSH directory based on username
  let sshDir: string;
  
  if (username && username !== 'root') {
    sshDir = `/home/${username}/.ssh`;
  } else {
    sshDir = path.join(os.homedir(), '.ssh');
  }
  
  if (!fs.existsSync(sshDir)) {
    return [];
  }

  const files = fs.readdirSync(sshDir);
  const keys: string[] = [];

  for (const file of files) {
    const filePath = path.join(sshDir, file);
    if (!file.endsWith('.pub') && !file.includes('known_hosts') && !file.includes('config') && !file.includes('authorized_keys')) {
      // Check if it's a private key
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('PRIVATE KEY')) {
          keys.push(filePath);
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return keys;
}

// ============================================
// User management
// ============================================

/**
 * Create deployment user with sudo privileges
 */
function createDeployUser(username: string, password: string, publicKey: string): boolean {
  const spinner = ora(`Creating user ${username}...`).start();

  // Create user
  let result = spawnSync('sudo', ['useradd', '-m', '-s', '/bin/bash', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0 && !result.stderr.includes('already exists')) {
    spinner.fail(`Failed to create user: ${result.stderr}`);
    return false;
  }

  // Set password
  const chpasswd = spawnSync('sudo', ['chpasswd'], {
    input: `${username}:${password}`,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (chpasswd.status !== 0) {
    spinner.fail(`Failed to set password: ${chpasswd.stderr}`);
    return false;
  }

  // Add to sudo group
  result = spawnSync('sudo', ['usermod', '-aG', 'sudo', username], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    // Try wheel group (RHEL/CentOS)
    result = spawnSync('sudo', ['usermod', '-aG', 'wheel', username], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  // Setup SSH for the user
  const userHome = `/home/${username}`;
  const userSSHDir = `${userHome}/.ssh`;

  spawnSync('sudo', ['mkdir', '-p', userSSHDir], { encoding: 'utf-8' });
  spawnSync('sudo', ['sh', '-c', `echo "${publicKey}" > ${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });
  spawnSync('sudo', ['chown', '-R', `${username}:${username}`, userSSHDir], { encoding: 'utf-8' });
  spawnSync('sudo', ['chmod', '700', userSSHDir], { encoding: 'utf-8' });
  spawnSync('sudo', ['chmod', '600', `${userSSHDir}/authorized_keys`], { encoding: 'utf-8' });

  // Add passwordless sudo for docker commands
  const sudoersContent = `${username} ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker-compose, /usr/bin/systemctl`;
  spawnSync('sudo', ['sh', '-c', `echo "${sudoersContent}" > /etc/sudoers.d/${username}`], { encoding: 'utf-8' });
  spawnSync('sudo', ['chmod', '440', `/etc/sudoers.d/${username}`], { encoding: 'utf-8' });

  spinner.succeed(`User ${username} created successfully`);
  return true;
}

// ============================================
// Connection string generation
// ============================================

/**
 * Generate connection string (base64 encoded JSON)
 */
function generateConnectionString(config: {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  password?: string;
}): string {
  const json = JSON.stringify({
    host: config.host,
    port: config.port,
    user: config.user,
    privateKey: config.privateKey,
    ...(config.password && { password: config.password })
  });

  return Buffer.from(json).toString('base64');
}

/**
 * Display connection information
 */
function displayConnectionInfo(config: HostConfig, privateKey: string): void {
  console.log('');
  printHeader('Connection Information');
  console.log('');

  console.log(chalk.yellow('━'.repeat(70)));
  console.log(chalk.yellow('SSH Private Key (KEEP SECURE):'));
  console.log(chalk.yellow('━'.repeat(70)));
  console.log(privateKey);
  console.log(chalk.yellow('━'.repeat(70)));
  console.log('');

  const connectionString = generateConnectionString({
    host: config.publicHost,
    port: config.sshPort,
    user: config.deployUser,
    privateKey: privateKey,
    password: config.deployPassword
  });

  console.log(chalk.red('╔' + '═'.repeat(70) + '╗'));
  console.log(chalk.red('║') + '                         ⚠️  DO NOT SHARE  ⚠️                          ' + chalk.red('║'));
  console.log(chalk.red('║') + '                                                                      ' + chalk.red('║'));
  console.log(chalk.red('║') + `  This connection string contains the SSH private key!                ` + chalk.red('║'));
  console.log(chalk.red('║') + `  Anyone with this string can access your server as: ${config.deployUser.padEnd(15)}   ` + chalk.red('║'));
  console.log(chalk.red('╚' + '═'.repeat(70) + '╝'));
  console.log('');

  console.log(chalk.cyan('Connection String (Base64):'));
  console.log(chalk.yellow('━'.repeat(70)));
  console.log(connectionString);
  console.log(chalk.yellow('━'.repeat(70)));
  console.log('');

  console.log(chalk.cyan('Deployment User:'), chalk.blue(config.deployUser));
  console.log('');
  console.log(chalk.yellow('💡 Add this connection string to your CI/CD secrets:'));
  console.log(chalk.gray('   Secret name: [YOURENV]_CONNECTION'));
  console.log(chalk.gray('   (Replace [YOURENV] with your environment, e.g., PRODUCTION_CONNECTION)'));
  console.log('');
}

// ============================================
// Ansible execution
// ============================================

/**
 * Validate user password by testing it with su
 * This works even when running as root
 */
async function validateUserPassword(username: string, password: string): Promise<boolean> {
  if (!username || !password) {
    return false;
  }

  // Check if running as root
  const isRoot = process.getuid?.() === 0;

  let result;
  if (isRoot) {
    // If running as root, run the su command as the target user (forces password check)
    result = spawnSync('sudo', ['-u', username, 'bash', '-c', `echo '${password}' | /bin/su --command true - '${username}'`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } else {
    // Not root, use su directly
    result = spawnSync('bash', ['-c', `echo '${password}' | /bin/su --command true - '${username}'`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  return result.status === 0;
}

/**
 * Prompt for user password with validation
 */
async function promptAndValidateUserPassword(username: string): Promise<string> {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const password = await promptPassword(`Password for user ${username}`);
    
    if (!password) {
      printWarning('Password cannot be empty');
      attempts++;
      continue;
    }

    printInfo('Validating password...');
    if (await validateUserPassword(username, password)) {
      printSuccess('Password validated');
      return password;
    } else {
      attempts++;
      if (attempts < maxAttempts) {
        printError(`Invalid password. ${maxAttempts - attempts} attempts remaining.`);
      }
    }
  }

  printError('Too many failed attempts');
  process.exit(1);
}

// ============================================
// Remote setup (Windows/macOS -> Linux)
// ============================================

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
 * Parse connection string to ConnectionInfo
 */
function parseConnectionString(connectionString: string): ConnectionInfo | null {
  try {
    const json = Buffer.from(connectionString, 'base64').toString('utf-8');
    const data = JSON.parse(json);
    
    if (!data.host || !data.user || !data.privateKey) {
      return null;
    }
    
    return {
      host: data.host,
      port: data.port || 22,
      user: data.user,
      privateKey: data.privateKey,
      password: data.password
    };
  } catch {
    return null;
  }
}

/**
 * Prompt for remote connection info
 */
async function promptRemoteConnection(): Promise<RemoteSetupOptions | null> {
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
    // Use connection string
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
  
  // Manual entry
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
  
  // Auth method
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
 * Prompt for multiline input (for SSH key pasting)
 */
async function promptMultiline(): Promise<string> {
  const rl = createRL();
  const lines: string[] = [];
  let emptyLineCount = 0;
  
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (line === '') {
        emptyLineCount++;
        if (emptyLineCount >= 2) {
          rl.close();
          resolve(lines.join('\n'));
          return;
        }
      } else {
        emptyLineCount = 0;
      }
      lines.push(line);
    });
    
    rl.on('close', () => {
      resolve(lines.join('\n'));
    });
  });
}

/**
 * Create ConnectionInfo from RemoteSetupOptions with password-based SSH
 * For password auth, we need to use sshpass
 */
function createConnectionForPasswordAuth(opts: RemoteSetupOptions): { conn: ConnectionInfo | null; usePassword: boolean } {
  if (opts.privateKey) {
    return {
      conn: {
        host: opts.host,
        port: opts.port,
        user: opts.user,
        privateKey: opts.privateKey,
        password: opts.password
      },
      usePassword: false
    };
  }
  
  // For password auth, we'll need to generate a temporary key on the remote
  return { conn: null, usePassword: true };
}

/**
 * Execute SSH command with password (requires sshpass on local machine)
 */
function sshExecWithPassword(host: string, port: number, user: string, password: string, command: string): { stdout: string; stderr: string; exitCode: number } {
  // Check if sshpass is available
  const hasSshpass = spawnSync('which', ['sshpass'], { encoding: 'utf-8' }).status === 0 ||
                     spawnSync('where', ['sshpass'], { encoding: 'utf-8', shell: true }).status === 0;
  
  if (!hasSshpass) {
    // Try using native ssh with expect-like behavior via spawn
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
      // Fallback without sshpass - less reliable for password auth
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
      
      // Send password if prompted
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
      // Don't print password prompts
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
 * Run remote setup via SSH
 */
async function runRemoteSetup(opts: RemoteSetupOptions): Promise<void> {
  printHeader('Remote Setup');
  console.log('');
  console.log(chalk.cyan('Target:'), `${opts.user}@${opts.host}:${opts.port}`);
  console.log('');
  
  // Test connection
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
  
  // Detect architecture
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
  
  // Download dockflow binary
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
  
  // Run setup on remote
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
  
  // Cleanup
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

// ============================================
// Dockflow repository management
// ============================================

/**
 * Clone or update the dockflow repository
 */
async function ensureDockflowRepo(): Promise<string> {
  const spinner = ora('Setting up Dockflow framework...').start();

  try {
    // Check if directory exists
    if (fs.existsSync(DOCKFLOW_DIR)) {
      // Check if it's a git repo
      const gitDir = path.join(DOCKFLOW_DIR, '.git');
      if (fs.existsSync(gitDir)) {
        spinner.text = 'Updating Dockflow framework...';
        
        // Pull latest changes
        const pullResult = spawnSync('git', ['pull', '--ff-only'], {
          cwd: DOCKFLOW_DIR,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (pullResult.status === 0) {
          spinner.succeed('Dockflow framework updated');
        } else {
          // Pull failed, maybe local changes - try to continue anyway
          spinner.warn('Could not update Dockflow (using existing version)');
        }
      } else {
        // Directory exists but not a git repo - remove and clone
        spinner.text = 'Reinitializing Dockflow framework...';
        fs.rmSync(DOCKFLOW_DIR, { recursive: true, force: true });
        
        const cloneResult = spawnSync('git', ['clone', DOCKFLOW_REPO, DOCKFLOW_DIR], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (cloneResult.status !== 0) {
          spinner.fail(`Failed to clone: ${cloneResult.stderr}`);
          throw new Error('Clone failed');
        }
        spinner.succeed('Dockflow framework installed');
      }
    } else {
      // Clone fresh
      spinner.text = 'Cloning Dockflow framework...';
      
      // Ensure parent directory exists
      const parentDir = path.dirname(DOCKFLOW_DIR);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const cloneResult = spawnSync('git', ['clone', DOCKFLOW_REPO, DOCKFLOW_DIR], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (cloneResult.status !== 0) {
        spinner.fail(`Failed to clone: ${cloneResult.stderr}`);
        throw new Error('Clone failed');
      }
      spinner.succeed('Dockflow framework installed');
    }

    // Verify ansible directory exists
    const ansibleDir = path.join(DOCKFLOW_DIR, 'ansible');
    if (!fs.existsSync(path.join(ansibleDir, 'configure_host.yml'))) {
      throw new Error('ansible/configure_host.yml not found in repository');
    }

    return ansibleDir;
  } catch (error: any) {
    spinner.fail(`Failed to setup Dockflow: ${error.message}`);
    throw error;
  }
}

/**
 * Install required Ansible roles
 */
async function installAnsibleRoles(cwd: string): Promise<boolean> {
  const spinner = ora('Installing Ansible roles...').start();

  return new Promise((resolve) => {
    const proc = spawn('ansible-galaxy', ['role', 'install', 'geerlingguy.docker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd
    });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        spinner.succeed('Ansible roles installed');
        resolve(true);
      } else {
        spinner.warn('Could not install Ansible roles (may already exist)');
        resolve(true); // Continue anyway
      }
    });

    proc.on('error', () => {
      spinner.warn('ansible-galaxy not available, skipping role install');
      resolve(true);
    });
  });
}

/**
 * Run Ansible playbook for host configuration
 */
async function runAnsiblePlaybook(config: HostConfig, ansibleDir: string): Promise<boolean> {
  const spinner = ora('Running Ansible playbook...').start();

  if (!ansibleDir) {
    spinner.fail('Cannot find ansible/configure_host.yml');
    console.log('');
    printInfo('The Ansible playbooks are required for setup.');
    printInfo('Please ensure the dockflow ansible directory is available.');
    console.log('');
    console.log(chalk.cyan('Options:'));
    console.log('  1. Clone the dockflow repository and run from there');
    console.log('  2. Copy the ansible/ directory next to the binary');
    console.log('  3. Install to /opt/dockflow/ansible');
    console.log('');
    console.log(chalk.gray('Example:'));
    console.log(chalk.gray('  git clone https://github.com/Shawiizz/dockflow.git'));
    console.log(chalk.gray('  cd dockflow'));
    console.log(chalk.gray('  ./dockflow-linux-x64 setup'));
    return false;
  }

  printInfo(`Using Ansible directory: ${ansibleDir}`);

  // Build skip tags
  const skipTags = ['deploy'];
  if (!config.portainer.install) {
    skipTags.push('portainer', 'nginx');
  }

  // Build extra vars
  const extraVars: string[] = [
    `ansible_python_interpreter=/usr/bin/python3`,
    `skip_docker_install=${config.skipDockerInstall}`
  ];

  if (config.deployPassword) {
    extraVars.push(`ansible_become_password=${config.deployPassword}`);
  }

  if (config.portainer.install) {
    extraVars.push(`portainer_install=true`);
    extraVars.push(`portainer_http_port=${config.portainer.port}`);
    if (config.portainer.password) {
      extraVars.push(`portainer_password=${config.portainer.password}`);
    }
    if (config.portainer.domain) {
      extraVars.push(`portainer_domain_name=${config.portainer.domain}`);
    }
  }

  spinner.stop();
  printInfo('Executing Ansible playbook...');
  console.log('');

  return new Promise((resolve) => {
    const args = [
      'ansible/configure_host.yml',
      '-i', 'localhost,',
      '-c', 'local',
      '--skip-tags', skipTags.join(','),
      '--extra-vars', extraVars.join(' ')
    ];

    const proc = spawn('ansible-playbook', args, {
      stdio: 'inherit',
      cwd: path.dirname(ansibleDir!),
      env: {
        ...process.env,
        ANSIBLE_HOST_KEY_CHECKING: 'False',
        ANSIBLE_CONFIG: path.join(path.dirname(ansibleDir!), 'ansible.cfg')
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('');
        printSuccess('Ansible playbook completed successfully');
        resolve(true);
      } else {
        console.log('');
        printError(`Ansible playbook failed with code ${code}`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      printError(`Failed to run Ansible: ${err.message}`);
      resolve(false);
    });
  });
}

// ============================================
// Interactive setup flow
// ============================================

/**
 * Run interactive setup wizard
 */
async function runInteractiveSetup(): Promise<void> {
  printHeader('Machine Setup Wizard');
  console.log('');

  // Check dependencies first
  displayDependencyStatus();

  const deps = checkDependencies();
  if (!deps.ok) {
    printError('Missing required dependencies:');
    deps.missing.forEach(m => console.log(chalk.red(`  - ${m}`)));
    console.log('');
    printInfo('Please install the missing dependencies and try again.');
    process.exit(1);
  }

  printSuccess('All dependencies satisfied');
  console.log('');

  // Detect defaults
  const detectedIP = detectPublicIP();
  const detectedPort = detectSSHPort();
  const currentUser = getCurrentUser();

  // Prompt for configuration
  printSection('Server Configuration');

  const publicHost = await prompt('Public IP/Hostname (for connection string)', detectedIP);
  const sshPortStr = await prompt('SSH Port', detectedPort.toString());
  const sshPort = parseInt(sshPortStr, 10) || 22;

  console.log('');
  printSection('Deployment User');

  // Ask what they want to do
  const userChoice = await selectMenu('What would you like to do?', [
    'Create a new deployment user',
    'Use an existing user (configure SSH key)',
    'Display connection string for existing setup'
  ]);

  let deployUser: string;
  let deployPassword: string | undefined;
  let privateKeyPath: string;
  let needsUserSetup = false;

  if (userChoice === 0) {
    // Create new user
    deployUser = await prompt('New username', 'dockflow');
    
    // Check if user already exists
    const userExists = spawnSync('id', [deployUser], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (userExists.status === 0) {
      printWarning(`User '${deployUser}' already exists on this system.`);
      const continueAnyway = await confirm('Continue with this user anyway?', true);
      if (!continueAnyway) {
        process.exit(0);
      }
      // User exists, no need to create
      needsUserSetup = false;
    } else {
      deployPassword = await promptPassword('Password for new user');
      needsUserSetup = true;
    }

    // Generate SSH key for the user
    const keyPath = path.join(os.homedir(), '.ssh', `${deployUser}_key`);
    printInfo(`Generating SSH key at ${keyPath}...`);

    const keyResult = generateSSHKey(keyPath, `dockflow-${deployUser}`);
    if (keyResult.success) {
      printSuccess('SSH key generated');
      privateKeyPath = keyPath;
    } else {
      printError(`Failed to generate SSH key: ${keyResult.error}`);
      process.exit(1);
    }
  } else if (userChoice === 1) {
    // Use existing user
    deployUser = await prompt('Existing username', currentUser);

    // SSH key selection - look in the selected user's .ssh directory
    const existingKeys = listSSHKeys(deployUser);
    const userHome = deployUser === 'root' ? '/root' : `/home/${deployUser}`;
    const defaultKeyPath = path.join(userHome, '.ssh', 'dockflow_key');

    if (existingKeys.length > 0) {
      console.log('');
      const keyChoice = await selectMenu('SSH Key Selection:', [
        'Generate new SSH key',
        'Use existing SSH key',
      ]);

      if (keyChoice === 1) {
        console.log('');
        console.log(chalk.cyan('Available keys:'));
        existingKeys.forEach((k, i) => console.log(`  ${i + 1}) ${k}`));
        const keyIdxStr = await prompt('Select key number', '1');
        const keyIdx = parseInt(keyIdxStr, 10) - 1;
        privateKeyPath = existingKeys[keyIdx] || existingKeys[0];
      } else {
        privateKeyPath = defaultKeyPath;
        printInfo(`Generating SSH key at ${privateKeyPath}...`);

        const keyResult = generateSSHKey(privateKeyPath, `dockflow-${currentUser}`);
        if (keyResult.success) {
          printSuccess('SSH key generated');
          addToAuthorizedKeys(`${privateKeyPath}.pub`);
          printSuccess('Key added to authorized_keys');
        } else {
          printError(`Failed to generate SSH key: ${keyResult.error}`);
          process.exit(1);
        }
      }
    } else {
      privateKeyPath = defaultKeyPath;
      printInfo(`Generating SSH key at ${privateKeyPath}...`);

      const keyResult = generateSSHKey(privateKeyPath, `dockflow-${currentUser}`);
      if (keyResult.success) {
        printSuccess('SSH key generated');
        addToAuthorizedKeys(`${privateKeyPath}.pub`);
        printSuccess('Key added to authorized_keys');
      } else {
        printError(`Failed to generate SSH key: ${keyResult.error}`);
        process.exit(1);
      }
    }

    // Ask for sudo password if needed
    if (await confirm('Does the user require a password for sudo?', false)) {
      deployPassword = await promptAndValidateUserPassword(deployUser);
    }
  } else {
    // Just display connection string for existing setup
    console.log('');
    deployUser = await prompt('Deployment username', 'dockflow');
    
    // Look for keys in the selected user's .ssh directory
    const existingKeys = listSSHKeys(deployUser);
    const userHome = deployUser === 'root' ? '/root' : `/home/${deployUser}`;
    if (existingKeys.length === 0) {
      printError(`No SSH keys found in ${userHome}/.ssh/`);
      process.exit(1);
    }
    
    console.log('');
    console.log(chalk.cyan('Available keys:'));
    existingKeys.forEach((k, i) => console.log(`  ${i + 1}) ${k}`));
    const keyIdxStr = await prompt('Select key number', '1');
    const keyIdx = parseInt(keyIdxStr, 10) - 1;
    privateKeyPath = existingKeys[keyIdx] || existingKeys[0];
    
    // Just show connection info and exit
    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo({
      publicHost,
      sshPort,
      deployUser,
      privateKeyPath,
      skipDockerInstall: false,
      portainer: { install: false, port: 9000 }
    }, privateKey);
    
    // Exit cleanly
    process.exit(0);
  }

  // Portainer configuration
  console.log('');
  printSection('Optional Services');

  let portainerConfig = {
    install: false,
    port: 9000,
    password: undefined as string | undefined,
    domain: undefined as string | undefined
  };

  if (await confirm('Install Portainer (container management UI)?', false)) {
    portainerConfig.install = true;
    portainerConfig.password = await promptPassword('Portainer admin password');
    const portStr = await prompt('Portainer HTTP port', '9000');
    portainerConfig.port = parseInt(portStr, 10) || 9000;
    const domain = await prompt('Portainer domain (optional, press Enter to skip)', '');
    if (domain) {
      portainerConfig.domain = domain;
    }
  }

  // Configuration summary
  console.log('');
  printHeader('Configuration Summary');
  console.log('');
  console.log(`${chalk.cyan('Target:')} Local Machine`);
  console.log(`${chalk.cyan('Public Host:')} ${publicHost}`);
  console.log(`${chalk.cyan('SSH Port:')} ${sshPort}`);
  console.log(`${chalk.cyan('Deployment User:')} ${deployUser}`);
  console.log(`${chalk.cyan('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  console.log(`${chalk.cyan('Install Portainer:')} ${portainerConfig.install ? 'Yes' : 'No'}`);
  if (portainerConfig.install) {
    console.log(`${chalk.cyan('Portainer Port:')} ${portainerConfig.port}`);
    if (portainerConfig.domain) {
      console.log(`${chalk.cyan('Portainer Domain:')} ${portainerConfig.domain}`);
    }
  }
  console.log('');

  if (!await confirm('Proceed with this configuration?', true)) {
    printWarning('Setup cancelled');
    process.exit(0);
  }

  // Clone/update dockflow repository
  console.log('');
  let ansibleDir: string;
  try {
    ansibleDir = await ensureDockflowRepo();
  } catch (error) {
    printError('Cannot proceed without the Dockflow framework');
    process.exit(1);
  }

  // Create user if needed
  if (needsUserSetup && deployPassword) {
    console.log('');
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      printError('Failed to create deployment user');
      process.exit(1);
    }
  }

  // Install Ansible roles
  console.log('');
  await installAnsibleRoles(DOCKFLOW_DIR);

  // Run Ansible playbook
  console.log('');
  const config: HostConfig = {
    publicHost,
    sshPort,
    deployUser,
    deployPassword,
    privateKeyPath,
    skipDockerInstall: false,
    portainer: portainerConfig
  };

  const success = await runAnsiblePlaybook(config, ansibleDir);

  if (success) {
    // Display completion
    console.log('');
    printHeader('Setup Complete');
    console.log('');
    printSuccess('The machine has been successfully configured!');

    // Display connection info
    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo(config, privateKey);
    
    // Exit cleanly
    process.exit(0);
  } else {
    printError('Setup failed. Please check the errors above.');
    process.exit(1);
  }
}

// ============================================
// Non-interactive setup flow
// ============================================

/**
 * Run non-interactive setup
 */
async function runNonInteractiveSetup(options: SetupOptions): Promise<void> {
  printHeader('Machine Setup (Non-Interactive)');
  console.log('');

  // Check dependencies first
  const deps = checkDependencies();
  if (!deps.ok) {
    printError('Missing required dependencies:');
    deps.missing.forEach(m => console.log(chalk.red(`  - ${m}`)));
    process.exit(1);
  }

  // Use provided values or detect defaults
  const publicHost = options.host || detectPublicIP();
  const sshPort = parseInt(options.port || detectSSHPort().toString(), 10);
  const currentUser = getCurrentUser();

  let deployUser: string;
  let deployPassword: string | undefined;
  let privateKeyPath: string;
  let needsUserSetup = false;

  // User configuration
  if (options.user && options.user !== currentUser) {
    // Creating a new user
    deployUser = options.user;
    deployPassword = options.password;
    needsUserSetup = true;

    // Generate or use provided key
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
    // Using current user
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

  // Display configuration
  printSection('Configuration');
  console.log(`${chalk.cyan('Public Host:')} ${publicHost}`);
  console.log(`${chalk.cyan('SSH Port:')} ${sshPort}`);
  console.log(`${chalk.cyan('Deployment User:')} ${deployUser}`);
  console.log(`${chalk.cyan('Create New User:')} ${needsUserSetup ? 'Yes' : 'No'}`);
  console.log(`${chalk.cyan('Skip Docker Install:')} ${options.skipDockerInstall ? 'Yes' : 'No'}`);
  console.log(`${chalk.cyan('Install Portainer:')} ${options.portainer ? 'Yes' : 'No'}`);
  console.log('');

  // Clone/update dockflow repository
  let ansibleDir: string;
  try {
    ansibleDir = await ensureDockflowRepo();
  } catch (error) {
    printError('Cannot proceed without the Dockflow framework');
    process.exit(1);
  }

  // Create user if needed
  if (needsUserSetup && deployPassword) {
    const pubKey = fs.readFileSync(`${privateKeyPath}.pub`, 'utf-8').trim();
    if (!createDeployUser(deployUser, deployPassword, pubKey)) {
      printError('Failed to create deployment user');
      process.exit(1);
    }
  }

  // Install Ansible roles
  await installAnsibleRoles(DOCKFLOW_DIR);

  // Build config
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

  // Run Ansible
  console.log('');
  const success = await runAnsiblePlaybook(config, ansibleDir);

  if (success) {
    console.log('');
    printHeader('Setup Complete');
    printSuccess('The machine has been successfully configured!');

    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    displayConnectionInfo(config, privateKey);
    
    // Exit cleanly
    process.exit(0);
  } else {
    printError('Setup failed');
    process.exit(1);
  }
}

// ============================================
// Command registration
// ============================================

/**
 * Register setup commands
 */
export function registerSetupCommand(program: Command): void {
  const setup = program
    .command('setup')
    .description('Setup host machine for deployment');

  // Interactive mode (default)
  setup
    .command('interactive', { isDefault: true })
    .description('Run interactive setup wizard')
    .action(async () => {
      if (!isLinux()) {
        // Not on Linux - offer remote setup
        printHeader('Remote Setup');
        console.log('');
        printInfo('You are not running on a Linux host.');
        printInfo('Dockflow can connect to your remote server via SSH and run the setup there.');
        console.log('');
        
        const remoteOpts = await promptRemoteConnection();
        if (!remoteOpts) {
          process.exit(0);
        }
        
        await runRemoteSetup(remoteOpts);
        process.exit(0);
      }

      await runInteractiveSetup();
    });

  // Remote mode - explicit remote setup from any platform
  setup
    .command('remote')
    .description('Run setup on a remote Linux server via SSH')
    .option('--host <host>', 'Remote server IP or hostname')
    .option('--port <port>', 'SSH port', '22')
    .option('--user <user>', 'SSH username')
    .option('--password <password>', 'SSH password')
    .option('--key <path>', 'Path to SSH private key')
    .option('--connection <string>', 'Dockflow connection string')
    .action(async (options: { host?: string; port?: string; user?: string; password?: string; key?: string; connection?: string }) => {
      let remoteOpts: RemoteSetupOptions | null = null;
      
      if (options.connection) {
        // Use connection string
        const conn = parseConnectionString(options.connection);
        if (!conn) {
          printError('Invalid connection string');
          process.exit(1);
        }
        remoteOpts = {
          host: conn.host,
          port: conn.port || 22,
          user: conn.user,
          privateKey: conn.privateKey,
          password: conn.password
        };
      } else if (options.host && options.user) {
        // Use provided options
        let privateKey: string | undefined;
        if (options.key) {
          if (!fs.existsSync(options.key)) {
            printError(`SSH key file not found: ${options.key}`);
            process.exit(1);
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
        // Interactive mode
        remoteOpts = await promptRemoteConnection();
      }
      
      if (!remoteOpts) {
        process.exit(0);
      }
      
      await runRemoteSetup(remoteOpts);
      process.exit(0);
    });

  // Non-interactive mode
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
    .action(async (options: SetupOptions) => {
      if (!isLinux()) {
        printError('The "auto" command must be run directly on the target Linux host.');
        printInfo('Use "dockflow setup remote" to run setup on a remote server via SSH.');
        process.exit(1);
      }

      await runNonInteractiveSetup(options);
    });

  // Check dependencies only
  setup
    .command('check')
    .description('Check if all dependencies are installed')
    .action(() => {
      printHeader('Dependency Check');
      console.log('');

      if (!isLinux()) {
        printWarning('Not running on Linux - some checks may not be accurate');
        console.log('');
      }

      displayDependencyStatus();

      const deps = checkDependencies();
      if (deps.ok) {
        printSuccess('All required dependencies are installed');
      } else {
        printError('Missing dependencies:');
        deps.missing.forEach(m => console.log(chalk.red(`  - ${m}`)));
        process.exit(1);
      }
    });

  // Show connection info for existing setup
  setup
    .command('connection')
    .description('Display connection string for existing deployment user')
    .option('--host <host>', 'Server IP/hostname')
    .option('--port <port>', 'SSH port', '22')
    .option('--user <user>', 'Deployment username')
    .option('--key <path>', 'Path to SSH private key')
    .action(async (options: { host?: string; port?: string; user?: string; key?: string }) => {
      let host = options.host;
      let port = parseInt(options.port || '22', 10);
      let user = options.user;
      let keyPath = options.key;

      // Interactive if options missing
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
          console.log('');
          console.log(chalk.cyan('Available keys:'));
          keys.forEach((k, i) => console.log(`  ${i + 1}) ${k}`));
          const keyIdxStr = await prompt('Select key number', '1');
          const keyIdx = parseInt(keyIdxStr, 10) - 1;
          keyPath = keys[keyIdx] || keys[0];
        } else {
          keyPath = await prompt('Path to SSH private key');
        }
      }

      if (!fs.existsSync(keyPath)) {
        printError(`SSH key not found: ${keyPath}`);
        process.exit(1);
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
    });
}
