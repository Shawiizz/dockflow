// T/commands/refusals.test.ts (P73-cli-integration, design-07 14.2): the cross-cutting checklist for
// every command-level refusal that must fire before any SSH work. Two concerns:
//   - U-CMD-REFUSE-01..06: one capability refusal each, asserted at the point the design names.
//   - U-CMD-TARGET-01: `--server <worker>` (D26, core 6.6 step 2) refused on every orchestrator
//     command, proven by actually reaching `resolveOrchestratorTarget` through each command's own
//     `run*` function and its own `options.server` field, not by asserting the shared helper alone.
// Individual command files assert their own refusal in more detail (day2.test.ts, helm.test.ts,
// volumes.test.ts, lifecycle.test.ts); this file is the one place every row of the design-07 table is
// checked, in one pass, against the wiring of every command that offers `--server`.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { assertBuildSupported } from '../../../commands/build';
import { runAccessoriesExec } from '../../../commands/accessories/exec';
import { runAccessoriesList } from '../../../commands/accessories/list';
import { runAccessoriesLogs } from '../../../commands/accessories/logs';
import { runAccessoriesRemove } from '../../../commands/accessories/remove';
import { runAccessoriesRestart } from '../../../commands/accessories/restart';
import { runAccessoriesStop } from '../../../commands/accessories/stop';
import { runCp } from '../../../commands/app/cp';
import { runDetails } from '../../../commands/app/details';
import { runDiagnose } from '../../../commands/app/diagnose';
import { runExec } from '../../../commands/app/exec';
import { runLogs } from '../../../commands/app/logs';
import { runMetrics } from '../../../commands/app/metrics';
import { runPrune } from '../../../commands/app/prune';
import { runPs } from '../../../commands/app/ps';
import { runRestart } from '../../../commands/app/restart';
import { runRollback } from '../../../commands/app/rollback';
import { runScale } from '../../../commands/app/scale';
import { runStop } from '../../../commands/app/stop';
import { runVersion } from '../../../commands/app/version';
import { runBackupList } from '../../../commands/backup/list';
import { openHelmCommand } from '../../../commands/helm/utils';
import { runListImages } from '../../../commands/list/images';
import { runListServices } from '../../../commands/list/services';
import { runLockAcquire } from '../../../commands/lock/acquire';
import { runLockRelease } from '../../../commands/lock/release';
import { runLockStatus } from '../../../commands/lock/status';
import { __setOrchestratorOpenerForTests, planPrune } from '../../../commands/shared/day2';
import { runVolumesList } from '../../../commands/volumes/list';
import { runVolumesRemove } from '../../../commands/volumes/remove';
import { capabilitiesFor } from '../../../services/orchestrator/capabilities';
import type { OpenedOrchestrator } from '../../../services/orchestrator/factory';
import { resolveOrchestratorTarget, type ResolveTargetOptions } from '../../../services/orchestrator/target';
import type { ResolvedServer } from '../../../types/servers';
import { UnsupportedOperationError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { config } from '../support/builders';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

// decorative, never asserted on: silenced so a refusal reached before any output still prints nothing
const DECORATIVE = ['printIntro', 'printInfo', 'printBlank', 'printWarning'] as const;
let decorativeSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  decorativeSpies = DECORATIVE.map((name) => spyOn(output, name).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of decorativeSpies) spy.mockRestore();
});

// ---------------------------------------------------------------------------
// U-CMD-REFUSE-01..06
// ---------------------------------------------------------------------------

