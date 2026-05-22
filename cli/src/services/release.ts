/**
 * Release — manages versioned release directories on the remote manager.
 *
 * Handles rollback to previous releases and cleans up old releases
 * along with their orphaned Docker images.
 *
 * Remote directory structure:
 *   /var/lib/dockflow/stacks/{stackName}/
 *     current -> v1.2.4/          (symlink)
 *     v1.2.3/
 *       docker-compose.yml
 *       metadata.json
 *     v1.2.4/
 *       docker-compose.yml
 *       metadata.json
 */

import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from '../utils/ssh';
import { printDebug, printInfo, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { DOCKFLOW_STACKS_DIR } from '../constants';
import type { StackBackend } from './orchestrator/interfaces';
import type { DockflowConfig } from '../utils/config';

const DEFAULT_KEEP_RELEASES = 3;

export interface ReleaseMetadata {
  project_name: string;
  version: string;
  env: string;
  timestamp: string;
  epoch: number;
  performer: string;
  branch: string;
}

export class Release {
  constructor(private readonly connection: SSHKeyConnection) {}

  private stackDir(stackName: string): string {
    return `${DOCKFLOW_STACKS_DIR}/${stackName}`;
  }

  private releaseDir(stackName: string, version: string): string {
    return `${this.stackDir(stackName)}/${version}`;
  }

  /**
   * Create a new release directory and upload compose + metadata.
   * Updates the `current` symlink to point at the new release.
   */
  async createRelease(
    stackName: string,
    version: string,
    composeYaml: string,
    metadata: ReleaseMetadata,
  ): Promise<{ previousSymlink: string | null }> {
    const dir = this.releaseDir(stackName, version);
    const metaJson = JSON.stringify(metadata, null, 2);
    const stackDir = this.stackDir(stackName);

    // Read previous symlink target before overwriting — used to restore on failure
    const prevResult = await sshExec(this.connection, `readlink "${stackDir}/current" 2>/dev/null || echo ""`);
    const previousSymlink = prevResult.stdout.trim() || null;

    const mkdirResult = await sshExec(this.connection, `mkdir -p "${dir}"`);
    if (mkdirResult.exitCode !== 0) {
      throw new DeployError(
        `Failed to create release directory ${dir}: ${mkdirResult.stderr.trim() || `exit ${mkdirResult.exitCode}`}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user has write access to ${stackDir}. Run once as root:\n  mkdir -p '${stackDir}' && chown ${this.connection.user}: '${stackDir}'`,
      );
    }

    // Write compose and metadata via stdin (no shell escaping needed)
    const [composeHandle, metaHandle] = await Promise.all([
      sshExecChannel(this.connection, `cat > "${dir}/docker-compose.yml"`),
      sshExecChannel(this.connection, `cat > "${dir}/metadata.json"`),
    ]);
    composeHandle.stream.end(composeYaml);
    metaHandle.stream.end(metaJson);
    const [composeResult, metaResult] = await Promise.all([composeHandle.done, metaHandle.done]);
    if (composeResult.exitCode !== 0) {
      throw new DeployError(
        `Failed to write release compose for ${version}: ${composeResult.stderr.trim() || `exit ${composeResult.exitCode}`}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
    if (metaResult.exitCode !== 0) {
      throw new DeployError(
        `Failed to write release metadata for ${version}: ${metaResult.stderr.trim() || `exit ${metaResult.exitCode}`}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    await sshExec(this.connection, `ln -sfn "${dir}" "${stackDir}/current"`);

    printDebug(`Release ${version} created at ${dir}`);
    return { previousSymlink };
  }

  /**
   * Read the compose file from the current release symlink.
   * Returns null if no release exists yet.
   */
  async getCurrentComposeContent(stackName: string): Promise<string | null> {
    const result = await sshExec(
      this.connection,
      `cat "${this.stackDir(stackName)}/current/docker-compose.yml" 2>/dev/null`,
    );
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout : null;
  }

  /**
   * List all releases sorted by epoch descending (newest first).
   * Uses a single SSH call to read all metadata files at once.
   */
  async listReleases(stackName: string): Promise<ReleaseMetadata[]> {
    const dir = this.stackDir(stackName);

    const result = await sshExec(
      this.connection,
      `cd "${dir}" 2>/dev/null && for d in */; do ` +
        `[ "$d" = "current/" ] && continue; ` +
        `[ -f "$d/metadata.json" ] && printf '\\x1e' && cat "$d/metadata.json"; ` +
      `done || echo ""`,
    );

    const raw = result.stdout.trim();
    if (!raw) return [];

    const releases: ReleaseMetadata[] = [];

    // Split on record separator (ASCII 0x1E)
    const chunks = raw.split('\x1e').filter(Boolean);
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        const meta = JSON.parse(trimmed) as ReleaseMetadata;
        releases.push(meta);
      } catch {
        printDebug(`Skipping release with bad metadata`);
      }
    }

    // Sort newest first
    releases.sort((a, b) => b.epoch - a.epoch);
    return releases;
  }

  /**
   * Rollback to the previous release. Returns the version rolled back to.
   * When `previousReleasePath` is supplied the target is used directly;
   * otherwise releases are listed and the most recent non-failed one is used.
   */
  async rollback(
    stackName: string,
    orchestrator: StackBackend,
    failedVersion?: string | null,
    previousReleasePath?: string | null,
  ): Promise<string> {
    let previousDir: string;
    let previousVersion: string;
    let failedDir: string | undefined;

    if (previousReleasePath) {
      // Fast path: we already know where the previous release lives.
      previousDir = previousReleasePath;
      previousVersion = previousReleasePath.split('/').pop() ?? previousReleasePath;
      failedDir = failedVersion ? this.releaseDir(stackName, failedVersion) : undefined;
    } else {
      // Fallback: discover via listReleases.
      const releases = await this.listReleases(stackName);
      const candidates = failedVersion
        ? releases.filter(r => r.version !== failedVersion)
        : releases.slice(1);

      if (candidates.length < 1) {
        throw new DeployError(
          'No previous release available for rollback',
          ErrorCode.ROLLBACK_FAILED,
        );
      }

      const previous = candidates[0];
      previousDir = this.releaseDir(stackName, previous.version);
      previousVersion = previous.version;
      failedDir = failedVersion ? this.releaseDir(stackName, failedVersion) : undefined;
    }

    printInfo(`Rolling back to ${previousVersion}...`);

    const composeResult = await sshExec(this.connection, `cat "${previousDir}/docker-compose.yml"`);
    if (composeResult.exitCode !== 0 || !composeResult.stdout.trim()) {
      throw new DeployError(
        `Could not read compose for rollback at ${previousDir}`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    const deployResult = await orchestrator.redeploy(stackName, composeResult.stdout);
    if (!deployResult.success) {
      throw new DeployError(deployResult.error.message, ErrorCode.ROLLBACK_FAILED);
    }

    const convergence = await orchestrator.waitConvergence(stackName, 300, 5);
    if (!convergence.converged) {
      throw new DeployError('Rollback did not converge', ErrorCode.ROLLBACK_FAILED);
    }

    await sshExec(this.connection, `ln -sfn "${previousDir}" "${this.stackDir(stackName)}/current"`);

    if (failedDir) {
      await sshExec(this.connection, `rm -rf "${failedDir}"`).catch(() => {
        printWarning(`Could not remove failed release directory ${failedDir}`);
      });
    }

    return previousVersion;
  }

  /**
   * Remove a single release directory.
   * If restoreTo is provided and the `current` symlink points to this version,
   * restores it to the given target (or removes the symlink if restoreTo is null).
   */
  async removeRelease(stackName: string, version: string, restoreTo?: string | null): Promise<void> {
    const dir = this.releaseDir(stackName, version);
    const stackDir = this.stackDir(stackName);

    if (restoreTo !== undefined) {
      await sshExec(
        this.connection,
        `currentTarget=$(readlink "${stackDir}/current" 2>/dev/null); ` +
        `rm -rf "${dir}"; ` +
        `if [ "$currentTarget" = "${dir}" ]; then ` +
        (restoreTo
          ? `ln -sfn "${restoreTo}" "${stackDir}/current"; `
          : `rm -f "${stackDir}/current"; `) +
        `fi`,
      );
    } else {
      await sshExec(this.connection, `rm -rf "${dir}"`);
    }

    printDebug(`Removed release ${version}`);
  }

  /**
   * Cleanup old releases keeping only the N most recent.
   * Also removes orphaned Docker images from deleted releases.
   *
   * Batches SSH calls: 1 for running images (all stacks), 1 for kept compose
   * files, 1 for to-remove compose files, 1 for image cleanup, 1 for dir cleanup.
   */
  async cleanupOldReleases(
    stackName: string,
    config: DockflowConfig,
  ): Promise<void> {
    const keepN = config.stack_management?.keep_releases ?? DEFAULT_KEEP_RELEASES;
    const releases = await this.listReleases(stackName);

    if (releases.length <= keepN) {
      printDebug(`${releases.length} release(s), keeping ${keepN} — nothing to clean`);
      return;
    }

    const toKeep = releases.slice(0, keepN);
    const toRemove = releases.slice(keepN);

    // 1-3. Collect running images, kept compose images, and to-remove compose images in parallel
    const protectedImages = new Set<string>();
    const keptDirs = toKeep.map(r => `"${this.releaseDir(stackName, r.version)}/docker-compose.yml"`).join(' ');
    const removeDirs = toRemove.map(r => `"${this.releaseDir(stackName, r.version)}/docker-compose.yml"`).join(' ');

    const [runningResult, keptResult, removeResult] = await Promise.all([
      sshExec(
        this.connection,
        `for stack in $(docker stack ls --format '{{.Name}}' 2>/dev/null); do ` +
          `docker stack services "$stack" --format '{{.Image}}' 2>/dev/null; ` +
        `done`,
      ),
      sshExec(this.connection, `cat ${keptDirs} 2>/dev/null || echo ""`),
      sshExec(this.connection, `cat ${removeDirs} 2>/dev/null || echo ""`),
    ]);

    for (const img of runningResult.stdout.trim().split('\n').filter(Boolean)) {
      protectedImages.add(img);
    }

    const keptMatches = keptResult.stdout.match(/image:\s*['"]?([^\s'"]+)/g);
    if (keptMatches) {
      for (const m of keptMatches) {
        protectedImages.add(m.replace(/image:\s*['"]?/, ''));
      }
    }

    const orphanImages: string[] = [];
    const removeMatches = removeResult.stdout.match(/image:\s*['"]?([^\s'"]+)/g);
    if (removeMatches) {
      for (const m of removeMatches) {
        const img = m.replace(/image:\s*['"]?/, '');
        if (!protectedImages.has(img) && !img.endsWith(':latest')) {
          orphanImages.push(img);
        }
      }
    }

    // 4. Batch cleanup orphaned images in ONE SSH call
    if (orphanImages.length > 0) {
      const uniqueOrphans = [...new Set(orphanImages)];
      const quotedImages = uniqueOrphans.map(img => `'${img}'`).join(' ');
      // Remove containers using these images, then the images themselves
      await sshExec(
        this.connection,
        `for img in ${quotedImages}; do ` +
          `ids=$(docker ps -a --filter "ancestor=$img" -q 2>/dev/null); ` +
          `[ -n "$ids" ] && docker rm -f $ids 2>/dev/null; ` +
          `docker rmi "$img" 2>/dev/null; ` +
        `done; true`,
      );
      printDebug(`Removed ${uniqueOrphans.length} orphaned image(s)`);
    }

    // 5. Batch remove release directories in ONE SSH call
    const rmDirs = toRemove.map(r => `"${this.releaseDir(stackName, r.version)}"`).join(' ');
    await sshExec(this.connection, `rm -rf ${rmDirs}`);

    printInfo(`Cleaned up ${toRemove.length} old release(s)`);
  }
}
