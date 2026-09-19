// The few host commands Helm support needs besides helm itself (design-04 3.5.2): per-call temp
// directories, credential files written from stdin, sha256 of archives, the chart cache and the
// listener scan. Builders and parsers are pure; `hostCommands` runs them through a NodeShell, which
// never retries, so reads are retried here once on a lost transport and never on a non-zero exit.

import { shellQuote } from '../../../../utils/ssh';
import type { ClusterNodeRef } from '../../interfaces';
import { HELM_CHART_CACHE_DAYS, HELM_CHARTS_DIR, HELM_TMP_DIR, K8S_GUARD_MARGIN_S, K8S_REQUEST_TIMEOUT_S } from '../constants';
import { TRAEFIK_CHART_PIN } from '../versions';
import { classifyKubectlFailure, KubeError, NO_EXIT_CODE } from './errors';
import { firstLine, type KubectlResult } from './kubectl';
import type { NodeShell } from './node-shell';

/** local guard of every host command */
export const HOST_COMMAND_GUARD_S = K8S_REQUEST_TIMEOUT_S + K8S_GUARD_MARGIN_S;

/** call directories left behind by a killed CLI are swept after a day */
export const HELM_TMP_MAX_AGE_MIN = 24 * 60;

export const LISTENING_PORTS_COMMAND = 'ss -Hltn';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CALL_DIR = `${escapeRegExp(HELM_TMP_DIR)}/call\\.[A-Za-z0-9]{10}`;
const CALL_DIR_PATTERN = new RegExp(`^${CALL_DIR}$`);
/** a direct child of a call directory: credential files, the repository cache */
const CALL_FILE_PATTERN = new RegExp(`^${CALL_DIR}/[A-Za-z0-9][A-Za-z0-9._+-]*$`);
const CACHED_CHART_PATTERN = new RegExp(`^${escapeRegExp(HELM_CHARTS_DIR)}/sha256-[0-9a-f]{64}\\.tgz$`);
const SHA256_PREFIX = /^\\?([0-9a-f]{64})/;

export function isHelmCallDir(path: string): boolean {
  return CALL_DIR_PATTERN.test(path);
}

export function isHelmCallFile(path: string): boolean {
  return CALL_FILE_PATTERN.test(path);
}

function refuse(what: string, path: string, rule: string): never {
  throw new Error(`${what} refused ${path}: ${rule}`);
}

function assertAbsolute(what: string, path: string): void {
  if (!path.startsWith('/') || path.split('/').includes('..')) refuse(what, path, 'not an absolute path without ..');
}

// ---------------------------------------------------------------------------
// Builders (pure)
// ---------------------------------------------------------------------------

/**
 * Creates a per-call directory and sweeps leftovers on the way: call directories older than a day
 * and chart archives unused for HELM_CHART_CACHE_DAYS, never the pinned Traefik chart, which setup
 * placed there so that an unchanged proxy never needs the network.
 */
export function helmTempDirCommand(): string {
  const pinned = `sha256-${TRAEFIK_CHART_PIN.sha256}.tgz`;
  return [
    'umask 077',
    `mkdir -p ${HELM_TMP_DIR}`,
    `{ find ${HELM_TMP_DIR} -mindepth 1 -maxdepth 1 -mmin +${HELM_TMP_MAX_AGE_MIN} -exec rm -rf -- {} + 2>/dev/null || true; }`,
    `{ find ${HELM_CHARTS_DIR} -mindepth 1 -maxdepth 1 -name 'sha256-*.tgz' ! -name '${pinned}' -mtime +${HELM_CHART_CACHE_DAYS} -delete 2>/dev/null || true; }`,
    `mktemp -d ${HELM_TMP_DIR}/call.XXXXXXXXXX`,
  ].join(' && ');
}

/** the content travels on stdin; the file is 0600 inside a 0700 call directory */
export function writeSecretFileCommand(path: string): string {
  if (!isHelmCallFile(path)) refuse('writeSecretFile', path, `not a file directly inside ${HELM_TMP_DIR}/call.*`);
  return `umask 077 && cat > ${shellQuote(path)}`;
}

export function removeTempDirCommand(path: string): string {
  if (!isHelmCallDir(path)) refuse('removeTempDir', path, `not a directory created by mktemp -d ${HELM_TMP_DIR}/call.XXXXXXXXXX`);
  return `rm -rf -- ${shellQuote(path)}`;
}

export function fileSha256Command(path: string): string {
  assertAbsolute('fileSha256', path);
  return `sha256sum -- ${shellQuote(path)} 2>/dev/null`;
}

/** moves a verified archive out of its call directory into the content-addressed cache */
export function installFileCommand(src: string, dest: string): string {
  if (!isHelmCallFile(src)) refuse('installFile', src, `not a file directly inside ${HELM_TMP_DIR}/call.*`);
  if (!CACHED_CHART_PATTERN.test(dest)) refuse('installFile', dest, `not ${HELM_CHARTS_DIR}/sha256-<64 hex>.tgz`);
  const dir = dest.slice(0, dest.lastIndexOf('/'));
  return `mkdir -p -m 0700 ${shellQuote(dir)} && mv -f -- ${shellQuote(src)} ${shellQuote(dest)}`;
}

/** a reused archive is touched so the cache sweep never ages it out */
export function touchCachedChartCommand(path: string): string {
  if (!CACHED_CHART_PATTERN.test(path)) refuse('touchCachedChart', path, `not ${HELM_CHARTS_DIR}/sha256-<64 hex>.tgz`);
  return `touch -c -- ${shellQuote(path)}`;
}

