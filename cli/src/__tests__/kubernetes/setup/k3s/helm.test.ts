import { afterEach, describe, expect, it } from 'bun:test';
import { DOWNLOAD_CACHE_DIR, HELM_BIN_DIR } from '../../../../commands/setup/k3s/constants';
import {
  cacheTraefikChart,
  ensureHelmDirectories,
  HELM_EXTRACT_TEMPLATE,
  HELM_HOME_SUBDIRS,
  type HelmPinInput,
  installedHelmVersion,
  installHelm,
  traefikChartCachePath,
} from '../../../../commands/setup/k3s/helm';
import { SetupStepError } from '../../../../commands/setup/k3s/host-runner';
import { curlArgs, downloadCachePath } from '../../../../commands/setup/k3s/install';
import { HELM_BIN_PATH, HELM_CHARTS_DIR, HELM_HOME_DIR } from '../../../../services/orchestrator/kubernetes/constants';
import { TRAEFIK_CHART_PIN, type TraefikChartPin } from '../../../../services/orchestrator/kubernetes/versions';
import { sha256Hex } from '../../../../utils/hash';
import { Redactor } from '../../../../utils/redact';
import { FakeHostRunner, fakeBinary, fakeTarball } from '../../fakes/fake-host-runner';
import { assertExecutorInvariants } from '../../support/invariants';

const KEY = 'server_1';
const HELM_URL = 'https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz';
const ARCHIVE = fakeTarball({ 'linux-amd64/helm': '#!fake helm v4.3.0\n', 'linux-amd64/README.md': 'docs\n' });
const ARM_ARCHIVE = fakeTarball({ 'linux-arm64/helm': '#!fake helm v4.3.0\n' });
const PIN: HelmPinInput = { version: 'v4.3.0', archive: { url: HELM_URL, sha256: sha256Hex(ARCHIVE) } };
const CHART = Buffer.from('fake traefik-41.6.0.tgz bytes');
const CHART_PIN: TraefikChartPin = {
  ...TRAEFIK_CHART_PIN,
  url: 'https://traefik.github.io/charts/traefik/traefik-41.6.0.tgz',
  sha256: sha256Hex(CHART),
};

let runners: FakeHostRunner[] = [];

function host(): FakeHostRunner {
  const runner = new FakeHostRunner();
  runners.push(runner);
  return runner;
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
  const hostRunner = runners;
  runners = [];
  assertExecutorInvariants({ hostRunner, redactor: new Redactor() });
});

