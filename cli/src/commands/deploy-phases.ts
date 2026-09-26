/**
 * Deploy phases — self-contained steps called by `deploy.ts` (design-03 3.4, 12, 19.3): image
 * delivery, uploads (direct SSH, orchestrator-independent) and the audit/metrics/history-sync
 * write-up, alongside the accessories/app deploy phases proper.
 *
 * Orchestrator-agnostic: every remote effect goes through `ctx.orchestrator`, so the same code runs
 * a k3s or a Swarm deploy (DESIGN-CORE 2.2). k3s-only pieces (the normalizer call inside
 * `siblingInput`) are safe to run for Swarm too, because Swarm's StackBackend never reads
 * `StackDeployInput.sibling`.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { basename, dirname, relative, resolve as resolvePath } from 'path';
import { pipeline } from 'stream/promises';
import * as Build from '../services/build';
import * as Compose from '../services/compose';
import type { ParsedCompose } from '../services/compose';
import * as Distribution from '../services/distribution';
import type { ContainerRuntime } from '../services/distribution';
import * as HistorySync from '../services/history-sync';
import { createFileResolver } from '../services/orchestrator/file-resolver';
import { convergenceFailureError, healthFailureError } from '../services/orchestrator/failure';
import { openOrchestrator } from '../services/orchestrator/factory';
import { requireCapability } from '../services/orchestrator/capabilities';
import { remoteHookContext, runHook } from '../services/hook';
import { DiagnosticSink } from '../services/orchestrator/diagnostics';
import type {
  DeployReceipt,
  ImageDelivery,
  LockData,
  LockStore,
  Orchestrator,
  RevertResult,
  StackArtifact,
  StackBackend,
  StackDeployInput,
  StackRef,
  StackRole,
} from '../services/orchestrator/interfaces';
import { k3sDistribution } from '../services/orchestrator/kubernetes/k3s/distribution';
import { namespaceFor } from '../services/orchestrator/kubernetes/naming';
import { normalizeStack } from '../services/orchestrator/kubernetes/normalize';
import type { StackIdentity } from '../services/orchestrator/kubernetes/model/types';
import { KubeError } from '../services/orchestrator/kubernetes/runtime/errors';
import { HealthCheck } from '../services/health-check';
import { renderedValuesFileLookup, resolveHelmReleases } from '../services/orchestrator/kubernetes/helm/resolve';
import {
  CONVERGENCE_INTERVAL_S,
  CONVERGENCE_TIMEOUT_S,
  DEFAULT_HEALTHCHECK_INTERVAL_S,
  DEFAULT_HEALTHCHECK_TIMEOUT_S,
  DOCKFLOW_UPLOAD_BACKUPS_DIR,
  HEALTH_STABILITY_WINDOW_S,
  REGISTRY_PULL_SECRET_NAME,
} from '../constants';
import { getLayout, getPerformer, type DockflowConfig, type HealthCheckConfig, type UploadItem } from '../utils/config';
import { OrchestratorUnavailableError, DeployError, ErrorCode } from '../utils/errors';
import { walkDir } from '../utils/fs';
import { createSpinner, formatBytes, printDebug, printDim, printInfo, printSuccess, printWarning } from '../utils/output';
import { buildExcludeFilter, packDirToTarGz } from '../utils/tar';
import { sshExec, sshExecChannel, shellQuote } from '../utils/ssh';
import type { SSHKeyConnection } from '../types';
import type { DeployContext } from './deploy-context';
import { activeNodes } from './deploy-context';

/** the ONE registry predicate (design-03 12.1, K42); reused verbatim, never re-implemented here */
export { usesRegistry } from '../services/compose';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 12.1 Delivery mode (pure)
// ---------------------------------------------------------------------------

/**
 * Configuration-only, never a function of whether a build ran in this invocation: `--skip-build`
 * and `--accessories` deploys must render the exact same pod templates as a full deploy.
 */
export function resolveImageDelivery(config: DockflowConfig, compose: ParsedCompose): ImageDelivery {
  const hasBuilt = Object.values(compose.services).some((s) => s.build !== undefined);
  const registryMode = Compose.usesRegistry(config);
  return {
    built: [],
    mode: registryMode ? 'registry' : hasBuilt ? 'import' : 'none',
    pullSecretName: registryMode ? REGISTRY_PULL_SECRET_NAME : null,
  };
}

/** Said once per deploy (and as a validate diagnostic): the fallback is deliberate, not silent. */
export function warnRegistryWithoutPassword(config: DockflowConfig): void {
  const r = config.registry;
  if (r?.enabled === true && !!r.url && !Compose.registryPassword(config)) {
    printWarning(
      `Registry ${r.url} is enabled but neither registry.password nor registry.token is set; built images are distributed over SSH instead of pushed`,
    );
  }
}

// ---------------------------------------------------------------------------
// 12.3 Registry pull secret
// ---------------------------------------------------------------------------

export async function ensureRegistryAccess(ctx: DeployContext, appRef: StackRef): Promise<string | null> {
  if (!Compose.usesRegistry(ctx.config)) return null;
  const r = ctx.config.registry!;
  return ctx.orchestrator.images.ensurePullSecret(appRef, { server: r.url!, username: r.username ?? '', password: Compose.registryPassword(ctx.config)! });
}

