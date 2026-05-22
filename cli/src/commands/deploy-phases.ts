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
import { resolve, relative, dirname, basename } from 'path';
import { pipeline } from 'stream/promises';
import { printDim, printWarning, formatBytes, createSpinner } from '../utils/output';
import { walkDir } from '../utils/fs';
import { packDirToTarGz, buildExcludeFilter } from '../utils/tar';
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
import { CONVERGENCE_TIMEOUT_S, CONVERGENCE_INTERVAL_S, DOCKFLOW_UPLOAD_BACKUPS_DIR } from '../constants';
import type { StackBackend } from '../services/orchestrator/interfaces';
import type { HealthCheckConfig } from '../utils/config';
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
  name: string;
  conn: SSHKeyConnection;
  backedUp: string[];                                       // individual files backed up
  created: string[];                                        // individual files created (no prior backup)
  backedUpDirs: Array<{ dest: string; backup: string }>;   // dirs backed up as tar.gz
  createdDirs: string[];                                    // dirs created from scratch
}

export interface UploadRollbackPlan {
  hosts: HostUploadState[];
  backupBaseDir: string;
}

const UPLOAD_CONCURRENCY = 8;

/** Work-stealing concurrency pool — N workers drain a shared task queue. */
async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let i = 0;
  const worker = async () => {
    let idx: number;
    while ((idx = i++) < tasks.length) await tasks[idx]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/** Stream a packDirToTarGz stream into an SSH channel. */
async function streamDirToHost(
  srcDir: string,
  excludePatterns: string[],
  conn: SSHKeyConnection,
  destBase: string,
  compress: boolean,
  onProgress?: (bytesProcessed: number) => void,
  onExtracting?: () => void,
): Promise<void> {
  const extractCmd = compress ? `tar xzf - -C '${destBase}'` : `tar xf - -C '${destBase}'`;
  const { stream, done } = await sshExecChannel(conn, extractCmd);
  await pipeline(packDirToTarGz(srcDir, excludePatterns, onProgress, compress), stream as unknown as NodeJS.WritableStream);
  onExtracting?.();
  const result = await done;
  if (result.exitCode !== 0) {
    throw new DeployError(
      `upload: tar extraction failed at ${destBase} on ${conn.host}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }
}


export async function uploadFiles(ctx: DeployContext): Promise<UploadRollbackPlan> {
  const uploads = ctx.config.upload;
  const backupBaseDir = `${DOCKFLOW_UPLOAD_BACKUPS_DIR}/${ctx.stackName}/${ctx.deployVersion}`;

  const plan: UploadRollbackPlan = {
    hosts: activeNodes(ctx.cluster).map(n => ({
      name: n.name, conn: n.connection, backedUp: [], created: [], backedUpDirs: [], createdDirs: [],
    })),
    backupBaseDir,
  };

  if (!uploads || uploads.length === 0) return plan;

  const serviceFilter = ctx.options.only
    ? new Set(ctx.options.only.split(',').map((s: string) => s.trim()))
    : null;

  for (const upload of uploads) {
    if (serviceFilter && upload.service) {
      const uploadServices = Array.isArray(upload.service) ? upload.service : [upload.service];
      if (!uploadServices.some(s => serviceFilter.has(s))) continue;
    }

    const srcAbs = resolve(ctx.projectRoot, upload.src);
    if (!existsSync(srcAbs)) {
      printWarning(`upload: source not found, skipping: ${upload.src}`);
      continue;
    }

    const destBase = upload.dest.replace(/\/$/, '');

    if (statSync(srcAbs).isDirectory()) {
      // -----------------------------------------------------------------------
      // Directory upload
      // -----------------------------------------------------------------------
      const excludePatterns = upload.exclude ?? [];

      // Step 1: backup existing remote dir + ensure dest exists (all hosts in parallel)
      await Promise.all(plan.hosts.map(async hostState => {
        const { conn } = hostState;
        const backupPath = `${backupBaseDir}/${destBase.replace(/^\//, '')}.tar.gz`;

        await sshExec(conn, `mkdir -p '${dirname(backupPath)}'`);
        const backupResult = await sshExec(conn,
          `if [ -d '${destBase}' ] && [ -n "$(ls -A '${destBase}' 2>/dev/null)" ]; then ` +
          `tar czf '${backupPath}' -C '${destBase}' . 2>/dev/null && echo backed_up; ` +
          `else echo missing; fi`,
        );
        if (backupResult.stdout.trim() === 'backed_up') {
          hostState.backedUpDirs.push({ dest: destBase, backup: backupPath });
        } else {
          hostState.createdDirs.push(destBase);
        }

        const mkdirResult = await sshExec(conn, `mkdir -p '${destBase}'`);
        if (mkdirResult.exitCode !== 0) {
          throw new DeployError(
            `upload: cannot create ${destBase} on ${conn.host}: ${mkdirResult.stderr.trim() || `exit ${mkdirResult.exitCode}`}`,
            ErrorCode.DEPLOY_FAILED,
            `The deploy user must own the destination directory. Run once on the server as root:\n  mkdir -p '${destBase}' && chown ${conn.user}: '${destBase}'`,
          );
        }
      }));

      // Step 2: transfer
      const compress = upload.compress !== false;
      const compressFlag = compress ? '' : ' [no compression]';

      if (plan.hosts.length === 1) {
        // Single host: stream directly into SSH — no RAM buffer
        const { name, conn } = plan.hosts[0];
        const isExcluded = buildExcludeFilter(excludePatterns);
        const totalBytes = walkDir(srcAbs)
          .filter(f => !isExcluded(relative(srcAbs, f).replace(/\\/g, '/')))
          .reduce((sum, f) => sum + statSync(f).size, 0);
        const totalStr = formatBytes(totalBytes);
        const spinner = createSpinner();
        spinner.start(`upload: ${upload.src}/ -> ${name}:${destBase}/${compressFlag}`);
        let lastTick = 0;
        await streamDirToHost(srcAbs, excludePatterns, conn, destBase, compress,
          (bytesProcessed) => {
            const now = Date.now();
            if (now - lastTick < 250) return;
            lastTick = now;
            const pct = Math.min(99, Math.round(bytesProcessed / totalBytes * 100));
            spinner.update(`upload: ${upload.src}/ -> ${name}:${destBase}/ ${formatBytes(bytesProcessed)} / ${totalStr} (${pct}%)`);
          },
          () => spinner.update(`upload: unpacking on ${name}...`),
        );
        spinner.succeed(`upload: ${upload.src}/ -> ${name}:${destBase}/ done`);
        if (upload.permissions) await sshExec(conn, `chmod -R ${upload.permissions} '${destBase}'`);
        if (upload.owner) await sshExec(conn, `chown -R ${upload.owner} '${destBase}'`);
      } else {
        // Multiple hosts: stream independently to each host in parallel — no RAM buffer
        printDim(`upload: ${upload.src}/ -> ${destBase}/${compressFlag} [${plan.hosts.length} hosts]`);
        await Promise.all(plan.hosts.map(async ({ name, conn }) => {
          await streamDirToHost(srcAbs, excludePatterns, conn, destBase, compress);
          printDim(`  upload: -> ${name}:${destBase}/ done`);
          if (upload.permissions) await sshExec(conn, `chmod -R ${upload.permissions} '${destBase}'`);
          if (upload.owner) await sshExec(conn, `chown -R ${upload.owner} '${destBase}'`);
        }));
      }
    } else {
      // -----------------------------------------------------------------------
      // Single file: parallel across hosts, batched mkdir
      // -----------------------------------------------------------------------
      const destPath = upload.dest.endsWith('/')
        ? `${destBase}/${basename(srcAbs)}`
        : upload.dest;
      const destRelative = destPath.replace(/^\//, '');
      const backupPath = `${backupBaseDir}/${destRelative}`;
      const fileContent = readFileSync(srcAbs);

      // Ensure destination and backup dirs exist on all hosts in one call each
      await Promise.all(plan.hosts.map(({ conn }) =>
        sshExec(conn, `mkdir -p '${dirname(destPath)}' '${dirname(backupPath)}'`),
      ));

      const tasks = plan.hosts.map(hostState => async () => {
        const { conn } = hostState;

        const backupResult = await sshExec(conn,
          `if test -f '${destPath}'; then cp '${destPath}' '${backupPath}' && echo existed; else echo missing; fi`,
        );
        if (backupResult.stdout.trim() === 'existed') {
          hostState.backedUp.push(destPath);
        } else {
          hostState.created.push(destPath);
        }

        const { stream, done } = await sshExecChannel(conn, `cat > '${destPath}'`);
        stream.end(fileContent);
        const result = await done;
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
          throw new DeployError(
            `upload: failed to transfer ${upload.src} to ${conn.host}: ${detail}`,
            ErrorCode.DEPLOY_FAILED,
            `Ensure ${conn.user} has write access to ${dirname(destPath)} on ${conn.host}. Run once as root:\n  mkdir -p '${dirname(destPath)}' && chown ${conn.user}: '${dirname(destPath)}'`,
          );
        }

        if (upload.permissions) {
          const r = await sshExec(conn, `chmod ${upload.permissions} '${destPath}'`);
          if (r.exitCode !== 0) throw new DeployError(`upload: chmod failed on ${destPath} (${conn.host})`, ErrorCode.DEPLOY_FAILED);
        }
        if (upload.owner) {
          const r = await sshExec(conn, `chown ${upload.owner} '${destPath}'`);
          if (r.exitCode !== 0) throw new DeployError(
            `upload: chown failed on ${destPath} (${conn.host})`,
            ErrorCode.DEPLOY_FAILED,
            `Grant chown rights:\n  echo '${conn.user} ALL=(ALL) NOPASSWD: /bin/chown * ${dirname(destPath)}/*' >> /etc/sudoers.d/dockflow`,
          );
        }
      });

      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);
      printDim(`upload: ${upload.src} -> ${destPath}`);
    }
  }

  return plan;
}

