/**
 * Distribution Service
 *
 * Replaces the Ansible roles `local-registry`, `docker-registry`,
 * and `_shared/registry-login`.
 *
 * Transfers Docker images to Swarm nodes via SSH pipe
 * (docker save | gzip | docker load), pushes to registries,
 * and handles registry authentication.
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecWithInput } from '../utils/ssh';
import { printDebug, printDim, printSuccess, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';

export interface DistributionTarget {
  connection: SSHKeyConnection;
  name: string;
}

const TRANSFER_MAX_RETRIES = 2;

export class DistributionService {
  /**
   * Get the image ID on a remote host. Empty string if not present.
   */
  static async getRemoteImageId(
    connection: SSHKeyConnection,
    image: string,
  ): Promise<string> {
    const result = await sshExec(
      connection,
      `docker images --no-trunc -q "${image}" 2>/dev/null | head -1`,
    );
    return result.stdout.trim();
  }

  /**
   * Get the local image ID. Empty string if not present.
   */
  static async getLocalImageId(image: string): Promise<string> {
    const proc = Bun.spawn(
      ['docker', 'images', '--no-trunc', '-q', image],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim().split('\n')[0] || '';
  }

  /**
   * Transfer a single image to a remote host via SSH pipe.
   *
   * docker save | gzip -1 | ssh ... "gunzip | docker load"
   *
   * Skips if remote already has the same image ID.
   * Retries up to TRANSFER_MAX_RETRIES times on failure.
   */
  static async transferImage(
    image: string,
    target: DistributionTarget,
  ): Promise<void> {
    // Check if already up to date
    const localId = await DistributionService.getLocalImageId(image);
    if (localId) {
      const remoteId = await DistributionService.getRemoteImageId(
        target.connection,
        image,
      );
      if (localId === remoteId) {
        printDim(`Already up to date on ${target.name}: ${image}`);
        return;
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= TRANSFER_MAX_RETRIES + 1; attempt++) {
      try {
        // Save image locally and compress
        const saveProc = Bun.spawn(['docker', 'save', image], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const gzipProc = Bun.spawn(['gzip', '-1'], {
          stdin: saveProc.stdout,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const gzipped = Buffer.from(await new Response(gzipProc.stdout).arrayBuffer());
        await gzipProc.exited;
        await saveProc.exited;

        if (saveProc.exitCode !== 0) {
          throw new Error(`docker save failed for ${image}`);
        }

        // Stream gzipped data directly through the SSH channel's stdin.
        // The ssh2 library handles packet splitting and flow control.
        // No base64 encoding, no temp files, no shell quoting issues.
        const result = await sshExecWithInput(
          target.connection,
          'gunzip | docker load',
          gzipped,
        );

        if (result.exitCode !== 0) {
          throw new Error(`docker load failed on ${target.name}: ${result.stderr.trim() || result.stdout.trim()}`);
        }

        printSuccess(`Transferred ${image} to ${target.name}`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt <= TRANSFER_MAX_RETRIES) {
          printWarning(`Transfer attempt ${attempt} failed for ${image} → ${target.name}, retrying...`);
        }
      }
    }

    throw new DeployError(
      `Failed to transfer ${image} to ${target.name} after ${TRANSFER_MAX_RETRIES + 1} attempts: ${lastError?.message}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  /**
   * Transfer all images to all targets in parallel.
   */
  static async distributeAll(
    images: string[],
    targets: DistributionTarget[],
  ): Promise<void> {
    if (images.length === 0 || targets.length === 0) return;

    printDim(`Distributing ${images.length} image(s) to ${targets.length} node(s)...`);

    // Transfer images to each target sequentially per target, targets in parallel
    const targetTasks = targets.map(async (target) => {
      for (const image of images) {
        await DistributionService.transferImage(image, target);
      }
    });

    const results = await Promise.allSettled(targetTasks);
    const failed = results.filter((r) => r.status === 'rejected');

    if (failed.length > 0) {
      const errors = failed
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? 'unknown')
        .join('; ');
      throw new DeployError(
        `Image distribution failed: ${errors}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
  }

  /**
   * Login to a Docker registry on a remote host.
   * Does not print the command to avoid leaking credentials.
   */
  static async registryLogin(
    connection: SSHKeyConnection,
    config: { url: string; username?: string; password: string },
  ): Promise<void> {
    printDebug('Logging in to Docker registry...');

    const userFlag = config.username ? `-u "${config.username}"` : '';
    const result = await sshExec(
      connection,
      `echo "${config.password}" | docker login "${config.url}" ${userFlag} --password-stdin 2>&1`,
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

  /**
   * Push all built images to registry (runs locally).
   * Optionally tags and pushes additional tags with variable substitution.
   */
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

      // Push additional tags if configured
      if (additionalTags && additionalTags.tags.length > 0) {
        const sha = await DistributionService.getGitSha();
        const imageBase = image.split(':')[0];

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

  /**
   * Get the current git SHA (short form).
   */
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

  /**
   * Sanitize a git branch name for use in Docker tags.
   */
  private static sanitizeBranch(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  }
}
