// Helm on k3s servers and the pinned Traefik chart (design-05 5.3, 5.4): Helm comes from the pinned
// archive in the verified cache, is installed to /usr/local/lib/dockflow/bin/helm and checked with
// `helm version`; the chart archive lands, verified, in the deploy user's content-addressed chart
// cache so the proxy backend never needs the chart repository at deploy time.

import { HELM_BIN_PATH, HELM_CHARTS_DIR, HELM_HOME_DIR } from '../../../services/orchestrator/kubernetes/constants';
import { TRAEFIK_CHART_PIN, type TraefikChartPin } from '../../../services/orchestrator/kubernetes/versions';
import { HELM_BIN_DIR } from './constants';
import { firstLineOf, type HostRunner, type HostUser, runChecked, SetupStepError } from './host-runner';
import { DOWNLOAD_CACHE_ROOT, downloadToCache, type PinnedComponent, verifyFile } from './install';
import type { SetupProblem } from './messages';
import type { DownloadPin, NodeArch } from './plan';

/** private extraction directory inside the root-only cache (5.3) */
export const HELM_EXTRACT_TEMPLATE = `${DOWNLOAD_CACHE_ROOT}/extract.XXXXXXXX`;
export const HELM_LIB_DIR = HELM_BIN_DIR.slice(0, HELM_BIN_DIR.lastIndexOf('/'));
export const HELM_BIN_MODE = '0755';
/** HELM_HOME_DIR and its subdirectories, deploy user 0700 (4.3) */
export const HELM_HOME_SUBDIRS: readonly string[] = ['cache', 'config', 'data', 'tmp', 'charts'];
export const HELM_HOME_MODE = 0o700;
export const CHART_FILE_MODE = '0600';
const HELM_VERSION_TIMEOUT_MS = 30_000;

export const helmMessages = {
  installFailed: (key: string, detail: string): SetupProblem => ({
    message: `Could not install Helm on ${key} (${detail})`,
    suggestion: `Check the free space and permissions of ${HELM_LIB_DIR} on ${key}, then run setup again.`,
  }),
  versionMismatch: (key: string, found: string, pin: string): SetupProblem => ({
    message: `Helm on ${key} reports ${found} after the install, expected ${pin}`,
    suggestion: `Remove ${HELM_BIN_PATH} on ${key} and run setup again; if it persists, report it.`,
  }),
  chartNotCached: (key: string, detail: string): SetupProblem => ({
    message: `The pinned Traefik chart could not be cached on ${key} (${detail})`,
    suggestion:
      'Deploys with `proxy.enabled` will download it themselves; re-run setup once the node can reach the chart repository.',
  }),
} as const;

export interface HelmPinInput {
  version: string;
  archive: DownloadPin;
}

export function helmComponent(pin: HelmPinInput): PinnedComponent {
  return { component: 'Helm', version: pin.version, url: pin.archive.url, sha256: pin.archive.sha256 };
}

/** `helm version --template '{{.Version}}'` of Dockflow's Helm, null when absent or broken */
export async function installedHelmVersion(runner: HostRunner): Promise<string | null> {
  const result = await runner.run([HELM_BIN_PATH, 'version', '--template', '{{.Version}}'], { timeoutMs: HELM_VERSION_TIMEOUT_MS });
  if (result.exitCode !== 0 || result.timedOut) return null;
  const version = result.stdout.trim();
  return version === '' ? null : version;
}

/**
 * Installs the pinned Helm unless it is already the installed version (H1): verified archive,
 * extraction of `linux-<arch>/helm` only into a private directory, `install` then `mv -f` so a
 * running Helm is never overwritten in place, and the version checked afterwards (H3).
 */
