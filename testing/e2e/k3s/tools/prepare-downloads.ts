#!/usr/bin/env bun
/**
 * Fills the content-addressed cache of pinned downloads the k3s node image carries:
 * testing/e2e/.cache/downloads/sha256/<sha256> for the k3s binary, install.sh, the Helm archive and
 * the Traefik chart of the target architecture, each verified against its pin (cli/src/services/
 * orchestrator/kubernetes/{k3s/versions.ts,versions.ts}). The node image copies the directory to
 * /var/cache/dockflow/sha256/, which setup and the proxy backend consult before downloading and still
 * verify against the pin; the same layout is how an air-gapped host is provisioned.
 *
 * --previous-pin [file] also caches install.sh and the k3s binary of the previous k3s minor, used by
 * the upgrade scenario, and records that pin in .cache/downloads/previous-pin.json. Without a file
 * (a JSON pin shaped like K3S_PIN), the latest patch of the previous minor is resolved from the k3s
 * release channels and its checksums from the release's sha256sum-<arch>.txt.
 *
 * Usage (from the repository root):
 *   bun run testing/e2e/k3s/tools/prepare-downloads.ts [--arch amd64|arm64] [--previous-pin [file]]
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { K3S_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import {
  HELM_PIN,
  PINNED_ARCHES,
  type PinnedArch,
  type PinnedDownload,
  TRAEFIK_CHART_PIN,
} from "../../../../cli/src/services/orchestrator/kubernetes/versions";
import { CACHE_DIR } from "../../helpers/cluster";

export type Arch = PinnedArch;

export const DOWNLOADS_DIR = join(CACHE_DIR, "downloads", "sha256");
export const PREVIOUS_PIN_PATH = join(CACHE_DIR, "downloads", "previous-pin.json");
const TMP_DIR = join(CACHE_DIR, "tmp");

export const K3S_RELEASES = "https://github.com/k3s-io/k3s/releases/download";
const K3S_SOURCES = "https://raw.githubusercontent.com/k3s-io/k3s";
const K3S_CHANNELS = "https://update.k3s.io/v1-release/channels";
export const K3S_BINARY_NAMES: Readonly<Record<Arch, string>> = { amd64: "k3s", arm64: "k3s-arm64" };

const SHA256_RE = /^[0-9a-f]{64}$/;
const K3S_VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)\+k3s\d+$/;

export function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function isArch(value: string): value is Arch {
  return (PINNED_ARCHES as readonly string[]).includes(value);
}

export function hostArch(): Arch {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`The k3s e2e node image exists for amd64 and arm64 only, not ${process.arch}`);
}

export function parseArch(value: string | undefined): Arch {
  if (value !== undefined && isArch(value)) return value;
  throw new Error(`--arch must be one of ${PINNED_ARCHES.join(", ")}, got ${value ?? "nothing"}`);
}

// ─── HTTP and hashing ──────────────────────────────────────────────

/** GET over HTTPS; retries transport failures, 429 and 5xx. */
export async function fetchOk(url: string): Promise<Response> {
  if (!url.startsWith("https://")) throw new Error(`Refusing to download ${url} over a non-HTTPS URL`);
  let failure = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "dockflow-e2e-prepare" },
        redirect: "follow",
        signal: AbortSignal.timeout(600_000),
      });
      if (response.ok) return response;
      failure = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await Bun.sleep(attempt * 2000);
  }
  throw new Error(`GET ${url} failed: ${failure}`);
}

