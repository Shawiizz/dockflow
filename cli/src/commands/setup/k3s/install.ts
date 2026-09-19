// Pinned downloads and the k3s install (design-05 3.3, 4.4, 4.4.1, 5.1, 5.2, DESIGN-CORE 8.7): one
// curl flag set for every download, a content-addressed root-only cache checked first and verified
// whether the bytes came from it or from the network, `sha256sum -c` before anything is installed,
// install.sh with a scrubbed environment, the service wait, and the verified delivery of the
// Dockflow binary itself (K57c).

import { readFileSync } from 'fs';
import { DOCKFLOW_RELEASE_URL, DOCKFLOW_VERSION } from '../../../constants';
import { K8S_TRANSPORT_FAILURES_TOLERATED } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import type { KubeExecutor } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { CLIError, ErrorCode, ValidationError } from '../../../utils/errors';
import { sha256Hex } from '../../../utils/hash';
import { Redactor } from '../../../utils/redact';
import { shellQuote } from '../../../utils/ssh';
import { buildBinaryDownloadUrl } from '../forward';
import {
  CURL_FLAGS,
  DOWNLOAD_CACHE_DIR,
  DOWNLOAD_MAX_TIME_S,
  K3S_AGENT_START_TIMEOUT_S,
  K3S_BINARY,
  K3S_SERVER_START_TIMEOUT_S,
} from './constants';
import { firstLineOf, type HostRunner, HOST_CHILD_ENV, lastLines, runChecked, SetupStepError } from './host-runner';
import { hostKubeExecutor } from './kube';
import type { SetupProblem } from './messages';
import type { K3sNodeRole, NodeArch } from './plan';

/** `/var/cache/dockflow`: root 0700, like the sha256 directory inside it (5.1, design-07 I-02) */
export const DOWNLOAD_CACHE_ROOT = DOWNLOAD_CACHE_DIR.slice(0, DOWNLOAD_CACHE_DIR.lastIndexOf('/'));
export const DOWNLOAD_CACHE_DIR_MODE = 0o700;
export const DOWNLOAD_CACHE_FILE_MODE = 0o600;
export const K3S_BINARY_MODE = '0755';
/** the curl deadline plus room for the process to report it */
const DOWNLOAD_TIMEOUT_MS = (DOWNLOAD_MAX_TIME_S + 60) * 1000;
const SHORT_COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_SCRIPT_TIMEOUT_MS = 600_000;
const INSTALL_SCRIPT_LOG_LINES = 30;
const SERVICE_POLL_MS = 2000;
const SERVICE_MAX_RESTARTS = 3;
const SERVICE_JOURNAL_LINES = 40;
const READYZ_TIMEOUT_S = 5;
const SHA256 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Messages (5.1, 3.3, 4.4, 4.4.1)
// ---------------------------------------------------------------------------

const DO_NOT_BYPASS =
  'Do not bypass this check. Retry later; if it persists, report it: the download does not match the release Dockflow pinned.';

