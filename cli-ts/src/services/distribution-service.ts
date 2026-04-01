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
import { sshExec } from '../utils/ssh';
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
        // Build the SSH connection args for the pipe command
        const conn = target.connection;
        const sshArgs = [
          'ssh',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-p', String(conn.port),
          '-i', '/dev/stdin',
        ];

        // Use a shell pipeline: docker save | gzip -1 | ssh ... "gunzip | docker load"
        // Since we can't easily pipe the SSH key, use a single sshExec approach instead:
        // Save locally, pipe through SSH exec stream
        const saveProc = Bun.spawn(['docker', 'save', image], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const gzipProc = Bun.spawn(['gzip', '-1'], {
          stdin: saveProc.stdout,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        // Read gzipped data into buffer, then send via sshExec
        const gzipped = await new Response(gzipProc.stdout).arrayBuffer();
        await gzipProc.exited;
        await saveProc.exited;

        if (saveProc.exitCode !== 0) {
          throw new Error(`docker save failed for ${image}`);
        }

        // We need to transfer the gzipped data to the remote and load it.
        // Use base64 encoding through SSH to avoid binary issues.
        const b64 = Buffer.from(gzipped).toString('base64');

        // Split into chunks for very large images to avoid argument length limits
        const chunkSize = 500000; // ~500KB per chunk
        const chunks = [];
        for (let i = 0; i < b64.length; i += chunkSize) {
          chunks.push(b64.substring(i, i + chunkSize));
        }

        if (chunks.length === 1) {
          const result = await sshExec(
            target.connection,
            `echo "${b64}" | base64 -d | gunzip | docker load`,
          );
          if (result.exitCode !== 0) {
            throw new Error(`docker load failed on ${target.name}: ${result.stderr.trim()}`);
          }
        } else {
          // For large images, write chunks to a temp file on remote
          const tmpFile = `/tmp/dockflow-img-${Date.now()}.gz`;
          try {
            // Initialize empty file
            await sshExec(target.connection, `> "${tmpFile}"`);

            for (const chunk of chunks) {
              await sshExec(
                target.connection,
                `echo "${chunk}" | base64 -d >> "${tmpFile}"`,
              );
            }

            const result = await sshExec(
              target.connection,
              `gunzip < "${tmpFile}" | docker load`,
            );
            if (result.exitCode !== 0) {
              throw new Error(`docker load failed on ${target.name}: ${result.stderr.trim()}`);
            }
          } finally {
            await sshExec(target.connection, `rm -f "${tmpFile}"`).catch(() => {});
          }
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

    // Transfer all images to all targets in parallel
    const tasks: Promise<void>[] = [];
    for (const image of images) {
      for (const target of targets) {
        tasks.push(DistributionService.transferImage(image, target));
      }
    }

    const results = await Promise.allSettled(tasks);
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
   */
  static async pushImages(images: string[]): Promise<void> {
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
    }
  }
}
