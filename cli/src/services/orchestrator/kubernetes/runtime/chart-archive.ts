// Every chart Helm installs is a local .tgz whose sha256 is known (design-04 3.5.3, 2.9.1). A chart
// version is a name: an HTTP index and the archive behind it are mutable and an OCI tag can move, so
// the bytes are pinned instead. Archives live in a content-addressed cache under HELM_CHARTS_DIR,
// looked up first and re-verified on every use; a pull goes through a per-call directory that also
// holds the short-lived credentials, and is removed in `finally`.
//
// Errors: a failed pull, login or index update is classified and thrown as a CLIError; transport
// loss and guard expiry propagate as the executors' KubeError, which the backend maps.

import { ConfigError, DeployError, ErrorCode } from '../../../../utils/errors';
import type { HelmChartSource, HelmEventSink, ResolvedHelmRelease } from '../../interfaces';
import { M } from '../../messages';
import { HELM_CHARTS_DIR, K8S_PROXY_RELEASE, K8S_SYSTEM_NAMESPACE } from '../constants';
import type { TraefikChartPin } from '../versions';
import type { HelmEnvOverrides, HelmExecutor, HelmResult } from './helm';
import { type HelmCallContext, type HelmFailureReason, classifyHelmFailure, helmFailureDetail, helmErrorToCliError } from './helm-errors';
import { type HostCommands, hostCommands } from './host';
import type { NodeShell } from './node-shell';

/** `path` is `cachePath(sha256)`; `sha256` is 64 lowercase hex, the form of `HelmReleaseRecord.chartSha256` */
export interface ChartArchive {
  path: string;
  sha256: string;
}

export interface ChartArchiveDeps {
  helm: HelmExecutor;
  /** shell of the node the executor runs helm on: both see the same files */
  shell: NodeShell;
}

/** what a pull needs from a release; `auth` is used for the pull only, never for the upgrade */
export type ChartRequest = Pick<ResolvedHelmRelease, 'name' | 'namespace' | 'chart' | 'version' | 'auth'>;

export interface ChartArchiveOptions {
  /** `--allow-chart-drift`: a digest mismatch is a warning and the new bytes are cached and used */
  allowDrift: boolean;
  events?: HelmEventSink;
  /** a stored release is being restored: E-HELM-CHART-DIGEST carries ROLLBACK_FAILED */
  rollback?: boolean;
  env: string;
  /** `DistributionTraits.name`, for setup suggestions */
  distribution: string;
}

export const CHART_PULL_TIMEOUT_S = 120;
export const REGISTRY_LOGIN_TIMEOUT_S = 60;
/** alias of an authenticated repository in its per-call repositories file */
export const CHART_REPO_ALIAS = 'dockflow-repo';

const PLAIN_HTTP_REGISTRY = 'server gave HTTP response to HTTPS client';
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function chartCachePath(sha256: string): string {
  return `${HELM_CHARTS_DIR}/sha256-${sha256}.tgz`;
}

