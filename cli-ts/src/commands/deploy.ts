/**
 * Deploy command
 *
 * Deploys the application to a Docker Swarm cluster using direct SSH.
 * No Ansible or Docker container needed — all operations go through
 * the ssh2 library from the CLI process.
 *
 * Template rendering is entirely in-memory — no files are written to disk.
 */

import os from 'os';
import { dirname, relative } from 'path';
import type { Command } from 'commander';
import {
  getProjectRoot,
  loadConfig,
  getComposePath,
} from '../utils/config';
import {
  printSuccess,
  printInfo,
  printIntro,
  printDebug,
  printBlank,
  printWarning,
  printDim,
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
import { ComposeService } from '../services/compose-service';
import type { ComposeRenderContext } from '../services/compose-service';
import { SwarmDeployService } from '../services/swarm-deploy-service';
import { HealthCheckService } from '../services/health-check-service';
import { ReleaseService } from '../services/release-service';
import { LockService } from '../services/lock-service';
import { AuditService } from '../services/audit-service';
import { MetricsWriteService } from '../services/metrics-service';
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

/**
 * Run deployment — can be called directly or via CLI command
 */
export async function runDeploy(
  env: string,
  version: string | undefined,
  options: Partial<DeployOptions>,
): Promise<void> {
  if (options.debug) setVerbose(true);

  loadSecrets();
  printDebug('Secrets loaded from environment');

  const { deployApp, forceAccessories, skipAccessories } = getDeploymentTargets(
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

  // --- Load config ---
  const config = loadConfig();
  if (!config) {
    throw new ConfigError(
      'No config.yml found',
      'Run `dockflow init` to create a project configuration.',
    );
  }

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

  // Other manager connections for history sync
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
  const branchName = getCurrentBranch();
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
      deployApp,
      forceAccessories,
      skipAccessories,
      skipBuild: options.skipBuild,
      force: options.force,
      services: options.services,
      debug: options.debug,
    });
    return;
  }

  // --- Services ---
  const swarmDeploy = new SwarmDeployService(managerConn);
  const health = new HealthCheckService(managerConn);
  const releases = new ReleaseService(managerConn);
  const lock = new LockService(managerConn, stackName);
  const audit = new AuditService(managerConn);
  const metrics = new MetricsWriteService(managerConn);

  const startTime = Date.now();
  let deployFailed = false;
  let auditMessage = `Deploy ${deployVersion} to ${env}`;
  let metricsJson = '';

  // --- Acquire lock ---
  const lockResult = await lock.acquire({
    version: deployVersion,
    force: options.force,
    message: `Deploy ${deployVersion}`,
  });
  if (!lockResult.success) {
    throw new DeployError(lockResult.error.message, ErrorCode.DEPLOY_LOCKED);
  }

  // --- Render templates in memory (no disk writes) ---
  const templateContext = buildTemplateContext(env, manager.name);
  const renderCtx: ComposeRenderContext = {
    env,
    version: deployVersion,
    branch: branchName,
    project_name: config.project_name,
    config,
    current: templateContext?.current ?? {},
    servers: templateContext?.servers ?? {},
    cluster: templateContext?.cluster ?? {},
  };
  const rendered = ComposeService.renderTemplates(projectRoot, renderCtx);

  // --- Get compose content from rendered map ---
  const originalComposePath = getComposePath();
  if (!originalComposePath) {
    throw new ConfigError(
      'No docker-compose.yml found',
      'Expected at .dockflow/docker/docker-compose.yml',
    );
  }
  const composeRelPath = relative(projectRoot, originalComposePath).replace(/\\/g, '/');
  const composeContent = rendered.get(composeRelPath);
  if (!composeContent) {
    throw new ConfigError(
      'Compose file not found in rendered templates',
      `Expected key "${composeRelPath}" in rendered files map`,
    );
  }
  const composeDirPath = dirname(originalComposePath);

  try {
    // --- Prepare compose ---
    const compose = ComposeService.loadFromString(composeContent);
    ComposeService.updateImageTags(compose, config, env, deployVersion);
    ComposeService.injectSwarmDefaults(compose);
    if (config.proxy?.enabled) {
      ComposeService.injectTraefikLabels(compose, config, stackName, env);
    }

    // --- Build ---
    let builtImages: string[] = [];
    if (!options.skipBuild && deployApp) {
      await HookService.runLocal('pre-build', projectRoot, config, rendered);

      if (config.options?.remote_build) {
        const result = await BuildService.buildRemote(managerConn, {
          projectRoot,
          composeContent: ComposeService.serialize(compose),
          composeDirPath,
          projectName: config.project_name,
          env,
          branch: branchName,
          servicesFilter: options.services,
        });
        builtImages = result.images;

        // Distribute images from manager to workers
        if (builtImages.length > 0 && workerConns.length > 0) {
          const workerTargets = workerConns.map((w) => ({ connection: w.connection, name: w.name }));
          await DistributionService.distributeFromRemote(builtImages, managerConn, workerTargets);
        }
      } else {
        const targets = BuildService.getBuildTargets(ComposeService.serialize(compose), composeDirPath, options.services);
        if (targets.length > 0) {
          // Attach rendered overrides to each target
          for (const target of targets) {
            target.renderedOverrides = BuildService.getOverridesForTarget(rendered, target, projectRoot);
          }

          const result = await BuildService.buildAll(targets);
          builtImages = result.images;

          if (config.registry?.enabled && config.registry.url && config.registry.password) {
            await DistributionService.registryLogin(managerConn, {
              url: config.registry.url,
              username: config.registry.username,
              password: config.registry.password,
            });
            await DistributionService.pushImages(builtImages, config.registry.additional_tags?.length ? {
              tags: config.registry.additional_tags,
              env,
              version: deployVersion,
              branch: branchName,
            } : undefined);
          } else if (builtImages.length > 0) {
            const distTargets = [
              { connection: managerConn, name: 'manager' },
              ...workerConns.map((w) => ({ connection: w.connection, name: w.name })),
            ];
            await DistributionService.distributeAll(builtImages, distTargets);
          }
        }
      }

      await HookService.runLocal('post-build', projectRoot, config, rendered);
    }

    // --- Create release ---
    const performer = `${process.env.USER ?? 'ci'}@${os.hostname()}`;
    await releases.createRelease(stackName, deployVersion, ComposeService.serialize(compose), {
      project_name: config.project_name,
      version: deployVersion,
      env,
      timestamp: new Date().toISOString(),
      epoch: Math.floor(Date.now() / 1000),
      performer,
      branch: branchName,
    });

    // --- Deploy accessories ---
    if (!skipAccessories) {
      const accessoriesRelPath = '.dockflow/docker/accessories.yml';
      const accessoriesContent = rendered.get(accessoriesRelPath);
      if (accessoriesContent) {
        const accessoriesCompose = ComposeService.loadFromString(accessoriesContent);
        // Do NOT call updateImageTags on accessories — they use third-party images
        // (Redis, Postgres, etc.) that must not be retagged with the app version.
        ComposeService.injectAccessoriesDefaults(accessoriesCompose);
        const externalNets = ComposeService.getExternalNetworks(accessoriesCompose);
        const externalVols = ComposeService.getExternalVolumes(accessoriesCompose);
        await swarmDeploy.createExternalNetworks(externalNets);
        await swarmDeploy.createExternalVolumes(externalVols);
        await swarmDeploy.deployAccessories(
          stackName,
          accessoriesRelPath,
          ComposeService.serialize(accessoriesCompose),
          { force: forceAccessories },
        );
      }
    }

    // --- Deploy app ---
    if (deployApp) {
      // Ensure Traefik is running if proxy is enabled
      if (config.proxy?.enabled) {
        const traefik = new TraefikService(managerConn);
        await traefik.ensureRunning(config.proxy);
      }

      await HookService.runRemote('pre-deploy', managerConn, stackName, projectRoot, config, rendered);

      const externalNetworks = ComposeService.getExternalNetworks(compose);
      const externalVolumes = ComposeService.getExternalVolumes(compose);
      await swarmDeploy.createExternalNetworks(externalNetworks);
      await swarmDeploy.createExternalVolumes(externalVolumes);

      await swarmDeploy.deployStack(stackName, ComposeService.serialize(compose));
      await swarmDeploy.waitConvergence(stackName);

      // Health checks
      if (config.health_checks?.enabled !== false) {
        const expectedImages: Record<string, string> = {};
        for (const [svcName, svc] of Object.entries(compose.services)) {
          const img = svc.image as string | undefined;
          if (img) expectedImages[`${stackName}_${svcName}`] = img;
        }
        await health.checkSwarmHealth(stackName, expectedImages);

        if (config.health_checks?.endpoints?.length) {
          await health.checkHTTPEndpoints(config.health_checks);
        }
      }

      await HookService.runRemote('post-deploy', managerConn, stackName, projectRoot, config, rendered);
    }

    // --- Cleanup old releases ---
    await releases.cleanupOldReleases(stackName, config);

    auditMessage = `Deployed ${deployVersion} to ${env} successfully`;
  } catch (err) {
    deployFailed = true;
    auditMessage = `Deploy ${deployVersion} to ${env} failed: ${err instanceof Error ? err.message : String(err)}`;

    // Remove failed release
    await releases.removeRelease(stackName, deployVersion).catch(() => {});

    // Rollback if configured
    if (
      err instanceof DeployError &&
      config.health_checks?.on_failure === 'rollback'
    ) {
      try {
        const rolledBackTo = await releases.rollback(stackName, swarmDeploy);
        printWarning(`Rolled back to ${rolledBackTo}`);
      } catch (rollbackErr) {
        printWarning(`Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }

    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    const status = deployFailed ? 'failed' : 'success';

    // Audit (best-effort)
    let auditLine = '';
    try {
      auditLine = await audit.writeEntry(stackName, status === 'success' ? 'deployed' : 'failed', auditMessage, deployVersion);
    } catch (e) {
      printWarning(`Audit write failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Metrics (best-effort)
    try {
      metricsJson = await metrics.writeDeployment({
        stackName,
        version: deployVersion,
        env,
        branch: branchName,
        status: status as 'success' | 'failed',
        durationMs,
        performer: `${process.env.USER ?? 'ci'}@${os.hostname()}`,
        buildSkipped: !!options.skipBuild,
        accessoriesDeployed: !skipAccessories,
        nodeCount: 1 + workers.length,
      });
    } catch (e) {
      printWarning(`Metrics write failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // History sync (best-effort)
    const allOtherConns = [
      ...otherManagerConns,
      ...workerConns.map((w) => w.connection),
    ];
    await HistorySyncService.syncToAllNodes(
      allOtherConns,
      stackName,
      auditLine,
      metricsJson,
    ).catch((e) =>
      printWarning(`History sync failed: ${e instanceof Error ? e.message : String(e)}`),
    );

    // Release lock (always)
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
    .command('deploy <env> [version]')
    .description('Deploy application to specified environment (targets Swarm manager)')
    .option('--services <services>', 'Comma-separated list of services to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .option('--accessories', 'Deploy only accessories (databases, caches, etc.)')
    .option('--all', 'Deploy both application and accessories')
    .option('--skip-accessories', 'Skip accessories check entirely')
    .option('--no-failover', 'Disable multi-manager failover (use first manager only)')
    .option('--dry-run', 'Show what would be deployed without executing')
    .option('--debug', 'Enable debug output')
    .action(
      withErrorHandler(async (env: string, version: string | undefined, options: DeployOptions) => {
        await runDeploy(env, version, options);
      }),
    );
}