// ---------------------------------------------------------------------------
// Build and distribute (12.2, through ImageBackend)
// ---------------------------------------------------------------------------

export interface BuildResult {
  images: string[];
  engine: ContainerRuntime;
  delivery: ImageDelivery;
}

/** The push runs here, so the login does too; nodes pull through ensureRegistryAccess. */
async function pushBuiltImages(ctx: DeployContext, images: string[], engine: ContainerRuntime): Promise<void> {
  const r = ctx.config.registry!;
  await Distribution.registryLoginLocal({ url: r.url!, username: r.username, password: Compose.registryPassword(ctx.config)! }, engine);
  await Distribution.pushImages(
    images,
    r.additional_tags?.length ? { tags: r.additional_tags, env: ctx.env, version: ctx.deployVersion, branch: ctx.branchName } : undefined,
    engine,
  );
}

async function distributeOrPush(ctx: DeployContext, images: string[], delivery: ImageDelivery, engine: ContainerRuntime): Promise<void> {
  if (images.length === 0) return;
  if (delivery.mode === 'registry') {
    await pushBuiltImages(ctx, images, engine);
    return;
  }
  await ctx.orchestrator.images.distribute(images, activeNodes(ctx.target));
}

/** `pre-build` / `post-build` run locally by default, remotely on `options.remote_build` (8.8). */
async function runBuildHook(ctx: DeployContext, phase: 'pre-build' | 'post-build'): Promise<void> {
  const remote = ctx.config.options?.remote_build ? remoteHookContext(ctx.orchestrator, ctx.deployVersion) : undefined;
  await runHook(phase, ctx.projectRoot, ctx.config, ctx.rendered, remote);
}

export async function buildAndDistribute(ctx: DeployContext, compose: ParsedCompose, delivery: ImageDelivery): Promise<BuildResult | null> {
  if (ctx.options.skipBuild || !ctx.deployApp) return null;
  if (!Compose.hasServices(compose)) return null;

  await runBuildHook(ctx, 'pre-build');

  const connection = ctx.target.controlPlane.connection;
  const engine: ContainerRuntime = Distribution.detectLocalEngine(ctx.config.container_engine);
  let images: string[] = [];

  if (ctx.config.options?.remote_build) {
    requireCapability(ctx.orchestrator, 'remoteBuild', 'options.remote_build');
    ({ images } = await Build.buildRemote(connection, {
      projectRoot: ctx.projectRoot,
      composeContent: Compose.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.only,
      engine,
    }));
    await distributeOrPush(ctx, images, delivery, engine);
  } else {
    const targets = Build.getBuildTargets(Compose.serialize(compose), ctx.composeDirPath, ctx.options.only);
    if (targets.length > 0) {
      const archResult = await sshExec(connection, 'uname -m');
      const remoteArch = archResult.stdout.trim();
      const platform = remoteArch === 'aarch64' || remoteArch === 'arm64' ? 'linux/arm64' : 'linux/amd64';

      for (const target of targets) {
        target.renderedOverrides = Build.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
        target.platform = platform;
        target.engine = engine;
        // what a registry push carries stays; an image shipped to the nodes keeps one id per content
        target.noDefaultAttestations = delivery.mode !== 'registry';
      }

      ({ images } = await Build.buildAll(targets));
      await distributeOrPush(ctx, images, delivery, engine);
    }
  }

  await runBuildHook(ctx, 'post-build');
  return { images, engine, delivery };
}

// ---------------------------------------------------------------------------
// Uploads (config.uploads): independent of the orchestrator, always over direct SSH (core 2.2
// "hooks pre-upload ; uploads ; post-upload ; pre-deploy"). Pre-rewrite home of this logic; the
// rewrite only swaps ClusterConnection/ClusterNode for OrchestratorTarget/ClusterNodeRef.
// ---------------------------------------------------------------------------

export interface HostUploadState {
  name: string;
  conn: SSHKeyConnection;
  backedUp: string[];
  created: string[];
  backedUpDirs: Array<{ dest: string; backup: string }>;
  createdDirs: string[];
}

export interface UploadRollbackPlan {
  hosts: HostUploadState[];
  backupBaseDir: string;
}

const UPLOAD_CONCURRENCY = 8;

