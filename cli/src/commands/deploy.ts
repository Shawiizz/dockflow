/**
 * Deploy command
 *
 * Deploys the application to a cluster using direct SSH.
 * Setup resolution, phase execution, and types are split into:
 *   deploy-context.ts  — DeployContext interface
 *   deploy-phases.ts   — build, accessories, app, audit phases
 *   deploy-dry-run.ts  — dry-run display
 */

import type { Command } from 'commander';
import {
  getProjectRoot,
  loadConfig,
  getPerformer,
} from '../utils/config';
import {
  printSuccess,
  printInfo,
  printIntro,
  printDebug,
  printBlank,
  printWarning,
  setVerbose,
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
import { resolveEnvironmentPrefix } from '../utils/validation';
import { detectCIEnvironment, resolveDeployParams } from '../utils/ci';
import { getCurrentBranch } from '../utils/git';
import { getLatestVersion, incrementVersion } from '../utils/version';
import {
  ConfigError,
  ConnectionError,
  DeployError,
  ErrorCode,
  withErrorHandler,
} from '../utils/errors';
import { displayDeployDryRun } from './deploy-dry-run';
import type { SSHKeyConnection } from '../types';

import * as Compose from '../services/compose';
import { createStackBackend, createProxyBackend } from '../services/orchestrator/factory';
import { Release } from '../services/release';
import { Lock } from '../services/lock';
import { Audit } from '../services/audit';
import { Metrics } from '../services/metrics';
import * as Notification from '../services/notification';

import type { DeployOptions, DeployContext } from './deploy-context';
import { buildAndDistribute, deployAccessories, deployApp, recordHistory } from './deploy-phases';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeploymentTargets(options: DeployOptions) {
  if (options.skipAccessories) return { deployApp: true, forceAccessories: false, skipAccessories: true };
  if (options.all) return { deployApp: true, forceAccessories: true, skipAccessories: false };
  if (options.accessories) return { deployApp: false, forceAccessories: true, skipAccessories: false };
  return { deployApp: true, forceAccessories: false, skipAccessories: false };
}

function buildConnection(env: string, serverName: string, host: string, port: number, user: string): SSHKeyConnection {
  const privateKey = getServerPrivateKey(env, serverName);
  if (!privateKey) {
    throw new ConnectionError(
      `No SSH private key found for "${serverName}"`,
      `Expected CI secret: ${env.toUpperCase()}_${serverName.toUpperCase()}_CONNECTION`,
    );
  }
  const password = getServerPassword(env, serverName);
  return { host, port, user, privateKey, password: password || undefined };
}

// ---------------------------------------------------------------------------
// Setup — resolve env, config, connections, version, render templates
// ---------------------------------------------------------------------------

async function resolveSetup(rawEnv: string | undefined, rawVersion: string | undefined, options: Partial<DeployOptions>) {
  let env = rawEnv;
  let version = rawVersion;

  if (!env) {
    const ci = detectCIEnvironment();
    if (ci) {
      const params = resolveDeployParams(ci);
      env = params.env;
      version = version ?? params.version;
      printInfo(`CI detected (${ci.provider}): deploying to ${env} with version ${version}`);
    } else {
      throw new ConfigError(
        'Environment is required',
        'Usage: dockflow deploy <env> [version]\nIn CI, environment and version are auto-detected from git tag/branch.',
      );
    }
  }

  loadSecrets();

  let config = loadConfig();
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

  let { manager, managers, workers } = deployment;

  // Multi-manager failover
  if (managers.length > 1 && !options.noFailover) {
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
  }

  // Build SSH connections
  const managerConn = buildConnection(env, manager.name, manager.host, manager.port, manager.user);

  const workerConns = workers.map((w) => ({ connection: buildConnection(env, w.name, w.host, w.port, w.user), name: w.name }));

  const otherManagerConns: SSHKeyConnection[] = [];
  for (const m of managers) {
    if (m.name === manager.name) continue;
    try { otherManagerConns.push(buildConnection(env, m.name, m.host, m.port, m.user)); }
    catch { printWarning(`History sync: no SSH key for ${m.name}`); }
  }

  // Version resolution
  const branchName = options.branch || getCurrentBranch();
  let deployVersion: string;

  if (version) {
    deployVersion = version;
  } else {
    const versionSpinner = createSpinner();
    versionSpinner.start('Fetching latest deployed version...');
    const connectionString = Buffer.from(JSON.stringify(managerConn)).toString('base64');
    const latestVersion = await getLatestVersion(connectionString, config.project_name || 'app', env, !!options.debug);
    if (latestVersion) {
      deployVersion = incrementVersion(latestVersion);
      versionSpinner.succeed(`Latest version: ${latestVersion} → New version: ${deployVersion}`);
    } else {
      deployVersion = '1.0.0';
      versionSpinner.info('No previous deployment found, starting at 1.0.0');
    }
  }

  const stackName = `${config.project_name}-${env}`;
  const projectRoot = getProjectRoot();

  // Display info
  printInfo(`Version: ${deployVersion}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Manager: ${manager.name} (${manager.host})`);
  if (workers.length > 0) printInfo(`Workers: ${workers.map((w) => `${w.name} (${w.host})`).join(', ')}`);
  printInfo(`Branch: ${branchName}`);
  printInfo(`Targets: ${targetDesc}`);
  if (options.services) printInfo(`Services: ${options.services}`);
  printBlank();

  // Dry-run exit
  if (options.dryRun) {
    displayDeployDryRun({
      env, deployVersion, branchName, projectRoot, manager, workers,
      deployApp: shouldDeployApp, forceAccessories, skipAccessories,
      skipBuild: options.skipBuild, force: options.force, services: options.services, debug: options.debug,
    });
    return null;
  }

  // Render templates
  const templateContext = buildTemplateContext(env, manager.name);
  const { rendered, composeContent, composeDirPath } = Compose.renderAndResolveCompose(
    { env, version: deployVersion, branch: branchName, project_name: config.project_name, config },
    templateContext,
  );
  config = loadConfig({ content: rendered.get('.dockflow/config.yml'), silent: true }) ?? config;

  // Build context
  const orchType = config.orchestrator ?? 'swarm';
  const ctx: DeployContext = {
    env, config, stackName, branchName, deployVersion, projectRoot,
    managerConn, workerConns, otherManagerConns,
    deployApp: shouldDeployApp, forceAccessories, skipAccessories,
    options, rendered, composeContent, composeDirPath,
    orchestrator: createStackBackend(orchType, managerConn),
    proxyBackend: config.proxy?.enabled ? createProxyBackend(orchType, managerConn) : undefined,
    releases: new Release(managerConn),
    lock: new Lock(managerConn, stackName),
    audit: new Audit(managerConn),
    metrics: new Metrics(managerConn),
  };

  return { ctx, managers, workers };
}

// ---------------------------------------------------------------------------
// Execute — lock, phases, rollback, audit, unlock
// ---------------------------------------------------------------------------

async function execute(
  ctx: DeployContext,
  managers: Array<{ name: string; host: string; port: number; user: string }>,
  workers: Array<{ name: string; host: string; port: number; user: string }>,
): Promise<void> {
  const lockResult = await ctx.lock.acquire({ version: ctx.deployVersion, force: ctx.options.force, message: `Deploy ${ctx.deployVersion}` });
  if (!lockResult.success) throw new DeployError(lockResult.error.message, ErrorCode.DEPLOY_LOCKED);

  const startTime = Date.now();
  let deployFailed = false;
  let stackDeployed = false;
  let auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env}`;

  try {
    const compose = Compose.loadFromString(ctx.composeContent);
    Compose.updateImageTags(compose, ctx.config, ctx.env, ctx.deployVersion);

    await buildAndDistribute(ctx, compose);

    await Promise.all([
      ctx.releases.createRelease(ctx.stackName, ctx.deployVersion, Compose.serialize(compose), {
        project_name: ctx.config.project_name, version: ctx.deployVersion, env: ctx.env,
        timestamp: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000),
        performer: getPerformer(), branch: ctx.branchName,
      }),
      deployAccessories(ctx),
    ]);

    await deployApp(ctx, compose);
    stackDeployed = ctx.deployApp !== false;

    await ctx.releases.cleanupOldReleases(ctx.stackName, ctx.config);
    auditMessage = `Deployed ${ctx.deployVersion} to ${ctx.env} successfully`;
  } catch (err) {
    deployFailed = true;
    auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env} failed: ${err instanceof Error ? err.message : String(err)}`;
    await ctx.releases.removeRelease(ctx.stackName, ctx.deployVersion).catch(() => {});

    if (stackDeployed && ctx.config.health_checks?.on_failure === 'rollback') {
      try { printWarning(`Rolled back to ${await ctx.releases.rollback(ctx.stackName, ctx.orchestrator)}`); }
      catch (e) { printWarning(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    const status = deployFailed ? 'failed' : 'success';

    await recordHistory(ctx, status, durationMs, auditMessage, workers);
    await Notification.notify(ctx.config.notifications?.webhooks, {
      project: ctx.config.project_name, env: ctx.env, version: ctx.deployVersion,
      branch: ctx.branchName, performer: getPerformer(), status, duration_ms: durationMs, message: auditMessage,
    });
    await ctx.lock.release().catch((e) => printWarning(`Lock release failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  const totalNodes = managers.length + workers.length;
  printBlank();
  printSuccess(totalNodes > 1
    ? `Deployment completed! Cluster: ${managers.length} manager(s) + ${workers.length} worker(s)`
    : 'Deployment completed!');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runDeploy(env: string | undefined, version: string | undefined, options: Partial<DeployOptions>): Promise<void> {
  if (options.debug) setVerbose(true);
  const setup = await resolveSetup(env, version, options);
  if (!setup) return;
  await execute(setup.ctx, setup.managers, setup.workers);
}

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy [env] [version]')
    .description('Deploy application to specified environment')
    .helpGroup('Deploy')
    .option('--services <services>', 'Comma-separated list of services to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .option('--accessories', 'Deploy only accessories (databases, caches, etc.)')
    .option('--all', 'Deploy both application and accessories')
    .option('--skip-accessories', 'Skip accessories check entirely')
    .option('--no-failover', 'Disable multi-manager failover (use first manager only)')
    .option('--dry-run', 'Show what would be deployed without executing')
    .option('--branch <branch>', 'Override auto-detected git branch')
    .option('--debug', 'Enable debug output')
    .action(
      withErrorHandler(async (env: string | undefined, version: string | undefined, options: DeployOptions) => {
        await runDeploy(env, version, options);
      }),
    );
}
