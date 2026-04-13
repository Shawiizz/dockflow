/**
 * Release Service
 *
 * Replaces the Ansible roles `rollback` and `stack-management`.
 * Manages versioned release directories on the remote manager,
 * handles rollback to previous releases, and cleans up old releases
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
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDebug, printInfo, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { DOCKFLOW_STACKS_DIR } from '../constants';
import type { OrchestratorService } from './orchestrator/interface';
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

export class ReleaseService {
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
  ): Promise<void> {
    const dir = this.releaseDir(stackName, version);
    const escapedCompose = shellEscape(composeYaml);
    const escapedMeta = shellEscape(JSON.stringify(metadata, null, 2));
    const stackDir = this.stackDir(stackName);

    await sshExec(
      this.connection,
      `mkdir -p "${dir}" && ` +
      `printf '%s' '${escapedCompose}' > "${dir}/docker-compose.yml" && ` +
      `printf '%s' '${escapedMeta}' > "${dir}/metadata.json" && ` +
      `ln -sfn "${dir}" "${stackDir}/current"`,
    );

    printDebug(`Release ${version} created at ${dir}`);
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
   * Rollback to the previous release.
   *
   * Reads the previous release's compose, deploys it via OrchestratorService,
   * waits for convergence, then updates the `current` symlink.
   * Returns the version that was rolled back to.
   */
  async rollback(
    stackName: string,
    orchestrator: OrchestratorService,
  ): Promise<string> {
    const releases = await this.listReleases(stackName);

    if (releases.length < 2) {
      throw new DeployError(
        'No previous release available for rollback',
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    const failed = releases[0];
    const previous = releases[1];
    const previousDir = this.releaseDir(stackName, previous.version);

    printInfo(`Rolling back to ${previous.version}...`);

    // Read previous compose
    const composeResult = await sshExec(
      this.connection,
      `cat "${previousDir}/docker-compose.yml"`,
    );

    if (composeResult.exitCode !== 0 || !composeResult.stdout.trim()) {
      throw new DeployError(
        `Could not read compose for rollback version ${previous.version}`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    // Deploy old compose via orchestrator
    const deployResult = await orchestrator.deployStack(stackName, composeResult.stdout, previousDir);
    if (!deployResult.success) {
      throw new DeployError(
        deployResult.error.message,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    const convergence = await orchestrator.waitConvergence(stackName, 300, 5);
    if (!convergence.converged) {
      throw new DeployError(
        'Rollback did not converge',
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    // Update symlink
    await sshExec(
      this.connection,
      `ln -sfn "${previousDir}" "${this.stackDir(stackName)}/current"`,
    );

    // Clean up the failed release directory
    await this.removeRelease(stackName, failed.version).catch(() => {
      printWarning(`Could not remove failed release ${failed.version}`);
    });

    return previous.version;
  }

  /**
   * Remove a single release directory.
   */
  async removeRelease(stackName: string, version: string): Promise<void> {
    const dir = this.releaseDir(stackName, version);
    await sshExec(this.connection, `rm -rf "${dir}"`);
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
      const quotedImages = uniqueOrphans.map(img => `'${shellEscape(img)}'`).join(' ');
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
