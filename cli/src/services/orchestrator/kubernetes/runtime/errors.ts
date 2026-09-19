// kubectl failure classification and its user-facing mapping (DESIGN-CORE 8.4). Stderr reaching
// this module is already redacted by the executor that produced it.

import { CLIError, DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../../utils/errors';
import { K8S_KUBECONFIG_PATH } from '../constants';

export type KubeErrorReason =
  | 'NotFound'
  | 'AlreadyExists'
  | 'Conflict'
  | 'Forbidden'
  | 'Unauthorized'
  | 'Unreachable'
  | 'CertificateMismatch'
  | 'KubeconfigMissing'
  | 'ToolMissing'
  | 'NoKindMatch'
  | 'Immutable'
  | 'Invalid'
  | 'AdmissionDenied'
  | 'Timeout'
  | 'Unknown';

export class KubeError extends Error {
  constructor(
    public readonly reason: KubeErrorReason,
    message: string,
    public readonly node: string,
    public readonly exitCode: number,
    /** redacted */
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'KubeError';
  }
}

/** `KubeError.exitCode` when no remote status exists: local guard expiry or a lost transport */
export const NO_EXIT_CODE = -1;

/**
 * A shell (or env) reporting that the executable it was asked to run does not exist. Warnings are
 * excluded: `bash: warning: setlocale: ...: No such file or directory` precedes many real errors.
 */
const SHELL_MISSING_TOOL =
  /^(?:\S*\/)?(?:sh|bash|dash|ash|zsh|ksh|env): (?!.*\bwarning:).*(?:not found|No such file or directory)\s*$/m;

interface Rule {
  reason: KubeErrorReason;
  matches(exitCode: number, stderr: string): boolean;
}

const has = (...needles: string[]) => (_exitCode: number, stderr: string): boolean =>
  needles.some((needle) => stderr.includes(needle));

// First match wins. AdmissionDenied is tested before Forbidden because webhook and PodSecurity
// denials are served as `(Forbidden)` too, and they are not an RBAC problem of the deploy identity.
const RULES: Rule[] = [
  { reason: 'ToolMissing', matches: (exitCode, stderr) => exitCode === 127 || SHELL_MISSING_TOOL.test(stderr) },
  {
    reason: 'KubeconfigMissing',
    matches: (_exitCode, stderr) => stderr.includes(K8S_KUBECONFIG_PATH) && /no such file|permission denied/i.test(stderr),
  },
  { reason: 'CertificateMismatch', matches: has('x509:') },
  { reason: 'Unauthorized', matches: has('(Unauthorized)', 'You must be logged in') },
  {
    reason: 'Unreachable',
    matches: has('connection refused', 'Unable to connect to the server', 'dial tcp', 'The connection to the server'),
  },
  { reason: 'AdmissionDenied', matches: has('admission webhook', 'denied the request', 'violates PodSecurity') },
  { reason: 'Forbidden', matches: has('(Forbidden)') },
  { reason: 'NoKindMatch', matches: has('no matches for kind') },
  {
    reason: 'Immutable',
    matches: has(
      'field is immutable',
      'may not change once set',
      'is immutable after creation',
      // a StatefulSet refuses volumeClaimTemplates (and selector) changes with this text instead
      'updates to statefulset spec for fields other than',
    ),
  },
  { reason: 'Invalid', matches: has('(Invalid)', ' is invalid') },
  { reason: 'Conflict', matches: has('(Conflict)') },
  { reason: 'NotFound', matches: has('(NotFound)') },
  { reason: 'AlreadyExists', matches: has('(AlreadyExists)') },
  {
    reason: 'Timeout',
    matches: has('context deadline exceeded', 'Client.Timeout', '(Timeout)', 'timed out waiting for the condition'),
  },
];

export function classifyKubectlFailure(exitCode: number, stderr: string): KubeErrorReason {
  return RULES.find((rule) => rule.matches(exitCode, stderr))?.reason ?? 'Unknown';
}

export interface KubeErrorContext {
  env: string;
  /** what was being done, as a subject and after "not allowed to" (e.g. `deploy`) */
  operation: string;
  mutating: boolean;
  /** `DistributionTraits.name`: the product, its setup command and its service unit */
  distribution: string;
}

/** first `count` non-empty stderr lines, trimmed, on one line */
export function stderrExcerpt(stderr: string, count = 5): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, count)
    .join('; ');
}

interface ObjectRef {
  kind: string;
  name: string;
}

function objectOf(stderr: string): ObjectRef | null {
  const invalid = /([A-Z][A-Za-z0-9]*)(?:\.[a-z0-9.-]+)? "([^"]+)" is invalid/.exec(stderr);
  if (invalid) return { kind: invalid[1], name: invalid[2] };
  const conflict = /Operation cannot be fulfilled on ([a-z0-9.-]+) "([^"]+)"/.exec(stderr);
  if (conflict) return { kind: conflict[1], name: conflict[2] };
  const plain = /([a-z0-9.-]+) "([^"]+)" (?:not found|already exists|is forbidden)/.exec(stderr);
  if (plain) return { kind: plain[1], name: plain[2] };
  return null;
}

function subject(ref: ObjectRef | null, fallback: string): string {
  return ref ? `${ref.kind} ${ref.name}` : fallback;
}