/** Work-stealing concurrency pool — N workers drain a shared task queue. */
export async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let i = 0;
  const worker = async () => {
    let idx: number;
    while ((idx = i++) < tasks.length) await tasks[idx]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

export function resolveFileDestPath(dest: string, srcBasename: string): string {
  return dest.endsWith('/') ? `${dest.replace(/\/$/, '')}/${srcBasename}` : dest;
}

export function uploadOwnedDir(dest: string, isDirUpload: boolean): string {
  const clean = dest.replace(/\/$/, '');
  return isDirUpload || dest.endsWith('/') ? clean : dirname(clean);
}

export function fileBackupPath(backupBaseDir: string, destPath: string): string {
  return `${backupBaseDir}/${destPath.replace(/^\//, '')}`;
}

export function dirBackupPath(backupBaseDir: string, destBase: string): string {
  return `${backupBaseDir}/${destBase.replace(/^\//, '')}.tar.gz`;
}

/** Uploads relevant to a partial deploy (--only): scopeless uploads always apply. */
export function filterUploads(uploads: UploadItem[] | undefined, only?: string): UploadItem[] {
  if (!uploads || uploads.length === 0) return [];
  if (!only) return uploads;
  const serviceFilter = new Set(only.split(',').map((s) => s.trim()));
  return uploads.filter((u) => {
    if (!u.service) return true;
    const services = Array.isArray(u.service) ? u.service : [u.service];
    return services.some((s) => serviceFilter.has(s));
  });
}

export function uploadName(upload: UploadItem): string {
  return upload.label ?? upload.src;
}

function filterUploadsByService(ctx: DeployContext): UploadItem[] {
  return filterUploads(ctx.config.uploads, ctx.options.only);
}

async function streamDirToHost(
  srcDir: string,
  excludePatterns: string[],
  name: string,
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
      `upload: tar extraction failed at ${destBase} on ${name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }
}

/**
 * Pre-flight permission check for upload destinations, one SSH round trip per node, run before
 * the build so a permission mistake surfaces immediately rather than after the image is built.
 */
export async function checkUploadPermissions(ctx: DeployContext): Promise<void> {
  const filtered = filterUploadsByService(ctx);
  if (filtered.length === 0) return;

  const checkFn =
    'check_path() {\n' +
    '  local dest="$1" label="$2"\n' +
    '  if [ -e "$dest" ]; then\n' +
    '    [ -w "$dest" ] || ERRORS="${ERRORS}$label: not writable: $dest\\n"\n' +
    '  else\n' +
    '    local p="$dest"\n' +
    '    while [ ! -d "$p" ]; do p=$(dirname "$p"); done\n' +
    '    [ -w "$p" ] || ERRORS="${ERRORS}$label: cannot create $dest (nearest existing parent: $p)\\n"\n' +
    '  fi\n' +
    '}';
  const checks = filtered.map((u) => `check_path ${shellQuote(u.dest)} ${shellQuote(uploadName(u))}`).join('\n');
  const script = `ERRORS=""\n${checkFn}\n${checks}\n[ -z "$ERRORS" ] || { printf "%b" "$ERRORS"; exit 1; }`;

  const nodes = activeNodes(ctx.target);
  const failures: string[] = [];
  printDebug(`Checking upload permissions on ${nodes.length} node(s)...`);

  await Promise.all(
    nodes.map(async (node) => {
      const result = await sshExec(node.connection, script);
      if (result.exitCode !== 0) {
        const detail = (result.stdout.trim() || result.stderr.trim()).split('\n').map((l) => `    ${l}`).join('\n');
        failures.push(`  ${node.name}:\n${detail}`);
      }
    }),
  );

  if (failures.length > 0) {
    const user = ctx.target.controlPlane.connection.user;
    const commands = filtered.map((u) => {
      const srcAbs = resolvePath(ctx.projectRoot, u.src);
      const isDir = existsSync(srcAbs) && statSync(srcAbs).isDirectory();
      const owned = uploadOwnedDir(u.dest, isDir);
      return `  mkdir -p '${owned}' && chown ${isDir ? '-R ' : ''}${user}: '${owned}'`;
    });
    const destList = [...new Set(commands)].join('\n');
    throw new DeployError(
      `Upload permission check failed:\n${failures.join('\n')}`,
      ErrorCode.DEPLOY_FAILED,
      `Ensure the deploy user has write access to all upload destinations.\nRun once on each failing server as root:\n${destList}`,
    );
  }
}

export async function uploadFiles(ctx: DeployContext): Promise<UploadRollbackPlan> {
  const backupBaseDir = `${DOCKFLOW_UPLOAD_BACKUPS_DIR}/${ctx.stackName}/${ctx.deployVersion}`;
  const filtered = filterUploadsByService(ctx);
  // nothing touches a node, so commit and rollback must not connect to any (a down node would fail them)
  if (filtered.length === 0) return { hosts: [], backupBaseDir };

  const plan: UploadRollbackPlan = {
    hosts: activeNodes(ctx.target).map((n) => ({ name: n.name, conn: n.connection, backedUp: [], created: [], backedUpDirs: [], createdDirs: [] })),
    backupBaseDir,
  };

  for (const upload of filtered) {
    const srcAbs = resolvePath(ctx.projectRoot, upload.src);
    const srcRel = relative(ctx.projectRoot, srcAbs).replace(/\\/g, '/');
    const inMemory = ctx.rendered.has(srcRel);
    if (!inMemory && !existsSync(srcAbs)) {
      printWarning(`upload: source not found, skipping: ${uploadName(upload)}`);
      continue;
    }

    const destBase = upload.dest.replace(/\/$/, '');

    if (!inMemory && statSync(srcAbs).isDirectory()) {
      const excludePatterns = upload.exclude ?? [];

      await Promise.all(
        plan.hosts.map(async (hostState) => {
          const { name, conn } = hostState;
          const backupPath = dirBackupPath(backupBaseDir, destBase);
          await sshExec(conn, `mkdir -p '${dirname(backupPath)}'`);
          const backupResult = await sshExec(
            conn,
            `if [ -d '${destBase}' ] && [ -n "$(ls -A '${destBase}' 2>/dev/null)" ]; then tar czf '${backupPath}' -C '${destBase}' . 2>/dev/null && echo backed_up; else echo missing; fi`,
          );
          if (backupResult.stdout.trim() === 'backed_up') hostState.backedUpDirs.push({ dest: destBase, backup: backupPath });
          else hostState.createdDirs.push(destBase);

          const mkdirResult = await sshExec(conn, `mkdir -p '${destBase}'`);
          if (mkdirResult.exitCode !== 0) {
            throw new DeployError(
              `upload: cannot create ${destBase} on ${name}: ${mkdirResult.stderr.trim() || `exit ${mkdirResult.exitCode}`}`,
              ErrorCode.DEPLOY_FAILED,
              `The deploy user must own the destination directory. Run once on the server as root:\n  mkdir -p '${destBase}' && chown ${conn.user}: '${destBase}'`,
            );
          }
        }),
      );

      const compress = upload.compress !== false;
      const compressFlag = compress ? '' : ' [no compression]';

      if (plan.hosts.length === 1) {
        const { name, conn } = plan.hosts[0];
        const isExcluded = buildExcludeFilter(excludePatterns);
        const totalBytes = walkDir(srcAbs)
          .filter((f) => !isExcluded(relative(srcAbs, f).replace(/\\/g, '/')))
          .reduce((sum, f) => sum + statSync(f).size, 0);
        const totalStr = formatBytes(totalBytes);
        const spinner = createSpinner();
        spinner.start(`upload: ${uploadName(upload)}/ -> ${name}:${destBase}/${compressFlag}`);
        let lastTick = 0;
        await streamDirToHost(
          srcAbs,
          excludePatterns,
          name,
          conn,
          destBase,
          compress,
          (bytesProcessed) => {
            const now = Date.now();
            if (now - lastTick < 250) return;
            lastTick = now;
            const pct = Math.min(99, Math.round((bytesProcessed / (totalBytes || 1)) * 100));
            spinner.update(`upload: ${uploadName(upload)}/ -> ${name}:${destBase}/ ${formatBytes(bytesProcessed)} / ${totalStr} (${pct}%)`);
          },
          () => spinner.update(`upload: unpacking on ${name}...`),
        );
        spinner.succeed(`upload: ${uploadName(upload)}/ -> ${name}:${destBase}/ done`);
        if (upload.permissions) await sshExec(conn, `chmod -R ${upload.permissions} '${destBase}'`);
        if (upload.owner) await sshExec(conn, `chown -R ${upload.owner} '${destBase}'`);
      } else {
        printDebug(`upload: ${uploadName(upload)}/ -> ${destBase}/${compressFlag} [${plan.hosts.length} hosts]`);
        await Promise.all(
          plan.hosts.map(async ({ name, conn }) => {
            await streamDirToHost(srcAbs, excludePatterns, name, conn, destBase, compress);
            printDebug(`  upload: -> ${name}:${destBase}/ done`);
            if (upload.permissions) await sshExec(conn, `chmod -R ${upload.permissions} '${destBase}'`);
            if (upload.owner) await sshExec(conn, `chown -R ${upload.owner} '${destBase}'`);
          }),
        );
      }
    } else {
      const destPath = resolveFileDestPath(upload.dest, basename(srcAbs));
      const backupPath = fileBackupPath(backupBaseDir, destPath);
      const renderedText = ctx.rendered.get(srcRel);
      const fileContent = renderedText !== undefined ? Buffer.from(renderedText) : readFileSync(srcAbs);

      await Promise.all(
        plan.hosts.map(async ({ name, conn }) => {
          const r = await sshExec(conn, `mkdir -p '${dirname(destPath)}' '${dirname(backupPath)}'`);
          if (r.exitCode !== 0) {
            throw new DeployError(
              `upload: cannot create ${dirname(destPath)} on ${name}: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
              ErrorCode.DEPLOY_FAILED,
              `The deploy user must own the destination directory. Run once on the server as root:\n  mkdir -p '${dirname(destPath)}' && chown ${conn.user}: '${dirname(destPath)}'`,
            );
          }
        }),
      );

      const tasks = plan.hosts.map((hostState) => async () => {
        const { name, conn } = hostState;
        const backupResult = await sshExec(conn, `if test -f '${destPath}'; then cp '${destPath}' '${backupPath}' && echo existed; else echo missing; fi`);
        if (backupResult.stdout.trim() === 'existed') hostState.backedUp.push(destPath);
        else hostState.created.push(destPath);

        const { stream, done } = await sshExecChannel(conn, `cat > '${destPath}'`);
        stream.end(fileContent);
        const result = await done;
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
          throw new DeployError(
            `upload: failed to transfer ${uploadName(upload)} -> ${destPath} on ${name}: ${detail}`,
            ErrorCode.DEPLOY_FAILED,
            `Ensure ${conn.user} has write access to ${dirname(destPath)} on ${name}. Run once as root:\n  mkdir -p '${dirname(destPath)}' && chown ${conn.user}: '${dirname(destPath)}'`,
          );
        }
        if (upload.permissions) {
          const r = await sshExec(conn, `chmod ${upload.permissions} '${destPath}'`);
          if (r.exitCode !== 0) {
            throw new DeployError(`upload: chmod ${upload.permissions} failed on ${destPath} (${name}): ${r.stderr.trim() || `exit ${r.exitCode}`}`, ErrorCode.DEPLOY_FAILED);
          }
        }
        if (upload.owner) {
          const r = await sshExec(conn, `chown ${upload.owner} '${destPath}'`);
          if (r.exitCode !== 0) {
            throw new DeployError(
              `upload: chown ${upload.owner} failed on ${destPath} (${name}): ${r.stderr.trim() || `exit ${r.exitCode}`}`,
              ErrorCode.DEPLOY_FAILED,
              `The deploy user needs sudo rights for chown. Either run once on the server as root:\n  chown ${upload.owner} '${destPath}'\nOr grant the deploy user the right permanently:\n  echo '${conn.user} ALL=(ALL) NOPASSWD: /bin/chown * ${dirname(destPath)}/*' >> /etc/sudoers.d/dockflow`,
            );
          }
        }
      });

      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);
      printDebug(`upload: ${uploadName(upload)} -> ${destPath}`);
    }
  }

  return plan;
}