describe('capability refusals fire before any SSH', () => {
  it('U-CMD-REFUSE-01: exec --user root on k3s', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    __setOrchestratorOpenerForTests(async () => ({ config: config(), orchestrator }));
    try {
      await expect(runExec('production', 'web', [], { user: 'root' }, () => 'k3s')).rejects.toMatchObject({
        message: 'dockflow exec --user is not supported with orchestrator: k3s: the Kubernetes exec API runs commands as the container user',
      });
      expect(orchestrator.remoteWorkTripped).toBe(false);
    } finally {
      __setOrchestratorOpenerForTests(null);
    }
  });

  it('U-CMD-REFUSE-02: build --remote / options.remote_build on k3s', () => {
    expect(() => assertBuildSupported({ orchestrator: 'k3s', options: { remote_build: true } })).toThrow(UnsupportedOperationError);
  });

  it('U-CMD-REFUSE-03: helm list on Swarm, refused before openOrchestrator', async () => {
    let opened = false;
    await expect(
      openHelmCommand('production', {}, 'dockflow helm list', {
        loadConfig: () => config({ orchestrator: 'swarm' }),
        openOrchestrator: async () => {
          opened = true;
          throw new Error('test setup: openOrchestrator should never be reached');
        },
      }),
    ).rejects.toMatchObject({ message: 'dockflow helm list requires orchestrator: k3s', suggestion: 'Helm releases are only supported on Kubernetes.' });
    expect(opened).toBe(false);
  });

  it('U-CMD-REFUSE-04: volumes list on Swarm, refused before openDay2', async () => {
    let opened = false;
    __setOrchestratorOpenerForTests(async () => {
      opened = true;
      throw new Error('test setup: openDay2 should never be reached');
    });
    try {
      await expect(runVolumesList('production', {}, () => 'swarm')).rejects.toMatchObject({
        message: 'dockflow volumes list is not supported with orchestrator: swarm',
        suggestion: 'List Swarm volumes on a node with `dockflow ssh <env>`, then `docker volume ls`.',
      });
      expect(opened).toBe(false);
    } finally {
      __setOrchestratorOpenerForTests(null);
    }
  });

  it('U-CMD-REFUSE-05: prune --networks on k3s, no suggestion', () => {
    try {
      planPrune({ networks: true }, capabilitiesFor('k3s'));
      throw new Error('test setup: expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      const refusal = error as UnsupportedOperationError;
      expect(refusal.message).toBe('dockflow prune --networks is not supported with orchestrator: k3s: the pod network is managed by the cluster');
      expect(refusal.suggestion).toBeUndefined();
    }
  });

  it('U-CMD-REFUSE-06: prune --volumes on k3s, points to volumes rm', () => {
    try {
      planPrune({ volumes: true }, capabilitiesFor('k3s'));
      throw new Error('test setup: expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect((error as UnsupportedOperationError).suggestion).toContain('dockflow volumes rm');
    }
  });
});

// ---------------------------------------------------------------------------
// U-CMD-TARGET-01: --server <worker> on every orchestrator command
// ---------------------------------------------------------------------------

const TARGET_ENV = 'production';
const MANAGER_NAME = 'server_1';
const WORKER_NAME = 'agent_1';

function testServer(name: string, role: 'manager' | 'worker'): ResolvedServer {
  return {
    name,
    role,
    host: '10.0.0.1',
    privateHost: '10.0.0.1',
    declaredPrivateHost: null,
    nodeLabels: {},
    port: 22,
    user: 'dockflow',
    env: {},
    tags: [TARGET_ENV],
  };
}

const TARGET_TEST_SERVERS: readonly ResolvedServer[] = [testServer(MANAGER_NAME, 'manager'), testServer(WORKER_NAME, 'worker')];

/**
 * Every orchestrator command funnels `--server` into `resolveOrchestratorTarget` through one of two
 * seams (`openDay2`'s `orchestratorOpener`, `openHelmCommand`'s `HelmCommandDeps.openOrchestrator`).
 * This stub runs the REAL resolution (D26) against a fixed manager+worker pair instead of a fake
 * bundle, so a command that forgot to forward its own `--server` option would reach here with
 * `options.server` undefined, resolve the manager, and never throw — catching the wiring bug the
 * shared helper's own unit test (`orchestrator/target.test.ts`) cannot see.
 */
async function workerRefusalOpener(env: string, options?: ResolveTargetOptions): Promise<OpenedOrchestrator> {
  await resolveOrchestratorTarget(env, config({ orchestrator: 'k3s' }), { ...options, servers: TARGET_TEST_SERVERS });
  throw new Error('test setup: resolveOrchestratorTarget accepted the worker instead of refusing it');
}

const WORKER_REFUSAL = {
  message: `${WORKER_NAME} is a worker (k3s agent); orchestrator commands run on a manager`,
  suggestion: `Use one of: ${MANAGER_NAME}`,
};

async function expectWorkerRefusal(run: Promise<unknown>): Promise<void> {
  await expect(run).rejects.toMatchObject(WORKER_REFUSAL);
}

const cleanups: (() => void)[] = [];

function grantManagerCredentials(): void {
  const key = `${TARGET_ENV.toUpperCase()}_${MANAGER_NAME.toUpperCase()}_SSH_PRIVATE_KEY`;
  process.env[key] = 'test-private-key';
  cleanups.push(() => {
    delete process.env[key];
  });
}

describe('U-CMD-TARGET-01: --server <worker> is refused on every orchestrator command', () => {
  beforeEach(() => {
    grantManagerCredentials();
    __setOrchestratorOpenerForTests(workerRefusalOpener);
  });

  afterEach(() => {
    __setOrchestratorOpenerForTests(null);
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const SERVER = { server: WORKER_NAME };

  it('exec', async () => {
    await expectWorkerRefusal(runExec(TARGET_ENV, 'web', [], SERVER));
  });
  it('cp', async () => {
    await expectWorkerRefusal(runCp(TARGET_ENV, 'web:/app/logs', './logs', SERVER));
  });
  it('details', async () => {
    await expectWorkerRefusal(runDetails(TARGET_ENV, SERVER));
  });
  it('diagnose', async () => {
    await expectWorkerRefusal(runDiagnose(TARGET_ENV, SERVER));
  });
  it('logs', async () => {
    await expectWorkerRefusal(runLogs(TARGET_ENV, 'web', SERVER));
  });
  it('ps', async () => {
    await expectWorkerRefusal(runPs(TARGET_ENV, SERVER));
  });
  it('restart', async () => {
    await expectWorkerRefusal(runRestart(TARGET_ENV, 'web', SERVER));
  });
  it('rollback', async () => {
    await expectWorkerRefusal(runRollback(TARGET_ENV, undefined, SERVER));
  });
  it('scale', async () => {
    await expectWorkerRefusal(runScale(TARGET_ENV, 'web', '2', SERVER));
  });
  it('stop', async () => {
    await expectWorkerRefusal(runStop(TARGET_ENV, SERVER));
  });
  it('version', async () => {
    await expectWorkerRefusal(runVersion(TARGET_ENV, SERVER));
  });
  it('metrics', async () => {
    await expectWorkerRefusal(runMetrics(TARGET_ENV, SERVER));
  });
  it('prune', async () => {
    await expectWorkerRefusal(runPrune(TARGET_ENV, { ...SERVER, yes: true }, () => 'k3s'));
  });

  it('accessories list', async () => {
    await expectWorkerRefusal(runAccessoriesList(TARGET_ENV, SERVER));
  });
  it('accessories logs', async () => {
    await expectWorkerRefusal(runAccessoriesLogs(TARGET_ENV, undefined, SERVER));
  });
  it('accessories exec', async () => {
    await expectWorkerRefusal(runAccessoriesExec(TARGET_ENV, 'db', [], SERVER));
  });
  it('accessories restart', async () => {
    await expectWorkerRefusal(runAccessoriesRestart(TARGET_ENV, undefined, SERVER));
  });
  it('accessories stop', async () => {
    await expectWorkerRefusal(runAccessoriesStop(TARGET_ENV, undefined, SERVER));
  });
  it('accessories remove', async () => {
    await expectWorkerRefusal(runAccessoriesRemove(TARGET_ENV, SERVER));
  });

  // backup create/restore/prune read `.dockflow/config.yml`'s `backup.*` section before opening the
  // orchestrator (`requireBackupConfig`/`configuredSources`), with no injectable seam; exercising them
  // here would depend on this checkout's own project files, which the suite must never do. `backup
  // list` opens the orchestrator first (`collect()` reads config only afterwards), so it alone is
  // covered; the other two forward `options.server` to the identical `openDay2({server: ...})` call.
  it('backup list', async () => {
    await expectWorkerRefusal(runBackupList(TARGET_ENV, undefined, SERVER));
  });

  it('list services', async () => {
    await expectWorkerRefusal(runListServices(TARGET_ENV, SERVER));
  });
  it('list images', async () => {
    await expectWorkerRefusal(runListImages(TARGET_ENV, SERVER));
  });

  it('lock acquire', async () => {
    await expectWorkerRefusal(runLockAcquire(TARGET_ENV, SERVER));
  });
  it('lock release', async () => {
    await expectWorkerRefusal(runLockRelease(TARGET_ENV, SERVER));
  });
  it('lock status', async () => {
    await expectWorkerRefusal(runLockStatus(TARGET_ENV, SERVER));
  });

  it('volumes list', async () => {
    await expectWorkerRefusal(runVolumesList(TARGET_ENV, SERVER, () => 'k3s'));
  });
  it('volumes rm', async () => {
    await expectWorkerRefusal(runVolumesRemove(TARGET_ENV, ['data'], SERVER, () => 'k3s'));
  });

  // Every `dockflow helm *` subcommand opens its context with this exact call
  // (`openHelmCommand(env, { server: options.server }, '<operation>')`), so proving the seam once per
  // operation name covers all six the same way testing `openDay2` per command covers the rest.
  const HELM_OPERATIONS = [
    'dockflow helm list',
    'dockflow helm status',
    'dockflow helm history',
    'dockflow helm values',
    'dockflow helm rollback',
    'dockflow helm uninstall',
  ];
  for (const operation of HELM_OPERATIONS) {
    it(operation, async () => {
      await expectWorkerRefusal(
        openHelmCommand(TARGET_ENV, SERVER, operation, {
          loadConfig: () => config({ orchestrator: 'k3s' }),
          openOrchestrator: workerRefusalOpener,
        }),
      );
    });
  }
});
