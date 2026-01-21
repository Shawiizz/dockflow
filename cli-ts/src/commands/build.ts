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
import { getEnvVarsForEnvironment, buildTemplateContext, getManagersForEnvironment } from '../utils/servers';
import { buildBuildContext, writeContextFile, getHostContextPath } from '../utils/context-generator';
import type { TemplateContext } from '../types';
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
  skipHooks?: boolean;
}

/**
 * Build the build script to run inside the container
 * 
 * New architecture (JSON context):
 * - Context is provided via /tmp/dockflow_context.json (mounted by CLI)
 * - No more shell variable exports
 * - Ansible consumes context via --extra-vars "@file"
 */
function buildBuildScript(options: BuildOptions): string {
  const dockflowSetup = getDockflowSetupScript({
    devMode: options.dev || false,
    checkFile: 'ansible/playbooks/build_images.yml',
  });

  return `
set -e

${dockflowSetup}

# Minimal setup - context is provided via /tmp/dockflow_context.json
export ROOT_PATH="/project"
export BUILD_MODE="true"
export ANSIBLE_HOST_KEY_CHECKING=False

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Dockflow Build Mode"
echo "═══════════════════════════════════════════════════"
echo ""

# Prepare environment (CRLF fix, workspace setup)
source $DOCKFLOW_PATH/.common/scripts/prepare_env.sh

# Build extra vars for Ansible
EXTRA_VARS=()

# Use JSON context file (new approach - all variables in one file)
CONTEXT_FILE="/tmp/dockflow_context.json"
if [ -f "$CONTEXT_FILE" ]; then
    EXTRA_VARS+=("-e" "@\${CONTEXT_FILE}")
fi

# Run Ansible build playbook
cd $DOCKFLOW_PATH
ansible-playbook ansible/playbooks/build_images.yml "\${EXTRA_VARS[@]}"
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

  // Build template context for Jinja2 (current, servers, cluster)
  // For build, we use the first manager as "current" since we're building locally
  const managers = getManagersForEnvironment(env);
  const currentServerName = managers.length > 0 ? managers[0].name : undefined;
  const templateContext = currentServerName ? buildTemplateContext(env, currentServerName) : null;
  if (templateContext) {
    printDebug('Template context built', {
      currentServer: templateContext.current.name,
      serversCount: Object.keys(templateContext.servers).length,
      clusterSize: templateContext.cluster.size,
    });
  }

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
  if (options.skipHooks) {
    printInfo(`Hooks: Skipped`);
  }
  if (options.dev) {
    printInfo(`Mode: Development (using local dockflow)`);
  }
  console.log('');

  // Build context JSON (needed even without SSH for template context)
  let contextFilePath: string | undefined;
  if (templateContext) {
    const buildContext = buildBuildContext({
      env,
      branchName,
      templateContext,
      userEnv: envVars,
      options: {
        skipHooks: options.skipHooks,
        services: options.services,
      },
    });

    contextFilePath = getHostContextPath();
    writeContextFile(buildContext, contextFilePath);
    printDebug('Context file written', { path: contextFilePath });
  }

  const buildScript = buildBuildScript(options as BuildOptions);

  await runInAnsibleContainer({
    script: buildScript,
    devMode: options.dev,
    actionName: 'build',
    successMessage: 'Build completed successfully!',
    contextFilePath,
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
    .option('--skip-hooks', 'Skip pre-build and post-build hooks')
    .option('--debug', 'Enable debug output')
    .option('--dev', 'Use local dockflow folder instead of cloning (for development)')
    .action(withErrorHandler(async (env: string, options: BuildOptions) => {
      await runBuild(env, options);
    }));
}
