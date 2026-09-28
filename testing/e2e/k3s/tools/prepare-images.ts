#!/usr/bin/env bun
/**
 * Images the k3s node image carries in /var/lib/rancher/k3s/agent/images/, imported and pinned by
 * k3s when it starts, so every node has them without pulling:
 * - .cache/images/k3s-airgap-images-<arch>.tar.zst: the k3s system images of K3S_PIN.version,
 *   verified against the release's sha256sum-<arch>.txt, which is trusted only because it lists the
 *   pinned k3s binary hash;
 * - .cache/images/e2e-images-<arch>.tar: the images.lock.json entries marked `bake` (`--nightly`
 *   adds the "nightly" ones), pulled by digest, tagged back to their reference and saved.
 * The pulled images stay tagged in the runner's Docker, so fixture builds (`FROM nginx:alpine`)
 * do not hit Docker Hub. Both archives are reused while their pins are unchanged, the workload one
 * also while Docker keeps the same image store.
 *
 * Usage (from the repository root):
 *   bun run testing/e2e/k3s/tools/prepare-images.ts [--arch amd64|arm64] [--nightly]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { K3S_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { CACHE_DIR, exec, tryExec } from "../../helpers/cluster";
import { bakedImages, type ImagesLock, lockedReference, readImagesLock, traefikProblem } from "./lock-images";
import {
  type Arch,
  downloadVerified,
  fetchText,
  hostArch,
  K3S_BINARY_NAMES,
  K3S_RELEASES,
  log,
  parseArch,
  parseChecksums,
  sha256File,
} from "./prepare-downloads";

export const IMAGES_DIR = join(CACHE_DIR, "images");

export function airgapArchivePath(arch: Arch): string {
  return join(IMAGES_DIR, `k3s-airgap-images-${arch}.tar.zst`);
}

export function workloadArchivePath(arch: Arch): string {
  return join(IMAGES_DIR, `e2e-images-${arch}.tar`);
}

// ─── k3s airgap archive ────────────────────────────────────────────

async function ensureAirgapArchive(arch: Arch): Promise<void> {
  const archive = airgapArchivePath(arch);
  const name = `k3s-airgap-images-${arch}.tar.zst`;
  // "<sha256>  <k3s version>" of the verified archive, so a re-run needs no network
  const stamp = `${archive}.sha256`;
  if (existsSync(archive) && existsSync(stamp)) {
    const [sha256, version] = readFileSync(stamp, "utf-8").trim().split(/\s+/);
    if (version === K3S_PIN.version && sha256 && (await sha256File(archive)) === sha256) {
      log(`cached      ${name} (k3s ${version})`);
      return;
    }
  }

  const tag = encodeURIComponent(K3S_PIN.version);
  const sums = parseChecksums(await fetchText(`${K3S_RELEASES}/${tag}/sha256sum-${arch}.txt`));
  const binary = K3S_BINARY_NAMES[arch];
  const pinned = K3S_PIN.binaries[arch].sha256;
  if (sums.get(binary) !== pinned) {
    throw new Error(
      `sha256sum-${arch}.txt of k3s ${K3S_PIN.version} lists ${binary} as ${sums.get(binary) ?? "nothing"} but K3S_PIN pins ${pinned}; the checksum file is not trusted`,
    );
  }
  const sha256 = sums.get(name);
  if (!sha256) throw new Error(`sha256sum-${arch}.txt of k3s ${K3S_PIN.version} has no entry for ${name}`);

  mkdirSync(IMAGES_DIR, { recursive: true });
  const result = await downloadVerified(`${K3S_RELEASES}/${tag}/${name}`, sha256, archive, `${name} of k3s ${K3S_PIN.version}`);
  writeFileSync(stamp, `${sha256}  ${K3S_PIN.version}\n`);
  log(`${result === "cached" ? "cached    " : "downloaded"}  ${name} (k3s ${K3S_PIN.version})`);
}

// ─── Workload images ───────────────────────────────────────────────

async function usesContainerdStore(): Promise<boolean> {
  const info = await tryExec(["docker", "info", "--format", "{{json .DriverStatus}}"]);
  return info.stdout.includes("io.containerd.snapshotter");
}

async function pullAndTag(ref: string, locked: string, arch: Arch): Promise<void> {
  const present = await tryExec(["docker", "image", "inspect", locked]);
  if (present.exitCode !== 0) {
    log(`pulling     ${locked}`);
    await exec(["docker", "pull", "--platform", `linux/${arch}`, locked], { timeoutMs: 1_200_000 });
  }
  await exec(["docker", "tag", locked, ref]);
}

/**
 * No `--platform`: it saves the platform's manifest alone and drops the index, whose digest the nodes
 * resolve an image pinned by digest through. Only the content that was pulled comes along, which
 * pullAndTag limits to the node's platform.
 */
