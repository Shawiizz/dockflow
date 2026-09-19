import { afterEach, describe, expect, it } from 'bun:test';
import {
  DOWNLOAD_CACHE_DIR,
  K3S_BINARY,
  K3S_DATA_DIR,
  K3S_NODE_STATE_FILE,
  K3S_SERVER_TOKEN,
  K3S_STORAGE_DIR,
  PRESERVED_DIR,
  SUDOERS_K3S_FILE,
} from '../../../../commands/setup/k3s/constants';
import { SetupStepError } from '../../../../commands/setup/k3s/host-runner';
import { preserveData, removeDockflowFiles, renderPreservedReadme, resetMessages, runNodeReset } from '../../../../commands/setup/k3s/reset';
import { HELM_BIN_PATH, HELM_HOME_DIR, K8S_KUBECONFIG_DIR } from '../../../../services/orchestrator/kubernetes/constants';
import { Redactor } from '../../../../utils/redact';
import { FakeClock, FAKE_CLOCK_START } from '../../fakes/fake-clock';
import { FakeHostRunner } from '../../fakes/fake-host-runner';
import { assertExecutorInvariants, assertNoSecretLeak } from '../../support/invariants';

const KEY = 'server_1';
const redactor = new Redactor();
let runners: FakeHostRunner[] = [];

function host(): FakeHostRunner {
  const runner = new FakeHostRunner();
  runners.push(runner);
  return runner;
}

function seedInstalledK3s(runner: FakeHostRunner): void {
  runner.seedFile(K3S_BINARY, '#!fake k3s\n', { mode: 0o755 });
  runner.seedFile(K3S_NODE_STATE_FILE, JSON.stringify({ schema: 1, managedBy: 'dockflow' }), { mode: 0o600 });
  runner.seedFile('/usr/local/bin/k3s-killall.sh', '#!/bin/sh\n', { mode: 0o755 });
  runner.seedFile('/usr/local/bin/k3s-uninstall.sh', '#!/bin/sh\n', { mode: 0o755 });
  runner.seedFile('/usr/local/bin/k3s-agent-uninstall.sh', '#!/bin/sh\n', { mode: 0o755 });
}

afterEach(() => {
  const hostRunner = runners;
  runners = [];
  for (const runner of hostRunner) runner.assertDone();
  assertExecutorInvariants({ hostRunner, redactor });
});

describe('preserveData (18.3.1)', () => {
  it('moves volume data, snapshots and pre-upgrade copies, and copies the token and encryption config', async () => {
    const runner = host();
    const timestamp = 'K10a1b2c3::server:9f8e7d6c5b4a';
    runner.seedFile(`${K3S_STORAGE_DIR}/pvc-1/data.txt`, 'volume data');
    runner.seedFile(`${K3S_DATA_DIR}/server/db/snapshots/etcd-snapshot-1`, 'snapshot bytes');
    runner.seedFile(`${K3S_DATA_DIR}/server/db-dockflow-pre-v1.35.8-k3s1/state.db`, 'sqlite bytes');
    runner.seedFile(K3S_SERVER_TOKEN, timestamp);
    runner.seedFile(`${K3S_DATA_DIR}/server/cred/encryption-config.json`, '{"keys":[]}');

    const clock = new FakeClock(new Date(FAKE_CLOCK_START));
    const preserved = await preserveData(runner, clock);

    expect(preserved.path).toBe(`${PRESERVED_DIR}/20260101T000000Z`);
    expect(preserved.items).toEqual(['storage', 'etcd-snapshots', 'db-dockflow-pre-v1.35.8-k3s1', 'token', 'encryption-config.json']);
    expect(preserved.bytes).toBeGreaterThan(0);
    expect(await runner.stat(K3S_STORAGE_DIR)).toBeNull();
    expect(runner.text(`${preserved.path}/storage/pvc-1/data.txt`)).toBe('volume data');
    expect(runner.text(`${preserved.path}/token`)).toBe(timestamp);
    const tokenInfo = await runner.stat(`${preserved.path}/token`);
    expect(tokenInfo?.mode).toBe(0o600);
    expect(runner.text(`${preserved.path}/README.txt`)).toContain('cluster-reset-restore-path');
    assertNoSecretLeak(runner, [timestamp]);
  });

  it('an empty node preserves nothing but still writes README.txt', async () => {
    const runner = host();
    const clock = new FakeClock(new Date(FAKE_CLOCK_START));
    const preserved = await preserveData(runner, clock);
    expect(preserved.items).toEqual([]);
    expect(runner.text(`${preserved.path}/README.txt`)).not.toBe(null);
  });

  it('README.txt carries no secret text', () => {
    const readme = renderPreservedReadme();
    expect(readme).not.toContain('K10');
    expect(readme.length).toBeGreaterThan(0);
  });
});

