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
import type { SwarmDeployService } from './swarm-deploy-service';
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

    await sshExec(
      this.connection,
      `mkdir -p "${dir}"`,
    );

    // Write compose file
    await sshExec(
      this.connection,
      `cat > "${dir}/docker-compose.yml" << 'DOCKFLOW_EOF'\n${composeYaml}\nDOCKFLOW_EOF`,
    );

    // Write metadata
    await sshExec(
      this.connection,
      `echo '${escapedMeta}' > "${dir}/metadata.json"`,
    );

    // Update symlink
    await sshExec(
      this.connection,
      `ln -sfn "${dir}" "${this.stackDir(stackName)}/current"`,
    );

    printDebug(`Release ${version} created at ${dir}`);
  }

  /**
   * List all releases sorted by epoch descending (newest first).
   */
  async listReleases(stackName: string): Promise<ReleaseMetadata[]> {
    const dir = this.stackDir(stackName);

    // List directories, excluding 'current' symlink
    const lsResult = await sshExec(
      this.connection,
      `ls -1 "${dir}" 2>/dev/null | grep -v '^current$' || echo ""`,
    );

    const entries = lsResult.stdout.trim().split('\n').filter(Boolean);
    if (entries.length === 0) return [];

    const releases: ReleaseMetadata[] = [];

    for (const entry of entries) {
      const metaResult = await sshExec(
        this.connection,
        `cat "${dir}/${entry}/metadata.json" 2>/dev/null || echo ""`,
      );

      const raw = metaResult.stdout.trim();
      if (!raw) continue;

      try {
        const meta = JSON.parse(raw) as ReleaseMetadata;
        releases.push(meta);
      } catch {
        // Skip releases with corrupted metadata
        printDebug(`Skipping release with bad metadata: ${entry}`);
      }
    }

    // Sort newest first
    releases.sort((a, b) => b.epoch - a.epoch);
    return releases;
  }

  /**
   * Rollback to the previous release.
   *
   * Reads the previous release's compose, deploys it via SwarmDeployService,
   * waits for convergence, then updates the `current` symlink.
   * Always throws — a rollback is itself a deploy failure.
   */
  async rollback(
    stackName: string,
    swarmDeployService: SwarmDeployService,
  ): Promise<never> {
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

    // Deploy old compose
    await swarmDeployService.deployStack(stackName, composeResult.stdout);
    await swarmDeployService.waitConvergence(stackName, { context: 'rollback' });

    // Update symlink
    await sshExec(
      this.connection,
      `ln -sfn "${previousDir}" "${this.stackDir(stackName)}/current"`,
    );

    // Clean up the failed release directory
    await this.removeRelease(stackName, failed.version).catch(() => {
      printWarning(`Could not remove failed release ${failed.version}`);
    });

    throw new DeployError(
      `Rolled back to ${previous.version}`,
      ErrorCode.ROLLBACK_FAILED,
    );
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

    // Collect protected images (currently running + in kept releases + other stacks)
    const protectedImages = new Set<string>();

    // Running images from THIS stack
    const runningResult = await sshExec(
      this.connection,
      `docker stack services ${stackName} --format '{{.Image}}' 2>/dev/null || echo ""`,
    );
    for (const img of runningResult.stdout.trim().split('\n').filter(Boolean)) {
      protectedImages.add(img);
    }

    // Running images from ALL other stacks (cross-project protection)
    const allStacksResult = await sshExec(
      this.connection,
      `docker stack ls --format '{{.Name}}' 2>/dev/null || echo ""`,
    );
    for (const otherStack of allStacksResult.stdout.trim().split('\n').filter(Boolean)) {
      if (otherStack === stackName) continue;
      const otherImagesResult = await sshExec(
        this.connection,
        `docker stack services ${otherStack} --format '{{.Image}}' 2>/dev/null || echo ""`,
      );
      for (const img of otherImagesResult.stdout.trim().split('\n').filter(Boolean)) {
        protectedImages.add(img);
      }
    }

    // Images from kept releases
    for (const release of toKeep) {
      const composeResult = await sshExec(
        this.connection,
        `cat "${this.releaseDir(stackName, release.version)}/docker-compose.yml" 2>/dev/null || echo ""`,
      );
      const raw = composeResult.stdout.trim();
      if (!raw) continue;
      // Extract image: lines from YAML (simple regex — avoids parsing on remote)
      const imageMatches = raw.match(/image:\s*['"]?([^\s'"]+)/g);
      if (imageMatches) {
        for (const m of imageMatches) {
          const img = m.replace(/image:\s*['"]?/, '');
          protectedImages.add(img);
        }
      }
    }

    // Remove old releases and their orphaned images
    for (const release of toRemove) {
      const dir = this.releaseDir(stackName, release.version);

      // Read images from the release's compose
      const composeResult = await sshExec(
        this.connection,
        `cat "${dir}/docker-compose.yml" 2>/dev/null || echo ""`,
      );
      const raw = composeResult.stdout.trim();

      if (raw) {
        const imageMatches = raw.match(/image:\s*['"]?([^\s'"]+)/g);
        if (imageMatches) {
          for (const m of imageMatches) {
            const img = m.replace(/image:\s*['"]?/, '');

            // Skip protected and :latest images
            if (protectedImages.has(img) || img.endsWith(':latest')) continue;

            // Remove containers using this image, then the image itself
            try {
              const containerResult = await sshExec(
                this.connection,
                `docker ps -a --filter ancestor=${img} -q 2>/dev/null || echo ""`,
              );
              const containerIds = containerResult.stdout.trim();
              if (containerIds) {
                await sshExec(
                  this.connection,
                  `docker rm -f ${containerIds} 2>/dev/null || true`,
                );
              }
              await sshExec(
                this.connection,
                `docker rmi ${img} 2>/dev/null || true`,
              );
              printDebug(`Removed image: ${img}`);
            } catch {
              // Best-effort cleanup
            }
          }
        }
      }

      // Remove the release directory
      await sshExec(this.connection, `rm -rf "${dir}"`);
      printDebug(`Cleaned up release: ${release.version}`);
    }

    printInfo(`Cleaned up ${toRemove.length} old release(s)`);
  }
}
