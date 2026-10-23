/**
 * Release — the versioned release directories on the remote manager: creation, rollback, and
 * cleanup of old releases with their orphaned Docker images.
 *
 * Remote directory structure:
 *   /var/lib/dockflow/stacks/{stackName}/
 *     current -> v1.2.4/          (symlink)
 *     v1.2.3/
 *       docker-compose.yml
 *       stack.yml
 *       metadata.json
 *     v1.2.4/
 *       ...
 *
 * Release files hold the rendered stack and its secrets: they are written under umask 077.
 */

import { randomBytes } from 'crypto';
import type { SSHKeyConnection } from '../../types';
import { shellQuote } from '../../utils/ssh';
import { sshShell, type RemoteShell } from '../../utils/remote-shell';
import { printDebug, printInfo, printWarning } from '../../utils/output';
import { DeployError, ErrorCode } from '../../utils/errors';
import { DOCKFLOW_STACKS_DIR, RELEASE_STACK_FILE } from '../../constants';
import type { SwarmStack } from '../swarm/stack';
import type { DockflowConfig } from '../../utils/config';
import {
  BACKUP_PREFIX,
  COMPOSE_FILE,
  CURRENT_LINK,
  METADATA_FILE,
  RELEASE_FILES,
  TEMP_PREFIX,
  type ReleaseMetadata,
} from './layout';
import { assertReleaseName, parseMetadata, parseReleaseList, selectRetention, selectRollbackTarget } from './selection';
import { computeOrphanImages, extractComposeImages, missingImagesCommand, removeImagesCommand, sweepStaleTags } from './images';

export type { ReleaseMetadata } from './layout';
export { assertReleaseName, parseReleaseList, releaseEpoch, selectRetention, selectRollbackTarget } from './selection';
export {
  builtRepositories,
  computeOrphanImages,
  computeStaleTags,
  extractComposeImages,
  missingImagesCommand,
  removeImagesCommand,
} from './images';

const DEFAULT_KEEP_RELEASES = 3;

function failure(result: { stderr: string; exitCode: number }): string {
  return result.stderr.trim() || `exit ${result.exitCode}`;
}

/** A node that may run the services, where the images of a release have to be. */
export interface ImageNode {
  name: string;
  shell: RemoteShell;
}

export interface RollbackOptions {
  /** the nodes the images were distributed to (no registry): the rollback is refused when one lacks an image */
  imageNodes?: ImageNode[];
}

export interface ReleaseOptions {
  /** replaces DOCKFLOW_STACKS_DIR */
  stacksDir?: string;
}

export class Release {
  private readonly shell: RemoteShell;
  private readonly owner: string;
  private readonly stacksDir: string;
  /** `<stack>/<version>` whose previous files this process kept aside during a same-version create */
  private readonly replaced = new Set<string>();

  constructor(target: SSHKeyConnection | RemoteShell, options: ReleaseOptions = {}) {
    const isShell = 'run' in target;
    this.shell = isShell ? target : sshShell(target);
    this.owner = isShell ? '<deploy user>' : target.user;
    this.stacksDir = (options.stacksDir ?? DOCKFLOW_STACKS_DIR).replace(/\/+$/, '');
  }

  private stackDir(stackName: string): string {
    assertReleaseName(stackName, 'stack');
    return `${this.stacksDir}/${stackName}`;
  }

  private releaseDir(stackName: string, version: string): string {
    assertReleaseName(version, 'version');
    return `${this.stackDir(stackName)}/${version}`;
  }

  private backupDir(stackName: string, version: string): string {
    assertReleaseName(version, 'version');
    return `${this.stackDir(stackName)}/${BACKUP_PREFIX}${version}`;
  }