export async function fetchText(url: string): Promise<string> {
  return (await fetchOk(url)).text();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** `<sha256>  <name>` lines, as sha256sum prints them. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * Store `url` at `dest` when it hashes to `sha256`. An existing file is kept only if it verifies;
 * the download goes to a temporary file first so a partial file never carries a checksum name.
 */
export async function downloadVerified(url: string, sha256: string, dest: string, what: string): Promise<"cached" | "downloaded"> {
  if (existsSync(dest)) {
    if ((await sha256File(dest)) === sha256) return "cached";
    rmSync(dest, { force: true });
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, `${sha256}.${process.pid}.part`);
  try {
    await Bun.write(tmp, await fetchOk(url));
    const actual = await sha256File(tmp);
    if (actual !== sha256) {
      throw new Error(`${what} failed verification: expected sha256 ${sha256}, got ${actual} from ${url}`);
    }
    renameSync(tmp, dest);
    return "downloaded";
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ─── Pinned downloads ──────────────────────────────────────────────

export interface NamedDownload extends PinnedDownload {
  readonly name: string;
}

export function pinnedDownloads(arch: Arch): NamedDownload[] {
  return [
    { name: `k3s ${K3S_PIN.version} (${arch})`, ...K3S_PIN.binaries[arch] },
    { name: `k3s install.sh ${K3S_PIN.version}`, ...K3S_PIN.installScript },
    { name: `Helm ${HELM_PIN.version} (${arch})`, ...HELM_PIN.archives[arch] },
    { name: `Traefik chart ${TRAEFIK_CHART_PIN.version}`, url: TRAEFIK_CHART_PIN.url, sha256: TRAEFIK_CHART_PIN.sha256 },
  ];
}

/** Delete cache entries whose content no longer matches their name (the node image build refuses them). */
async function sweepCache(): Promise<void> {
  for (const name of readdirSync(DOWNLOADS_DIR)) {
    const path = join(DOWNLOADS_DIR, name);
    if (!SHA256_RE.test(name) || (await sha256File(path)) !== name) {
      log(`removing invalid cache entry ${name}`);
      rmSync(path, { recursive: true, force: true });
    }
  }
}

// ─── Previous k3s minor ────────────────────────────────────────────

export interface PreviousPin {
  version: string;
  installScript: PinnedDownload;
  binaries: Record<Arch, PinnedDownload>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDownload(value: unknown, where: string): PinnedDownload {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    !value.url.startsWith("https://") ||
    typeof value.sha256 !== "string" ||
    !SHA256_RE.test(value.sha256)
  ) {
    throw new Error(`${where} needs an https url and a 64-hex sha256`);
  }
  return { url: value.url, sha256: value.sha256 };
}

function asPreviousPin(value: unknown, source: string): PreviousPin {
  if (!isRecord(value) || typeof value.version !== "string" || !K3S_VERSION_RE.test(value.version)) {
    throw new Error(`${source} needs a k3s version such as v1.35.3+k3s1`);
  }
  const binaries: Record<string, unknown> = isRecord(value.binaries) ? value.binaries : {};
  return {
    version: value.version,
    installScript: asDownload(value.installScript, `${source} installScript`),
    binaries: {
      amd64: asDownload(binaries.amd64, `${source} binaries.amd64`),
      arm64: asDownload(binaries.arm64, `${source} binaries.arm64`),
    },
  };
}

function minorOf(version: string): [number, number] {
  const match = K3S_VERSION_RE.exec(version);
  if (!match) throw new Error(`${version} is not a k3s version`);
  return [Number(match[1]), Number(match[2])];
}

function previousChannel(): string {
  const [major, minor] = minorOf(K3S_PIN.version);
  return `v${major}.${minor - 1}`;
}

async function resolvePreviousPin(): Promise<PreviousPin> {
  const channel = previousChannel();
  const body: unknown = JSON.parse(await fetchText(K3S_CHANNELS));
  const channels = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  const latest = channels.find((entry) => entry.id === channel)?.latest;
  if (typeof latest !== "string" || !K3S_VERSION_RE.test(latest)) {
    throw new Error(`The k3s ${channel} channel has no release`);
  }
  const tag = encodeURIComponent(latest);
  const binary = async (arch: Arch): Promise<PinnedDownload> => {
    const sums = parseChecksums(await fetchText(`${K3S_RELEASES}/${tag}/sha256sum-${arch}.txt`));
    const sha256 = sums.get(K3S_BINARY_NAMES[arch]);
    if (!sha256) throw new Error(`sha256sum-${arch}.txt of k3s ${latest} has no entry for ${K3S_BINARY_NAMES[arch]}`);
    return { url: `${K3S_RELEASES}/${tag}/${K3S_BINARY_NAMES[arch]}`, sha256 };
  };
  const binaries = { amd64: await binary("amd64"), arm64: await binary("arm64") };
  // install.sh is published without a checksum: it is pinned by the hash of what was downloaded
  const installUrl = `${K3S_SOURCES}/${tag}/install.sh`;
  const script = new Uint8Array(await (await fetchOk(installUrl)).arrayBuffer());
  const installSha = sha256Hex(script);
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  writeFileSync(join(DOWNLOADS_DIR, installSha), script);
  return { version: latest, installScript: { url: installUrl, sha256: installSha }, binaries };
}

/** The previous-minor pin: from `file`, from the recorded pin when it is still of that minor, or resolved. */
export async function previousPin(source: string | true): Promise<PreviousPin> {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  let pin: PreviousPin;
  if (source !== true) {
    pin = asPreviousPin(JSON.parse(readFileSync(source, "utf-8")), source);
  } else if (existsSync(PREVIOUS_PIN_PATH)) {
    const recorded = asPreviousPin(JSON.parse(readFileSync(PREVIOUS_PIN_PATH, "utf-8")), PREVIOUS_PIN_PATH);
    pin = `v${minorOf(recorded.version).join(".")}` === previousChannel() ? recorded : await resolvePreviousPin();
  } else {
    pin = await resolvePreviousPin();
  }
  const [major, minor] = minorOf(K3S_PIN.version);
  const [pinMajor, pinMinor] = minorOf(pin.version);
  if (pinMajor !== major || pinMinor >= minor) {
    throw new Error(`The previous pin ${pin.version} is not older than the k3s minor of K3S_PIN ${K3S_PIN.version}`);
  }
  writeFileSync(PREVIOUS_PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

// ─── Entry point ───────────────────────────────────────────────────

export interface PrepareDownloadsOptions {
  arch: Arch;
  /** true: resolve the previous minor; a string: read that pin file */
  previousPin?: string | true;
}

export async function prepareDownloads(opts: PrepareDownloadsOptions): Promise<void> {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  await sweepCache();
  const downloads = pinnedDownloads(opts.arch);
  if (opts.previousPin !== undefined) {
    const pin = await previousPin(opts.previousPin);
    downloads.push(
      { name: `k3s ${pin.version} (${opts.arch}, previous minor)`, ...pin.binaries[opts.arch] },
      { name: `k3s install.sh ${pin.version}`, ...pin.installScript },
    );
  }
  for (const download of downloads) {
    const result = await downloadVerified(download.url, download.sha256, join(DOWNLOADS_DIR, download.sha256), download.name);
    log(`${result === "cached" ? "cached    " : "downloaded"}  ${download.sha256}  ${download.name}`);
  }
}

const USAGE = "Usage: bun run testing/e2e/k3s/tools/prepare-downloads.ts [--arch amd64|arm64] [--previous-pin [file]]";

function parseArgs(argv: string[]): PrepareDownloadsOptions {
  const opts: PrepareDownloadsOptions = { arch: hostArch() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arch") {
      opts.arch = parseArch(argv[++i]);
    } else if (arg === "--previous-pin") {
      const next = argv[i + 1];
      opts.previousPin = next !== undefined && !next.startsWith("--") ? (argv[++i] ?? true) : true;
    } else {
      throw new Error(`Unknown argument ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

if (import.meta.main) {
  try {
    await prepareDownloads(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
