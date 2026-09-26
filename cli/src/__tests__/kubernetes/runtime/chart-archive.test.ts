import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { HelmChartSource, HelmEventSink } from '../../../services/orchestrator/interfaces';
import { M } from '../../../services/orchestrator/messages';
import { HELM_CHARTS_DIR } from '../../../services/orchestrator/kubernetes/constants';
import {
  CHART_REPO_ALIAS,
  type ChartArchiveOptions,
  type ChartRequest,
  chartCachePath,
  chartDisplayOf,
  chartOrigin,
  ociRegistryHost,
  pulledArchiveCandidates,
  repositoriesFile,
  resolveChartArchive,
  resolveTraefikChartArchive,
} from '../../../services/orchestrator/kubernetes/runtime/chart-archive';
import { KubeError, NO_EXIT_CODE } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { helmFailureDetail } from '../../../services/orchestrator/kubernetes/runtime/helm-errors';
import { helmTempDirCommand } from '../../../services/orchestrator/kubernetes/runtime/host';
import { TRAEFIK_CHART_PIN } from '../../../services/orchestrator/kubernetes/versions';
import { ConfigError, DeployError, ErrorCode } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { chartCachePath as fakeCachePath, FakeHelmExecutor, type HelmStep } from '../fakes/fake-helm-executor';
import { fakeNode, REST } from '../fakes/fake-kube-executor';
import { FakeNodeShell, type NodeShellStep } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';
import { expectCliError } from '../support/matchers';

const NS = 'dockflow-shop-production';
const REPO = 'https://charts.example.com';
const OCI_REF = 'oci://registry.example.com:5000/charts/search';
const PASSWORD = 'chart-repo-password-5519';
const TMP = '/var/lib/dockflow/helm/tmp/call.0000000001';
const redactor = new Redactor([PASSWORD]);

const OPTIONS: ChartArchiveOptions = { allowDrift: false, env: 'production', distribution: 'k3s' };

function repoRelease(overrides: Partial<ChartRequest> = {}): ChartRequest {
  return { name: 'cache', namespace: NS, chart: { kind: 'repo', repo: REPO, chart: 'redis' }, version: '20.1.0', auth: null, ...overrides };
}

function ociRelease(overrides: Partial<ChartRequest> = {}): ChartRequest {
  return { name: 'search', namespace: NS, chart: { kind: 'oci', ref: OCI_REF }, version: '2.4.1', auth: null, ...overrides };
}

let fakes: { helm: FakeHelmExecutor; shell: FakeNodeShell } | null = null;

afterEach(() => {
  if (fakes) {
    assertExecutorInvariants({ helm: fakes.helm, nodeShell: fakes.shell, redactor });
    // credentials never outlive the pull, on success and on failure
    expect(fakes.helm.credentialFilesLeft()).toEqual([]);
    expect(fakes.shell.fs('server_1').files('/var/lib/dockflow/helm/tmp')).toEqual([]);
    expect(fakes.helm.calls.some((call) => call.args.includes('--plain-http'))).toBe(false);
  }
  fakes = null;
});

function setup(script: HelmStep[] = [], steps: NodeShellStep[] = []) {
  const shell = new FakeNodeShell(steps, { redactor, interpretFileCommands: true });
  const helm = new FakeHelmExecutor({ redactor, nodeShell: shell, script });
  fakes = { helm, shell };
  const fs = shell.fs(helm.node);
  const deps = { helm, shell: shell.forNode(helm.node) };
  const done = (): void => {
    helm.assertDone();
    shell.assertDone();
  };
  return { helm, shell, fs, deps, done };
}

function scripts(shell: FakeNodeShell): string[] {
  return shell.calls.map((call) => call.script);
}

function events(): HelmEventSink & { warn: ReturnType<typeof mock> } {
  return { step: mock(() => {}), warn: mock(() => {}) };
}

