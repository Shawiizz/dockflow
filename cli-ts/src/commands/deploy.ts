/**
 * Deploy command
 *
 * Deploys the application to a Docker Swarm cluster using direct SSH.
 * No Ansible or Docker container needed — all operations go through
 * the ssh2 library from the CLI process.
 *
 * Template rendering is entirely in-memory — no files are written to disk.
 */

import type { Command } from 'commander';
import {
  getProjectRoot,
  loadConfig,
  getPerformer,
  type DockflowConfig,
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

// Services
import { ComposeService, type ParsedCompose, type RenderedFiles } from '../services/compose-service';
import { SwarmDeployService } from '../services/swarm-deploy-service';
import { HealthCheckService } from '../services/health-check-service';
import { ReleaseService } from '../services/release-service';
import { LockService } from '../services/lock-service';
import { AuditService } from '../services/audit-service';
import { MetricsService } from '../services/metrics-service';
import { HistorySyncService } from '../services/history-sync-service';
import { BuildService } from '../services/build-service';
import { DistributionService } from '../services/distribution-service';
import { HookService } from '../services/hook-service';
import { TraefikService } from '../services/traefik-service';

interface DeployOptions {
  services?: string;
  skipBuild?: boolean;
  force?: boolean;
  debug?: boolean;
  accessories?: boolean;
  all?: boolean;
  skipAccessories?: boolean;
  noFailover?: boolean;
  dryRun?: boolean;
  branch?: string;
}

/**
 * Shared context built during the setup phase and passed to each deploy phase.
 */
interface DeployContext {
  env: string;
  config: DockflowConfig;
  stackName: string;
  branchName: string;
  deployVersion: string;
  projectRoot: string;

  managerConn: SSHKeyConnection;
  workerConns: Array<{ connection: SSHKeyConnection; name: string }>;
  otherManagerConns: SSHKeyConnection[];

  deployApp: boolean;
  forceAccessories: boolean;
  skipAccessories: boolean;
  options: Partial<DeployOptions>;

  rendered: RenderedFiles;
  composeContent: string;
  composeDirPath: string;

  // Services
  swarmDeploy: SwarmDeployService;
  health: HealthCheckService;
  releases: ReleaseService;
  lock: LockService;
  audit: AuditService;
  metrics: MetricsService;
}

/**
 * Determine what to deploy based on options
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
  return { deployApp: true, forceAccessories: false, skipAccessories: false };
}

/**
 * Build an SSHKeyConnection from a resolved server
 */
function buildConnection(
  env: string,
  serverName: string,
  host: string,
  port: number,
  user: string,
): SSHKeyConnection {
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
// Deploy phases
// ---------------------------------------------------------------------------

/**
 * Phase: Build Docker images and distribute to Swarm nodes.
 */
async function buildAndDistribute(
  ctx: DeployContext,
  compose: ParsedCompose,
): Promise<string[]> {
  if (ctx.options.skipBuild || !ctx.deployApp) return [];

  await HookService.runLocal('pre-build', ctx.projectRoot, ctx.config, ctx.rendered);

  let builtImages: string[] = [];

  if (ctx.config.options?.remote_build) {
    const result = await BuildService.buildRemote(ctx.managerConn, {
      projectRoot: ctx.projectRoot,
      composeContent: ComposeService.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.services,
    });
    builtImages = result.images;

    if (builtImages.length > 0 && ctx.workerConns.length > 0) {
      const workerTargets = ctx.workerConns.map((w) => ({ connection: w.connection, name: w.name }));
      await DistributionService.distributeFromRemote(builtImages, ctx.managerConn, workerTargets);
    }
  } else {
    const targets = BuildService.getBuildTargets(
      ComposeService.serialize(compose),
      ctx.composeDirPath,
      ctx.options.services,
    );

    if (targets.length > 0) {
      for (const target of targets) {
        target.renderedOverrides = BuildService.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
      }

      const result = await BuildService.buildAll(targets);
      builtImages = result.images;

      if (ctx.config.registry?.enabled && ctx.config.registry.url && ctx.config.registry.password) {
        await DistributionService.registryLogin(ctx.managerConn, {
          url: ctx.config.registry.url,
          username: ctx.config.registry.username,
          password: ctx.config.registry.password,
        });
        await DistributionService.pushImages(builtImages, ctx.config.registry.additional_tags?.length ? {
          tags: ctx.config.registry.additional_tags,
          env: ctx.env,
          version: ctx.deployVersion,
          branch: ctx.branchName,
        } : undefined);
      } else if (builtImages.length > 0) {
        const distTargets = [
          { connection: ctx.managerConn, name: 'manager' },
          ...ctx.workerConns.map((w) => ({ connection: w.connection, name: w.name })),
        ];
        await DistributionService.distributeAll(builtImages, distTargets);
      }
    }
  }

  await HookService.runLocal('post-build', ctx.projectRoot, ctx.config, ctx.rendered);
  return builtImages;
}

/**
 * Phase: Deploy accessories stack (databases, caches, etc.)
 */
async function deployAccessories(ctx: DeployContext): Promise<void> {
  if (ctx.skipAccessories) return;

  const accessoriesRelPath = '.dockflow/docker/accessories.yml';
  const accessoriesContent = ctx.rendered.get(accessoriesRelPath);
  if (!accessoriesContent) return;

  const accessoriesCompose = ComposeService.loadFromString(accessoriesContent);
  ComposeService.injectAccessoriesDefaults(accessoriesCompose);

  const externalNets = ComposeService.getExternalNetworks(accessoriesCompose);
  const externalVols = ComposeService.getExternalVolumes(accessoriesCompose);
  await ctx.swarmDeploy.createExternalResources(externalNets, externalVols);

  await ctx.swarmDeploy.deployAccessories(
    ctx.stackName,
    accessoriesRelPath,
    ComposeService.serialize(accessoriesCompose),
    { force: ctx.forceAccessories },
  );
}

/**
 * Phase: Deploy application stack with health checks.
 */
async function deployApp(ctx: DeployContext, compose: ParsedCompose): Promise<void> {
  if (!ctx.deployApp) return;

  // Ensure Traefik is running if proxy is enabled
  if (ctx.config.proxy?.enabled) {
    const traefik = new TraefikService(ctx.managerConn);
    await traefik.ensureRunning(ctx.config.proxy);
  }

  await HookService.runRemote('pre-deploy', ctx.managerConn, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);

  const externalNetworks = ComposeService.getExternalNetworks(compose);
  const externalVolumes = ComposeService.getExternalVolumes(compose);
  await ctx.swarmDeploy.createExternalResources(externalNetworks, externalVolumes);

  await ctx.swarmDeploy.deployStack(ctx.stackName, ComposeService.serialize(compose));
  await ctx.swarmDeploy.waitConvergence(ctx.stackName);

  // Health checks
  if (ctx.config.health_checks?.enabled !== false) {
    const expectedImages: Record<string, string> = {};
    for (const [svcName, svc] of Object.entries(compose.services)) {
      const img = svc.image as string | undefined;
      if (img) expectedImages[`${ctx.stackName}_${svcName}`] = img;
    }
    await ctx.health.checkSwarmHealth(ctx.stackName, expectedImages, ctx.config.health_checks);

    if (ctx.config.health_checks?.endpoints?.length) {
      await ctx.health.checkHTTPEndpoints(ctx.config.health_checks);
    }
  }

  await HookService.runRemote('post-deploy', ctx.managerConn, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);
}

/**
 * Phase: Record audit, metrics, and sync history to other nodes.
 * Best-effort — never throws.
 */
async function recordHistory(
  ctx: DeployContext,
  status: 'success' | 'failed',
  durationMs: number,
  auditMessage: string,
  workers: Array<{ host: string }>,
): Promise<void> {
  let auditLine = '';
  let metricsJson = '';

  const [auditResult, metricsResult] = await Promise.allSettled([
    ctx.audit.writeEntry(
      ctx.stackName,
      status === 'success' ? 'deployed' : 'failed',
      auditMessage,
      ctx.deployVersion,
    ),
    ctx.metrics.writeDeployment({
      stackName: ctx.stackName,
      version: ctx.deployVersion,
      env: ctx.env,
      branch: ctx.branchName,
      status,
      durationMs,
      performer: getPerformer(),
      buildSkipped: !!ctx.options.skipBuild,
      accessoriesDeployed: !ctx.skipAccessories,
      nodeCount: 1 + workers.length,
    }),
  ]);

  if (auditResult.status === 'fulfilled') {
    auditLine = auditResult.value;
  } else {
    printWarning(`Audit write failed: ${auditResult.reason instanceof Error ? auditResult.reason.message : String(auditResult.reason)}`);
  }

  if (metricsResult.status === 'fulfilled') {
    metricsJson = metricsResult.value;
  } else {
    printWarning(`Metrics write failed: ${metricsResult.reason instanceof Error ? metricsResult.reason.message : String(metricsResult.reason)}`);
  }

  const allOtherConns = [
    ...ctx.otherManagerConns,
    ...ctx.workerConns.map((w) => w.connection),
  ];
  await HistorySyncService.syncToAllNodes(
    allOtherConns,
    ctx.stackName,
    auditLine,
    metricsJson,
  ).catch((e) =>
    printWarning(`History sync failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}

// ---------------------------------------------------------------------------
// Main deploy orchestrator
// ---------------------------------------------------------------------------

/**
 * Run deployment — can be called directly or via CLI command
 */
export async function runDeploy(
  env: string | undefined,
  version: string | undefined,
  options: Partial<DeployOptions>,
): Promise<void> {
  if (options.debug) setVerbose(true);

  // Auto-detect env/version from CI environment when not provided
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

  // --- Load config ---
  let config = loadConfig();
  if (!config) {
    throw new ConfigError(
      'No config.yml found',
      'Run `dockflow init` to create a project configuration.',
    );
  }

  // Wire config-based debug logs
  if (config.options?.enable_debug_logs) setVerbose(true);

  printDebug('Secrets loaded from environment');

  const { deployApp: shouldDeployApp, forceAccessories, skipAccessories } = getDeploymentTargets(
    options as DeployOptions,
  );
  const accessoriesDesc = skipAccessories
    ? ''
    : forceAccessories
      ? ' + Accessories (forced)'
      : ' + Accessories (auto)';
  const targetDesc = options.accessories
    ? 'Accessories only'
    : `App${accessoriesDesc}`;

  printIntro(`Deploying ${targetDesc} to ${env}`);
  printBlank();

  // --- Resolve deployment ---
  const deployment = resolveDeploymentForEnvironment(env);
  if (!deployment) {
    const availableEnvs = getAvailableEnvironments();
    throw new ConfigError(
      `No manager server found for environment "${env}"`,
      availableEnvs.length > 0
        ? `Available environments: ${availableEnvs.join(', ')}`
        : 'Each environment needs a server with role: manager',
    );
  }

  let { manager, managers, workers } = deployment;

  // Multi-manager failover
  if (managers.length > 1 && !options.noFailover) {
    const managerSpinner = createSpinner();
    managerSpinner.start(`Checking ${managers.length} managers for active leader...`);
    const activeResult = await findActiveManager(env, managers, {
      verbose: !!options.debug,
    });
    if (!activeResult) {
      managerSpinner.fail('No reachable managers found');
      throw new ConnectionError(
        'All managers are unreachable. Cannot deploy.',
        `Managers tried: ${managers.map((m) => `${m.name} (${m.host})`).join(', ')}`,
      );
    }
    manager = activeResult.manager;
    if (activeResult.failedManagers.length > 0) {
      managerSpinner.warn(
        `Using ${manager.name} (${activeResult.status}). Unreachable: ${activeResult.failedManagers.join(', ')}`,
      );
    } else {
      managerSpinner.succeed(
        `Using ${manager.name} (${activeResult.status === 'leader' ? 'leader' : 'active manager'})`,
      );
    }
  }

  // --- Build connections ---
  const managerConn = buildConnection(env, manager.name, manager.host, manager.port, manager.user);

  const workerConns: Array<{ connection: SSHKeyConnection; name: string }> = [];
  for (const w of workers) {
    const conn = buildConnection(env, w.name, w.host, w.port, w.user);
    workerConns.push({ connection: conn, name: w.name });
  }

  const otherManagerConns: SSHKeyConnection[] = [];
  for (const m of managers) {
    if (m.name === manager.name) continue;
    try {
      const conn = buildConnection(env, m.name, m.host, m.port, m.user);
      otherManagerConns.push(conn);
    } catch {
      printWarning(`History sync: no SSH key for ${m.name}`);
    }
  }

  // --- Determine version ---
  const branchName = options.branch || getCurrentBranch();
  let deployVersion: string;

  if (version) {
    deployVersion = version;
  } else {
    const versionSpinner = createSpinner();
    versionSpinner.start('Fetching latest deployed version...');
    const connectionString = Buffer.from(
      JSON.stringify(managerConn),
    ).toString('base64');
    const projectName = config.project_name || 'app';
    const latestVersion = await getLatestVersion(
      connectionString,
      projectName,
      env,
      !!options.debug,
    );
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

  // --- Display deployment info ---
  printInfo(`Version: ${deployVersion}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Manager: ${manager.name} (${manager.host})`);
  if (workers.length > 0) {
    printInfo(`Workers: ${workers.map((w) => `${w.name} (${w.host})`).join(', ')}`);
  }
  printInfo(`Branch: ${branchName}`);
  printInfo(`Targets: ${targetDesc}`);
  if (options.services) printInfo(`Services: ${options.services}`);
  printBlank();

  // --- Dry-run ---
  if (options.dryRun) {
    displayDeployDryRun({
      env,
      deployVersion,
      branchName,
      projectRoot,
      manager,
      workers,
      deployApp: shouldDeployApp,
      forceAccessories,
      skipAccessories,
      skipBuild: options.skipBuild,
      force: options.force,
      services: options.services,
      debug: options.debug,
    });
    return;
  }

  // --- Render templates ---
  const templateContext = buildTemplateContext(env, manager.name);
  const { rendered, composeContent, composeDirPath } = ComposeService.renderAndResolveCompose(
    {
      env,
      version: deployVersion,
      branch: branchName,
      project_name: config.project_name,
      config,
    },
    templateContext,
  );

  // Re-parse config from rendered templates (resolves {{ current.env.xxx }})
  config = loadConfig({ content: rendered.get('.dockflow/config.yml'), silent: true }) ?? config;

  // --- Build deploy context ---
  const lock = new LockService(managerConn, stackName);

  const ctx: DeployContext = {
    env, config, stackName, branchName, deployVersion, projectRoot,
    managerConn, workerConns, otherManagerConns,
    deployApp: shouldDeployApp, forceAccessories, skipAccessories,
    options, rendered, composeContent, composeDirPath,
    swarmDeploy: new SwarmDeployService(managerConn),
    health: new HealthCheckService(managerConn),
    releases: new ReleaseService(managerConn),
    lock,
    audit: new AuditService(managerConn),
    metrics: new MetricsService(managerConn),
  };

  // --- Acquire lock ---
  const lockResult = await lock.acquire({
    version: deployVersion,
    force: options.force,
    message: `Deploy ${deployVersion}`,
  });
  if (!lockResult.success) {
    throw new DeployError(lockResult.error.message, ErrorCode.DEPLOY_LOCKED);
  }

  const startTime = Date.now();
  let deployFailed = false;
  let stackDeployed = false;
  let auditMessage = `Deploy ${deployVersion} to ${env}`;

  try {
    // --- Prepare compose ---
    const compose = ComposeService.loadFromString(composeContent);
    ComposeService.updateImageTags(compose, config, env, deployVersion);
    ComposeService.injectSwarmDefaults(compose);
    if (config.proxy?.enabled) {
      ComposeService.injectTraefikLabels(compose, config, stackName, env);
    }

    // --- Build & distribute ---
    await buildAndDistribute(ctx, compose);

    // --- Create release + Deploy accessories (independent, parallel) ---
    const performer = getPerformer();
    await Promise.all([
      ctx.releases.createRelease(stackName, deployVersion, ComposeService.serialize(compose), {
        project_name: config.project_name,
        version: deployVersion,
        env,
        timestamp: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        performer,
        branch: branchName,
      }),
      deployAccessories(ctx),
    ]);

    // --- Deploy app ---
    await deployApp(ctx, compose);
    stackDeployed = ctx.deployApp !== false;

    // --- Cleanup old releases ---
    await ctx.releases.cleanupOldReleases(stackName, config);

    auditMessage = `Deployed ${deployVersion} to ${env} successfully`;
  } catch (err) {
    deployFailed = true;
    auditMessage = `Deploy ${deployVersion} to ${env} failed: ${err instanceof Error ? err.message : String(err)}`;

    await ctx.releases.removeRelease(stackName, deployVersion).catch(() => {});

    if (
      stackDeployed &&
      config.health_checks?.on_failure === 'rollback'
    ) {
      try {
        const rolledBackTo = await ctx.releases.rollback(stackName, ctx.swarmDeploy);
        printWarning(`Rolled back to ${rolledBackTo}`);
      } catch (rollbackErr) {
        printWarning(`Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }

    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    const status = deployFailed ? 'failed' : 'success';

    await recordHistory(ctx, status, durationMs, auditMessage, workers);

    await lock.release().catch((e) =>
      printWarning(`Lock release failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  const totalNodes = managers.length + workers.length;
  printBlank();
  if (totalNodes > 1) {
    printSuccess(
      `Deployment completed! Swarm cluster: ${managers.length} manager(s) + ${workers.length} worker(s)`,
    );
  } else {
    printSuccess('Deployment completed!');
  }
}

/**
 * Register deploy command
 */
export function registerDeployCommand(program: Command): void {
  program
    .command('deploy [env] [version]')
    .description('Deploy application to specified environment (targets Swarm manager)')
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
