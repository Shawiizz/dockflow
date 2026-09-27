import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_CHARTS_DIR } from '../../../services/orchestrator/kubernetes/constants';
import {
  classifyKubectlFailure,
  KubeError,
  type KubeErrorReason,
  NO_EXIT_CODE,
} from '../../../services/orchestrator/kubernetes/runtime/errors';
import { helmStderr } from '../../../services/orchestrator/kubernetes/runtime/helm';
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
import { metaErrors, readHelmFixture, scrubViolations } from '../support/kubectl-fixtures';
import { expectCliError } from '../support/matchers';

const NS = 'dockflow-shop-production';
const SECRET = 'values-db-password-4411';
const CHART = 'redis 20.1.0 from https://charts.example.com';

const FIXTURES = join(import.meta.dir, '..', 'fixtures');
const HELM_STDERR = join(FIXTURES, 'helm-stderr');

/** the reasons of the design-04 3.5.5 table; the rest come from the kubectl classifier */
type TableReason = Exclude<HelmFailureReason, KubeErrorReason> | 'ToolMissing' | 'Timeout';

const TABLE_REASONS: TableReason[] = [
  'ToolMissing',
  'Pending',
  'UninstalledOnFailure',
  'RolledBack',
  'NotReady',
  'Timeout',
  'Ownership',
  'ChartNotFound',
  'RepoAuth',
  'RepoUnreachable',
  'RenderError',
  'ValuesSchema',
  'ReleaseNotFound',
];

interface Sample {
  /** the recording, under fixtures/ */
  file: string;
  exitCode: number;
  /** as the executor hands it over (helmStderr) */
  stderr: string;
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** a sample of fixtures/helm-stderr; the one kept with its stdout is a failed `repo update` */
function recorded(file: string): Sample {
  const stdout = join(HELM_STDERR, file.replace(/\.txt$/, '.stdout.txt'));
  const repoUpdate = existsSync(stdout);
  const raw = { exitCode: 1, stdout: repoUpdate ? readText(stdout) : '', stderr: readText(join(HELM_STDERR, file)) };
  return { file: `helm-stderr/${file}`, exitCode: 1, stderr: helmStderr(repoUpdate ? ['repo', 'update'] : [], raw) };
}

/** the upgrade stderr of a fixtures/helm scenario */
function recordedUpgrade(scenario: string): Sample {
  const raw = { exitCode: 1, stdout: '', stderr: readHelmFixture(scenario, 'upgrade-stderr.txt') };
  return { file: `helm/${scenario}/upgrade-stderr.txt`, exitCode: 1, stderr: helmStderr(['upgrade'], raw) };
}

/** the directories of fixtures/helm-stderr, each named after the reason its samples are classified as */
const RECORDED_REASONS = readdirSync(HELM_STDERR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name as HelmFailureReason)
  .sort();

function sampleFiles(reason: HelmFailureReason): string[] {
  const dir = join(HELM_STDERR, reason);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^\d+\.txt$/.test(file))
    .sort()
    .map((file) => `${reason}/${file}`);
}

/** helm missing on a node before setup, recorded with the kubectl samples */
const HELM_MISSING = 'kubectl-stderr/ToolMissing/3.txt';

