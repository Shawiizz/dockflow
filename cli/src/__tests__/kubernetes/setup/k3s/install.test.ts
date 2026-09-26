import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CURL_FLAGS, DOWNLOAD_CACHE_DIR, K3S_BINARY } from '../../../../commands/setup/k3s/constants';
import { cacheTraefikChart, installHelm } from '../../../../commands/setup/k3s/helm';
import { createLocalHostRunner, HOST_CHILD_ENV, SetupStepError, writeFileAtomic } from '../../../../commands/setup/k3s/host-runner';
import {
  archFromMachine,
  curlArgs,
  DELIVERY_DOWNLOAD_FAILED,
  DELIVERY_VERIFICATION_FAILED,
  download,
  downloadCachePath,
  downloadToCache,
  installK3sBinary,
  installScriptComponent,
  installScriptEnv,
  k3sBinaryComponent,
  type NodeBinary,
  nodeArch,
  nodeBinaryAsset,
  nodeBinaryDeliveryScript,
  type PinnedComponent,
  parseDeliveryFailure,
  parseSha256Sums,
  parseSystemctlShow,
  pruneDownloadCache,
  resolveNodeBinary,
  runInstallScript,
  sha256SumsUrl,
  waitForService,
} from '../../../../commands/setup/k3s/install';
import { HOST_KUBECTL_PREFIX, hostKubeExecutor, hostKubectlArgv } from '../../../../commands/setup/k3s/kube';
import { KubeError } from '../../../../services/orchestrator/kubernetes/runtime/errors';
import { CLIError } from '../../../../utils/errors';
import { sha256Hex } from '../../../../utils/hash';
import { Redactor } from '../../../../utils/redact';
import { shellQuote } from '../../../../utils/ssh';
import { FakeClock } from '../../fakes/fake-clock';
import { FakeHostRunner, fakeBinary, fakeTarball } from '../../fakes/fake-host-runner';
import { FakeKubeExecutor, fakeNode, type KubeStep } from '../../fakes/fake-kube-executor';
import { assertExecutorInvariants, assertNoSecretLeak } from '../../support/invariants';

const KEY = 'server_1';
const VERSION = 'v1.36.4+k3s1';
const TOKEN = 'K10aaaaaaaaaaaaaaaa::server:0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const K3S_BYTES = fakeBinary('k3s', VERSION);
const SCRIPT_BYTES = Buffer.from('#!/bin/sh\necho fake k3s install script\n');
const K3S: PinnedComponent = k3sBinaryComponent(VERSION, {
  url: 'https://github.com/k3s-io/k3s/releases/download/v1.36.4%2Bk3s1/k3s',
  sha256: sha256Hex(K3S_BYTES),
});
const SCRIPT: PinnedComponent = installScriptComponent(VERSION, {
  url: 'https://raw.githubusercontent.com/k3s-io/k3s/v1.36.4%2Bk3s1/install.sh',
  sha256: sha256Hex(SCRIPT_BYTES),
});

const redactor = new Redactor([TOKEN]);
let runners: FakeHostRunner[] = [];
let kubes: FakeKubeExecutor[] = [];

function host(options: ConstructorParameters<typeof FakeHostRunner>[0] = {}): FakeHostRunner {
  const runner = new FakeHostRunner(options);
  runners.push(runner);
  return runner;
}

function kube(script: KubeStep[], clock?: FakeClock): FakeKubeExecutor {
  const executor = new FakeKubeExecutor({ node: fakeNode(KEY), script, redactor, clock });
  kubes.push(executor);
  return executor;
}

async function failure(promise: Promise<unknown>): Promise<SetupStepError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupStepError) return error;
    throw error;
  }
  throw new Error('expected a SetupStepError');
}

afterEach(() => {
  const [hostRunner, kube] = [runners, kubes];
  runners = [];
  kubes = [];
  assertExecutorInvariants({ hostRunner, kube, redactor });
});

