#!/usr/bin/env bun
/**
 * Pins the images of the k3s e2e suite: resolves every reference of testing/e2e/k3s/images.lock.json
 * to its index digest and rewrites the file. Run by a maintainer (network and `docker buildx`
 * needed); the result is reviewed in a PR. The Traefik entry is never resolved: it follows
 * TRAEFIK_CHART_PIN (tag = appVersion, digest = imageDigest), the image Dockflow deploys.
 *
 * Usage (from the repository root):
 *   bun run testing/e2e/k3s/tools/lock-images.ts           resolve and rewrite
 *   bun run testing/e2e/k3s/tools/lock-images.ts --check   offline: fail when a digest is missing or stale
 *
 * The other tools and helpers/cluster.ts read the file through `readImagesLock`.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { TRAEFIK_CHART_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/versions";

/** true: baked into the node image; "nightly": baked only with `--nightly`; false: runner side only. */
export type BakeMode = boolean | "nightly";

export interface LockedImage {
  ref: string;
  /** index digest (`sha256:<64 hex>`), null until lock-images.ts has resolved it */
  digest: string | null;
  use: string;
  bake: BakeMode;
}

export interface ImagesLock {
  schema: 1;
  generatedBy: string;
  images: LockedImage[];
}

export const IMAGES_LOCK_PATH = join(import.meta.dir, "..", "images.lock.json");
export const TRAEFIK_REPOSITORY = "docker.io/traefik";
export const NODE_BASE_REPOSITORY = "docker.io/library/ubuntu";

const GENERATED_BY = "testing/e2e/k3s/tools/lock-images.ts";
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const LOCK_HINT = "run `bun run testing/e2e/k3s/tools/lock-images.ts` (network) and commit the result";

/** Repository part of a reference: tag and digest removed, registry port kept. */
export function repositoryOf(ref: string): string {
  const name = ref.split("@")[0] ?? ref;
  const colon = name.lastIndexOf(":");
  return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readImagesLock(path: string = IMAGES_LOCK_PATH): ImagesLock {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!isRecord(parsed) || parsed.schema !== 1 || !Array.isArray(parsed.images)) {
    throw new Error(`${path} is not an images lock of schema 1`);
  }
  const images = parsed.images.map((entry: unknown, index: number): LockedImage => {
    const where = `${path} images[${index}]`;
    if (!isRecord(entry) || typeof entry.ref !== "string" || typeof entry.use !== "string") {
      throw new Error(`${where} needs a string ref and use`);
    }
    const { ref, use, digest, bake } = entry;
    if (!(digest === null || (typeof digest === "string" && DIGEST_RE.test(digest)))) {
      throw new Error(`${where} (${ref}) has digest ${String(digest)}; expected sha256:<64 hex> or null`);
    }
    if (!(typeof bake === "boolean" || bake === "nightly")) {
      throw new Error(`${where} (${ref}) has bake ${String(bake)}; expected true, false or "nightly"`);
    }
    return { ref, digest, use, bake };
  });
  return { schema: 1, generatedBy: typeof parsed.generatedBy === "string" ? parsed.generatedBy : GENERATED_BY, images };
}

export function findImage(lock: ImagesLock, repository: string): LockedImage {
  const image = lock.images.find((entry) => repositoryOf(entry.ref) === repository);
  if (!image) throw new Error(`${IMAGES_LOCK_PATH} has no entry for ${repository}`);
  return image;
}

/** `repository@digest`, the only form the tools pull; refuses an unresolved entry. */
export function lockedReference(image: LockedImage): string {
  if (image.digest === null) throw new Error(`${IMAGES_LOCK_PATH} has no digest for ${image.ref}; ${LOCK_HINT}`);
  return `${repositoryOf(image.ref)}@${image.digest}`;
}

export function bakedImages(lock: ImagesLock, nightly: boolean): LockedImage[] {
  return lock.images.filter((image) => image.bake === true || (nightly && image.bake === "nightly"));
}

function traefikRef(): string {
  return `${TRAEFIK_REPOSITORY}:${TRAEFIK_CHART_PIN.appVersion}`;
}