export async function rollbackUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(
    plan.hosts.map(async ({ conn, backedUp, created, backedUpDirs, createdDirs }) => {
      for (const destPath of backedUp) {
        const backupPath = fileBackupPath(plan.backupBaseDir, destPath);
        const r = await sshExec(conn, `cp '${backupPath}' '${destPath}' && rm -f '${backupPath}'`);
        if (r.exitCode !== 0) throw new DeployError(`upload rollback: failed to restore '${destPath}': ${r.stderr.trim() || `exit ${r.exitCode}`}`, ErrorCode.DEPLOY_FAILED);
      }
      for (const destPath of created) await sshExec(conn, `rm -f '${destPath}'`);
      for (const { dest, backup } of backedUpDirs) {
        const tmp = `${dest}.dockflow-restore-${Date.now()}`;
        const r = await sshExec(conn, `mkdir -p '${tmp}' && tar xzf '${backup}' -C '${tmp}'`);
        if (r.exitCode !== 0) {
          await sshExec(conn, `rm -rf '${tmp}'`);
          throw new DeployError(`upload rollback: failed to extract backup for '${dest}': ${r.stderr.trim() || `exit ${r.exitCode}`}`, ErrorCode.DEPLOY_FAILED);
        }
        const swap = await sshExec(conn, `rm -rf '${dest}' && mv '${tmp}' '${dest}'`);
        if (swap.exitCode !== 0) {
          throw new DeployError(
            `upload rollback: failed to restore '${dest}': ${swap.stderr.trim() || `exit ${swap.exitCode}`}\nThe extracted backup is still available at '${tmp}' on the server.`,
            ErrorCode.DEPLOY_FAILED,
          );
        }
      }
      for (const dest of createdDirs) await sshExec(conn, `rm -rf '${dest}'`);
      await sshExec(conn, `rm -rf '${plan.backupBaseDir}'`);
    }),
  );
}

