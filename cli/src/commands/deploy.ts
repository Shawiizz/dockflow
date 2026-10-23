/**
 * Deploy command
 *
 * Deploys the application to a cluster using direct SSH.
 * Setup resolution, phase execution, and types are split into:
 *   deploy-context.ts  — DeployContext interface
 *   deploy-run.ts      — one run: its steps, the undo on failure or Ctrl+C, the record
 *   deploy-phases/     — the phases: build, uploads, accessories, app, health checks, history
 *   deploy-dry-run.ts  — dry-run display
 */

import type { Command } from 'commander';
import {
  getProjectRoot,
  loadConfig,
} from '../utils/config';
import {
  printSuccess,
  printInfo,
  printIntro,
  printDebug,
  printBlank,
  printWarning,
  setVerbose,
  isVerbose,
  createSpinner,
} from '../utils/output';
import {
  resolveDeploymentForEnvironment,
  getServerPrivateKey,
  getServerPassword,
  getAvailableEnvironments,
  findActiveManager,
  buildTemplateContext,
} from '../utils/servers';
import { loadSecrets } from '../utils/secrets';
import { chooseServer, resolveEnvironmentPrefix } from '../utils/validation';
import { detectCIEnvironment, resolveDeployParams } from '../utils/ci';
import { getCurrentBranch } from '../utils/git';
import { incrementVersion } from '../utils/version';
import {
  ConfigError,
  ConnectionError,
  DeployError,
  ErrorCode,
  withErrorHandler,
} from '../utils/errors';
import { displayDeployDryRun, displayRenderedStack } from './deploy-dry-run';
import type { ClusterNode, ResolvedServer, SSHKeyConnection } from '../types';

import * as Compose from '../services/compose';
import { SwarmStack } from '../services/swarm/stack';
import { SwarmProxy } from '../services/swarm/proxy';
import { assertReleaseName, Release } from '../services/release';
import { createEnvLock } from '../services/lock';
import { Audit } from '../services/audit';
import { Metrics } from '../services/metrics';
import * as Plugin from '../services/plugin';
import { onInterrupt } from '../utils/interrupt';

import type { DeployOptions, DeployContext } from './deploy-context';
import { DeployRun } from './deploy-run';
import { accessoriesKey } from './deploy-phases';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeploymentTargets(options: DeployOptions) {
  if (options.skipAccessories) return { deployApp: true, forceAccessories: false, skipAccessories: true };
  if (options.all) return { deployApp: true, forceAccessories: true, skipAccessories: false };
  if (options.accessories) return { deployApp: false, forceAccessories: true, skipAccessories: false };
  return { deployApp: true, forceAccessories: false, skipAccessories: false };
}

function buildConnection(env: string, server: ResolvedServer): SSHKeyConnection {
  const { name: serverName, host, port, user, hostKey } = server;
  const privateKey = getServerPrivateKey(env, serverName);
  if (!privateKey) {
    throw new ConnectionError(
      `No SSH private key found for "${serverName}"`,
      `Expected CI secret: ${env.toUpperCase()}_${serverName.toUpperCase()}_CONNECTION`,
    );
  }
  const password = getServerPassword(env, serverName);
  return { host, port, user, privateKey, password: password || undefined, hostKey };
}

/** The env and version given on the command line, or read from the CI when the env is missing. */
function targetFromArgsOrCI(rawEnv: string | undefined, rawVersion: string | undefined): { env: string; version: string | undefined } {
  if (rawEnv) return { env: rawEnv, version: rawVersion };
  const ci = detectCIEnvironment();
  if (!ci) {
    throw new ConfigError(
      'Environment is required',
      'Usage: dockflow deploy <env> [version]\nIn CI, environment and version are auto-detected from git tag/branch.',
    );
  }
  const params = resolveDeployParams(ci);
  const version = rawVersion ?? params.version;
  printInfo(`CI detected (${ci.provider}): deploying to ${params.env} with version ${version}`);
  return { env: params.env, version };
}

type Deployment = NonNullable<ReturnType<typeof resolveDeploymentForEnvironment>>;

