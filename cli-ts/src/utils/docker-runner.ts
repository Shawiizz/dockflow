/**
 * Docker Runner Utilities
 * Shared logic for running Ansible playbooks in Docker containers
 */

import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProjectRoot, loadConfig, isDockerAvailable, getAnsibleDockerImage } from './config';
import { printSuccess } from './output';
import { DOCKFLOW_REPO, DOCKFLOW_VERSION } from '../constants';
import { CLIError, ConfigError, DockerError } from './errors';

/**
 * Find the dockflow repository root for dev mode
 * Requires DOCKFLOW_DEV_PATH environment variable to be set
 */
export function findDockflowRoot(): string | null {
  const devPath = process.env.DOCKFLOW_DEV_PATH;
  if (devPath && existsSync(join(devPath, '.common', 'scripts', 'run_ansible.sh'))) {
    return devPath;
  }
  return null;
}

/**
 * Options for generating the dockflow setup script
 */
export interface DockflowSetupOptions {
  /** Whether to use dev mode (local dockflow) */
  devMode: boolean;
  /** File to check exists after clone (for validation) */
  checkFile?: string;
}

/**
 * Generate the shell script portion that clones/sets up dockflow framework
 */
export function getDockflowSetupScript(options: DockflowSetupOptions): string {
  const { devMode, checkFile = '.common/scripts/run_ansible.sh' } = options;

  if (devMode) {
    return `
# Dev mode: using local dockflow mounted at /tmp/dockflow
echo "Using local dockflow framework (dev mode)..."
chmod +x /tmp/dockflow/.common/scripts/*.sh 2>/dev/null || true
export DOCKFLOW_PATH="/tmp/dockflow"
`;
  }

  return `
# Clone dockflow framework
echo "Cloning dockflow framework v${DOCKFLOW_VERSION}..."
if ! git clone --depth 1 --branch "${DOCKFLOW_VERSION}" "${DOCKFLOW_REPO}" /tmp/dockflow 2>/dev/null; then
  echo ""
  echo "ERROR: Failed to clone dockflow framework."
  echo "  - Tag '${DOCKFLOW_VERSION}' may not exist on the remote repository"
  echo "  - Check your internet connection"
  echo "  - Repository: ${DOCKFLOW_REPO}"
  echo ""
  echo "For local development, use: --dev flag with DOCKFLOW_DEV_PATH environment variable"
  exit 1
fi

if [ ! -f /tmp/dockflow/${checkFile} ]; then
  echo ""
  echo "ERROR: Dockflow framework is missing required files."
  echo "  - File not found: ${checkFile}"
  echo "  - The cloned version may be incompatible or corrupted"
  echo ""
  exit 1
fi

chmod +x /tmp/dockflow/.common/scripts/*.sh 2>/dev/null || true
export DOCKFLOW_PATH="/tmp/dockflow"
`;
}

/**
 * Generate the shell script portion that prepares environment for Ansible
 */
export function getEnvPrepScript(): string {
  return `
# Convert Windows line endings in .deployment files
if [ -d "$ROOT_PATH/.deployment" ]; then
  find "$ROOT_PATH/.deployment" -type f -exec sed -i 's/\\r$//' {} \\; 2>/dev/null || true
fi

# Export environment variables to YAML for Ansible
echo "Exporting environment variables to /tmp/ansible_env_vars.yml..."
python3 <<'PYTHON_EOF'
import os, yaml
env_vars = {k.lower(): v for k, v in os.environ.items() if k}
with open('/tmp/ansible_env_vars.yml', 'w') as f:
    yaml.dump(env_vars, f, default_flow_style=False, allow_unicode=True)
PYTHON_EOF
`;
}

/**
 * Options for running a script in the Ansible Docker container
 */
export interface RunInContainerOptions {
  /** The shell script to execute */
  script: string;
  /** Whether to use dev mode (mount local dockflow) */
  devMode?: boolean;
  /** Action name for logs (e.g., "build", "deployment") */
  actionName: string;
  /** Success message to display */
  successMessage: string;
}

/**
 * Build Docker command arguments for running the Ansible container
 */
export function buildDockerCommand(devMode: boolean = false): string[] {
  const projectRoot = getProjectRoot();
  const dockerImage = getAnsibleDockerImage();
  
  // Check if we have a TTY available (not in CI)
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  
  const dockerCmd = [
    'docker', 'run', '--rm',
    ...(isTTY ? ['-it'] : []),
    '-v', `${projectRoot}:/project`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
  ];

  // Allow connecting to a specific Docker network (useful for e2e tests)
  const dockerNetwork = process.env.DOCKFLOW_DOCKER_NETWORK;
  if (dockerNetwork) {
    dockerCmd.push('--network', dockerNetwork);
  }

  // In dev mode, mount the local dockflow repository
  if (devMode) {
    const dockflowRoot = process.env.DOCKFLOW_DEV_PATH || findDockflowRoot();
    if (dockflowRoot) {
      dockerCmd.push('-v', `${dockflowRoot}:/tmp/dockflow`);
      console.log(chalk.yellow(`Dev mode: mounting ${dockflowRoot} as /tmp/dockflow`));
    } else {
      throw new ConfigError(
        'Dev mode: Could not find dockflow root',
        'Set DOCKFLOW_DEV_PATH environment variable'
      );
    }
  }

  dockerCmd.push(dockerImage);
  
  return dockerCmd;
}

/**
 * Execute a script in the Ansible Docker container
 */
export async function runInAnsibleContainer(options: RunInContainerOptions): Promise<void> {
  const { script, devMode = false, actionName, successMessage } = options;
  
  const dockerCmd = buildDockerCommand(devMode);
  dockerCmd.push('bash', '-c', script);

  console.log(chalk.dim(`Starting ${actionName} container...`));
  console.log('');

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
      console.log('');
      printSuccess(successMessage);
    } else {
      console.log('');
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
    console.log('');
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
      '.deployment/config.yml not found',
      'Run "dockflow init" to create project structure'
    );
  }
  return config;
}
