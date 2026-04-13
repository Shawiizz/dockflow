/**
 * Distribution Service
 *
 * Streams Docker images to nodes via SSH pipe.
 * Supports both Docker (docker save/load) and containerd (k3s ctr import) runtimes.
 * Also handles registry push and authentication.
 */

import type { ClientChannel } from 'ssh2';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel, shellEscape } from '../utils/ssh';
import { printDebug, printDim, printSuccess, printWarning, createTimedSpinner } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { parseImageRef } from './compose-service';

export type ContainerRuntime = 'docker' | 'containerd' | 'podman';

export interface DistributionTarget {
  connection: SSHKeyConnection;
  name: string;
}

const TRANSFER_MAX_RETRIES = 2;

/** Returns the shell command to import a gzipped image tar on the remote. */
function importCommand(runtime: ContainerRuntime): string {
  if (runtime === 'containerd') return 'gunzip | sudo k3s ctr -n k8s.io images import -';
  return `gunzip | ${runtime} load`;
}

/** Returns the shell command to save an image on a remote host. */
function saveCommand(image: string, runtime: ContainerRuntime): string {
  if (runtime === 'containerd') return `sudo k3s ctr -n k8s.io images export - '${shellEscape(image)}' | gzip -1`;
  return `${runtime} save '${shellEscape(image)}' | gzip -1`;
}

/** Check if a remote host has a specific image. */
function imageIdCommand(image: string, runtime: ContainerRuntime): string {
  if (runtime === 'containerd') return `sudo k3s ctr -n k8s.io images ls -q 2>/dev/null | grep -F '${shellEscape(image)}' | head -1`;
  return `${runtime} images --no-trunc -q '${shellEscape(image)}' 2>/dev/null | head -1`;
}

export class DistributionService {
  static async getRemoteImageId(
    connection: SSHKeyConnection,
    image: string,
    runtime: ContainerRuntime = 'docker',
  ): Promise<string> {
    const result = await sshExec(connection, imageIdCommand(image, runtime));
    return result.stdout.trim();
  }

  static async getLocalImageId(image: string, engine: 'docker' | 'podman' = 'docker'): Promise<string> {
    const proc = Bun.spawn(
      [engine, 'images', '--no-trunc', '-q', image],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim().split('\n')[0] || '';
  }

  // ─── Pipe helpers ───────────────────────────────────────────

  /** Pipe a ReadableStream into an SSH channel with backpressure. */
  private static async pipeToChannel(
    source: ReadableStream<Uint8Array>,
    sink: ClientChannel,
  ): Promise<void> {
    const reader = source.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        try {
          if (!sink.write(value)) {
            await new Promise<void>((resolve) => {
              const onDrain = () => { sink.removeListener('close', onClose); resolve(); };
              const onClose = () => { sink.removeListener('drain', onDrain); resolve(); };
              sink.once('drain', onDrain);
              sink.once('close', onClose);
            });
          }
        } catch {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    try { sink.end(); } catch { }
  }

  /** Pipe an SSH channel into another SSH channel with backpressure. */
  private static pipeChannels(
    source: ClientChannel,
    sink: ClientChannel,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      sink.once('close', () => { try { source.destroy(); } catch { } });

      source.on('data', (chunk: Buffer) => {
        try {
          if (!sink.write(chunk)) {
            source.pause();
            sink.once('drain', () => source.resume());
          }
        } catch {
          try { source.destroy(); } catch { }
        }
      });

      source.on('end', () => {
        try { sink.end(); } catch { }
        resolve();
      });
      source.on('close', () => resolve());
      source.on('error', () => resolve());
    });
  }

  // ─── Streaming transfer ─────────────────────────────────────