export const installMessages = {
  /** `subject` is `<component> <version>` (or the local path of `--binary`) */
  verificationFailed: (subject: string, key: string, expected: string, actual: string): SetupProblem => ({
    message: `${subject} failed verification on ${key}: expected sha256 ${expected}, got ${actual}; nothing was installed`,
    suggestion: DO_NOT_BYPASS,
  }),
  downloadFailed: (subject: string, key: string, detail: string): SetupProblem => ({
    message: `Could not download ${subject} on ${key} (${detail})`,
    suggestion: `Check that ${key} reaches github.com and get.helm.sh over HTTPS.`,
  }),
  binaryDownloadFailed: (version: string, key: string, detail: string): SetupProblem => ({
    message: `Could not download Dockflow ${version} on ${key} (${detail})`,
    suggestion: `Check that ${key} reaches github.com over HTTPS.`,
  }),
  binaryDeliveryFailed: (key: string, detail: string): SetupProblem => ({
    message: `Could not install the Dockflow binary on ${key} (${detail})`,
    suggestion: `Check that the bootstrap user can write to its temporary directory on ${key}.`,
  }),
  cacheFailed: (key: string, detail: string): SetupProblem => ({
    message: `Could not prepare the download cache ${DOWNLOAD_CACHE_DIR} on ${key} (${detail})`,
    suggestion: `Check the permissions of ${DOWNLOAD_CACHE_ROOT} on ${key}; it must be a directory owned by root.`,
  }),
  binaryInstallFailed: (key: string, detail: string): SetupProblem => ({
    message: `Could not install ${K3S_BINARY} on ${key} (${detail})`,
    suggestion: `Check the free space and permissions of /usr/local/bin on ${key}.`,
  }),
  installScriptFailed: (key: string, exitCode: number): SetupProblem => ({
    message: `The k3s install script failed on ${key} (exit ${exitCode})`,
    suggestion: 'Run the setup again with --debug to see the full output.',
  }),
  serviceTimeout: (key: string, timeoutS: number, state: ServiceState): string =>
    `k3s on ${key} did not become ready within ${timeoutS}s (${state.activeState}/${state.subState}, ${state.restarts} restarts)`,
  serviceRestarting: (key: string, state: ServiceState): string =>
    `k3s on ${key} did not become ready: it restarted ${state.restarts} times (${state.activeState}/${state.subState})`,
  serviceUnreadable: (key: string, unit: string, detail: string): string =>
    `Could not read the state of ${unit} on ${key} (${detail})`,
  serviceSuggestion: (key: string, unit: string, joinUrl: string | null): string =>
    unit === 'k3s-agent'
      ? `Check that ${key} reaches ${joinUrl ?? 'its server'}, then run journalctl -u k3s-agent -n 100 on ${key}.`
      : `Run journalctl -u k3s -n 100 on ${key}.`,
  unsupportedArch: (machine: string, key: string): SetupProblem => ({
    message: `Unsupported architecture ${machine} on ${key}; k3s nodes must be amd64 or arm64`,
    suggestion: 'Use an amd64 (x86_64) or arm64 (aarch64) machine.',
  }),
  noSha256Sums: (version: string, nodes: number, asset: string | null): SetupProblem => ({
    message: `Dockflow ${version} publishes no SHA256SUMS${asset === null ? '' : ` entry for ${asset}`}, so the binary that would run as root on ${nodes} ${nodes === 1 ? 'node' : 'nodes'} cannot be verified`,
    suggestion: 'Use a Dockflow release that publishes `SHA256SUMS`, or pass `--dev` (build locally) or `--binary <path>`.',
  }),
  sha256SumsUnreachable: (version: string, detail: string): SetupProblem => ({
    message: `Could not fetch the SHA256SUMS of Dockflow ${version} (${detail})`,
    suggestion: 'Check that this machine reaches github.com over HTTPS, or pass `--dev` (build locally) or `--binary <path>`.',
  }),
  localBinaryUnreadable: (path: string, detail: string): SetupProblem => ({
    message: `--binary ${path} cannot be read (${detail})`,
    suggestion: 'Point `--binary` at a compiled Linux binary of the same Dockflow version.',
  }),
  localBinaryMissingArch: (arch: NodeArch): SetupProblem => ({
    message: `No local Dockflow binary for the ${arch} nodes`,
    suggestion: 'Build the CLI for every node architecture, or drop `--binary`/`--dev` to use the release binaries.',
  }),
} as const;

function stepError(problem: SetupProblem, logTail: string[] = []): SetupStepError {
  return new SetupStepError(problem.message, problem.suggestion, logTail);
}

// ---------------------------------------------------------------------------
// Verified downloads (5.1)
// ---------------------------------------------------------------------------

/** A pinned artefact and the words its messages use (`k3s v1.36.4+k3s1`, `Helm v4.3.0`). */
export interface PinnedComponent {
  component: string;
  version: string;
  url: string;
  sha256: string;
}

/** The one curl invocation of every download (K57c, m12): nothing else builds a curl argv. */
export function curlArgs(url: string, dest: string): string[] {
  return ['curl', ...CURL_FLAGS, '-o', dest, url];
}

