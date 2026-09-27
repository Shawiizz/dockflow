// Helm failure classification and its user-facing mapping (design-04 3.5.5). Stderr reaching this
// module is already redacted by the executor that produced it; stdout never reaches it.

import { CLIError, ConfigError, DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../../utils/errors';
import type { Redactor } from '../../../../utils/redact';
import { HELM_BIN_PATH } from '../constants';
import { classifyKubectlFailure, KubeError, type KubeErrorReason, kubeErrorToCliError, NO_EXIT_CODE } from './errors';
import { helmGuardS } from './helm';

export type HelmFailureReason =
  | 'Pending'
  | 'RolledBack'
  | 'UninstalledOnFailure'
  | 'NotReady'
  | 'Timeout'
  | 'Ownership'
  | 'ChartNotFound'
  | 'RepoUnreachable'
  | 'RepoAuth'
  | 'RenderError'
  | 'ValuesSchema'
  | 'ReleaseNotFound'
  | KubeErrorReason;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `env` quotes the path it could not run, `sh` does not */
const HELM_MISSING = new RegExp(`${escapeRegExp(HELM_BIN_PATH)}'?: (?:No such file or directory|not found)`);

/** one kstatus line of the watcher: `resource <kind>/<ns>/<name> not ready. status: <s>, message: <m>` */
const NOT_READY_LINE = /resource \S+ not ready\. status: .*/;

/** the API server is dialled on loopback or on its well-known port 6443; a chart repository is not */
const API_DIAL = /dial tcp (?:(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)[:\s]|(?:\[[0-9a-fA-F:.]+\]|[^\s:[]+):6443\b)/;

/** Helm's and client-go's own words for "the API server did not answer", lowercased: Helm 4 lowercased its own */
const CLUSTER_UNREACHABLE = ['kubernetes cluster unreachable', 'unable to connect to the server', 'the connection to the server'];

type Matcher = (exitCode: number, stderr: string) => boolean;

const has =
  (...needles: string[]): Matcher =>
  (_exitCode, stderr) =>
    needles.some((needle) => stderr.includes(needle));

const chartNotFound: Matcher = (_exitCode, stderr) =>
  (stderr.includes('not found in') && stderr.includes('repository')) ||
  stderr.includes('no chart version found') ||
  stderr.includes('no chart name found') ||
  // OCI `<registry>/<repo>:<tag>: not found`; `release: not found` is a missing release, not a chart
  (stderr.includes(': not found') && !stderr.includes('release: not found'));

// Cluster-side rejections use the same words as a registry: an admission webhook "denied the
// request", the API server answers "(Unauthorized)", an unreadable kubeconfig is "permission
// denied". A registry says `denied: <message>`. The others fall through to the kubectl classifier.
const repoAuth: Matcher = (_exitCode, stderr) => {
  const lower = stderr.toLowerCase();
  if (/\b40[13]\b/.test(stderr) || lower.includes('authentication required')) return true;
  if (lower.includes('unauthorized') && !lower.includes('(unauthorized)')) return true;
  return /(?:^|[\s:])denied: /m.test(lower);
};

const repoUnreachable: Matcher = (_exitCode, stderr) => {
  if (stderr.includes('is not a valid chart repository or cannot be reached')) return true;
  if (API_DIAL.test(stderr)) return false;
  return stderr.includes('no such host') || stderr.includes('dial tcp') || stderr.includes('i/o timeout');
};

// First match wins (design-04 3.5.5).
const RULES: { reason: HelmFailureReason; matches: Matcher }[] = [
  { reason: 'Pending', matches: has('another operation (install/upgrade/rollback) is in progress') },
  { reason: 'UninstalledOnFailure', matches: has('has been uninstalled due to rollback-on-failure') },
  { reason: 'RolledBack', matches: has('has been rolled back due to rollback-on-failure') },
  // a policy of the cluster refused an object, or its webhook could not be called: the `dial tcp`
  // or deadline of that call is neither the chart repository nor a readiness wait
  { reason: 'AdmissionDenied', matches: (exitCode, stderr) => classifyKubectlFailure(exitCode, stderr) === 'AdmissionDenied' },
  { reason: 'NotReady', matches: has('not ready. status:') },
  { reason: 'Timeout', matches: has('context deadline exceeded', 'timed out waiting for the condition') },
  { reason: 'Ownership', matches: has('invalid ownership metadata', 'exists and cannot be imported into the current release') },
  { reason: 'ChartNotFound', matches: chartNotFound },
  { reason: 'RepoAuth', matches: repoAuth },
  { reason: 'RepoUnreachable', matches: repoUnreachable },
  { reason: 'RenderError', matches: has('execution error at (', 'parse error at (', 'template: ') },
  { reason: 'ValuesSchema', matches: has("values don't meet the specifications of the schema") },
  { reason: 'ReleaseNotFound', matches: has('release: not found') },
];

/**
 * Helm could not talk to the API server at all. Its wrapper carries words the chart rules match
 * (`context deadline exceeded`, `dial tcp`), so the kubectl classifier decides instead.
 */
function clusterUnreachable(exitCode: number, stderr: string): KubeErrorReason {
  if (stderr.includes('provide credentials')) return 'Unauthorized';
  const reason = classifyKubectlFailure(exitCode, stderr);
  return reason === 'Unknown' || reason === 'Timeout' ? 'Unreachable' : reason;
}

export function classifyHelmFailure(exitCode: number, stderr: string): HelmFailureReason {
  if (exitCode === 127 || HELM_MISSING.test(stderr)) return 'ToolMissing';
  const lower = stderr.toLowerCase();
  if (CLUSTER_UNREACHABLE.some((text) => lower.includes(text))) return clusterUnreachable(exitCode, stderr);
  return RULES.find((rule) => rule.matches(exitCode, stderr))?.reason ?? classifyKubectlFailure(exitCode, stderr);
}

const DETAIL_LINES = 5;

/** Helm's wrappers around the cause; the CLI message already says what failed */
const WRAPPERS = [
  /^Error: /,
  /^(?:UPGRADE|INSTALL|INSTALLATION|ROLLBACK|UNINSTALL|UNINSTALLATION) FAILED: /,
  /^release \S+ failed, and has been (?:uninstalled|rolled back) due to rollback-on-failure being set: /,
];

function unwrap(line: string): string {
  let text = line.trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const wrapper of WRAPPERS) {
      const next = text.replace(wrapper, '');
      if (next !== text) {
        text = next.trim();
        changed = true;
      }
    }
  }
  return text;
}

