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
 *       stack.yml
 *       metadata.json
 *     v1.2.4/
 *       ...
 *
 * Release files hold the rendered stack and its secrets: they are written under umask 077.
 */

import { randomBytes } from 'crypto';
import { parseAllDocuments } from 'yaml';
import type { SSHKeyConnection } from '../types';
import { shellQuote } from '../utils/ssh';
import { sshShell, type RemoteShell } from '../utils/remote-shell';
import { printDebug, printInfo, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { DOCKFLOW_STACKS_DIR, RELEASE_STACK_FILE } from '../constants';
import type { StackBackend } from './orchestrator/interfaces';
import type { DockflowConfig } from '../utils/config';

const DEFAULT_KEEP_RELEASES = 3;
const COMPOSE_FILE = 'docker-compose.yml';
const METADATA_FILE = 'metadata.json';
const RELEASE_FILES = [COMPOSE_FILE, RELEASE_STACK_FILE, METADATA_FILE];
const CURRENT_LINK = 'current';
/** a release being written, renamed into place once complete */
const TEMP_PREFIX = '.tmp-';
/** the previous files of a version being redeployed, put back if that redeploy fails */
const BACKUP_PREFIX = '.previous-';

export interface ReleaseMetadata {
  project_name: string;
  version: string;
  env: string;
  timestamp: string;
  epoch: number;
  performer: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — release logic without SSH, unit-tested in __tests__/release.test.ts
// ---------------------------------------------------------------------------

/**
 * Stack names and versions become paths under `rm -rf`: each must be one plain path segment (no
 * `/`, no control character, not hidden, and a version cannot shadow `current`).
 */
export function assertReleaseName(value: string, kind: 'stack' | 'version'): void {
  let plain = value !== '' && !value.startsWith('.') && !value.includes('/');
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) plain = false;
  }
  if (kind === 'version' && value === CURRENT_LINK) plain = false;
  if (plain) return;
  const shown = JSON.stringify(value);
  if (kind === 'version') {
    throw new DeployError(
      `Version ${shown} cannot be used as a release directory name`,
      ErrorCode.DEPLOY_FAILED,
      'Use a version without `/` or control characters that does not start with `.` and is not `current`.',
    );
  }
  throw new DeployError(
    `Stack name ${shown} cannot be used as a directory name`,
    ErrorCode.DEPLOY_FAILED,
    'Use a project name and environment without `/` or control characters that do not start with `.`.',
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** newest first: epoch descending, then version descending */
function newestFirst(list: readonly ReleaseMetadata[]): ReleaseMetadata[] {
  return [...list].sort((a, b) => b.epoch - a.epoch || compareText(b.version, a.version));
}

/**
 * Parse the output of the release listing command (one `<directory>\t<metadata JSON>` per line)
 * into ReleaseMetadata entries, newest first. A directory whose metadata is unreadable or names
 * another version is reported through `onCorrupted` and left out: its name is what prune deletes.
 */
export function parseReleaseList(stdout: string, onCorrupted?: (directory: string) => void): ReleaseMetadata[] {
  const releases: ReleaseMetadata[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const directory = tab >= 0 ? line.slice(0, tab) : line;
    const metadata = tab >= 0 ? parseMetadata(line.slice(tab + 1)) : null;
    if (metadata && metadata.version === directory) {
      releases.push(metadata);
    } else {
      onCorrupted?.(directory);
    }
  }
  return newestFirst(releases);
}

function parseMetadata(text: string): ReleaseMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as ReleaseMetadata;
  if (typeof metadata.version !== 'string' || metadata.version === '') return null;
  if (typeof metadata.epoch === 'number') return metadata;
  return { ...metadata, epoch: Number(metadata.epoch) || 0 };
}

/**
 * The epoch of a new release: the time it is deployed, but always after every stored release, which
 * another machine may have written with its clock ahead of this one. Deploys are serialized by the
 * deploy lock, so the history, ordered by epoch, keeps the order of the deploys.
 */
export function releaseEpoch(now: Date, stored: readonly ReleaseMetadata[]): number {
  return stored.reduce((epoch, release) => Math.max(epoch, release.epoch + 1), Math.floor(now.getTime() / 1000));
}

/** The newest `keep` releases, plus current when it is older; everything else is removed. */
export function selectRetention(
  list: readonly ReleaseMetadata[],
  current: string | null,
  keep: number,
): { kept: ReleaseMetadata[]; removed: ReleaseMetadata[] } {
  const sorted = newestFirst(list);
  const kept = sorted.slice(0, Math.max(0, keep));
  if (current !== null && !kept.some((r) => r.version === current)) {
    const currentRelease = sorted.find((r) => r.version === current);
    if (currentRelease) kept.push(currentRelease);
  }
  const keptVersions = new Set(kept.map((r) => r.version));
  return { kept, removed: sorted.filter((r) => !keptVersions.has(r.version)) };
}

/**
 * The newest release strictly older than current, so a second rollback goes further back. With the
 * failed version known, the newest release other than it. Without a current record, the newest is
 * skipped (it is what runs).
 */
export function selectRollbackTarget(
  list: readonly ReleaseMetadata[],
  current: string | null,
  failedVersion?: string | null,
): ReleaseMetadata | null {
  const sorted = newestFirst(list);
  if (failedVersion) return sorted.find((r) => r.version !== failedVersion) ?? null;
  const index = sorted.findIndex((r) => r.version === current);
  return index === -1 ? (sorted[1] ?? null) : (sorted[index + 1] ?? null);
}

/**
 * The images of the services of one or more compose documents (several files read one after the
 * other are separated by `---`). Only `services.*.image`: an `image:` in a comment or a label is
 * not an image. An unreadable document contributes nothing.
 */
export function extractComposeImages(yamlText: string): string[] {
  const images: string[] = [];
  for (const doc of parseAllDocuments(yamlText)) {
    if (doc.errors.length > 0) continue;
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: 1000 });
    } catch {
      continue;
    }
    const services = isRecord(value) ? value.services : undefined;
    if (!isRecord(services)) continue;
    for (const service of Object.values(services)) {
      const image = isRecord(service) ? service.image : undefined;
      if (typeof image === 'string' && image !== '' && !images.includes(image)) images.push(image);
    }
  }
  return images;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Removes the images, and the stopped containers that keep them. `ancestor=` matches by image id,
 * which a kept release shares when its build came from the same cache: a running container is
 * never removed, and `docker rmi` of a shared id only drops the tag.
 */
