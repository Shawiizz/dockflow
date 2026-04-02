/**
 * Distribution Service
 *
 * Streams Docker images to Swarm nodes via SSH pipe
 * (docker save | gzip → gunzip | docker load), without buffering in memory.
 * Also handles registry push and authentication.
 */

import type { ClientChannel } from 'ssh2';
import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel, shellEscape } from '../utils/ssh';
import { printDebug, printDim, printSuccess, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { parseImageRef } from './compose-service';

export interface DistributionTarget {
  connection: SSHKeyConnection;
  name: string;
}

const TRANSFER_MAX_RETRIES = 2;

export class DistributionService {
  static async getRemoteImageId(
    connection: SSHKeyConnection,
    image: string,
  ): Promise<string> {
    const result = await sshExec(
      connection,
      `docker images --no-trunc -q '${shellEscape(image)}' 2>/dev/null | head -1`,
    );
    return result.stdout.trim();
  }

  static async getLocalImageId(image: string): Promise<string> {
    const proc = Bun.spawn(
      ['docker', 'images', '--no-trunc', '-q', image],
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

  /** Stream an image from local Docker to a single remote target. */
  private static async streamToTarget(
    image: string,
    target: DistributionTarget,
  ): Promise<void> {
    const { stream: sink, done } = await sshExecChannel(
      target.connection,
      'gunzip | docker load',
    );

    // Drain remote stdout to prevent SSH window deadlock
    sink.resume();

    const saveProc = Bun.spawn(['docker', 'save', image], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const gzipProc = Bun.spawn(['gzip', '-1'], {
      stdin: saveProc.stdout,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const saveStderrP = new Response(saveProc.stderr).text();

    await DistributionService.pipeToChannel(gzipProc.stdout, sink);

    const [result] = await Promise.all([done, gzipProc.exited, saveProc.exited]);

    if (saveProc.exitCode !== 0) {
      const stderr = await saveStderrP;
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
  ): Promise<void> {
    const { stream: sink, done: sinkDone } = await sshExecChannel(
      target.connection,
      'gunzip | docker load',
    );
    // Drain remote stdout to prevent SSH window deadlock
    sink.resume();

    const { stream: src, done: srcDone } = await sshExecChannel(
      source,
      `docker save '${shellEscape(image)}' | gzip -1`,
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
  ): Promise<DistributionTarget[]> {
    if (!sourceId) return targets;

    const checks = await Promise.all(
      targets.map(async (t) => {
        const targetId = await DistributionService.getRemoteImageId(t.connection, image);
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
  ): Promise<void> {
    if (images.length === 0 || targets.length === 0) return;

    printDim(`Distributing ${images.length} image(s) to ${targets.length} node(s)...`);

    for (const image of images) {
      const sourceId = await DistributionService.getLocalImageId(image);
      const needsUpdate = await DistributionService.filterTargetsNeedingImage(image, sourceId, targets);
      if (needsUpdate.length === 0) continue;

      await DistributionService.transferImageToTargets(
        image,
        needsUpdate,
        DistributionService.streamToTarget,
        '',
      );
    }
  }

  static async distributeFromRemote(
    images: string[],
    source: SSHKeyConnection,
    targets: DistributionTarget[],
  ): Promise<void> {
    if (images.length === 0 || targets.length === 0) return;

    printDim(`Distributing ${images.length} image(s) to ${targets.length} node(s) (from remote)...`);

    for (const image of images) {
      const sourceId = await DistributionService.getRemoteImageId(source, image);
      const needsUpdate = await DistributionService.filterTargetsNeedingImage(image, sourceId, targets);
      if (needsUpdate.length === 0) continue;

      await DistributionService.transferImageToTargets(
        image,
        needsUpdate,
        (img, target) => DistributionService.streamRemoteToTarget(img, source, target),
        ' (from remote)',
      );
    }
  }

  // ─── Single-target convenience ─────────────────────────────

  static async transferImage(
    image: string,
    target: DistributionTarget,
  ): Promise<void> {
    const sourceId = await DistributionService.getLocalImageId(image);
    if (sourceId) {
      const targetId = await DistributionService.getRemoteImageId(target.connection, image);
      if (sourceId === targetId) {
        printDim(`Already up to date on ${target.name}: ${image}`);
        return;
      }
    }

    await DistributionService.transferImageToTargets(
      image,
      [target],
      DistributionService.streamToTarget,
      '',
    );
  }

  static async transferImageFromRemote(
    image: string,
    source: SSHKeyConnection,
    target: DistributionTarget,
  ): Promise<void> {
    const sourceId = await DistributionService.getRemoteImageId(source, image);
    if (sourceId) {
      const targetId = await DistributionService.getRemoteImageId(target.connection, image);
      if (sourceId === targetId) {
        printDim(`Already up to date on ${target.name}: ${image}`);
        return;
      }
    }

    await DistributionService.transferImageToTargets(
      image,
      [target],
      (img, t) => DistributionService.streamRemoteToTarget(img, source, t),
      ' (from remote)',
    );
  }

  // ─── Registry ───────────────────────────────────────────────

  static async registryLogin(
    connection: SSHKeyConnection,
    config: { url: string; username?: string; password: string },
  ): Promise<void> {
    printDebug('Logging in to Docker registry...');

    const ePassword = shellEscape(config.password);
    const eUrl = shellEscape(config.url);
    const userFlag = config.username ? `-u '${shellEscape(config.username)}'` : '';
    const result = await sshExec(
      connection,
      `echo '${ePassword}' | docker login '${eUrl}' ${userFlag} --password-stdin 2>&1`,
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
  ): Promise<void> {
    for (const image of images) {
      printDim(`Pushing ${image}...`);

      const proc = Bun.spawn(['docker', 'push', image], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        throw new DeployError(
          `docker push failed for ${image}: ${stderr.trim()}`,
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

          const tagProc = Bun.spawn(['docker', 'tag', image, taggedImage], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          await tagProc.exited;

          if (tagProc.exitCode !== 0) {
            printWarning(`Failed to tag ${taggedImage}`);
            continue;
          }

          const pushProc = Bun.spawn(['docker', 'push', taggedImage], {
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
