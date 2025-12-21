/**
 * Deploy command
 * Uses Docker to run Ansible playbooks
 * 
 * Architecture: Docker Swarm deployment
 * - Deploy targets only the manager node
 * - Images are distributed to all nodes (via registry or docker save/load)
 * - Swarm handles workload distribution automatically
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProjectRoot, loadConfig, isDockerAvailable, getAnsibleDockerImage, hasServersConfig } from '../utils/config';
import { printError, printSuccess, printInfo, printHeader, printWarning } from '../utils/output';
import { 
  resolveDeploymentForEnvironment,
  getServerPrivateKey, 
  getServerPassword,
  getAvailableEnvironments,
  getAllServersForEnvironment,
  findActiveManager,
  getManagerCount
} from '../utils/servers';
import { loadSecrets } from '../utils/secrets';
import { getCurrentBranch } from '../utils/git';
import { getLatestVersion, incrementVersion } from '../utils/version';
import { DOCKFLOW_REPO, DOCKFLOW_VERSION } from '../constants';
import type { ResolvedServer, ResolvedDeployment } from '../types';

/**
 * Find the dockflow repository root for dev mode
 * Requires DOCKFLOW_DEV_PATH environment variable to be set
 */
function findDockflowRoot(): string | null {
  const devPath = process.env.DOCKFLOW_DEV_PATH;
  if (devPath && existsSync(join(devPath, '.common', 'scripts', 'run_ansible.sh'))) {
    return devPath;
  }
  return null;
}

interface DeployOptions {
  services?: string;
  skipBuild?: boolean;
  force?: boolean;
  debug?: boolean;
  dev?: boolean;
  accessories?: boolean;
  all?: boolean;
  skipAccessories?: boolean;
  skipDockerInstall?: boolean;
  noFailover?: boolean;
}

/**
 * Determine what to deploy based on options
 * 
 * New behavior with hash-based detection:
 * - Accessories are ALWAYS checked (hash comparison)
 * - --accessories: force redeploy accessories only (skip app)
 * - --all: force redeploy both app and accessories
 * - --skip-accessories: completely skip accessories check
 * - default: deploy app + auto-check accessories (deploy if changed)
 */
function getDeploymentTargets(options: DeployOptions): { 
  deployApp: boolean; 
  forceAccessories: boolean;
  skipAccessories: boolean;
} {
  if (options.skipAccessories) {
    return { deployApp: true, forceAccessories: false, skipAccessories: true };
  }
  if (options.all) {
    return { deployApp: true, forceAccessories: true, skipAccessories: false };
  }
  if (options.accessories) {
    return { deployApp: false, forceAccessories: true, skipAccessories: false };
  }
  // Default: deploy app + auto-check accessories (hash-based)
  return { deployApp: true, forceAccessories: false, skipAccessories: false };
}

/**
 * Build environment exports string from resolved server environment
 */
function buildEnvExportsFromServer(env: string, server: ResolvedServer, privateKey: string, password?: string): string {
  const lines: string[] = [];
  
  // Connection info
  lines.push(`export DOCKFLOW_HOST="${server.host}"`);
  lines.push(`export DOCKFLOW_PORT="${server.port}"`);
  lines.push(`export DOCKFLOW_USER="${server.user}"`);
  
  // Private key (escape for shell)
  const escapedKey = privateKey.replace(/'/g, "'\"'\"'");
  lines.push(`export SSH_PRIVATE_KEY='${escapedKey}'`);
  
  if (password) {
    lines.push(`export DOCKFLOW_PASSWORD="${password}"`);
  }
  
  // Environment variables from servers.yml + CI overrides
  for (const [key, value] of Object.entries(server.env)) {
    // Escape double quotes and dollar signs for shell
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    lines.push(`export ${key}="${escapedValue}"`);
  }
  
  return lines.join('\n');
}

/**
 * Build the deployment script to run inside the container
 * 
 * New architecture:
 * - Deployment always targets the manager
 * - WORKERS_JSON contains worker connection info for image distribution
 * - Ansible pushes images to workers if no registry is configured
 */
