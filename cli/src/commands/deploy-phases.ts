/**
 * Deploy phases — self-contained steps called by the deploy orchestrator.
 *
 * Each function receives a DeployContext and performs one logical phase:
 * build, accessories, app deploy + health checks, or audit/history.
 */

import {
  getPerformer,
  getLayout,
} from '../utils/config';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, join, relative, dirname, basename } from 'path';
import { walkDir } from '../utils/fs';
import { printDim, printWarning } from '../utils/output';
import { sshExec, sshExecChannel } from '../utils/ssh';
import {
  DeployError,
  ErrorCode,
} from '../utils/errors';
import type { SSHKeyConnection, ClusterConnection, ClusterNode } from '../types';

import * as Compose from '../services/compose';
import type { ParsedCompose } from '../services/compose';
import { HealthCheck } from '../services/health-check';
import * as HistorySync from '../services/history-sync';
import * as Build from '../services/build';
import * as Distribution from '../services/distribution';
import type { ContainerRuntime } from '../services/distribution';
import * as Hook from '../services/hook';
import * as Nginx from '../services/nginx';
import { CONVERGENCE_TIMEOUT_S, CONVERGENCE_INTERVAL_S, DOCKFLOW_UPLOAD_BACKUPS_DIR } from '../constants';
import type { DeployContext } from './deploy-context';

// ---------------------------------------------------------------------------
// Cluster helpers — deploy-specific traversal of ClusterConnection
// ---------------------------------------------------------------------------

/** Nodes that receive builds, uploads, and deployments (manager + workers). */
function activeNodes(cluster: ClusterConnection): ClusterNode[] {
  return [cluster.manager, ...cluster.workers];
}

/** Connections that receive history-sync writes (all nodes except the primary manager). */
function historySyncConns(cluster: ClusterConnection): SSHKeyConnection[] {
  return [...cluster.otherManagers, ...cluster.workers].map(n => n.connection);
}

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
// Phase: Upload files to remote server
// ---------------------------------------------------------------------------

export interface HostUploadState {
  conn: SSHKeyConnection;
  backedUp: string[];
  created: string[];
}

export interface UploadRollbackPlan {
  hosts: HostUploadState[];
  backupBaseDir: string;
}

export async function uploadFiles(ctx: DeployContext): Promise<UploadRollbackPlan> {
  const uploads = ctx.config.upload;
  const backupBaseDir = `${DOCKFLOW_UPLOAD_BACKUPS_DIR}/${ctx.stackName}/${ctx.deployVersion}`;

  const plan: UploadRollbackPlan = {
    hosts: activeNodes(ctx.cluster).map(n => ({ conn: n.connection, backedUp: [], created: [] })),
    backupBaseDir,
  };

  if (!uploads || uploads.length === 0) return plan;

  for (const upload of uploads) {
    const srcAbs = resolve(ctx.projectRoot, upload.src);

    if (!existsSync(srcAbs)) {
      printWarning(`upload: source not found, skipping: ${upload.src}`);
      continue;
    }

    const isDir = statSync(srcAbs).isDirectory();
    const files = isDir ? walkDir(srcAbs) : [srcAbs];
    const baseDir = isDir ? srcAbs : dirname(srcAbs);
    const destBase = upload.dest.replace(/\/$/, '');

    for (const file of files) {
      const relPath = relative(baseDir, file).replace(/\\/g, '/');
      const destPath = isDir
        ? `${destBase}/${relPath}`
        : upload.dest.endsWith('/')
          ? `${destBase}/${basename(file)}`
          : upload.dest;

      // destPath stripped of leading slash to use as relative path under backupBaseDir
      const destRelative = destPath.replace(/^\//, '');
      const backupPath = `${backupBaseDir}/${destRelative}`;
      const fileContent = readFileSync(file);

      await Promise.all(plan.hosts.map(async hostState => {
        const { conn } = hostState;

        // Backup existing file before overwriting
        await sshExec(conn, `mkdir -p '${dirname(backupPath)}'`);
        const backupResult = await sshExec(conn,
          `if test -f '${destPath}'; then cp '${destPath}' '${backupPath}' && echo existed; else echo missing; fi`,
        );
        if (backupResult.stdout.trim() === 'existed') {
          hostState.backedUp.push(destPath);
        } else {
          hostState.created.push(destPath);
        }

        // Upload new file
        const mkdirResult = await sshExec(conn, `mkdir -p '${dirname(destPath)}'`);
        if (mkdirResult.exitCode !== 0) {
          throw new DeployError(
            `upload: cannot create ${dirname(destPath)} on ${conn.host}: ${mkdirResult.stderr.trim() || `exit ${mkdirResult.exitCode}`}`,
            ErrorCode.DEPLOY_FAILED,
            `The deploy user must own the destination directory. Run once on the server:\n  sudo mkdir -p '${dirname(destPath)}' && sudo chown $(whoami): '${dirname(destPath)}'`,
          );
        }
        const { stream, done } = await sshExecChannel(conn, `cat > '${destPath}'`);
        stream.end(fileContent);
        const result = await done;
        if (result.exitCode !== 0) {
          const detail = (result.stderr.trim() || result.stdout.trim()) || `exit code ${result.exitCode}`;
          throw new DeployError(
            `upload: failed to transfer ${upload.src} → ${destPath} on ${conn.host}: ${detail}`,
            ErrorCode.DEPLOY_FAILED,
            `Ensure ${conn.user} has write access to ${dirname(destPath)} on ${conn.host}:\n` +
            `  sudo mkdir -p '${dirname(destPath)}' && sudo chown ${conn.user}: '${dirname(destPath)}'`,
          );
        }
      }));

      printDim(`upload: ${upload.src}${isDir ? '/' + relPath : ''} → ${destPath}`);
    }
  }

  return plan;
}

export async function rollbackUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(plan.hosts.map(async ({ conn, backedUp, created }) => {
    for (const destPath of backedUp) {
      const destRelative = destPath.replace(/^\//, '');
      const backupPath = `${plan.backupBaseDir}/${destRelative}`;
      await sshExec(conn, `mv '${backupPath}' '${destPath}'`);
    }
    for (const destPath of created) {
      await sshExec(conn, `rm -f '${destPath}'`);
    }
    await sshExec(conn, `rm -rf '${plan.backupBaseDir}'`);
  }));
}

export async function commitUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(plan.hosts.map(({ conn }) =>
    sshExec(conn, `rm -rf '${plan.backupBaseDir}'`),
  ));
}

