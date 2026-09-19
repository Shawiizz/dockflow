#!/usr/bin/env bun
/**
 * Builds the k3s e2e node image (testing/e2e/docker/Dockerfile.k3s-vm, context testing/e2e). Its
 * build args come from the pins (cli/src/services/orchestrator/kubernetes/{k3s/versions.ts,
 * versions.ts}) and images.lock.json, never from a literal, and the download cache and image
 * archives are prepared first, so the image builds from an empty cache.
 *
 * Usage (from the repository root):
 *   bun run testing/e2e/k3s/tools/build-node-image.ts [--arch amd64|arm64] [--tag <image>] [--nightly]
 *                                                    [--save <file.tar.zst>] [--if-stale]
 * --if-stale does nothing when the tagged image was built from the same inputs (label
 * dockflow.e2e.fingerprint); --save writes `docker save | zstd` for the CI artifact.
 */

import { createHash } from "crypto";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { K3S_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { HELM_PIN, TRAEFIK_CHART_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/versions";
import { DEFAULT_NODE_IMAGE, E2E_DIR, execStreaming, tryExec } from "../../helpers/cluster";
import { bakedImages, findImage, type ImagesLock, lockedReference, NODE_BASE_REPOSITORY, readImagesLock } from "./lock-images";
import { type Arch, hostArch, log, parseArch, prepareDownloads } from "./prepare-downloads";
import { prepareImages } from "./prepare-images";

const DOCKERFILE = join("docker", "Dockerfile.k3s-vm");
const FINGERPRINT_LABEL = "dockflow.e2e.fingerprint";

/** Files copied into the image; a change to any of them makes the image stale. */
const BUILD_FILES = [
  "docker/Dockerfile.k3s-vm",
  "docker/entrypoint.k3s.sh",
  "docker/healthcheck.k3s.sh",
  "docker/k3s-node/sshd_config.d/10-e2e.conf",
  "docker/k3s-node/e2e-forward@.service",
  "fixtures/keys/id_ed25519.pub",
  "fixtures/keys/bootstrap_ed25519.pub",
];

export interface BuildNodeImageOptions {
  arch: Arch;
  tag: string;
  nightly: boolean;
  save?: string;
  ifStale: boolean;
}

/** The single source of the Dockerfile's build args: the pins and the locked base image. */
export function nodeImageBuildArgs(arch: Arch, lock: ImagesLock): Record<string, string> {
  return {
    BASE_IMAGE: lockedReference(findImage(lock, NODE_BASE_REPOSITORY)),
    K3S_VERSION: K3S_PIN.version,
    K3S_BIN_SHA256: K3S_PIN.binaries[arch].sha256,
    K3S_INSTALL_SHA256: K3S_PIN.installScript.sha256,
    HELM_VERSION: HELM_PIN.version,
    HELM_ARCHIVE_SHA256: HELM_PIN.archives[arch].sha256,
    TRAEFIK_CHART_SHA256: TRAEFIK_CHART_PIN.sha256,
  };
}

export function nodeImageFingerprint(opts: BuildNodeImageOptions, lock: ImagesLock, args: Record<string, string>): string {
  const hash = createHash("sha256");
  const baked = bakedImages(lock, opts.nightly).map(lockedReference);
  hash.update(JSON.stringify({ arch: opts.arch, nightly: opts.nightly, args, baked }));
  for (const file of BUILD_FILES) hash.update(`\n${file}\n`).update(readFileSync(join(E2E_DIR, file)));
  return hash.digest("hex");
}

async function imageFingerprint(tag: string): Promise<string | null> {
  const inspect = await tryExec(["docker", "image", "inspect", "--format", `{{ index .Config.Labels "${FINGERPRINT_LABEL}" }}`, tag]);
  return inspect.exitCode === 0 ? inspect.stdout.trim() : null;
}

async function saveCompressed(tag: string, out: string): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  log(`Saving ${tag} to ${out}...`);
  const save = Bun.spawn(["docker", "save", tag], { stdout: "pipe", stderr: "inherit" });
  const zstd = Bun.spawn(["zstd", "-q", "-f", "-T0", "-o", out], { stdin: save.stdout, stdout: "inherit", stderr: "inherit" });
  const [saveCode, zstdCode] = await Promise.all([save.exited, zstd.exited]);
  if (saveCode !== 0 || zstdCode !== 0) {
    rmSync(out, { force: true });
    throw new Error(`docker save ${tag} | zstd failed (exit ${saveCode} and ${zstdCode})`);
  }
}

export async function buildNodeImage(opts: BuildNodeImageOptions): Promise<void> {
  const lock = readImagesLock();
  const args = nodeImageBuildArgs(opts.arch, lock);
  const fingerprint = nodeImageFingerprint(opts, lock, args);

  if (opts.ifStale && (await imageFingerprint(opts.tag)) === fingerprint) {
    log(`${opts.tag} is up to date (${fingerprint.slice(0, 12)})`);
  } else {
    await prepareDownloads({ arch: opts.arch });
    await prepareImages({ arch: opts.arch, nightly: opts.nightly });
    log(`Building ${opts.tag} for linux/${opts.arch} (k3s ${K3S_PIN.version}, Helm ${HELM_PIN.version})...`);
    await execStreaming(
      [
        "docker", "build",
        "--platform", `linux/${opts.arch}`,
        "-f", DOCKERFILE,
        "-t", opts.tag,
        "--label", `${FINGERPRINT_LABEL}=${fingerprint}`,
        ...Object.entries(args).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]),
        ".",
      ],
      { cwd: E2E_DIR, env: { DOCKER_BUILDKIT: "1" }, timeoutMs: 3_600_000 },
    );
    log(`Built ${opts.tag}`);
  }
  if (opts.save) await saveCompressed(opts.tag, opts.save);
}

const USAGE =
  "Usage: bun run testing/e2e/k3s/tools/build-node-image.ts [--arch amd64|arm64] [--tag <image>] [--nightly] [--save <file.tar.zst>] [--if-stale]";

function parseArgs(argv: string[]): BuildNodeImageOptions {
  const opts: BuildNodeImageOptions = { arch: hostArch(), tag: DEFAULT_NODE_IMAGE, nightly: false, ifStale: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--arch") opts.arch = parseArch(argv[++i]);
    else if (arg === "--tag") opts.tag = value();
    else if (arg === "--save") opts.save = resolve(value());
    else if (arg === "--nightly") opts.nightly = true;
    else if (arg === "--if-stale") opts.ifStale = true;
    else throw new Error(`Unknown argument ${arg}\n${USAGE}`);
  }
  return opts;
}

if (import.meta.main) {
  try {
    await buildNodeImage(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