async function dockerSave(refs: readonly string[], archive: string): Promise<void> {
  const partial = `${archive}.part`;
  rmSync(partial, { force: true });
  try {
    await exec(["docker", "save", "-o", partial, ...refs], { timeoutMs: 1_800_000 });
    renameSync(partial, archive);
  } finally {
    rmSync(partial, { force: true });
  }
}

/** every locked index digest is a blob of the archive */
async function carriesDigests(archive: string, digests: readonly string[]): Promise<boolean> {
  const listing = await tryExec(["tar", "-tf", archive], { timeoutMs: 300_000 });
  if (listing.exitCode !== 0) return false;
  const blobs = new Set(listing.stdout.split(/\r?\n/));
  return digests.every((digest) => blobs.has(`blobs/sha256/${digest.replace(/^sha256:/, "")}`));
}

async function ensureWorkloadArchive(lock: ImagesLock, arch: Arch, nightly: boolean): Promise<void> {
  const images = bakedImages(lock, nightly).map((image) => {
    const locked = lockedReference(image);
    return { ref: image.ref, locked, digest: locked.slice(locked.indexOf("@") + 1) };
  });
  const archive = workloadArchivePath(arch);
  const stampPath = join(IMAGES_DIR, `e2e-images-${arch}.json`);
  // an archive saved from the classic store, or with an index missing, is saved again
  const containerdStore = await usesContainerdStore();
  const stamp = `${JSON.stringify({ arch, store: containerdStore ? "containerd" : "classic", images: images.map((image) => `${image.ref} ${image.locked}`) }, null, 2)}\n`;
  const upToDate =
    existsSync(archive) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf-8") === stamp &&
    (!containerdStore || (await carriesDigests(archive, images.map((image) => image.digest))));

  // Pull on the runner's own architecture even when the archive is current: fixture builds need the tags
  if (!upToDate || arch === hostArch()) {
    for (const image of images) await pullAndTag(image.ref, image.locked, arch);
  }
  if (upToDate) {
    log(`cached      e2e-images-${arch}.tar (${images.length} images)`);
    return;
  }

  if (!containerdStore) {
    process.stderr.write(
      "warning: Docker uses its classic image store, so docker save drops registry digests; " +
        "nodes resolve the baked images by tag, and an image referenced by digest (Dockflow's Traefik) is pulled from its registry\n",
    );
  }
  mkdirSync(IMAGES_DIR, { recursive: true });
  log(`saving      e2e-images-${arch}.tar (${images.length} images)`);
  await dockerSave(
    images.map((image) => image.ref),
    archive,
  );
  if (containerdStore && !(await carriesDigests(archive, images.map((image) => image.digest)))) {
    throw new Error(`docker save left out the index of an image pinned by digest in ${archive}`);
  }
  writeFileSync(stampPath, stamp);
}

// ─── Entry point ───────────────────────────────────────────────────

export interface PrepareImagesOptions {
  arch: Arch;
  nightly: boolean;
}

export async function prepareImages(opts: PrepareImagesOptions): Promise<void> {
  const lock = readImagesLock();
  const traefik = traefikProblem(lock);
  if (traefik) throw new Error(traefik);
  await ensureAirgapArchive(opts.arch);
  await ensureWorkloadArchive(lock, opts.arch, opts.nightly);
}

const USAGE = "Usage: bun run testing/e2e/k3s/tools/prepare-images.ts [--arch amd64|arm64] [--nightly]";

function parseArgs(argv: string[]): PrepareImagesOptions {
  const opts: PrepareImagesOptions = { arch: hostArch(), nightly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arch") opts.arch = parseArch(argv[++i]);
    else if (arg === "--nightly") opts.nightly = true;
    else throw new Error(`Unknown argument ${arg}\n${USAGE}`);
  }
  return opts;
}

if (import.meta.main) {
  try {
    await prepareImages(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