function buildDeployScript(
  env: string,
  deployment: ResolvedDeployment,
  deployVersion: string,
  branchName: string,
  managerExports: string,
  workersJson: string,
  options: DeployOptions
): string {
  const { deployApp, forceAccessories, skipAccessories } = getDeploymentTargets(options);
  const manager = deployment.manager;

  // In dev mode, use the mounted local dockflow folder
  const dockflowSetup = options.dev
    ? `
# Dev mode: using local dockflow mounted at /tmp/dockflow
echo "Using local dockflow framework (dev mode)..."
chmod +x /tmp/dockflow/.common/scripts/*.sh 2>/dev/null || true
export DOCKFLOW_PATH="/tmp/dockflow"
`
    : `
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

if [ ! -f /tmp/dockflow/.common/scripts/run_ansible.sh ]; then
  echo ""
  echo "ERROR: Dockflow framework is missing required files."
  echo "  - File not found: .common/scripts/run_ansible.sh"
  echo "  - The cloned version may be incompatible or corrupted"
  echo ""
  exit 1
fi

chmod +x /tmp/dockflow/.common/scripts/*.sh
export DOCKFLOW_PATH="/tmp/dockflow"
`;

  return `
set -e

${dockflowSetup}

# Set manager connection and environment variables
${managerExports}

# Workers info for image distribution (JSON format)
export WORKERS_JSON='${workersJson}'
export WORKERS_COUNT="${deployment.workers.length}"

# Set deployment environment variables
export ENV="${env}"
export SERVER_NAME="${manager.name}"
export SERVER_ROLE="manager"
export VERSION="${deployVersion}"
export BRANCH_NAME="${branchName}"
export ROOT_PATH="/project"
export ANSIBLE_HOST_KEY_CHECKING=False
${options.skipBuild ? 'export SKIP_BUILD=true' : ''}
${options.skipDockerInstall ? 'export SKIP_DOCKER_INSTALL=true' : ''}
${options.force ? 'export FORCE_DEPLOY=true' : ''}
${options.services ? `export DEPLOY_DOCKER_SERVICES="${options.services}"` : ''}

# Deployment targets
export DEPLOY_APP="${deployApp}"
export DEPLOY_ACCESSORIES="${forceAccessories}"
${skipAccessories ? 'export SKIP_ACCESSORIES=true' : ''}

echo ""
echo "Deploying to ${env} cluster"
echo "  Manager: ${manager.name} (\$DOCKFLOW_HOST)"
echo "  Workers: ${deployment.workers.length > 0 ? deployment.workers.map(w => w.name).join(', ') : 'none'}"
echo "  App: ${deployApp} | Accessories: ${skipAccessories ? 'skipped' : (forceAccessories ? 'forced' : 'auto')}"
echo ""

# Run Ansible deployment
cd \$DOCKFLOW_PATH
bash .common/scripts/run_ansible.sh
`;
}

/**
 * Execute deployment in Docker container
 */
async function executeDeployment(
  projectRoot: string,
  dockerImage: string,
  deployScript: string,
  env: string,
  devMode: boolean = false
): Promise<void> {
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
      console.log(chalk.red('Dev mode: Could not find dockflow root. Set DOCKFLOW_DEV_PATH env var.'));
      process.exit(1);
    }
  }

  dockerCmd.push(dockerImage, 'bash', '-c', deployScript);

  console.log(chalk.dim('Starting deployment container...'));
  console.log('');

  const deploySpinner = ora('Starting deployment...').start();

  try {
    const proc = Bun.spawn(dockerCmd, {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });

    deploySpinner.stop();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log('');
      printSuccess(`Deployment to ${env} completed successfully!`);
    } else {
      console.log('');
      printError(`Deployment failed with exit code ${exitCode}`);
      process.exit(exitCode);
    }
  } catch (error) {
    deploySpinner.fail('Deployment failed');
    printError(`${error}`);
    process.exit(1);
  }
}

/**
 * Run deployment - can be called directly or via CLI command
 */
