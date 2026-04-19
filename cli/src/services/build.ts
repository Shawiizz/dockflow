/**
 * Build — Docker/Podman image builds (local and remote).
 *
 * Local builds use tar-stdin: the build context is assembled in memory
 * (with rendered template overrides) and piped to `docker build -`.
 * No temporary files are written to disk.
 */

import { resolve, join, relative } from 'path';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDim, printRaw, printSuccess, printWarning, createTaskLog } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { createTar, type TarEntry } from '../utils/tar';
import { parseDockerignore } from '../utils/dockerignore';

export interface BuildTarget {
  /** Relative path used for `-f` flag (path within the tar) */
  dockerfile: string;
  /** Absolute path to the Dockerfile on disk */
  dockerfileAbsPath: string;
  /** Absolute path to the context directory on disk */
  context: string;
  /** Docker image tag */
  tag: string;
  /** Rendered template overrides: relative path (within context) → content */
  renderedOverrides?: Map<string, string>;
  /** Target platform for cross-compilation (e.g. 'linux/arm64') */
  platform?: string;
  /** Container engine to use for building ('docker' or 'podman') */
  engine?: 'docker' | 'podman';
}

export interface BuildResult {
  images: string[];
  durationMs: number;
}

/**
 * Walk a directory collecting tar entries, skipping ignored dirs early.
 * This avoids traversing into node_modules, .next, .git etc.
 */
function collectEntries(
  dir: string,
  contextDir: string,
  shouldInclude: (relPath: string) => boolean,
  overrides: Map<string, string> | undefined,
  entries: TarEntry[],
  addedOverrides: Set<string>,
): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relPath = relative(contextDir, full).replace(/\\/g, '/');

    if (!shouldInclude(relPath)) continue;

    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectEntries(full, contextDir, shouldInclude, overrides, entries, addedOverrides);
    } else {
      if (overrides?.has(relPath)) {
        entries.push({ path: relPath, content: overrides.get(relPath)! });
        addedOverrides.add(relPath);
      } else {
        entries.push({ path: relPath, content: readFileSync(full) });
      }
    }
  }
}

/**
 * Build a tar archive for a Docker build context.
 */
async function buildContextTar(target: BuildTarget): Promise<Buffer> {
  const contextDir = target.context;
  const entries: TarEntry[] = [];

  const dockerignorePath = join(contextDir, '.dockerignore');
  let shouldInclude: (path: string) => boolean = () => true;
  if (existsSync(dockerignorePath)) {
    const ignoreContent = readFileSync(dockerignorePath, 'utf-8');
    shouldInclude = parseDockerignore(ignoreContent);
  }

  const overrides = target.renderedOverrides;
  const addedOverrides = new Set<string>();

  collectEntries(contextDir, contextDir, shouldInclude, overrides, entries, addedOverrides);

  if (overrides) {
    for (const [relPath, content] of overrides) {
      if (!addedOverrides.has(relPath) && shouldInclude(relPath)) {
        entries.push({ path: relPath, content });
      }
    }
  }

  const dockerfilePath = target.dockerfile.replace(/\\/g, '/');
  const hasDockerfile = entries.some(e => e.path === dockerfilePath);
  if (!hasDockerfile) {
    if (overrides?.has(dockerfilePath)) {
      entries.push({ path: dockerfilePath, content: overrides.get(dockerfilePath)! });
    } else if (existsSync(target.dockerfileAbsPath)) {
      entries.push({ path: dockerfilePath, content: readFileSync(target.dockerfileAbsPath) });
    }
  }

  return await createTar(entries);
}

/**
 * Compute rendered overrides for a build target from a RenderedFiles map.
 * Filters entries within the target's context dir, re-keys them relative
 * to the context, and includes the Dockerfile override if it's outside.
 */
export function getOverridesForTarget(
  rendered: Map<string, string>,
  target: BuildTarget,
  projectRoot: string,
): Map<string, string> {
  const overrides = new Map<string, string>();
  const contextRel = relative(projectRoot, target.context).replace(/\\/g, '/');

  for (const [relPath, content] of rendered) {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.startsWith(contextRel + '/')) {
      const contextRelPath = normalized.slice(contextRel.length + 1);
      overrides.set(contextRelPath, content);
    }
  }

  const dockerfileProjectRel = relative(projectRoot, target.dockerfileAbsPath).replace(/\\/g, '/');
  if (!dockerfileProjectRel.startsWith(contextRel + '/')) {
    const renderedDockerfile = rendered.get(dockerfileProjectRel);
    if (renderedDockerfile) {
      overrides.set(target.dockerfile.replace(/\\/g, '/'), renderedDockerfile);
    }
  }

  return overrides;
}