/** `/var/cache/dockflow/sha256/<sha256>`: the file name is the expected digest */
export function downloadCachePath(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error(`Not a sha256 digest: ${sha256}`);
  return `${DOWNLOAD_CACHE_DIR}/${sha256}`;
}

function subjectOf(pin: PinnedComponent): string {
  return `${pin.component} ${pin.version}`;
}

/** `sha256sum -c --status -` with `<sha256>  <path>` on stdin (DESIGN-CORE 8.7) */
export async function verifyFile(runner: HostRunner, path: string, sha256: string): Promise<boolean> {
  const result = await runner.run(['sha256sum', '-c', '--status', '-'], {
    input: `${sha256}  ${path}\n`,
    timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
  });
  return result.exitCode === 0 && !result.timedOut;
}

/** first field of `sha256sum <path>`, null when it cannot be read */
export async function sha256OfFile(runner: HostRunner, path: string): Promise<string | null> {
  const result = await runner.run(['sha256sum', '--', path], { timeoutMs: SHORT_COMMAND_TIMEOUT_MS });
  if (result.exitCode !== 0) return null;
  const digest = result.stdout.trim().split(/\s+/)[0] ?? '';
  return SHA256.test(digest) ? digest : null;
}

/** `/var/cache/dockflow` and its `sha256` directory, root 0700 */
export async function ensureDownloadCache(runner: HostRunner, key: string): Promise<void> {
  for (const dir of [DOWNLOAD_CACHE_ROOT, DOWNLOAD_CACHE_DIR]) {
    const info = await runner.stat(dir);
    if (info !== null && info.type !== 'directory') throw stepError(installMessages.cacheFailed(key, `${dir} is not a directory`));
    if (info !== null && info.mode === DOWNLOAD_CACHE_DIR_MODE && info.uid === 0 && info.gid === 0) continue;
    await runner.mkdir(dir, { mode: DOWNLOAD_CACHE_DIR_MODE, uid: 0, gid: 0 });
  }
}

/**
 * `dest` verified against the pin: kept when it already verifies (`cached`), otherwise fetched to
 * `<dest>.part`, checked with `sha256sum -c` and renamed (`downloaded`). A cache entry that fails
 * verification is deleted and fetched again; a download that fails it is deleted and nothing is
 * installed.
 */