/** the stderr line without kubectl's `Error from server (X): ` / `error: ` prefixes */
function strippedFirstLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return line
    .trim()
    .replace(/^Error from server(?: \([A-Za-z]+\))?: /, '')
    .replace(/^error: /, '');
}

function invalidDetail(stderr: string): string {
  const match = / is invalid: (.+)/.exec(stderr);
  return match ? match[1].trim() : strippedFirstLine(stderr);
}

function admissionDetail(stderr: string): string {
  const webhook = /denied the request: (.+)/.exec(stderr);
  if (webhook) return webhook[1].trim();
  const podSecurity = /(violates PodSecurity .+)/.exec(stderr);
  return podSecurity ? podSecurity[1].trim() : strippedFirstLine(stderr);
}

function immutableField(stderr: string): string {
  const match = / is invalid: \[?([A-Za-z0-9_.[\]-]+): /.exec(stderr);
  return match ? match[1] : 'a field';
}

export function kubeErrorToCliError(error: KubeError, context: KubeErrorContext): CLIError {
  const { env, operation, mutating, distribution } = context;
  const node = error.node;
  const stderr = error.stderr;
  const rerunSetup = `Re-run \`dockflow setup ${distribution} ${env}\`.`;
  const checkService = `Check the ${distribution} service with \`dockflow ssh ${env}\`, then \`systemctl status ${distribution}\`.`;

  switch (error.reason) {
    case 'ToolMissing':
      return new OrchestratorUnavailableError(
        `${distribution} is not installed on ${node}`,
        `Run \`dockflow setup ${distribution} ${env}\`.`,
        error,
      );
    case 'KubeconfigMissing':
      return new OrchestratorUnavailableError(`The Dockflow kubeconfig is missing or unreadable on ${node}`, rerunSetup, error);
    case 'CertificateMismatch':
      return new OrchestratorUnavailableError(
        `The kubeconfig on ${node} does not match the cluster certificate authority`,
        rerunSetup,
        error,
      );
    case 'Unauthorized':
      return new OrchestratorUnavailableError(
        `The Dockflow deploy identity was rejected by the cluster on ${node}`,
        rerunSetup,
        error,
      );
    case 'Unreachable':
      return new OrchestratorUnavailableError(`The Kubernetes API is not answering on ${node}`, checkService, error);
    case 'Forbidden':
      return new OrchestratorUnavailableError(`The Dockflow deploy identity is not allowed to ${operation}`, rerunSetup, error);
    case 'NoKindMatch': {
      const kind = /no matches for kind "([^"]+)"/.exec(stderr)?.[1] ?? 'requested';
      return new DeployError(
        `The cluster has no ${kind} resource type (missing CRDs)`,
        ErrorCode.DEPLOY_FAILED,
        'Enable `proxy.enabled` so Dockflow installs Traefik, or remove the Traefik labels.',
      );
    }
    case 'Immutable':
      return new DeployError(
        `${subject(objectOf(stderr), 'An object')} cannot be updated in place (${immutableField(stderr)} is immutable); nothing was changed`,
        ErrorCode.DEPLOY_FAILED,
        `Remove the workloads with \`dockflow stop ${env}\` (or \`dockflow accessories remove ${env}\`); volumes are kept. Then deploy again.`,
      );
    case 'AdmissionDenied':
      return new DeployError(
        `Cluster policy rejected ${subject(objectOf(stderr), 'an object')}: ${admissionDetail(stderr)}; nothing was changed`,
        ErrorCode.DEPLOY_FAILED,
      );
    case 'Invalid':
      return new DeployError(
        `Kubernetes rejected ${subject(objectOf(stderr), 'an object')}: ${invalidDetail(stderr)}`,
        ErrorCode.VALIDATION_FAILED,
        `Report this as a Dockflow bug with the output of \`dockflow deploy ${env} --dry-run --render\`.`,
      );
    case 'Conflict':
      return new DeployError(
        `${subject(objectOf(stderr), 'An object')} was modified concurrently`,
        ErrorCode.DEPLOY_FAILED,
        'Retry the command.',
      );
    case 'NotFound': {
      const ref = objectOf(stderr);
      const namespace = ref !== null && /^(?:namespaces?|Namespace)$/.test(ref.kind);
      return new CLIError(
        ref ? `${ref.kind} ${ref.name} was not found in the cluster` : `${operation} failed on ${node}: an object it needs was not found`,
        namespace ? ErrorCode.STACK_NOT_FOUND : ErrorCode.SERVICE_NOT_FOUND,
        namespace
          ? `Deploy the stack with \`dockflow deploy ${env}\` first.`
          : `Run \`dockflow status ${env}\` to see what is deployed.`,
        error,
      );
    }
    case 'Timeout':
      return mutating
        ? new DeployError(
            `${operation} timed out on ${node}`,
            ErrorCode.DEPLOY_FAILED,
            `Check the result with \`dockflow status ${env}\` before running it again.`,
          )
        : new OrchestratorUnavailableError(`${operation} timed out on ${node}`, checkService, error);
    case 'AlreadyExists':
    case 'Unknown': {
      const detail = stderrExcerpt(stderr) || `exit code ${error.exitCode}`;
      const message = `${operation} failed on ${node}: ${detail}`;
      return mutating ? new DeployError(message, ErrorCode.DEPLOY_FAILED) : new OrchestratorUnavailableError(message, undefined, error);
    }
  }
}