/**
 * Extract build targets from a compose YAML string.
 * Parses the YAML directly — no external dependency needed.
 */
export function getBuildTargets(
  composeContent: string,
  basePath: string,
  servicesFilter?: string,
): BuildTarget[] {
  const compose = parseYaml(composeContent) as Record<string, unknown>;
  const services = (compose.services ?? {}) as Record<string, Record<string, unknown>>;
  const filterSet = servicesFilter
    ? new Set(servicesFilter.split(',').map(s => s.trim()))
    : null;

  const targets: BuildTarget[] = [];

  for (const [name, svc] of Object.entries(services)) {
    if (filterSet && !filterSet.has(name)) continue;

    const build = svc.build;
    if (!build) continue;

    let dockerfile: string;
    let context: string;

    if (typeof build === 'string') {
      context = build;
      dockerfile = 'Dockerfile';
    } else if (typeof build === 'object') {
      const buildObj = build as Record<string, unknown>;
      dockerfile = (buildObj.dockerfile as string) ?? 'Dockerfile';
      context = (buildObj.context as string) ?? '.';
    } else {
      continue;
    }

    const tag = (svc.image as string) ?? `${name}:latest`;
    const resolvedContext = resolve(basePath, context);
    const resolvedDockerfile = typeof build === 'string'
      ? resolve(resolvedContext, dockerfile)
      : resolve(basePath, dockerfile);

    targets.push({
      dockerfile,
      dockerfileAbsPath: resolvedDockerfile,
      context: resolvedContext,
      tag,
    });
  }

  return targets;
}

/**
 * Build a single Docker image locally via tar-stdin.
 */
