/**
 * Docker Runner Utilities
 * Shared logic for running Ansible playbooks in Docker containers
 */

import ora from 'ora';
import { existsSync, readdirSync } from 'fs';
import { join, dirname, parse as parsePath } from 'path';
import { getProjectRoot, loadConfig, loadServersConfig, isDockerAvailable, getAnsibleDockerImage } from './config';
import { printSuccess, printDim, printBlank } from './output';
import { DOCKFLOW_REPO, DOCKFLOW_VERSION, CONTAINER_PATHS } from '../constants';
import { isCI } from './secrets';
import { CLIError, ConfigError, DockerError } from './errors';

/**
 * Options for running a command in the Ansible Docker container
 */
export interface RunCommandOptions {
  command: string[];
  actionName: string;
  successMessage: string;
  contextFilePath?: string;
}

/**
 * Find the dockflow framework root by walking up from a starting directory.
 * The framework root is identified by the presence of ansible/deploy.yml.
 */
function findDockflowRoot(startDir: string): string | null {
  let dir = startDir;
  const { root } = parsePath(dir);
  while (dir !== root) {
    if (existsSync(join(dir, 'ansible', 'deploy.yml'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Detect if dockflow framework is available locally (auto dev mode).
 */
function detectLocalDockflow(projectRoot: string): string | null {
  return findDockflowRoot(projectRoot) || process.env.DOCKFLOW_DEV_PATH || null;
}

export function buildDockerCommand(contextFilePath?: string): string[] {
  const projectRoot = getProjectRoot();
  const dockerImage = getAnsibleDockerImage();
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  const mountMode = isCI() ? '' : ':ro';

  const dockerCmd = [
    'docker', 'run', '--rm',
    '--pull', 'always',
    ...(isTTY ? ['-it'] : []),
    '-v', `${projectRoot}:${CONTAINER_PATHS.PROJECT}${mountMode}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
  ];

  if (contextFilePath) {
    dockerCmd.push('-v', `${contextFilePath}:${CONTAINER_PATHS.CONTEXT}:ro`);
  }

  const dockerNetwork = process.env.DOCKFLOW_DOCKER_NETWORK;
  if (dockerNetwork) {
    dockerCmd.push('--network', dockerNetwork);
  }

  const dockflowRoot = detectLocalDockflow(projectRoot);
  if (dockflowRoot) {
    dockerCmd.push('-v', `${dockflowRoot}:${CONTAINER_PATHS.DOCKFLOW}`);
    printDim(`Using local dockflow: ${dockflowRoot}`);
  }

  dockerCmd.push('-e', `DOCKFLOW_PATH=${CONTAINER_PATHS.DOCKFLOW}`);
  dockerCmd.push('-e', 'ANSIBLE_HOST_KEY_CHECKING=False');
  dockerCmd.push('-e', 'PYTHONUNBUFFERED=1');
  dockerCmd.push(dockerImage);

  return dockerCmd;
}

/**
 * Execute a command directly in the Ansible Docker container
 * The entrypoint.sh handles workspace setup, we just need to clone dockflow if not in dev mode
 */
export async function runAnsibleCommand(options: RunCommandOptions): Promise<void> {
  const { command, actionName, successMessage, contextFilePath } = options;

  const projectRoot = getProjectRoot();
  const isLocal = !!detectLocalDockflow(projectRoot);
  const dockerCmd = buildDockerCommand(contextFilePath);

  const chmodInventory = `chmod +x ${CONTAINER_PATHS.DOCKFLOW}/ansible/inventory.py 2>/dev/null || true`;

  // Setup writable workspace (copy .dockflow + symlinks) - only needed locally
  // where /project is mounted read-only. In CI, /project is read-write so no setup needed.
  const setupWorkspace = isCI() ? '' : `
if [ -f "${CONTAINER_PATHS.DOCKFLOW}/.common/scripts/setup_workspace.sh" ] && [ -d "/project/.dockflow" ]; then
  source "${CONTAINER_PATHS.DOCKFLOW}/.common/scripts/setup_workspace.sh"
fi`;

  const cloneStep = isLocal
    ? `${chmodInventory}
${setupWorkspace}`
    : `
echo "Cloning dockflow framework v${DOCKFLOW_VERSION}..."
if ! git clone --depth 1 --branch "${DOCKFLOW_VERSION}" "${DOCKFLOW_REPO}" ${CONTAINER_PATHS.DOCKFLOW} 2>/dev/null; then
  echo "ERROR: Failed to clone dockflow framework (tag '${DOCKFLOW_VERSION}')"
  exit 1
fi
chmod +x ${CONTAINER_PATHS.DOCKFLOW}/.common/scripts/*.sh 2>/dev/null || true
${chmodInventory}
${setupWorkspace}`;

  const fullScript = `
set -e
${cloneStep}
cd ${CONTAINER_PATHS.DOCKFLOW}
${command.map(c => `"${c}"`).join(' ')}
`;

  dockerCmd.push('bash', '-c', fullScript);

  printDim(`Starting ${actionName} container...`);
  printBlank();

  const spinner = ora(`Starting ${actionName}...`).start();

  try {
    const proc = Bun.spawn(dockerCmd, {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });

    spinner.stop();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      printBlank();
      printSuccess(successMessage);
    } else {
      printBlank();
      throw new DockerError(`${actionName.charAt(0).toUpperCase() + actionName.slice(1)} failed with exit code ${exitCode}`);
    }
  } catch (error) {
    spinner.fail(`${actionName.charAt(0).toUpperCase() + actionName.slice(1)} failed`);
    if (error instanceof CLIError) {
      throw error;
    }
    throw new DockerError(`${error}`);
  }
}

/**
 * Check Docker availability with spinner feedback
 */
export async function checkDockerAvailable(): Promise<void> {
  const spinner = ora('Checking Docker availability...').start();
  const dockerAvailable = await isDockerAvailable();

  if (!dockerAvailable) {
    spinner.fail('Docker is not available');
    printBlank();
    throw new DockerError(
      'Docker is required',
      { suggestion: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop\nOn Windows, make sure Docker Desktop is running.\nOn Linux, install Docker with: curl -fsSL https://get.docker.com | sh' }
    );
  }
  spinner.succeed('Docker is available');
}

/**
 * Validate project has required configuration
 * @throws ConfigError if config is not found
 * @returns The loaded config (never null)
 */
export function validateProjectConfig(): NonNullable<ReturnType<typeof loadConfig>> {
  const config = loadConfig();
  if (!config) {
    throw new ConfigError(
      '.dockflow/config.yml not found',
      'Run "dockflow init" to create project structure'
    );
  }
  return config;
}

/**
 * Validate servers.yml exists and is valid
 * @throws ConfigError if servers.yml is not found or validation fails
 * @returns The loaded servers config (never null)
 */
export function validateServersYaml(): NonNullable<ReturnType<typeof loadServersConfig>> {
  const config = loadServersConfig();
  if (!config) {
    throw new ConfigError(
      '.dockflow/servers.yml not found or invalid',
      'Run "dockflow config validate" for detailed validation'
    );
  }
  return config;
}

/**
 * Options for building Ansible deploy command
 */
export interface DeployCommandOptions {
  /** Skip tags (e.g., ['configure_host', 'nginx']) */
  skipTags?: string[];
}

/**
 * Build the ansible-playbook command for deployment
 */
export function buildDeployAnsibleCommand(options: DeployCommandOptions = {}): string[] {
  const cmd = [
    'ansible-playbook', 'ansible/deploy.yml',
    '-i', 'ansible/inventory.py',
    '-e', `@${CONTAINER_PATHS.CONTEXT}`,
  ];

  // Add skip tags
  const skipTags = options.skipTags || ['configure_host'];
  if (skipTags.length > 0) {
    cmd.push('--skip-tags', skipTags.join(','));
  }

  return cmd;
}

/**
 * Options for building Ansible build command
 */
export interface BuildCommandOptions {
  // Future options can be added here
}

/**
 * Build the ansible-playbook command for building images
 */
export function buildBuildAnsibleCommand(_options: BuildCommandOptions = {}): string[] {
  const cmd = [
    'ansible-playbook', 'ansible/playbooks/build_images.yml',
    '-e', `@${CONTAINER_PATHS.CONTEXT}`,
  ];

  return cmd;
}

/**
 * Check if nginx configuration exists in the project
 */
export function hasNginxConfig(): boolean {
  const projectRoot = getProjectRoot();
  const nginxPath = join(projectRoot, '.dockflow', 'templates', 'nginx');
  
  if (!existsSync(nginxPath)) {
    return false;
  }
  
  // Check if directory has files
  try {
    const files = readdirSync(nginxPath);
    return files.length > 0;
  } catch {
    return false;
  }
}
