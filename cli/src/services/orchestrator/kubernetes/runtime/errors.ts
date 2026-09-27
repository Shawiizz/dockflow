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
  | 'NamespaceTerminating'
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

// First match wins. AdmissionDenied comes first among the server's answers: a webhook that cannot
// be called fails with its own `dial tcp`, `x509:` or deadline, which are no fault of the API server
// or of the kubeconfig; a policy denial is served as `(Forbidden)` or as `is invalid`, and neither
// is an RBAC problem of the deploy identity or a Dockflow bug. A namespace being deleted refuses new
// objects as `(Forbidden)` too.
const RULES: Rule[] = [
  { reason: 'ToolMissing', matches: (exitCode, stderr) => exitCode === 127 || SHELL_MISSING_TOOL.test(stderr) },
  {
    reason: 'KubeconfigMissing',
    matches: (_exitCode, stderr) => stderr.includes(K8S_KUBECONFIG_PATH) && /no such file|permission denied/i.test(stderr),
  },
  {
    reason: 'AdmissionDenied',
    matches: has('admission webhook', 'failed calling webhook', 'denied the request', "ValidatingAdmissionPolicy '", 'violates PodSecurity'),
  },
  { reason: 'CertificateMismatch', matches: has('x509:') },
  // client-go's own words for a 401, e.g. when kubectl apply downloads the OpenAPI schema first
  { reason: 'Unauthorized', matches: has('(Unauthorized)', 'You must be logged in', 'the server has asked for the client to provide credentials') },
  {
    reason: 'Unreachable',
    matches: has('connection refused', 'Unable to connect to the server', 'dial tcp', 'The connection to the server'),
  },
  { reason: 'NamespaceTerminating', matches: has('because it is being terminated') },
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
  // `The Deployment "web" is invalid`, or the resource name a policy denial prints: `The deployments "web" is invalid`
  const invalid = /([A-Za-z][A-Za-z0-9]*)(?:\.[a-z0-9.-]+)? "([^"]+)" is invalid/.exec(stderr);
  if (invalid) return { kind: invalid[1], name: invalid[2] };
  const conflict = /Operation cannot be fulfilled on ([A-Za-z0-9.-]+) "([^"]+)"/.exec(stderr);
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

/** the `* <field>: <reason>` lines the API server prints under `is invalid:` when several fields fail */
function fieldErrors(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('* '))
    .map((line) => line.slice(2));
}

function invalidDetail(stderr: string): string {
  const inline = / is invalid: (.+)/.exec(stderr)?.[1].trim();
  if (inline) return inline;
  const fields = fieldErrors(stderr);
  return fields.length > 0 ? fields.join('; ') : strippedFirstLine(stderr);
}

function admissionDetail(stderr: string): string {
  // a webhook, then a ValidatingAdmissionPolicy (`with binding '<b>' denied request: <message>`)
  const denial = /denied (?:the )?request: (.+)/.exec(stderr);
  if (denial) return denial[1].trim();
  const other = /(violates PodSecurity .+|failed calling webhook .+)/.exec(stderr);
  return other ? other[1].trim() : strippedFirstLine(stderr);
}

function immutableField(stderr: string): string {
  const match = / is invalid: \[?([A-Za-z0-9_.[\]-]+): /.exec(stderr) ?? /^\* ([A-Za-z0-9_.[\]-]+): /m.exec(stderr);
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
    case 'NamespaceTerminating': {
      // updates of objects that are still there go through; only new ones are refused
      const namespace = /in namespace (\S+) because it is being terminated/.exec(stderr)?.[1];
      return new DeployError(
        `Namespace ${namespace ?? 'of the stack'} is being deleted, so nothing new can be created in it`,
        ErrorCode.DEPLOY_FAILED,
        'Wait until the deletion has finished, then run the command again.',
      );
    }
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
