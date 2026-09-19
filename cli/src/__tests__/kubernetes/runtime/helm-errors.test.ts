import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_CHARTS_DIR } from '../../../services/orchestrator/kubernetes/constants';
import {
  classifyKubectlFailure,
  KubeError,
  type KubeErrorReason,
  NO_EXIT_CODE,
} from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  classifyHelmFailure,
  type HelmCallContext,
  type HelmFailureReason,
  helmErrorToCliError,
  helmFailureDetail,
  helmKubeErrorToCliError,
  helmResultToCliError,
} from '../../../services/orchestrator/kubernetes/runtime/helm-errors';
import {
  CLIError,
  ConfigError,
  DeployError,
  ErrorCode,
  OrchestratorUnavailableError,
} from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeHelmExecutor } from '../fakes/fake-helm-executor';
import { REST } from '../fakes/fake-kube-executor';
import { FakeNodeShell } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';
import { readHelmFixture } from '../support/kubectl-fixtures';
import { expectCliError } from '../support/matchers';

const NS = 'dockflow-shop-production';
const SECRET = 'values-db-password-4411';
const CHART = 'redis 20.1.0 from https://charts.example.com';

/** the reasons of the design-04 3.5.5 table; the rest come from the kubectl classifier */
type TableReason = Exclude<HelmFailureReason, KubeErrorReason> | 'ToolMissing' | 'Timeout';

// Synthetic stderr in the shapes helm v4.3.0 prints, until the test machine records them (PD-12).
// The two recorded-shape fixtures of fixtures/helm are read through the fixture loader.
const SAMPLES: Record<TableReason, { exitCode: number; stderr: string }[]> = {
  ToolMissing: [
    { exitCode: 127, stderr: 'sh: 1: /usr/local/lib/dockflow/bin/helm: not found\n' },
    { exitCode: 127, stderr: "env: '/usr/local/lib/dockflow/bin/helm': No such file or directory\n" },
    { exitCode: 1, stderr: "env: '/usr/local/lib/dockflow/bin/helm': No such file or directory\n" },
  ],
  Pending: [{ exitCode: 1, stderr: 'Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress\n' }],
  UninstalledOnFailure: [
    {
      exitCode: 1,
      stderr: `Error: INSTALL FAILED: release web failed, and has been uninstalled due to rollback-on-failure being set: resource Deployment/${NS}/web not ready. status: InProgress, message: Available: 0/1\ncontext deadline exceeded\n`,
    },
    {
      exitCode: 1,
      stderr: 'Error: INSTALL FAILED: release web failed, and has been uninstalled due to rollback-on-failure being set: failed pre-install: 1 error occurred:\n\t* job web-migrate failed: BackoffLimitExceeded\n',
    },
  ],
  RolledBack: [{ exitCode: 1, stderr: readHelmFixture('helm-history-rollback', 'upgrade-stderr.txt') }],
  NotReady: [{ exitCode: 1, stderr: readHelmFixture('helm-status-failed', 'upgrade-stderr.txt') }],
  Timeout: [
    { exitCode: 1, stderr: 'Error: UPGRADE FAILED: context deadline exceeded\n' },
    { exitCode: 1, stderr: 'Error: UPGRADE FAILED: post-upgrade hooks failed: timed out waiting for the condition\n' },
  ],
  Ownership: [
    {
      exitCode: 1,
      stderr: `Error: INSTALL FAILED: unable to continue with install: ConfigMap "web-config" in namespace "${NS}" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"\n`,
    },
  ],
  ChartNotFound: [
    { exitCode: 1, stderr: 'Error: chart "redis" version "9.9.9" not found in https://charts.example.com repository\n' },
    { exitCode: 1, stderr: 'Error: failed to perform "FetchReference" on source: registry.example.com/charts/search:9.9.9: not found\n' },
    { exitCode: 1, stderr: "Error: chart \"redis\" matching 9.9.9 not found in dockflow-repo index. (try 'helm repo update'): no chart version found for redis-9.9.9\n" },
    { exitCode: 1, stderr: 'Error: no chart name found\n' },
  ],
  RepoAuth: [
    { exitCode: 1, stderr: 'Error: failed to fetch https://charts.example.com/private/redis-20.1.0.tgz : 401 Unauthorized\n' },
    {
      exitCode: 1,
      stderr: 'Error: looks like "https://charts.example.com/private" is not a valid chart repository or cannot be reached: failed to fetch https://charts.example.com/private/index.yaml : 401 Unauthorized\n',
    },
    { exitCode: 1, stderr: 'Error: login attempt to https://registry.example.com/v2/ failed with status: 401 Unauthorized\n' },
    {
      exitCode: 1,
      stderr: 'Error: failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://registry.example.com/token?scope=repository%3Acharts%2Fsearch%3Apull: 403 Forbidden\n',
    },
    { exitCode: 1, stderr: 'Error: unauthorized: authentication required\n' },
    { exitCode: 1, stderr: 'Error: denied: requested access to the resource is denied\n' },
  ],
  RepoUnreachable: [
    {
      exitCode: 1,
      stderr: 'Error: looks like "https://charts.example.com" is not a valid chart repository or cannot be reached: Get "https://charts.example.com/index.yaml": dial tcp: lookup charts.example.com on 127.0.0.53:53: no such host\n',
    },
    { exitCode: 1, stderr: 'Error: Get "https://registry.example.com/v2/": dial tcp 203.0.113.7:443: i/o timeout\n' },
  ],
  RenderError: [
    {
      exitCode: 1,
      stderr: 'Error: UPGRADE FAILED: template: web/templates/deployment.yaml:21:28: executing "web/templates/deployment.yaml" at <.Values.image.tag>: nil pointer evaluating interface {}.tag\n',
    },
    { exitCode: 1, stderr: 'Error: INSTALL FAILED: execution error at (web/templates/secret.yaml:4:11): password is required\n' },
    { exitCode: 1, stderr: 'Error: UPGRADE FAILED: parse error at (web/templates/_helpers.tpl:12): unexpected "}" in operand\n' },
  ],
  ValuesSchema: [
    {
      exitCode: 1,
      stderr: "Error: INSTALL FAILED: values don't meet the specifications of the schema(s) in the following chart(s):\nweb:\n- replicaCount: Invalid type. Expected: integer, given: string\n",
    },
  ],
  ReleaseNotFound: [{ exitCode: 1, stderr: 'Error: release: not found\n' }],
};