export async function rollbackUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(plan.hosts.map(async ({ conn, backedUp, created, backedUpDirs, createdDirs }) => {
    for (const destPath of backedUp) {
      const backupPath = `${plan.backupBaseDir}/${destPath.replace(/^\//, '')}`;
      await sshExec(conn, `mv '${backupPath}' '${destPath}'`);
    }
    for (const destPath of created) {
      await sshExec(conn, `rm -f '${destPath}'`);
    }
    for (const { dest, backup } of backedUpDirs) {
      await sshExec(conn, `rm -rf '${dest}' && mkdir -p '${dest}' && tar xzf '${backup}' -C '${dest}'`);
    }
    for (const dest of createdDirs) {
      await sshExec(conn, `rm -rf '${dest}'`);
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

export interface BuildResult {
  images: string[];
  engine: 'docker' | 'podman';
  usedRegistry: boolean;
}

export async function buildAndDistribute(
  ctx: DeployContext,
  compose: ParsedCompose,
): Promise<BuildResult | null> {
  if (ctx.options.skipBuild || !ctx.deployApp) return null;
  if (!Compose.hasServices(compose)) return null;

  await Hook.runLocal('pre-build', ctx.projectRoot, ctx.config, ctx.rendered);

  const engine = await detectContainerEngine(ctx.cluster.manager.connection, ctx.config.container_engine);
  const runtime: ContainerRuntime = ctx.config.orchestrator === 'k3s' ? 'containerd' : engine;
  let images: string[] = [];
  let usedRegistry = false;

  if (ctx.config.options?.remote_build) {
    ({ images } = await Build.buildRemote(ctx.cluster.manager.connection, {
      projectRoot: ctx.projectRoot,
      composeContent: Compose.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.only,
      engine,
    }));

    if (images.length > 0 && ctx.cluster.workers.length > 0) {
      await Distribution.distributeFromRemote(images, ctx.cluster.manager.connection, ctx.cluster.workers, runtime);
    }
  } else {
    const targets = Build.getBuildTargets(
      Compose.serialize(compose),
      ctx.composeDirPath,
      ctx.options.only,
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

      ({ images } = await Build.buildAll(targets));

      if (ctx.config.registry?.enabled && ctx.config.registry.url && ctx.config.registry.password) {
        usedRegistry = true;
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
  return { images, engine, usedRegistry };
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
  if (!Compose.hasServices(compose)) return;

  if (ctx.proxyBackend) {
    await ctx.proxyBackend.ensureRunning(ctx.config.proxy!);
  }

  const servicesFilter = ctx.options.only
    ? ctx.options.only.split(',').map((s: string) => s.trim())
    : undefined;

  const deployStartedAt = new Date();

  const deployResult = await ctx.orchestrator.deploy({
    stackName: ctx.stackName,
    env: ctx.env,
    compose,
    proxy: ctx.config.proxy,
    useRegistry: ctx.config.registry?.enabled,
    servicesFilter,
  });
  if (!deployResult.success) {
    throw deployResult.error;
  }

  const convergence = await ctx.orchestrator.waitConvergence(
    ctx.stackName,
    CONVERGENCE_TIMEOUT_S,
    CONVERGENCE_INTERVAL_S,
    servicesFilter,
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
    const internalResult = await health.checkInternalHealth(ctx.stackName, ctx.config.health_checks, servicesFilter, deployStartedAt);
    if (!internalResult.healthy) {
      throw new DeployError(
        internalResult.message || `Health check failed${internalResult.failedService ? `: ${internalResult.failedService}` : ''}`,
        ErrorCode.HEALTH_CHECK_FAILED,
        'Check service logs with `dockflow logs <service>` for details.',
      );
    }

  }

}

export async function runHTTPHealthChecks(ctx: DeployContext): Promise<void> {
  if (!ctx.deployApp || !ctx.config.health_checks?.endpoints?.length) return;
  const health = new HealthCheck(ctx.cluster.manager.connection, ctx.orchestrator);
  await health.checkHTTPEndpoints(ctx.config.health_checks);
}

/**
 * Run health checks after a rollback. Always best-effort — failures are
 * printed as warnings, never thrown, because there is nothing left to roll back to.
 */
export async function runPostRollbackHealthChecks(
  connection: SSHKeyConnection,
  orchestrator: StackBackend,
  stackName: string,
  healthConfig: HealthCheckConfig | undefined,
): Promise<void> {
  if (healthConfig?.enabled === false) return;

  const health = new HealthCheck(connection, orchestrator);

  const result = await health.checkInternalHealth(stackName, healthConfig).catch(() => null);
  if (result && !result.healthy) {
    printWarning(`Rolled-back version is unhealthy: ${result.message ?? result.failedService ?? 'check logs'}`);
  }

  if (healthConfig?.endpoints?.length) {
    // Force on_failure to 'notify' — rolling back a rollback is not an option.
    await health.checkHTTPEndpoints({ ...healthConfig, on_failure: 'notify' });
  }
}

/**
 * Remove images from all cluster nodes after a failed deployment.
 * Skipped when a registry was used — images live in the registry, not just on nodes.
 * Best-effort: Docker/Podman refuse to remove in-use images, so this is inherently safe.
 */
export async function cleanupFailedImages(
  buildResult: BuildResult,
  nodes: ClusterNode[],
): Promise<void> {
  if (buildResult.usedRegistry || buildResult.images.length === 0) return;

  const quotedImages = buildResult.images.map(img => `'${img}'`).join(' ');
  const engine = buildResult.engine;

  await Promise.allSettled(
    nodes.map(node =>
      sshExec(node.connection, `${engine} rmi ${quotedImages} 2>/dev/null || true`),
    ),
  );
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