describe('local HostRunner', () => {
  it('runs argv with the fixed child environment and handles files without following surprises', async () => {
    const runner = createLocalHostRunner();
    const echoed = await runner.run([process.execPath, '-e', 'process.stdout.write(`${process.env.LANG}|${process.env.EXTRA}|${process.env.HOME ?? "-"}`)'], {
      env: { EXTRA: 'x', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
    });
    expect(echoed).toEqual({ exitCode: 0, stdout: `${HOST_CHILD_ENV.LANG}|x|-`, stderr: '', timedOut: false });

    const dir = mkdtempSync(join(tmpdir(), 'dockflow-host-runner-')).replace(/\\/g, '/');
    try {
      expect(await runner.readFile(`${dir}/missing`)).toBeNull();
      expect(await runner.stat(`${dir}/missing`)).toBeNull();
      expect(await runner.createExclusive(`${dir}/lock`, '4242\n', 0o600)).toBe(true);
      expect(await runner.createExclusive(`${dir}/lock`, '1\n', 0o600)).toBe(false);
      expect((await runner.readFile(`${dir}/lock`))?.toString()).toBe('4242\n');
      await runner.mkdir(`${dir}/a/b`, { mode: 0o700 });
      expect((await runner.stat(`${dir}/a/b`))?.type).toBe('directory');
      if (process.platform !== 'win32') {
        // a parent the call creates keeps 0755: a 0700 leaf must not lock the directories above it
        expect(lstatSync(`${dir}/a`).mode & 0o777).toBe(0o755);
        expect(lstatSync(`${dir}/a/b`).mode & 0o777).toBe(0o700);
      }
      await writeFileAtomic(runner, `${dir}/a/b/state.json`, '{}\n', { mode: 0o600 });
      expect(await runner.readDir(`${dir}/a/b`)).toEqual(['state.json']);
      await runner.writeFile(`${dir}/a/b/state.json`, '{"v":2}\n', { mode: 0o600 });
      expect((await runner.readFile(`${dir}/a/b/state.json`))?.toString()).toBe('{"v":2}\n');
      await runner.rename(`${dir}/a/b/state.json`, `${dir}/a/state.json`);
      expect((await runner.stat(`${dir}/a/state.json`))?.type).toBe('file');
      await runner.remove(`${dir}/a`, { recursive: true });
      expect(await runner.stat(`${dir}/a`)).toBeNull();
      await runner.remove(`${dir}/never-existed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('curlArgs (5.1, K57c)', () => {
  it('is the one flag set: HTTPS only, TLS 1.2, retries, connect and total timeouts, no shell', () => {
    const argv = curlArgs('https://example.com/file', '/tmp/dest');
    expect(argv).toEqual(['curl', ...CURL_FLAGS, '-o', '/tmp/dest', 'https://example.com/file']);
    expect(argv.join(' ')).toContain('-fsSL --proto =https --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900');
  });

  it('names cache entries by their digest only', () => {
    expect(downloadCachePath(K3S.sha256)).toBe(`${DOWNLOAD_CACHE_DIR}/${K3S.sha256}`);
    expect(() => downloadCachePath('../etc/passwd')).toThrow();
  });
});

describe('verified cache (U-SETUP-INSTALL-06, I1)', () => {
  it('I1 a cached file with the right hash is used without any download', async () => {
    const runner = host();
    runner.seedCache(K3S_BYTES);
    const { path, outcome } = await downloadToCache(runner, K3S, KEY);
    expect(outcome).toBe('cached');
    expect(path).toBe(downloadCachePath(K3S.sha256));
    expect(runner.commandsStartingWith('curl')).toEqual([]);
    const check = runner.calls.find((call) => call.argv.join(' ') === 'sha256sum -c --status -');
    expect(check?.input).toBe(`${K3S.sha256}  ${path}\n`);
    runner.assertDone();
  });

  it('a miss downloads to .part, checks it with sha256sum -c, then renames it 0600 into the root 0700 cache', async () => {
    const runner = host();
    runner.urls.set(K3S.url, K3S_BYTES);
    const { path, outcome } = await downloadToCache(runner, K3S, KEY);
    expect(outcome).toBe('downloaded');
    const argvs = runner.calls.map((call) => call.argv.join(' '));
    const curlAt = argvs.indexOf(curlArgs(K3S.url, `${path}.part`).join(' '));
    const checkAt = argvs.indexOf('sha256sum -c --status -');
    expect(curlAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeGreaterThan(curlAt);
    expect(runner.calls[checkAt].input).toBe(`${K3S.sha256}  ${path}.part\n`);
    expect(runner.files.get(path)?.mode).toBe(0o600);
    expect(runner.files.has(`${path}.part`)).toBe(false);
    for (const dir of ['/var/cache/dockflow', DOWNLOAD_CACHE_DIR]) {
      expect(runner.files.get(dir)).toMatchObject({ type: 'directory', mode: 0o700, uid: 0, gid: 0 });
    }
    runner.assertDone();
  });

  it('a cache entry that fails verification is deleted and fetched again; the pin is checked on the new bytes too', async () => {
    const runner = host();
    runner.seedFile(downloadCachePath(K3S.sha256), 'tampered', { mode: 0o600 });
    runner.urls.set(K3S.url, K3S_BYTES);
    const { outcome, path } = await downloadToCache(runner, K3S, KEY);
    expect(outcome).toBe('downloaded');
    expect(runner.text(path)).toBe(K3S_BYTES.toString('utf8'));
    expect(runner.commandsStartingWith('sha256sum', '-c')).toHaveLength(2);
    runner.assertDone();
  });

  it('I2 a download that does not match the pin fails with the exact message, removes .part and installs nothing', async () => {
    const runner = host();
    const old = fakeBinary('k3s', 'v1.35.8+k3s1');
    runner.seedFile(K3S_BINARY, old, { mode: 0o755 });
    runner.urls.set(K3S.url, Buffer.from('not the pinned bytes'));
    const error = await failure(installK3sBinary(runner, K3S, KEY));
    const actual = sha256Hex('not the pinned bytes');
    expect(error.message).toBe(`k3s v1.36.4+k3s1 failed verification on server_1: expected sha256 ${K3S.sha256}, got ${actual}; nothing was installed`);
    expect(error.suggestion).toBe(
      'Do not bypass this check. Retry later; if it persists, report it: the download does not match the release Dockflow pinned.',
    );
    const path = downloadCachePath(K3S.sha256);
    expect(runner.files.has(`${path}.part`)).toBe(false);
    expect(runner.files.has(path)).toBe(false);
    expect(runner.files.get(K3S_BINARY)?.content.equals(old)).toBe(true);
    expect(runner.commandsStartingWith('install')).toEqual([]);
    runner.assertDone();
  });

  it('a failed download names the component, the node and curl first stderr line', async () => {
    const runner = host();
    runner.urls.set(K3S.url, { exitCode: 6, stderr: 'curl: (6) Could not resolve host: github.com\n' });
    const error = await failure(downloadToCache(runner, K3S, KEY));
    expect(error.message).toBe('Could not download k3s v1.36.4+k3s1 on server_1 (curl: (6) Could not resolve host: github.com)');
    expect(error.suggestion).toBe('Check that server_1 reaches github.com and get.helm.sh over HTTPS.');
    expect(runner.files.has(`${downloadCachePath(K3S.sha256)}.part`)).toBe(false);
    runner.assertDone();
  });

  it('keeps only the current pins after an install', async () => {
    const runner = host();
    runner.seedCache(K3S_BYTES);
    const stale = runner.seedCache('an older k3s');
    runner.seedFile(`${DOWNLOAD_CACHE_DIR}/leftover.part`, 'x');
    const removed = await pruneDownloadCache(runner, [K3S.sha256]);
    expect(removed.sort()).toEqual([stale.slice(DOWNLOAD_CACHE_DIR.length + 1), 'leftover.part'].sort());
    expect(await runner.readDir(DOWNLOAD_CACHE_DIR)).toEqual([K3S.sha256]);
    runner.assertDone();
  });

  it('download() keeps an existing file that verifies wherever it is', async () => {
    const runner = host();
    runner.seedFile('/opt/k3s', K3S_BYTES);
    expect(await download(runner, K3S, '/opt/k3s', KEY)).toBe('cached');
    runner.assertDone();
  });
});

describe('k3s binary (5.2)', () => {
  it('I6 is not reinstalled when the installed binary already has the pinned hash', async () => {
    const runner = host();
    runner.seedFile(K3S_BINARY, K3S_BYTES, { mode: 0o755 });
    expect(await installK3sBinary(runner, K3S, KEY)).toBe('unchanged');
    expect(runner.commandsStartingWith('install')).toEqual([]);
    expect(runner.commandsStartingWith('curl')).toEqual([]);
    runner.assertDone();
  });

  it('installs the verified cache entry with install -o root -g root -m 0755', async () => {
    const runner = host();
    const cached = runner.seedCache(K3S_BYTES);
    expect(await installK3sBinary(runner, K3S, KEY)).toBe('installed');
    expect(runner.commandsStartingWith('install')).toEqual([['install', '-o', 'root', '-g', 'root', '-m', '0755', cached, K3S_BINARY]]);
    const checks = runner.calls.filter((call) => call.argv[0] === 'sha256sum' && call.argv[1] === '-c');
    expect(checks.at(-1)?.input).toBe(`${K3S.sha256}  ${cached}\n`);
    expect(runner.files.get(K3S_BINARY)).toMatchObject({ mode: 0o755, uid: 0, gid: 0 });
    runner.assertDone();
  });
});

describe('install.sh (4.4, I4, U-SETUP-INSTALL-05)', () => {
  it('I4 the environment is exactly PATH and the four INSTALL_K3S_* variables, never K3S_*', () => {
    expect(installScriptEnv('server-init', VERSION)).toEqual({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      INSTALL_K3S_SKIP_DOWNLOAD: 'binary',
      INSTALL_K3S_VERSION: VERSION,
      INSTALL_K3S_EXEC: 'server',
      INSTALL_K3S_SKIP_START: 'true',
    });
    expect(installScriptEnv('server', VERSION).INSTALL_K3S_EXEC).toBe('server');
    expect(installScriptEnv('agent', VERSION).INSTALL_K3S_EXEC).toBe('agent');
    for (const role of ['server-init', 'server', 'agent'] as const) {
      expect(Object.keys(installScriptEnv(role, VERSION)).filter((name) => name.startsWith('K3S_'))).toEqual([]);
    }
  });

  it('runs sh <verified cache entry> with that environment', async () => {
    const runner = host();
    const cached = runner.seedCache(SCRIPT_BYTES);
    await runInstallScript(runner, SCRIPT, 'agent', KEY);
    const call = runner.calls.find((c) => c.argv[0] === 'sh');
    expect(call?.argv).toEqual(['sh', cached]);
    expect(call?.env).toEqual(installScriptEnv('agent', VERSION));
    expect(runner.files.has('/etc/systemd/system/k3s-agent.service')).toBe(true);
    runner.assertDone();
  });

  it('a failure carries the last 30 lines, redacted, and the journalctl hint; debug keeps every line', async () => {
    const runner = host();
    runner.seedCache(SCRIPT_BYTES);
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}${i === 39 ? ` token ${TOKEN}` : ''}`);
    runner.installScript = { exitCode: 1, stdout: `${lines.join('\n')}\n` };
    const error = await failure(runInstallScript(runner, SCRIPT, 'server-init', KEY, { redactor }));
    expect(error.message).toBe('The k3s install script failed on server_1 (exit 1)');
    expect(error.suggestion).toBe(
      'Read the script output above; if the k3s service failed to start, `journalctl -u k3s -n 100` on server_1 (`-u k3s-agent` on an agent) says why.',
    );
    expect(error.logTail).toHaveLength(30);
    expect(error.logTail[0]).toBe('line 11');
    expect(error.logTail.at(-1)).toBe('line 40 token ***');
    assertNoSecretLeak(error, [TOKEN]);
    const debug = await failure(runInstallScript(runner, SCRIPT, 'server-init', KEY, { redactor, debug: true }));
    expect(debug.logTail).toHaveLength(40);
    assertNoSecretLeak(debug, [TOKEN]);
    runner.assertDone();
  });
});

describe('I3 every download goes through curlArgs', () => {
  const HELM_TGZ = fakeTarball({ 'linux-amd64/helm': '#!fake helm v4.3.0\n' });
  const CHART = Buffer.from('fake traefik chart archive');
  const cases: { name: string; run(runner: FakeHostRunner): Promise<unknown>; url: string }[] = [
    { name: 'k3s binary', url: K3S.url, run: (runner) => installK3sBinary(runner, K3S, KEY) },
    { name: 'install.sh', url: SCRIPT.url, run: (runner) => runInstallScript(runner, SCRIPT, 'server-init', KEY) },
    {
      name: 'Helm',
      url: 'https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz',
      run: (runner) =>
        installHelm(
          runner,
          { version: 'v4.3.0', archive: { url: 'https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz', sha256: sha256Hex(HELM_TGZ) } },
          'amd64',
          KEY,
        ),
    },
    {
      name: 'Traefik chart',
      url: 'https://traefik.github.io/charts/traefik/traefik-41.6.0.tgz',
      run: (runner) => {
        runner.addUser('deploy');
        return cacheTraefikChart(runner, {
          key: KEY,
          deployUser: 'deploy',
          pin: {
            chart: 'traefik',
            repo: 'https://traefik.github.io/charts',
            version: '41.6.0',
            url: 'https://traefik.github.io/charts/traefik/traefik-41.6.0.tgz',
            sha256: sha256Hex(CHART),
            appVersion: 'v3.7.13',
          },
        });
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: argv is exactly curlArgs, the full flag set, no shell`, async () => {
      const runner = host();
      runner.urls.set(K3S.url, K3S_BYTES);
      runner.urls.set(SCRIPT.url, SCRIPT_BYTES);
      runner.urls.set('https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz', HELM_TGZ);
      runner.urls.set('https://traefik.github.io/charts/traefik/traefik-41.6.0.tgz', CHART);
      await testCase.run(runner);
      const curls = runner.commandsStartingWith('curl');
      expect(curls).toHaveLength(1);
      const argv = curls[0];
      expect(argv).toEqual(curlArgs(testCase.url, argv[argv.length - 2]));
      expect(argv.slice(1, 1 + CURL_FLAGS.length)).toEqual([...CURL_FLAGS]);
      expect(runner.calls.some((call) => call.argv[0] === 'sh' && call.argv[1] === '-c')).toBe(false);
      runner.assertDone();
    });
  }

  it('node binary delivery command: the same curl argv, shell-quoted', () => {
    const binary: NodeBinary = { mode: 'download', url: 'https://github.com/example/releases/download/1.9.0/dockflow-linux-x64', sha256: 'a'.repeat(64), asset: 'dockflow-linux-x64' };
    const script = nodeBinaryDeliveryScript('/tmp/dockflow-setup.AbC123', binary);
    expect(script).toContain(curlArgs(binary.url, '/tmp/dockflow-setup.AbC123/dockflow.part').map(shellQuote).join(' '));
  });
});

describe('architecture (U-SETUP-INSTALL-03)', () => {
  it('maps uname -m to the pinned architectures and refuses the others', async () => {
    expect(archFromMachine('x86_64')).toBe('amd64');
    expect(archFromMachine('aarch64')).toBe('arm64');
    expect(archFromMachine('arm64')).toBe('arm64');
    expect(archFromMachine('armv7l')).toBeNull();
    const runner = host({ machine: 'armv7l' });
    const error = await failure(nodeArch(runner, KEY));
    expect(error.message).toBe('Unsupported architecture armv7l on server_1; k3s nodes must be amd64 or arm64');
    runner.assertDone();
  });
});

describe('waiting for the service (4.4.1, I5)', () => {
  const READYZ = ['get', '--raw=/readyz'];

  async function settle(promise: Promise<void>, clock: FakeClock, maxMs = 400_000): Promise<unknown> {
    const outcome = promise.then(
      () => 'ok',
      (error: unknown) => error,
    );
    await clock.runUntilIdle(maxMs);
    return outcome;
  }

  it('server: active/running and readyz ok', async () => {
    const clock = new FakeClock();
    const executor = kube(
      [
        { args: READYZ, respond: { exitCode: 1, stdout: '', stderr: 'The connection to the server 127.0.0.1:6443 was refused' } },
        { args: READYZ, respond: { exitCode: 0, stdout: 'ok', stderr: '' } },
      ],
      clock,
    );
    const runner = host({ kube: executor });
    runner.services.set('k3s', [
      { activeState: 'activating', subState: 'start' },
      { activeState: 'active', subState: 'running' },
    ]);
    expect(await settle(waitForService(runner, clock, { key: KEY, role: 'server-init', joinUrl: null }), clock)).toBe('ok');
    expect(executor.calls.map((call) => call.call.requestTimeoutS)).toEqual([5, 5]);
    expect(runner.commandsStartingWith('systemctl', 'show')[0]).toEqual(['systemctl', 'show', 'k3s', '-p', 'ActiveState,SubState,NRestarts']);
    executor.assertDone();
    runner.assertDone();
  });

  it('agent: active/running is enough', async () => {
    const clock = new FakeClock();
    const runner = host();
    runner.services.set('k3s-agent', [{ activeState: 'active', subState: 'running' }]);
    expect(await settle(waitForService(runner, clock, { key: 'agent_1', role: 'agent', joinUrl: 'https://10.0.0.10:6443' }), clock)).toBe('ok');
    runner.assertDone();
  });

  it('three restarts fail early with the redacted journal tail', async () => {
    const clock = new FakeClock();
    const runner = host();
    runner.services.set('k3s-agent', [{ activeState: 'activating', subState: 'auto-restart', nRestarts: 3 }]);
    runner.journal.set('k3s-agent', `level=fatal msg="token ${TOKEN} rejected"\nlevel=info msg=starting\n`);
    const error = (await settle(waitForService(runner, clock, { key: 'agent_1', role: 'agent', joinUrl: 'https://10.0.0.10:6443', redactor }), clock)) as SetupStepError;
    expect(error).toBeInstanceOf(SetupStepError);
    expect(error.message).toBe('k3s on agent_1 did not become ready: it restarted 3 times (activating/auto-restart)');
    expect(error.suggestion).toBe('Check that agent_1 reaches https://10.0.0.10:6443, then run journalctl -u k3s-agent -n 100 on agent_1.');
    expect(error.logTail).toEqual(['level=fatal msg="token *** rejected"', 'level=info msg=starting']);
    expect(runner.commandsStartingWith('journalctl')).toEqual([['journalctl', '-u', 'k3s-agent', '-n', '40', '--no-pager', '-o', 'cat']]);
    expect(clock.now().getTime() - Date.parse('2026-01-01T00:00:00Z')).toBeLessThan(10_000);
    assertNoSecretLeak(error, [TOKEN]);
    runner.assertDone();
  });

  it('times out after 300 s on a server with the state in the message', async () => {
    const clock = new FakeClock();
    const runner = host();
    runner.services.set('k3s', [{ activeState: 'activating', subState: 'start', nRestarts: 1 }]);
    const error = (await settle(waitForService(runner, clock, { key: KEY, role: 'server', joinUrl: 'https://10.0.0.10:6443' }), clock)) as SetupStepError;
    expect(error.message).toBe('k3s on server_1 did not become ready within 300s (activating/start, 1 restarts)');
    expect(error.suggestion).toBe('Run journalctl -u k3s -n 100 on server_1.');
    expect(clock.sleeps.every((ms) => ms === 2000)).toBe(true);
    expect(clock.sleeps).toHaveLength(150);
    runner.assertDone();
  });

  it('tolerates K8S_TRANSPORT_FAILURES_TOLERATED unreadable probes in a row; one more fails', async () => {
    const clock = new FakeClock();
    const tolerated = host();
    tolerated.on(['systemctl', 'show'], { exitCode: 1, stderr: 'Failed to connect to bus' }, { times: 2 });
    tolerated.services.set('k3s-agent', [{ activeState: 'active', subState: 'running' }]);
    expect(await settle(waitForService(tolerated, clock, { key: 'agent_1', role: 'agent', joinUrl: null }), clock)).toBe('ok');
    tolerated.assertDone();

    const failing = host();
    failing.on(['systemctl', 'show'], { exitCode: 1, stderr: 'Failed to connect to bus' }, { times: 3 });
    const error = (await settle(waitForService(failing, clock, { key: 'agent_1', role: 'agent', joinUrl: null }), clock)) as SetupStepError;
    expect(error.message).toBe('Could not read the state of k3s-agent on agent_1 (Failed to connect to bus)');
    failing.assertDone();
  });

  it('parses systemctl show output', () => {
    expect(parseSystemctlShow('ActiveState=active\nSubState=running\nNRestarts=2\n')).toEqual({ activeState: 'active', subState: 'running', restarts: 2 });
    expect(parseSystemctlShow('')).toEqual({ activeState: 'unknown', subState: 'unknown', restarts: 0 });
  });
});

describe('hostKubeExecutor (4.0)', () => {
  it('runs k3s kubectl with the admin kubeconfig through the HostRunner, argv built by the kubectl builders', async () => {
    const executor = kube([
      { args: ['get', 'nodes', '-o', 'json'], respond: { json: { items: [{ metadata: { name: 'server-1' } }] } } },
      { args: ['apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '-f', '-'], mutating: true, stdin: /kind: Namespace/, respond: { exitCode: 0, stdout: '', stderr: '' } },
    ]);
    const runner = host({ kube: executor });
    const kubectl = hostKubeExecutor(runner, KEY);
    expect(await kubectl.getJson<{ metadata: { name: string } }>(['nodes'])).toEqual([{ metadata: { name: 'server-1' } }]);
    await kubectl.apply('apiVersion: v1\nkind: Namespace\nmetadata:\n  name: dockflow-system\n', { dryRun: false });
    expect(runner.calls.map((call) => call.argv)).toEqual([
      [...HOST_KUBECTL_PREFIX, '--request-timeout=30s', 'get', 'nodes', '-o', 'json'],
      [...HOST_KUBECTL_PREFIX, '--request-timeout=120s', 'apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '-f', '-'],
    ]);
    expect(HOST_KUBECTL_PREFIX).toEqual([K3S_BINARY, 'kubectl', '--kubeconfig=/etc/rancher/k3s/k3s.yaml']);
    expect(runner.calls[1].input).toContain('kind: Namespace');
    expect(kubectl.command(['get', 'pods'], 'dockflow-system')).toBe(
      `'${K3S_BINARY}' 'kubectl' '--kubeconfig=/etc/rancher/k3s/k3s.yaml' '-n' 'dockflow-system' 'get' 'pods'`,
    );
    executor.assertDone();
    runner.assertDone();
  });

  it('maps failures and timeouts to KubeError, refuses shell scripts and forbidden output formats', async () => {
    const executor = kube([{ args: ['get', 'storageclasses', '-o', 'json'], respond: { error: 'Forbidden' } }]);
    const runner = host({ kube: executor });
    runner.on([K3S_BINARY, 'kubectl', /--kubeconfig/, /--request-timeout/, 'get', 'nodes'], { exitCode: 124, timedOut: true });
    const kubectl = hostKubeExecutor(runner, KEY, { redactor });
    await expect(kubectl.getJson(['storageclasses'])).rejects.toMatchObject({ reason: 'Forbidden' });
    const timeout = await kubectl.run({ args: ['get', 'nodes', '-o', 'json'], mutating: false }).catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(KubeError);
    expect((timeout as KubeError).reason).toBe('Timeout');
    await expect(kubectl.shell({ script: 'true', guardS: 5 })).rejects.toThrow('argv only');
    expect(() => hostKubectlArgv({ args: ['get', 'pods', '-o', 'jsonpath={.items}'] })).toThrow('not allowed');
    executor.assertDone();
    runner.assertDone();
  });
});

describe('Dockflow binary integrity (3.3, K57c, U-SETUP-BIN-01, I7, I8)', () => {
  const SUMS = [`${'1'.repeat(64)}  dockflow-linux-x64`, `${'2'.repeat(64)}  dockflow-linux-arm64`, `${'3'.repeat(64)}  dockflow-macos-arm64`].join('\n');
  const RELEASE = 'https://github.com/example/dockflow/releases/latest/download';

  it('I7 release mode: SHA256SUMS fetched next to the assets, one hash per node architecture', async () => {
    const fetched: string[] = [];
    const binaries = await resolveNodeBinary(
      { localBinaries: null, arches: ['arm64', 'amd64', 'amd64'], nodeCount: 3, version: '1.9.0', releaseUrl: RELEASE },
      {
        fetchText: async (url) => {
          fetched.push(url);
          return SUMS;
        },
        readLocalFile: () => {
          throw new Error('never read');
        },
      },
    );
    expect(fetched).toEqual([sha256SumsUrl(RELEASE, '1.9.0')]);
    expect(fetched[0]).toBe('https://github.com/example/dockflow/releases/download/1.9.0/SHA256SUMS');
    expect(binaries).toEqual({
      amd64: { mode: 'download', url: 'https://github.com/example/dockflow/releases/download/1.9.0/dockflow-linux-x64', sha256: '1'.repeat(64), asset: 'dockflow-linux-x64' },
      arm64: { mode: 'download', url: 'https://github.com/example/dockflow/releases/download/1.9.0/dockflow-linux-arm64', sha256: '2'.repeat(64), asset: 'dockflow-linux-arm64' },
    });
    expect(nodeBinaryAsset('amd64')).toBe('dockflow-linux-x64');
    expect(parseSha256Sums(`${'A'.repeat(64)} *dockflow-linux-x64\nnoise\n`).get('dockflow-linux-x64')).toBe('a'.repeat(64));
  });

  it('I7 a missing SHA256SUMS, or one without the asset, is a CLIError before anything is touched', async () => {
    const deps = (text: string | null) => ({ fetchText: async () => text, readLocalFile: () => new Uint8Array() });
    const missing = await resolveNodeBinary({ localBinaries: null, arches: ['amd64'], nodeCount: 3, version: '1.9.0', releaseUrl: RELEASE }, deps(null)).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(CLIError);
    expect((missing as CLIError).message).toBe('Dockflow 1.9.0 publishes no SHA256SUMS, so the binary that would run as root on 3 nodes cannot be verified');
    expect((missing as CLIError).suggestion).toBe('Use a Dockflow release that publishes `SHA256SUMS`, or pass `--dev` (build locally) or `--binary <path>`.');
    const unparseable = await resolveNodeBinary({ localBinaries: null, arches: ['amd64'], nodeCount: 1, version: '1.9.0', releaseUrl: RELEASE }, deps('<html>not found</html>')).catch((e: unknown) => e);
    expect((unparseable as CLIError).message).toBe('Dockflow 1.9.0 publishes no SHA256SUMS, so the binary that would run as root on 1 node cannot be verified');
    const noAsset = await resolveNodeBinary(
      { localBinaries: null, arches: ['arm64'], nodeCount: 2, version: '1.9.0', releaseUrl: RELEASE },
      deps(`${'1'.repeat(64)}  dockflow-linux-x64\n`),
    ).catch((e: unknown) => e);
    expect((noAsset as CLIError).message).toBe(
      'Dockflow 1.9.0 publishes no SHA256SUMS entry for dockflow-linux-arm64, so the binary that would run as root on 2 nodes cannot be verified',
    );
    const unreachable = await resolveNodeBinary(
      { localBinaries: null, arches: ['amd64'], nodeCount: 1, version: '1.9.0', releaseUrl: RELEASE },
      { fetchText: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND github.com')), readLocalFile: () => new Uint8Array() },
    ).catch((e: unknown) => e);
    expect((unreachable as CLIError).message).toBe('Could not fetch the SHA256SUMS of Dockflow 1.9.0 (getaddrinfo ENOTFOUND github.com)');
  });

  it('I7 --binary / --dev hash the local file and never fetch', async () => {
    const bytes = new TextEncoder().encode('fake linux binary');
    const read: string[] = [];
    const binaries = await resolveNodeBinary(
      { localBinaries: { amd64: '/work/dockflow-linux-x64', arm64: '/work/dockflow-linux-x64' }, arches: ['amd64', 'arm64'], nodeCount: 2 },
      {
        fetchText: async () => {
          throw new Error('must not fetch');
        },
        readLocalFile: (path) => {
          read.push(path);
          return bytes;
        },
      },
    );
    expect(read).toEqual(['/work/dockflow-linux-x64']);
    expect(binaries.amd64).toEqual({ mode: 'upload', path: '/work/dockflow-linux-x64', sha256: sha256Hex(bytes) });
    expect(binaries.arm64).toEqual(binaries.amd64);
  });

  it('I8 the delivery script verifies before chmod/mv and removes the part file on a mismatch', () => {
    const binary: NodeBinary = { mode: 'upload', path: '/work/dockflow', sha256: 'b'.repeat(64) };
    const script = nodeBinaryDeliveryScript('/tmp/dockflow setup.x', binary);
    const part = shellQuote('/tmp/dockflow setup.x/dockflow.part');
    expect(script).toBe(
      `if printf '%s  %s\\n' '${'b'.repeat(64)}' ${part} | sha256sum -c --status -; ` +
        `then chmod 0700 ${part} && mv -f ${part} '/tmp/dockflow setup.x/dockflow'; ` +
        `else actual=$(sha256sum ${part} 2>/dev/null); rm -f -- ${part}; printf 'actual %s\\n' "\${actual%% *}" >&2; exit ${DELIVERY_VERIFICATION_FAILED}; fi`,
    );
    const download = nodeBinaryDeliveryScript('/tmp/d', { mode: 'download', url: 'https://example.com/x', sha256: 'c'.repeat(64), asset: 'x' });
    expect(download.indexOf('curl')).toBeLessThan(download.indexOf('sha256sum -c'));
    expect(download).toContain(`|| { rm -f -- '/tmp/d/dockflow.part'; exit ${DELIVERY_DOWNLOAD_FAILED}; }`);
  });

  it('I8 delivery failures map to the 3.3 messages, "nothing was installed" for a mismatch', () => {
    const release: NodeBinary = { mode: 'download', url: 'https://example.com/x', sha256: 'c'.repeat(64), asset: 'dockflow-linux-x64' };
    expect(parseDeliveryFailure({ exitCode: DELIVERY_VERIFICATION_FAILED, stderr: `actual ${'d'.repeat(64)}\n` }, { key: 'srv-1', binary: release, version: '1.9.0' })).toEqual({
      message: `Dockflow 1.9.0 failed verification on srv-1: expected sha256 ${'c'.repeat(64)}, got ${'d'.repeat(64)}; nothing was installed`,
      suggestion: 'Do not bypass this check. Retry later; if it persists, report it: the download does not match the release Dockflow pinned.',
    });
    expect(parseDeliveryFailure({ exitCode: DELIVERY_DOWNLOAD_FAILED, stderr: 'curl: (22) The requested URL returned error: 404\n' }, { key: 'srv-1', binary: release, version: '1.9.0' }).message).toBe(
      'Could not download Dockflow 1.9.0 on srv-1 (curl: (22) The requested URL returned error: 404)',
    );
    const upload: NodeBinary = { mode: 'upload', path: '/work/dockflow', sha256: 'e'.repeat(64) };
    expect(parseDeliveryFailure({ exitCode: DELIVERY_VERIFICATION_FAILED, stderr: 'actual f\n' }, { key: 'srv-1', binary: upload }).message).toBe(
      `/work/dockflow failed verification on srv-1: expected sha256 ${'e'.repeat(64)}, got f; nothing was installed`,
    );
  });

  const posixSh = Bun.which('sh') !== null && Bun.which('sha256sum') !== null;
  it.if(posixSh)('I8 run by a real sh: a mismatch leaves no executable, a match installs it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dockflow-delivery-')).replace(/\\/g, '/');
    try {
      const bytes = 'fake dockflow binary';
      writeFileSync(`${dir}/dockflow.part`, bytes);
      const wrong = Bun.spawnSync(['sh', '-c', nodeBinaryDeliveryScript(dir, { mode: 'upload', path: '/work/dockflow', sha256: '0'.repeat(64) })]);
      expect(wrong.exitCode).toBe(DELIVERY_VERIFICATION_FAILED);
      expect(existsSync(`${dir}/dockflow`)).toBe(false);
      expect(existsSync(`${dir}/dockflow.part`)).toBe(false);
      expect(wrong.stderr.toString()).toContain(`actual ${sha256Hex(bytes)}`);

      writeFileSync(`${dir}/dockflow.part`, bytes);
      const right = Bun.spawnSync(['sh', '-c', nodeBinaryDeliveryScript(dir, { mode: 'upload', path: '/work/dockflow', sha256: sha256Hex(bytes) })]);
      expect(right.exitCode).toBe(0);
      expect(readFileSync(`${dir}/dockflow`, 'utf8')).toBe(bytes);
      expect(existsSync(`${dir}/dockflow.part`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
