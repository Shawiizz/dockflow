import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyKubectlFailure,
  KubeError,
  type KubeErrorReason,
  kubeErrorToCliError,
  stderrExcerpt,
} from '../../../services/orchestrator/kubernetes/runtime/errors';
import { CLIError, DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../utils/errors';

const SAMPLES = join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr');

const REASONS: KubeErrorReason[] = [
  'NotFound',
  'AlreadyExists',
  'Conflict',
  'Forbidden',
  'Unauthorized',
  'Unreachable',
  'CertificateMismatch',
  'KubeconfigMissing',
  'ToolMissing',
  'NoKindMatch',
  'Immutable',
  'Invalid',
  'AdmissionDenied',
  'Timeout',
  'Unknown',
];

function sample(reason: KubeErrorReason, file = '1.txt'): string {
  return readFileSync(join(SAMPLES, reason, file), 'utf8');
}

function kubeError(reason: KubeErrorReason, stderr = sample(reason)): KubeError {
  return new KubeError(reason, `kubectl failed with ${reason}`, 'server_1', reason === 'ToolMissing' ? 127 : 1, stderr);
}

const CONTEXT = { env: 'production', operation: 'deploy', distribution: 'k3s' };
const RERUN_SETUP = 'Re-run `dockflow setup k3s production`.';

describe('classifyKubectlFailure', () => {
  it('has at least two recorded-shape samples for every reason and no other directory', () => {
    expect(readdirSync(SAMPLES).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      expect(readdirSync(join(SAMPLES, reason)).filter((file) => file.endsWith('.txt')).length).toBeGreaterThanOrEqual(2);
    }
  });

  for (const reason of REASONS) {
    it(`U-RT-E-01: classifies every ${reason} sample as ${reason}`, () => {
      for (const file of readdirSync(join(SAMPLES, reason))) {
        expect({ file, reason: classifyKubectlFailure(1, sample(reason, file)) }).toEqual({ file, reason });
      }
    });
  }

  it('U-RT-E-02: exit 127 is ToolMissing whatever stderr says', () => {
    expect(classifyKubectlFailure(127, '')).toBe('ToolMissing');
    expect(classifyKubectlFailure(127, sample('Conflict'))).toBe('ToolMissing');
    expect(classifyKubectlFailure(127, sample('Unreachable'))).toBe('ToolMissing');
  });

  it('U-RT-E-03: x509 wins over "Unable to connect to the server" (table order)', () => {
    const stderr = 'Unable to connect to the server: tls: failed to verify certificate: x509: certificate has expired';
    expect(classifyKubectlFailure(1, stderr)).toBe('CertificateMismatch');
  });

  it('keeps admission denials, which the API serves as (Forbidden), apart from RBAC refusals', () => {
    expect(classifyKubectlFailure(1, sample('AdmissionDenied', '1.txt'))).toBe('AdmissionDenied');
    expect(classifyKubectlFailure(1, sample('Forbidden', '1.txt'))).toBe('Forbidden');
  });

  it('tells a missing kubeconfig from another missing file', () => {
    expect(classifyKubectlFailure(1, sample('KubeconfigMissing', '1.txt'))).toBe('KubeconfigMissing');
    expect(classifyKubectlFailure(1, 'error: open /tmp/manifest.yaml: no such file or directory')).toBe('Unknown');
  });

  it('classifies the three immutable transitions the translator itself produces as Immutable, not Invalid', () => {
    expect(classifyKubectlFailure(1, sample('Immutable', '2.txt'))).toBe('Immutable');
    expect(classifyKubectlFailure(1, sample('Immutable', '3.txt'))).toBe('Immutable');
    expect(classifyKubectlFailure(1, sample('Immutable', '4.txt'))).toBe('Immutable');
  });

  it('does not mistake a shell locale warning for a missing tool', () => {
    const stderr = `bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8): No such file or directory\n${sample('NotFound')}`;
    expect(classifyKubectlFailure(1, stderr)).toBe('NotFound');
  });

  it('returns Unknown for an empty stderr with exit 1', () => {
    expect(classifyKubectlFailure(1, '')).toBe('Unknown');
  });
});

describe('kubeErrorToCliError', () => {
  interface Row {
    reason: KubeErrorReason;
    file?: string;
    type: new (...args: never[]) => CLIError;
    code: ErrorCode;
    message: string;
    suggestion: string | undefined;
  }

  const rows: Row[] = [
    {
      reason: 'ToolMissing',
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'k3s is not installed on server_1',
      suggestion: 'Run `dockflow setup k3s production`.',
    },
    {
      reason: 'KubeconfigMissing',
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'The Dockflow kubeconfig is missing or unreadable on server_1',
      suggestion: RERUN_SETUP,
    },
    {
      reason: 'CertificateMismatch',
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'The kubeconfig on server_1 does not match the cluster certificate authority',
      suggestion: RERUN_SETUP,
    },
    {
      reason: 'Unauthorized',
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'The Dockflow deploy identity was rejected by the cluster on server_1',
      suggestion: RERUN_SETUP,
    },
    {
      reason: 'Unreachable',
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'The Kubernetes API is not answering on server_1',
      suggestion: 'Check the k3s service with `dockflow ssh production`, then `systemctl status k3s`.',
    },
    {
      reason: 'Forbidden',
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'The Dockflow deploy identity is not allowed to deploy',
      suggestion: RERUN_SETUP,
    },
    {
      reason: 'NoKindMatch',
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'The cluster has no IngressRoute resource type (missing CRDs)',
      suggestion: 'Enable `proxy.enabled` so Dockflow installs Traefik, or remove the Traefik labels.',
    },
    {
      reason: 'Immutable',
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Deployment web cannot be updated in place (spec.selector is immutable); nothing was changed',
      suggestion:
        'Remove the workloads with `dockflow stop production` (or `dockflow accessories remove production`); volumes are kept. Then deploy again.',
    },
    {
      reason: 'Immutable',
      file: '2.txt',
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Service db cannot be updated in place (spec.clusterIPs[0] is immutable); nothing was changed',
      suggestion:
        'Remove the workloads with `dockflow stop production` (or `dockflow accessories remove production`); volumes are kept. Then deploy again.',
    },
    {
      reason: 'AdmissionDenied',
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message:
        'Cluster policy rejected an object: images from registry.example.com/untrusted are not allowed; nothing was changed',
      suggestion: undefined,
    },
    {
      reason: 'Invalid',
      type: DeployError,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Kubernetes rejected Deployment web: spec.template.spec.containers[0].image: Required value',
      suggestion: 'Report this as a Dockflow bug with the output of `dockflow deploy production --dry-run --render`.',
    },
    {
      reason: 'Conflict',
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'leases.coordination.k8s.io lock-dockflow-shop-production was modified concurrently',
      suggestion: 'Retry the command.',
    },
    {
      reason: 'NotFound',
      type: CLIError,
      code: ErrorCode.SERVICE_NOT_FOUND,
      message: 'deployments.apps web was not found in the cluster',
      suggestion: 'Run `dockflow status production` to see what is deployed.',
    },
    {
      reason: 'NotFound',
      file: '2.txt',
      type: CLIError,
      code: ErrorCode.STACK_NOT_FOUND,
      message: 'namespaces dockflow-shop-production was not found in the cluster',
      suggestion: 'Deploy the stack with `dockflow deploy production` first.',
    },
  ];

  for (const row of rows) {
    it(`U-RT-E-04: maps ${row.reason}${row.file ? ` (${row.file})` : ''} exactly`, () => {
      const mapped = kubeErrorToCliError(kubeError(row.reason, sample(row.reason, row.file)), { ...CONTEXT, mutating: true });
      expect(mapped).toBeInstanceOf(row.type);
      expect({ code: mapped.code, message: mapped.message, suggestion: mapped.suggestion }).toEqual({
        code: row.code,
        message: row.message,
        suggestion: row.suggestion,
      });
    });
  }

  it('U-RT-E-04: maps the same way for a query, except Timeout and Unknown', () => {
    for (const row of rows) {
      const mapped = kubeErrorToCliError(kubeError(row.reason, sample(row.reason, row.file)), { ...CONTEXT, mutating: false });
      expect(mapped.message).toBe(row.message);
    }
  });

  it('U-RT-E-04: names the distribution it is given, never a hard-coded one', () => {
    const mapped = kubeErrorToCliError(kubeError('ToolMissing'), { ...CONTEXT, mutating: false, distribution: 'otherdist' });
    expect(mapped.message).toBe('otherdist is not installed on server_1');
    expect(mapped.suggestion).toBe('Run `dockflow setup otherdist production`.');
  });

  it('U-RT-E-05: Timeout is a DeployError when mutating and OrchestratorUnavailableError for a query', () => {
    const mutating = kubeErrorToCliError(kubeError('Timeout'), { ...CONTEXT, mutating: true });
    expect(mutating).toBeInstanceOf(DeployError);
    expect(mutating.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(mutating.message).toBe('deploy timed out on server_1');
    expect(mutating.suggestion).toBe('Check the result with `dockflow status production` before running it again.');

    const query = kubeErrorToCliError(kubeError('Timeout'), { ...CONTEXT, operation: 'status', mutating: false });
    expect(query).toBeInstanceOf(OrchestratorUnavailableError);
    expect(query.code).toBe(ErrorCode.ORCHESTRATOR_UNAVAILABLE);
    expect(query.message).toBe('status timed out on server_1');
  });

  it('U-RT-E-06: Unknown carries only the first 5 (already redacted) stderr lines', () => {
    const stderr = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const mutating = kubeErrorToCliError(kubeError('Unknown', stderr), { ...CONTEXT, mutating: true });
    expect(mutating).toBeInstanceOf(DeployError);
    expect(mutating.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(mutating.message).toBe('deploy failed on server_1: line 1; line 2; line 3; line 4; line 5');
    expect(mutating.message).not.toContain('line 6');

    const query = kubeErrorToCliError(kubeError('Unknown', stderr), { ...CONTEXT, mutating: false });
    expect(query).toBeInstanceOf(OrchestratorUnavailableError);
    expect(query.message).toBe(mutating.message);

    const blank = kubeErrorToCliError(new KubeError('Unknown', 'x', 'server_1', 3, ''), { ...CONTEXT, mutating: true });
    expect(blank.message).toBe('deploy failed on server_1: exit code 3');
    expect(stderrExcerpt('\n a \n\n b \n', 1)).toBe('a');
  });

  it('U-RT-E-07: Invalid is VALIDATION_FAILED with the bug-report suggestion', () => {
    const mapped = kubeErrorToCliError(kubeError('Invalid', sample('Invalid', '2.txt')), { ...CONTEXT, mutating: true });
    expect(mapped.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(mapped.message).toBe('Kubernetes rejected Service web: spec.ports[0].port: Invalid value: 70000: must be between 1 and 65535, inclusive');
    expect(mapped.suggestion).toBe(
      'Report this as a Dockflow bug with the output of `dockflow deploy production --dry-run --render`.',
    );
  });

  it('maps AlreadyExists left unhandled by its caller like Unknown', () => {
    const mapped = kubeErrorToCliError(kubeError('AlreadyExists'), { ...CONTEXT, mutating: true });
    expect(mapped).toBeInstanceOf(DeployError);
    expect(mapped.message).toStartWith('deploy failed on server_1: Error from server (AlreadyExists)');
  });

  it('keeps every message on one line without a trailing period', () => {
    for (const reason of REASONS) {
      for (const mutating of [true, false]) {
        const mapped = kubeErrorToCliError(kubeError(reason), { ...CONTEXT, mutating });
        expect(mapped.message).not.toContain('\n');
        expect(mapped.message.endsWith('.')).toBe(false);
        if (mapped.suggestion !== undefined) expect(mapped.suggestion.endsWith('.')).toBe(true);
      }
    }
  });
});
