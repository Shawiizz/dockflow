/**
 * Deploy command
 *
 * Deploys the application to a cluster using direct SSH.
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
import { resolveEnvironmentPrefix } from '../utils/validation';
import { detectCIEnvironment, resolveDeployParams } from '../utils/ci';
import { getCurrentBranch } from '../utils/git';
import { getLatestVersion, incrementVersion } from '../utils/version';
import { sshExec } from '../utils/ssh';
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
import { createOrchestrator, createHealthBackend } from '../services/orchestrator/factory';
import type { OrchestratorService } from '../services/orchestrator/interface';
import type { HealthBackend } from '../services/orchestrator/health-interface';
import { HealthCheckService } from '../services/health-check-service';
import { ReleaseService } from '../services/release-service';
import { LockService } from '../services/lock-service';
import { AuditService } from '../services/audit-service';
import { MetricsService } from '../services/metrics-service';
import { HistorySyncService } from '../services/history-sync-service';
import { BuildService } from '../services/build-service';
import { DistributionService, type ContainerRuntime } from '../services/distribution-service';
import { HookService } from '../services/hook-service';
import { TraefikService } from '../services/traefik-service';
import { K3sTraefikService } from '../services/k3s-traefik-service';
import { K8sManifestService } from '../services/k8s-manifest-service';
import { NotificationService } from '../services/notification-service';
import { CONVERGENCE_TIMEOUT_S, CONVERGENCE_INTERVAL_S } from '../constants';

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
  orchestrator: OrchestratorService;
  healthBackend: HealthBackend;
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
 * Detect which container engine (docker or podman) is available on the remote.
 * If a config override is set, use it directly.
 */
async function detectContainerEngine(
  conn: SSHKeyConnection,
  configEngine?: 'docker' | 'podman',
): Promise<'docker' | 'podman'> {
  if (configEngine) return configEngine;

  const podman = await sshExec(conn, 'which podman 2>/dev/null');
  if (podman.exitCode === 0) return 'podman';

  return 'docker';
}

/**
 * Phase: Build Docker images and distribute to nodes.
 */