export async function commitUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(plan.hosts.map(({ conn }) => sshExec(conn, `rm -rf '${plan.backupBaseDir}'`)));
}

// ---------------------------------------------------------------------------
// 3.4 buildStackInput / siblingInput / buildAccessoriesInput
// ---------------------------------------------------------------------------

function accessoriesRelPath(ctx: DeployContext): string {
  const layout = getLayout();
  return layout.accessoriesPath ? relative(ctx.projectRoot, layout.accessoriesPath).replace(/\\/g, '/') : '.dockflow/docker/accessories.yml';
}

function loadAccessoriesCompose(ctx: DeployContext): ParsedCompose | null {
  const content = ctx.rendered.get(accessoriesRelPath(ctx));
  return content ? Compose.loadFromString(content) : null;
}

function configSourceOf(ctx: DeployContext): { file: string; text: string } {
  const layout = getLayout();
  const file = relative(ctx.projectRoot, layout.configPath).replace(/\\/g, '/');
  return { file, text: ctx.rendered.get(file) ?? '' };
}

/** Names of every Helm release of `role` declared in config.yml, --only filtering included (8.5). */
export function declaredHelmNames(config: DockflowConfig, role: StackRole): string[] {
  return (config.helm?.releases ?? []).filter((r) => (r.role ?? 'app') === role).map((r) => r.name);
}