/** Why the Traefik entry does not match the pin Dockflow deploys, or null. */
export function traefikProblem(lock: ImagesLock): string | null {
  const image = lock.images.find((entry) => repositoryOf(entry.ref) === TRAEFIK_REPOSITORY);
  if (!image) return `${IMAGES_LOCK_PATH} has no ${TRAEFIK_REPOSITORY} entry`;
  if (image.ref !== traefikRef()) {
    return `${IMAGES_LOCK_PATH} lists ${image.ref} but TRAEFIK_CHART_PIN deploys ${traefikRef()}; ${LOCK_HINT}`;
  }
  const pinned = TRAEFIK_CHART_PIN.imageDigest ?? null;
  if (pinned !== null && image.digest !== pinned) {
    return `${IMAGES_LOCK_PATH} pins ${image.ref} at ${image.digest} but TRAEFIK_CHART_PIN.imageDigest is ${pinned}; ${LOCK_HINT}`;
  }
  return null;
}

/** One image per line so a digest change is a one-line diff. */
export function formatImagesLock(lock: ImagesLock): string {
  const entry = (image: LockedImage) =>
    `    { "ref": ${JSON.stringify(image.ref)}, "digest": ${JSON.stringify(image.digest)}, "use": ${JSON.stringify(image.use)}, "bake": ${JSON.stringify(image.bake)} }`;
  return [
    "{",
    `  "schema": ${lock.schema},`,
    `  "generatedBy": ${JSON.stringify(lock.generatedBy)},`,
    '  "images": [',
    lock.images.map(entry).join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

interface ResolvedIndex {
  digest: string;
  platforms: string[];
}

async function inspectIndex(ref: string): Promise<ResolvedIndex> {
  const proc = Bun.spawn(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`docker buildx imagetools inspect ${ref} failed: ${stderr.trim()}`);
  const manifest: unknown = JSON.parse(stdout);
  if (!isRecord(manifest) || typeof manifest.digest !== "string" || !DIGEST_RE.test(manifest.digest)) {
    throw new Error(`docker buildx imagetools inspect ${ref} printed no digest`);
  }
  const children = Array.isArray(manifest.manifests) ? manifest.manifests.filter(isRecord) : [];
  const platforms = children.flatMap((child) => {
    const platform = isRecord(child.platform) ? child.platform : null;
    return platform && typeof platform.os === "string" && typeof platform.architecture === "string"
      ? [`${platform.os}/${platform.architecture}`]
      : [];
  });
  return { digest: manifest.digest, platforms };
}

const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];

async function lockImages(): Promise<number> {
  const lock = readImagesLock();
  const images: LockedImage[] = [];
  for (const image of lock.images) {
    if (repositoryOf(image.ref) === TRAEFIK_REPOSITORY) {
      const digest = TRAEFIK_CHART_PIN.imageDigest ?? (await inspectIndex(traefikRef())).digest;
      images.push({ ...image, ref: traefikRef(), digest });
      process.stdout.write(`${traefikRef()}  ${digest}  (TRAEFIK_CHART_PIN)\n`);
      continue;
    }
    const resolved = await inspectIndex(image.ref);
    // Node base and baked images must exist for both architectures of the node image
    if (image.bake !== false || repositoryOf(image.ref) === NODE_BASE_REPOSITORY) {
      const missing = REQUIRED_PLATFORMS.filter((platform) => !resolved.platforms.includes(platform));
      if (missing.length > 0) throw new Error(`${image.ref} (${resolved.digest}) has no ${missing.join(", ")} image`);
    }
    images.push({ ...image, digest: resolved.digest });
    process.stdout.write(`${image.ref}  ${resolved.digest}${image.digest && image.digest !== resolved.digest ? `  (was ${image.digest})` : ""}\n`);
  }
  writeFileSync(IMAGES_LOCK_PATH, formatImagesLock({ schema: 1, generatedBy: GENERATED_BY, images }));
  process.stdout.write(`Wrote ${IMAGES_LOCK_PATH}\n`);
  return 0;
}

function checkLock(): number {
  const lock = readImagesLock();
  const problems = lock.images.filter((image) => image.digest === null).map((image) => `${image.ref} has no digest`);
  const traefik = traefikProblem(lock);
  if (traefik) problems.push(traefik);
  if (problems.length === 0) {
    process.stdout.write(`${IMAGES_LOCK_PATH} pins ${lock.images.length} images\n`);
    return 0;
  }
  process.stderr.write(`${problems.join("\n")}\n${LOCK_HINT}\n`);
  return 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument ${unknown[0]}\nUsage: bun run testing/e2e/k3s/tools/lock-images.ts [--check]\n`);
    process.exit(2);
  }
  try {
    process.exit(args.includes("--check") ? checkLock() : await lockImages());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
