/**
 * Deploy phases — self-contained steps called by the deploy orchestrator.
 *
 * Each function receives a DeployContext and performs one logical phase:
 * build, accessories, app deploy + health checks, or audit/history.
 */

import {
  getPerformer,
} from '../utils/config';
import { printWarning } from '../utils/output';
import { sshExec } from '../utils/ssh';
import {
  DeployError,
  ErrorCode,
} from '../utils/errors';
import type { SSHKeyConnection } from '../types';

import { ComposeService, type ParsedCompose } from '../services/compose-service';
import { HealthCheckService } from '../services/health-check-service';
import { HistorySyncService } from '../services/history-sync-service';
import { BuildService } from '../services/build-service';
import { DistributionService, type ContainerRuntime } from '../services/distribution-service';
import { HookService } from '../services/hook-service';
import { CONVERGENCE_TIMEOUT_S, CONVERGENCE_INTERVAL_S } from '../constants';
import type { DeployContext } from './deploy-context';

// ---------------------------------------------------------------------------
// Container engine detection
// ---------------------------------------------------------------------------

export async function detectContainerEngine(
  conn: SSHKeyConnection,
  configEngine?: 'docker' | 'podman',
): Promise<'docker' | 'podman'> {
  if (configEngine) return configEngine;
  const podman = await sshExec(conn, 'which podman 2>/dev/null');
  return podman.exitCode === 0 ? 'podman' : 'docker';
}

// ---------------------------------------------------------------------------
// Phase: Build & distribute
// ---------------------------------------------------------------------------

export async function buildAndDistribute(
  ctx: DeployContext,
  compose: ParsedCompose,
): Promise<void> {
  if (ctx.options.skipBuild || !ctx.deployApp) return;

  await HookService.runLocal('pre-build', ctx.projectRoot, ctx.config, ctx.rendered);

  const engine = await detectContainerEngine(ctx.managerConn, ctx.config.container_engine);
  const runtime: ContainerRuntime = ctx.config.orchestrator === 'k3s' ? 'containerd' : engine;

  if (ctx.config.options?.remote_build) {
    const { images } = await BuildService.buildRemote(ctx.managerConn, {
      projectRoot: ctx.projectRoot,
      composeContent: ComposeService.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.services,
      engine,
    });

    if (images.length > 0 && ctx.workerConns.length > 0) {
      const workerTargets = ctx.workerConns.map((w) => ({ connection: w.connection, name: w.name }));
      await DistributionService.distributeFromRemote(images, ctx.managerConn, workerTargets, runtime);
    }
  } else {
    const targets = BuildService.getBuildTargets(
      ComposeService.serialize(compose),
      ctx.composeDirPath,
      ctx.options.services,
    );

    if (targets.length > 0) {
      const archResult = await sshExec(ctx.managerConn, 'uname -m');
      const remoteArch = archResult.stdout.trim();
      const platform = (remoteArch === 'aarch64' || remoteArch === 'arm64') ? 'linux/arm64' : 'linux/amd64';

      for (const target of targets) {
        target.renderedOverrides = BuildService.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
        target.platform = platform;
        target.engine = engine;
      }

      const { images } = await BuildService.buildAll(targets);

      if (ctx.config.registry?.enabled && ctx.config.registry.url && ctx.config.registry.password) {
        await DistributionService.registryLogin(ctx.managerConn, {
          url: ctx.config.registry.url,
          username: ctx.config.registry.username,
          password: ctx.config.registry.password,
        }, engine);
        await DistributionService.pushImages(images, ctx.config.registry.additional_tags?.length ? {
          tags: ctx.config.registry.additional_tags,
          env: ctx.env,
          version: ctx.deployVersion,
          branch: ctx.branchName,
        } : undefined, engine);
      } else if (images.length > 0) {
        const distTargets = [
          { connection: ctx.managerConn, name: 'manager' },
          ...ctx.workerConns.map((w) => ({ connection: w.connection, name: w.name })),
        ];
        await DistributionService.distributeAll(images, distTargets, runtime);
      }
    }
  }

  await HookService.runLocal('post-build', ctx.projectRoot, ctx.config, ctx.rendered);
}

// ---------------------------------------------------------------------------
// Phase: Accessories
// ---------------------------------------------------------------------------

export async function deployAccessories(ctx: DeployContext): Promise<void> {
  if (ctx.skipAccessories) return;

  const accessoriesRelPath = '.dockflow/docker/accessories.yml';
  const accessoriesContent = ctx.rendered.get(accessoriesRelPath);
  if (!accessoriesContent) return;

  const accessoriesCompose = ComposeService.loadFromString(accessoriesContent);
  ComposeService.injectAccessoriesDefaults(accessoriesCompose);

  const result = await ctx.orchestrator.deployAccessory({
    stackName: ctx.stackName,
    env: ctx.env,
    compose: accessoriesCompose,
    accessoryPath: accessoriesRelPath,
    force: ctx.forceAccessories,
    proxy: ctx.config.proxy,
    useRegistry: ctx.config.registry?.enabled,
  });

  if (!result.success) {
    throw result.error;
  }
}

// ---------------------------------------------------------------------------
// Phase: App deploy + health checks
// ---------------------------------------------------------------------------

export async function deployApp(ctx: DeployContext, compose: ParsedCompose): Promise<void> {
  if (!ctx.deployApp) return;

  if (ctx.traefikBackend) {
    await ctx.traefikBackend.ensureRunning(ctx.config.proxy!);
  }

  await HookService.runRemote('pre-deploy', ctx.managerConn, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);

  const deployResult = await ctx.orchestrator.deploy({
    stackName: ctx.stackName,
    env: ctx.env,
    compose,
    proxy: ctx.config.proxy,
    useRegistry: ctx.config.registry?.enabled,
  });
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

  if (ctx.config.health_checks?.enabled !== false) {
    const health = new HealthCheckService(ctx.managerConn, ctx.orchestrator);
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

// ---------------------------------------------------------------------------
// Phase: Audit, metrics, history sync (best-effort)
// ---------------------------------------------------------------------------

export async function recordHistory(
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