function context(overrides: Partial<HelmCallContext> = {}): HelmCallContext {
  return {
    env: 'production',
    operation: 'upgrade',
    release: 'web',
    namespace: NS,
    node: 'server_1',
    mutating: true,
    chart: CHART,
    timeoutS: 300,
    distribution: 'k3s',
    repository: 'https://charts.example.com',
    ...overrides,
  };
}

function mapped(reason: HelmFailureReason, detail = 'the detail', overrides: Partial<HelmCallContext> = {}): CLIError {
  return helmErrorToCliError(reason, { ...context(overrides), detail });
}

describe('classifyHelmFailure', () => {
  for (const [reason, samples] of Object.entries(SAMPLES)) {
    it(`classifies every ${reason} sample`, () => {
      for (const sample of samples) expect(classifyHelmFailure(sample.exitCode, sample.stderr)).toBe(reason as HelmFailureReason);
    });
  }

  it('prefers UninstalledOnFailure and RolledBack over the NotReady lines they carry', () => {
    const [uninstalled] = SAMPLES.UninstalledOnFailure;
    expect(uninstalled.stderr).toContain('not ready. status:');
    expect(classifyHelmFailure(1, uninstalled.stderr)).toBe('UninstalledOnFailure');
    const [rolledBack] = SAMPLES.RolledBack;
    expect(rolledBack.stderr).toContain('not ready. status:');
    expect(classifyHelmFailure(1, rolledBack.stderr)).toBe('RolledBack');
  });

  it('falls back to the kubectl classifier for every recorded kubectl stderr sample', () => {
    const root = join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr');
    let checked = 0;
    for (const reason of readdirSync(root).sort()) {
      for (const file of readdirSync(join(root, reason)).sort()) {
        const stderr = readFileSync(join(root, reason, file), 'utf8').replace(/\r\n/g, '\n');
        const exitCode = reason === 'ToolMissing' ? 127 : 1;
        expect(`${reason}/${file}: ${classifyHelmFailure(exitCode, stderr)}`).toBe(`${reason}/${file}: ${classifyKubectlFailure(exitCode, stderr)}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('leaves cluster-side rejections to the kubectl classifier although they use registry words', () => {
    const webhook = 'Error: UPGRADE FAILED: failed to create resource: admission webhook "validate.example.com" denied the request: replicas must be at most 3\n';
    expect(classifyHelmFailure(1, webhook)).toBe('AdmissionDenied');
    const apiDial = `Error: UPGRADE FAILED: Get "https://127.0.0.1:6443/apis/apps/v1/namespaces/${NS}/deployments/web": dial tcp 127.0.0.1:6443: connect: connection refused\n`;
    expect(classifyHelmFailure(1, apiDial)).toBe('Unreachable');
    const otherManager = 'Error: UPGRADE FAILED: Get "https://10.0.0.11:6443/api/v1/namespaces": dial tcp 10.0.0.11:6443: i/o timeout\n';
    expect(classifyHelmFailure(1, otherManager)).toBe('Unreachable');
    expect(classifyHelmFailure(1, 'Error: Get "https://charts.example.com/index.yaml": dial tcp 203.0.113.7:443: connect: connection refused\n')).toBe('RepoUnreachable');
  });

  it('classifies an unreachable cluster by the kubectl rules, whatever the wrapper says', () => {
    const refused = 'Error: INSTALLATION FAILED: Kubernetes cluster unreachable: Get "https://127.0.0.1:6443/version": dial tcp 127.0.0.1:6443: connect: connection refused\n';
    expect(classifyHelmFailure(1, refused)).toBe('Unreachable');
    expect(classifyHelmFailure(1, 'Error: Kubernetes cluster unreachable: Get "https://127.0.0.1:6443/version": context deadline exceeded\n')).toBe('Unreachable');
    expect(classifyHelmFailure(1, 'Error: Kubernetes cluster unreachable: the server has asked for the client to provide credentials\n')).toBe('Unauthorized');
    expect(classifyHelmFailure(1, 'Error: Kubernetes cluster unreachable: Get "https://127.0.0.1:6443/version": tls: failed to verify certificate: x509: certificate signed by unknown authority\n')).toBe(
      'CertificateMismatch',
    );
  });
});

describe('helmFailureDetail', () => {
  it('keeps the not-ready lines when the watcher reported some', () => {
    expect(helmFailureDetail(SAMPLES.RolledBack[0].stderr)).toBe(
      'resource Deployment/fixture-helm-history-rollback/web-e2e-broken not ready. status: InProgress, message: Available: 0/1',
    );
    expect(helmFailureDetail(SAMPLES.UninstalledOnFailure[0].stderr)).toBe(`resource Deployment/${NS}/web not ready. status: InProgress, message: Available: 0/1`);
  });

  it("removes `Error: ` prefixes and Helm's wrappers, and joins the lines", () => {
    expect(helmFailureDetail(SAMPLES.UninstalledOnFailure[1].stderr)).toBe('failed pre-install: 1 error occurred:; * job web-migrate failed: BackoffLimitExceeded');
    expect(helmFailureDetail('Error: UPGRADE FAILED: Error: context deadline exceeded\n')).toBe('context deadline exceeded');
  });

  it('keeps at most 5 lines and redacts them', () => {
    const stderr = ['line 1', `line 2 ${SECRET}`, 'line 3', '', 'line 4', 'line 5', 'line 6', 'line 7'].join('\n');
    expect(helmFailureDetail(stderr, new Redactor([SECRET]))).toBe('line 1; line 2 ***; line 3; line 4; line 5');
    expect(helmFailureDetail(stderr)).not.toContain('line 6');
  });
});

describe('helmErrorToCliError', () => {
  it('maps a missing helm binary to OrchestratorUnavailableError naming the setup command', async () => {
    await expectCliError(mapped('ToolMissing'), {
      type: OrchestratorUnavailableError,
      code: ErrorCode.ORCHESTRATOR_UNAVAILABLE,
      message: 'helm is not installed on server_1',
      suggestion: 'Re-run `dockflow setup k3s production`.',
    });
  });

  it('maps the release-level reasons to DeployError with their exact texts', async () => {
    const rows: [HelmFailureReason, string, string][] = [
      ['Pending', 'Helm release web has an operation in progress', 'Run `dockflow helm status production web`.'],
      [
        'UninstalledOnFailure',
        'Helm release web failed to install and was removed (the detail)',
        'Run `dockflow diagnose production`, fix the chart values, then deploy again.',
      ],
      [
        'RolledBack',
        'Helm release web failed to upgrade and was rolled back to its previous revision (the detail)',
        'Run `dockflow helm history production web`.',
      ],
      ['Timeout', 'Helm release web did not become ready within 300s (the detail)', 'Run `dockflow diagnose production`, or raise `helm.releases[].timeout`.'],
      ['NotReady', 'Helm release web did not become ready within 300s (the detail)', 'Run `dockflow diagnose production`, or raise `helm.releases[].timeout`.'],
      [
        'Ownership',
        'Helm release web would take over objects it does not own (the detail)',
        'Rename the conflicting objects or the release, because Dockflow never passes `--take-ownership`.',
      ],
      ['RepoUnreachable', 'server_1 cannot reach https://charts.example.com', 'Check outbound HTTPS from the control-plane node.'],
    ];
    for (const [reason, message, suggestion] of rows) {
      await expectCliError(mapped(reason), { type: DeployError, code: ErrorCode.DEPLOY_FAILED, message, suggestion });
    }
  });

  it('maps chart and credential problems to ConfigError', async () => {
    await expectCliError(mapped('ChartNotFound'), {
      type: ConfigError,
      code: ErrorCode.CONFIG_INVALID,
      message: `Chart ${CHART} was not found`,
      suggestion: 'Check `chart`, `repo` and `version` of web in config.yml.',
    });
    await expectCliError(mapped('RepoAuth'), {
      type: ConfigError,
      code: ErrorCode.CONFIG_INVALID,
      message: `The chart repository rejected the credentials for ${CHART}`,
      suggestion: 'Check `helm.releases[].auth` of web.',
    });
  });

  it('maps render and schema failures to VALIDATION_FAILED with the detail', async () => {
    await expectCliError(mapped('RenderError', 'template: web/templates/deployment.yaml:21:28: nil pointer'), {
      type: DeployError,
      code: ErrorCode.VALIDATION_FAILED,
      message: `Chart ${CHART} failed to render with the values of web: template: web/templates/deployment.yaml:21:28: nil pointer`,
      suggestion: 'Check the values of web.',
    });
    await expectCliError(mapped('ValuesSchema', 'replicaCount: Invalid type'), {
      type: DeployError,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'The values of web do not match the chart schema: replicaCount: Invalid type',
      suggestion: null,
    });
  });

  it('maps a missing release to SERVICE_NOT_FOUND', async () => {
    await expectCliError(mapped('ReleaseNotFound'), {
      code: ErrorCode.SERVICE_NOT_FOUND,
      message: `Helm release web was not found in namespace ${NS}`,
      suggestion: 'Run `dockflow helm list production`.',
    });
  });

  it('names the chart display when no repository is given for RepoUnreachable', async () => {
    await expectCliError(helmErrorToCliError('RepoUnreachable', { ...context(), repository: undefined, detail: '' }), {
      message: `server_1 cannot reach ${CHART}`,
    });
  });

  it('maps every other reason through the kubectl table with operation `helm <op> <name>`', async () => {
    const forbidden = 'Error: UPGRADE FAILED: deployments.apps is forbidden: User "system:serviceaccount:dockflow-system:dockflow-deployer" cannot create resource "deployments" (Forbidden)\n';
    await expectCliError(helmResultToCliError({ exitCode: 1, stderr: forbidden }, context()), {
      type: OrchestratorUnavailableError,
      message: 'The Dockflow deploy identity is not allowed to helm upgrade web',
      suggestion: 'Re-run `dockflow setup k3s production`.',
    });
    const unknown = 'Error: UPGRADE FAILED: an error on the server ("") has prevented the request from succeeding\n';
    await expectCliError(helmResultToCliError({ exitCode: 1, stderr: unknown }, context()), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: /^helm upgrade web failed on server_1: Error: UPGRADE FAILED: an error on the server/,
    });
  });

  it('puts every suggestion command in backticks', () => {
    const reasons: HelmFailureReason[] = ['ToolMissing', 'Pending', 'UninstalledOnFailure', 'RolledBack', 'Timeout', 'ReleaseNotFound'];
    for (const reason of reasons) expect(mapped(reason).suggestion).toMatch(/`dockflow [^`]+`/);
  });
});

describe('helmResultToCliError and helmKubeErrorToCliError', () => {
  it('classifies, extracts the detail and maps a failed result in one call', async () => {
    await expectCliError(helmResultToCliError(SAMPLES.RolledBack[0], context()), {
      type: DeployError,
      message:
        'Helm release web failed to upgrade and was rolled back to its previous revision (resource Deployment/fixture-helm-history-rollback/web-e2e-broken not ready. status: InProgress, message: Available: 0/1)',
    });
  });

  it('turns an expired local guard into the "may still be running" DeployError', async () => {
    const expired = new KubeError('Timeout', 'helm upgrade did not finish within 1320s on server_1', 'server_1', NO_EXIT_CODE, '');
    await expectCliError(helmKubeErrorToCliError(expired, context()), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Helm upgrade of web did not finish within 1320s on server_1; it may still be running there',
      suggestion: 'Run `dockflow helm status production web` before retrying.',
    });
  });

  it('maps a lost transport with the kubectl table and reclassifies a failed exit with the Helm rules', async () => {
    const lost = new KubeError('Unreachable', 'Lost the SSH connection to server_1 during helm upgrade: read ECONNRESET', 'server_1', NO_EXIT_CODE, '');
    await expectCliError(helmKubeErrorToCliError(lost, context()), { type: OrchestratorUnavailableError, message: 'The Kubernetes API is not answering on server_1' });
    const pending = SAMPLES.Pending[0];
    const thrown = new KubeError(classifyKubectlFailure(1, pending.stderr), 'helm upgrade failed on server_2 (exit 1)', 'server_2', 1, pending.stderr);
    await expectCliError(helmKubeErrorToCliError(thrown, context()), { message: 'Helm release web has an operation in progress' });
  });
});

describe('with FakeHelmExecutor', () => {
  let fakes: { helm: FakeHelmExecutor; shell: FakeNodeShell } | null = null;
  const redactor = new Redactor([SECRET]);

  afterEach(() => {
    if (fakes) assertExecutorInvariants({ helm: fakes.helm, nodeShell: fakes.shell, redactor });
    fakes = null;
  });

  function setup(script: ConstructorParameters<typeof FakeHelmExecutor>[0]['script'] = []) {
    const shell = new FakeNodeShell([], { redactor });
    const helm = new FakeHelmExecutor({ redactor, nodeShell: shell, script });
    fakes = { helm, shell };
    return { helm, shell };
  }

  it('maps the redacted stderr the executor returns, never a secret it echoed', async () => {
    const { helm, shell } = setup([
      {
        args: ['upgrade', REST],
        respond: { exitCode: 1, stdout: '', stderr: `Error: INSTALL FAILED: execution error at (web/templates/secret.yaml:4:11): bad value ${SECRET}\n` },
      },
    ]);
    const result = await helm.run({ args: ['upgrade', '--install', 'web', `${HELM_CHARTS_DIR}/sha256-${'a'.repeat(64)}.tgz`, '-n', NS], mutating: true, timeoutS: 300, allowFailure: true });
    expect(result.stderr).not.toContain(SECRET);
    const error = await expectCliError(helmResultToCliError(result, context()), { code: ErrorCode.VALIDATION_FAILED });
    expect(error.message).toBe(`Chart ${CHART} failed to render with the values of web: execution error at (web/templates/secret.yaml:4:11): bad value ***`);
    helm.assertDone();
    shell.assertDone();
  });

  it('classifies the rollback-on-failure outcome of an upgrade', async () => {
    const { helm, shell } = setup();
    const sha = helm.chart({ name: 'web', version: '0.1.0' });
    const path = helm.seedCache(sha, 'fake chart archive web-0.1.0\n');
    const upgrade = (stdin: string) => ({
      args: ['upgrade', '--install', 'web', path, '-n', NS, '--values', '-', '--rollback-on-failure', '--timeout', '300s'],
      stdin,
      mutating: true,
      timeoutS: 300,
      allowFailure: true,
    });
    expect((await helm.run(upgrade('{"replicas":1}\n'))).exitCode).toBe(0);
    helm.failNext('web', `Error: resource Deployment/${NS}/web not ready. status: InProgress, message: Available: 0/1`);
    const failed = await helm.run(upgrade('{"replicas":2}\n'));
    expect(classifyHelmFailure(failed.exitCode, failed.stderr)).toBe('RolledBack');
    await expectCliError(helmResultToCliError(failed, context()), {
      message: `Helm release web failed to upgrade and was rolled back to its previous revision (resource Deployment/${NS}/web not ready. status: InProgress, message: Available: 0/1)`,
    });
    helm.assertDone();
    shell.assertDone();
  });
});
