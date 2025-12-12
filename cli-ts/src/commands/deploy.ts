/**
 * Deploy command
 * Uses Docker to run Ansible playbooks
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getProjectRoot, loadConfig, isDockerAvailable, getAnsibleDockerImage } from '../utils/config';
import { printError, printSuccess, printInfo, printHeader } from '../utils/output';
import { loadEnvDockflow, buildEnvExports } from '../utils/env';
import { getCurrentBranch } from '../utils/git';
import { getLatestVersion, incrementVersion } from '../utils/version';

const DOCKFLOW_REPO = 'https://github.com/Shawiizz/dockflow.git';
const DOCKFLOW_VERSION = '2.0.0-dev2';

interface DeployOptions {
  services?: string;
  skipBuild?: boolean;
  force?: boolean;
  hostname?: string;
  debug?: boolean;
}

/**
 * Build the deployment script to run inside the container
 */
function buildDeployScript(
  env: string,
  hostname: string,
  deployVersion: string,
  branchName: string,
  envExports: string,
  options: DeployOptions
): string {
  return `
set -e

# Clone dockflow framework
echo "Cloning dockflow framework v${DOCKFLOW_VERSION}..."
git clone --depth 1 --branch "${DOCKFLOW_VERSION}" "${DOCKFLOW_REPO}" /tmp/dockflow 2>/dev/null
chmod +x /tmp/dockflow/.common/scripts/*.sh

# Set environment variables from .env.dockflow
${envExports}

# Set deployment environment variables
export ENV="${env}"
export HOSTNAME="${hostname}"
export VERSION="${deployVersion}"
export BRANCH_NAME="${branchName}"
export ROOT_PATH="/project"
export ANSIBLE_HOST_KEY_CHECKING=False
${options.skipBuild ? 'export SKIP_BUILD=true' : ''}
${options.force ? 'export FORCE_DEPLOY=true' : ''}
${options.services ? `export DEPLOY_DOCKER_SERVICES="${options.services}"` : ''}

# Load environment using the standard load_env script
cd /project
source /tmp/dockflow/.common/scripts/load_env.sh "${env}" "${hostname}"

echo ""
echo "Deploying to \$DOCKFLOW_HOST:\$DOCKFLOW_PORT as \$DOCKFLOW_USER"
echo ""

# Run the deployment script
cd /tmp/dockflow
bash .common/scripts/deploy_with_ansible.sh
`;
}

/**
 * Execute deployment in Docker container
 */
async function executeDeployment(
  projectRoot: string,
  dockerImage: string,
  deployScript: string,
  env: string
): Promise<void> {
  const dockerCmd = [
    'docker', 'run', '--rm', '-it',
    '-v', `${projectRoot}:/project`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    dockerImage,
    'bash', '-c', deployScript,
  ];

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
 * Register deploy command
 */
export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <env> [version]')
    .description('Deploy application to specified environment')
    .option('--services <services>', 'Comma-separated list of services to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .option('--hostname <hostname>', 'Specific host to deploy to (for multi-host)', 'main')
    .option('--debug', 'Enable debug output')
    .action(async (env: string, version: string | undefined, options: DeployOptions) => {
      printHeader(`Deploying to ${env}`);
      console.log('');

      const debug = options.debug || false;

      // Check config exists
      const config = loadConfig();
      if (!config) {
        printError('.deployment/config.yml not found');
        printInfo('Run "dockflow init" to create project structure');
        process.exit(1);
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

      // Load .env.dockflow
      const envVars = loadEnvDockflow();
      const connectionKey = `${env.toUpperCase()}_CONNECTION`;

      if (!envVars[connectionKey]) {
        printError(`.env.dockflow does not contain ${connectionKey}`);
        printInfo('Create a .env.dockflow file with your connection string:');
        console.log(`  ${connectionKey}=<base64-encoded-connection-string>`);
        process.exit(1);
      }

      // Determine version
      let deployVersion: string;
      const hostname = options.hostname || 'main';
      const branchName = getCurrentBranch();

      if (version) {
        deployVersion = version;
      } else {
        // Auto-increment version
        const versionSpinner = ora('Fetching latest deployed version...').start();
        const projectName = config.project_name || 'app';
        const latestVersion = await getLatestVersion(envVars[connectionKey], projectName, env, debug);

        if (latestVersion) {
          deployVersion = incrementVersion(latestVersion);
          versionSpinner.succeed(`Latest version: ${latestVersion} → New version: ${deployVersion}`);
        } else {
          deployVersion = '1.0.0';
          versionSpinner.info('No previous deployment found, starting at 1.0.0');
        }
      }

      printInfo(`Version: ${deployVersion}`);
      printInfo(`Environment: ${env}`);
      printInfo(`Hostname: ${hostname}`);
      printInfo(`Branch: ${branchName}`);
      if (options.services) {
        printInfo(`Services: ${options.services}`);
      }
      console.log('');

      // Build and execute deployment
      const projectRoot = getProjectRoot();
      const dockerImage = getAnsibleDockerImage();
      const envExports = buildEnvExports(envVars);

      const deployScript = buildDeployScript(
        env,
        hostname,
        deployVersion,
        branchName,
        envExports,
        options
      );

      await executeDeployment(projectRoot, dockerImage, deployScript, env);
    });
}
