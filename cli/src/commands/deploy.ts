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
import type { ClusterNode, SSHKeyConnection } from '../types';

import * as Compose from '../services/compose';
import { createStackBackend, createProxyBackend } from '../services/orchestrator/factory';
import { assertReleaseName, Release, releaseEpoch } from '../services/release';
import { createEnvLock } from '../services/lock';
import { Audit } from '../services/audit';
import { Metrics } from '../services/metrics';
import * as Notification from '../services/notification';
import * as Plugin from '../services/plugin';
import { onInterrupt, SIGINT_EXIT_CODE } from '../utils/interrupt';
import { sshShell } from '../utils/remote-shell';

import type { DeployOptions, DeployContext } from './deploy-context';
import { accessoriesKey, applyPublicPorts, composeWithImageTags, keepRunningImageTags, rolledBackError, failureOutcome, cleanupManager, buildAndDistribute, loginManagerToRegistry, runDeployHook, uploadFiles, checkUploadPermissions, rollbackUploads, commitUploads, ensureExternalNetworks, deployAccessories, deployApp, runHTTPHealthChecks, runPostRollbackHealthChecks, cleanupFailedImages, recordHistory } from './deploy-phases';
import type { AppProgress, BuildResult } from './deploy-phases';
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

  let { manager, managers, workers } = deployment;
  let unavailableManagers: string[] = [];

  if (options.server) {
    const chosen = chooseServer(env, [...managers, ...workers], options.server, {}, () => true);
    if ('type' in chosen) throw new ConfigError(chosen.message, chosen.suggestion);
    manager = managers.find((m) => m.name === chosen.name) ?? manager;
  }

  // Multi-manager failover
  if (managers.length > 1 && options.failover !== false && !options.server) {
    const managerSpinner = createSpinner();
    managerSpinner.start(`Checking ${managers.length} managers for active leader...`);
    const activeResult = await findActiveManager(env, managers, { verbose: !!options.debug });
    if (!activeResult) {
      managerSpinner.fail('No reachable managers found');
      throw new ConnectionError('All managers are unreachable. Cannot deploy.', `Managers tried: ${managers.map((m) => `${m.name} (${m.host})`).join(', ')}`);
    }
    manager = activeResult.manager;
    unavailableManagers = activeResult.unavailable;
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
    // a manager found down cannot run tasks: it gets no image or upload
    if (m.name === manager.name || unavailableManagers.includes(m.name)) continue;
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
    let latestVersion: string | null;
    try {
      latestVersion = await new Release(cluster.manager.connection).latestVersion(`${config.project_name}-${env}`);
    } catch (e) {
      // starting over at 1.0.0 would overwrite a release that exists
      versionSpinner.fail('Could not read the deployed versions');
      throw e;
    }
    if (latestVersion) {
      deployVersion = incrementVersion(latestVersion);
      versionSpinner.succeed(`Latest version: ${latestVersion} → New version: ${deployVersion}`);
    } else {
      deployVersion = '1.0.0';
      versionSpinner.info('No previous deployment found, starting at 1.0.0');
    }
  }

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

  // proxy.routes name services of both compose files: check them before anything is built,
  // dry runs included
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

  // Validate --only service names before anything else, dry runs included (no_services has no Docker services)
  if (options.only && !config.no_services) {
    const compose = Compose.loadFromString(composeContent, 'docker-compose.yml');
    const available = Object.keys(compose.services);
    const filterSet = options.only.split(',').map((s) => s.trim()).filter(Boolean);
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
  const managerConn = cluster.manager.connection;
  const ctx: DeployContext = {
    env, config, stackName, branchName, deployVersion, projectRoot,
    cluster,
    deployApp: shouldDeployApp, forceAccessories, skipAccessories,
    options, rendered, composeContent, composeDirPath,
    orchestrator: createStackBackend(managerConn),
    proxyBackend: config.proxy?.enabled ? createProxyBackend(managerConn) : undefined,
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
// Execute — lock, phases, rollback, audit, unlock
// ---------------------------------------------------------------------------

async function execute(ctx: DeployContext): Promise<void> {
  const lockResult = await ctx.lock.acquire({ version: ctx.deployVersion, force: ctx.options.force, message: `Deploy ${ctx.deployVersion}` });
  // DEPLOY_LOCKED only when another deploy holds it: a manager that does not answer has its own code
  if (!lockResult.success) throw lockResult.error;
  ctx.lock.keepAlive();

  const startTime = Date.now();
  let deployFailed = false;
  const app: AppProgress = { sent: false, swarmRolledBack: false };
  let uploadPlan: UploadRollbackPlan | null = null;
  let previousSymlink: string | null = null;
  let buildResult: BuildResult | null = null;
  let auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env}`;
  let releaseCreated = false;
  // the stack deploy was sent: from then on Swarm may run the new version, whatever happens here
  let applyStarted = false;
  let interrupted = false;

  const handleSignal = () => {
    if (interrupted) return;
    interrupted = true;
    printWarning(`\nDeploy interrupted — cleaning up before exit...`);
    (async () => {
      if (uploadPlan) await rollbackUploads(uploadPlan).catch(() => {});
      if (releaseCreated && !applyStarted) {
        await ctx.releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
      } else if (applyStarted) {
        printWarning(`Version ${ctx.deployVersion} was sent to Swarm but its state is unknown; run dockflow status ${ctx.env}`);
      }
      await ctx.lock.release().catch(() => {});
    })().finally(() => process.exit(SIGINT_EXIT_CODE));
  };

  const stopHandlingInterrupts = onInterrupt(handleSignal);

  try {
    let compose = composeWithImageTags(ctx);

    await checkUploadPermissions(ctx);

    buildResult = await buildAndDistribute(ctx, compose);

    await runDeployHook(ctx, 'pre-upload');

    uploadPlan = await uploadFiles(ctx);

    await runDeployHook(ctx, 'post-upload');

    await runDeployHook(ctx, 'pre-deploy');

    compose = await keepRunningImageTags(ctx, compose);

    await applyPublicPorts(ctx);

    await ensureExternalNetworks(ctx);

    await loginManagerToRegistry(ctx);

    // The whole stack, even under --only: a rollback restores every service.
    const renderedStack = ctx.orchestrator.render({
      stackName: ctx.stackName, env: ctx.env, compose, proxy: ctx.config.proxy,
    });

    const now = new Date();
    const storedReleases = await ctx.releases.listReleases(ctx.stackName);

    // Settled, not Promise.all: when accessories fail first, the release write
    // must still hand back the symlink to restore, or cleanup deletes `current`.
    // `deploy --accessories` leaves the app and its release history alone
    const [releaseOutcome, accessoriesOutcome] = await Promise.allSettled([
      !ctx.deployApp ? Promise.resolve({ previousSymlink: null }) : ctx.releases.createRelease(ctx.stackName, ctx.deployVersion, Compose.serialize(compose), renderedStack, {
        project_name: ctx.config.project_name, version: ctx.deployVersion, env: ctx.env,
        timestamp: now.toISOString(), epoch: releaseEpoch(now, storedReleases),
        performer: getPerformer(), branch: ctx.branchName,
      }),
      deployAccessories(ctx),
    ]);
    if (releaseOutcome.status === 'rejected') throw releaseOutcome.reason;
    previousSymlink = releaseOutcome.value.previousSymlink;
    releaseCreated = ctx.deployApp;
    if (accessoriesOutcome.status === 'rejected') throw accessoriesOutcome.reason;

    applyStarted = true;
    await deployApp(ctx, compose, app);


    await runHTTPHealthChecks(ctx);
    await runDeployHook(ctx, 'post-deploy');

    await Promise.all([
      // the deploy succeeded: housekeeping failures are reported, never a reason to roll back
      ctx.deployApp && ctx.releases.cleanupOldReleases(ctx.stackName, ctx.config, [...ctx.cluster.otherManagers, ...ctx.cluster.workers].map((node) => sshShell(node.connection))).catch((e) => printWarning(`Old releases cleanup failed: ${e instanceof Error ? e.message : String(e)}`)),
      commitUploads(uploadPlan).catch((e) => printWarning(`Upload commit failed: ${e instanceof Error ? e.message : String(e)}`)),
    ]);
    auditMessage = `Deployed ${ctx.deployVersion} to ${ctx.env} successfully`;
  } catch (err) {
    deployFailed = true;
    auditMessage = `Deploy ${ctx.deployVersion} to ${ctx.env} failed: ${err instanceof Error ? err.message : String(err)}`;

    if (uploadPlan) {
      await rollbackUploads(uploadPlan).catch((e) => printWarning(`Upload rollback failed: ${e instanceof Error ? e.message : String(e)}`));
    }

    let rolledBackTo: string | null = null;
    const outcome = failureOutcome(app, ctx.config.health_checks?.on_failure, previousSymlink !== null);
    const needsManager = outcome === 'rollback' || (outcome === 'forget' && releaseCreated);
    const through = needsManager ? await cleanupManager(ctx.cluster) : ctx.cluster.manager;
    if (!through) {
      printWarning(`No manager answers: ${ctx.deployVersion} could not be cleaned up. Run \`dockflow status ${ctx.env}\` once the cluster is back.`);
    } else if (through !== ctx.cluster.manager) {
      printWarning(`${ctx.cluster.manager.name} no longer answers: cleaning up through ${through.name}`);
    }
    const lost = through !== null && through !== ctx.cluster.manager;
    const releases = lost ? new Release(through.connection) : ctx.releases;
    const orchestrator = lost ? createStackBackend(through.connection) : ctx.orchestrator;

    if (through && outcome === 'rollback' && previousSymlink) {
      // rollback() handles its own cleanup — calling removeRelease first would delete the failed release before rollback can list it.
      try {
        const rollbackStartedAt = new Date();
        rolledBackTo = await releases.rollback(ctx.stackName, orchestrator, ctx.deployVersion, previousSymlink);
        printWarning(`Rolled back to ${rolledBackTo}`);
        await runPostRollbackHealthChecks(through.connection, orchestrator, ctx.stackName, ctx.config.health_checks, rollbackStartedAt);
      }
      catch (e) {
        printWarning(
          `Rollback failed: ${e instanceof Error ? e.message : String(e)}\n` +
          `The cluster may be in an inconsistent state. Run 'dockflow status' to check what is running.`
        );
        await releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
      }
    } else if (outcome === 'keep') {
      printWarning(`${ctx.deployVersion} reached Swarm and is what runs now: it stays the current release. Check it with \`dockflow status ${ctx.env}\`.`);
    } else if (through && releaseCreated) {
      // only a record this deploy wrote: before that, the version's directory may be the running release
      await releases.removeRelease(ctx.stackName, ctx.deployVersion, previousSymlink).catch(() => {});
    }

    // after the rollback: until then the failed tasks' containers hold the images
    if (buildResult && ctx.config.stack_management?.cleanup_on_failure !== false) {
      await cleanupFailedImages(buildResult, [ctx.cluster.manager, ...ctx.cluster.otherManagers, ...ctx.cluster.workers]).catch(() => {});
    }

    // Runs last so it observes the settled state. runHook never lets an
    // on-failure entry abort, and this catch keeps the original error on top.
    await runDeployHook(ctx, 'on-failure', {
      DOCKFLOW_ERROR: err instanceof Error ? err.message : String(err),
      DOCKFLOW_ROLLED_BACK_TO: rolledBackTo ?? '',
    }).catch((e) => printWarning(`on-failure hooks could not run: ${e instanceof Error ? e.message : String(e)}`));

    if (rolledBackTo) throw rolledBackError(err, rolledBackTo);
    throw err;
  } finally {
    stopHandlingInterrupts();
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