describe('Helm on servers (5.3, U-SETUP-HELM-01)', () => {
  it('H1 skips everything when the installed Helm already reports the pinned version', async () => {
    const runner = host();
    runner.seedFile(HELM_BIN_PATH, fakeBinary('helm', 'v4.3.0'), { mode: 0o755 });
    expect(await installHelm(runner, PIN, 'amd64', KEY)).toEqual({ outcome: 'unchanged', version: 'v4.3.0' });
    expect(runner.calls.map((call) => call.argv)).toEqual([[HELM_BIN_PATH, 'version', '--template', '{{.Version}}']]);
    runner.assertDone();
  });

  it('H2 verified archive, private extraction of linux-<arch>/helm only, install then mv, version checked', async () => {
    const runner = host();
    const cached = runner.seedCache(ARCHIVE);
    expect(await installHelm(runner, PIN, 'amd64', KEY)).toEqual({ outcome: 'installed', version: 'v4.3.0' });
    const dir = HELM_EXTRACT_TEMPLATE.replace(/X+$/, '00000001');
    expect(runner.calls.map((call) => call.argv)).toEqual([
      [HELM_BIN_PATH, 'version', '--template', '{{.Version}}'],
      ['sha256sum', '-c', '--status', '-'],
      ['mktemp', '-d', '/var/cache/dockflow/extract.XXXXXXXX'],
      ['tar', '-xzf', cached, '-C', dir, '--no-same-owner', '--no-same-permissions', 'linux-amd64/helm'],
      ['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', '/usr/local/lib/dockflow', HELM_BIN_DIR],
      ['install', '-o', 'root', '-g', 'root', '-m', '0755', `${dir}/linux-amd64/helm`, `${HELM_BIN_PATH}.new`],
      ['mv', '-f', `${HELM_BIN_PATH}.new`, HELM_BIN_PATH],
      ['rm', '-rf', '--', dir],
      [HELM_BIN_PATH, 'version', '--template', '{{.Version}}'],
    ]);
    expect(runner.calls[1].input).toBe(`${PIN.archive.sha256}  ${cached}\n`);
    expect(runner.files.get(HELM_BIN_PATH)).toMatchObject({ type: 'file', mode: 0o755, uid: 0, gid: 0 });
    expect(runner.files.has(`${HELM_BIN_PATH}.new`)).toBe(false);
    expect(runner.files.has(dir)).toBe(false);
    expect(runner.files.has(`${dir}/linux-amd64/README.md`)).toBe(false);
    expect(await installedHelmVersion(runner)).toBe('v4.3.0');
    runner.assertDone();
  });

  it('H2 arm64 extracts linux-arm64/helm', async () => {
    const runner = host();
    runner.seedCache(ARM_ARCHIVE);
    await installHelm(runner, { version: 'v4.3.0', archive: { url: 'https://get.helm.sh/helm-v4.3.0-linux-arm64.tar.gz', sha256: sha256Hex(ARM_ARCHIVE) } }, 'arm64', KEY);
    expect(runner.commandsStartingWith('tar')[0]?.at(-1)).toBe('linux-arm64/helm');
    runner.assertDone();
  });

  it('H3 a Helm that reports another version after the install fails', async () => {
    const runner = host();
    const wrong = fakeTarball({ 'linux-amd64/helm': '#!fake helm v4.2.0\n' });
    runner.seedCache(wrong);
    const error = await failure(installHelm(runner, { version: 'v4.3.0', archive: { url: HELM_URL, sha256: sha256Hex(wrong) } }, 'amd64', KEY));
    expect(error.message).toBe('Helm on server_1 reports v4.2.0 after the install, expected v4.3.0');
    expect(error.suggestion).toBe(`Remove ${HELM_BIN_PATH} on server_1 and run setup again; if it persists, report it.`);
    expect(runner.commandsStartingWith('rm', '-rf')).toHaveLength(1);
    runner.assertDone();
  });

  it('downloads the pinned archive through curlArgs when it is not cached, and refuses bytes that do not match', async () => {
    const runner = host();
    runner.urls.set(HELM_URL, ARCHIVE);
    await installHelm(runner, PIN, 'amd64', KEY);
    expect(runner.commandsStartingWith('curl')).toEqual([curlArgs(HELM_URL, `${downloadCachePath(PIN.archive.sha256)}.part`)]);
    runner.assertDone();

    const tampered = host();
    tampered.urls.set(HELM_URL, Buffer.from('tampered archive'));
    const error = await failure(installHelm(tampered, PIN, 'amd64', KEY));
    expect(error.message).toBe(
      `Helm v4.3.0 failed verification on server_1: expected sha256 ${PIN.archive.sha256}, got ${sha256Hex('tampered archive')}; nothing was installed`,
    );
    expect(tampered.commandsStartingWith('tar')).toEqual([]);
    expect(tampered.files.has(HELM_BIN_PATH)).toBe(false);
    tampered.assertDone();
  });

  it('a failing extraction removes the private directory and names the node', async () => {
    const runner = host();
    runner.seedCache(ARCHIVE);
    runner.on(['tar'], { exitCode: 2, stderr: 'tar: Unexpected EOF in archive\n' });
    const error = await failure(installHelm(runner, PIN, 'amd64', KEY));
    expect(error.message).toBe('Could not install Helm on server_1 (tar: Unexpected EOF in archive)');
    expect(runner.commandsStartingWith('rm', '-rf')).toHaveLength(1);
    expect(runner.files.has(HELM_BIN_PATH)).toBe(false);
    runner.assertDone();
  });
});

describe('Helm home directories (4.3)', () => {
  it('creates HELM_HOME_DIR and its subdirectories 0700 for the deploy user, once', async () => {
    const runner = host();
    const user = runner.addUser('deploy');
    runner.seedDir('/var/lib/dockflow', { mode: 0o750, uid: user.uid, gid: user.gid });
    await ensureHelmDirectories(runner, user);
    for (const dir of [HELM_HOME_DIR, ...HELM_HOME_SUBDIRS.map((name) => `${HELM_HOME_DIR}/${name}`)]) {
      expect(runner.files.get(dir)).toMatchObject({ type: 'directory', mode: 0o700, uid: user.uid, gid: user.gid });
    }
    expect(HELM_HOME_SUBDIRS).toEqual(['cache', 'config', 'data', 'tmp', 'charts']);
    runner.assertDone();
  });
});