export async function download(
  runner: HostRunner,
  pin: PinnedComponent,
  dest: string,
  key: string,
): Promise<'cached' | 'downloaded'> {
  const existing = await runner.stat(dest);
  if (existing !== null) {
    if (existing.type === 'file' && (await verifyFile(runner, dest, pin.sha256))) return 'cached';
    await runner.remove(dest, { recursive: existing.type === 'directory' });
  }
  const tmp = `${dest}.part`;
  await runner.remove(tmp);
  const curl = await runner.run(curlArgs(pin.url, tmp), { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (curl.exitCode !== 0 || curl.timedOut) {
    await runner.remove(tmp);
    const detail = curl.timedOut ? 'timed out' : firstLineOf(curl.stderr) || `curl exit ${curl.exitCode}`;
    throw stepError(installMessages.downloadFailed(subjectOf(pin), key, detail));
  }
  if (!(await verifyFile(runner, tmp, pin.sha256))) {
    const actual = (await sha256OfFile(runner, tmp)) ?? 'an unreadable file';
    await runner.remove(tmp);
    throw stepError(installMessages.verificationFailed(subjectOf(pin), key, pin.sha256, actual));
  }
  await runner.rename(tmp, dest);
  await runner.chmod(dest, DOWNLOAD_CACHE_FILE_MODE);
  return 'downloaded';
}

/** download() into the content-addressed cache; returns the cache path */
export async function downloadToCache(
  runner: HostRunner,
  pin: PinnedComponent,
  key: string,
): Promise<{ path: string; outcome: 'cached' | 'downloaded' }> {
  await ensureDownloadCache(runner, key);
  const path = downloadCachePath(pin.sha256);
  return { path, outcome: await download(runner, pin, path, key) };
}

/**
 * After a successful install: cache entries whose digest is not a current pin are removed, so an
 * upgrade leaves no stale binaries behind (5.1). Returns the removed names.
 */
export async function pruneDownloadCache(runner: HostRunner, keep: readonly string[]): Promise<string[]> {
  const names = (await runner.readDir(DOWNLOAD_CACHE_DIR)) ?? [];
  const wanted = new Set(keep);
  const removed: string[] = [];
  for (const name of [...names].sort()) {
    if (wanted.has(name)) continue;
    await runner.remove(`${DOWNLOAD_CACHE_DIR}/${name}`, { recursive: true });
    removed.push(name);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// k3s binary and install.sh (4.4, 5.2)
// ---------------------------------------------------------------------------

export function k3sBinaryComponent(version: string, pin: { url: string; sha256: string }): PinnedComponent {
  return { component: 'k3s', version, url: pin.url, sha256: pin.sha256 };
}

export function installScriptComponent(version: string, pin: { url: string; sha256: string }): PinnedComponent {
  return { component: 'the k3s install script', version, url: pin.url, sha256: pin.sha256 };
}

/**
 * `install -o root -g root -m 0755 <cache>/<sha256> /usr/local/bin/k3s`, only when the installed
 * binary differs. The cache entry is verified again right before (download() re-fetches it when it
 * does not verify), so nothing unverified is ever installed.
 */
export async function installK3sBinary(
  runner: HostRunner,
  pin: PinnedComponent,
  key: string,
): Promise<'installed' | 'unchanged'> {
  if ((await sha256OfFile(runner, K3S_BINARY)) === pin.sha256) return 'unchanged';
  const { path } = await downloadToCache(runner, pin, key);
  await runChecked(runner, ['install', '-o', 'root', '-g', 'root', '-m', K3S_BINARY_MODE, path, K3S_BINARY], {
    message: (detail) => installMessages.binaryInstallFailed(key, detail).message,
    suggestion: installMessages.binaryInstallFailed(key, '').suggestion,
  });
  return 'installed';
}

/**
 * The whole environment install.sh adds to PATH/LANG (4.4): the binary is already verified and
 * installed (`binary` still allows the SELinux RPM, F2), Dockflow starts the unit itself (F4), and
 * no K3S_* variable is ever set (F5 would persist it into the unit's env file).
 */
export function installScriptEnv(role: K3sNodeRole, version: string): Record<string, string> {
  return {
    PATH: HOST_CHILD_ENV.PATH,
    INSTALL_K3S_SKIP_DOWNLOAD: 'binary',
    INSTALL_K3S_VERSION: version,
    INSTALL_K3S_EXEC: role === 'agent' ? 'agent' : 'server',
    INSTALL_K3S_SKIP_START: 'true',
  };
}

/** `sh <cache>/<install.sh sha256>`, output captured; a failure carries the redacted tail (all of it with --debug). */
export async function runInstallScript(
  runner: HostRunner,
  pin: PinnedComponent,
  role: K3sNodeRole,
  key: string,
  options: { redactor?: Redactor; debug?: boolean } = {},
): Promise<void> {
  const { path } = await downloadToCache(runner, pin, key);
  const result = await runner.run(['sh', path], {
    env: installScriptEnv(role, pin.version),
    timeoutMs: INSTALL_SCRIPT_TIMEOUT_MS,
  });
  if (result.exitCode === 0 && !result.timedOut) return;
  const redactor = options.redactor ?? new Redactor();
  const output = redactor.redact(`${result.stdout}\n${result.stderr}`);
  const tail = options.debug ? lastLines(output, Number.MAX_SAFE_INTEGER) : lastLines(output, INSTALL_SCRIPT_LOG_LINES);
  throw stepError(installMessages.installScriptFailed(key, result.exitCode), tail);
}

// ---------------------------------------------------------------------------
// Waiting for the service (4.4.1)
// ---------------------------------------------------------------------------

export interface ServiceState {
  activeState: string;
  subState: string;
  restarts: number;
}

/** `systemctl show -p ActiveState,SubState,NRestarts` output */
export function parseSystemctlShow(stdout: string): ServiceState {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const restarts = Number(values.get('NRestarts') ?? '0');
  return {
    activeState: values.get('ActiveState') || 'unknown',
    subState: values.get('SubState') || 'unknown',
    restarts: Number.isFinite(restarts) ? restarts : 0,
  };
}

export function k3sUnitFor(role: K3sNodeRole): 'k3s' | 'k3s-agent' {
  return role === 'agent' ? 'k3s-agent' : 'k3s';
}

export interface ServiceWaitOptions {
  key: string;
  role: K3sNodeRole;
  /** agents: the server they join, named in the suggestion */
  joinUrl: string | null;
  redactor?: Redactor;
  /** default 300 s for servers, 180 s for agents */
  timeoutS?: number;
}

/**
 * Polls the unit every 2 s until it is active/running and, on servers, `/readyz` answers `ok`.
 * Fails early after 3 restarts, at the deadline, or after more consecutive unreadable probes than
 * K8S_TRANSPORT_FAILURES_TOLERATED; the failure carries the redacted journal tail.
 */
export async function waitForService(runner: HostRunner, clock: Clock, options: ServiceWaitOptions): Promise<void> {
  const unit = k3sUnitFor(options.role);
  const server = options.role !== 'agent';
  const timeoutS = options.timeoutS ?? (server ? K3S_SERVER_START_TIMEOUT_S : K3S_AGENT_START_TIMEOUT_S);
  const redactor = options.redactor ?? new Redactor();
  const kube = hostKubeExecutor(runner, options.key, { redactor });
  const deadline = clock.now().getTime() + timeoutS * 1000;
  let state: ServiceState = { activeState: 'unknown', subState: 'unknown', restarts: 0 };
  let unreadable = 0;

  const fail = async (message: string): Promise<never> => {
    const journal = await runner.run(['journalctl', '-u', unit, '-n', String(SERVICE_JOURNAL_LINES), '--no-pager', '-o', 'cat'], {
      timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
    });
    const tail = lastLines(redactor.redact(journal.stdout), SERVICE_JOURNAL_LINES);
    throw new SetupStepError(message, installMessages.serviceSuggestion(options.key, unit, options.joinUrl), tail);
  };

  for (;;) {
    const shown = await runner.run(['systemctl', 'show', unit, '-p', 'ActiveState,SubState,NRestarts'], {
      timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
    });
    if (shown.exitCode !== 0 || shown.timedOut) {
      unreadable += 1;
      if (unreadable > K8S_TRANSPORT_FAILURES_TOLERATED) {
        const detail = shown.timedOut ? 'timed out' : redactor.redact(firstLineOf(shown.stderr)) || `exit ${shown.exitCode}`;
        await fail(installMessages.serviceUnreadable(options.key, unit, detail));
      }
    } else {
      unreadable = 0;
      state = parseSystemctlShow(shown.stdout);
      if (state.activeState === 'active' && state.subState === 'running' && (!server || (await readyz(kube)))) return;
      if (state.restarts >= SERVICE_MAX_RESTARTS) await fail(installMessages.serviceRestarting(options.key, state));
    }
    if (clock.now().getTime() >= deadline) await fail(installMessages.serviceTimeout(options.key, timeoutS, state));
    await clock.sleep(SERVICE_POLL_MS);
  }
}

/** GET /readyz with the admin kubeconfig; a starting API server answers nothing or `[-]...` */
async function readyz(kube: KubeExecutor): Promise<boolean> {
  try {
    const result = await kube.run({
      args: ['get', '--raw=/readyz'],
      mutating: false,
      requestTimeoutS: READYZ_TIMEOUT_S,
      allowFailure: true,
    });
    return result.exitCode === 0 && result.stdout.trim() === 'ok';
  } catch (error) {
    if (error instanceof KubeError) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Architecture (3.3)
// ---------------------------------------------------------------------------

/** `uname -m` -> the pinned architecture; null for anything else (armv7l, i686, ...) */
export function archFromMachine(machine: string): NodeArch | null {
  const value = machine.trim();
  if (value === 'x86_64' || value === 'amd64') return 'amd64';
  if (value === 'aarch64' || value === 'arm64') return 'arm64';
  return null;
}

/** the node's architecture, or the refusal of 3.3 */
export async function nodeArch(runner: HostRunner, key: string): Promise<NodeArch> {
  const machine = await runner.machine();
  const arch = archFromMachine(machine);
  if (arch === null) throw stepError(installMessages.unsupportedArch(machine, key));
  return arch;
}

// ---------------------------------------------------------------------------
// The Dockflow binary delivered to the nodes (3.3, K57c)
// ---------------------------------------------------------------------------

export type NodeBinary =
  /** --binary / --dev: uploaded by the coordinator, hashed locally */
  | { mode: 'upload'; path: string; sha256: string }
  /** release asset, hash from the release's SHA256SUMS */
  | { mode: 'download'; url: string; sha256: string; asset: string };

/** release asset names published by the CLI workflow */
export function nodeBinaryAsset(arch: NodeArch): string {
  return arch === 'amd64' ? 'dockflow-linux-x64' : 'dockflow-linux-arm64';
}

/** `<sha256>  <asset>` (or ` *<asset>`) lines; anything else is ignored */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export interface NodeBinaryRequest {
  /** `--binary <path>` for every architecture, or the binaries `--dev` built per architecture */
  localBinaries: Partial<Record<NodeArch, string>> | null;
  /** architectures of the nodes (from `uname -m`) */
  arches: readonly NodeArch[];
  /** number of nodes the binary runs on, for the refusal text */
  nodeCount: number;
  /** default DOCKFLOW_VERSION */
  version?: string;
  /** default DOCKFLOW_RELEASE_URL */
  releaseUrl?: string;
}

export interface NodeBinaryDeps {
  /** HTTPS GET; null when the file does not exist (404) */
  fetchText(url: string): Promise<string | null>;
  readLocalFile(path: string): Uint8Array;
}

const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

async function fetchTextOverHttps(url: string): Promise<string | null> {
  let last = '';
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
      if (!response.url.startsWith('https://')) throw new Error(`redirected to ${response.url}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(last);
}

export const defaultNodeBinaryDeps: NodeBinaryDeps = {
  fetchText: fetchTextOverHttps,
  readLocalFile: (path) => readFileSync(path),
};

/** `.../releases/download/<v>/SHA256SUMS`, next to the release binaries */
export function sha256SumsUrl(releaseUrl: string, version: string): string {
  return buildBinaryDownloadUrl(releaseUrl, version, 'SHA256SUMS');
}

/**
 * The binary each node architecture runs and the hash the node verifies before making it
 * executable (3.3). Runs on the coordinator before any SSH connection: a release without
 * `SHA256SUMS`, or without an entry for a needed asset, is refused, never downloaded unverified.
 */
export async function resolveNodeBinary(
  request: NodeBinaryRequest,
  deps: NodeBinaryDeps = defaultNodeBinaryDeps,
): Promise<Partial<Record<NodeArch, NodeBinary>>> {
  const version = request.version ?? DOCKFLOW_VERSION;
  const arches = [...new Set(request.arches)].sort();
  const resolved: Partial<Record<NodeArch, NodeBinary>> = {};
  if (request.localBinaries !== null) {
    const hashes = new Map<string, string>();
    for (const arch of arches) {
      const path = request.localBinaries[arch];
      if (path === undefined) {
        const problem = installMessages.localBinaryMissingArch(arch);
        throw new ValidationError(problem.message, problem.suggestion);
      }
      let sha256 = hashes.get(path);
      if (sha256 === undefined) {
        let bytes: Uint8Array;
        try {
          bytes = deps.readLocalFile(path);
        } catch (error) {
          const problem = installMessages.localBinaryUnreadable(path, error instanceof Error ? error.message : String(error));
          throw new ValidationError(problem.message, problem.suggestion);
        }
        sha256 = sha256Hex(bytes);
        hashes.set(path, sha256);
      }
      resolved[arch] = { mode: 'upload', path, sha256 };
    }
    return resolved;
  }

  const releaseUrl = request.releaseUrl ?? DOCKFLOW_RELEASE_URL;
  let text: string | null;
  try {
    text = await deps.fetchText(sha256SumsUrl(releaseUrl, version));
  } catch (error) {
    const problem = installMessages.sha256SumsUnreachable(version, error instanceof Error ? error.message : String(error));
    throw new CLIError(problem.message, ErrorCode.COMMAND_FAILED, problem.suggestion);
  }
  const sums = text === null ? new Map<string, string>() : parseSha256Sums(text);
  if (sums.size === 0) {
    const problem = installMessages.noSha256Sums(version, request.nodeCount, null);
    throw new CLIError(problem.message, ErrorCode.COMMAND_FAILED, problem.suggestion);
  }
  for (const arch of arches) {
    const asset = nodeBinaryAsset(arch);
    const sha256 = sums.get(asset);
    if (sha256 === undefined) {
      const problem = installMessages.noSha256Sums(version, request.nodeCount, asset);
      throw new CLIError(problem.message, ErrorCode.COMMAND_FAILED, problem.suggestion);
    }
    resolved[arch] = { mode: 'download', url: buildBinaryDownloadUrl(releaseUrl, version, asset), sha256, asset };
  }
  return resolved;
}

/** exit codes of the delivery script, read by parseDeliveryFailure */
export const DELIVERY_DOWNLOAD_FAILED = 90;
export const DELIVERY_VERIFICATION_FAILED = 91;

/**
 * One POSIX sh line run by the bootstrap user in its private `mktemp -d` directory (3.3): the
 * release binary is fetched with curlArgs (uploads land in `<dir>/dockflow.part` beforehand), then
 * `sha256sum -c` with the hash the coordinator resolved, and only then `chmod 0700` and `mv`. A
 * failed check removes the part file: no executable is left behind. Every value is shellQuote()d.
 */
export function nodeBinaryDeliveryScript(dir: string, binary: NodeBinary): string {
  const part = shellQuote(`${dir}/dockflow.part`);
  const final = shellQuote(`${dir}/dockflow`);
  const lines: string[] = [];
  if (binary.mode === 'download') {
    const curl = curlArgs(binary.url, `${dir}/dockflow.part`).map(shellQuote).join(' ');
    lines.push(`${curl} || { rm -f -- ${part}; exit ${DELIVERY_DOWNLOAD_FAILED}; }`);
  }
  lines.push(
    `if printf '%s  %s\\n' ${shellQuote(binary.sha256)} ${part} | sha256sum -c --status -; ` +
      `then chmod 0700 ${part} && mv -f ${part} ${final}; ` +
      `else actual=$(sha256sum ${part} 2>/dev/null); rm -f -- ${part}; printf 'actual %s\\n' "\${actual%% *}" >&2; exit ${DELIVERY_VERIFICATION_FAILED}; fi`,
  );
  return lines.join('; ');
}

/** The message of a failed delivery script (3.3 table). */
export function parseDeliveryFailure(
  result: { exitCode: number; stderr: string },
  context: { key: string; binary: NodeBinary; version?: string },
): SetupProblem {
  const version = context.version ?? DOCKFLOW_VERSION;
  if (result.exitCode === DELIVERY_DOWNLOAD_FAILED) {
    return installMessages.binaryDownloadFailed(version, context.key, firstLineOf(result.stderr) || 'curl failed');
  }
  if (result.exitCode === DELIVERY_VERIFICATION_FAILED) {
    const actual = /^actual (\S+)/m.exec(result.stderr)?.[1] ?? 'an unreadable file';
    const subject = context.binary.mode === 'upload' ? context.binary.path : `Dockflow ${version}`;
    return installMessages.verificationFailed(subject, context.key, context.binary.sha256, actual);
  }
  return installMessages.binaryDeliveryFailed(context.key, firstLineOf(result.stderr) || `exit ${result.exitCode}`);
}
