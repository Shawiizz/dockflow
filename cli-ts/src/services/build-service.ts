/**
 * Build Service
 *
 * Replaces the Ansible roles `local-build` and `remote-build`.
 * Extracts build targets from docker-compose via decomposerize,
 * executes local or remote Docker builds, and handles .dockerignore.
 *
 * Local builds use tar-stdin: the build context is assembled in memory
 * (with rendered template overrides) and piped to `docker build -`.
 * No temporary files are written to disk.
 */

import { resolve, dirname, join, relative } from 'path';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDebug, printDim, printRaw, printSuccess, printWarning, createTaskLog } from '../utils/output';
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
}

export interface BuildResult {
  images: string[];
  durationMs: number;
}

/**
 * Parse a `docker build` command line into a BuildTarget.
 * Expected format: docker build -f <dockerfile> -t "<tag>" <context>
 */
function parseBuildCommand(line: string, basePath: string): BuildTarget | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('docker build')) return null;

  let dockerfile = '';
  let tag = '';
  let context = '.';

  const parts = trimmed.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-f' && parts[i + 1]) {
      dockerfile = parts[++i];
    } else if (parts[i] === '-t' && parts[i + 1]) {
      tag = parts[++i].replace(/^["']|["']$/g, '');
    }
  }

  // Last non-flag argument is the context
  const lastPart = parts[parts.length - 1];
  if (lastPart && !lastPart.startsWith('-') && lastPart !== 'build') {
    context = lastPart;
  }

  if (!dockerfile || !tag) return null;

  const contextAbsolute = resolve(basePath, context);

  return {
    dockerfile,
    dockerfileAbsPath: resolve(basePath, dockerfile),
    context: contextAbsolute,
    tag,
  };
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

    // Check ignore BEFORE descending — this is the key optimization
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
 * Walks the context directory skipping .dockerignore'd paths at the directory
 * level (never descends into node_modules etc.), overlays rendered template
 * overrides, and returns a single tar buffer.
 */
async function buildContextTar(target: BuildTarget): Promise<Buffer> {
  const contextDir = target.context;
  const entries: TarEntry[] = [];

  // Parse .dockerignore if present
  const dockerignorePath = join(contextDir, '.dockerignore');
  let shouldInclude: (path: string) => boolean = () => true;
  if (existsSync(dockerignorePath)) {
    const ignoreContent = readFileSync(dockerignorePath, 'utf-8');
    shouldInclude = parseDockerignore(ignoreContent);
  }

  const overrides = target.renderedOverrides;
  const addedOverrides = new Set<string>();

  // Walk + filter in one pass (skips ignored directories early)
  collectEntries(contextDir, contextDir, shouldInclude, overrides, entries, addedOverrides);

  // Add any overrides for files that don't exist on disk yet
  // (e.g. .j2 files that produce a new file)
  if (overrides) {
    for (const [relPath, content] of overrides) {
      if (!addedOverrides.has(relPath) && shouldInclude(relPath)) {
        entries.push({ path: relPath, content });
      }
    }
  }

  // Inject Dockerfile if it's outside the context directory
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

export class BuildService {
  /**
   * Compute rendered overrides for a build target from a RenderedFiles map.
   * Filters entries within the target's context dir, re-keys them relative
   * to the context, and includes the Dockerfile override if it's outside.
   */
  static getOverridesForTarget(
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

    // Include Dockerfile override if it's outside the context
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
   * Extract build targets from compose content using decomposerize via stdin.
   * No temporary files are written.
   */
  static async getBuildTargets(
    composeContent: string,
    basePath: string,
    servicesFilter?: string,
  ): Promise<BuildTarget[]> {
    const args = ['--docker-build'];
    if (servicesFilter) {
      args.push(`--services=${servicesFilter}`);
    }

    const proc = Bun.spawn(['decomposerize', ...args], {
      cwd: basePath,
      stdin: new Response(composeContent).body!,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new DeployError(
        `decomposerize failed (exit ${proc.exitCode}): ${stderr.trim()}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    const targets: BuildTarget[] = [];

    for (const line of stdout.trim().split('\n')) {
      const target = parseBuildCommand(line, basePath);
      if (target) targets.push(target);
    }

    return targets;
  }

  /**
   * Build a single Docker image locally via tar-stdin.
   * Assembles the build context as a tar archive in memory (including
   * rendered template overrides) and pipes it to `docker build -`.
   * Streams output via clack taskLog (shows live, clears on success).
   */
  static async buildImage(target: BuildTarget): Promise<void> {
    const tar = await buildContextTar(target);

    const proc = Bun.spawn(
      ['docker', 'build', '--progress=plain', '-f', target.dockerfile, '-t', target.tag, '-'],
      {
        stdin: new Blob([new Uint8Array(tar)]).stream(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

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
        `Docker build failed for ${target.tag} (exit ${proc.exitCode})`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    log.success(`Built ${target.tag}`);
  }

  /**
   * Build all targets. Single target streams output; multiple run in parallel.
   */
  static async buildAll(targets: BuildTarget[]): Promise<BuildResult> {
    if (targets.length === 0) {
      return { images: [], durationMs: 0 };
    }

    const startTime = Date.now();

    if (targets.length === 1) {
      await BuildService.buildImage(targets[0]);
      return { images: [targets[0].tag], durationMs: Date.now() - startTime };
    }

    // Parallel builds
    printDim(`Building ${targets.length} images in parallel...`);

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        await BuildService.buildImage(target);
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
   * Build images on a remote server via SSH.
   *
   * 1. Git clone the repo on the remote host
   * 2. Extract build targets locally
   * 3. Execute builds on remote
   * 4. Cleanup temp dir
   */
  static async buildRemote(
    connection: SSHKeyConnection,
    params: {
      projectRoot: string;
      composeContent: string;
      composeDirPath: string;
      projectName: string;
      env: string;
      branch: string;
      servicesFilter?: string;
    },
  ): Promise<BuildResult> {
    const startTime = Date.now();
    const timestamp = Date.now();
    const tmpDir = `/tmp/dockflow-build-${params.projectName}-${params.env}-${timestamp}`;

    try {
      // 1. Get repo info locally
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

      // 2. Inject auth token into URL
      const authUrl = BuildService.injectGitAuth(repoUrl);

      // 3. Git clone on remote
      printDim(`Cloning repo on remote (${params.branch})...`);
      const cloneResult = await sshExec(
        connection,
        `git clone --branch ${params.branch} --single-branch ${authUrl} ${tmpDir} 2>&1`,
      );
      if (cloneResult.exitCode !== 0) {
        throw new DeployError(
          `Remote git clone failed: ${cloneResult.stderr.trim() || cloneResult.stdout.trim()}`,
          ErrorCode.DEPLOY_FAILED,
        );
      }

      // Checkout exact commit
      await sshExec(connection, `git -C ${tmpDir} checkout ${commitSha} 2>&1`);

      // 4. Get build targets from compose content via stdin
      const targets = await BuildService.getBuildTargets(
        params.composeContent,
        params.composeDirPath,
        params.servicesFilter,
      );

      if (targets.length === 0) {
        printWarning('No build targets found');
        return { images: [], durationMs: Date.now() - startTime };
      }

      // 5. Execute builds on remote
      printDim(`Building ${targets.length} image(s) on remote...`);
      const images: string[] = [];

      for (const target of targets) {
        // Rebase paths to remote tmpDir
        const relDockerfile = target.dockerfile;
        const relContext = relative(params.projectRoot, target.context).replace(/\\/g, '/');
        const remoteContext = `${tmpDir}/${relContext}`;

        const buildResult = await sshExec(
          connection,
          `docker build -f "${remoteContext}/${relDockerfile}" -t "${target.tag}" "${remoteContext}" 2>&1`,
        );

        if (buildResult.exitCode !== 0) {
          printRaw(buildResult.stdout);
          throw new DeployError(
            `Remote build failed for ${target.tag}`,
            ErrorCode.DEPLOY_FAILED,
          );
        }

        images.push(target.tag);
        printSuccess(`Built ${target.tag} (remote)`);
      }

      return { images, durationMs: Date.now() - startTime };
    } finally {
      // Always cleanup
      await sshExec(connection, `rm -rf "${tmpDir}"`).catch(() => {});
    }
  }

  /**
   * Inject git auth token into a repository URL.
   * Checks GITHUB_TOKEN, CI_JOB_TOKEN, GIT_TOKEN env vars.
   */
  private static injectGitAuth(repoUrl: string): string {
    const token =
      process.env.GITHUB_TOKEN ||
      process.env.CI_JOB_TOKEN ||
      process.env.GIT_TOKEN;

    if (!token) return repoUrl;

    try {
      const url = new URL(repoUrl);

      if (process.env.GITHUB_TOKEN) {
        url.username = 'x-access-token';
        url.password = token;
      } else if (process.env.CI_JOB_TOKEN) {
        url.username = 'oauth2';
        url.password = token;
      } else {
        url.username = 'token';
        url.password = token;
      }

      return url.toString();
    } catch {
      // If URL parsing fails (e.g. SSH URL), return as-is
      return repoUrl;
    }
  }
}