  /** Stream an image from local Docker/Podman to a single remote target. */
  private static async streamToTarget(
    image: string,
    target: DistributionTarget,
    runtime: ContainerRuntime = 'docker',
  ): Promise<void> {
    const { stream: sink, done } = await sshExecChannel(
      target.connection,
      importCommand(runtime),
    );

    // Drain remote stdout to prevent SSH window deadlock
    sink.resume();

    const localEngine = runtime === 'containerd' ? 'docker' : runtime;
    const saveProc = Bun.spawn([localEngine, 'save', image], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Compress with built-in zlib instead of external gzip binary (cross-platform)
    const gzip = createGzip({ level: 1 });
    Readable.fromWeb(saveProc.stdout as unknown as import('node:stream/web').ReadableStream).pipe(gzip);

    const gzipStream = Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>;
    await DistributionService.pipeToChannel(gzipStream, sink);

    const [result] = await Promise.all([done, saveProc.exited]);

    if (saveProc.exitCode !== 0) {
      const stderr = await new Response(saveProc.stderr).text();
      throw new Error(`docker save failed for ${image}: ${stderr.trim()}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`docker load failed on ${target.name}: ${result.stderr.trim()}`);
    }
  }

  /**
   * Stream an image from a remote source (manager) to a single remote target.
   */
  private static async streamRemoteToTarget(
    image: string,
    source: SSHKeyConnection,
    target: DistributionTarget,
    runtime: ContainerRuntime = 'docker',
  ): Promise<void> {
    const { stream: sink, done: sinkDone } = await sshExecChannel(
      target.connection,
      importCommand(runtime),
    );
    // Drain remote stdout to prevent SSH window deadlock
    sink.resume();

    const { stream: src, done: srcDone } = await sshExecChannel(
      source,
      saveCommand(image, runtime),
    );

    await DistributionService.pipeChannels(src, sink);

    const [srcResult, sinkResult] = await Promise.all([srcDone, sinkDone]);

    if (srcResult.exitCode !== 0) {
      throw new Error(`docker save failed on remote: ${srcResult.stderr.trim()}`);
    }
    if (sinkResult.exitCode !== 0) {
      throw new Error(`docker load failed on ${target.name}: ${sinkResult.stderr.trim()}`);
    }
  }

  // ─── Dedup + retry ──────────────────────────────────────────

  /** Filter out targets that already have the image. */
  private static async filterTargetsNeedingImage(
    image: string,
    sourceId: string,
    targets: DistributionTarget[],
    runtime: ContainerRuntime = 'docker',
  ): Promise<DistributionTarget[]> {
    if (!sourceId) return targets;

    const checks = await Promise.all(
      targets.map(async (t) => {
        const targetId = await DistributionService.getRemoteImageId(t.connection, image, runtime);
        return { target: t, needsUpdate: targetId !== sourceId };
      }),
    );

    for (const { target, needsUpdate } of checks) {
      if (!needsUpdate) {
        printDim(`Already up to date on ${target.name}: ${image}`);
      }
    }

    return checks.filter((c) => c.needsUpdate).map((c) => c.target);
  }

  /** Transfer a single image to N targets in parallel with retry. */
  private static async transferImageToTargets(
    image: string,
    targets: DistributionTarget[],
    streamFn: (image: string, target: DistributionTarget) => Promise<void>,
    label: string,
  ): Promise<void> {
    let remaining = targets;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= TRANSFER_MAX_RETRIES + 1; attempt++) {
      const results = await Promise.allSettled(
        remaining.map((t) => streamFn(image, t)),
      );

      const failed: DistributionTarget[] = [];
      const errors: string[] = [];

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          failed.push(remaining[i]);
          errors.push((results[i] as PromiseRejectedResult).reason?.message ?? 'unknown');
        } else {
          printSuccess(`Transferred ${image} to ${remaining[i].name}${label}`);
        }
      }

      if (failed.length === 0) return;

      lastError = errors.join('; ');
      remaining = failed;

      if (attempt <= TRANSFER_MAX_RETRIES) {
        printWarning(
          `Transfer attempt ${attempt} failed for ${image} on ${remaining.map((t) => t.name).join(', ')}, retrying...`,
        );
      }
    }

    throw new DeployError(
      `Failed to transfer ${image} after ${TRANSFER_MAX_RETRIES + 1} attempts: ${lastError}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  // ─── Public API ─────────────────────────────────────────────

  static async distributeAll(
    images: string[],
    targets: DistributionTarget[],
    runtime: ContainerRuntime = 'docker',
  ): Promise<void> {
    if (images.length === 0 || targets.length === 0) return;

    const spinner = createTimedSpinner();
    spinner.start(`Distributing ${images.length} image(s) to ${targets.length} node(s)...`);

    try {
      // Images sequential (avoid N×M SSH channels), targets parallel per image
      for (const image of images) {
        spinner.update(`Distributing ${image}...`);
        const sourceId = await DistributionService.getLocalImageId(image);
        const needsUpdate = await DistributionService.filterTargetsNeedingImage(image, sourceId, targets, runtime);
        if (needsUpdate.length === 0) continue;

        await DistributionService.transferImageToTargets(
          image,
          needsUpdate,
          (img, t) => DistributionService.streamToTarget(img, t, runtime),
          '',
        );
      }

      spinner.succeed(`Distributed ${images.length} image(s) to ${targets.length} node(s)`);
    } catch (error) {
      spinner.fail('Image distribution failed');
      throw error;
    }
  }

  static async distributeFromRemote(
    images: string[],
    source: SSHKeyConnection,
    targets: DistributionTarget[],
    runtime: ContainerRuntime = 'docker',
  ): Promise<void> {
    if (images.length === 0 || targets.length === 0) return;

    const spinner = createTimedSpinner();
    spinner.start(`Distributing ${images.length} image(s) to ${targets.length} node(s) (from remote)...`);

    try {
      // Images sequential (avoid N×M SSH channels), targets parallel per image
      for (const image of images) {
        spinner.update(`Distributing ${image} (from remote)...`);
        const sourceId = await DistributionService.getRemoteImageId(source, image, runtime);
        const needsUpdate = await DistributionService.filterTargetsNeedingImage(image, sourceId, targets, runtime);
        if (needsUpdate.length === 0) continue;

        await DistributionService.transferImageToTargets(
          image,
          needsUpdate,
          (img, t) => DistributionService.streamRemoteToTarget(img, source, t, runtime),
          ' (from remote)',
        );
      }

      spinner.succeed(`Distributed ${images.length} image(s) to ${targets.length} node(s) (from remote)`);
    } catch (error) {
      spinner.fail('Image distribution failed');
      throw error;
    }
  }

  // ─── Single-target convenience ─────────────────────────────

  static async transferImage(
    image: string,
    target: DistributionTarget,
    runtime: ContainerRuntime = 'docker',
  ): Promise<void> {
    const sourceId = await DistributionService.getLocalImageId(image);
    if (sourceId) {
      const targetId = await DistributionService.getRemoteImageId(target.connection, image, runtime);
      if (sourceId === targetId) {
        printDim(`Already up to date on ${target.name}: ${image}`);
        return;
      }
    }

    await DistributionService.transferImageToTargets(
      image,
      [target],
      (img, t) => DistributionService.streamToTarget(img, t, runtime),
      '',
    );
  }

  static async transferImageFromRemote(
    image: string,
    source: SSHKeyConnection,
    target: DistributionTarget,
    runtime: ContainerRuntime = 'docker',
  ): Promise<void> {
    const sourceId = await DistributionService.getRemoteImageId(source, image, runtime);
    if (sourceId) {
      const targetId = await DistributionService.getRemoteImageId(target.connection, image, runtime);
      if (sourceId === targetId) {
        printDim(`Already up to date on ${target.name}: ${image}`);
        return;
      }
    }

    await DistributionService.transferImageToTargets(
      image,
      [target],
      (img, t) => DistributionService.streamRemoteToTarget(img, source, t, runtime),
      ' (from remote)',
    );
  }

  // ─── Registry ───────────────────────────────────────────────

  static async registryLogin(
    connection: SSHKeyConnection,
    config: { url: string; username?: string; password: string },
    engine: 'docker' | 'podman' = 'docker',
  ): Promise<void> {
    printDebug('Logging in to container registry...');

    const ePassword = shellEscape(config.password);
    const eUrl = shellEscape(config.url);
    const userFlag = config.username ? `-u '${shellEscape(config.username)}'` : '';
    const result = await sshExec(
      connection,
      `echo '${ePassword}' | ${engine} login '${eUrl}' ${userFlag} --password-stdin 2>&1`,
    );

    if (result.exitCode !== 0) {
      throw new DeployError(
        `Registry login failed: ${result.stdout.trim()}`,
        ErrorCode.DEPLOY_FAILED,
        'Check registry URL and credentials.',
      );
    }

    printDebug('Registry login successful');
  }

  /** Push all built images to registry, with optional additional tags. */
  static async pushImages(
    images: string[],
    additionalTags?: { tags: string[]; env: string; version: string; branch: string },
    engine: 'docker' | 'podman' = 'docker',
  ): Promise<void> {
    for (const image of images) {
      printDim(`Pushing ${image}...`);

      const proc = Bun.spawn([engine, 'push', image], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new DeployError(
          `${engine} push failed for ${image}: ${stderr.trim()}`,
          ErrorCode.DEPLOY_FAILED,
        );
      }

      printSuccess(`Pushed ${image}`);

      if (additionalTags && additionalTags.tags.length > 0) {
        const sha = await DistributionService.getGitSha();
        const imageBase = parseImageRef(image).name;

        for (const tagTemplate of additionalTags.tags) {
          const tag = tagTemplate
            .replace(/\{version\}/g, additionalTags.version)
            .replace(/\{env\}/g, additionalTags.env)
            .replace(/\{branch\}/g, DistributionService.sanitizeBranch(additionalTags.branch))
            .replace(/\{sha\}/g, sha);

          const taggedImage = `${imageBase}:${tag}`;

          const tagProc = Bun.spawn([engine, 'tag', image, taggedImage], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          await tagProc.exited;

          if (tagProc.exitCode !== 0) {
            printWarning(`Failed to tag ${taggedImage}`);
            continue;
          }

          const pushProc = Bun.spawn([engine, 'push', taggedImage], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const pushStderr = await new Response(pushProc.stderr).text();
          await pushProc.exited;

          if (pushProc.exitCode !== 0) {
            printWarning(`Failed to push additional tag ${taggedImage}: ${pushStderr.trim()}`);
          } else {
            printDim(`Pushed additional tag: ${taggedImage}`);
          }
        }
      }
    }
  }

  private static async getGitSha(): Promise<string> {
    try {
      const proc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return stdout.trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private static sanitizeBranch(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  }
}
