/**
 * Build command
 * Uses Docker to run Ansible playbook for building images only (no deployment)
 * 
 * This command builds Docker images locally without deploying to a Swarm cluster.
 * Useful for CI/CD pipelines where you want to validate builds before deployment.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { printInfo, printHeader, printDebug, setVerbose } from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import { getCurrentBranch } from '../utils/git';
import { withErrorHandler } from '../utils/errors';
import { getEnvVarsForEnvironment } from '../utils/servers';
import type { EnvVars } from '../types';
import {
  getDockflowSetupScript,
  runInAnsibleContainer,
  checkDockerAvailable,
  validateProjectConfig,
  validateServersYaml,
} from '../utils/docker-runner';

interface BuildOptions {
  services?: string;
  debug?: boolean;
  dev?: boolean;
  push?: boolean;
}

/**
 * Build environment exports string from env vars
 */
function buildEnvExports(envVars: EnvVars): string {
  const lines: string[] = [];
  
  for (const [key, value] of Object.entries(envVars)) {
    // Escape double quotes and dollar signs for shell
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    lines.push(`export ${key}="${escapedValue}"`);
  }
  
  return lines.join('\n');
}

/**
 * Build the build script to run inside the container
 */
function buildBuildScript(
  env: string,
  branchName: string,
  envVars: EnvVars,
  options: BuildOptions
): string {
  const dockflowSetup = getDockflowSetupScript({
    devMode: options.dev || false,
    checkFile: 'ansible/playbooks/build_images.yml',
  });

  const envExports = buildEnvExports(envVars);

  return `
set -e

${dockflowSetup}

# Set build environment variables
export ENV="${env}"
export VERSION="build"
export BUILD_MODE="true"
export BRANCH_NAME="${branchName}"
export ROOT_PATH="/project"
export ANSIBLE_HOST_KEY_CHECKING=False
${options.services ? `export DEPLOY_DOCKER_SERVICES="${options.services}"` : ''}

# Environment variables from servers.yml
${envExports}

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Dockflow Build Mode"
echo "═══════════════════════════════════════════════════"
echo "  Environment: ${env}"
echo "  Branch: ${branchName}"
${options.services ? `echo "  Services: ${options.services}"` : ''}
echo "═══════════════════════════════════════════════════"
echo ""

# Prepare environment (CRLF fix + export env vars to YAML)
source $DOCKFLOW_PATH/.common/scripts/prepare_env.sh

# Run Ansible build playbook
cd $DOCKFLOW_PATH
ansible-playbook ansible/playbooks/build_images.yml
`;
}

/**
 * Run build - can be called directly or via CLI command
 */
export async function runBuild(env: string, options: Partial<BuildOptions>): Promise<void> {
  // Enable verbose mode if debug flag is set
  if (options.debug) {
    setVerbose(true);
  }

  // Load secrets from file or environment (for CI)
  loadSecrets();
  printDebug('Secrets loaded from environment');

  printHeader(`Building Docker images for ${env}`);
  console.log('');

  // Check config exists
  const config = validateProjectConfig();

  // Validate servers.yml schema
  validateServersYaml();

  // Check Docker is available
  await checkDockerAvailable();

  const branchName = getCurrentBranch();

  // Get environment variables for this environment
  const envVars = getEnvVarsForEnvironment(env);
  printDebug('Environment variables loaded', envVars);

  // Display build info
  printInfo(`Project: ${config.project_name || 'app'}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Branch: ${branchName}`);
  if (Object.keys(envVars).length > 0) {
    printInfo(`Env vars: ${Object.keys(envVars).length} variables loaded`);
  } else {
    console.log(chalk.yellow(`⚠ No environment variables found for "${env}"`));
    console.log(chalk.dim(`  Check that servers.yml has a server with tag "${env}" and env vars defined`));
  }
  if (options.services) {
    printInfo(`Services: ${options.services}`);
  }
  if (options.dev) {
    printInfo(`Mode: Development (using local dockflow)`);
  }
  console.log('');

  const buildScript = buildBuildScript(env, branchName, envVars, options as BuildOptions);

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
    .command('build <environment>')
    .description('Build Docker images locally without deploying')
    .option('--services <services>', 'Comma-separated list of services to build')
    .option('--push', 'Push images to registry after build')
    .option('--debug', 'Enable debug output')
    .option('--dev', 'Use local dockflow folder instead of cloning (for development)')
    .action(withErrorHandler(async (env: string, options: BuildOptions) => {
      await runBuild(env, options);
    }));
}