describe('removeDockflowFiles (18.3)', () => {
  it('removes only the Dockflow files that exist; the deploy user and /var/lib/dockflow are kept', async () => {
    const runner = host();
    runner.seedFile(SUDOERS_K3S_FILE, 'x', { mode: 0o440 });
    runner.seedDir(K8S_KUBECONFIG_DIR);
    // HELM_HOME_DIR and HELM_BIN_PATH left absent on purpose (this node never installed Helm's cache)
    const removed = await removeDockflowFiles(runner);
    expect(removed).toEqual([SUDOERS_K3S_FILE, K8S_KUBECONFIG_DIR]);
    expect(await runner.stat(SUDOERS_K3S_FILE)).toBeNull();
    expect(await runner.stat('/var/lib/dockflow')).not.toBeNull();
  });

  it('removes every listed path when all are present', async () => {
    const runner = host();
    runner.seedFile(SUDOERS_K3S_FILE, 'x');
    runner.seedDir(K8S_KUBECONFIG_DIR);
    runner.seedDir(HELM_HOME_DIR);
    runner.seedFile(HELM_BIN_PATH, 'helm', { mode: 0o755 });
    runner.seedDir(DOWNLOAD_CACHE_DIR);
    const removed = await removeDockflowFiles(runner);
    expect(removed.sort()).toEqual([DOWNLOAD_CACHE_DIR, HELM_BIN_PATH, HELM_HOME_DIR, K8S_KUBECONFIG_DIR, SUDOERS_K3S_FILE].sort());
  });
});

describe('runNodeReset (18.3)', () => {
  it('runs firewall removal, killall, preserve-data, uninstall and dockflow-files removal in order', async () => {
    const runner = host();
    seedInstalledK3s(runner);
    runner.seedFile(`${K3S_STORAGE_DIR}/pvc-1/data.txt`, 'data');
    const clock = new FakeClock(new Date(FAKE_CLOCK_START));

    const report = await runNodeReset(runner, { key: KEY, role: 'server-init', deleteVolumes: false, clock });

    const order = runner.calls.map((call) => call.argv.join(' '));
    const killallIndex = order.findIndex((c) => c.includes('k3s-killall.sh'));
    const uninstallIndex = order.findIndex((c) => c.includes('k3s-uninstall.sh'));
    expect(killallIndex).toBeGreaterThanOrEqual(0);
    expect(uninstallIndex).toBeGreaterThan(killallIndex);
    expect(report.preserved.items).toContain('storage');
    // the real k3s-uninstall.sh removes /etc/rancher/k3s and the data dir itself (F6, simulated by the stock handler)
    expect(await runner.stat(K3S_BINARY)).toBeNull();
    expect(report.removed).toEqual([]);
  });

  it('--delete-volumes: nothing is preserved', async () => {
    const runner = host();
    seedInstalledK3s(runner);
    runner.seedFile(`${K3S_STORAGE_DIR}/pvc-1/data.txt`, 'data');
    const clock = new FakeClock(new Date(FAKE_CLOCK_START));
    const report = await runNodeReset(runner, { key: KEY, role: 'server-init', deleteVolumes: true, clock });
    expect(report.preserved).toEqual({ path: null, items: [], bytes: 0 });
  });

  it('a node without state.json but with k3s present is refused', async () => {
    const runner = host();
    runner.seedFile(K3S_BINARY, '#!fake k3s\n', { mode: 0o755 });
    const clock = new FakeClock(new Date(FAKE_CLOCK_START));
    let error: unknown;
    try {
      await runNodeReset(runner, { key: KEY, role: 'server-init', deleteVolumes: false, clock });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SetupStepError);
    expect((error as SetupStepError).message).toBe(resetMessages.notManagedByDockflow(KEY).message);
  });

  it('a node with no k3s at all and no state.json is a no-op reset (nothing to refuse)', async () => {
    const runner = host();
    const clock = new FakeClock(new Date(FAKE_CLOCK_START));
    // no killall/uninstall scripts on disk: an unmanaged, never-installed node
    let error: unknown;
    try {
      await runNodeReset(runner, { key: KEY, role: 'agent', deleteVolumes: true, clock });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SetupStepError);
  });
});
