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
import type { ClusterNode, SSHKeyConnection } from '../types';

import * as Compose from '../services/compose';
import { createStackBackend, createProxyBackend } from '../services/orchestrator/factory';
import { Release } from '../services/release';
import { Lock } from '../services/lock';
import { Audit } from '../services/audit';
import { Metrics } from '../services/metrics';
import * as Notification from '../services/notification';
import * as Nginx from '../services/nginx';
import * as Hook from '../services/hook';

import type { DeployOptions, DeployContext } from './deploy-context';
import { buildAndDistribute, uploadFiles, rollbackUploads, commitUploads, deployAccessories, deployApp, runHTTPHealthChecks, recordHistory } from './deploy-phases';
import type { UploadRollbackPlan } from './deploy-phases';

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

  // Build cluster
  const managerNode: ClusterNode = {
    connection: buildConnection(env, manager.name, manager.host, manager.port, manager.user),
    name: manager.name,
  };
  const workerNodes: ClusterNode[] = workers.map((w) => ({
    connection: buildConnection(env, w.name, w.host, w.port, w.user),
    name: w.name,
  }));
  const otherManagerNodes: ClusterNode[] = [];
  for (const m of managers) {
    if (m.name === manager.name) continue;
    try { otherManagerNodes.push({ connection: buildConnection(env, m.name, m.host, m.port, m.user), name: m.name }); }
    catch { printWarning(`History sync: no SSH key for ${m.name}`); }
  }
  const cluster = { manager: managerNode, workers: workerNodes, otherManagers: otherManagerNodes };

  // Version resolution
  const branchName = options.branch || getCurrentBranch();
  let deployVersion: string;

  if (version) {
    deployVersion = version;
  } else {
    const versionSpinner = createSpinner();
    versionSpinner.start('Fetching latest deployed version...');
    const connectionString = Buffer.from(JSON.stringify(cluster.manager.connection)).toString('base64');
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
  printInfo(`Manager: ${isVerbose() ? `${manager.name} (${manager.host})` : manager.name}`);
  if (workers.length > 0) printInfo(`Workers: ${workers.map((w) => isVerbose() ? `${w.name} (${w.host})` : w.name).join(', ')}`);
  printInfo(`Branch: ${branchName}`);
  printInfo(`Targets: ${targetDesc}`);
  if (options.only) printInfo(`Only: ${options.only}`);
  printBlank();

  // Dry-run exit
  if (options.dryRun) {
    displayDeployDryRun({
      env, deployVersion, branchName, projectRoot, manager, workers,
      deployApp: shouldDeployApp, forceAccessories, skipAccessories,
      skipBuild: options.skipBuild, force: options.force, only: options.only, debug: options.debug,
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

  // Validate --only service names before acquiring the lock
  if (options.only) {
    const compose = Compose.loadFromString(composeContent);
    const available = Object.keys(compose.services);
    const filterSet = options.only.split(',').map((s) => s.trim());
    const unknown = filterSet.filter(s => !available.includes(s));
    if (unknown.length > 0) {
      throw new DeployError(
        `Unknown service(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`,
        ErrorCode.VALIDATION_FAILED,
        'Use the exact service names defined in your docker-compose file.',
      );
    }
  }

  // Build context
  const orchType = config.orchestrator ?? 'swarm';
  const managerConn = cluster.manager.connection;
  const ctx: DeployContext = {
    env, config, stackName, branchName, deployVersion, projectRoot,
    cluster,
    deployApp: shouldDeployApp, forceAccessories, skipAccessories,
    options, rendered, composeContent, composeDirPath,
    orchestrator: createStackBackend(orchType, managerConn),
    proxyBackend: config.proxy?.enabled ? createProxyBackend(orchType, managerConn) : undefined,
    releases: new Release(managerConn),
    lock: new Lock(managerConn, stackName),
    audit: new Audit(managerConn),
    metrics: new Metrics(managerConn),
  };

  return { ctx };
}

// ---------------------------------------------------------------------------
// Execute — lock, phases, rollback, audit, unlock
// ---------------------------------------------------------------------------

async function execute(ctx: DeployContext): Promise<void> {
  const lockResult = await ctx.lock.acquire({ version: ctx.deployVersion, force: ctx.options.force, message: `Deploy ${ctx.deployVersion}` });
  if (!lockResult.success) throw new DeployError(lockResult.error.message, ErrorCode.DEPLOY_LOCKED);

  const startTime = Date.now();
  let deployFailed = false;
  let stackDeployed = false;
  let uploadPlan: UploadRollbackPlan | null = null;
  let previousSymlink: string | null = null;
  let auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env}`;

  try {
    const compose = Compose.loadFromString(ctx.composeContent);

    Compose.updateImageTags(compose, ctx.config, ctx.env, ctx.deployVersion, ctx.options.only);

    await buildAndDistribute(ctx, compose);

    uploadPlan = await uploadFiles(ctx);

    // When --only targets specific services, build the release from the local
    // compose (preserves new services and config changes) but borrow image tags
    // from the server release for non-targeted services so the release reflects
    // what is actually running for those services.
    // Falls back to the local compose as-is if no release exists yet.
    let releaseCompose = compose;
    if (ctx.options.only) {
      const currentContent = await ctx.releases.getCurrentComposeContent(ctx.stackName);
      if (currentContent) {
        const filter = ctx.options.only.split(',').map((s: string) => s.trim());
        releaseCompose = Compose.syncNonTargetedImageTags(compose, Compose.loadFromString(currentContent), filter);
      }
    }

    const [releaseResult] = await Promise.all([
      ctx.releases.createRelease(ctx.stackName, ctx.deployVersion, Compose.serialize(releaseCompose), {
        project_name: ctx.config.project_name, version: ctx.deployVersion, env: ctx.env,
        timestamp: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000),
        performer: getPerformer(), branch: ctx.branchName,
      }),
      deployAccessories(ctx),
    ]);
    previousSymlink = releaseResult.previousSymlink;

    await deployApp(ctx, compose);
    stackDeployed = ctx.deployApp !== false;

    await runHTTPHealthChecks(ctx);

    await Nginx.deployNginxTemplates(ctx.cluster.manager.connection, ctx.rendered);
    await Hook.runRemote('post-deploy', ctx.cluster.manager.connection, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);

    await Promise.all([
      ctx.releases.cleanupOldReleases(ctx.stackName, ctx.config),
      commitUploads(uploadPlan).catch((e) => printWarning(`Upload commit failed: ${e instanceof Error ? e.message : String(e)}`)),
    ]);
    auditMessage = `Deployed ${ctx.deployVersion} to ${ctx.env} successfully`;
  } catch (err) {
    deployFailed = true;
    auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env} failed: ${err instanceof Error ? err.message : String(err)}`;

    if (uploadPlan) {
      await rollbackUploads(uploadPlan).catch((e) => printWarning(`Upload rollback failed: ${e instanceof Error ? e.message : String(e)}`));
    }

    if (stackDeployed && ctx.config.health_checks?.on_failure === 'rollback') {
      // rollback() handles its own cleanup — calling removeRelease first would delete the failed release before rollback can list it.
      try { printWarning(`Rolled back to ${await ctx.releases.rollback(ctx.stackName, ctx.orchestrator, ctx.deployVersion, previousSymlink)}`); }
      catch (e) {
        printWarning(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`);
        await ctx.releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
      }
    } else {
      await ctx.releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
    }
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    const status = deployFailed ? 'failed' : 'success';

    await recordHistory(ctx, status, durationMs, auditMessage);
    await Notification.notify(ctx.config.notifications?.webhooks, {
      project: ctx.config.project_name, env: ctx.env, version: ctx.deployVersion,
      branch: ctx.branchName, performer: getPerformer(), status, duration_ms: durationMs, message: auditMessage,
    });
    await ctx.lock.release().catch((e) => printWarning(`Lock release failed: ${e instanceof Error ? e.message : String(e)}`));
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
    .option('--dry-run', 'Show what would be deployed without executing')
    .option('--branch <branch>', 'Override auto-detected git branch')
    .option('--debug', 'Enable debug output')
    .action(
      withErrorHandler(async (env: string | undefined, version: string | undefined, options: DeployOptions) => {
        await runDeploy(env, version, options);
      }),
    );
}