  /**
   * Write a release and point `current` at it. A new version appears through one directory rename;
   * an existing one is replaced file by file after a copy of its files is kept aside, so a failed
   * redeploy can put them back (`removeRelease`, `rollback`).
   *
   * The compose keeps the project's images for partial deploys and image cleanup;
   * the rendered stack is what rollback re-applies.
   */
  async createRelease(
    stackName: string,
    version: string,
    composeYaml: string,
    renderedStack: string,
    metadata: ReleaseMetadata,
  ): Promise<{ previousSymlink: string | null }> {
    const stackDir = this.stackDir(stackName);
    const dir = this.releaseDir(stackName, version);
    const backup = this.backupDir(stackName, version);
    const tmp = `${stackDir}/${TEMP_PREFIX}${version}-${randomBytes(4).toString('hex')}`;
    const q = shellQuote;

    // leftovers of an interrupted create are dropped; the deploy lock rules out a concurrent one
    const prepared = await this.shell.run(
      [
        'umask 077',
        `mkdir -p ${q(stackDir)} || exit 1`,
        `rm -rf ${q(stackDir)}/${TEMP_PREFIX}* ${q(stackDir)}/${BACKUP_PREFIX}*`,
        `mkdir ${q(tmp)} || exit 1`,
        `readlink ${q(`${stackDir}/${CURRENT_LINK}`)} 2>/dev/null || true`,
      ].join('\n'),
    );
    if (prepared.exitCode !== 0) {
      throw new DeployError(
        `Failed to create release directory ${dir}: ${failure(prepared)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user has write access to ${stackDir}. Run once as root:\n  mkdir -p ${q(stackDir)} && chown ${this.owner}: ${q(stackDir)}`,
      );
    }
    for (const key of this.replaced) {
      if (key.startsWith(`${stackName}/`)) this.replaced.delete(key);
    }
    const previousSymlink = prepared.stdout.trim() || null;

    const files = [
      { name: COMPOSE_FILE, label: 'compose', content: composeYaml },
      { name: RELEASE_STACK_FILE, label: 'stack', content: renderedStack },
      { name: METADATA_FILE, label: 'metadata', content: JSON.stringify(metadata, null, 2) },
    ];
    const written = await Promise.all(
      files.map((file) => this.shell.run(`umask 077 && cat > ${q(`${tmp}/${file.name}`)}`, file.content)),
    );
    const failed = written.findIndex((result) => result.exitCode !== 0);
    if (failed >= 0) {
      await this.discard(tmp);
      throw new DeployError(
        `Failed to write release ${files[failed].label} for ${version}: ${failure(written[failed])}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    const names = RELEASE_FILES.map(q).join(' ');
    const committed = await this.shell.run(
      [
        'umask 077',
        `if [ -d ${q(dir)} ]; then`,
        `  rm -rf ${q(backup)} && cp -Rp ${q(dir)} ${q(backup)} || exit 1`,
        '  echo replacing',
        `  for f in ${names}; do`,
        `    if [ -f ${q(tmp)}/"$f" ]; then mv -f ${q(tmp)}/"$f" ${q(dir)}/"$f" || exit 1; else rm -f ${q(dir)}/"$f"; fi`,
        '  done',
        `  rm -rf ${q(tmp)}`,
        'else',
        `  mv ${q(tmp)} ${q(dir)} || exit 1`,
        'fi',
        // the `current` symlink is what rollback and partial deploys resolve
        `ln -sfn ${q(dir)} ${q(`${stackDir}/${CURRENT_LINK}`)} || exit 2`,
      ].join('\n'),
    );
    const replacing = committed.stdout.includes('replacing');
    if (replacing) this.replaced.add(`${stackName}/${version}`);
    if (committed.exitCode === 2) {
      throw new DeployError(
        `Failed to update the current release symlink: ${failure(committed)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${stackDir}.`,
      );
    }
    if (committed.exitCode !== 0) {
      await this.discard(tmp);
      if (replacing) {
        await this.restoreReplaced(stackName, version).catch((error: unknown) =>
          printDebug(`Release ${version} restore failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      throw new DeployError(
        `Failed to move release ${version} into place: ${failure(committed)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${stackDir}.`,
      );
    }

    printDebug(`Release ${version} created at ${dir}`);
    return { previousSymlink };
  }

  /** The compose file of the release `current` points at, null when there is none yet. */
  async getCurrentComposeContent(stackName: string): Promise<string | null> {
    const result = await this.shell.run(`cat ${shellQuote(`${this.stackDir(stackName)}/${CURRENT_LINK}/${COMPOSE_FILE}`)} 2>/dev/null`);
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout : null;
  }

  /** The version `current` points at, null without one. */
  async currentVersion(stackName: string): Promise<string | null> {
    const result = await this.shell.run(`readlink ${shellQuote(`${this.stackDir(stackName)}/${CURRENT_LINK}`)} 2>/dev/null`);
    const target = result.stdout.trim().replace(/\/+$/, '');
    if (result.exitCode !== 0 || !target) return null;
    return target.slice(target.lastIndexOf('/') + 1) || null;
  }

  /** List all releases, newest first. */
  async listReleases(stackName: string): Promise<ReleaseMetadata[]> {
    const dir = this.stackDir(stackName);
    const result = await this.shell.run(
      `cd ${shellQuote(dir)} 2>/dev/null && for d in */; do ` +
        '[ -L "${d%/}" ] && continue; ' +
        `[ -f "\${d}${METADATA_FILE}" ] && printf '%s\\t' "\${d%/}" && tr -d '\\n' < "\${d}${METADATA_FILE}" && echo; ` +
        'done || true',
    );
    return parseReleaseList(result.stdout, (directory) =>
      printWarning(`Skipping release directory ${directory} with corrupted metadata in ${dir}`),
    );
  }

  /** The newest release, the base of the next auto-incremented version. */
  async latestVersion(stackName: string): Promise<string | null> {
    return (await this.listReleases(stackName))[0]?.version ?? null;
  }

  /**
   * Rolls back and returns the version rolled back to: `previousReleasePath` when given, else the
   * newest release older than current, or other than the failed one.
   */
  async rollback(
    stackName: string,
    swarm: SwarmStack,
    failedVersion?: string | null,
    previousReleasePath?: string | null,
    options: RollbackOptions = {},
  ): Promise<string> {
    let previousVersion: string;
    if (previousReleasePath) {
      previousVersion = previousReleasePath.replace(/\/+$/, '').split('/').pop() ?? previousReleasePath;
    } else {
      const [releases, current] = await Promise.all([this.listReleases(stackName), this.currentVersion(stackName)]);
      const previous = selectRollbackTarget(releases, current, failedVersion);
      if (!previous) {
        throw new DeployError(
          'No previous release available for rollback',
          ErrorCode.ROLLBACK_FAILED,
        );
      }
      previousVersion = previous.version;
    }
    const previousDir = this.releaseDir(stackName, previousVersion);

    // a failed redeploy of the same version goes back to that version's previous files
    const sameVersion = failedVersion === previousVersion;
    if (failedVersion && this.replaced.has(`${stackName}/${failedVersion}`)) {
      await this.restoreReplaced(stackName, failedVersion);
    } else if (sameVersion) {
      throw new DeployError(
        `Release ${previousVersion} is the failed release; nothing distinct to roll back to`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    printInfo(`Rolling back to ${previousVersion}...`);

    // a release written before the rendered stack was stored only has its compose
    const stackResult = await this.shell.run(
      `cat ${shellQuote(`${previousDir}/${RELEASE_STACK_FILE}`)} 2>/dev/null || cat ${shellQuote(`${previousDir}/${COMPOSE_FILE}`)}`,
    );
    if (stackResult.exitCode !== 0 || !stackResult.stdout.trim()) {
      throw new DeployError(
        `Could not read the stack for rollback at ${previousDir}`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    if (options.imageNodes?.length) await this.requireImagesOnNodes(previousDir, previousVersion, options.imageNodes);

    const deployResult = await swarm.redeploy(stackName, stackResult.stdout);
    if (!deployResult.success) {
      throw new DeployError(deployResult.error.message, ErrorCode.ROLLBACK_FAILED);
    }

    const convergence = await swarm.waitConvergence(stackName, 300, 5);
    if (!convergence.converged) {
      const detail = convergence.errorDetail ?? (convergence.timedOut ? 'timed out' : convergence.rolledBack ? 'Swarm rolled the services back' : '');
      throw new DeployError(
        `Rollback to ${previousVersion} did not converge${detail ? `: ${detail}` : ''}`,
        ErrorCode.ROLLBACK_FAILED,
        'Run `dockflow diagnose <env>` to see why the services do not start.',
      );
    }

    await this.warnIfAccessoriesChanged(stackName, swarm, previousDir, previousVersion);

    const linkResult = await this.shell.run(`ln -sfn ${shellQuote(previousDir)} ${shellQuote(`${this.stackDir(stackName)}/${CURRENT_LINK}`)}`);
    if (linkResult.exitCode !== 0) {
      throw new DeployError(
        `Rollback deployed ${previousVersion} but failed to update the current release symlink: ${failure(linkResult)}`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    if (failedVersion && !sameVersion) {
      const failedDir = this.releaseDir(stackName, failedVersion);
      const removed = await this.shell
        .run(`timeout 30 rm -rf ${shellQuote(failedDir)} ${shellQuote(this.backupDir(stackName, failedVersion))}`)
        .catch(() => null);
      if (!removed || removed.exitCode !== 0) printWarning(`Could not remove failed release directory ${failedDir}`);
    }

    return previousVersion;
  }

  /**
   * Without a registry, nodes cannot pull a release's images: a node missing one would only show it
   * as a task that never starts, after the whole convergence timeout.
   */
  private async requireImagesOnNodes(dir: string, version: string, nodes: ImageNode[]): Promise<void> {
    const compose = await this.shell.run(`cat ${shellQuote(`${dir}/${COMPOSE_FILE}`)} 2>/dev/null`);
    const images = compose.exitCode === 0 ? extractComposeImages(compose.stdout, true) : [];
    if (images.length === 0) return;

    const command = missingImagesCommand(images);
    const missing = (
      await Promise.all(
        nodes.map(async (node) => {
          try {
            const result = await node.shell.run(command);
            return { node: node.name, images: result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) };
          } catch (error) {
            printWarning(`Could not check the images on ${node.name}: ${error instanceof Error ? error.message : String(error)}`);
            return { node: node.name, images: [] };
          }
        }),
      )
    ).filter((entry) => entry.images.length > 0);
    if (missing.length === 0) return;

    throw new DeployError(
      `Cannot roll back to ${version}: its images are missing on ${missing.map((entry) => `${entry.node} (${entry.images.join(', ')})`).join('; ')}`,
      ErrorCode.ROLLBACK_FAILED,
      `No registry holds them, so the nodes cannot pull them. Deploy ${version} again to rebuild and distribute its images.`,
    );
  }

  /** Accessories are not part of the stack a rollback redeploys; say so when they are not what the release ran with. */
  private async warnIfAccessoriesChanged(stackName: string, swarm: SwarmStack, dir: string, version: string): Promise<void> {
    try {
      const metadata = await this.shell.run(`cat ${shellQuote(`${dir}/${METADATA_FILE}`)} 2>/dev/null`);
      const recorded = metadata.exitCode === 0 ? parseMetadata(metadata.stdout)?.accessories_digest : undefined;
      if (typeof recorded !== 'string' || recorded === '') return;
      const running = await swarm.accessoriesDigest(stackName);
      if (running !== null && running !== recorded) printWarning(`Accessories were not rolled back: they changed since ${version}`);
    } catch (error) {
      printDebug(`Accessories digest check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Removes a release directory; a version this process redeployed gets its previous files back
   * instead. When `current` points at this version, `restoreTo` is the new target (null removes the link).
   */
  async removeRelease(stackName: string, version: string, restoreTo?: string | null): Promise<void> {
    const dir = this.releaseDir(stackName, version);
    const link = shellQuote(`${this.stackDir(stackName)}/${CURRENT_LINK}`);
    const restoreLink = restoreTo === undefined
      ? ''
      : `if [ "$(readlink ${link} 2>/dev/null)" = ${shellQuote(dir)} ]; then ${restoreTo ? `ln -sfn ${shellQuote(restoreTo)} ${link}` : `rm -f ${link}`}; fi`;

    if (this.replaced.has(`${stackName}/${version}`)) {
      await this.restoreReplaced(stackName, version);
      if (restoreLink && restoreTo !== dir) await this.shell.run(restoreLink);
      printDebug(`Restored the previous files of release ${version}`);
      return;
    }

    // current first: never a dangling pointer
    if (restoreLink) await this.shell.run(restoreLink);
    await this.shell.run(`timeout 30 rm -rf ${shellQuote(dir)} ${shellQuote(this.backupDir(stackName, version))}`);
    printDebug(`Removed release ${version}`);
  }

  /**
   * Keeps the newest `stack_management.keep_releases` releases, and current whatever its age; the
   * orphaned images of the removed ones are deleted here and on `otherNodes`.
   */
  async cleanupOldReleases(
    stackName: string,
    config: DockflowConfig,
    otherNodes: RemoteShell[] = [],
  ): Promise<void> {
    const keepN = config.stack_management?.keep_releases ?? DEFAULT_KEEP_RELEASES;
    const [releases, current] = await Promise.all([this.listReleases(stackName), this.currentVersion(stackName)]);
    const { kept, removed } = selectRetention(releases, current, keepN);

    // one YAML document per release
    const composeFiles = (list: ReleaseMetadata[]) =>
      list.length === 0
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
        : this.shell.run(
            `for f in ${list.map(r => shellQuote(`${this.releaseDir(stackName, r.version)}/${COMPOSE_FILE}`)).join(' ')}; do cat "$f" 2>/dev/null; echo '---'; done`,
          );

    const [runningResult, keptResult, removeResult] = await Promise.all([
      this.shell.run(
        `for stack in $(docker stack ls --format '{{.Name}}' 2>/dev/null); do ` +
          `docker stack services "$stack" --format '{{.Image}}' 2>/dev/null; ` +
        `done`,
      ),
      composeFiles(kept),
      composeFiles(removed),
    ]);

    const orphanImages = removed.length === 0 ? [] : computeOrphanImages(runningResult.stdout, keptResult.stdout, removeResult.stdout);

    if (orphanImages.length > 0) {
      const command = removeImagesCommand(orphanImages);
      await Promise.allSettled([this.shell, ...otherNodes].map((node) => node.run(command)));
      printDebug(`Removed ${orphanImages.length} orphaned image(s)`);
    }

    await sweepStaleTags(kept, keptResult.stdout, removeResult.stdout, runningResult.stdout, orphanImages, [this.shell, ...otherNodes]).catch((error: unknown) =>
      printDebug(`Image tag sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    );

    if (removed.length === 0) {
      printDebug(`${releases.length} release(s), keeping ${keepN} — nothing to clean`);
      return;
    }

    const paths = removed.flatMap(r => [this.releaseDir(stackName, r.version), this.backupDir(stackName, r.version)]);
    await this.shell.run(`timeout 60 rm -rf ${paths.map(shellQuote).join(' ')}`);

    printInfo(`Cleaned up ${removed.length} old release(s)`);
  }


  /** Puts back the files a same-version create kept aside (only complete copies are kept aside). */
  private async restoreReplaced(stackName: string, version: string): Promise<void> {
    const dir = shellQuote(this.releaseDir(stackName, version));
    const backup = shellQuote(this.backupDir(stackName, version));
    const result = await this.shell.run(
      [
        'umask 077',
        `if [ -d ${backup} ]; then`,
        `  mkdir -p ${dir} || exit 1`,
        `  for f in ${RELEASE_FILES.map(shellQuote).join(' ')}; do`,
        `    if [ -f ${backup}/"$f" ]; then mv -f ${backup}/"$f" ${dir}/"$f" || exit 1; else rm -f ${dir}/"$f"; fi`,
        '  done',
        `  rm -rf ${backup}`,
        'fi',
      ].join('\n'),
    );
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Failed to restore the previous files of release ${version}: ${failure(result)}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
    this.replaced.delete(`${stackName}/${version}`);
  }

  private async discard(tmp: string): Promise<void> {
    await this.shell
      .run(`rm -rf ${shellQuote(tmp)}`)
      .catch((error: unknown) =>
        printDebug(`Release temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
      );
  }
}