export async function buildImage(target: BuildTarget): Promise<void> {
  const tar = await buildContextTar(target);
  const cmd = target.engine || 'docker';

  const args = [cmd, 'build', '--progress=plain'];
  if (target.platform) {
    args.push('--platform', target.platform);
  }
  args.push('-f', target.dockerfile, '-t', target.tag, '-');

  const proc = Bun.spawn(args, {
    stdin: new Blob([new Uint8Array(tar)]).stream(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const log = createTaskLog(`Building ${target.tag}`);

  async function streamToLog(stream: ReadableStream<Uint8Array> | null) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) log.message(line.trimEnd());
        }
      }
      if (buffer.trim()) log.message(buffer.trimEnd());
    } finally {
      reader.releaseLock();
    }
  }

  await Promise.all([
    streamToLog(proc.stdout as ReadableStream<Uint8Array> | null),
    streamToLog(proc.stderr as ReadableStream<Uint8Array> | null),
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    log.error(`Build failed for ${target.tag} (exit ${proc.exitCode})`);
    throw new DeployError(
      `Build failed for ${target.tag} (exit ${proc.exitCode})`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  log.success(`Built ${target.tag}`);
}

/**
 * Build all targets. Single target streams output; multiple run in parallel.
 */
export async function buildAll(targets: BuildTarget[]): Promise<BuildResult> {
  if (targets.length === 0) {
    return { images: [], durationMs: 0 };
  }

  const startTime = Date.now();

  if (targets.length === 1) {
    await buildImage(targets[0]);
    return { images: [targets[0].tag], durationMs: Date.now() - startTime };
  }

  printDim(`Building ${targets.length} images in parallel...`);

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      await buildImage(target);
      return target.tag;
    }),
  );

  const built: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      built.push(r.value);
    } else {
      failed.push(targets[i].tag);
    }
  }

  if (failed.length > 0) {
    throw new DeployError(
      `Build failed for: ${failed.join(', ')}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  return { images: built, durationMs: Date.now() - startTime };
}

/**
 * Build git auth env vars for cloning via HTTP.
 * Uses GIT_CONFIG_* env vars so the token never appears in process args.
 */
function buildGitAuthEnv(): string {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.CI_JOB_TOKEN ||
    process.env.GIT_TOKEN;

  if (!token) return '';

  const header = process.env.CI_JOB_TOKEN
    ? `PRIVATE-TOKEN: ${token}`
    : `Authorization: Bearer ${token}`;

  const eHeader = shellEscape(header);
  return `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.extraHeader' GIT_CONFIG_VALUE_0='${eHeader}' `;
}

/**
 * Build images on a remote server via SSH.
 *
 * 1. Git clone the repo on the remote host
 * 2. Extract build targets locally
 * 3. Execute builds on remote
 * 4. Cleanup temp dir
 */
export async function buildRemote(
  connection: SSHKeyConnection,
  params: {
    projectRoot: string;
    composeContent: string;
    composeDirPath: string;
    projectName: string;
    env: string;
    branch: string;
    servicesFilter?: string;
    engine?: 'docker' | 'podman';
  },
): Promise<BuildResult> {
  const startTime = Date.now();
  const timestamp = Date.now();
  const tmpDir = `/tmp/dockflow-build-${params.projectName}-${params.env}-${timestamp}`;

  try {
    const repoUrlProc = Bun.spawn(['git', 'config', '--get', 'remote.origin.url'], {
      cwd: params.projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const repoUrl = (await new Response(repoUrlProc.stdout).text()).trim();
    await repoUrlProc.exited;

    const commitProc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      cwd: params.projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const commitSha = (await new Response(commitProc.stdout).text()).trim();
    await commitProc.exited;

    const authEnv = buildGitAuthEnv();
    const eBranch = shellEscape(params.branch);
    const eRepoUrl = shellEscape(repoUrl);
    const eTmpDir = shellEscape(tmpDir);

    printDim(`Cloning repo on remote (${params.branch})...`);
    const cloneResult = await sshExec(
      connection,
      `${authEnv}GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" git clone --branch '${eBranch}' --single-branch '${eRepoUrl}' '${eTmpDir}' 2>&1`,
    );
    if (cloneResult.exitCode !== 0) {
      const output = (cloneResult.stderr.trim() || cloneResult.stdout.trim())
        .replace(/Authorization: Bearer [^\s'"]*/gi, 'Authorization: ***')
        .replace(/PRIVATE-TOKEN: [^\s'"]*/gi, 'PRIVATE-TOKEN: ***');
      throw new DeployError(
        `Remote git clone failed: ${output}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    const eCommitSha = shellEscape(commitSha);
    await sshExec(connection, `git -C '${eTmpDir}' checkout '${eCommitSha}' 2>&1`);

    const targets = getBuildTargets(
      params.composeContent,
      params.composeDirPath,
      params.servicesFilter,
    );

    if (targets.length === 0) {
      printWarning('No build targets found');
      return { images: [], durationMs: Date.now() - startTime };
    }

    if (params.engine) {
      for (const target of targets) {
        target.engine = params.engine;
      }
    }

    printDim(`Building ${targets.length} image(s) on remote...`);
    const images: string[] = [];

    for (const target of targets) {
      const relDockerfile = relative(target.context, target.dockerfileAbsPath).replace(/\\/g, '/');
      const relContext = relative(params.projectRoot, target.context).replace(/\\/g, '/');
      const remoteContext = `${tmpDir}/${relContext}`;

      const eDockerfile = shellEscape(`${remoteContext}/${relDockerfile}`);
      const eTag = shellEscape(target.tag);
      const eContext = shellEscape(remoteContext);

      const remoteEngine = target.engine || 'docker';

      const buildResult = await sshExec(
        connection,
        `${remoteEngine} build -f '${eDockerfile}' -t '${eTag}' '${eContext}' 2>&1`,
      );

      if (buildResult.exitCode !== 0) {
        printRaw(buildResult.stdout);
        throw new DeployError(
          `Remote build failed for ${target.tag}`,
          ErrorCode.DEPLOY_FAILED,
        );
      }

      printSuccess(`Built ${target.tag} (remote)`);
      images.push(target.tag);
    }

    return { images, durationMs: Date.now() - startTime };
  } finally {
    await sshExec(connection, `rm -rf '${shellEscape(tmpDir)}'`).catch(() => {});
  }
}