export async function runDeploy(env: string, version: string | undefined, options: Partial<DeployOptions>): Promise<void> {
  // Load secrets from file or environment (for CI)
  loadSecrets();

  const { deployApp, forceAccessories, skipAccessories } = getDeploymentTargets(options as DeployOptions);
  const accessoriesDesc = skipAccessories ? '' : (forceAccessories ? ' + Accessories (forced)' : ' + Accessories (auto)');
  const targetDesc = options.accessories ? 'Accessories only' : `App${accessoriesDesc}`;

  printHeader(`Deploying ${targetDesc} to ${env}`);
  console.log('');

  const debug = options.debug || false;

  // Check config exists
  const config = loadConfig();
  if (!config) {
    printError('.deployment/config.yml not found');
    printInfo('Run "dockflow init" to create project structure');
    process.exit(1);
  }

  // Check servers.yml exists
  if (!hasServersConfig()) {
    printError('.deployment/servers.yml not found');
    printInfo('Create a servers.yml file to define your deployment servers');
    process.exit(1);
  }

  // Resolve deployment (manager + workers)
  const deployment = resolveDeploymentForEnvironment(env);
  if (!deployment) {
    printError(`No manager server found for environment "${env}"`);
    const availableEnvs = getAvailableEnvironments();
    if (availableEnvs.length > 0) {
      printInfo(`Available environments: ${availableEnvs.join(', ')}`);
    }
    printInfo('Each environment needs a server with role: manager');
    process.exit(1);
  }

  let { manager, managers, workers } = deployment;

  // Multi-manager failover: find active manager
  if (managers.length > 1 && !options.noFailover) {
    const managerSpinner = ora(`Checking ${managers.length} managers for active leader...`).start();
    
    const activeResult = await findActiveManager(env, managers, { verbose: debug });
    
    if (!activeResult) {
      managerSpinner.fail('No reachable managers found');
      printError('All managers are unreachable. Cannot deploy.');
      printInfo('Managers tried:');
      for (const m of managers) {
        printInfo(`  - ${m.name} (${m.host})`);
      }
      process.exit(1);
    }
    
    manager = activeResult.manager;
    
    if (activeResult.failedManagers.length > 0) {
      managerSpinner.warn(`Using ${manager.name} (${activeResult.status}). Unreachable: ${activeResult.failedManagers.join(', ')}`);
    } else {
      managerSpinner.succeed(`Using ${manager.name} (${activeResult.status === 'leader' ? 'leader' : 'active manager'})`);
    }
  }

  // Validate manager has private key
  const managerPrivateKey = getServerPrivateKey(env, manager.name);
  if (!managerPrivateKey) {
    printError(`No SSH private key found for manager "${manager.name}"`);
    printInfo(`Expected CI secret: ${env.toUpperCase()}_${manager.name.toUpperCase()}_CONNECTION`);
    printInfo(`  or: ${env.toUpperCase()}_${manager.name.toUpperCase()}_SSH_PRIVATE_KEY`);
    process.exit(1);
  }

  // Validate workers have private keys (for image distribution)
  for (const worker of workers) {
    const privateKey = getServerPrivateKey(env, worker.name);
    if (!privateKey) {
      printError(`No SSH private key found for worker "${worker.name}"`);
      printInfo(`Expected CI secret: ${env.toUpperCase()}_${worker.name.toUpperCase()}_CONNECTION`);
      printInfo(`  or: ${env.toUpperCase()}_${worker.name.toUpperCase()}_SSH_PRIVATE_KEY`);
      process.exit(1);
    }
  }

  // Check Docker is available
  const spinner = ora('Checking Docker availability...').start();
  const dockerAvailable = await isDockerAvailable();

  if (!dockerAvailable) {
    spinner.fail('Docker is not available');
    console.log('');
    printError('Docker is required for deployment');
    printInfo('Install Docker Desktop: https://www.docker.com/products/docker-desktop');
    console.log('');
    printInfo('On Windows, make sure Docker Desktop is running.');
    printInfo('On Linux, install Docker with: curl -fsSL https://get.docker.com | sh');
    process.exit(1);
  }
  spinner.succeed('Docker is available');

  // Determine version
  let deployVersion: string;
  const branchName = getCurrentBranch();

  if (version) {
    deployVersion = version;
  } else {
    // Auto-increment version using manager
    const managerPassword = getServerPassword(env, manager.name);

    const connectionString = Buffer.from(JSON.stringify({
      host: manager.host,
      port: manager.port,
      user: manager.user,
      privateKey: managerPrivateKey,
      password: managerPassword,
    })).toString('base64');

    const versionSpinner = ora('Fetching latest deployed version...').start();
    const projectName = config.project_name || 'app';
    const latestVersion = await getLatestVersion(connectionString, projectName, env, debug);

    if (latestVersion) {
      deployVersion = incrementVersion(latestVersion);
      versionSpinner.succeed(`Latest version: ${latestVersion} → New version: ${deployVersion}`);
    } else {
      deployVersion = '1.0.0';
      versionSpinner.info('No previous deployment found, starting at 1.0.0');
    }
  }

  // Display deployment info
  printInfo(`Version: ${deployVersion}`);
  printInfo(`Environment: ${env}`);
  if (managers.length > 1) {
    printInfo(`Manager: ${manager.name} (${manager.host}) [${managers.length} managers configured]`);
  } else {
    printInfo(`Manager: ${manager.name} (${manager.host})`);
  }
  if (workers.length > 0) {
    printInfo(`Workers: ${workers.map(w => `${w.name} (${w.host})`).join(', ')}`);
  }
  printInfo(`Branch: ${branchName}`);
  printInfo(`Targets: ${targetDesc}`);
  if (options.services) {
    printInfo(`Services: ${options.services}`);
  }
  if (options.dev) {
    printInfo(`Mode: Development (using local dockflow)`);
  }
  console.log('');

  // Build workers JSON for Ansible (for image distribution)
  const workersInfo = workers.map(w => ({
    name: w.name,
    host: w.host,
    port: w.port,
    user: w.user,
    privateKey: getServerPrivateKey(env, w.name),
  }));
  const workersJson = JSON.stringify(workersInfo).replace(/'/g, "'\"'\"'");

  // Deploy via manager only (Swarm distributes workloads)
  const projectRoot = getProjectRoot();
  const dockerImage = getAnsibleDockerImage();

  const managerPassword = getServerPassword(env, manager.name);
  const managerExports = buildEnvExportsFromServer(env, manager, managerPrivateKey, managerPassword);

  const deployScript = buildDeployScript(
    env,
    deployment,
    deployVersion,
    branchName,
    managerExports,
    workersJson,
    options as DeployOptions
  );

  await executeDeployment(projectRoot, dockerImage, deployScript, env, options.dev || false);

  const totalNodes = managers.length + workers.length;
  if (totalNodes > 1) {
    console.log('');
    if (managers.length > 1) {
      printSuccess(`Deployment completed! Swarm cluster: ${managers.length} managers + ${workers.length} worker(s)`);
    } else {
      printSuccess(`Deployment completed! Swarm cluster: 1 manager + ${workers.length} worker(s)`);
    }
  }
}

/**
 * Register deploy command
 */
export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <env> [version]')
    .description('Deploy application to specified environment (targets Swarm manager)')
    .option('--services <services>', 'Comma-separated list of services to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .option('--skip-docker-install', 'Skip Docker installation (use when Docker is pre-installed)')
    .option('--accessories', 'Deploy only accessories (databases, caches, etc.)')
    .option('--all', 'Deploy both application and accessories')
    .option('--skip-accessories', 'Skip accessories check entirely')
    .option('--no-failover', 'Disable multi-manager failover (use first manager only)')
    .option('--debug', 'Enable debug output')
    .option('--dev', 'Use local dockflow folder instead of cloning (for development)')
    .action(async (env: string, version: string | undefined, options: DeployOptions) => {
      await runDeploy(env, version, options);
    });
}