export function parseOnly(only: string): string[] {
  return only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The compose a deploy renders, shared by the deploy and its dry run: built images tagged for this
 * version and, with --only, every other service kept at the image its current release runs.
 */
export async function composeForDeploy(ctx: DeployContext): Promise<ParsedCompose> {
  const compose = Compose.loadFromString(ctx.composeContent);
  Compose.updateImageTags(compose, ctx.config, ctx.env, ctx.deployVersion, ctx.options.only);
  if (!ctx.options.only) return compose;
  const current = await ctx.orchestrator.releases.currentCompose(ctx.stackName);
  return current ? Compose.syncNonTargetedImageTags(compose, Compose.loadFromString(current), parseOnly(ctx.options.only)) : compose;
}

/**
 * Pure: the sibling file is normalized first (core 3 / K27) so the checks that need more than keys
 * (external volumes, aliases, published ports, middleware names) have their inputs. Diagnostics of
 * this pass are discarded: only the sibling's own render can report on its own compose file.
 */
export function siblingInput(ctx: DeployContext, other: ParsedCompose | null, role: StackRole): StackDeployInput['sibling'] {
  const empty: StackDeployInput['sibling'] = { services: [], volumes: [], middlewares: [] };
  if (!other) return empty;

  const identity: StackIdentity = {
    project: ctx.config.project_name,
    env: ctx.env,
    stackName: ctx.stackName,
    namespace: namespaceFor(ctx.config.project_name, ctx.env),
    version: ctx.deployVersion,
  };

  const { stack } = normalizeStack({
    compose: other,
    role: role === 'app' ? 'accessory' : 'app',
    identity,
    proxy: ctx.config.proxy,
    sibling: empty,
    serverNames: activeNodes(ctx.target).map((n) => n.name),
    imageDelivery: 'none',
    files: createFileResolver(ctx.rendered, ctx.projectRoot, ctx.composeDirPath),
    traits: k3sDistribution.traits,
    sink: new DiagnosticSink(),
  });

  return {
    services: stack.services.map((s) => ({
      key: s.composeName,
      name: s.name,
      aliases: s.network.aliases,
      published: s.ports.filter((p) => p.published !== null).map((p) => ({ port: p.published as number, protocol: p.protocol })),
    })),
    volumes: stack.volumes.map((v) => ({ key: v.key, claimName: v.name, external: v.external })),
    middlewares: stack.middlewares.map((m) => m.name),
  };
}

export function buildStackInput(
  ctx: DeployContext,
  role: StackRole,
  compose: ParsedCompose,
  delivery: ImageDelivery,
  force = false,
): StackDeployInput {
  const other = role === 'app' ? loadAccessoriesCompose(ctx) : Compose.loadFromString(ctx.composeContent);
  const composeServices = {
    app: Object.keys((role === 'app' ? compose : other)?.services ?? {}),
    accessory: Object.keys((role === 'accessory' ? compose : other)?.services ?? {}),
  };

  const { releases } = resolveHelmReleases({
    helm: ctx.config.helm,
    role,
    stackNamespace: namespaceFor(ctx.config.project_name, ctx.env),
    configSource: configSourceOf(ctx),
    readValuesFile: renderedValuesFileLookup(ctx.rendered),
    composeServices,
    noServices: ctx.config.no_services === true,
    templates: ctx.config.templates,
  });

  return {
    ref: { project: ctx.config.project_name, env: ctx.env, role },
    version: ctx.deployVersion,
    compose,
    proxy: ctx.config.proxy,
    services: role === 'app' && ctx.options.only ? parseOnly(ctx.options.only) : null,
    previousVersion: null,
    force,
    images: delivery,
    helm: releases,
    helmDeclared: declaredHelmNames(ctx.config, role),
    sibling: siblingInput(ctx, other, role),
    serverNames: activeNodes(ctx.target).map((n) => n.name),
    rebindVolumes: ctx.options.rebindVolumes === true,
    traefikOnCluster: ctx.traefikOnCluster,
    files: createFileResolver(ctx.rendered, ctx.projectRoot, ctx.composeDirPath),
  };
}

/**
 * `liveHelmReleases`: accessory-role Helm releases are installed (hasLiveAccessoryReleases). The role
 * then runs without an accessories.yml too, as Helm-only apps do, so declared releases deploy and
 * undeclared ones are reported (8.5).
 */
export function buildAccessoriesInput(ctx: DeployContext, delivery: ImageDelivery, liveHelmReleases = false): StackDeployInput | null {
  if (ctx.skipAccessories) return null;
  const helmOnly = declaredHelmNames(ctx.config, 'accessory').length > 0 || liveHelmReleases;
  const compose = loadAccessoriesCompose(ctx) ?? (helmOnly ? Compose.emptyCompose() : null);
  if (!compose) return null;
  Compose.injectAccessoriesDefaults(compose, ctx.orchestrator.kind);
  return buildStackInput(ctx, 'accessory', compose, delivery, ctx.forceAccessories);
}

/** Only asked when nothing else runs the accessory role: no accessories.yml, no accessory release declared. */
export async function hasLiveAccessoryReleases(ctx: DeployContext): Promise<boolean> {
  if (ctx.skipAccessories || loadAccessoriesCompose(ctx) !== null || declaredHelmNames(ctx.config, 'accessory').length > 0) return false;
  const live = (await ctx.orchestrator.helm?.listAll(namespaceFor(ctx.config.project_name, ctx.env))) ?? [];
  return live.some((release) => release.role === 'accessory' && release.status !== 'uninstalled');
}

// ---------------------------------------------------------------------------
// 8.2 Diagnostics printing (once per role)
// ---------------------------------------------------------------------------

export function printArtifactDiagnostics(file: string, artifact: StackArtifact): void {
  for (const d of artifact.diagnostics) {
    if (d.severity === 'info') {
      printDebug(`${file} ${d.path}: ${d.message}`);
      continue;
    }
    printWarning(`${file} ${d.path}: ${d.message}`);
    if (d.hint) printDim(`  ${d.hint}`);
  }
}

// ---------------------------------------------------------------------------
// deployAccessories / deployApp (3.4)
// ---------------------------------------------------------------------------

const NATIVE: RevertResult = { status: 'native', services: [] };

/** K08: does this revert prove the app role runs what `previous` describes again? Pure. */
export function settles(r: RevertResult, previousVersion: string | null, nativeRolledBack: boolean): boolean {
  if (r.status === 'native') return nativeRolledBack;
  if (r.status === 'reverted') return true;
  return r.status === 'nothing-to-revert' && previousVersion === null;
}

async function revertIfBackend(ctx: DeployContext, receipt: DeployReceipt): Promise<RevertResult> {
  if (ctx.orchestrator.capabilities.revert === 'native') return NATIVE;
  const result = await ctx.orchestrator.stack.revert(receipt);
  if (result.status === 'reverted' && receipt.ref.role === 'app') ctx.revertedTo = receipt.previousVersion;
  return result;
}

/**
 * `finalize` is documented to never throw (interfaces.ts `StackBackend.finalize`, K33 (a)): both
 * real backends already turn every internal failure into a warning. This is defense in depth for a
 * backend that breaks the contract anyway — a throwing prune must never turn a converged, healthy
 * deploy into a "did we ship it?" failure (U-FLOW-12).
 */
async function safeFinalize(stack: StackBackend, receipt: DeployReceipt): Promise<void> {
  try {
    await stack.finalize(receipt);
  } catch (error) {
    printWarning(`Cleanup after deploy failed: ${message(error)}; the deploy itself succeeded`);
  }
}

export async function deployAccessories(ctx: DeployContext, input: StackDeployInput | null): Promise<void> {
  if (!input) return; // skipped or no accessories.yml
  const stack = ctx.orchestrator.stack; // already rendered and printed by execute()
  const deployed = await stack.deploy(input);
  if (!deployed.success) throw deployed.error;
  const receipt = deployed.data;
  if (receipt.skipped) {
    printInfo('Accessories unchanged, skipping');
    return;
  }

  const convergence = await stack.waitConvergence(receipt, { timeoutS: CONVERGENCE_TIMEOUT_S, intervalS: CONVERGENCE_INTERVAL_S });
  if (convergence.status !== 'converged') {
    const revert = convergence.status === 'reverted' ? NATIVE : await revertIfBackend(ctx, receipt);
    throw convergenceFailureError(convergence, revert, { env: ctx.env, role: 'accessory', previousVersion: null });
  }
  await safeFinalize(stack, receipt);
  printSuccess('Accessories deployed');
}

export async function deployApp(ctx: DeployContext, input: StackDeployInput): Promise<void> {
  if (!ctx.deployApp) return;
  const hasServices = Compose.hasServices(input.compose);
  if (!hasServices && input.helm.length === 0) return; // Helm-only projects still deploy (design-04 3.11)

  const orch = ctx.orchestrator;
  // proxy.ensure already ran in execute() (K09), before accessories and independently of deployApp

  const deployed = await orch.stack.deploy({
    ...input,
    onApplyProgress: (p) => {
      if (p.kind === 'started') ctx.applyStarted = true;
      else ctx.appSettled = settles(p.revert, input.previousVersion, false);
    },
  });
  if (!deployed.success) throw deployed.error; // backend already reverted a partial apply (5.8)
  const receipt = deployed.data;

  const convergence = await orch.stack.waitConvergence(receipt, { timeoutS: CONVERGENCE_TIMEOUT_S, intervalS: CONVERGENCE_INTERVAL_S });
  if (convergence.status !== 'converged') {
    const revert = convergence.status === 'reverted' ? NATIVE : await revertIfBackend(ctx, receipt);
    ctx.appSettled = settles(revert, input.previousVersion, convergence.status === 'reverted');
    throw convergenceFailureError(convergence, revert, { env: ctx.env, role: 'app', previousVersion: input.previousVersion });
  }

  const hc = ctx.config.health_checks;
  if (hc?.enabled !== false) {
    const health = await orch.stack.checkHealth(receipt, {
      timeoutS: hc?.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_S,
      intervalS: hc?.interval ?? DEFAULT_HEALTHCHECK_INTERVAL_S,
      stabilityS: HEALTH_STABILITY_WINDOW_S,
    });
    if (!health.healthy) {
      const revert = health.rolledBack ? NATIVE : await revertIfBackend(ctx, receipt);
      ctx.appSettled = settles(revert, input.previousVersion, health.rolledBack);
      throw healthFailureError(health, revert, { env: ctx.env, role: 'app', previousVersion: input.previousVersion });
    }
  }

  await safeFinalize(orch.stack, receipt);
}

// ---------------------------------------------------------------------------
// HTTP health checks (health-check.ts keeps the endpoint logic; this decides when to run it)
// ---------------------------------------------------------------------------

export async function runHTTPHealthChecks(ctx: DeployContext): Promise<void> {
  if (!ctx.deployApp || !ctx.config.health_checks?.endpoints?.length) return;
  const health = new HealthCheck(ctx.target.controlPlane.connection);
  await health.checkHTTPEndpoints(ctx.config.health_checks);
}

/**
 * Best-effort only: there is nothing left to roll back to if this fails. `on_failure` is forced to
 * `notify` because rolling back a rollback is not an option. Takes only the two fields it reads
 * (not a full `DeployContext`) so `dockflow rollback <env>` (design-06 3.13), which has no deploy
 * context to build, can call it too.
 */
export async function runPostRollbackHealthChecks(config: DockflowConfig, orchestrator: Orchestrator): Promise<void> {
  const hc: HealthCheckConfig | undefined = config.health_checks;
  if (hc?.enabled === false || !hc?.endpoints?.length) return;
  const health = new HealthCheck(orchestrator.target.controlPlane.connection);
  await health.checkHTTPEndpoints({ ...hc, on_failure: 'notify' }).catch((e) => printWarning(`Post-rollback health check failed: ${message(e)}`));
}

// ---------------------------------------------------------------------------
// 19.3 Deploy cleanup failover
// ---------------------------------------------------------------------------

/** `OrchestratorUnavailableError` from `Unreachable`, `Timeout`, or an SSH transport failure. */
export function isControlPlaneLoss(error: unknown): boolean {
  if (!(error instanceof OrchestratorUnavailableError)) return false;
  const cause = error.cause;
  if (cause instanceof KubeError) return cause.reason === 'Unreachable' || cause.reason === 'Timeout';
  return true; // SSH transport-level failures reach here without a KubeError cause
}

/**
 * When the deploy fails with a control-plane loss and the environment has several managers,
 * re-resolve a control plane before touching the release record and the lock, so a dead server
 * does not leave a Lease behind for 30 minutes.
 */
export async function cleanupBundle(ctx: DeployContext, error: unknown): Promise<Orchestrator> {
  if (!isControlPlaneLoss(error) || ctx.target.managers.length < 2 || ctx.options.failover === false) return ctx.orchestrator;
  try {
    const reopened = await openOrchestrator(ctx.env, { failover: true, requireWorkerCredentials: false });
    if (reopened.orchestrator.target.controlPlane.name !== ctx.target.controlPlane.name) {
      printWarning(`Control plane ${ctx.target.controlPlane.name} was lost; finishing cleanup on ${reopened.orchestrator.target.controlPlane.name}`);
    }
    return reopened.orchestrator;
  } catch {
    return ctx.orchestrator; // nothing ready: cleanup fails with warnings, lock stays (stale later)
  }
}

export async function releaseLock(ctx: DeployContext, lock: LockStore, acquired: LockData): Promise<void> {
  const first = await lock.release();
  if (first.success) return;
  const bundle = ctx.cleanupOrchestrator ?? ctx.orchestrator;
  if (bundle === ctx.orchestrator) {
    printWarning(`Lock release failed: ${first.error.message}`);
    return;
  }
  const other = bundle.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
  const status = await other.status();
  if (status.success && status.data.data?.started_at === acquired.started_at && status.data.data.performer === acquired.performer) {
    const second = await other.release(); // unconditional, after verifying the holder is this deploy
    if (!second.success) printWarning(`Lock release failed: ${second.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// History (audit + metrics + sync), best-effort — Swarm-visible, unchanged behaviour (19.3)
// ---------------------------------------------------------------------------

/** Connections that receive history-sync writes: every active node except the control plane. */
function historySyncConns(target: DeployContext['target']): SSHKeyConnection[] {
  return [...target.managers.filter((m) => m.name !== target.controlPlane.name), ...target.workers].map((n) => n.connection);
}

export async function recordHistory(ctx: DeployContext, status: 'success' | 'failed', durationMs: number, auditMessage: string): Promise<void> {
  let auditLine = '';
  let metricsJson = '';

  const [auditResult, metricsResult] = await Promise.allSettled([
    ctx.audit.writeEntry(ctx.stackName, status === 'success' ? 'deployed' : 'failed', auditMessage, ctx.deployVersion),
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
      nodeCount: activeNodes(ctx.target).length,
    }),
  ]);

  if (auditResult.status === 'fulfilled') auditLine = auditResult.value;
  else printWarning(`Audit write failed: ${message(auditResult.reason)}`);

  if (metricsResult.status === 'fulfilled') metricsJson = metricsResult.value;
  else printWarning(`Metrics write failed: ${message(metricsResult.reason)}`);

  await HistorySync.syncToAllNodes(historySyncConns(ctx.target), ctx.stackName, auditLine, metricsJson).catch((e) => printWarning(`History sync failed: ${message(e)}`));
}
