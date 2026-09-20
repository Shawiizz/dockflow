// T/commands/volumes.test.ts (P71-volumes-backup-commands, design-06 3.17): `dockflow volumes
// list|rm` over `FakeOrchestrator`, following the day2.test.ts / helm.test.ts pattern (no
// `mock.module`; `__setOrchestratorOpenerForTests` injects the fake bundle).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { runVolumesList } from '../../../commands/volumes/list';
import { runVolumesRemove } from '../../../commands/volumes/remove';
import { __setOrchestratorOpenerForTests } from '../../../commands/shared/day2';
import { K8S_STORAGE_CLASS } from '../../../services/orchestrator/kubernetes/constants';
import type { HelmReleaseStatus, VolumeInfo, VolumeRemovalReport } from '../../../services/orchestrator/interfaces';
import { DeployError, UnsupportedOperationError, ValidationError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function volume(overrides: Partial<VolumeInfo> = {}): VolumeInfo {
  return {
    name: 'db-data',
    composeName: 'db_data',
    role: 'accessory',
    phase: 'Bound',
    capacity: '10Gi',
    storageClass: K8S_STORAGE_CLASS,
    node: 'server-1',
    reclaimPolicy: 'Retain',
    usedBy: ['db'],
    hostPath: '/var/lib/dockflow/volumes/db-data',
    ...overrides,
  };
}

function release(overrides: Partial<HelmReleaseStatus> = {}): HelmReleaseStatus {
  return { name: 'search', namespace: 'dockflow-metrics', role: 'app', revision: 3, status: 'deployed', chart: 'search-1.0.0', appVersion: null, updated: null, ...overrides };
}

function open(orchestrator: FakeOrchestrator): void {
  __setOrchestratorOpenerForTests(async () => ({ config: { project_name: 'shop', orchestrator: orchestrator.kind }, orchestrator }));
}

// decorative, never asserted on
const decorative = ['printIntro', 'printOutro', 'printBlank'] as const;
let decorativeSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  decorativeSpies = decorative.map((name) => spyOn(output, name).mockImplementation(() => {}));
});

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
  for (const spy of decorativeSpies) spy.mockRestore();
});

describe('runVolumesList', () => {
  it('R-05: refuses on Swarm before any opener call', async () => {
    let opened = false;
    __setOrchestratorOpenerForTests(async () => {
      opened = true;
      throw new Error('should never be reached');
    });
    await expect(runVolumesList('production', {}, () => 'swarm')).rejects.toThrow(UnsupportedOperationError);
    expect(opened).toBe(false);
  });

  it('the refusal message matches the shared volumes capability constant', async () => {
    await expect(runVolumesList('production', {}, () => 'swarm')).rejects.toMatchObject({
      message: 'dockflow volumes list is not supported with orchestrator: swarm',
    });
  });

  it('rejects an invalid --role', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);
    await expect(runVolumesList('production', { role: 'bogus' }, () => 'k3s')).rejects.toThrow(ValidationError);
  });

  it('--system and --namespace cannot be combined', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);
    await expect(runVolumesList('production', { system: true, namespace: 'dockflow-metrics' }, () => 'k3s')).rejects.toThrow(ValidationError);
  });

  it('--namespace must name a Helm release owned by this stack', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [release({ namespace: 'dockflow-other' })]);
    open(orchestrator);
    await expect(runVolumesList('production', { namespace: 'dockflow-metrics' }, () => 'k3s')).rejects.toThrow(
      'Namespace dockflow-metrics holds no Helm release of shop-production',
    );
  });

  it('a matching --namespace is passed through to volumes.list', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [release({ namespace: 'dockflow-metrics' })]);
    orchestrator.program('volumes.list', []);
    open(orchestrator);

    await runVolumesList('production', { namespace: 'dockflow-metrics' }, () => 'k3s');

    const calls = orchestrator.callsTo('volumes.list');
    expect(calls[0][0]).toMatchObject({ namespace: 'dockflow-metrics', role: null });
  });

  it('prints "No volumes" when the listing is empty', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', []);
    open(orchestrator);
    const info = spyOn(output, 'printInfo').mockImplementation(() => {});

    await runVolumesList('production', {}, () => 'k3s');

    expect(info).toHaveBeenCalledWith(expect.stringContaining('No volumes in'));
  });

  it('--json prints the shared {stack, namespace, items} shape', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);
    const json = spyOn(output, 'printJSON').mockImplementation(() => {});

    await runVolumesList('production', { json: true }, () => 'k3s');

    expect(json).toHaveBeenCalledWith({ stack: 'shop-production', namespace: 'dockflow-shop-production', items: [volume()] });
  });

  it('flags a Delete-policy PV of the Dockflow class still bound to its claim, and prints the footer', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume({ name: 'stray', reclaimPolicy: 'Delete' }), volume({ name: 'other-class', reclaimPolicy: 'Delete', storageClass: 'other' })]);
    open(orchestrator);
    const warning = spyOn(output, 'printWarning').mockImplementation(() => {});
    const raw = spyOn(output, 'printRaw').mockImplementation(() => {});

    await runVolumesList('production', {}, () => 'k3s');

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('1 volume(s) are set to Delete'));
    const flaggedRow = raw.mock.calls.map((call) => call[0] as string).find((line) => line.includes('stray'));
    expect(flaggedRow).toContain('(expected Retain)');
  });
});