/** The manager to deploy through: the one --server names, else the active one when there are several. */
async function chooseManager(env: string, deployment: Deployment, options: Partial<DeployOptions>): Promise<{ manager: ResolvedServer; unavailableManagers: string[] }> {
  const { managers, workers } = deployment;
  let manager = deployment.manager;

  if (options.server) {
    const chosen = chooseServer(env, [...managers, ...workers], options.server, {}, () => true);
    if ('type' in chosen) throw new ConfigError(chosen.message, chosen.suggestion);
    manager = managers.find((m) => m.name === chosen.name) ?? manager;
    return { manager, unavailableManagers: [] };
  }
  if (managers.length <= 1 || options.failover === false) return { manager, unavailableManagers: [] };

  const managerSpinner = createSpinner();
  managerSpinner.start(`Checking ${managers.length} managers for active leader...`);
  const activeResult = await findActiveManager(env, managers, { verbose: !!options.debug });
  if (!activeResult) {
    managerSpinner.fail('No reachable managers found');
    throw new ConnectionError('All managers are unreachable. Cannot deploy.', `Managers tried: ${managers.map((m) => `${m.name} (${m.host})`).join(', ')}`);
  }
  manager = activeResult.manager;
  if (activeResult.failedManagers.length > 0) {
    managerSpinner.warn(`Using ${manager.name} (${activeResult.status}). Unreachable: ${activeResult.failedManagers.join(', ')}`);
  } else {
    managerSpinner.succeed(`Using ${manager.name} (${activeResult.status === 'leader' ? 'leader' : 'active manager'})`);
  }
  return { manager, unavailableManagers: activeResult.unavailable };
}

function buildCluster(env: string, manager: ResolvedServer, managers: ResolvedServer[], workers: ResolvedServer[], unavailableManagers: string[]) {
  const managerNode: ClusterNode = {
    connection: buildConnection(env, manager),
    name: manager.name,
  };
  const workerNodes: ClusterNode[] = workers.map((w) => ({
    connection: buildConnection(env, w),
    name: w.name,
  }));
  const otherManagerNodes: ClusterNode[] = [];
  for (const m of managers) {
    // a manager found down cannot run tasks: it gets no image or upload
    if (m.name === manager.name || unavailableManagers.includes(m.name)) continue;
    try { otherManagerNodes.push({ connection: buildConnection(env, m), name: m.name }); }
    catch { printWarning(`History sync: no SSH key for ${m.name}`); }
  }
  return { manager: managerNode, workers: workerNodes, otherManagers: otherManagerNodes };
}

/** The version after the latest deployed one, or 1.0.0 for a first deploy. */
async function nextVersion(managerConn: SSHKeyConnection, stackName: string): Promise<string> {
  const versionSpinner = createSpinner();
  versionSpinner.start('Fetching latest deployed version...');
  let latestVersion: string | null;
  try {
    latestVersion = await new Release(managerConn).latestVersion(stackName);
  } catch (e) {
    // starting over at 1.0.0 would overwrite a release that exists
    versionSpinner.fail('Could not read the deployed versions');
    throw e;
  }
  if (!latestVersion) {
    versionSpinner.info('No previous deployment found, starting at 1.0.0');
    return '1.0.0';
  }
  const deployVersion = incrementVersion(latestVersion);
  versionSpinner.succeed(`Latest version: ${latestVersion} → New version: ${deployVersion}`);
  return deployVersion;
}