/**
 * At most 5 lines on one line, `Error: ` prefixes and Helm's wrappers removed. When the watcher
 * reported resources that are not ready, those lines are the detail: they name what did not start.
 * The optional Redactor is applied on top of the executor's own redaction.
 */
export function helmFailureDetail(stderr: string, redactor?: Redactor): string {
  const lines = stderr
    .split(/\r?\n/)
    .map(unwrap)
    .filter((line) => line.length > 0);
  const notReady = lines.flatMap((line) => {
    const match = NOT_READY_LINE.exec(line);
    return match ? [match[0]] : [];
  });
  const detail = (notReady.length > 0 ? notReady : lines).slice(0, DETAIL_LINES).join('; ');
  return redactor ? redactor.redact(detail) : detail;
}

export interface HelmFailureContext {
  env: string;
  /** the helm verb (`upgrade`, `rollback`, `pull`, ...), for the kubectl fallback and guard messages */
  operation: string;
  release: string;
  namespace: string;
  node: string;
  mutating: boolean;
  /** helmFailureDetail of the stderr */
  detail: string;
  /** chart display, e.g. `postgresql 16.7.4 from https://charts.example.org` */
  chart: string;
  /** --timeout of the operation */
  timeoutS: number;
  /** `DistributionTraits.name`: its setup command is the one the suggestions name */
  distribution: string;
  /** repository URL or OCI registry host named by RepoUnreachable; default: the chart display */
  repository?: string;
  /** redacted stderr and exit code for the kubectl fallback; default: the detail and exit 1 */
  stderr?: string;
  exitCode?: number;
}

