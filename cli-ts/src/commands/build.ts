/**
 * Build command
 * Uses Docker to run Ansible playbook for building images only (no deployment)
 * 
 * This command builds Docker images locally without deploying to a Swarm cluster.
 * Useful for CI/CD pipelines where you want to validate builds before deployment.
 */

import type { Command } from 'commander';
import { printInfo, printHeader, printDebug, setVerbose } from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import { getCurrentBranch } from '../utils/git';
import { withErrorHandler } from '../utils/errors';
import {
  getDockflowSetupScript,
  getEnvPrepScript,
  runInAnsibleContainer,
  checkDockerAvailable,
  validateProjectConfig,
} from '../utils/docker-runner';

interface BuildOptions {
  services?: string;
  debug?: boolean;
  dev?: boolean;
  push?: boolean;
}

/**
 * Build the build script to run inside the container
 */
function buildBuildScript(
  branchName: string,
  options: BuildOptions
): string {
  const dockflowSetup = getDockflowSetupScript({
    devMode: options.dev || false,
    checkFile: 'ansible/playbooks/build_images.yml',
  });

  const envPrep = getEnvPrepScript();

  return `
set -e

${dockflowSetup}

# Set build environment variables
export ENV="build"
export VERSION="build"
export BRANCH_NAME="${branchName}"
export ROOT_PATH="/project"
export ANSIBLE_HOST_KEY_CHECKING=False
${options.services ? `export DEPLOY_DOCKER_SERVICES="${options.services}"` : ''}

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Dockflow Build Mode"
echo "═══════════════════════════════════════════════════"
echo "  Branch: ${branchName}"
${options.services ? `echo "  Services: ${options.services}"` : ''}
echo "═══════════════════════════════════════════════════"
echo ""

${envPrep}

# Run Ansible build playbook
cd $DOCKFLOW_PATH
ansible-playbook ansible/playbooks/build_images.yml
`;
}

/**
 * Run build - can be called directly or via CLI command
 */
export async function runBuild(options: Partial<BuildOptions>): Promise<void> {
  // Enable verbose mode if debug flag is set
  if (options.debug) {
    setVerbose(true);
  }

  // Load secrets from file or environment (for CI)
  loadSecrets();
  printDebug('Secrets loaded from environment');

  printHeader('Building Docker images');
  console.log('');

  // Check config exists
  const config = validateProjectConfig();

  // Check Docker is available
  await checkDockerAvailable();

  const branchName = getCurrentBranch();

  // Display build info
  printInfo(`Project: ${config.project_name || 'app'}`);
  printInfo(`Branch: ${branchName}`);
  if (options.services) {
    printInfo(`Services: ${options.services}`);
  }
  if (options.dev) {
    printInfo(`Mode: Development (using local dockflow)`);
  }
  console.log('');

  const buildScript = buildBuildScript(branchName, options as BuildOptions);

  await runInAnsibleContainer({
    script: buildScript,
    devMode: options.dev,
    actionName: 'build',
    successMessage: 'Build completed successfully!',
  });
}

/**
 * Register build command
 */
export function registerBuildCommand(program: Command): void {
  program
    .command('build')
    .description('Build Docker images locally without deploying')
    .option('--services <services>', 'Comma-separated list of services to build')
    .option('--push', 'Push images to registry after build')
    .option('--debug', 'Enable debug output')
    .option('--dev', 'Use local dockflow folder instead of cloning (for development)')
    .action(withErrorHandler(async (options: BuildOptions) => {
      await runBuild(options);
    }));
}