describe('pinned Traefik chart (5.4)', () => {
  it('uses the content-addressed path of design-04 for the pin', () => {
    expect(traefikChartCachePath(TRAEFIK_CHART_PIN.sha256)).toBe(`${HELM_CHARTS_DIR}/sha256-${TRAEFIK_CHART_PIN.sha256}.tgz`);
  });

  it('root cache first, then install -o <u> -g <u> -m 0600 into the chart cache, verified again', async () => {
    const runner = host();
    const user = runner.addUser('deploy');
    runner.urls.set(CHART_PIN.url, CHART);
    const result = await cacheTraefikChart(runner, { key: KEY, deployUser: 'deploy', pin: CHART_PIN });
    expect(result).toEqual({ outcome: 'installed', warning: null });
    const cached = `${DOWNLOAD_CACHE_DIR}/${CHART_PIN.sha256}`;
    const dest = traefikChartCachePath(CHART_PIN.sha256);
    expect(runner.commandsStartingWith('install')).toEqual([['install', '-o', 'deploy', '-g', 'deploy', '-m', '0600', cached, dest]]);
    expect(runner.files.get(dest)).toMatchObject({ type: 'file', mode: 0o600, uid: user.uid, gid: user.gid });
    expect(runner.files.get(dest)?.content.equals(CHART)).toBe(true);
    const checks = runner.calls.filter((call) => call.argv[0] === 'sha256sum' && call.argv[1] === '-c');
    expect(checks.at(-1)?.input).toBe(`${CHART_PIN.sha256}  ${dest}\n`);
    runner.assertDone();
  });

  it('is unchanged on a re-run: no download, no install', async () => {
    const runner = host();
    runner.addUser('deploy');
    runner.urls.set(CHART_PIN.url, CHART);
    await cacheTraefikChart(runner, { key: KEY, deployUser: 'deploy', pin: CHART_PIN });
    const before = runner.calls.length;
    expect(await cacheTraefikChart(runner, { key: KEY, deployUser: 'deploy', pin: CHART_PIN })).toEqual({ outcome: 'unchanged', warning: null });
    expect(runner.calls.slice(before).map((call) => call.argv[0])).toEqual(['sha256sum']);
    runner.assertDone();
  });

  it('a failed chart download is a warning, not a node failure', async () => {
    const runner = host();
    runner.addUser('deploy');
    runner.urls.set(CHART_PIN.url, { exitCode: 7, stderr: 'curl: (7) Failed to connect to traefik.github.io port 443\n' });
    const result = await cacheTraefikChart(runner, { key: KEY, deployUser: 'deploy', pin: CHART_PIN });
    expect(result.outcome).toBe('warned');
    expect(result.warning).toEqual({
      message:
        'The pinned Traefik chart could not be cached on server_1 (Could not download Traefik chart 41.6.0 on server_1 (curl: (7) Failed to connect to traefik.github.io port 443))',
      suggestion: 'Deploys with `proxy.enabled` will download it themselves; re-run setup once the node can reach the chart repository.',
    });
    expect(runner.files.has(traefikChartCachePath(CHART_PIN.sha256))).toBe(false);
    runner.assertDone();
  });

  it('a copy that does not verify after install is removed with a warning', async () => {
    const runner = host();
    runner.addUser('deploy');
    runner.urls.set(CHART_PIN.url, CHART);
    runner.on(['install'], (call) => {
      call.runner.seedFile(call.argv.at(-1) as string, 'corrupted on the way', { mode: 0o600 });
      return {};
    });
    const result = await cacheTraefikChart(runner, { key: KEY, deployUser: 'deploy', pin: CHART_PIN });
    expect(result.outcome).toBe('warned');
    expect(result.warning?.message).toBe(
      `The pinned Traefik chart could not be cached on server_1 (the copy in ${HELM_CHARTS_DIR} does not match sha256 ${CHART_PIN.sha256})`,
    );
    expect(runner.files.has(traefikChartCachePath(CHART_PIN.sha256))).toBe(false);
    runner.assertDone();
  });
});
