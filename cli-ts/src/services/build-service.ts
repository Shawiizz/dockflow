/**
 * Build Service
 *
 * Replaces the Ansible roles `local-build` and `remote-build`.
 * Extracts build targets from docker-compose via decomposerize,
 * executes local or remote Docker builds, and handles .dockerignore.
 */

import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDebug, printDim, printRaw, printSuccess, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';

export interface BuildTarget {
  dockerfile: string;
  context: string;
  tag: string;
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

  return {
    dockerfile: resolve(basePath, dockerfile),
    context: resolve(basePath, context),
    tag,
  };
}

export class BuildService {
  /**
   * Extract build targets from a docker-compose file using decomposerize.
   */
  static async getBuildTargets(
    composePath: string,
    servicesFilter?: string,
  ): Promise<BuildTarget[]> {
    const args = [composePath, '--docker-build'];
    if (servicesFilter) {
      args.push(`--services=${servicesFilter}`);
    }

    const proc = Bun.spawn(['decomposerize', ...args], {
      cwd: dirname(composePath),
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

    const basePath = dirname(composePath);
    const targets: BuildTarget[] = [];

    for (const line of stdout.trim().split('\n')) {
      const target = parseBuildCommand(line, basePath);
      if (target) targets.push(target);
    }

    return targets;
  }

  /**
   * Build a single Docker image locally.
   * Handles .dockerignore via tar piping if present.
   */
  static async buildImage(target: BuildTarget): Promise<void> {
    const dockerignorePath = join(target.context, '.dockerignore');
    const hasDockerignore = existsSync(dockerignorePath);

    let proc: ReturnType<typeof Bun.spawn>;

    if (hasDockerignore) {
      // Build via tar to respect .dockerignore
      const tarArgs = [
        'tar', '-chf', '-',
        '--exclude-from', dockerignorePath,
        '-C', target.context, '.',
      ];
      const tarProc = Bun.spawn(tarArgs, {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      proc = Bun.spawn(
        ['docker', 'build', '-f', target.dockerfile, '-t', target.tag, '-'],
        {
          stdin: tarProc.stdout,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      await tarProc.exited;
    } else {
      proc = Bun.spawn(
        ['docker', 'build', '-f', target.dockerfile, '-t', target.tag, target.context],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
    }

    // Collect output
    const stdoutText = (proc.stdout && typeof proc.stdout !== 'number')
      ? await new Response(proc.stdout).text()
      : '';
    const stderrText = (proc.stderr && typeof proc.stderr !== 'number')
      ? await new Response(proc.stderr).text()
      : '';

    await proc.exited;

    if (proc.exitCode !== 0) {
      if (stdoutText) printRaw(stdoutText);
      if (stderrText) printRaw(stderrText);
      throw new DeployError(
        `Docker build failed for ${target.tag} (exit ${proc.exitCode})`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
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
      printDim(`Building ${targets[0].tag}...`);
      await BuildService.buildImage(targets[0]);
      const durationMs = Date.now() - startTime;
      printSuccess(`Built ${targets[0].tag} in ${(durationMs / 1000).toFixed(1)}s`);
      return { images: [targets[0].tag], durationMs };
    }

    // Parallel builds
    printDim(`Building ${targets.length} images in parallel...`);

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const t0 = Date.now();
        await BuildService.buildImage(target);
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        printSuccess(`Built ${target.tag} in ${dur}s`);
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
      composePath: string;
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

      // 4. Get build targets from local compose
      const targets = await BuildService.getBuildTargets(
        params.composePath,
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
        const relDockerfile = target.dockerfile.replace(params.projectRoot, '').replace(/\\/g, '/');
        const relContext = target.context.replace(params.projectRoot, '').replace(/\\/g, '/');
        const remoteDockerfile = `${tmpDir}${relDockerfile}`;
        const remoteContext = `${tmpDir}${relContext}`;

        const buildResult = await sshExec(
          connection,
          `docker build -f "${remoteDockerfile}" -t "${target.tag}" "${remoteContext}" 2>&1`,
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