/** a cache entry whose bytes no longer hash to its name */
export function removeCachedChartCommand(path: string): string {
  if (!CACHED_CHART_PATTERN.test(path)) refuse('removeCachedChart', path, `not ${HELM_CHARTS_DIR}/sha256-<64 hex>.tgz`);
  return `rm -f -- ${shellQuote(path)}`;
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

/** the directory mktemp printed; null when the output is not one */
export function parseTempDir(stdout: string): string | null {
  const path = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  return isHelmCallDir(path) ? path : null;
}

/** first 64 hex characters of `sha256sum` output; null on a non-zero exit (missing file) */
export function parseSha256(result: KubectlResult): string | null {
  if (result.exitCode !== 0) return null;
  return SHA256_PREFIX.exec(result.stdout.trim())?.[1] ?? null;
}

export interface Listener {
  /** host part of the local address, brackets removed (`0.0.0.0`, `::`, `*`, `127.0.0.53%lo`) */
  address: string;
  port: number;
  /** the local address column as ss printed it */
  local: string;
}

/** `ss -Hltn` lines: state, Recv-Q, Send-Q, local `addr:port`, peer `addr:port` */
export function parseListeningPorts(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const local = columns[3];
    const colon = local.lastIndexOf(':');
    if (colon <= 0) continue;
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    let address = local.slice(0, colon);
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    listeners.push({ address, port, local });
  }
  return listeners;
}

/** listeners on any of `ports`, whatever the address they are bound to */
export function listenersOn(listeners: readonly Listener[], ports: readonly number[]): Listener[] {
  return listeners.filter((listener) => ports.includes(listener.port));
}

// ---------------------------------------------------------------------------
// Execution through a NodeShell
// ---------------------------------------------------------------------------

export interface HostCommands {
  readonly node: ClusterNodeRef;
  /** a fresh `<HELM_TMP_DIR>/call.XXXXXXXXXX`, after sweeping stale call directories and charts */
  helmTempDir(): Promise<string>;
  writeSecretFile(path: string, content: string): Promise<void>;
  /** always called in `finally` by whoever created the directory */
  removeTempDir(path: string): Promise<void>;
  /** null when the file does not exist */
  fileSha256(path: string): Promise<string | null>;
  installFile(src: string, dest: string): Promise<void>;
  touchCachedChart(path: string): Promise<void>;
  removeCachedChart(path: string): Promise<void>;
  /** null when `ss` is not installed (unknown, not "no listener") */
  listeningPorts(): Promise<Listener[] | null>;
}

function isTransportLoss(error: unknown): boolean {
  return error instanceof KubeError && error.reason === 'Unreachable' && error.exitCode === NO_EXIT_CODE;
}

function failure(node: ClusterNodeRef, what: string, result: KubectlResult): KubeError {
  const line = firstLine(result.stderr);
  return new KubeError(
    classifyKubectlFailure(result.exitCode, result.stderr),
    `${what} failed on ${node.name} (exit ${result.exitCode})${line ? `: ${line}` : ''}`,
    node.name,
    result.exitCode,
    result.stderr,
  );
}

class NodeHostCommands implements HostCommands {
  constructor(private readonly shell: NodeShell) {}

  get node(): ClusterNodeRef {
    return this.shell.node;
  }

  async helmTempDir(): Promise<string> {
    const result = await this.write('Creating a Helm temporary directory', helmTempDirCommand());
    const path = parseTempDir(result.stdout);
    if (path === null) {
      throw new KubeError('Unknown', `mktemp did not print a Helm call directory on ${this.node.name}`, this.node.name, 0, '');
    }
    return path;
  }

  async writeSecretFile(path: string, content: string): Promise<void> {
    await this.write('Writing a Helm credentials file', writeSecretFileCommand(path), content);
  }

  async removeTempDir(path: string): Promise<void> {
    await this.write('Removing a Helm temporary directory', removeTempDirCommand(path));
  }

  async fileSha256(path: string): Promise<string | null> {
    return parseSha256(await this.read(fileSha256Command(path)));
  }

  async installFile(src: string, dest: string): Promise<void> {
    await this.write('Storing a chart archive', installFileCommand(src, dest));
  }

  async touchCachedChart(path: string): Promise<void> {
    await this.write('Touching a cached chart archive', touchCachedChartCommand(path));
  }

  async removeCachedChart(path: string): Promise<void> {
    await this.write('Removing a corrupt chart archive', removeCachedChartCommand(path));
  }

  async listeningPorts(): Promise<Listener[] | null> {
    const result = await this.read(LISTENING_PORTS_COMMAND);
    if (result.exitCode === 127) return null;
    if (result.exitCode !== 0) throw failure(this.node, 'Listing listening ports', result);
    return parseListeningPorts(result.stdout);
  }

  private async write(what: string, script: string, stdin?: string): Promise<KubectlResult> {
    const result = await this.shell.run(script, { stdin, guardS: HOST_COMMAND_GUARD_S });
    if (result.exitCode !== 0) throw failure(this.node, what, result);
    return result;
  }

  private async read(script: string): Promise<KubectlResult> {
    try {
      return await this.shell.run(script, { guardS: HOST_COMMAND_GUARD_S });
    } catch (error) {
      if (!isTransportLoss(error)) throw error;
      return this.shell.run(script, { guardS: HOST_COMMAND_GUARD_S });
    }
  }
}

export function hostCommands(shell: NodeShell): HostCommands {
  return new NodeHostCommands(shell);
}