/** Checks of the rendered compose files that hold before anything is built, dry runs included. */
function checkRenderedCompose(config: DeployContext['config'], env: string, stackName: string, rendered: Map<string, string>, composeContent: string, only: string | undefined): void {
  // proxy.routes name services of both compose files
  if (config.proxy?.enabled && config.proxy.routes?.length && !config.no_services) {
    const accessories = rendered.get(accessoriesKey());
    const problems = Compose.checkProxyRoutes(
      config.proxy, env, stackName,
      Compose.loadFromString(composeContent, 'docker-compose.yml'),
      accessories ? Compose.loadFromString(accessories, 'accessories.yml') : null,
    );
    if (problems.length > 0) {
      throw new DeployError(
        `Traefik cannot serve proxy.routes as configured:\n  ${problems.join('\n  ')}`,
        ErrorCode.VALIDATION_FAILED,
        'Fix proxy.routes in .dockflow/config.yml.',
      );
    }
  }

  // --only names services of the app (no_services has no Docker services)
  if (only && !config.no_services) {
    const compose = Compose.loadFromString(composeContent, 'docker-compose.yml');
    const available = Object.keys(compose.services);
    const filterSet = only.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = filterSet.filter(s => !available.includes(s));
    if (unknown.length > 0) {
      throw new DeployError(
        `Unknown service(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`,
        ErrorCode.VALIDATION_FAILED,
        'Use the exact service names defined in your docker-compose file.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Setup — resolve env, config, connections, version, render templates
// ---------------------------------------------------------------------------

async function resolveSetup(rawEnv: string | undefined, rawVersion: string | undefined, options: Partial<DeployOptions>) {
  let { env, version } = targetFromArgsOrCI(rawEnv, rawVersion);

  loadSecrets();

  let config = loadConfig({ strict: true });
  if (!config) throw new ConfigError('No config.yml found', 'Run `dockflow init` to create a project configuration.');

  if (config.options?.enable_debug_logs) setVerbose(true);
  printDebug('Secrets loaded from environment');

  env = resolveEnvironmentPrefix(env);

  const { deployApp: shouldDeployApp, forceAccessories, skipAccessories } = getDeploymentTargets(options as DeployOptions);
  const accessoriesDesc = skipAccessories ? '' : forceAccessories ? ' + Accessories (forced)' : ' + Accessories (auto)';
  const targetDesc = options.accessories ? 'Accessories only' : `App${accessoriesDesc}`;

  printIntro(`Deploying ${targetDesc} to ${env}`);
  printBlank();

  // Resolve deployment servers
  const deployment = resolveDeploymentForEnvironment(env);
  if (!deployment) {
    const availableEnvs = getAvailableEnvironments();
    throw new ConfigError(
      `No manager server found for environment "${env}"`,
      availableEnvs.length > 0 ? `Available environments: ${availableEnvs.join(', ')}` : 'Each environment needs a server with role: manager',
    );
  }

  const { managers, workers } = deployment;
  const { manager, unavailableManagers } = await chooseManager(env, deployment, options);
  const cluster = buildCluster(env, manager, managers, workers, unavailableManagers);

  const branchName = options.branch || getCurrentBranch();
  const deployVersion = version ?? await nextVersion(cluster.manager.connection, `${config.project_name}-${env}`);

  const stackName = `${config.project_name}-${env}`;
  assertReleaseName(stackName, 'stack');
  assertReleaseName(deployVersion, 'version');
  const projectRoot = getProjectRoot();

  // Display info
  printInfo(`Version: ${deployVersion}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Manager: ${isVerbose() ? `${manager.name} (${manager.host})` : manager.name}`);
  if (workers.length > 0) printInfo(`Workers: ${workers.map((w) => isVerbose() ? `${w.name} (${w.host})` : w.name).join(', ')}`);
  printInfo(`Branch: ${branchName}`);
  printInfo(`Targets: ${targetDesc}`);
  if (options.only) printInfo(`Only: ${options.only}`);
  printBlank();

  // Render templates
  const templateContext = buildTemplateContext(env, manager.name);
  const { rendered, composeContent, composeDirPath, renderContext } = Compose.renderAndResolveCompose(
    { env, version: deployVersion, branch: branchName, project_name: config.project_name, config },
    templateContext,
    { uploadOnly: config.no_services },
  );
  const pluginsLoaded = await Plugin.loadConfigWithPlugins({ rendered, fallback: config, projectRoot, projectContext: renderContext });
  config = pluginsLoaded.config;

  checkRenderedCompose(config, env, stackName, rendered, composeContent, options.only);

  // Build context
  const managerConn = cluster.manager.connection;
  const ctx: DeployContext = {
    env, config, stackName, branchName, deployVersion, projectRoot,
    cluster,
    deployApp: shouldDeployApp, forceAccessories, skipAccessories,
    options, rendered, composeContent, composeDirPath,
    swarm: new SwarmStack(managerConn),
    swarmProxy: config.proxy?.enabled ? new SwarmProxy(managerConn) : undefined,
    releases: new Release(managerConn),
    lock: await createEnvLock(env, stackName, config.lock?.stale_threshold_minutes),
    audit: new Audit(managerConn),
    metrics: new Metrics(managerConn),
  };

  // Dry-run exit — after rendering and plugin expansion, so the summary lists the
  // uploads and hook entries a deploy would actually run.
  if (options.dryRun) {
    if (options.render) {
      await displayRenderedStack(ctx);
    } else {
      displayDeployDryRun({
        env, deployVersion, branchName, projectRoot, manager, workers,
        deployApp: shouldDeployApp, forceAccessories, skipAccessories,
        skipBuild: options.skipBuild, force: options.force, only: options.only, debug: options.debug,
        config, pluginSummary: pluginsLoaded.pluginSummary,
      });
    }
    return null;
  }

  return { ctx };
}

// ---------------------------------------------------------------------------
// Execute — lock, run, undo on failure, record, unlock
// ---------------------------------------------------------------------------

async function execute(ctx: DeployContext): Promise<void> {
  const lockResult = await ctx.lock.acquire({ version: ctx.deployVersion, force: ctx.options.force, message: `Deploy ${ctx.deployVersion}` });
  // DEPLOY_LOCKED only when another deploy holds it: a manager that does not answer has its own code
  if (!lockResult.success) throw lockResult.error;
  ctx.lock.keepAlive();

  const run = new DeployRun(ctx);
  const stopHandlingInterrupts = onInterrupt(() => run.interrupt());
  let status: 'success' | 'failed' = 'success';
  let auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env}`;
  try {
    await run.steps();
    auditMessage = `Deployed ${ctx.deployVersion} to ${ctx.env} successfully`;
  } catch (err) {
    status = 'failed';
    auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env} failed: ${err instanceof Error ? err.message : String(err)}`;
    throw await run.undo(err);
  } finally {
    stopHandlingInterrupts();
    await run.record(status, auditMessage);
  }

  const managerCount = 1 + ctx.cluster.otherManagers.length;
  const workerCount = ctx.cluster.workers.length;
  const totalNodes = managerCount + workerCount;
  printBlank();
  printSuccess(totalNodes > 1
    ? `Deployment completed! Cluster: ${managerCount} manager(s) + ${workerCount} worker(s)`
    : 'Deployment completed!');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runDeploy(env: string | undefined, version: string | undefined, options: Partial<DeployOptions>): Promise<void> {
  if (options.debug) setVerbose(true);
  if (options.render && !options.dryRun) {
    throw new ConfigError('--render only works with --dry-run', 'Run: dockflow deploy <env> --dry-run --render');
  }
  const setup = await resolveSetup(env, version, options);
  if (!setup) return;
  await execute(setup.ctx);
}

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy [env] [version]')
    .description('Deploy application to specified environment')
    .helpGroup('Deploy')
    .option('--only <services>', 'Comma-separated list of services to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .option('--accessories', 'Deploy only accessories (databases, caches, etc.)')
    .option('--all', 'Deploy both application and accessories')
    .option('--skip-accessories', 'Skip accessories check entirely')
    .option('--no-failover', 'Disable multi-manager failover (use first manager only)')
    .option('-s, --server <name>', 'Deploy through this manager (no failover)')
    .option('--dry-run', 'Show what would be deployed without executing')
    .option('--render', 'With --dry-run, print the Swarm stack that would be sent')
    .option('--branch <branch>', 'Override auto-detected git branch')
    .option('--debug', 'Enable debug output')
    .action(
      withErrorHandler(async (env: string | undefined, version: string | undefined, options: DeployOptions) => {
        await runDeploy(env, version, options);
      }),
    );
}