describe('pure helpers', () => {
  it('names cache paths, origins and chart displays', () => {
    expect(chartCachePath('a'.repeat(64))).toBe(`${HELM_CHARTS_DIR}/sha256-${'a'.repeat(64)}.tgz`);
    expect(chartCachePath('a'.repeat(64))).toBe(fakeCachePath('a'.repeat(64)));
    expect(ociRegistryHost(OCI_REF)).toBe('registry.example.com:5000');
    expect(chartOrigin({ kind: 'repo', repo: REPO, chart: 'redis' })).toBe(REPO);
    expect(chartOrigin({ kind: 'oci', ref: OCI_REF })).toBe('registry.example.com:5000');
    expect(chartDisplayOf({ kind: 'repo', repo: 'https://charts.example.org', chart: 'postgresql' }, '16.7.4')).toBe(
      'postgresql 16.7.4 from https://charts.example.org',
    );
    expect(chartDisplayOf({ kind: 'oci', ref: 'oci://registry.example.com/charts/search' }, '2.4.1')).toBe('oci://registry.example.com/charts/search 2.4.1');
  });

  it('looks for the pulled file under the chart name, with and without a v prefix', () => {
    const oci: HelmChartSource = { kind: 'oci', ref: OCI_REF };
    expect(pulledArchiveCandidates(TMP, oci, '2.4.1')).toEqual([`${TMP}/search-2.4.1.tgz`]);
    expect(pulledArchiveCandidates(TMP, { kind: 'repo', repo: REPO, chart: 'redis' }, 'v20.1.0')).toEqual([`${TMP}/redis-v20.1.0.tgz`, `${TMP}/redis-20.1.0.tgz`]);
  });

  it('writes the exact per-call repositories file', () => {
    expect(repositoriesFile(REPO, { username: 'deploy', password: PASSWORD })).toBe(
      `{"apiVersion":"","generated":"0001-01-01T00:00:00Z","repositories":[{"name":"dockflow-repo","url":"${REPO}","username":"deploy","password":"${PASSWORD}"}]}`,
    );
  });
});