// ---------------------------------------------------------------------------
// Phase: Build & distribute
// ---------------------------------------------------------------------------

export async function buildAndDistribute(
  ctx: DeployContext,
  compose: ParsedCompose,
): Promise<void> {
  if (ctx.options.skipBuild || !ctx.deployApp) return;

  await Hook.runLocal('pre-build', ctx.projectRoot, ctx.config, ctx.rendered);

  const engine = await detectContainerEngine(ctx.cluster.manager.connection, ctx.config.container_engine);
  const runtime: ContainerRuntime = ctx.config.orchestrator === 'k3s' ? 'containerd' : engine;

  if (ctx.config.options?.remote_build) {
    const { images } = await Build.buildRemote(ctx.cluster.manager.connection, {
      projectRoot: ctx.projectRoot,
      composeContent: Compose.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.services,
      engine,
    });

    if (images.length > 0 && ctx.cluster.workers.length > 0) {
      await Distribution.distributeFromRemote(images, ctx.cluster.manager.connection, ctx.cluster.workers, runtime);
    }
  } else {
    const targets = Build.getBuildTargets(
      Compose.serialize(compose),
      ctx.composeDirPath,
      ctx.options.services,
    );

    if (targets.length > 0) {
      const archResult = await sshExec(ctx.cluster.manager.connection, 'uname -m');
      const remoteArch = archResult.stdout.trim();
      const platform = (remoteArch === 'aarch64' || remoteArch === 'arm64') ? 'linux/arm64' : 'linux/amd64';

      for (const target of targets) {
        target.renderedOverrides = Build.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
        target.platform = platform;
        target.engine = engine;
      }

      const { images } = await Build.buildAll(targets);

      if (ctx.config.registry?.enabled && ctx.config.registry.url && ctx.config.registry.password) {
        await Distribution.registryLogin(ctx.cluster.manager.connection, {
          url: ctx.config.registry.url,
          username: ctx.config.registry.username,
          password: ctx.config.registry.password,
        }, engine);
        await Distribution.pushImages(images, ctx.config.registry.additional_tags?.length ? {
          tags: ctx.config.registry.additional_tags,
          env: ctx.env,
          version: ctx.deployVersion,
          branch: ctx.branchName,
        } : undefined, engine);
      } else if (images.length > 0) {
        await Distribution.distributeAll(images, activeNodes(ctx.cluster), runtime);
      }
    }
  }

  await Hook.runLocal('post-build', ctx.projectRoot, ctx.config, ctx.rendered);
}

// ---------------------------------------------------------------------------
// Phase: Accessories
// ---------------------------------------------------------------------------

export async function deployAccessories(ctx: DeployContext): Promise<void> {
  if (ctx.skipAccessories) return;

  const layout = getLayout();
  const accessoriesRelPath = layout.accessoriesPath
    ? relative(layout.root, layout.accessoriesPath).replace(/\\/g, '/')
    : '.dockflow/docker/accessories.yml';
  const accessoriesContent = ctx.rendered.get(accessoriesRelPath);
  if (!accessoriesContent) return;

  const accessoriesCompose = Compose.loadFromString(accessoriesContent);
  Compose.injectAccessoriesDefaults(accessoriesCompose);

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

  if (ctx.proxyBackend) {
    await ctx.proxyBackend.ensureRunning(ctx.config.proxy!);
  }

  await Hook.runRemote('pre-deploy', ctx.cluster.manager.connection, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);

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
        convergence.errorDetail ?? 'Orchestrator auto-rolled back the deployment',
        ErrorCode.HEALTH_CHECK_FAILED,
        'Check service logs to understand why the new version failed.',
      );
    }
    throw new DeployError(
      convergence.errorDetail ?? 'Service convergence timed out',
      ErrorCode.DEPLOY_FAILED,
      'Check service logs with `dockflow logs <service>` for details.',
    );
  }

  if (ctx.config.health_checks?.enabled !== false) {
    const health = new HealthCheck(ctx.cluster.manager.connection, ctx.orchestrator);
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

  await Nginx.deployNginxTemplates(ctx.cluster.manager.connection, ctx.rendered);

  await Hook.runRemote('post-deploy', ctx.cluster.manager.connection, ctx.stackName, ctx.projectRoot, ctx.config, ctx.rendered);
}

// ---------------------------------------------------------------------------
// Phase: Audit, metrics, history sync (best-effort)
// ---------------------------------------------------------------------------

export async function recordHistory(
  ctx: DeployContext,
  status: 'success' | 'failed',
  durationMs: number,
  auditMessage: string,
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
      nodeCount: activeNodes(ctx.cluster).length,
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

  await HistorySync.syncToAllNodes(
    historySyncConns(ctx.cluster),
    ctx.stackName,
    auditLine,
    metricsJson,
  ).catch((e) =>
    printWarning(`History sync failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}