async function buildAndDistribute(
  ctx: DeployContext,
  compose: ParsedCompose,
): Promise<string[]> {
  if (ctx.options.skipBuild || !ctx.deployApp) return [];

  await HookService.runLocal('pre-build', ctx.projectRoot, ctx.config, ctx.rendered);

  // Determine container engine (podman vs docker) — auto-detect or config override
  const engine = await detectContainerEngine(ctx.managerConn, ctx.config.container_engine);
  const runtime: ContainerRuntime = ctx.config.orchestrator === 'k3s' ? 'containerd' : engine;
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
      engine,
    });
    builtImages = result.images;

    if (builtImages.length > 0 && ctx.workerConns.length > 0) {
      const workerTargets = ctx.workerConns.map((w) => ({ connection: w.connection, name: w.name }));
      await DistributionService.distributeFromRemote(builtImages, ctx.managerConn, workerTargets, runtime);
    }
  } else {
    const targets = BuildService.getBuildTargets(
      ComposeService.serialize(compose),
      ctx.composeDirPath,
      ctx.options.services,
    );

    if (targets.length > 0) {
      // Detect remote arch for cross-compilation if needed
      const archResult = await sshExec(ctx.managerConn, 'uname -m');
      const remoteArch = archResult.stdout.trim();
      const platform = (remoteArch === 'aarch64' || remoteArch === 'arm64') ? 'linux/arm64' : 'linux/amd64';

      for (const target of targets) {
        target.renderedOverrides = BuildService.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
        target.platform = platform;
        target.engine = engine;
      }

      const result = await BuildService.buildAll(targets);
      builtImages = result.images;

      if (ctx.config.registry?.enabled && ctx.config.registry.url && ctx.config.registry.password) {
        await DistributionService.registryLogin(ctx.managerConn, {
          url: ctx.config.registry.url,
          username: ctx.config.registry.username,
          password: ctx.config.registry.password,
        }, engine);
        await DistributionService.pushImages(builtImages, ctx.config.registry.additional_tags?.length ? {
          tags: ctx.config.registry.additional_tags,
          env: ctx.env,
          version: ctx.deployVersion,
          branch: ctx.branchName,
        } : undefined, engine);
      } else if (builtImages.length > 0) {
        const distTargets = [
          { connection: ctx.managerConn, name: 'manager' },
          ...ctx.workerConns.map((w) => ({ connection: w.connection, name: w.name })),
        ];
        await DistributionService.distributeAll(builtImages, distTargets, runtime);
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

  await ctx.orchestrator.prepareInfrastructure(ctx.stackName, ComposeService.serialize(accessoriesCompose));

  const accessoriesYaml = ctx.config.orchestrator === 'k3s'
    ? K8sManifestService.composeToManifests(ctx.stackName, accessoriesCompose)
    : ComposeService.serialize(accessoriesCompose);

  const result = await ctx.orchestrator.deployAccessory(
    ctx.stackName,
    accessoriesYaml,
    accessoriesRelPath,
    { force: ctx.forceAccessories },
  );

  if (!result.success) {
    throw result.error;
  }
}

/**
 * Phase: Deploy application stack with health checks.
 */
async function deployApp(ctx: DeployContext, compose: ParsedCompose): Promise<void> {
  if (!ctx.deployApp) return;

  // Ensure Traefik is running if proxy is enabled
  if (ctx.config.proxy?.enabled) {
    const traefik = ctx.config.orchestrator === 'k3s'
      ? new K3sTraefikService(ctx.managerConn)
      : new TraefikService(ctx.managerConn);
    await traefik.ensureRunning(ctx.config.proxy);
  }

  await HookService.runRemote('pre-deploy', ctx.managerConn, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);

  // Prepare infrastructure (external networks/volumes for Swarm, no-op for k3s)
  await ctx.orchestrator.prepareInfrastructure(ctx.stackName, ComposeService.serialize(compose));

  // Convert to K8s manifests if using k3s, otherwise use compose YAML
  const deployContent = ctx.config.orchestrator === 'k3s'
    ? K8sManifestService.composeToManifests(ctx.stackName, compose, ctx.config.proxy)
    : ComposeService.serialize(compose);

  const deployResult = await ctx.orchestrator.deployStack(ctx.stackName, deployContent, '');
  if (!deployResult.success) {
    throw deployResult.error;
  }

  const convergence = await ctx.orchestrator.waitConvergence(
    ctx.stackName,
    CONVERGENCE_TIMEOUT_S,
    CONVERGENCE_INTERVAL_S,
  );
  if (!convergence.converged) {
    if (convergence.rolledBack) {
      throw new DeployError(
        'Orchestrator auto-rolled back the deployment',
        ErrorCode.HEALTH_CHECK_FAILED,
        'Check service logs to understand why the new version failed.',
      );
    }
    throw new DeployError(
      'Service convergence timed out',
      ErrorCode.DEPLOY_FAILED,
      'Check service logs with `dockflow logs <service>` for details.',
    );
  }

  // Health checks
  if (ctx.config.health_checks?.enabled !== false) {
    const health = new HealthCheckService(ctx.managerConn, ctx.healthBackend);
    const internalResult = await health.checkInternalHealth(ctx.stackName, ctx.config.health_checks);
    if (!internalResult.healthy) {
      throw new DeployError(
        internalResult.message || `Health check failed${internalResult.failedService ? `: ${internalResult.failedService}` : ''}`,
        ErrorCode.HEALTH_CHECK_FAILED,
        'Check service logs with `dockflow logs <service>` for details.',
      );
    }

    if (ctx.config.health_checks?.endpoints?.length) {
      await health.checkHTTPEndpoints(ctx.config.health_checks);
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

  // Resolve environment prefix (pr → production)
  env = resolveEnvironmentPrefix(env);

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
  const orchType = config.orchestrator ?? 'swarm';

  const ctx: DeployContext = {
    env, config, stackName, branchName, deployVersion, projectRoot,
    managerConn, workerConns, otherManagerConns,
    deployApp: shouldDeployApp, forceAccessories, skipAccessories,
    options, rendered, composeContent, composeDirPath,
    orchestrator: createOrchestrator(orchType, managerConn),
    healthBackend: createHealthBackend(orchType, managerConn),
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
    if (config.orchestrator !== 'k3s') {
      ComposeService.injectSwarmDefaults(compose);
    }
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
        const rolledBackTo = await ctx.releases.rollback(stackName, ctx.orchestrator);
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

    // Notify webhooks — best-effort, never blocks
    await NotificationService.notify(config.notifications?.webhooks, {
      project: config.project_name,
      env,
      version: deployVersion,
      branch: branchName,
      performer: getPerformer(),
      status,
      duration_ms: durationMs,
      message: auditMessage,
    });

    await lock.release().catch((e) =>
      printWarning(`Lock release failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  const totalNodes = managers.length + workers.length;
  printBlank();
  if (totalNodes > 1) {
    printSuccess(
      `Deployment completed! Cluster: ${managers.length} manager(s) + ${workers.length} worker(s)`,
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