describe('resolveChartArchive: cache', () => {
  it('uses a cached archive whose digest matches without any pull (touch only)', async () => {
    const { helm, shell, fs, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    const path = helm.seedCache(sha, 'fake chart archive redis-20.1.0\n');
    expect(await resolveChartArchive(deps, repoRelease(), sha, OPTIONS)).toEqual({ path, sha256: sha });
    expect(helm.calls).toEqual([]);
    expect(scripts(shell)).toEqual([`sha256sum -- '${path}' 2>/dev/null`, `touch -c -- '${path}'`]);
    expect(fs.sha256(path)).toBe(sha);
    done();
  });

  it('deletes a cache entry whose bytes no longer hash to its name and pulls it again', async () => {
    const { helm, shell, fs, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    const path = helm.seedCache(sha, 'corrupt');
    expect(await resolveChartArchive(deps, repoRelease(), sha, OPTIONS)).toEqual({ path, sha256: sha });
    expect(fs.sha256(path)).toBe(sha);
    expect(scripts(shell)).toEqual([
      `sha256sum -- '${path}' 2>/dev/null`,
      `rm -f -- '${path}'`,
      helmTempDirCommand(),
      `sha256sum -- '${TMP}/redis-20.1.0.tgz' 2>/dev/null`,
      `mkdir -p -m 0700 '${HELM_CHARTS_DIR}' && mv -f -- '${TMP}/redis-20.1.0.tgz' '${path}'`,
      `rm -rf -- '${TMP}'`,
    ]);
    expect(helm.calls.map((call) => call.args[0])).toEqual(['pull']);
    done();
  });

  it('pulls a missing archive once and caches it under its digest', async () => {
    const { helm, fs, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    const archive = await resolveChartArchive(deps, repoRelease(), sha, OPTIONS);
    expect(archive).toEqual({ path: chartCachePath(sha), sha256: sha });
    expect(fs.files(HELM_CHARTS_DIR)).toEqual([chartCachePath(sha)]);
    // a second resolution is a verified cache hit
    await resolveChartArchive(deps, repoRelease(), sha, OPTIONS);
    expect(helm.calls.filter((call) => call.args[0] === 'pull')).toHaveLength(1);
    done();
  });
});

describe('resolveChartArchive: pull and verification', () => {
  it('pulls a repository chart with the exact arguments into a call directory, then hashes the file (U-RT-H-02)', async () => {
    const { helm, shell, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    await resolveChartArchive(deps, repoRelease(), sha, OPTIONS);
    expect(helm.calls).toHaveLength(1);
    expect(helm.calls[0]).toMatchObject({
      args: ['pull', 'redis', '--repo', REPO, '--version', '20.1.0', '--destination', TMP],
      mutating: false,
      timeoutS: 120,
      env: {},
      stdin: '',
    });
    expect(scripts(shell)).toContain(`sha256sum -- '${TMP}/redis-20.1.0.tgz' 2>/dev/null`);
    done();
  });

  it('returns a local archive an upgrade can install, never a repository reference (U-RT-H-12)', async () => {
    const { helm, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    const archive = await resolveChartArchive(deps, repoRelease(), null, OPTIONS);
    const upgrade = await helm.run({
      args: ['upgrade', '--install', 'cache', archive.path, '-n', NS, '--values', '-'],
      stdin: '{"replicas":1}\n',
      mutating: true,
      timeoutS: 300,
    });
    expect(upgrade.exitCode).toBe(0);
    expect(helm.release(NS, 'cache')?.latest?.version).toBe('20.1.0');
    expect(archive.sha256).toBe(sha);
    done();
  });

  it('returns the pulled digest when nothing pinned the chart, without a cache lookup', async () => {
    const { helm, shell, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    expect(await resolveChartArchive(deps, repoRelease(), null, OPTIONS)).toEqual({ path: chartCachePath(sha), sha256: sha });
    expect(scripts(shell)[0]).toBe(helmTempDirCommand());
    done();
  });

  it('finds the archive of a v-prefixed version under the name Helm gives it', async () => {
    const { helm, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    expect((await resolveChartArchive(deps, repoRelease({ version: 'v20.1.0' }), sha, OPTIONS)).sha256).toBe(sha);
    expect(helm.calls[0].args).toContain('v20.1.0');
    done();
  });

  it('refuses bytes that differ from the pin with E-HELM-CHART-DIGEST, removes the call directory and caches nothing', async () => {
    const { helm, shell, fs, deps, done } = setup();
    const actual = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO, bytes: 'republished bytes' });
    const expected = 'c'.repeat(64);
    await expectCliError(resolveChartArchive(deps, repoRelease(), expected, OPTIONS), {
      type: DeployError,
      code: ErrorCode.VALIDATION_FAILED,
      message: `The chart of Helm release cache (redis 20.1.0 from ${REPO}) no longer matches the bytes it was pinned to: sha256 ${actual} instead of ${expected}`,
      suggestion: `Check the chart repository; if the new content is trusted, set \`digest: ${actual}\` in config.yml, or re-run with \`--allow-chart-drift\` to install the current bytes.`,
    });
    expect(scripts(shell).at(-1)).toBe(`rm -rf -- '${TMP}'`);
    expect(scripts(shell).some((script) => script.includes('mv -f'))).toBe(false);
    expect(fs.files(HELM_CHARTS_DIR)).toEqual([]);
    done();
  });

  it('refuses a stored release whose chart changed with ROLLBACK_FAILED (U-RT-H-13)', async () => {
    const { helm, deps, done } = setup();
    const actual = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO, bytes: 'republished bytes' });
    const recorded = 'd'.repeat(64);
    const error = await expectCliError(resolveChartArchive(deps, repoRelease(), recorded, { ...OPTIONS, rollback: true }), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
    });
    expect(error.message).toContain(actual);
    expect(error.message).toContain(recorded);
    done();
  });

  it('with --allow-chart-drift warns W-HELM-CHART-DRIFT and caches and returns the new bytes', async () => {
    const { helm, fs, deps, done } = setup();
    const actual = helm.chart({ name: 'redis', version: '20.1.0', repo: REPO, bytes: 'republished bytes' });
    const recorded = 'e'.repeat(64);
    const sink = events();
    expect(await resolveChartArchive(deps, repoRelease(), recorded, { ...OPTIONS, allowDrift: true, events: sink })).toEqual({
      path: chartCachePath(actual),
      sha256: actual,
    });
    expect(sink.warn.mock.calls).toEqual([
      [
        `The chart of Helm release cache has digest ${actual} instead of the recorded ${recorded}, and \`--allow-chart-drift\` was given`,
        'Record the new digest in `config.yml` once you trust it.',
      ],
    ]);
    expect(fs.sha256(chartCachePath(actual))).toBe(actual);
    done();
  });

  it('pulls an OCI chart by reference with --version and no --repo (U-RT-H-03)', async () => {
    const { helm, deps, done } = setup();
    const sha = helm.chart({ name: 'search', version: '2.4.1', oci: OCI_REF });
    expect((await resolveChartArchive(deps, ociRelease(), null, OPTIONS)).sha256).toBe(sha);
    expect(helm.calls.map((call) => call.args)).toEqual([['pull', OCI_REF, '--version', '2.4.1', '--destination', TMP]]);
    done();
  });

  it('pulls from an http:// repository like any other, without --plain-http and without a second warning', async () => {
    const { helm, deps, done } = setup();
    const repo = 'http://charts.example.com';
    helm.chart({ name: 'redis', version: '20.1.0', repo });
    const sink = events();
    await resolveChartArchive(deps, repoRelease({ chart: { kind: 'repo', repo, chart: 'redis' } }), null, { ...OPTIONS, events: sink });
    expect(helm.calls[0].args).toEqual(['pull', 'redis', '--repo', repo, '--version', '20.1.0', '--destination', TMP]);
    expect(sink.warn).not.toHaveBeenCalled();
    done();
  });
});

describe('resolveChartArchive: credentials', () => {
  it('pulls an authenticated repository through a per-call repositories file and repo update (U-RT-H-06)', async () => {
    const { helm, shell, deps, done } = setup();
    const sha = helm.chart({ name: 'redis', version: '20.1.0' });
    const release = repoRelease({ auth: { username: 'deploy', password: PASSWORD } });
    expect((await resolveChartArchive(deps, release, sha, OPTIONS)).sha256).toBe(sha);

    const env = { repositoryConfig: `${TMP}/repositories.yaml`, repositoryCache: `${TMP}/cache` };
    expect(helm.calls.map((call) => ({ args: call.args, env: call.env, mutating: call.mutating, timeoutS: call.timeoutS }))).toEqual([
      { args: ['repo', 'update', CHART_REPO_ALIAS], env, mutating: false, timeoutS: 120 },
      { args: ['pull', `${CHART_REPO_ALIAS}/redis`, '--version', '20.1.0', '--destination', TMP], env, mutating: false, timeoutS: 120 },
    ]);
    const write = shell.calls.find((call) => call.script.startsWith('umask 077 && cat >'));
    expect(write?.script).toBe(`umask 077 && cat > '${TMP}/repositories.yaml'`);
    expect(Buffer.from(write?.stdin ?? new Uint8Array()).toString('utf8')).toBe(repositoriesFile(REPO, { username: 'deploy', password: PASSWORD }));
    expect(scripts(shell).at(-1)).toBe(`rm -rf -- '${TMP}'`);
    expect(helm.credentials.map((record) => record.kind)).toEqual(['repo-update']);
    for (const call of helm.calls) {
      expect(call.args).not.toContain('--repo');
      expect(`${call.commandString} ${call.args.join(' ')}`).not.toContain(PASSWORD);
    }
    done();
  });

  it('removes the call directory even when the authenticated pull fails, and maps the refusal', async () => {
    const { deps, fs, done } = setup([
      { args: ['repo', 'update', CHART_REPO_ALIAS], respond: { exitCode: 0, stdout: 'Update Complete.\n', stderr: '' } },
      { args: ['pull', REST], respond: { exitCode: 1, stdout: '', stderr: `Error: failed to fetch ${REPO}/redis-20.1.0.tgz : 401 Unauthorized\n` } },
    ]);
    await expectCliError(resolveChartArchive(deps, repoRelease({ auth: { username: 'deploy', password: PASSWORD } }), null, OPTIONS), {
      type: ConfigError,
      message: `The chart repository rejected the credentials for redis 20.1.0 from ${REPO}`,
      suggestion: 'Check `helm.releases[].auth` of cache.',
    });
    expect(fs.exists(TMP)).toBe(false);
    done();
  });

  // Helm prints why the index could not be downloaded on stdout; stderr only lists the failed URL
  function repoUpdateFailure(cause: string): HelmStep {
    return {
      args: ['repo', 'update', CHART_REPO_ALIAS],
      respond: {
        exitCode: 1,
        stdout: `Hang tight while we grab the latest from your chart repositories...\n...Unable to get an update from the "${CHART_REPO_ALIAS}" chart repository (${REPO}):\n\t${cause}\n`,
        stderr: `Error: failed to update the following repositories: [${REPO}]\n`,
      },
    };
  }

  it('maps credentials refused while updating the repository index, before any pull', async () => {
    const { helm, deps, fs, done } = setup([repoUpdateFailure(`failed to fetch ${REPO}/index.yaml : 401 Unauthorized`)]);
    await expectCliError(resolveChartArchive(deps, repoRelease({ auth: { username: 'deploy', password: PASSWORD } }), null, OPTIONS), {
      type: ConfigError,
      message: `The chart repository rejected the credentials for redis 20.1.0 from ${REPO}`,
    });
    expect(helm.calls.map((call) => call.args[0])).toEqual(['repo']);
    expect(fs.exists(TMP)).toBe(false);
    done();
  });

  it('names the TLS error of an authenticated repository whose certificate is not trusted', async () => {
    const cause = `Get "${REPO}/index.yaml": tls: failed to verify certificate: x509: certificate signed by unknown authority`;
    const { deps, done } = setup([repoUpdateFailure(cause)]);
    await expectCliError(resolveChartArchive(deps, repoRelease({ auth: { username: 'deploy', password: PASSWORD } }), null, OPTIONS), {
      type: DeployError,
      message: `server_1 cannot reach ${REPO} (${cause}; failed to update the following repositories: [${REPO}])`,
    });
    done();
  });

  it('logs in to an OCI registry with --password-stdin and a per-call registry config (U-RT-H-05)', async () => {
    const { helm, shell, deps, done } = setup();
    const sha = helm.chart({ name: 'search', version: '2.4.1', oci: OCI_REF });
    await resolveChartArchive(deps, ociRelease({ auth: { username: 'deploy', password: PASSWORD } }), sha, OPTIONS);
    const env = { registryConfig: `${TMP}/registry.json` };
    expect(helm.calls.map((call) => ({ args: call.args, env: call.env, stdin: call.stdin, timeoutS: call.timeoutS }))).toEqual([
      {
        args: ['registry', 'login', 'registry.example.com:5000', '--username', 'deploy', '--password-stdin'],
        env,
        stdin: PASSWORD,
        timeoutS: 60,
      },
      { args: ['pull', OCI_REF, '--version', '2.4.1', '--destination', TMP], env, stdin: '', timeoutS: 120 },
    ]);
    expect(helm.credentials).toMatchObject([{ kind: 'registry-login', host: 'registry.example.com:5000', username: 'deploy', passwordStdin: PASSWORD }]);
    expect(scripts(shell).at(-1)).toBe(`rm -rf -- '${TMP}'`);
    done();
  });

  it('stops before the pull when the registry refuses the login, and removes the call directory', async () => {
    const { helm, deps, fs, done } = setup([
      {
        args: ['registry', 'login', REST],
        respond: { exitCode: 1, stdout: '', stderr: 'Error: login attempt to https://registry.example.com:5000/v2/ failed with status: 401 Unauthorized\n' },
      },
    ]);
    await expectCliError(resolveChartArchive(deps, ociRelease({ auth: { username: 'deploy', password: PASSWORD } }), null, OPTIONS), {
      type: ConfigError,
      message: `The chart repository rejected the credentials for ${OCI_REF} 2.4.1`,
    });
    expect(helm.calls.map((call) => call.args[0])).toEqual(['registry']);
    expect(fs.exists(TMP)).toBe(false);
    done();
  });

  it('refuses an OCI registry over plain HTTP with the shared message', async () => {
    const { deps, done } = setup([
      {
        args: ['pull', REST],
        respond: { exitCode: 1, stdout: '', stderr: `Error: Get "https://registry.example.com:5000/v2/": http: server gave HTTP response to HTTPS client\n` },
      },
    ]);
    await expectCliError(resolveChartArchive(deps, ociRelease(), null, OPTIONS), { type: ConfigError, message: M.helmOciPlainHttp(OCI_REF) });
    done();
  });
});

describe('resolveChartArchive: failures', () => {
  it('maps a missing chart version to ConfigError', async () => {
    const { deps, done } = setup();
    await expectCliError(resolveChartArchive(deps, repoRelease({ version: '9.9.9' }), null, OPTIONS), {
      type: ConfigError,
      message: `Chart redis 9.9.9 from ${REPO} was not found`,
      suggestion: 'Check `chart`, `repo` and `version` of cache in config.yml.',
    });
    done();
  });

  const UNREACHABLE: [string, string][] = [
    [
      'an unknown host',
      `Error: looks like "${REPO}" is not a valid chart repository or cannot be reached: Get "${REPO}/index.yaml": dial tcp: lookup charts.example.com: no such host\n`,
    ],
    ['a download timeout', `Error: Get "${REPO}/index.yaml": context deadline exceeded\n`],
    ['a TLS error', `Error: Get "${REPO}/index.yaml": tls: failed to verify certificate: x509: certificate signed by unknown authority\n`],
  ];
  for (const [label, stderr] of UNREACHABLE) {
    it(`maps ${label} while downloading to an unreachable repository`, async () => {
      const { deps, fs, done } = setup([{ args: ['pull', REST], respond: { exitCode: 1, stdout: '', stderr } }]);
      await expectCliError(resolveChartArchive(deps, repoRelease(), null, OPTIONS), {
        type: DeployError,
        code: ErrorCode.DEPLOY_FAILED,
        message: `server_1 cannot reach ${REPO} (${helmFailureDetail(stderr)})`,
        suggestion: 'Check outbound HTTPS from the control-plane node.',
      });
      expect(fs.exists(TMP)).toBe(false);
      done();
    });
  }

  it('lets a lost transport propagate as the KubeError the backend maps, after removing the call directory', async () => {
    const lost = new KubeError('Unreachable', 'Lost the SSH connection to server_1 during helm pull: read ECONNRESET', 'server_1', NO_EXIT_CODE, '');
    const { deps, fs, done } = setup([
      {
        args: ['pull', REST],
        respond: () => {
          throw lost;
        },
      },
    ]);
    await expect(resolveChartArchive(deps, repoRelease(), null, OPTIONS)).rejects.toBe(lost);
    expect(fs.exists(TMP)).toBe(false);
    done();
  });

  it('keeps the original error when removing the call directory fails too', async () => {
    const { deps, done } = setup(
      [{ args: ['pull', REST], respond: { exitCode: 1, stdout: '', stderr: `Error: chart "redis" version "20.1.0" not found in ${REPO} repository\n` } }],
      [{ script: /^rm -rf -- /, respond: { exitCode: 1, stderr: 'rm: cannot remove: Device or resource busy\n' } }],
    );
    await expectCliError(resolveChartArchive(deps, repoRelease(), null, OPTIONS), { type: ConfigError, message: /was not found$/ });
    done();
  });

  it('fails a successful pull whose call directory cannot be removed', async () => {
    const { helm, deps, done } = setup([], [{ script: /^rm -rf -- /, respond: { exitCode: 1, stderr: 'rm: cannot remove: Device or resource busy\n' } }]);
    helm.chart({ name: 'redis', version: '20.1.0', repo: REPO });
    await expect(resolveChartArchive(deps, repoRelease(), null, OPTIONS)).rejects.toThrow(/Removing a Helm temporary directory failed on server_1/);
    done();
  });

  it('names the chart when the pull left no archive under the expected name', async () => {
    const { deps, done } = setup([{ args: ['pull', REST], respond: { exitCode: 0, stdout: '', stderr: '' } }]);
    await expectCliError(resolveChartArchive(deps, repoRelease(), null, OPTIONS), {
      type: DeployError,
      message: `The chart archive of Helm release cache (redis 20.1.0 from ${REPO}) was not found on server_1 after the pull`,
    });
    done();
  });

  it('refuses a pin that is not a sha256 before touching the node', async () => {
    const { helm, deps, done } = setup();
    await expect(resolveChartArchive(deps, repoRelease(), `sha256:${'a'.repeat(64)}`, OPTIONS)).rejects.toThrow(/64 lowercase hex characters/);
    expect(helm.calls).toEqual([]);
    done();
  });

  it('refuses a shell bound to another node than helm', async () => {
    const { shell, helm, done } = setup();
    await expect(resolveChartArchive({ helm, shell: shell.forNode(fakeNode('server_2')) }, repoRelease(), null, OPTIONS)).rejects.toThrow(
      /runs on server_2 but helm runs on server_1/,
    );
    done();
  });
});

describe('resolveTraefikChartArchive', () => {
  const CONTEXT = { env: 'production', distribution: 'k3s' };

  it('uses the archive setup cached without any network call', async () => {
    const { helm, shell, deps, done } = setup();
    const sha = helm.chart({ name: 'traefik', version: TRAEFIK_CHART_PIN.version, repo: TRAEFIK_CHART_PIN.repo });
    const pin = { ...TRAEFIK_CHART_PIN, sha256: sha };
    helm.seedCache(sha, 'fake chart archive traefik-41.6.0\n');
    expect(await resolveTraefikChartArchive(deps, pin, CONTEXT)).toEqual({ path: chartCachePath(sha), sha256: sha });
    expect(helm.calls).toEqual([]);
    expect(scripts(shell)).toHaveLength(2);
    done();
  });

  it('falls back to pulling the pinned chart and verifies it', async () => {
    const { helm, deps, done } = setup();
    const sha = helm.chart({ name: 'traefik', version: TRAEFIK_CHART_PIN.version, repo: TRAEFIK_CHART_PIN.repo });
    const pin = { ...TRAEFIK_CHART_PIN, sha256: sha };
    expect(await resolveTraefikChartArchive(deps, pin, CONTEXT)).toEqual({ path: chartCachePath(sha), sha256: sha });
    expect(helm.calls.map((call) => [call.args, call.timeoutS, call.mutating])).toEqual([
      [['pull', 'traefik', '--repo', 'https://traefik.github.io/charts', '--version', '41.6.0', '--destination', TMP], 120, false],
    ]);
    done();
  });

  it('refuses wrong bytes with E-PX-VERIFY naming both hashes, before any upgrade (U-RT-H-09)', async () => {
    const { helm, fs, deps, done } = setup();
    const actual = helm.chart({ name: 'traefik', version: TRAEFIK_CHART_PIN.version, repo: TRAEFIK_CHART_PIN.repo, bytes: 'rewritten by a proxy' });
    await expectCliError(resolveTraefikChartArchive(deps, TRAEFIK_CHART_PIN, CONTEXT), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: `Traefik chart 41.6.0 failed verification on server_1: expected sha256 cd7254ea853da73bdb88edc896f079b88d43ffa0bfe699fdbf21081361eac365, got ${actual}, and nothing was installed`,
      suggestion: 'Check for a proxy or mirror rewriting downloads from traefik.github.io, then deploy again.',
    });
    expect(helm.calls.map((call) => call.args[0])).toEqual(['pull']);
    expect(fs.files(HELM_CHARTS_DIR)).toEqual([]);
    done();
  });

  it('replaces a corrupt copy of the pinned chart', async () => {
    const { helm, shell, deps, done } = setup();
    const sha = helm.chart({ name: 'traefik', version: TRAEFIK_CHART_PIN.version, repo: TRAEFIK_CHART_PIN.repo });
    helm.seedCache(sha, 'truncated');
    const pin = { ...TRAEFIK_CHART_PIN, sha256: sha };
    expect((await resolveTraefikChartArchive(deps, pin, CONTEXT)).sha256).toBe(sha);
    expect(scripts(shell)[1]).toBe(`rm -f -- '${chartCachePath(sha)}'`);
    done();
  });

  it('reports an unreachable chart repository as E-PX-CHART-FETCH, naming setup', async () => {
    const { deps, done } = setup([
      {
        args: ['pull', REST],
        respond: {
          exitCode: 1,
          stdout: '',
          stderr: 'Error: looks like "https://traefik.github.io/charts" is not a valid chart repository or cannot be reached: Get "https://traefik.github.io/charts/index.yaml": dial tcp: lookup traefik.github.io: no such host\n',
        },
      },
    ]);
    await expectCliError(resolveTraefikChartArchive(deps, TRAEFIK_CHART_PIN, CONTEXT), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message:
        'server_1 cannot download the Traefik chart 41.6.0 from traefik.github.io (looks like "https://traefik.github.io/charts" is not a valid chart repository or cannot be reached: Get "https://traefik.github.io/charts/index.yaml": dial tcp: lookup traefik.github.io: no such host)',
      suggestion: 'Re-run `dockflow setup k3s production`, which downloads and verifies the chart, or allow outbound HTTPS from that node.',
    });
    done();
  });

  it('maps other pull failures like any chart', async () => {
    const { deps, done } = setup([
      { args: ['pull', REST], respond: { exitCode: 1, stdout: '', stderr: 'Error: chart "traefik" version "41.6.0" not found in https://traefik.github.io/charts repository\n' } },
    ]);
    await expectCliError(resolveTraefikChartArchive(deps, TRAEFIK_CHART_PIN, CONTEXT), {
      type: ConfigError,
      message: 'Chart traefik 41.6.0 from https://traefik.github.io/charts was not found',
    });
    done();
  });
});
