/**
 * `dockflow list images` (design-06 3.6): images on every node, filtered by default to this
 * project's own images (repository containing the project name, or a reference of the current
 * release compose, verbatim or through `importedImageRef`) so the same test the Kubernetes backend's
 * own image GC uses decides what counts as "this project's image" here too.
 */

import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import type { NodeImage } from '../../services/orchestrator/interfaces';
import { importedImageRef } from '../../services/orchestrator/kubernetes/naming';
import { withServicesRequired } from '../../utils/errors';
import { colors, formatBytes, printBlank, printDim, printRaw, printSection } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { type Day2Context, openDay2 } from '../shared/day2';

export interface ListImagesOptions {
  server?: string;
  all?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `image:` of every service in a stored compose string; [] when it cannot be read (mirrors `kubernetes/backends/images.ts`'s own GC filter). */
function composeImageRefs(compose: string | null): string[] {
  if (!compose || compose.trim() === '') return [];
  let doc: unknown;
  try {
    doc = parseYaml(compose, { merge: true });
  } catch {
    return [];
  }
  const services = isRecord(doc) ? doc.services : undefined;
  if (!isRecord(services)) return [];
  const images: string[] = [];
  for (const service of Object.values(services)) {
    if (isRecord(service) && typeof service.image === 'string' && service.image !== '') images.push(service.image);
  }
  return images;
}

/** the current release's image references, verbatim and through `importedImageRef` (design-06 3.6) */
async function projectImageRefs(ctx: Day2Context): Promise<Set<string>> {
  const compose = await ctx.orchestrator.releases.currentCompose(ctx.stackName);
  const refs = new Set<string>();
  for (const ref of composeImageRefs(compose)) {
    refs.add(ref);
    refs.add(importedImageRef(ref));
  }
  return refs;
}

function isProjectImage(image: NodeImage, projectName: string, refs: ReadonlySet<string>): boolean {
  return image.ref.includes(projectName) || refs.has(image.ref);
}

/** `repo:tag`/`repo@digest` split for display; a digest-only reference prints `latest` (no tag to show). */
function splitRef(ref: string): [string, string] {
  const at = ref.lastIndexOf('@');
  const withoutDigest = at === -1 ? ref : ref.slice(0, at);
  const colon = withoutDigest.lastIndexOf(':');
  const slash = withoutDigest.lastIndexOf('/');
  if (colon === -1 || colon < slash) return [withoutDigest, 'latest'];
  return [withoutDigest.slice(0, colon), withoutDigest.slice(colon + 1)];
}

export async function runListImages(env: string, options: ListImagesOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const nodes = [...ctx.orchestrator.target.managers, ...ctx.orchestrator.target.workers];
  const result = await ctx.orchestrator.images.list(nodes, { all: Boolean(options.all) });
  const refs = options.all ? new Set<string>() : await projectImageRefs(ctx);

  for (const row of result) {
    const images = options.all ? row.images : row.images.filter((image) => isProjectImage(image, ctx.config.project_name, refs));
    printSection(row.diskUsage ? `Node ${row.node} (disk: ${row.diskUsage})` : `Node ${row.node}`);
    if (images.length === 0) {
      printDim('  No images found');
      printBlank();
      continue;
    }
    printRaw(colors.dim(`  ${'REPOSITORY'.padEnd(45)}${'TAG'.padEnd(9)}${'SIZE'.padEnd(10)}IN USE`));
    for (const image of images) {
      const [repository, tag] = splitRef(image.ref);
      const size = image.sizeBytes === null ? '-' : formatBytes(image.sizeBytes);
      printRaw(`  ${repository.padEnd(45)}${tag.padEnd(9)}${size.padEnd(10)}${image.inUse ? 'yes' : 'no'}`);
    }
    printBlank();
  }

  if (ctx.orchestrator.kind === 'k3s') {
    printDim('Run `dockflow prune <env> --images --all` to remove unused images');
  }
}

export function registerListImagesCommand(parent: Command): void {
  parent
    .command('images <env>')
    .description('Show images on cluster nodes')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('-a, --all', 'Show all images, not just project images')
    .action(withServicesRequired(withResolvedEnv(runListImages)));
}