/** the recordings of `reason`: its directory of fixtures/helm-stderr, and the upgrades of fixtures/helm */
function samplesOf(reason: HelmFailureReason): Sample[] {
  const samples = sampleFiles(reason).map(recorded);
  if (reason === 'RolledBack') return [recordedUpgrade('helm-history-rollback'), ...samples];
  if (reason === 'NotReady') return [recordedUpgrade('helm-status-failed'), ...samples];
  // the path in the text is enough, whatever exit code the transport reports
  if (reason === 'ToolMissing') return [127, 1].map((exitCode) => ({ file: HELM_MISSING, exitCode, stderr: readText(join(FIXTURES, HELM_MISSING)) }));
  return samples;
}

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
  it('has a recording for every reason of the table', () => {
    expect(TABLE_REASONS.filter((reason) => samplesOf(reason).length === 0)).toEqual([]);
  });

  it('every sample of fixtures/helm-stderr is a recording named by meta.json, and scrubbed', () => {
    const meta = JSON.parse(readText(join(HELM_STDERR, 'meta.json'))) as { steps: string[] };
    expect(metaErrors(meta, 'helm')).toEqual([]);
    const files = RECORDED_REASONS.flatMap(sampleFiles);
    expect(files.filter((file) => !meta.steps.some((step) => step.startsWith(`${file}: `)))).toEqual([]);
    expect(meta.steps.length).toBe(files.length);
    const texts = RECORDED_REASONS.flatMap((reason) => readdirSync(join(HELM_STDERR, reason)).map((file) => `${reason}/${file}`));
    expect(scrubViolations(texts.map((path) => ({ path, text: readText(join(HELM_STDERR, path)) })))).toEqual([]);
  });

  for (const reason of [...new Set<HelmFailureReason>([...TABLE_REASONS, ...RECORDED_REASONS])]) {
    it(`classifies every ${reason} sample`, () => {
      for (const { file, exitCode, stderr } of samplesOf(reason)) {
        expect({ file, reason: classifyHelmFailure(exitCode, stderr) }).toEqual({ file, reason });
      }
    });
  }

  it('classifies the recordings the same with the log lines Helm prints first', () => {
    // a failed repo update is left out: its causes are on stdout, which only helmStderr adds
    const raw = RECORDED_REASONS.flatMap((reason) => sampleFiles(reason).map((file) => ({ file, reason, stderr: readText(join(HELM_STDERR, file)) }))).filter(
      ({ file }) => !existsSync(join(HELM_STDERR, file.replace(/\.txt$/, '.stdout.txt'))),
    );
    for (const [scenario, reason] of [
      ['helm-history-rollback', 'RolledBack'],
      ['helm-status-failed', 'NotReady'],
    ] as const) {
      raw.push({ file: `helm/${scenario}/upgrade-stderr.txt`, reason, stderr: readHelmFixture(scenario, 'upgrade-stderr.txt') });
    }
    for (const { file, reason, stderr } of raw) expect({ file, reason: classifyHelmFailure(1, stderr) }).toEqual({ file, reason });
  });

  it('prefers UninstalledOnFailure and RolledBack over the not-ready lines they carry', () => {
    for (const reason of ['UninstalledOnFailure', 'RolledBack'] as const) {
      const carriers = samplesOf(reason).filter((sample) => sample.stderr.includes('not ready. status:'));
      expect(carriers.length).toBeGreaterThan(0);
      for (const { file, stderr } of carriers) expect({ file, reason: classifyHelmFailure(1, stderr) }).toEqual({ file, reason });
    }
  });

  it('falls back to the kubectl classifier for every recorded kubectl stderr sample', () => {
    const root = join(import.meta.dir, '..', 'fixtures', 'kubectl-stderr');
    let checked = 0;
    const reasons = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const reason of reasons.map((entry) => entry.name).sort()) {
      for (const file of readdirSync(join(root, reason)).sort()) {
        const stderr = readFileSync(join(root, reason, file), 'utf8').replace(/\r\n/g, '\n');
        const exitCode = reason === 'ToolMissing' ? 127 : 1;
        expect(`${reason}/${file}: ${classifyHelmFailure(exitCode, stderr)}`).toBe(`${reason}/${file}: ${classifyKubectlFailure(exitCode, stderr)}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('leaves the API server dialled during an operation to the kubectl classifier', () => {
    // on loopback, or on port 6443 of another manager: not a chart repository
    const apiDial = `Error: UPGRADE FAILED: Get "https://127.0.0.1:6443/apis/apps/v1/namespaces/${NS}/deployments/web": dial tcp 127.0.0.1:6443: connect: connection refused\n`;
    expect(classifyHelmFailure(1, apiDial)).toBe('Unreachable');
    const otherManager = 'Error: UPGRADE FAILED: Get "https://10.0.0.11:6443/api/v1/namespaces": dial tcp 10.0.0.11:6443: i/o timeout\n';
    expect(classifyHelmFailure(1, otherManager)).toBe('Unreachable');
  });

  it('a webhook the API server cannot call is the cluster policy, not the chart repository', () => {
    const unanswered = recorded('AdmissionDenied/2.txt').stderr;
    expect(unanswered).toContain('dial tcp');
    expect(classifyHelmFailure(1, unanswered)).toBe('AdmissionDenied');
    // what Helm did about a refusal still comes first
    const removed = recorded('UninstalledOnFailure/3.txt').stderr;
    expect(removed).toContain('denied the request');
    expect(classifyHelmFailure(1, removed)).toBe('UninstalledOnFailure');
  });

  it('classifies an unreachable cluster by the kubectl rules, whatever the wrapper carries', () => {
    // `kubernetes cluster unreachable: ...` holds words of the chart rules: dial tcp, a deadline
    for (const reason of ['Unreachable', 'Unauthorized', 'CertificateMismatch'] as const) {
      for (const { file, stderr } of samplesOf(reason)) {
        expect({ file, wrapped: stderr.includes('Error: kubernetes cluster unreachable: ') }).toEqual({ file, wrapped: true });
        expect({ file, reason: classifyHelmFailure(1, stderr) }).toEqual({ file, reason });
      }
    }
  });
});

describe('helmFailureDetail', () => {
  it('keeps the lines of the watcher when it reported some', () => {
    expect(helmFailureDetail(samplesOf('RolledBack')[0].stderr)).toBe(
      'resource Deployment/fixture-helm-history-rollback/web-e2e-broken not ready. status: InProgress, message: Available: 0/1',
    );
    expect(helmFailureDetail(recorded('UninstalledOnFailure/1.txt').stderr)).toBe(`resource Deployment/${NS}/cache-e2e-broken not ready. status: InProgress, message: Available: 0/1`);
    expect(helmFailureDetail(recorded('UninstalledOnFailure/2.txt').stderr)).toBe(`resource Job/${NS}/jobs-e2e-web-hook not ready. status: Failed, message: Job Failed. failed: 1/1`);
    // an uninstall waits for its objects to be gone
    expect(helmFailureDetail(recorded('Timeout/1.txt').stderr)).toBe(`resource ConfigMap/${NS}/stuck-e2e-web still exists. status: Terminating, message: Resource scheduled for deletion`);
  });

  it("removes `Error: ` prefixes and Helm's wrappers", () => {
    expect(helmFailureDetail(recorded('UninstalledOnFailure/3.txt').stderr)).toBe(
      'server-side apply failed for object dockflow-shop-staging/api-e2e-web apps/v1, Kind=Deployment: admission webhook "images.policy.example.com" denied the request: images from registry.example.com/untrusted are not allowed',
    );
    expect(helmFailureDetail(recorded('Ownership/2.txt').stderr)).toBe(
      `unable to continue with install: ConfigMap "web-e2e-web" in namespace "${NS}" exists and cannot be imported into the current release: invalid ownership metadata; annotation validation error: key "meta.helm.sh/release-name" must equal "web": current value is "search"`,
    );
    expect(helmFailureDetail('Error: UPGRADE FAILED: Error: context deadline exceeded\n')).toBe('context deadline exceeded');
  });

  it('goes on in the next line after a colon, as Helm 4 splits template and schema errors', () => {
    expect(helmFailureDetail(recorded('RenderError/1.txt').stderr)).toBe(
      'e2e-web/templates/hook-job.yaml:1:14; executing "e2e-web/templates/hook-job.yaml" at <.Values.hook.enabled>: nil pointer evaluating interface {}.enabled',
    );
    expect(helmFailureDetail(recorded('ValuesSchema/1.txt').stderr)).toBe(
      "values don't meet the specifications of the schema(s) in the following chart(s): e2e-pvc: - at '/storage': got number, want string",
    );
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
      ['RepoUnreachable', 'server_1 cannot reach https://charts.example.com (the detail)', 'Check outbound HTTPS from the control-plane node.'],
    ];
    for (const [reason, message, suggestion] of rows) {
      await expectCliError(mapped(reason), { type: DeployError, code: ErrorCode.DEPLOY_FAILED, message, suggestion });
    }
  });

  it('says an uninstall that timed out did not remove the release, and names what is left', async () => {
    await expectCliError(helmResultToCliError(recorded('Timeout/1.txt'), context({ operation: 'uninstall', release: 'stuck', timeoutS: 15 })), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: `Helm release stuck was not removed within 15s (resource ConfigMap/${NS}/stuck-e2e-web still exists. status: Terminating, message: Resource scheduled for deletion)`,
      suggestion: 'Run the command again once the objects still being deleted are gone.',
    });
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
      message: `The chart repository refused access to ${CHART}`,
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
    await expectCliError(helmResultToCliError(samplesOf('RolledBack')[0], context()), {
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
    const pending = recorded('Pending/1.txt');
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
