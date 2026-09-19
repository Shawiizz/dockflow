import { afterEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../fakes/fake-clock';
import { FakeCluster } from '../../fakes/fake-cluster';
import { FakeHostRunner } from '../../fakes/fake-host-runner';
import { FakeKubeExecutor, fakeNode, type KubeStep, REST } from '../../fakes/fake-kube-executor';
import { assertExecutorInvariants, assertNoSecretLeak } from '../../support/invariants';
import {
  applyIdentityObjects,
  deployerClusterRoleBinding,
  deployerServiceAccount,
  deployerTokenSecret,
  identityManifest,
  KUBECONFIG_DIR_MODE,
  KUBECONFIG_FILE_MODE,
  renderKubeconfig,
  rotateDeployToken,
  waitForDeployerToken,
  writeKubeconfig,
} from '../../../../commands/setup/k3s/identity';
import { K8S_KUBECONFIG_DIR, K8S_KUBECONFIG_PATH } from '../../../../services/orchestrator/kubernetes/constants';
import { SetupStepError } from '../../../../commands/setup/k3s/host-runner';
import { Redactor } from '../../../../utils/redact';

const KEY = 'server_1';
const ENV = 'production';
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB...fixture...\n-----END CERTIFICATE-----\n';
const TOKEN = '9f1c2a3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';

const redactor = new Redactor([TOKEN]);
let runners: FakeHostRunner[] = [];
let kubes: FakeKubeExecutor[] = [];

function host(): FakeHostRunner {
  const runner = new FakeHostRunner();
  runners.push(runner);
  return runner;
}

function scriptedKube(steps: KubeStep[], clock?: FakeClock): FakeKubeExecutor {
  const executor = new FakeKubeExecutor({ node: fakeNode(KEY), script: steps, redactor, clock });
  kubes.push(executor);
  return executor;
}

async function settle(promise: Promise<unknown>, clock: FakeClock, maxMs = 400_000): Promise<unknown> {
  const outcome = promise.then(
    (value) => value,
    (error: unknown) => error,
  );
  await clock.runUntilIdle(maxMs);
  return outcome;
}

afterEach(() => {
  const [hostRunner, kube] = [runners, kubes];
  runners = [];
  kubes = [];
  assertExecutorInvariants({ hostRunner, kube, redactor });
});

describe('deploy identity objects (12.1)', () => {
  it('ServiceAccount, Secret and ClusterRoleBinding match the design exactly', () => {
    const sa = deployerServiceAccount();
    expect(sa.metadata.name).toBe('dockflow-deployer');
    expect(sa.metadata.namespace).toBe('dockflow-system');
    expect(sa.automountServiceAccountToken).toBe(false);
    expect(sa.secrets).toBeUndefined();

    const secret = deployerTokenSecret();
    expect(secret.metadata.name).toBe('dockflow-deployer-token');
    expect(secret.type).toBe('kubernetes.io/service-account-token');
    expect(secret.metadata.annotations).toEqual({ 'kubernetes.io/service-account.name': 'dockflow-deployer' });

    const crb = deployerClusterRoleBinding();
    expect(crb.roleRef).toEqual({ apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' });
    expect(crb.subjects).toEqual([{ kind: 'ServiceAccount', name: 'dockflow-deployer', namespace: 'dockflow-system' }]);
  });

  it('identityManifest joins the three objects with --- separators, each a fresh object', () => {
    const manifest = identityManifest();
    expect(manifest.match(/^---$/gm)).toHaveLength(3);
    expect(manifest).toContain('kind: ServiceAccount');
    expect(manifest).toContain('kind: Secret');
    expect(manifest).toContain('kind: ClusterRoleBinding');
  });
});

describe('applyIdentityObjects (12.1)', () => {
  it('the three objects apply cleanly (schema-validated by FakeCluster) with no data.token yet', async () => {
    const cluster = new FakeCluster();
    const executor = new FakeKubeExecutor({ node: fakeNode(KEY), cluster, redactor, order: 'any' });
    kubes.push(executor);
    await applyIdentityObjects(executor);
    expect(cluster.get('ServiceAccount', 'dockflow-deployer', 'dockflow-system')).toBeDefined();
    expect(cluster.get('Secret', 'dockflow-deployer-token', 'dockflow-system')).toBeDefined();
    expect(cluster.get('ClusterRoleBinding', 'dockflow-deployer')).toBeDefined();
    executor.assertDone();
  });
});

describe('waitForDeployerToken (12.1)', () => {
  it('returns the decoded token once data.token is populated', async () => {
    const executor = scriptedKube([{ args: ['get', 'secrets', REST], respond: { json: { data: { token: Buffer.from(TOKEN).toString('base64') } } } }]);
    await expect(waitForDeployerToken(executor, new FakeClock(), { env: ENV })).resolves.toBe(TOKEN);
    executor.assertDone();
  });

  it('times out after 60s (fake clock) with a message naming the Secret', async () => {
    const clock = new FakeClock();
    const executor = scriptedKube([{ args: ['get', 'secrets', REST], respond: { json: {} }, times: 'any' }], clock);
    const error = (await settle(waitForDeployerToken(executor, clock, { env: ENV }), clock)) as SetupStepError;
    expect(error).toBeInstanceOf(SetupStepError);
    expect(error.message).toBe(`The dockflow-deployer-token Secret of ${ENV} did not populate within 60s`);
    executor.assertDone();
  });
});

describe('rotateDeployToken (12.4)', () => {
  it('deletes the Secret, re-applies the identity objects, then waits for the new token', async () => {
    const calls: string[] = [];
    const steps: KubeStep[] = [
      {
        args: ['delete', REST],
        respond: () => {
          calls.push('delete');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      {
        args: ['apply', REST],
        respond: () => {
          calls.push('apply');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      {
        args: ['get', 'secrets', REST],
        respond: () => {
          calls.push('wait');
          return { exitCode: 0, stdout: JSON.stringify({ data: { token: Buffer.from(TOKEN).toString('base64') } }), stderr: '' };
        },
      },
    ];
    const executor = scriptedKube(steps);
    await expect(rotateDeployToken(executor, new FakeClock(), { env: ENV })).resolves.toBe(TOKEN);
    expect(calls).toEqual(['delete', 'apply', 'wait']);
    executor.assertDone();
  });
});

describe('kubeconfig (12.2)', () => {
  it('ID1 renders the exact golden document', () => {
    const content = renderKubeconfig(CA_PEM, TOKEN);
    expect(content).toBe(
      [
        'apiVersion: v1',
        'kind: Config',
        'clusters:',
        '  - name: dockflow',
        '    cluster:',
        '      server: https://127.0.0.1:6443',
        `      certificate-authority-data: ${Buffer.from(CA_PEM, 'utf8').toString('base64')}`,
        'users:',
        '  - name: dockflow-deployer',
        '    user:',
        `      token: ${TOKEN}`,
        'contexts:',
        '  - name: dockflow',
        '    context:',
        '      cluster: dockflow',
        '      user: dockflow-deployer',
        '      namespace: dockflow-system',
        'current-context: dockflow',
        '',
      ].join('\n'),
    );
  });

  it('ID2 an unchanged file (content, mode, owner) is not rewritten', async () => {
    const runner = host();
    const user = runner.addUser('dockflow');
    const content = renderKubeconfig(CA_PEM, TOKEN);
    runner.seedDir('/var/lib/dockflow', { mode: 0o750, uid: user.uid, gid: user.gid });
    runner.seedDir(K8S_KUBECONFIG_DIR, { mode: KUBECONFIG_DIR_MODE, uid: user.uid, gid: user.gid });
    runner.seedFile(K8S_KUBECONFIG_PATH, content, { mode: KUBECONFIG_FILE_MODE, uid: user.uid, gid: user.gid });
    await expect(writeKubeconfig(runner, user, CA_PEM, TOKEN)).resolves.toBe('unchanged');
    expect(runner.calls.some((call) => call.argv[0] === 'mv' || call.argv.join(' ').includes('.config'))).toBe(false);
    runner.assertDone();
  });

  it('ID3 wrong owner/mode is rewritten with 0600 and the deploy uid/gid', async () => {
    const runner = host();
    const user = runner.addUser('dockflow');
    runner.seedDir('/var/lib/dockflow', { mode: 0o750, uid: user.uid, gid: user.gid });
    runner.seedDir(K8S_KUBECONFIG_DIR, { mode: 0o755, uid: 0, gid: 0 });
    runner.seedFile(K8S_KUBECONFIG_PATH, 'stale', { mode: 0o644, uid: 0, gid: 0 });
    await expect(writeKubeconfig(runner, user, CA_PEM, TOKEN)).resolves.toBe('written');
    const info = await runner.stat(K8S_KUBECONFIG_PATH);
    expect(info).toEqual({ type: 'file', mode: KUBECONFIG_FILE_MODE, uid: user.uid, gid: user.gid, size: expect.any(Number), mtimeMs: expect.any(Number) });
    expect(runner.text(K8S_KUBECONFIG_PATH)).toBe(renderKubeconfig(CA_PEM, TOKEN));
    assertNoSecretLeak(runner, [TOKEN]);
    runner.assertDone();
  });
});