export function removeImagesCommand(images: string[]): string {
  return (
    `for img in ${images.map(shellQuote).join(' ')}; do ` +
      `ids=$(docker ps -a --filter "ancestor=$img" --filter status=exited --filter status=created --filter status=dead -q 2>/dev/null); ` +
      `[ -n "$ids" ] && docker rm $ids 2>/dev/null; ` +
      `timeout 60 docker rmi "$img" 2>/dev/null; ` +
    `done; true`
  );
}

/**
 * Compute which images from removed releases can be deleted: anything not used
 * by a running stack, not referenced by a kept release, and not tagged :latest.
 * Returns a deduplicated list.
 */
export function computeOrphanImages(
  runningImagesOutput: string,
  keptComposeYaml: string,
  removedComposeYaml: string,
): string[] {
  const protectedImages = new Set(runningImagesOutput.trim().split('\n').filter(Boolean));
  for (const img of extractComposeImages(keptComposeYaml)) {
    protectedImages.add(img);
  }

  const orphans: string[] = [];
  for (const img of extractComposeImages(removedComposeYaml)) {
    if (!protectedImages.has(img) && !img.endsWith(':latest')) {
      orphans.push(img);
    }
  }
  return [...new Set(orphans)];
}

function failure(result: { stderr: string; exitCode: number }): string {
  return result.stderr.trim() || `exit ${result.exitCode}`;
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

    // Leftovers of an interrupted create are dropped; the deploy lock rules out a concurrent one.
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

  /**
   * Read the compose file from the current release symlink.
   * Returns null if no release exists yet.
   */
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
   * Rollback to the previous release. Returns the version rolled back to.
   * When `previousReleasePath` is supplied the target is used directly;
   * otherwise the newest release older than current, or other than the failed one, is used.
   */
  async rollback(
    stackName: string,
    orchestrator: StackBackend,
    failedVersion?: string | null,
    previousReleasePath?: string | null,
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

    // A failed redeploy of the same version goes back to that version's previous files.
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

    // A release written before the rendered stack was stored only has its compose.
    const stackResult = await this.shell.run(
      `cat ${shellQuote(`${previousDir}/${RELEASE_STACK_FILE}`)} 2>/dev/null || cat ${shellQuote(`${previousDir}/${COMPOSE_FILE}`)}`,
    );
    if (stackResult.exitCode !== 0 || !stackResult.stdout.trim()) {
      throw new DeployError(
        `Could not read the stack for rollback at ${previousDir}`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }

    const deployResult = await orchestrator.redeploy(stackName, stackResult.stdout);
    if (!deployResult.success) {
      throw new DeployError(deployResult.error.message, ErrorCode.ROLLBACK_FAILED);
    }

    const convergence = await orchestrator.waitConvergence(stackName, 300, 5);
    if (!convergence.converged) {
      const detail = convergence.errorDetail ?? (convergence.timedOut ? 'timed out' : convergence.rolledBack ? 'Swarm rolled the services back' : '');
      throw new DeployError(
        `Rollback to ${previousVersion} did not converge${detail ? `: ${detail}` : ''}`,
        ErrorCode.ROLLBACK_FAILED,
        'Run `dockflow diagnose <env>` to see why the services do not start.',
      );
    }

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
   * Remove a single release directory; a version this process redeployed gets its previous files
   * back instead. If restoreTo is provided and the `current` symlink points to this version,
   * restores it to the given target (or removes the symlink if restoreTo is null).
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
   * Cleanup old releases keeping the N most recent, and current whatever its age.
   * Also removes orphaned Docker images from deleted releases, here and on `otherNodes`.
   */
  async cleanupOldReleases(
    stackName: string,
    config: DockflowConfig,
    otherNodes: RemoteShell[] = [],
  ): Promise<void> {
    const keepN = config.stack_management?.keep_releases ?? DEFAULT_KEEP_RELEASES;
    const [releases, current] = await Promise.all([this.listReleases(stackName), this.currentVersion(stackName)]);
    const { kept, removed } = selectRetention(releases, current, keepN);

    if (removed.length === 0) {
      printDebug(`${releases.length} release(s), keeping ${keepN} — nothing to clean`);
      return;
    }

    // one YAML document per release
    const composeFiles = (list: ReleaseMetadata[]) =>
      `for f in ${list.map(r => shellQuote(`${this.releaseDir(stackName, r.version)}/${COMPOSE_FILE}`)).join(' ')}; do cat "$f" 2>/dev/null; echo '---'; done`;

    const [runningResult, keptResult, removeResult] = await Promise.all([
      this.shell.run(
        `for stack in $(docker stack ls --format '{{.Name}}' 2>/dev/null); do ` +
          `docker stack services "$stack" --format '{{.Image}}' 2>/dev/null; ` +
        `done`,
      ),
      this.shell.run(composeFiles(kept)),
      this.shell.run(composeFiles(removed)),
    ]);

    const orphanImages = computeOrphanImages(runningResult.stdout, keptResult.stdout, removeResult.stdout);

    if (orphanImages.length > 0) {
      const command = removeImagesCommand(orphanImages);
      await Promise.allSettled([this.shell, ...otherNodes].map((node) => node.run(command)));
      printDebug(`Removed ${orphanImages.length} orphaned image(s)`);
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