/** `registry.example.com:5000` of `oci://registry.example.com:5000/charts/search` */
export function ociRegistryHost(ref: string): string {
  return ref.replace(/^oci:\/\//, '').split('/')[0];
}

/** the repository URL, or the OCI registry host */
export function chartOrigin(chart: HelmChartSource): string {
  return chart.kind === 'repo' ? chart.repo : ociRegistryHost(chart.ref);
}

/** "postgresql 16.7.4 from https://charts.example.org", "oci://registry.example.com/charts/search 2.4.1" */
export function chartDisplayOf(chart: HelmChartSource, version: string): string {
  return chart.kind === 'repo' ? `${chart.chart} ${version} from ${chart.repo}` : `${chart.ref} ${version}`;
}

/** the name Helm gives the pulled file: the chart name, i.e. the last path segment without a tag */
function chartFileName(chart: HelmChartSource): string {
  const path = chart.kind === 'repo' ? chart.chart : chart.ref.replace(/^oci:\/\//, '');
  const last = path.split('/').at(-1) ?? path;
  return chart.kind === 'oci' ? last.split(/[:@]/)[0] : last;
}

/** Helm names the file after Chart.yaml's version, which a `v`-prefixed request may not carry */
export function pulledArchiveCandidates(dir: string, chart: HelmChartSource, version: string): string[] {
  const name = chartFileName(chart);
  const candidates = [`${dir}/${name}-${version}.tgz`];
  if (/^v\d/.test(version)) candidates.push(`${dir}/${name}-${version.slice(1)}.tgz`);
  return candidates;
}

/** exact per-call repositories file of an authenticated repository (design-04 3.5.3) */
export function repositoriesFile(repo: string, auth: { username: string; password: string }): string {
  return JSON.stringify({
    apiVersion: '',
    generated: '0001-01-01T00:00:00Z',
    repositories: [{ name: CHART_REPO_ALIAS, url: repo, username: auth.username, password: auth.password }],
  });
}

function assertSameNode(deps: ChartArchiveDeps): void {
  if (deps.shell.node.name !== deps.helm.node.name) {
    throw new Error(`The chart cache shell runs on ${deps.shell.node.name} but helm runs on ${deps.helm.node.name}`);
  }
}

// ---------------------------------------------------------------------------
// Shared flow
// ---------------------------------------------------------------------------

interface PullSpec {
  request: ChartRequest;
  display: string;
  env: string;
  distribution: string;
  /** decides what a pulled digest means: throws to refuse, returns to accept */
  verify(actual: string): void;
  /** maps a failed pull, login or index update */
  failure(operation: string, result: HelmResult): Error;
}

/** step 1: the cached archive when it still hashes to its name; a corrupt entry is deleted */
async function cachedArchive(host: HostCommands, expected: string): Promise<ChartArchive | null> {
  if (!SHA256_HEX.test(expected)) throw new Error(`A chart digest must be 64 lowercase hex characters, got ${expected}`);
  const path = chartCachePath(expected);
  const actual = await host.fileSha256(path);
  if (actual === expected) {
    await host.touchCachedChart(path);
    return { path, sha256: expected };
  }
  if (actual !== null) await host.removeCachedChart(path);
  return null;
}

interface PullArguments {
  ref: string;
  extra: string[];
  env: HelmEnvOverrides;
}

/** credentials are held for the pull only: a per-call repositories file or registry config */
async function preparePull(deps: ChartArchiveDeps, host: HostCommands, tmp: string, spec: PullSpec): Promise<PullArguments> {
  const { chart, auth } = spec.request;
  if (chart.kind === 'repo') {
    if (auth === null) return { ref: chart.chart, extra: ['--repo', chart.repo], env: {} };
    // with --repo Helm only takes --username/--password, which would put the password in argv
    const repositoryConfig = `${tmp}/repositories.yaml`;
    const env: HelmEnvOverrides = { repositoryConfig, repositoryCache: `${tmp}/cache` };
    await host.writeSecretFile(repositoryConfig, repositoriesFile(chart.repo, auth));
    const update = await deps.helm.run({
      args: ['repo', 'update', CHART_REPO_ALIAS],
      mutating: false,
      timeoutS: CHART_PULL_TIMEOUT_S,
      env,
      allowFailure: true,
    });
    if (update.exitCode !== 0) throw spec.failure('repo update', update);
    return { ref: `${CHART_REPO_ALIAS}/${chart.chart}`, extra: [], env };
  }
  if (auth === null) return { ref: chart.ref, extra: [], env: {} };
  const env: HelmEnvOverrides = { registryConfig: `${tmp}/registry.json` };
  const login = await deps.helm.run({
    args: ['registry', 'login', ociRegistryHost(chart.ref), '--username', auth.username, '--password-stdin'],
    stdin: auth.password,
    mutating: false,
    timeoutS: REGISTRY_LOGIN_TIMEOUT_S,
    env,
    allowFailure: true,
  });
  if (login.exitCode !== 0) throw spec.failure('registry login', login);
  return { ref: chart.ref, extra: [], env };
}

async function pulledArchive(host: HostCommands, tmp: string, spec: PullSpec): Promise<{ file: string; sha256: string }> {
  for (const file of pulledArchiveCandidates(tmp, spec.request.chart, spec.request.version)) {
    const sha256 = await host.fileSha256(file);
    if (sha256 !== null) return { file, sha256 };
  }
  throw new DeployError(
    `The chart archive of Helm release ${spec.request.name} (${spec.display}) was not found on ${host.node.name} after the pull`,
    ErrorCode.DEPLOY_FAILED,
    "Check that the name and version in the chart's Chart.yaml match `chart` and `version` in config.yml.",
  );
}

/** steps 2 to 7: pull into a call directory, hash, verify, move into the cache, remove the directory */
async function pullVerified(deps: ChartArchiveDeps, host: HostCommands, spec: PullSpec): Promise<ChartArchive> {
  const tmp = await host.helmTempDir();
  let failed = false;
  try {
    const pull = await preparePull(deps, host, tmp, spec);
    const result = await deps.helm.run({
      args: ['pull', pull.ref, ...pull.extra, '--version', spec.request.version, '--destination', tmp],
      mutating: false,
      timeoutS: CHART_PULL_TIMEOUT_S,
      env: pull.env,
      allowFailure: true,
    });
    if (result.exitCode !== 0) throw spec.failure('pull', result);
    const { file, sha256 } = await pulledArchive(host, tmp, spec);
    spec.verify(sha256);
    const path = chartCachePath(sha256);
    await host.installFile(file, path);
    return { path, sha256 };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // a cleanup failure never hides the error that brought us here
    await host.removeTempDir(tmp).catch((cleanup: unknown) => {
      if (!failed) throw cleanup;
    });
  }
}

/**
 * A pull never talks to the cluster: a timeout, an unreachable address or a TLS error while
 * downloading means the repository could not be reached, whatever the kubectl classifier would say.
 */
function pullReason(result: HelmResult): HelmFailureReason {
  const reason = classifyHelmFailure(result.exitCode, result.stderr);
  const network: HelmFailureReason[] = ['Timeout', 'NotReady', 'CertificateMismatch', 'Unreachable'];
  return network.includes(reason) ? 'RepoUnreachable' : reason;
}

function pullFailure(spec: Omit<PullSpec, 'failure' | 'verify'>, node: string, operation: string, result: HelmResult): Error {
  const { request } = spec;
  if (request.chart.kind === 'oci' && result.stderr.includes(PLAIN_HTTP_REGISTRY)) {
    return new ConfigError(M.helmOciPlainHttp(request.chart.ref));
  }
  const context: HelmCallContext = {
    env: spec.env,
    operation,
    release: request.name,
    namespace: request.namespace,
    node,
    mutating: false,
    chart: spec.display,
    timeoutS: operation === 'registry login' ? REGISTRY_LOGIN_TIMEOUT_S : CHART_PULL_TIMEOUT_S,
    distribution: spec.distribution,
    repository: chartOrigin(request.chart),
  };
  return helmErrorToCliError(pullReason(result), {
    ...context,
    detail: helmFailureDetail(result.stderr),
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The verified local archive of a release's chart. `expected` is `release.declaredDigest`: the
 * `digest:` of config.yml, the digest `pinCharts` fixed, or a stored record's `chartSha256`; null
 * only for an accessory release without `digest:`, and then whatever was pulled is what runs.
 */
export async function resolveChartArchive(
  deps: ChartArchiveDeps,
  release: ChartRequest,
  expected: string | null,
  options: ChartArchiveOptions,
): Promise<ChartArchive> {
  assertSameNode(deps);
  const host = hostCommands(deps.shell);
  if (expected !== null) {
    const cached = await cachedArchive(host, expected);
    if (cached) return cached;
  }
  const display = chartDisplayOf(release.chart, release.version);
  const base = { request: release, display, env: options.env, distribution: options.distribution };
  return pullVerified(deps, host, {
    ...base,
    verify(actual) {
      if (expected === null || actual === expected) return;
      if (options.allowDrift) {
        options.events?.warn(
          `The chart of Helm release ${release.name} has digest ${actual} instead of the recorded ${expected}, and \`--allow-chart-drift\` was given`,
          'Record the new digest in `config.yml` once you trust it.',
        );
        return;
      }
      throw new DeployError(
        `The chart of Helm release ${release.name} (${display}) no longer matches the bytes it was pinned to: sha256 ${actual} instead of ${expected}`,
        options.rollback ? ErrorCode.ROLLBACK_FAILED : ErrorCode.VALIDATION_FAILED,
        `Check the chart repository; if the new content is trusted, set \`digest: ${actual}\` in config.yml, or re-run with \`--allow-chart-drift\` to install the current bytes.`,
      );
    },
    failure: (operation, result) => pullFailure(base, deps.helm.node.name, operation, result),
  });
}

/**
 * The pinned Traefik chart (2.9.1). Setup already placed it in the cache, so the deploy path
 * normally makes no network call; the pull is the fallback for a node whose setup could not.
 */
export async function resolveTraefikChartArchive(
  deps: ChartArchiveDeps,
  pin: TraefikChartPin,
  context: { env: string; distribution: string },
): Promise<ChartArchive> {
  assertSameNode(deps);
  const host = hostCommands(deps.shell);
  const cached = await cachedArchive(host, pin.sha256);
  if (cached) return cached;
  const node = deps.helm.node.name;
  const source = new URL(pin.repo).host;
  const request: ChartRequest = {
    name: K8S_PROXY_RELEASE,
    namespace: K8S_SYSTEM_NAMESPACE,
    chart: { kind: 'repo', repo: pin.repo, chart: pin.chart },
    version: pin.version,
    auth: null,
  };
  const base = { request, display: chartDisplayOf(request.chart, pin.version), ...context };
  return pullVerified(deps, host, {
    ...base,
    verify(actual) {
      if (actual === pin.sha256) return;
      throw new DeployError(
        `Traefik chart ${pin.version} failed verification on ${node}: expected sha256 ${pin.sha256}, got ${actual}, and nothing was installed`,
        ErrorCode.DEPLOY_FAILED,
        `Check for a proxy or mirror rewriting downloads from ${source}, then deploy again.`,
      );
    },
    failure(operation, result) {
      if (pullReason(result) !== 'RepoUnreachable') return pullFailure(base, node, operation, result);
      return new DeployError(
        `${node} cannot download the Traefik chart ${pin.version} from ${source} (${helmFailureDetail(result.stderr)})`,
        ErrorCode.DEPLOY_FAILED,
        `Re-run \`dockflow setup ${context.distribution} ${context.env}\`, which downloads and verifies the chart, or allow outbound HTTPS from that node.`,
      );
    },
  });
}