export async function installHelm(
  runner: HostRunner,
  pin: HelmPinInput,
  arch: NodeArch,
  key: string,
): Promise<{ outcome: 'installed' | 'unchanged'; version: string }> {
  if ((await installedHelmVersion(runner)) === pin.version) return { outcome: 'unchanged', version: pin.version };
  const { path: archive } = await downloadToCache(runner, helmComponent(pin), key);
  const failure = {
    message: (detail: string) => helmMessages.installFailed(key, detail).message,
    suggestion: helmMessages.installFailed(key, '').suggestion,
  };
  const dir = (await runChecked(runner, ['mktemp', '-d', HELM_EXTRACT_TEMPLATE], failure)).stdout.trim();
  if (dir === '' || !dir.startsWith(`${DOWNLOAD_CACHE_ROOT}/extract.`)) {
    throw new SetupStepError(failure.message(`mktemp returned ${JSON.stringify(dir)}`), failure.suggestion);
  }
  const member = `linux-${arch}/helm`;
  try {
    await runChecked(runner, ['tar', '-xzf', archive, '-C', dir, '--no-same-owner', '--no-same-permissions', member], failure);
    await runChecked(runner, ['install', '-d', '-o', 'root', '-g', 'root', '-m', HELM_BIN_MODE, HELM_LIB_DIR, HELM_BIN_DIR], failure);
    await runChecked(runner, ['install', '-o', 'root', '-g', 'root', '-m', HELM_BIN_MODE, `${dir}/${member}`, `${HELM_BIN_PATH}.new`], failure);
    await runChecked(runner, ['mv', '-f', `${HELM_BIN_PATH}.new`, HELM_BIN_PATH], failure);
  } finally {
    await runner.run(['rm', '-rf', '--', dir]);
  }
  const version = await installedHelmVersion(runner);
  if (version !== pin.version) {
    const problem = helmMessages.versionMismatch(key, version ?? 'no version', pin.version);
    throw new SetupStepError(problem.message, problem.suggestion);
  }
  return { outcome: 'installed', version };
}

/** HELM_HOME_DIR and its subdirectories, owned by the deploy user, 0700 (4.3) */
export async function ensureHelmDirectories(runner: HostRunner, user: HostUser): Promise<void> {
  for (const dir of [HELM_HOME_DIR, ...HELM_HOME_SUBDIRS.map((name) => `${HELM_HOME_DIR}/${name}`)]) {
    const info = await runner.stat(dir);
    if (info?.type === 'directory' && info.mode === HELM_HOME_MODE && info.uid === user.uid && info.gid === user.gid) continue;
    await runner.mkdir(dir, { mode: HELM_HOME_MODE, uid: user.uid, gid: user.gid });
  }
}

/** `HELM_CHARTS_DIR/sha256-<sha256>.tgz`: the path design-04's chart cache computes (2.9.1) */
export function traefikChartCachePath(sha256: string): string {
  return `${HELM_CHARTS_DIR}/sha256-${sha256}.tgz`;
}

export interface ChartCacheResult {
  outcome: 'installed' | 'unchanged' | 'warned';
  /** a failed chart download is a warning, never a node failure (5.4) */
  warning: SetupProblem | null;
}

/**
 * Puts the pinned Traefik chart into the deploy user's chart cache on a server (5.4): root cache
 * first, `install -o <u> -g <u> -m 0600`, then the installed copy verified again (Helm runs as the
 * deploy user). Every server gets it, whether or not the proxy is enabled today.
 */
export async function cacheTraefikChart(
  runner: HostRunner,
  options: { key: string; deployUser: string; pin?: TraefikChartPin },
): Promise<ChartCacheResult> {
  const pin = options.pin ?? TRAEFIK_CHART_PIN;
  const warn = (detail: string): ChartCacheResult => ({ outcome: 'warned', warning: helmMessages.chartNotCached(options.key, detail) });
  const user = await runner.lookupUser(options.deployUser);
  if (user === null) return warn(`the deploy user ${options.deployUser} does not exist`);
  const dest = traefikChartCachePath(pin.sha256);
  const current = await runner.stat(dest);
  if (
    current?.type === 'file' &&
    current.uid === user.uid &&
    current.gid === user.gid &&
    current.mode === Number.parseInt(CHART_FILE_MODE, 8) &&
    (await verifyFile(runner, dest, pin.sha256))
  ) {
    return { outcome: 'unchanged', warning: null };
  }
  let cached: string;
  try {
    cached = (await downloadToCache(runner, { component: 'Traefik chart', version: pin.version, url: pin.url, sha256: pin.sha256 }, options.key)).path;
  } catch (error) {
    if (error instanceof SetupStepError) return warn(error.message);
    throw error;
  }
  await ensureHelmDirectories(runner, user);
  const installed = await runner.run(['install', '-o', options.deployUser, '-g', options.deployUser, '-m', CHART_FILE_MODE, cached, dest]);
  if (installed.exitCode !== 0) return warn(firstLineOf(installed.stderr) || `install exited with ${installed.exitCode}`);
  if (!(await verifyFile(runner, dest, pin.sha256))) {
    await runner.remove(dest);
    return warn(`the copy in ${HELM_CHARTS_DIR} does not match sha256 ${pin.sha256}`);
  }
  return { outcome: 'installed', warning: null };
}
