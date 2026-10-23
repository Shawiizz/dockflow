/**
 * Docker image cleanup after releases are removed: which images a compose file names, which of
 * them nothing refers to any more, the commands that remove them, and the sweep of stale tags.
 */

import { parseAllDocuments } from 'yaml';
import { sh, type ShellCommand } from '../../utils/ssh';
import type { RemoteShell } from '../../utils/remote-shell';
import { printDebug } from '../../utils/output';
import { parseImageRef } from '../compose';
import type { ReleaseMetadata } from './layout';

/**
 * The images of the services of one or more compose documents (several files read one after the
 * other are separated by `---`). Only `services.*.image`: an `image:` in a comment or a label is
 * not an image. An unreadable document contributes nothing. With `builtOnly`, only the services
 * with a `build` section: the images Dockflow builds and distributes itself.
 */
export function extractComposeImages(yamlText: string, builtOnly = false): string[] {
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
      if (builtOnly && !(isRecord(service) && hasBuildSection(service))) continue;
      if (typeof image === 'string' && image !== '' && !images.includes(image)) images.push(image);
    }
  }
  return images;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBuildSection(service: Record<string, unknown>): boolean {
  const build = service.build;
  return typeof build === 'string' ? build !== '' : isRecord(build);
}

/** Prints, one per line, the images among `images` the node does not have. */
export function missingImagesCommand(images: string[]): ShellCommand {
  return sh`for img in ${images}; do docker image inspect "$img" >/dev/null 2>&1 || echo "$img"; done`;
}

/**
 * Removes the images, and the stopped containers that keep them. `ancestor=` matches by image id,
 * which a kept release shares when its build came from the same cache: a running container is
 * never removed, and `docker rmi` of a shared id only drops the tag.
 */
export function removeImagesCommand(images: string[]): ShellCommand {
  return sh`for img in ${images}; do ids=$(docker ps -a --filter "ancestor=$img" --filter status=exited --filter status=created --filter status=dead -q 2>/dev/null); [ -n "$ids" ] && docker rm $ids 2>/dev/null; timeout 60 docker rmi "$img" 2>/dev/null; done; true`;
}

/** The images of removed releases that no running stack or kept release refers to, never `:latest`, without duplicates. */
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

/** The repositories Dockflow names for the images it builds: `<image>-<env>`. */
export function builtRepositories(composeYaml: string, env: string): string[] {
  const names = extractComposeImages(composeYaml, true).map((image) => parseImageRef(image).name);
  return [...new Set(names.filter((name) => name.endsWith(`-${env}`)))];
}

/** How many of the documents are compose files with services: a release whose file was unreadable is missing from the count. */
function countComposeDocuments(yamlText: string): number {
  let count = 0;
  for (const doc of parseAllDocuments(yamlText)) {
    if (doc.errors.length > 0) continue;
    const value = doc.toJS({ maxAliasCount: 1000 }) as unknown;
    if (isRecord(value) && isRecord(value.services)) count++;
  }
  return count;
}

function withoutDigest(image: string): string {
  return image.replace(/@sha256:[0-9a-f]+$/, '');
}

/**
 * The `repository:tag` of `docker images` output that belong to `repositories` and that nothing
 * refers to: not `inUse` (the images of the kept releases and of the running services), never
 * `:latest`, never an untagged image.
 */
export function computeStaleTags(
  localImages: string,
  repositories: ReadonlySet<string>,
  inUse: Iterable<string>,
): string[] {
  const used = new Set([...inUse].map(withoutDigest));
  const stale = new Set<string>();
  for (const line of localImages.split('\n')) {
    const ref = line.trim();
    if (!ref) continue;
    const { name, tag } = parseImageRef(ref);
    if (!repositories.has(name) || tag === undefined || tag === 'latest' || tag === '<none>' || used.has(ref)) continue;
    stale.add(ref);
  }
  return [...stale];
}

/**
 * Removes, on every node, the `<image>-<env>:<tag>` tags of the project that no kept release and
 * no running service refers to: failed deploys and releases cleaned before leave them behind.
 * Nothing is swept unless every kept release was read, since an unread one would look unused.
 */
export async function sweepStaleTags(
  kept: readonly ReleaseMetadata[],
  keptCompose: string,
  removedCompose: string,
  runningImages: string,
  alreadyRemoved: readonly string[],
  nodes: readonly RemoteShell[],
): Promise<void> {
  const env = kept[0]?.env;
  if (!env || countComposeDocuments(keptCompose) < kept.length) return;

  const repositories = new Set([...builtRepositories(keptCompose, env), ...builtRepositories(removedCompose, env)]);
  if (repositories.size === 0) return;
  const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const referenced = [...extractComposeImages(keptCompose), ...lines(runningImages), ...alreadyRemoved];

  const swept = await Promise.allSettled(
    nodes.map(async (node) => {
      const [images, containers] = await Promise.all([
        node.run(sh`docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null`),
        node.run(sh`docker ps --format '{{.Image}}' 2>/dev/null`),
      ]);
      if (images.exitCode !== 0 || containers.exitCode !== 0) return 0;
      const stale = computeStaleTags(images.stdout, repositories, [...referenced, ...lines(containers.stdout)]);
      if (stale.length > 0) await node.run(removeImagesCommand(stale));
      return stale.length;
    }),
  );
  const count = swept.reduce((total, outcome) => total + (outcome.status === 'fulfilled' ? outcome.value : 0), 0);
  if (count > 0) printDebug(`Removed ${count} unreferenced image tag(s)`);
}