export function helmErrorToCliError(reason: HelmFailureReason, context: HelmFailureContext): CLIError {
  const { env, release, namespace, node, detail, chart, timeoutS, distribution } = context;
  const within = detail ? ` (${detail})` : '';
  switch (reason) {
    case 'ToolMissing':
      return new OrchestratorUnavailableError(`helm is not installed on ${node}`, `Re-run \`dockflow setup ${distribution} ${env}\`.`);
    case 'Pending':
      return new DeployError(
        `Helm release ${release} has an operation in progress`,
        ErrorCode.DEPLOY_FAILED,
        `Run \`dockflow helm status ${env} ${release}\`.`,
      );
    case 'UninstalledOnFailure':
      return new DeployError(
        `Helm release ${release} failed to install and was removed${within}`,
        ErrorCode.DEPLOY_FAILED,
        `Run \`dockflow diagnose ${env}\`, fix the chart values, then deploy again.`,
      );
    case 'RolledBack':
      return new DeployError(
        `Helm release ${release} failed to upgrade and was rolled back to its previous revision${within}`,
        ErrorCode.DEPLOY_FAILED,
        `Run \`dockflow helm history ${env} ${release}\`.`,
      );
    // resources the watcher saw not ready before --timeout: the Timeout message with those lines
    case 'NotReady':
    case 'Timeout':
      return new DeployError(
        `Helm release ${release} did not become ready within ${timeoutS}s${within}`,
        ErrorCode.DEPLOY_FAILED,
        `Run \`dockflow diagnose ${env}\`, or raise \`helm.releases[].timeout\`.`,
      );
    case 'Ownership':
      return new DeployError(
        `Helm release ${release} would take over objects it does not own${within}`,
        ErrorCode.DEPLOY_FAILED,
        'Rename the conflicting objects or the release, because Dockflow never passes `--take-ownership`.',
      );
    case 'ChartNotFound':
      return new ConfigError(`Chart ${chart} was not found`, `Check \`chart\`, \`repo\` and \`version\` of ${release} in config.yml.`);
    case 'RepoAuth':
      return new ConfigError(`The chart repository rejected the credentials for ${chart}`, `Check \`helm.releases[].auth\` of ${release}.`);
    case 'RepoUnreachable':
      return new DeployError(
        `${node} cannot reach ${context.repository ?? chart}${within}`,
        ErrorCode.DEPLOY_FAILED,
        'Check outbound HTTPS from the control-plane node.',
      );
    case 'RenderError':
      return new DeployError(
        `Chart ${chart} failed to render with the values of ${release}: ${detail}`,
        ErrorCode.VALIDATION_FAILED,
        `Check the values of ${release}.`,
      );
    case 'ValuesSchema':
      return new DeployError(`The values of ${release} do not match the chart schema: ${detail}`, ErrorCode.VALIDATION_FAILED);
    case 'ReleaseNotFound':
      return new CLIError(
        `Helm release ${release} was not found in namespace ${namespace}`,
        ErrorCode.SERVICE_NOT_FOUND,
        `Run \`dockflow helm list ${env}\`.`,
      );
    default: {
      const stderr = context.stderr ?? detail;
      const exitCode = context.exitCode ?? 1;
      const operation = `helm ${context.operation} ${release}`;
      return kubeErrorToCliError(new KubeError(reason, `${operation} failed on ${node}`, node, exitCode, stderr), {
        env,
        operation,
        mutating: context.mutating,
        distribution,
      });
    }
  }
}

export type HelmCallContext = Omit<HelmFailureContext, 'detail' | 'stderr' | 'exitCode'>;

/** a failed `HelmResult` (a call made with `allowFailure`), classified and mapped */
export function helmResultToCliError(result: { exitCode: number; stderr: string }, context: HelmCallContext): CLIError {
  return helmErrorToCliError(classifyHelmFailure(result.exitCode, result.stderr), {
    ...context,
    detail: helmFailureDetail(result.stderr),
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}

/**
 * A KubeError thrown by the HelmExecutor: local guard expiry, a lost transport, or a non-zero exit
 * of a call made without `allowFailure` (reclassified with the Helm rules).
 */
export function helmKubeErrorToCliError(error: KubeError, context: Omit<HelmCallContext, 'node'>): CLIError {
  const { env, operation, release, mutating, timeoutS, distribution } = context;
  if (error.exitCode === NO_EXIT_CODE) {
    if (error.reason === 'Timeout') {
      return new DeployError(
        `Helm ${operation} of ${release} did not finish within ${helmGuardS({ mutating, timeoutS })}s on ${error.node}; it may still be running there`,
        ErrorCode.DEPLOY_FAILED,
        `Run \`dockflow helm status ${env} ${release}\` before retrying.`,
      );
    }
    return kubeErrorToCliError(error, { env, operation: `helm ${operation} ${release}`, mutating, distribution });
  }
  return helmResultToCliError(error, { ...context, node: error.node });
}
