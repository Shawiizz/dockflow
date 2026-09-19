import { describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type { ReleaseInput, StackDeployInput, StackRole } from '../../../services/orchestrator/interfaces';
import { HELM_BIN_PATH, HELM_TMP_DIR, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import { HELM_ENV_PREFIX } from '../../../services/orchestrator/kubernetes/runtime/helm';
import { getJsonCall, type KubectlResult, kubectlCommand } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { err, ok } from '../../../types/result';
import { CLIError, DeployError, ErrorCode, UnsupportedOperationError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import {
  assertExecutorInvariants,
  assertNoSecretLeak,
  checkExecutorInvariants,
  type ExecutorInvariantOptions,
  INV08_RELEASE_LIST_TEMPLATE,
  type SshRecorder,
} from '../support/invariants';
import { loadHelmFixture, loadKubectlFixture } from '../support/kubectl-fixtures';
import { expectCliError, expectCommandShape, expectDiagnostics } from '../support/matchers';
import { FakeClock } from './fake-clock';
import { chartCachePath, FakeHelmExecutor } from './fake-helm-executor';
import {
  ANY,
  argDistance,
  FakeKubeExecutor,
  type FakeKubeExecutorOptions,
  fakeNode,
  type KubeCallHandler,
  type KubeRequest,
  type KubeStep,
  matchArgs,
  REST,
} from './fake-kube-executor';
import { CLOSED_CHANNEL_EXIT, FakeNodeShell } from './fake-node-shell';
import { FakeOrchestrator } from './fake-orchestrator';
import { FakeSsh } from './fake-ssh';

const NS = 'dockflow-shop-production';
const SECRET = 'db-password-4242';
const KUBECONFIG = '--kubeconfig=/var/lib/dockflow/kube/config';
const KUBECTL = k3sDistribution.kubectlCommand;
const OK: KubectlResult = { exitCode: 0, stdout: '', stderr: '' };
const HASH = '0123456789abcdef0123456789abcdef';

function redactor(): Redactor {
  return new Redactor([SECRET]);
}

function kubeWith(script: KubeStep[], extra: Partial<FakeKubeExecutorOptions> = {}): FakeKubeExecutor {
  return new FakeKubeExecutor({ redactor: redactor(), script, order: 'any', ...extra });
}

function ids(options: ExecutorInvariantOptions): string[] {
  return checkExecutorInvariants(options).map((violation) => violation.id);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const CONFIG_MAP = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: ${NS}
data:
  mode: production
`;

const CONFIG_MAP_UNKNOWN_FIELD = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: ${NS}
spec:
  mode: production
`;

const DELETE_OPTIONS = `apiVersion: v1
kind: DeleteOptions
preconditions:
  uid: 00000000-0000-4000-8000-000000000001
  resourceVersion: "42"
`;

function helperPod(name: string | null): string {
  const identity = name === null ? '  generateName: dockflow-helper-archive-' : `  name: ${name}`;
  return `apiVersion: v1
kind: Pod
metadata:
${identity}
  namespace: ${NS}
  labels:
    app.kubernetes.io/managed-by: dockflow
    dockflow.shawiizz.dev/part: helper
spec:
  containers:
    - name: helper
      image: busybox:1.37
      command: [sleep, "600"]
  restartPolicy: Never
`;
}

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

describe('FakeClock', () => {
  it('starts on 2026-01-01 and resolves sleeps in due order only when time is advanced', async () => {
    const clock = new FakeClock();
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const woken: string[] = [];
    void clock.sleep(5000).then(() => woken.push('5s'));
    void clock.sleep(2000).then(() => woken.push('2s'));
    await clock.advance(1000);
    expect(woken).toEqual([]);
    await clock.advance(4000);
    expect(woken).toEqual(['2s', '5s']);
    expect(clock.sleeps).toEqual([5000, 2000]);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:05.000Z');
  });

  it('runs a polling loop to completion in fake time and reports the elapsed milliseconds', async () => {
    const clock = new FakeClock();
    let polls = 0;
    const loop = (async () => {
      while (polls < 3) {
        polls += 1;
        await clock.sleep(2000);
      }
    })();
    expect(await clock.runUntilIdle(60_000)).toBe(6000);
    await loop;
    expect(polls).toBe(3);
    expect(clock.sleeps).toEqual([2000, 2000, 2000]);
  });

  it('resolves a sleep as soon as its signal aborts', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(10_000, controller.signal);
    expect(clock.pending).toBe(1);
    controller.abort();
    await sleeping;
    expect(clock.pending).toBe(0);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// FakeKubeExecutor
// ---------------------------------------------------------------------------

describe('FakeKubeExecutor', () => {
  it('matches ANY to one argument, REST to the remaining ones, and a RegExp to one argument', () => {
    expect(matchArgs(['get', 'pods', ANY, '-o', 'json'], ['get', 'pods', 'web-1', '-o', 'json'])).toBe(true);
    expect(matchArgs(['get', 'pods', ANY], ['get', 'pods'])).toBe(false);
    expect(matchArgs(['delete', REST], ['delete'])).toBe(true);
    expect(matchArgs(['delete', REST], ['delete', 'pod/a', '--wait=false'])).toBe(true);
    expect(matchArgs([/^apply$/, REST], ['apply', '-f', '-'])).toBe(true);
    expect(() => matchArgs([REST, 'x'], ['x'])).toThrow(/REST may only be the last argument/);
    expect(argDistance(['get', 'pods', '-o', 'json'], ['get', 'svc', '-o', 'json'])).toBe(1);
  });

  it('records every call with the command string of the real builder', async () => {
    const kube = new FakeKubeExecutor({
      redactor: redactor(),
      script: [{ id: 'K07', args: ['get', 'pods', '-l', ANY, '-o', 'json'], namespace: NS, mutating: false, respond: { json: { items: [{ metadata: { name: 'web-1' } }] } } }],
    });
    const pods = await kube.getJson<{ metadata: { name: string } }>(['pods'], { namespace: NS, selector: 'app=web' });
    expect(pods.map((pod) => pod.metadata.name)).toEqual(['web-1']);
    expect(kube.calls[0].commandString).toBe(kubectlCommand(k3sDistribution, getJsonCall(['pods'], { namespace: NS, selector: 'app=web' })));
    expect(kube.calls[0]).toMatchObject({ method: 'getJson', node: 'server_1', step: 'K07' });
    kube.assertDone();
    expect(kube.asserted).toBe(true);
  });

  it('refuses an out-of-order call in strict mode with the rendered command and the closest steps', async () => {
    const kube = new FakeKubeExecutor({
      redactor: redactor(),
      script: [
        { id: 'first', args: ['get', 'pods', REST], respond: { json: { items: [] } } },
        { id: 'second', args: ['get', 'services', REST], respond: { json: { items: [] } } },
      ],
    });
    const error = await kube.getJson(['services'], { namespace: NS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Unexpected kubectl call on server_1: getJson in namespace dockflow-shop-production: get services -o json');
    expect(message).toContain(`command: ${KUBECTL} ${KUBECONFIG}`);
    expect(message).toContain('next step in order: first');
    expect(message).toContain('closest steps:');
    expect(message).toMatch(/second: get services <REST\.\.\.> \(distance 0/);
    expect(() => kube.assertDone()).toThrow(/unexpected call: getJson in namespace dockflow-shop-production: get services -o json/);
  });

  it('accepts any order when asked, and honours times, optional and times any', async () => {
    const kube = new FakeKubeExecutor({
      redactor: redactor(),
      order: 'any',
      script: [
        { args: ['get', 'pods', REST], respond: { json: { items: [] } }, times: 2 },
        { args: ['get', 'services', REST], respond: { json: { items: [] } } },
        { args: ['get', 'nodes', REST], respond: { json: { items: [] } }, optional: true },
        { args: ['get', 'events', REST], respond: { json: { items: [] } }, times: 'any' },
      ],
    });
    await kube.getJson(['services'], { namespace: NS });
    await kube.getJson(['pods'], { namespace: NS });
    expect(() => kube.assertDone()).toThrow(/was used 1 of 2 time\(s\)/);
    await kube.getJson(['pods'], { namespace: NS });
    kube.assertDone();
  });

  it('answers from recorded fixtures, with the classifier reasons of recorded stderr, and redacts stderr', async () => {
    const kube = kubeWith([
      { args: ['get', 'pods', REST], respond: { fixture: 'crashloop/pods' } },
      { args: ['get', 'deployments.apps', REST], respond: { error: 'NotFound' } },
      { args: ['create', REST], respond: { error: 'AlreadyExists' } },
      { args: ['delete', REST], respond: { error: 'Forbidden' } },
      { args: ['annotate', REST], respond: { exitCode: 1, stdout: '', stderr: `error: token ${SECRET} rejected\n` } },
    ]);
    const pods = await kube.getJson(['pods'], { namespace: NS });
    expect(pods).toEqual(loadKubectlFixture<{ items: unknown[] }>('crashloop', 'pods').items);
    expect(await kube.getJson(['deployments.apps'], { namespace: NS, allowNotFound: true })).toEqual([]);
    expect(await kube.create(CONFIG_MAP, { namespace: NS })).toEqual({ result: 'exists' });
    await expect(kube.delete(['pod/web-1'], { namespace: NS, wait: false, ignoreNotFound: true })).rejects.toMatchObject({ reason: 'Forbidden' });
    const failed = await kube.run({ args: ['annotate', 'deployment/web', 'a=b'], namespace: NS, mutating: true, allowFailure: true });
    expect(failed.stderr).toBe('error: token *** rejected\n');
    kube.assertDone();
  });

  it('turns transportError into Unreachable and hang into Timeout once the local guard elapses on the fake clock', async () => {
    const clock = new FakeClock();
    const kube = kubeWith(
      [
        { args: ['get', 'pods', REST], respond: { transportError: true } },
        { args: ['get', 'services', REST], respond: { hang: true } },
      ],
      { clock },
    );
    await expect(kube.getJson(['pods'], { namespace: NS })).rejects.toMatchObject({ reason: 'Unreachable' });
    const pending = kube.getJson(['services'], { namespace: NS }).catch((e: unknown) => e);
    await clock.advance(44_000);
    await clock.advance(1000);
    const error = await pending;
    expect(error).toBeInstanceOf(KubeError);
    expect((error as KubeError).reason).toBe('Timeout');
    expect(clock.sleeps).toContain(45_000);
    kube.assertDone();
  });

  it('asserts stdin with a callback, a regex or a golden file, and reports a mismatch in assertDone', async () => {
    const goldens = mkdtempSync(join(tmpdir(), 'dockflow-stdin-'));
    try {
      writeFileSync(join(goldens, 'config-map.yaml'), CONFIG_MAP);
      const seen: string[] = [];
      const kube = new FakeKubeExecutor({
        redactor: redactor(),
        stdinGoldenRoot: goldens,
        script: [
          { args: ['apply', REST], stdin: { golden: 'config-map.yaml' }, respond: OK },
          { args: ['create', REST], stdin: (text) => seen.push(text), respond: OK },
          { args: ['replace', REST], stdin: /kind: Lease/, respond: { json: {} } },
        ],
      });
      await kube.apply(CONFIG_MAP, { namespace: NS, dryRun: false });
      await kube.create(CONFIG_MAP, { namespace: NS });
      expect(seen).toEqual([CONFIG_MAP]);
      const notALease = `${CONFIG_MAP.replace('  name: web-config', '  name: web-config\n  resourceVersion: "7"')}`;
      await expect(kube.replace(notALease, { namespace: NS })).rejects.toThrow(/stdin does not match/);
      expect(() => kube.assertDone()).toThrow(/stdin does not match \/kind: Lease\//);
    } finally {
      rmSync(goldens, { recursive: true, force: true });
    }
  });

  it('serves the calls no row matches from the cluster handler, rows first', async () => {
    const seen: KubeRequest[] = [];
    const cluster: KubeCallHandler = {
      handle: (request) => {
        seen.push(request);
        return { exitCode: 0, stdout: '{"items":[]}', stderr: '' };
      },
    };
    const kube = new FakeKubeExecutor({ redactor: redactor(), cluster, script: [{ args: ['get', 'pods', REST], respond: { error: 'Forbidden' } }] });
    await expect(kube.getJson(['pods'], { namespace: NS })).rejects.toMatchObject({ reason: 'Forbidden' });
    expect(await kube.getJson(['services'], { namespace: NS })).toEqual([]);
    expect(seen.map((request) => [request.method, request.call.args[1], request.node.name])).toEqual([['getJson', 'services', 'server_1']]);
    expect(kube.calls.map((call) => call.step)).toEqual(['#0', 'cluster']);
    kube.assertDone();
  });

  it('records the field manager of apply calls', async () => {
    const kube = kubeWith([{ args: ['apply', REST], respond: OK, times: 2 }]);
    await kube.apply(CONFIG_MAP, { namespace: NS, dryRun: false });
    await kube.apply(CONFIG_MAP, { namespace: NS, dryRun: true, fieldManager: 'dockflow-release-state' });
    expect(kube.calls.map((call) => call.fieldManager)).toEqual(['dockflow', 'dockflow-release-state']);
    expect(kube.calls[1].call.args).toContain('--dry-run=server');
    kube.assertDone();
  });

  it('streams a channel: stdin is recorded, the answer comes after EOF, close() ends it without an answer', async () => {
    const kube = kubeWith([
      { method: 'channel', args: [/tar xf -/], respond: { exitCode: 0, stdout: 'done\n', stderr: '' } },
      { method: 'channel', args: [/logs -f/], respond: { hang: true } },
    ]);
    const copy = await kube.channel('K exec -i web-1 -- tar xf - -C /data');
    let out = '';
    copy.stdout.on('data', (chunk: unknown) => {
      out += String(chunk);
    });
    copy.stdin.end('tar bytes');
    expect(await copy.done).toEqual({ exitCode: 0 });
    expect(out).toBe('done\n');
    expect(kube.calls[0].stdinText).toBe('tar bytes');

    const logs = await kube.channel('K logs -f web-1');
    logs.stdout.resume();
    logs.close();
    expect(await logs.done).toEqual({ exitCode: CLOSED_CHANNEL_EXIT });
    expect(kube.calls[1].closed).toBe(true);
    kube.assertDone();
  });

  it('runs shell scripts with stdin and output handlers, streams, interactive sessions, and records command() without matching', async () => {
    const kube = kubeWith([
      { method: 'shell', args: [/gzip/], stdin: /^dump$/, respond: { exitCode: 0, stdout: 'bytes', stderr: `warning ${SECRET}\n` } },
      { method: 'stream', args: ['logs', REST], respond: { exitCode: 0, stdout: 'line 1\n', stderr: '' } },
      { method: 'interactive', args: [ANY], respond: { exitCode: 3, stdout: '', stderr: '' } },
    ]);
    const chunks: string[] = [];
    const lines: string[] = [];
    const result = await kube.shell({
      script: 'K exec -i db-0 -- pg_dump | gzip > /tmp/x',
      stdin: 'dump',
      guardS: 60,
      onStdout: (chunk) => chunks.push(chunk.toString('utf8')),
      onStderr: (line) => lines.push(line),
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: 'warning ***\n' });
    expect(chunks).toEqual(['bytes']);
    expect(lines).toEqual(['warning ***\n']);
    const streamed: string[] = [];
    const code = await kube.stream({ args: ['logs', '-f', 'web-1'], namespace: NS, requestTimeoutS: null }, { stdout: (c) => streamed.push(c), stderr: () => {} });
    expect([code, streamed]).toEqual([0, ['line 1\n']]);
    expect(await kube.interactive('K exec -it web-1 -- sh')).toBe(3);
    const command = kube.command(['logs', '-f', 'web-1'], NS);
    expect(command).toBe(`${KUBECTL} ${KUBECONFIG} -n '${NS}' 'logs' '-f' 'web-1'`);
    expect(kube.calls.map((call) => call.method)).toEqual(['shell', 'stream', 'interactive', 'command']);
    kube.assertDone();
  });
});

// ---------------------------------------------------------------------------
// FakeHelmExecutor
// ---------------------------------------------------------------------------

describe('FakeHelmExecutor', () => {
  function setup() {
    const shell = new FakeNodeShell([], { redactor: redactor() });
    const helm = new FakeHelmExecutor({ redactor: redactor(), nodeShell: shell });
    const sha = helm.chart({ name: 'redis', version: '20.1.0', bytes: 'redis-archive-bytes', repo: 'https://charts.example.com' });
    return { shell, helm, sha };
  }

  function upgrade(path: string, extra: string[] = [], stdin = '{"replicas":2}\n') {
    return {
      args: ['upgrade', '--install', 'cache', path, '-n', NS, '--history-max', '5', '--values', '-', '--timeout', '300s', ...extra],
      stdin,
      mutating: true,
      timeoutS: 300,
    };
  }

  it('pulls chart archives into the node file system it shares with FakeNodeShell', async () => {
    const { shell, helm, sha } = setup();
    const dir = `${HELM_TMP_DIR}/call.0001`;
    shell.fs('server_1').mkdir(dir, { parents: true });
    const result = await helm.run({
      args: ['pull', 'redis', '--repo', 'https://charts.example.com', '--version', '20.1.0', '--destination', dir],
      mutating: true,
      timeoutS: 60,
    });
    expect(result.stdout).toContain(`Digest: sha256:${sha}`);
    expect(shell.fs('server_1').sha256(`${dir}/redis-20.1.0.tgz`)).toBe(sha);
    expect(helm.calls[0].commandString.startsWith(HELM_ENV_PREFIX)).toBe(true);
    helm.assertDone();
  });

  it('keeps the spec hash as a release label, never as an annotation (PD-3), and filters listings by label', async () => {
    const { helm, sha } = setup();
    const path = helm.seedCache(sha, 'redis-archive-bytes');
    expect(path).toBe(chartCachePath(sha));
    await helm.run(upgrade(path, ['--labels', `${LABELS.specHash}=${HASH},${LABELS.stack}=shop-production`]));
    const release = helm.release(NS, 'cache');
    expect(release?.labels).toEqual({ [LABELS.specHash]: HASH, [LABELS.stack]: 'shop-production' });
    expect(release?.annotations).toEqual({});
    expect(release?.latest?.values).toEqual({ replicas: 2 });
    expect(helm.storageSecrets(NS)[0].labels).toMatchObject({ owner: 'helm', name: 'cache', status: 'deployed', version: '1', [LABELS.specHash]: HASH });
    const matching = await helm.json<{ name: string; revision: string }[]>(['list', '-n', NS, '-l', `${LABELS.specHash}=${HASH}`]);
    expect(matching?.map((row) => [row.name, row.revision])).toEqual([['cache', '1']]);
    expect(await helm.json<unknown[]>(['list', '-n', NS, '-l', `${LABELS.specHash}=ffffffffffffffffffffffffffffffff`])).toEqual([]);
    helm.assertDone();
  });

  it('refuses a repository reference as the chart of an upgrade (cross-cutting rule 15)', async () => {
    const { helm } = setup();
    await expect(helm.run({ args: ['upgrade', '--install', 'cache', 'bitnami/redis', '-n', NS], mutating: true, timeoutS: 300 })).rejects.toThrow(
      /is not a local \.tgz/,
    );
    expect(() => helm.assertDone()).toThrow(/cross-cutting rule 15/);
  });

  it('models failNext with --rollback-on-failure as a failed revision plus a rollback, trimmed to --history-max', async () => {
    const { helm, sha } = setup();
    const path = helm.seedCache(sha, 'redis-archive-bytes');
    await helm.run(upgrade(path));
    helm.failNext('cache', 'Error: context deadline exceeded');
    await expect(helm.run(upgrade(path, ['--rollback-on-failure', '--history-max', '2'], '{"replicas":3}'))).rejects.toMatchObject({ reason: 'Timeout' });
    const release = helm.release(NS, 'cache');
    expect(release?.revisions.map((revision) => [revision.revision, revision.status])).toEqual([
      [2, 'failed'],
      [3, 'deployed'],
    ]);
    expect(release?.latest?.description).toBe('Rollback to 1');
    expect(release?.latest?.values).toEqual({ replicas: 2 });
    helm.assertDone();
  });

  it('answers reads, counts status calls, returns null for a missing release, and lets script steps answer first', async () => {
    const { helm, sha } = setup();
    const scripted = new FakeHelmExecutor({ redactor: redactor(), script: [{ args: ['list', REST], respond: { fixture: 'helm-list/list-app.json' } }] });
    expect(await scripted.json(['list', '-n', NS])).toEqual(loadHelmFixture('helm-list', 'list-app'));
    expect(scripted.calls[0].step).toBe('#0');
    scripted.assertDone();

    await helm.run(upgrade(helm.seedCache(sha, 'redis-archive-bytes')));
    expect(await helm.json<Record<string, unknown>>(['get', 'values', 'cache', '-n', NS])).toEqual({ replicas: 2 });
    expect(await helm.json<{ revision: number }[]>(['history', 'cache', '-n', NS])).toEqual([
      expect.objectContaining({ revision: 1, status: 'deployed', chart: 'redis-20.1.0' }),
    ]);
    expect(await helm.json(['history', 'missing', '-n', NS])).toBeNull();
    expect(helm.statusCalls).toBe(0);
    await helm.json(['status', 'cache', '-n', NS]);
    expect(helm.statusCalls).toBe(1);
    helm.assertDone();
  });

  it('records registry credentials sent on stdin and the credential files left on the node', async () => {
    const { helm } = setup();
    const registryConfig = `${HELM_TMP_DIR}/call.0002/registry.json`;
    await helm.run({
      args: ['registry', 'login', 'registry.example.com', '--username', 'deploy', '--password-stdin'],
      stdin: `${SECRET}\n`,
      mutating: true,
      timeoutS: 30,
      env: { registryConfig },
    });
    expect(helm.credentials[0]).toMatchObject({ kind: 'registry-login', host: 'registry.example.com', username: 'deploy', passwordStdin: `${SECRET}\n` });
    expect(helm.credentialFilesLeft()).toEqual([registryConfig]);
    expect(helm.calls[0].args.join(' ')).not.toContain(SECRET);
    helm.assertDone();
  });

  it('seeds the verified cache, including a corrupt entry whose bytes do not hash to its name', () => {
    const { helm } = setup();
    const name = '0'.repeat(64);
    const path = helm.seedCache(name, 'corrupt');
    expect(helm.fs.sha256(path)).toBe(sha256('corrupt'));
    expect(helm.fs.sha256(path)).not.toBe(name);
  });
});

// ---------------------------------------------------------------------------
// FakeNodeShell
// ---------------------------------------------------------------------------

describe('FakeNodeShell', () => {
  it('binds one NodeShell per node, returns non-zero exits and redacts stderr', async () => {
    const shell = new FakeNodeShell([{ node: 'agent_1', script: /^crictl images/, respond: { exitCode: 1, stderr: `denied ${SECRET}` } }], { redactor: redactor() });
    const agent = shell.forNode(fakeNode('agent_1'));
    expect(agent.node.name).toBe('agent_1');
    expect(await agent.run('crictl images -o json', { guardS: 30 })).toEqual({ exitCode: 1, stdout: '', stderr: 'denied ***' });
    expect(shell.calls[0]).toMatchObject({ node: 'agent_1', kind: 'run', step: '#0' });
    shell.assertDone();
  });

  it('measures the peak of concurrent calls under concurrencyProbe', async () => {
    const shell = new FakeNodeShell([{ script: /images import/, respond: { exitCode: 0 }, times: 'any' }], { redactor: redactor(), concurrencyProbe: true });
    await Promise.all(['server_1', 'agent_1', 'agent_2'].map((name) => shell.forNode(fakeNode(name)).run('ctr images import -', { guardS: null })));
    expect(shell.peakConcurrency).toBe(3);
    shell.assertDone();
  });

  it('gunzips stdin before a stdin assertion when the script starts with gzip -dc', async () => {
    let seen = '';
    const shell = new FakeNodeShell(
      [{ script: /^gzip -dc/, kind: 'run', stdin: (bytes) => (seen = Buffer.from(bytes).toString('utf8')), respond: { exitCode: 0 } }],
      { redactor: redactor() },
    );
    await shell.forNode(fakeNode('agent_1')).run('gzip -dc | ctr images import -', { stdin: new Uint8Array(gzipSync(Buffer.from('image tar'))), guardS: null });
    expect(seen).toBe('image tar');
    shell.assertDone();
  });

  it('streams a channel and reports transport errors as Unreachable', async () => {
    const shell = new FakeNodeShell(
      [
        { script: /^cat > /, kind: 'channel', respond: { exitCode: 0, stdout: 'ok\n' } },
        { script: /^df /, respond: { transportError: true } },
      ],
      { redactor: redactor() },
    );
    const node = shell.forNode(fakeNode('server_1'));
    const channel = await node.channel('cat > /var/backups/db.gz');
    channel.stdout.resume();
    channel.stdin.end('payload');
    expect(await channel.done).toEqual({ exitCode: 0 });
    expect(Buffer.from(shell.calls[0].stdin).toString('utf8')).toBe('payload');
    await expect(node.run('df -h /var/lib', { guardS: 30 })).rejects.toMatchObject({ reason: 'Unreachable' });
    shell.assertDone();
  });

  it('refuses a script no step matches, and runs plain file commands through the interpreter when enabled', async () => {
    const strict = new FakeNodeShell([], { redactor: redactor() });
    await expect(strict.forNode(fakeNode('server_1')).run('rm -rf /data', { guardS: 30 })).rejects.toThrow(/Unexpected node command \[run on server_1\] rm -rf \/data/);
    expect(() => strict.assertDone()).toThrow(/unexpected node command/);

    const shell = new FakeNodeShell([], { redactor: redactor(), interpretFileCommands: true });
    const file = '/var/cache/dockflow/sha256/f';
    const result = await shell
      .forNode(fakeNode('server_1'))
      .run(`umask 077 && mkdir -p /var/cache/dockflow/sha256 && echo hello > ${file} && sha256sum ${file}`, { guardS: 30 });
    expect(result).toEqual({ exitCode: 0, stdout: `${sha256('hello\n')}  ${file}\n`, stderr: '' });
    expect(shell.fs('server_1').mode(file)).toBe(0o600);
    expect(shell.calls[0].step).toBe('interpreter');
    shell.assertDone();
  });
});

// ---------------------------------------------------------------------------
// FakeOrchestrator
// ---------------------------------------------------------------------------

function deployInput(role: StackRole, version: string, previousVersion: string | null = null): StackDeployInput {
  return {
    ref: { project: 'shop', env: 'production', role },
    version,
    compose: { raw: {}, services: {} },
    proxy: undefined,
    services: null,
    previousVersion,
    force: false,
    images: { built: [], mode: 'none', pullSecretName: null },
    helm: [],
    helmDeclared: [],
    sibling: { services: [], volumes: [], middlewares: [] },
    serverNames: ['server_1', 'agent_1'],
    files: () => ({ ok: false, reason: 'missing' }),
    rebindVolumes: false,
    traefikOnCluster: false,
  };
}

function releaseInput(version: string, epoch: number): ReleaseInput {
  return {
    version,
    compose: `# compose ${version}\n`,
    artifact: { format: 'k8s-manifests/1', role: 'app', content: '', helm: [], diagnostics: [], digest: `digest-${version}` },
    metadata: {
      project_name: 'shop',
      version,
      env: 'production',
      timestamp: '2026-01-01T00:00:00.000Z',
      epoch,
      performer: 'test',
      branch: 'main',
    },
  };
}

describe('FakeOrchestrator', () => {
  it('is a complete bundle per kind, with the capability table and overrides', () => {
    const k3s = new FakeOrchestrator('k3s');
    expect(k3s.capabilities).toMatchObject({ revert: 'backend', helm: true, volumes: true, artifactFormat: 'k8s-manifests/1' });
    expect(k3s.helm).not.toBeNull();
    expect(k3s.target).toMatchObject({ kind: 'k3s', project: 'shop', env: 'production', stackName: 'shop-production' });
    expect(k3s.target.controlPlane.name).toBe('server_1');
    const ref = { project: 'shop', env: 'production', role: 'accessory' as const };
    expect([k3s.naming.scope(ref), k3s.naming.describe(ref), k3s.naming.serviceNativeName(ref, 'web_app')]).toEqual([
      NS,
      `namespace ${NS} (accessories)`,
      'web-app',
    ]);
    const swarm = new FakeOrchestrator('swarm', { capabilities: { volumes: true } });
    expect(swarm.helm).toBeNull();
    expect(swarm.capabilities).toMatchObject({ revert: 'native', volumes: true, artifactFormat: 'swarm-compose/1' });
    expect(swarm.naming.serviceNativeName(ref, 'db')).toBe('shop-production-accessories_db');
    expect(swarm.releases.hookWorkingDir('shop-production')).toBe('/var/lib/dockflow/stacks/shop-production/current');
    expect(k3s.releases.hookWorkingDir('shop-production')).toBe('/var/lib/dockflow/hooks/shop-production');
  });

  it('logs every call in order with its role or version, and records the arguments', async () => {
    const o = new FakeOrchestrator('k3s');
    const lock = o.lock('shop-production');
    expect((await lock.acquire({ version: '1.2.0' })).success).toBe(true);
    await o.images.distribute(['shop-web:1.2.0'], [o.target.controlPlane]);
    o.stack.render(deployInput('app', '1.2.0'));
    await o.releases.create('shop-production', releaseInput('1.2.0', 1));
    const deployed = await o.stack.deploy(deployInput('accessory', '1.2.0'));
    if (!deployed.success) throw deployed.error;
    await o.stack.waitConvergence(deployed.data, { timeoutS: 300, intervalS: 2 });
    await o.stack.finalize(deployed.data);
    await o.releases.remove('shop-production', '1.2.0', { restoreCurrentTo: null });
    await lock.release();
    expect(o.events).toEqual([
      'lock.acquire',
      'images.distribute',
      'stack.render:app',
      'releases.create:1.2.0',
      'stack.deploy:accessory',
      'stack.waitConvergence:accessory',
      'stack.finalize:accessory',
      'releases.remove:1.2.0',
      'lock.release',
    ]);
    expect(o.callsTo('releases.remove')).toEqual([['shop-production', '1.2.0', { restoreCurrentTo: null }]]);
    expect(deployed.data).toMatchObject({ version: '1.2.0', skipped: false, artifactDigest: 'fake-accessory-1.2.0', changes: [] });
  });

  it('returns programmed values, errors and implementations, once-results first', async () => {
    const o = new FakeOrchestrator('k3s');
    const failure = { service: 'web', reason: 'CrashLoopBackOff', message: 'web exited with 1' };
    o.program('stack.waitConvergence', { status: 'failed', failures: [failure] });
    o.program('stack.exists', true);
    o.programOnce('stack.exists', false);
    o.program('releases.remove', new DeployError('lost'));
    const scaled: number[] = [];
    o.program('stack.scale', async (_ref, _service, replicas) => {
      scaled.push(replicas);
    });
    o.program('stack.deploy', err(new DeployError('apply refused')));
    const ref = { project: 'shop', env: 'production', role: 'app' as const };
    const receipt = { ref, version: '1.2.0', startedAt: new Date(0), services: null, skipped: false, artifactDigest: '', changes: [], helm: [], helmChanges: [], helmDeclared: [], previousVersion: null };
    expect(await o.stack.waitConvergence(receipt, { timeoutS: 1, intervalS: 1 })).toEqual({ status: 'failed', failures: [failure] });
    expect([await o.stack.exists(ref), await o.stack.exists(ref)]).toEqual([false, true]);
    await expect(o.releases.remove('shop-production', '1.2.0')).rejects.toThrow('lost');
    await o.stack.scale(ref, 'web', 3, { wait: false, timeoutS: 60 });
    expect(scaled).toEqual([3]);
    const deployed = await o.stack.deploy(deployInput('app', '1.2.0'));
    expect(deployed.success).toBe(false);
    o.program('stack.render', new DeployError('untranslatable accessories file'));
    expect(() => o.stack.render(deployInput('accessory', '1.2.0'))).toThrow('untranslatable accessories file');
    expect(o.events.at(-1)).toBe('stack.render:accessory');
  });

  it('makes every remote call throw SSH touched after forbidRemoteWork, while render and naming stay local', async () => {
    const o = new FakeOrchestrator('k3s');
    expect(o.remoteWorkTripped).toBe(false);
    o.forbidRemoteWork();
    expect(o.stack.render(deployInput('app', '0.0.0-validate')).format).toBe('k8s-manifests/1');
    expect(o.naming.scope({ project: 'shop', env: 'production', role: 'app' })).toBe(NS);
    expect(o.remoteWorkTripped).toBe(false);
    await expect(o.stack.exists({ project: 'shop', env: 'production', role: 'app' })).rejects.toThrow('SSH touched: stack.exists');
    await expect(o.lock('shop-production').acquire()).rejects.toThrow('SSH touched: lock.acquire');
    expect(o.forbiddenCalls).toEqual(['stack.exists', 'lock.acquire']);
    expect(o.remoteWorkTripped).toBe(true);
  });

  it('keeps releases in memory: previous, newest first, removal restoring current, prune keeping current', async () => {
    const o = new FakeOrchestrator('k3s');
    const stack = 'shop-production';
    expect(await o.releases.create(stack, releaseInput('1.0.0', 1))).toEqual({ previous: null });
    expect(await o.releases.create(stack, releaseInput('1.1.0', 2))).toEqual({ previous: '1.0.0' });
    o.seedRelease(stack, { version: '1.2.0', epoch: 3 });
    expect((await o.releases.list(stack)).map((m) => m.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(await o.releases.currentVersion(stack)).toBe('1.2.0');
    await o.releases.remove(stack, '1.2.0', { restoreCurrentTo: '1.1.0' });
    expect(o.storedReleases(stack)).toEqual({ current: '1.1.0', accessoriesDigest: null, versions: ['1.1.0', '1.0.0'] });
    expect(await o.releases.readCompose(stack, '1.0.0')).toBe('# compose 1.0.0\n');
    await expectCliError(o.releases.readArtifact(stack, '9.9.9'), { type: DeployError, code: ErrorCode.ROLLBACK_FAILED, message: /9\.9\.9/ });
    await o.releases.writeAccessoriesDigest(stack, 'abc');
    expect(await o.releases.readState(stack)).toEqual({ current: '1.1.0', accessoriesDigest: 'abc' });
    await o.releases.setCurrent(stack, '1.0.0');
    expect((await o.releases.prune(stack, 1)).map((m) => m.version)).toEqual(['1.1.0']);
    expect(o.storedReleases(stack).versions).toEqual(['1.0.0']);
  });

  it('models the deploy lock: a second acquire is refused unless forced, release frees it', async () => {
    const o = new FakeOrchestrator('k3s');
    const first = o.lock('shop-production');
    const second = o.lock('shop-production');
    expect((await first.acquire({ message: 'deploy' })).success).toBe(true);
    const refused = await second.acquire();
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.message).toMatch(/^Already locked by test/);
    expect((await second.acquire({ force: true, version: '1.2.0' })).success).toBe(true);
    expect(o.lockHolder('shop-production')?.version).toBe('1.2.0');
    const status = await first.status();
    expect(status.success && status.data.locked).toBe(true);
    await first.release();
    expect(o.lockHolder('shop-production')).toBeNull();
  });

  it('has healthy defaults for the other backends', async () => {
    const o = new FakeOrchestrator('k3s');
    const ref = { project: 'shop', env: 'production', role: 'app' as const };
    expect(await o.images.ensurePullSecret(ref, { server: 'registry.example.com', username: 'u', password: SECRET })).toBe('dockflow-registry');
    await expectCliError(() => o.images.pruneRuntime([o.target.controlPlane], 'networks'), { type: UnsupportedOperationError });
    expect((await o.cluster.nodes()).map((node) => [node.name, node.server, node.role])).toEqual([
      ['server-1', 'server_1', 'manager'],
      ['agent-1', 'agent_1', 'worker'],
    ]);
    expect(await o.proxy.ensure({ enabled: true }, 'production')).toEqual({ changed: false, action: 'unchanged', version: null });
    expect(await o.helm?.plan([], 'shop-production')).toEqual([]);
    expect(await o.volumes.remove({ project: 'shop', env: 'production', role: 'app' }, ['data'])).toEqual({
      deleted: [{ claim: 'data', volume: null }],
      restored: [],
      restoreFailed: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('assertExecutorInvariants', () => {
  it('passes for a clean, asserted script and fails a fake that was never assertDone()d', async () => {
    const kube = kubeWith([{ args: ['get', 'pods', REST], respond: { json: { items: [] } } }]);
    await kube.getJson(['pods'], { namespace: NS });
    expect(ids({ kube })).toEqual(['ASSERT-DONE']);
    expect(() => assertExecutorInvariants({ kube })).toThrow(/ASSERT-DONE a FakeKubeExecutor on server_1 was constructed but never asserted/);
    kube.assertDone();
    assertExecutorInvariants({ kube, redactor: redactor() });
    const helm = new FakeHelmExecutor({ redactor: redactor() });
    const nodeShell = new FakeNodeShell([], { redactor: redactor() });
    const ssh = new FakeSsh([]);
    const hostRunner = { calls: [], asserted: false };
    const violations = checkExecutorInvariants({ helm, nodeShell, ssh, hostRunner });
    expect(violations.map((v) => v.id)).toEqual(['ASSERT-DONE', 'ASSERT-DONE', 'ASSERT-DONE', 'ASSERT-DONE']);
    expect(violations.map((v) => v.message)).toContain('a FakeSsh was constructed but never asserted with assertDone()');
    ssh.assertDone();
    expect(ids({ ssh })).toEqual([]);
  });

  it('INV-01: a mutating verb flagged mutating: false', async () => {
    const kube = kubeWith([{ args: [/^(scale|rollout)$/, REST], respond: OK, times: 'any' }]);
    await kube.run({ args: ['scale', 'deployment/web', '--replicas=2'], namespace: NS, mutating: false });
    await kube.run({ args: ['rollout', 'restart', 'deployment/web'], namespace: NS, mutating: false });
    await kube.run({ args: ['rollout', 'status', 'deployment/web'], namespace: NS, mutating: false });
    await kube.run({ args: ['scale', 'deployment/web', '--replicas=3'], namespace: NS, mutating: true });
    kube.assertDone();
    const violations = checkExecutorInvariants({ kube });
    expect(violations.map((v) => v.id)).toEqual(['INV-01', 'INV-01']);
    expect(violations[1].message).toContain('rollout is flagged mutating: false');
  });

  it('INV-02: a registered secret in argv, base64 or URL-encoded, but never in stdin', async () => {
    const special = 'p@ss word/42!';
    const r = new Redactor([SECRET, special]);
    const kube = new FakeKubeExecutor({ redactor: r, order: 'any', script: [{ args: [/^(annotate|apply)$/, REST], respond: OK, times: 'any' }] });
    const secret = `apiVersion: v1
kind: Secret
metadata:
  name: db
  namespace: ${NS}
type: Opaque
data:
  password: ${Buffer.from(SECRET).toString('base64')}
`;
    await kube.apply(secret, { namespace: NS, dryRun: false });
    kube.assertDone();
    expect(ids({ kube, redactor: r })).toEqual([]);
    await kube.run({ args: ['annotate', 'deployment/web', `note=${SECRET}`], namespace: NS, mutating: true });
    await kube.run({ args: ['annotate', 'deployment/web', `note=${Buffer.from(SECRET).toString('base64')}`], namespace: NS, mutating: true });
    await kube.run({ args: ['annotate', 'deployment/web', `url=https://x.example.com/?p=${encodeURIComponent(special)}`], namespace: NS, mutating: true });
    const violations = checkExecutorInvariants({ kube, redactor: r });
    expect(violations.map((v) => v.id)).toEqual(['INV-02', 'INV-02', 'INV-02']);
    expect(JSON.stringify(violations)).not.toContain(SECRET);

    const nodeShell = new FakeNodeShell([{ script: /echo/, respond: { exitCode: 0 } }], { redactor: r });
    await nodeShell.forNode(fakeNode('agent_1')).run(`echo ${SECRET} > /tmp/x`, { guardS: 30 });
    nodeShell.assertDone();
    const hostRunner = { calls: [{ argv: ['k3s', 'agent'], env: { K3S_TOKEN: SECRET }, input: SECRET }], asserted: true };
    const hostRunnerStdinOnly = { calls: [{ argv: ['k3s', 'agent'], input: SECRET }], asserted: true };
    const setupTransport = { calls: [{ command: `sudo -n dockflow setup --token ${SECRET}` }], asserted: true };
    expect(ids({ nodeShell, hostRunner, setupTransport, redactor: r })).toEqual(['INV-02', 'INV-02', 'INV-02']);
    expect(ids({ hostRunner: hostRunnerStdinOnly, redactor: r })).toEqual([]);
  });

  it('INV-03: no Namespace deletion, checked structurally; a --raw Lease delete passes', async () => {
    const kube = kubeWith([{ args: ['delete', REST], respond: OK, times: 'any' }]);
    await kube.delete(['namespace', 'dockflow-other'], { wait: false, ignoreNotFound: true });
    await kube.delete(['ns/dockflow-other'], { wait: false, ignoreNotFound: true });
    await kube.run({ args: ['delete', '-f', '-'], stdin: 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: dockflow-other\n', mutating: true });
    await kube.run({ args: ['delete', '--raw=/api/v1/namespaces/dockflow-other', '-f', '-'], stdin: DELETE_OPTIONS, mutating: true });
    expect(ids({ kube })).toEqual(['ASSERT-DONE', 'INV-03', 'INV-03', 'INV-03', 'INV-03']);

    const lease = kubeWith([{ args: ['delete', REST], respond: OK }]);
    await lease.run({
      args: ['delete', '--raw=/apis/coordination.k8s.io/v1/namespaces/dockflow-system/leases/lock-shop-production', '-f', '-'],
      stdin: DELETE_OPTIONS,
      mutating: true,
    });
    lease.assertDone();
    expect(ids({ kube: lease })).toEqual([]);
  });

  it('INV-04: no PVC or PV deletion and no reclaim-policy patch without allow.volumeDeletion', async () => {
    const kube = kubeWith([{ args: [/^(delete|patch)$/, REST], respond: OK, times: 'any' }]);
    await kube.delete(['persistentvolumeclaims/data'], { namespace: NS, wait: true, timeoutS: 60, ignoreNotFound: true });
    await kube.delete(['pv', 'pv-1'], { wait: false, ignoreNotFound: true });
    await kube.run({ args: ['patch', 'persistentvolumes/pv-1', '--type=merge', '-p', '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'], mutating: true });
    kube.assertDone();
    expect(ids({ kube })).toEqual(['INV-04', 'INV-04', 'INV-04']);
    expect(ids({ kube: kubeWith([]), allow: { volumeDeletion: true } })).toEqual(['ASSERT-DONE']);
  });

  it('INV-04b: the one-volume-at-a-time protocol passes; a batch, a wrong restore or a PV left Delete fails', async () => {
    const patch = (pv: string, policy: string) => ({
      args: ['patch', `persistentvolumes/${pv}`, '--type=merge', '-p', JSON.stringify({ spec: { persistentVolumeReclaimPolicy: policy } })],
      mutating: true,
    });
    const protocol = kubeWith([
      { args: ['get', 'persistentvolumes', 'pv-1', '-o', 'json'], respond: { json: { metadata: { name: 'pv-1' }, spec: { persistentVolumeReclaimPolicy: 'Retain' } } } },
      { args: ['patch', REST], respond: OK, times: 'any' },
      { args: ['delete', REST], respond: OK },
      { args: ['get', 'persistentvolumes', 'pv-1', '--ignore-not-found', '-o', 'json'], respond: OK },
    ]);
    await protocol.getJson(['persistentvolumes'], { names: ['pv-1'] });
    await protocol.run({
      args: ['patch', 'persistentvolumes/pv-1', '--type=merge', '-p', '{"metadata":{"annotations":{"dockflow.shawiizz.dev/reclaim-policy-before":"Retain"}}}'],
      mutating: true,
    });
    await protocol.delete(['persistentvolumeclaims/data'], { namespace: NS, wait: true, timeoutS: 60, ignoreNotFound: true });
    await protocol.run(patch('pv-1', 'Delete'));
    expect(await protocol.getJson(['persistentvolumes'], { names: ['pv-1'], ignoreNotFound: true })).toEqual([]);
    protocol.assertDone();
    expect(ids({ kube: protocol, allow: { volumeDeletion: true } })).toEqual([]);
    expect(() => assertExecutorInvariants({ kube: protocol })).toThrow(/INV-04/);

    const batch = kubeWith([{ args: ['patch', REST], respond: OK, times: 'any' }]);
    await batch.run(patch('pv-1', 'Delete'));
    await batch.run(patch('pv-2', 'Delete'));
    await batch.run(patch('pv-1', 'Retain'));
    await batch.run(patch('pv-2', 'Retain'));
    batch.assertDone();
    const batchViolations = checkExecutorInvariants({ kube: batch, allow: { volumeDeletion: true } });
    expect(batchViolations.map((v) => v.id)).toEqual(['INV-04b']);
    expect(batchViolations[0].message).toContain('PV pv-2 patched to Delete while pv-1 still is');

    const wrongRestore = kubeWith([
      { args: ['annotate', REST], respond: OK },
      { args: ['patch', REST], respond: OK, times: 'any' },
    ]);
    await wrongRestore.run({ args: ['annotate', 'pv', 'pv-1', 'dockflow.shawiizz.dev/reclaim-policy-before=Retain'], mutating: true });
    await wrongRestore.run(patch('pv-1', 'Delete'));
    await wrongRestore.run(patch('pv-1', 'Recycle'));
    wrongRestore.assertDone();
    expect(ids({ kube: wrongRestore, allow: { volumeDeletion: true } })).toEqual(['INV-04b']);

    const leftDelete = kubeWith([{ args: ['patch', REST], respond: OK }]);
    await leftDelete.run(patch('pv-1', 'Delete'));
    leftDelete.assertDone();
    expect(ids({ kube: leftDelete, allow: { volumeDeletion: true } })).toEqual(['INV-04b']);
    expect(ids({ kube: leftDelete, allow: { volumeDeletion: true }, volumes: { reclaimPolicyOf: () => null } })).toEqual([]);
    expect(ids({ kube: leftDelete, allow: { volumeDeletion: true }, volumes: { reclaimPolicyOf: () => 'Delete' } })).toEqual(['INV-04b']);
  });

  it('INV-05: every stdin manifest passes schema validation; DeleteOptions, Helm values and binary streams are excluded by content', async () => {
    const kube = kubeWith([
      { args: [/^(apply|delete)$/, REST], respond: OK, times: 'any' },
      { method: 'shell', args: [ANY], respond: OK, times: 'any' },
    ]);
    await kube.apply(CONFIG_MAP, { namespace: NS, dryRun: false });
    await kube.run({ args: ['delete', '--raw=/api/v1/namespaces/dockflow-system/pods/x', '-f', '-'], stdin: DELETE_OPTIONS, mutating: true });
    await kube.shell({ script: 'cat > /tmp/backup.tar.gz', stdin: new Uint8Array(gzipSync(Buffer.from('tar'))), guardS: 60 });
    await kube.shell({ script: 'cat > /tmp/dump.sql', stdin: 'CREATE TABLE users (id int);\n', guardS: 60 });
    kube.assertDone();
    expect(ids({ kube })).toEqual([]);

    await kube.apply(CONFIG_MAP_UNKNOWN_FIELD, { namespace: NS, dryRun: false });
    await kube.apply('apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\n', { dryRun: false });
    await kube.run({ args: ['delete', '--raw=/api/v1/namespaces/dockflow-system/pods/x', '-f', '-'], stdin: `${DELETE_OPTIONS}force: true\n`, mutating: true });
    await kube.shell({ script: 'K apply --server-side -f -', stdin: CONFIG_MAP_UNKNOWN_FIELD, guardS: 60 });
    const violations = checkExecutorInvariants({ kube });
    expect(violations.map((v) => v.id)).toEqual(['INV-05', 'INV-05', 'INV-05', 'INV-05']);
    expect(violations[0].message).toContain('ConfigMap/web-config spec: unknown-field');
    expect(violations[1].message).toContain('no vendored schema for example.com/v1 Widget');
    expect(violations[2].message).toContain('DeleteOptions: unknown field force');

    const helm = new FakeHelmExecutor({ redactor: redactor(), script: [{ args: ['upgrade', REST], respond: OK }] });
    await helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz', '--values', '-'], stdin: 'apiVersion: v1\nkind: Nonsense\n', mutating: true, timeoutS: 60 });
    helm.assertDone();
    expect(ids({ helm })).toEqual([]);
  });

  it('INV-06: server-side apply with --force-conflicts and one of the three field managers, narrowed by allow', async () => {
    const kube = kubeWith([{ args: ['apply', REST], respond: OK, times: 'any' }]);
    await kube.apply(CONFIG_MAP, { namespace: NS, dryRun: true, fieldManager: 'dockflow-release-state' });
    kube.assertDone();
    expect(ids({ kube })).toEqual([]);
    expect(ids({ kube, allow: { fieldManagers: ['dockflow'] } })).toEqual(['INV-06']);
    await kube.run({ args: ['apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '--dry-run=client', '-f', '-'], stdin: CONFIG_MAP, mutating: true });
    await expect(kube.run({ args: ['apply', '--field-manager=kubectl', '-f', '-'], stdin: CONFIG_MAP, mutating: true })).rejects.toThrow(/--server-side/);
    const violations = checkExecutorInvariants({ kube });
    expect(violations.map((v) => v.id)).toEqual(['INV-06', 'INV-06', 'INV-06', 'INV-06']);
    expect(violations.map((v) => v.message.split(': ').at(-1))).toEqual([
      '--dry-run=client (only --dry-run=server)',
      'apply without --server-side',
      'apply without --force-conflicts',
      'field manager kubectl is not one of dockflow, dockflow-release-state, dockflow-accessories-state',
    ]);
  });

  it('INV-07: mutating calls go through a channel and only exec calls are retried', async () => {
    const node = fakeNode('server_1');
    const ssh = new FakeSsh([{ command: /./, respond: { exitCode: 0 } }]);
    const transport = ssh.transport();
    await transport.exec(node, kubectlCommand(k3sDistribution, { args: ['get', 'pods', '-o', 'json'], namespace: NS }));
    const channel = await transport.channel(node, kubectlCommand(k3sDistribution, { args: ['delete', 'pod/web-1', '--wait=false'], namespace: NS }));
    channel.stdin.end();
    await channel.done;
    ssh.assertDone();
    expect(ids({ ssh })).toEqual([]);
    await transport.exec(node, kubectlCommand(k3sDistribution, { args: ['scale', 'deployment/web', '--replicas=2'], namespace: NS }));
    await transport.exec(node, `${HELM_ENV_PREFIX} ${HELM_BIN_PATH} ${KUBECONFIG} 'uninstall' 'cache' '-n' '${NS}'`);
    expect(ids({ ssh })).toEqual(['INV-07', 'INV-07']);
    const retried: SshRecorder = {
      calls: [
        { node: 'server_1', command: 'true', path: 'exec', stdin: new Uint8Array(), attempt: 2, ended: false, closed: false },
        { node: 'server_1', command: 'true', path: 'channel', stdin: new Uint8Array(), attempt: 2, ended: true, closed: false },
      ],
      asserted: true,
    };
    expect(ids({ ssh: retried })).toEqual(['INV-07']);
  });

  it('INV-08: every get is -o json, except the -o name set, api-resources, --raw reads and the release listing template', async () => {
    const kube = kubeWith([{ args: [/^(get|api-resources)$/, REST], respond: OK, times: 'any' }]);
    await kube.run({ args: ['get', 'secrets', '-l', 'a=b', '-o', 'name'], namespace: NS, mutating: false });
    await kube.run({ args: ['get', 'configmaps,secrets', '-o', 'name'], namespace: NS, mutating: false });
    await kube.run({ args: ['get', 'customresourcedefinitions', 'ingressroutes.traefik.io', '-o', 'name'], mutating: false });
    await kube.run({ args: ['api-resources', '--api-group=metrics.k8s.io', '-o', 'name'], mutating: false });
    await kube.run({ args: ['get', '--raw=/readyz'], mutating: false });
    await kube.run({ args: ['get', 'secrets', '-l', 'a=b', '-o', INV08_RELEASE_LIST_TEMPLATE], namespace: NS, mutating: false });
    kube.assertDone();
    expect(ids({ kube })).toEqual([]);

    await kube.run({ args: ['get', 'pods'], namespace: NS, mutating: false });
    await kube.run({ args: ['get', '--raw=/readyz', '-o', 'json'], mutating: false });
    await kube.run({ args: ['get', 'secrets', '-o', 'go-template={{range .items}}{{.data}}{{end}}'], namespace: NS, mutating: false });
    await expect(kube.run({ args: ['get', 'pods', '-o', 'name'], namespace: NS, mutating: false })).rejects.toThrow(/-o name is only allowed/);
    await expect(kube.run({ args: ['get', 'pods', '-o', 'jsonpath={.items}'], namespace: NS, mutating: false })).rejects.toThrow(/jsonpath/);
    expect(ids({ kube })).toEqual(['INV-08', 'INV-08', 'INV-08', 'INV-08', 'INV-08']);
  });

  it('INV-09: Helm values only through --values -, no --set and no --password in argv', async () => {
    const helm = new FakeHelmExecutor({ redactor: redactor(), script: [{ args: ['upgrade', REST], respond: OK, times: 'any' }] });
    await helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz', '--values', '-'], stdin: 'replicas: 2\n', mutating: true, timeoutS: 60 });
    await helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz'], mutating: true, timeoutS: 60 });
    helm.assertDone();
    expect(ids({ helm })).toEqual([]);
    await helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz'], stdin: 'replicas: 2\n', mutating: true, timeoutS: 60 });
    await helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz', '--values', '/tmp/values.yaml'], mutating: true, timeoutS: 60 });
    await expect(helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz', '--set', 'a=b'], mutating: true, timeoutS: 60 })).rejects.toThrow(/--set is not allowed/);
    await expect(helm.run({ args: ['registry', 'login', 'r.example.com', '--password=abcdef'], mutating: true, timeoutS: 60 })).rejects.toThrow(/--password/);
    expect(ids({ helm })).toEqual(['INV-09', 'INV-09', 'INV-09', 'INV-09']);
  });

  it('INV-10: kubectl carries the Dockflow kubeconfig and helm the environment prefix, in scripts too', async () => {
    const kube = kubeWith([{ method: 'shell', args: [ANY], respond: OK, times: 'any' }]);
    await kube.shell({ script: `${kube.command(['exec', 'db-0', '--', 'pg_dump'], NS)} | gzip > /tmp/x`, guardS: 60 });
    kube.assertDone();
    expect(ids({ kube })).toEqual([]);
    await kube.shell({ script: `${KUBECTL} -n ${NS} exec db-0 -- pg_dump | gzip > /tmp/x`, guardS: 60 });
    expect(ids({ kube })).toEqual(['INV-10']);

    const nodeShell = new FakeNodeShell([{ script: /helm/, respond: { exitCode: 0 }, times: 'any' }], { redactor: redactor() });
    const node = nodeShell.forNode(fakeNode('server_1'));
    await node.run(`test -x ${HELM_BIN_PATH} && sha256sum ${HELM_BIN_PATH}`, { guardS: 30 });
    await node.run(`${HELM_ENV_PREFIX} ${HELM_BIN_PATH} ${KUBECONFIG} version`, { guardS: 30 });
    nodeShell.assertDone();
    expect(ids({ nodeShell })).toEqual([]);
    await node.run(`${HELM_BIN_PATH} ${KUBECONFIG} list -A`, { guardS: 30 });
    expect(ids({ nodeShell })).toEqual(['INV-10']);

    const ssh = new FakeSsh([{ command: /./, respond: { exitCode: 0 } }]);
    await ssh.transport().exec(fakeNode('server_1'), `${KUBECTL} get nodes -o json`);
    ssh.assertDone();
    expect(ids({ ssh })).toEqual(['INV-10']);
  });

  it('INV-11: no kubectl, helm or node-shell stdout in printed output or in a file the test wrote', async () => {
    const stdout = JSON.stringify({ items: [{ metadata: { name: 'web-1' }, data: { token: 'c2VjcmV0LXRva2Vu' } }] });
    const kube = kubeWith([
      { args: ['get', 'secrets', REST], respond: { exitCode: 0, stdout, stderr: '' } },
      { args: ['get', 'pods', REST], respond: { exitCode: 0, stdout: 'ok', stderr: '' } },
    ]);
    await kube.getJson(['secrets'], { namespace: NS });
    await kube.getJson(['pods'], { namespace: NS }).catch(() => []);
    kube.assertDone();
    const printDebug = mock((_message: string) => {});
    printDebug('kubectl get secrets on server_1: exit 0');
    printDebug('ok');
    expect(ids({ kube, printed: [printDebug] })).toEqual([]);
    printDebug(`kubectl output: ${stdout}`);
    expect(ids({ kube, printed: [printDebug] })).toEqual(['INV-11']);

    const dir = mkdtempSync(join(tmpdir(), 'dockflow-inv11-'));
    try {
      const file = join(dir, 'debug.log');
      writeFileSync(file, `dump\n${stdout}\n`);
      expect(ids({ kube, printed: ['nothing here'], writtenFiles: [file, join(dir, 'missing.log')] })).toEqual(['INV-11']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('INV-12: every helper pod created is deleted, by name, by selector or after generateName', async () => {
    const created = { metadata: { name: 'dockflow-helper-archive-x7k2p', namespace: NS } };
    const kube = kubeWith([
      { args: ['create', REST], respond: OK },
      { args: ['create', REST], respond: { json: created } },
      { args: ['delete', REST], respond: { error: 'Forbidden' } },
    ], { order: 'strict' });
    await kube.create(helperPod('dockflow-helper-backup-0a1b2c3d'), { namespace: NS });
    await kube.create(helperPod(null), { namespace: NS, json: true });
    await expect(kube.delete(['pod/dockflow-helper-backup-0a1b2c3d'], { namespace: NS, wait: false, ignoreNotFound: true })).rejects.toMatchObject({
      reason: 'Forbidden',
    });
    kube.assertDone();
    const violations = checkExecutorInvariants({ kube });
    expect(violations.map((v) => v.id)).toEqual(['INV-12', 'INV-12']);
    expect(violations.map((v) => v.message.split(' created by')[0])).toEqual([
      `helper pod ${NS}/dockflow-helper-backup-0a1b2c3d`,
      `helper pod ${NS}/dockflow-helper-archive-x7k2p`,
    ]);

    const cleaned = kubeWith([
      { args: ['create', REST], respond: OK, times: 2 },
      { args: ['delete', 'pod', REST], respond: OK },
      { args: ['delete', 'pods', '-l', REST], respond: OK },
    ]);
    await cleaned.create(helperPod('dockflow-helper-backup-0a1b2c3d'), { namespace: NS });
    await cleaned.delete(['pod', 'dockflow-helper-backup-0a1b2c3d'], { namespace: NS, wait: false, ignoreNotFound: true });
    await cleaned.create(helperPod('dockflow-helper-restore-0a1b2c3d'), { namespace: NS });
    await cleaned.run({ args: ['delete', 'pods', '-l', `app.kubernetes.io/managed-by=dockflow,${LABELS.part}=helper`, '--wait=false'], namespace: NS, mutating: true });
    cleaned.assertDone();
    expect(ids({ kube: cleaned })).toEqual([]);
  });
});

describe('assertNoSecretLeak', () => {
  it('finds a secret in strings, spies, errors and plain objects such as a serialized setup report', () => {
    expect(() => assertNoSecretLeak('all good', [SECRET])).not.toThrow();
    expect(() => assertNoSecretLeak(`token ${SECRET}`, [SECRET])).toThrow(/Secret leaked in 1 place/);
    const printWarning = mock((_message: string) => {});
    printWarning(`join failed with ${Buffer.from(SECRET).toString('base64')}`);
    expect(() => assertNoSecretLeak(printWarning, [SECRET])).toThrow(/\$\.mock\.calls\[0\]\[0\]/);
    expect(() => assertNoSecretLeak(new Error(`agent token ${SECRET} refused`), [SECRET])).toThrow(/\$\.message/);
    const report = { nodes: [{ key: 'server_1', status: 'ready', detail: `uses ${encodeURIComponent(SECRET)}` }], tokens: null };
    const error = (() => {
      try {
        assertNoSecretLeak(report, new Redactor([SECRET]));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).toContain('$.nodes[0].detail');
    expect(error?.message).not.toContain(SECRET);
  });

  it('exempts what a fake recorded on stdin, but not its argv', async () => {
    const kube = kubeWith([{ args: ['create', REST], respond: OK }, { args: ['annotate', REST], respond: OK }]);
    await kube.create(`apiVersion: v1\nkind: Secret\nmetadata:\n  name: t\ndata:\n  token: ${Buffer.from(SECRET).toString('base64')}\n`, { namespace: NS });
    expect(() => assertNoSecretLeak(kube, [SECRET])).not.toThrow();
    expect(() => assertNoSecretLeak({ calls: [{ argv: ['k3s'], input: SECRET }], asserted: true }, [SECRET])).not.toThrow();
    await kube.run({ args: ['annotate', 'deployment/web', `x=${SECRET}`], namespace: NS, mutating: true });
    expect(() => assertNoSecretLeak(kube, [SECRET])).toThrow(/\$\.calls\[1\]/);
  });

  it('refuses a vacuous check', () => {
    expect(() => assertNoSecretLeak('x', [])).toThrow(/at least one secret/);
    expect(() => assertNoSecretLeak('x', ['abc'])).toThrow(/at least 6 characters/);
  });
});

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

describe('matchers', () => {
  it('expectDiagnostics tolerates extra info diagnostics unless exact, and checks message and hint', () => {
    const sink = new DiagnosticSink();
    sink.warn('ports.host-ip-ignored', 'services.web.ports[0]', 'host_ip 127.0.0.1 is ignored', 'Remove host_ip.');
    sink.info('names.sanitized', 'services.web_app', 'web_app is named web-app');
    expectDiagnostics(sink, [{ severity: 'warning', code: 'ports.host-ip-ignored', path: 'services.web.ports[0]', message: /host_ip/, hint: 'Remove host_ip.' }]);
    expect(() => expectDiagnostics(sink, [{ severity: 'warning', code: 'ports.host-ip-ignored', path: 'services.web.ports[0]' }], { exact: true })).toThrow(
      /unexpected: info names\.sanitized/,
    );
    expect(() => expectDiagnostics(sink.list(), [])).toThrow(/unexpected: warning ports\.host-ip-ignored/);
    expect(() => expectDiagnostics(sink, [{ severity: 'error', code: 'ports.host-ip-ignored', path: 'services.web.ports[0]' }])).toThrow(
      /missing: error ports\.host-ip-ignored/,
    );
  });

  it('expectCliError accepts errors, failed Results, promises and functions, and checks class, code, message and suggestion', async () => {
    const deploy = new DeployError('Deploy failed and the automatic revert did not converge', ErrorCode.ROLLBACK_FAILED, 'Run `dockflow status production`.');
    expect(await expectCliError(deploy, { type: DeployError, code: ErrorCode.ROLLBACK_FAILED, suggestion: /dockflow status/ })).toBe(deploy);
    await expectCliError(err(deploy), { message: /automatic revert/ });
    await expectCliError(Promise.reject(deploy), { type: DeployError });
    await expectCliError(async () => {
      throw new UnsupportedOperationError('dockflow helm list requires orchestrator: k3s');
    }, { type: UnsupportedOperationError, code: ErrorCode.UNSUPPORTED_OPERATION, suggestion: null });
    await expect(expectCliError(() => ok(1), {})).rejects.toThrow(/nothing was thrown/);
    await expect(expectCliError(new Error('plain'), {})).rejects.toThrow(/Expected a CLIError, got Error: plain/);
    await expect(expectCliError(new CLIError('x', ErrorCode.UNKNOWN), { type: DeployError })).rejects.toThrow(/Expected a DeployError/);
    await expect(expectCliError(deploy, { code: ErrorCode.DEPLOY_FAILED, suggestion: null })).rejects.toThrow(/code 52, expected 50[\s\S]*where none was expected/);
  });

  it('expectCommandShape checks argv, command string, namespace, mutating and stdin of recorded calls', async () => {
    const kube = kubeWith([{ args: ['delete', REST], respond: OK }]);
    await kube.delete(['pod/web-1'], { namespace: NS, wait: false, ignoreNotFound: true });
    kube.assertDone();
    const call = kube.calls[0];
    expectCommandShape(call, ['delete', 'pod/web-1', REST]);
    expectCommandShape(call, { args: ['delete', ANY, '--ignore-not-found', '--wait=false'], namespace: NS, mutating: true, command: /^\/usr\/local\/bin\/k3s kubectl --kubeconfig=/ });
    expectCommandShape(call.commandString, {
      command: `${KUBECTL} ${KUBECONFIG} --request-timeout=30s -n '${NS}' 'delete' 'pod/web-1' '--ignore-not-found' '--wait=false'`,
    });
    expect(() => expectCommandShape(call, { args: ['delete', 'pod/web-2', REST], namespace: null })).toThrow(
      /args delete pod\/web-1 --ignore-not-found --wait=false\n {4}expected delete pod\/web-2 <REST\.\.\.>[\s\S]*namespace dockflow-shop-production, expected null/,
    );
    const helm = new FakeHelmExecutor({ redactor: redactor(), script: [{ args: ['upgrade', REST], respond: OK }] });
    await helm.run({ args: ['upgrade', '--install', 'x', '/tmp/x.tgz', '--values', '-'], stdin: 'a: 1\n', mutating: true, timeoutS: 60 });
    helm.assertDone();
    expectCommandShape(helm.calls[0], { args: ['upgrade', '--install', 'x', ANY, '--values', '-'], stdin: 'a: 1\n', mutating: true });
  });
});