describe('runVolumesRemove', () => {
  it('R-05: refuses on Swarm before any opener call', async () => {
    let opened = false;
    __setOrchestratorOpenerForTests(async () => {
      opened = true;
      throw new Error('should never be reached');
    });
    await expect(runVolumesRemove('production', ['db-data'], {}, () => 'swarm')).rejects.toThrow(UnsupportedOperationError);
    expect(opened).toBe(false);
  });

  it('requires at least one name', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);
    await expect(runVolumesRemove('production', [], {}, () => 'k3s')).rejects.toThrow(ValidationError);
  });

  it('--system and --namespace cannot be combined', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);
    await expect(runVolumesRemove('production', ['db-data'], { system: true, namespace: 'dockflow-metrics' }, () => 'k3s')).rejects.toThrow(ValidationError);
  });

  it('--namespace must name a Helm release owned by this stack', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', []);
    orchestrator.program('volumes.list', []);
    open(orchestrator);
    await expect(runVolumesRemove('production', ['db-data'], { namespace: 'dockflow-metrics' }, () => 'k3s')).rejects.toThrow(
      'Namespace dockflow-metrics holds no Helm release of shop-production',
    );
  });

  it('U-CMD-DAY2-05: without -y in a non-interactive session, a mismatched confirmation cancels with no backend call', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);
    const info = spyOn(output, 'printInfo').mockImplementation(() => {});

    await runVolumesRemove('production', ['db-data'], {}, () => 'k3s');

    expect(info).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    expect(orchestrator.callsTo('volumes.remove').length).toBe(0);
    expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
  });

  it('-y deletes without prompting, takes the lock and releases it, and reports the outcome by name', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume({ name: 'db-data' }), volume({ name: 'cache-data' }), volume({ name: 'uploads' })]);
    const report: VolumeRemovalReport = {
      deleted: [{ claim: 'db-data', volume: 'pvc-1' }],
      restored: ['cache-data'],
      restoreFailed: [{ volume: 'uploads', policy: 'Delete', error: 'timeout' }],
    };
    orchestrator.program('volumes.remove', report);
    open(orchestrator);
    const success = spyOn(output, 'printSuccess').mockImplementation(() => {});
    const warning = spyOn(output, 'printWarning').mockImplementation(() => {});
    const raw = spyOn(output, 'printRaw').mockImplementation(() => {});

    await runVolumesRemove('production', ['db-data', 'cache-data', 'uploads'], { yes: true }, () => 'k3s');

    expect(success).toHaveBeenCalledWith('Deleted 1 volume(s)');
    const lines = raw.mock.calls.map((call) => call[0] as string);
    expect(lines).toContainEqual(expect.stringContaining('Volume db-data: deleted'));
    expect(lines).toContainEqual(expect.stringContaining('Volume cache-data: not deleted'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Volume uploads: not deleted and its reclaim policy could not be restored'));
    expect(orchestrator.events).toContain('lock.acquire');
    expect(orchestrator.events.indexOf('lock.acquire')).toBeLessThan(orchestrator.events.indexOf('volumes.remove'));
    expect(orchestrator.events.indexOf('volumes.remove')).toBeLessThan(orchestrator.events.indexOf('lock.release'));
  });

  it('the ACME claim warning is printed for `--system dockflow-traefik` before the confirmation', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume({ name: 'dockflow-traefik', composeName: null })]);
    open(orchestrator);
    const warning = spyOn(output, 'printWarning').mockImplementation(() => {});

    await runVolumesRemove('production', ['dockflow-traefik'], { system: true }, () => 'k3s');

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('holds the ACME account key'));
  });

  it('2.8: a lock already held by another deploy fails with DEPLOY_LOCKED and never calls remove', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);
    const held = await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'other deploy' });
    expect(held.success).toBe(true);

    await expect(runVolumesRemove('production', ['db-data'], { yes: true }, () => 'k3s')).rejects.toThrow(DeployError);
    expect(orchestrator.callsTo('volumes.remove').length).toBe(0);
  });
});
