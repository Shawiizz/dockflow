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
import ora from 'ora';
import { getProjectRoot, getAnsibleDockerImage } from '../utils/config';
import { printSuccess, printInfo, printHeader, printDebug, setVerbose } from '../utils/output';
import {
  runAnsibleCommand,
  checkDockerAvailable,
  validateProjectConfig,
  validateServersYaml,
  buildDeployAnsibleCommand,
  hasNginxConfig,
} from '../utils/docker-runner';
import { 
  resolveDeploymentForEnvironment,
  getServerPrivateKey, 
  getServerPassword,
  getAvailableEnvironments,
  findActiveManager,
  buildTemplateContext,
} from '../utils/servers';
import { loadSecrets } from '../utils/secrets';
import { getCurrentBranch } from '../utils/git';
import { getLatestVersion, incrementVersion } from '../utils/version';
import { 
  ConfigError, 
  ConnectionError, 
  withErrorHandler,
} from '../utils/errors';
import { displayDeployDryRun } from './dry';
import { buildDeployContext, writeContextFile, getHostContextPath } from '../utils/context-generator';
import type { ResolvedDeployment, TemplateContext } from '../types';

interface DeployOptions {
  services?: string;
  skipBuild?: boolean;
  force?: boolean;
  debug?: boolean;
  accessories?: boolean;
  all?: boolean;
  skipAccessories?: boolean;
  skipDockerInstall?: boolean;
  noFailover?: boolean;
  dryRun?: boolean;
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
 * Run deployment - can be called directly or via CLI command
 */
export async function runDeploy(env: string, version: string | undefined, options: Partial<DeployOptions>): Promise<void> {
  // Enable verbose mode if debug flag is set
  if (options.debug) {
    setVerbose(true);
  }

  // Load secrets from file or environment (for CI)
  loadSecrets();
  printDebug('Secrets loaded from environment');

  const { deployApp, forceAccessories, skipAccessories } = getDeploymentTargets(options as DeployOptions);
  const accessoriesDesc = skipAccessories ? '' : (forceAccessories ? ' + Accessories (forced)' : ' + Accessories (auto)');
  const targetDesc = options.accessories ? 'Accessories only' : `App${accessoriesDesc}`;

  printDebug('Deployment targets resolved', { deployApp, forceAccessories, skipAccessories });

  printHeader(`Deploying ${targetDesc} to ${env}`);
  console.log('');

  const debug = options.debug || false;

  // Check config exists
  const config = validateProjectConfig();

  // Validate servers.yml exists and schema is valid
  validateServersYaml();

  // Resolve deployment (manager + workers)
  const deployment = resolveDeploymentForEnvironment(env);
  if (!deployment) {
    const availableEnvs = getAvailableEnvironments();
    throw new ConfigError(
      `No manager server found for environment "${env}"`,
      availableEnvs.length > 0 
        ? `Available environments: ${availableEnvs.join(', ')}. Each environment needs a server with role: manager`
        : 'Each environment needs a server with role: manager'
    );
  }

  let { manager, managers, workers } = deployment;

  // Multi-manager failover: find active manager
  if (managers.length > 1 && !options.noFailover) {
    const managerSpinner = ora(`Checking ${managers.length} managers for active leader...`).start();
    
    const activeResult = await findActiveManager(env, managers, { verbose: debug });
    
    if (!activeResult) {
      managerSpinner.fail('No reachable managers found');
      throw new ConnectionError(
        'All managers are unreachable. Cannot deploy.',
        `Managers tried: ${managers.map(m => `${m.name} (${m.host})`).join(', ')}`
      );
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
    throw new ConnectionError(
      `No SSH private key found for manager "${manager.name}"`,
      `Expected CI secret: ${env.toUpperCase()}_${manager.name.toUpperCase()}_CONNECTION\n  or: ${env.toUpperCase()}_${manager.name.toUpperCase()}_SSH_PRIVATE_KEY`
    );
  }

  // Validate workers have private keys (for image distribution)
  for (const worker of workers) {
    const privateKey = getServerPrivateKey(env, worker.name);
    if (!privateKey) {
      throw new ConnectionError(
        `No SSH private key found for worker "${worker.name}"`,
        `Expected CI secret: ${env.toUpperCase()}_${worker.name.toUpperCase()}_CONNECTION\n  or: ${env.toUpperCase()}_${worker.name.toUpperCase()}_SSH_PRIVATE_KEY`
      );
    }
  }

  // Check Docker is available
  await checkDockerAvailable();

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
  console.log('');

  // Build workers JSON for Ansible (for image distribution)
  const workersWithKeys = workers.map(w => ({
    server: w,
    privateKey: getServerPrivateKey(env, w.name) || '',
  }));

  printDebug('Workers configuration built', { workerCount: workers.length });

  // Build template context for Jinja2 (current, servers, cluster)
  const templateContext = buildTemplateContext(env, manager.name);
  if (!templateContext) {
    throw new ConfigError(
      `Failed to build template context for ${manager.name}`,
      'This should not happen if deployment resolved successfully'
    );
  }

  printDebug('Template context built', { 
    currentServer: templateContext.current.name,
    serversCount: Object.keys(templateContext.servers).length,
    clusterSize: templateContext.cluster.size,
  });

  // Deploy via manager only (Swarm distributes workloads)
  const projectRoot = getProjectRoot();
  const dockerImage = getAnsibleDockerImage();

  printDebug('Docker configuration', { projectRoot, dockerImage });

  const managerPassword = getServerPassword(env, manager.name);
  
  // Build complete Ansible context (JSON)
  const ansibleContext = buildDeployContext({
    env,
    version: deployVersion,
    branchName,
    deployment,
    templateContext,
    managerPrivateKey,
    managerPassword,
    workers: workersWithKeys,
    config: config as unknown as Record<string, unknown>,
    options: {
      skipBuild: options.skipBuild,
      skipDockerInstall: options.skipDockerInstall,
      force: options.force,
      deployApp,
      forceAccessories,
      skipAccessories,
      services: options.services,
    },
  });

  // Write context to host file (will be mounted into container)
  const contextFilePath = getHostContextPath();
  writeContextFile(ansibleContext, contextFilePath);
  printDebug('Context file written', { path: contextFilePath });

  // Build the Ansible command with skip tags
  const skipTags = ['configure_host'];
  if (!hasNginxConfig()) {
    printDebug('No nginx configuration found, will skip nginx role');
    skipTags.push('nginx');
  }
  const ansibleCommand = buildDeployAnsibleCommand({ skipTags });
  printDebug('Ansible command', { command: ansibleCommand.join(' ') });

  // Dry-run mode: display what would happen without executing
  if (options.dryRun) {
    displayDeployDryRun({
      env,
      deployVersion,
      branchName,
      projectRoot,
      dockerImage,
      manager,
      workers,
      deployApp,
      forceAccessories,
      skipAccessories,
      skipBuild: options.skipBuild,
      force: options.force,
      services: options.services,
      debug,
      deployScript: ansibleCommand.join(' '),
    });
    return;
  }

  await runAnsibleCommand({
    command: ansibleCommand,
    actionName: 'deployment',
    successMessage: `Deployment to ${env} completed successfully!`,
    contextFilePath,
  });

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
    .option('--dry-run', 'Show what would be deployed without executing')
    .option('--debug', 'Enable debug output')
    .action(withErrorHandler(async (env: string, version: string | undefined, options: DeployOptions) => {
      await runDeploy(env, version, options);
    }));
}
