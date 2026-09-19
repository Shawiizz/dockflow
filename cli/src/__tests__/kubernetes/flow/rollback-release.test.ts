// Full-stack rollback over the bundle (design-03 16, 22.8 RB rows) with FakeOrchestrator. What the
// Kubernetes `apply` does inside (registry Secret, kind switches, Redactor, Helm credentials) is
// asserted against the executors in backends/stack.test.ts; here, what the flow does around it.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { ServiceInfo, StackRef } from '../../../services/orchestrator/interfaces';
import { type RollbackReleaseArgs, rollbackRelease } from '../../../services/release';
import { err } from '../../../types/result';
import { DeployError, ErrorCode } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { fakeNode } from '../fakes/fake-kube-executor';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';
import { expectCliError } from '../support/matchers';

const STACK = 'shop-production';
const APP_REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const WAIT = { timeoutS: 300, intervalS: 5 };

function args(fields: Partial<RollbackReleaseArgs> = {}): RollbackReleaseArgs {
  return { ref: APP_REF, stackName: STACK, to: null, failedVersion: null, wait: WAIT, ...fields };
}

/** 1.4.0, 1.4.1 and 1.4.2 (current) */
function seeded(kind: 'k3s' | 'swarm' = 'k3s', options: ConstructorParameters<typeof FakeOrchestrator>[1] = {}): FakeOrchestrator {
  const orchestrator = new FakeOrchestrator(kind, options);
  orchestrator.seedRelease(STACK, { version: '1.4.0', epoch: 1 });
  orchestrator.seedRelease(STACK, { version: '1.4.1', epoch: 2 });
  orchestrator.seedRelease(STACK, { version: '1.4.2', epoch: 3 });
  return orchestrator;
}

function accessory(name: string): ServiceInfo {
  return {
    name,
    nativeName: name,
    kind: 'service',
    role: 'accessory',
    mode: 'replicated',
    image: `${name}:latest`,
    replicas: { running: 1, desired: 1 },
    ports: [],
    state: 'running',
  };
}

let warnings: string[] = [];
let dims: string[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  warnings = [];
  dims = [];
  spies = [
    spyOn(output, 'printWarning').mockImplementation((message: string) => {
      warnings.push(message);
    }),
    spyOn(output, 'printDim').mockImplementation((message: string) => {
      dims.push(message);
    }),
    spyOn(output, 'printInfo').mockImplementation(() => {}),
    spyOn(output, 'printDebug').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('RB1: order', () => {
  it('apply -> waitConvergence -> finalize -> setCurrent -> remove(failed)', async () => {
    const orchestrator = seeded();
    const stored = orchestrator.storedReleases(STACK);
    expect(stored.current).toBe('1.4.2');

    const version = await rollbackRelease(orchestrator, args({ to: '1.4.1', failedVersion: '1.4.2' }));

    expect(version).toBe('1.4.1');
    expect(orchestrator.events).toEqual([
      'releases.list',
      'releases.current',
      'releases.readArtifact:1.4.1',
      'stack.apply:app',
      'stack.waitConvergence:app',
      'stack.finalize:app',
      'releases.setCurrent:1.4.1',
      'releases.remove:1.4.2',
    ]);
    const [ref, target, artifact, options] = orchestrator.callsTo('stack.apply')[0] ?? [];
    expect(ref).toEqual(APP_REF);
    expect(target).toBe('1.4.1');
    expect(artifact).toMatchObject({ format: 'k8s-manifests/1', digest: 'fake-app-1.4.1' });
    expect(options).toEqual({ prune: true, services: null });
    expect(orchestrator.callsTo('stack.waitConvergence')[0]?.[1]).toEqual(WAIT);
    expect(orchestrator.callsTo('releases.remove')[0]).toEqual([STACK, '1.4.2']);
    expect(orchestrator.storedReleases(STACK)).toMatchObject({ current: '1.4.1', versions: ['1.4.1', '1.4.0'] });
  });

  it('`--allow-chart-drift` reaches the apply; without it the options carry no such key', async () => {
    const manual = seeded();
    await rollbackRelease(manual, args({ allowChartDrift: true }));
    expect(manual.callsTo('stack.apply')[0]?.[3]).toStrictEqual({ prune: true, services: null, allowChartDrift: true });

    for (const allowChartDrift of [undefined, false]) {
      const automatic = seeded();
      await rollbackRelease(automatic, args({ failedVersion: '1.4.2', allowChartDrift }));
      expect(automatic.callsTo('stack.apply')[0]?.[3]).toStrictEqual({ prune: true, services: null });
    }
  });

  it('without an explicit target, the failed version is skipped', async () => {
    const orchestrator = seeded();
    expect(await rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' }))).toBe('1.4.1');
  });

  it('a failed record that cannot be removed is a warning, the rollback still succeeds', async () => {
    const orchestrator = seeded();
    orchestrator.program('releases.remove', new Error('connection reset'));
    expect(await rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' }))).toBe('1.4.1');
    expect(orchestrator.storedReleases(STACK).current).toBe('1.4.1');
    expect(warnings).toEqual(['Could not remove failed release 1.4.2: connection reset']);
  });

  it('refuses when there is nothing to roll back to, or the target is the failed release', async () => {
    const lonely = new FakeOrchestrator('k3s');
    lonely.seedRelease(STACK, { version: '1.0.0', epoch: 1 });
    await expectCliError(rollbackRelease(lonely, args({ failedVersion: '1.0.0' })), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'No previous release available for rollback',
    });
    await expectCliError(rollbackRelease(seeded(), args({ to: '1.4.2', failedVersion: '1.4.2' })), {
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Release 1.4.2 is the failed release; nothing distinct to roll back to',
    });
    expect(lonely.events).not.toContain('stack.apply:app');
  });
});

describe('RB2: format mismatch', () => {
  it('ROLLBACK_FAILED and apply is never called', async () => {
    const orchestrator = seeded();
    orchestrator.seedRelease(STACK, { version: '1.3.9', epoch: 0, artifact: { format: 'swarm-compose/1' } }, { current: false });

    await expectCliError(rollbackRelease(orchestrator, args({ to: '1.3.9' })), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Release 1.3.9 was produced for swarm-compose/1 and cannot be applied with orchestrator: k3s',
    });
    expect(orchestrator.callsTo('stack.apply')).toEqual([]);
    expect(orchestrator.storedReleases(STACK).current).toBe('1.4.2');
  });

  it('the other way round on Swarm', async () => {
    const orchestrator = seeded('swarm');
    orchestrator.seedRelease(STACK, { version: '1.3.9', epoch: 0, artifact: { format: 'k8s-manifests/1' } }, { current: false });
    await expectCliError(rollbackRelease(orchestrator, args({ to: '1.3.9' })), {
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Release 1.3.9 was produced for k8s-manifests/1 and cannot be applied with orchestrator: swarm',
    });
    expect(orchestrator.callsTo('stack.apply')).toEqual([]);
  });
});

describe('RB3: not converged', () => {
  it('ROLLBACK_FAILED with the detail; setCurrent, finalize and remove are not called', async () => {
    const orchestrator = seeded();
    orchestrator.program('stack.waitConvergence', {
      status: 'timeout',
      failures: [{ service: 'web', reason: 'CrashLoopBackOff', message: 'Service web keeps crashing' }],
      message: 'Lost contact with the Kubernetes API on server_1 while waiting for web: connection reset',
    });

    await expectCliError(rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' })), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Rollback to 1.4.1 did not converge: Lost contact with the Kubernetes API on server_1 while waiting for web: connection reset',
      suggestion: 'Run `dockflow diagnose production`.',
    });
    expect(orchestrator.callsTo('releases.setCurrent')).toEqual([]);
    expect(orchestrator.callsTo('stack.finalize')).toEqual([]);
    expect(orchestrator.callsTo('releases.remove')).toEqual([]);
    // the cluster still runs the failed version, so its record stays
    expect(orchestrator.storedReleases(STACK)).toMatchObject({ current: '1.4.2', versions: ['1.4.2', '1.4.1', '1.4.0'] });
  });

  it('the first failure, then the status, when the result carries no message', async () => {
    const orchestrator = seeded();
    orchestrator.programOnce('stack.waitConvergence', {
      status: 'failed',
      failures: [{ service: 'web', reason: 'ImagePullBackOff', message: 'Service web cannot pull its image' }],
    });
    await expectCliError(rollbackRelease(orchestrator, args()), { message: 'Rollback to 1.4.1 did not converge: Service web cannot pull its image' });
    orchestrator.programOnce('stack.waitConvergence', { status: 'timeout', failures: [] });
    await expectCliError(rollbackRelease(orchestrator, args()), { message: 'Rollback to 1.4.1 did not converge: timeout' });
  });
});

describe('RB4: consecutive `dockflow rollback`', () => {
  it('the second one targets the release before current, not current again', async () => {
    const orchestrator = seeded();

    expect(await rollbackRelease(orchestrator, args())).toBe('1.4.1');
    expect(await rollbackRelease(orchestrator, args())).toBe('1.4.0');

    expect(orchestrator.events.filter((e) => e.startsWith('releases.readArtifact'))).toEqual([
      'releases.readArtifact:1.4.1',
      'releases.readArtifact:1.4.0',
    ]);
    expect(orchestrator.callsTo('releases.remove')).toEqual([]);
    expect(orchestrator.storedReleases(STACK)).toMatchObject({ current: '1.4.0', versions: ['1.4.2', '1.4.1', '1.4.0'] });
  });
});

describe('RB5: accessories are not rolled back (K45)', () => {
  async function withDigests(target: string | null, live: string | null): Promise<FakeOrchestrator> {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(STACK, { version: '1.4.1', epoch: 1, metadata: { accessories_digest: target } });
    orchestrator.seedRelease(STACK, { version: '1.4.2', epoch: 2, metadata: { accessories_digest: 'acc-1.4.2' } });
    orchestrator.program('stack.getServices', [accessory('db'), accessory('cache')]);
    if (live !== null) await orchestrator.releases.writeAccessoriesDigest(STACK, live);
    return orchestrator;
  }

  it('digests differ: a warning naming how many accessories kept the newer definition, then the dim suggestion', async () => {
    const orchestrator = await withDigests('acc-1.4.1', 'acc-1.4.2');

    await rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' }));

    expect(warnings).toEqual([
      'Accessories were not rolled back; 2 accessory service(s) still run the definition deployed after 1.4.1',
    ]);
    expect(dims).toEqual([
      '  Restore them by checking out the accessories.yml of 1.4.1 and running `dockflow deploy production --accessories`.',
    ]);
    expect(orchestrator.callsTo('stack.getServices')).toEqual([[{ ...APP_REF, role: 'accessory' }]]);
    // said after the release record moved, never instead of it
    expect(orchestrator.events.indexOf('releases.setCurrent:1.4.1')).toBeLessThan(orchestrator.events.indexOf('releases.readState'));
  });

  it('equal digests: no line', async () => {
    await rollbackRelease(await withDigests('acc-same', 'acc-same'), args({ failedVersion: '1.4.2' }));
    expect(warnings).toEqual([]);
    expect(dims).toEqual([]);
  });

  it('a digest missing on either side: nothing is claimed', async () => {
    const noTarget = await withDigests(null, 'acc-1.4.2');
    await rollbackRelease(noTarget, args({ failedVersion: '1.4.2' }));
    expect(noTarget.callsTo('releases.readState')).toEqual([]);

    await rollbackRelease(await withDigests('acc-1.4.1', null), args({ failedVersion: '1.4.2' }));
    expect(warnings).toEqual([]);
    expect(dims).toEqual([]);
  });

  it('a failing check never fails the rollback', async () => {
    const orchestrator = await withDigests('acc-1.4.1', 'acc-1.4.2');
    orchestrator.program('stack.getServices', new Error('connection reset'));
    expect(await rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' }))).toBe('1.4.1');
    expect(warnings).toEqual([]);
  });
});

describe('RB6: imported image missing on a node (K45)', () => {
  const content = [
    '# dockflow-artifact: k8s-manifests/1',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata: {name: web, namespace: dockflow-shop-production}',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - {name: web, image: dockflow.invalid/shop-web:1.4.1}',
    '        - {name: cache, image: redis:8-alpine}',
    '        - {name: api, image: dockflow.invalid/shop-api:1.4.1}',
  ].join('\n');

  function withImages(): FakeOrchestrator {
    const orchestrator = new FakeOrchestrator('k3s', { target: { workers: [fakeNode('worker-1'), fakeNode('worker-2')] } });
    orchestrator.seedRelease(STACK, { version: '1.4.1', epoch: 1, artifact: { content } });
    orchestrator.seedRelease(STACK, { version: '1.4.2', epoch: 2 });
    return orchestrator;
  }

  it('ROLLBACK_FAILED before any apply; setCurrent is not called', async () => {
    const orchestrator = withImages();
    orchestrator.program('images.verifyPresence', [{ node: 'worker-2', missing: ['dockflow.invalid/shop-web:1.4.1'] }]);

    await expectCliError(rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' })), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Release 1.4.1 cannot be applied: image dockflow.invalid/shop-web:1.4.1 is missing on worker-2',
      suggestion: 'Re-deploy that version with `dockflow deploy production 1.4.1`, or remove the affected node(s) from servers.yml.',
    });
    expect(orchestrator.callsTo('stack.apply')).toEqual([]);
    expect(orchestrator.callsTo('releases.setCurrent')).toEqual([]);
    expect(orchestrator.storedReleases(STACK).current).toBe('1.4.2');
  });

  it('checks only imported references, on every manager and worker', async () => {
    const orchestrator = withImages();
    await rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' }));

    const [images, nodes] = orchestrator.callsTo('images.verifyPresence')[0] ?? [];
    expect(images).toEqual(['dockflow.invalid/shop-web:1.4.1', 'dockflow.invalid/shop-api:1.4.1']);
    expect((nodes as { name: string }[]).map((node) => node.name)).toEqual(['server_1', 'worker-1', 'worker-2']);
    expect(orchestrator.events.indexOf('images.verifyPresence')).toBeLessThan(orchestrator.events.indexOf('stack.apply:app'));
  });

  it('names every node missing the reference', async () => {
    const orchestrator = withImages();
    orchestrator.program('images.verifyPresence', [
      { node: 'worker-1', missing: ['dockflow.invalid/shop-api:1.4.1'] },
      { node: 'worker-2', missing: ['dockflow.invalid/shop-web:1.4.1', 'dockflow.invalid/shop-api:1.4.1'] },
    ]);
    await expectCliError(rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' })), {
      message: 'Release 1.4.1 cannot be applied: image dockflow.invalid/shop-web:1.4.1 is missing on worker-2',
    });
    orchestrator.program('images.verifyPresence', [
      { node: 'worker-1', missing: ['dockflow.invalid/shop-api:1.4.1'] },
      { node: 'worker-2', missing: ['dockflow.invalid/shop-api:1.4.1'] },
    ]);
    await expectCliError(rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' })), {
      message: 'Release 1.4.1 cannot be applied: image dockflow.invalid/shop-api:1.4.1 is missing on worker-1, worker-2',
    });
  });

  it('a release with no imported image (registry or public images) needs no check', async () => {
    const orchestrator = seeded();
    await rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' }));
    expect(orchestrator.callsTo('images.verifyPresence')).toEqual([]);
  });
});

describe('RB7: registry Secret gone (K73), flow side', () => {
  it('the apply refusal is a ROLLBACK_FAILED with its text, and nothing after the apply runs', async () => {
    const orchestrator = seeded();
    orchestrator.program(
      'stack.apply',
      err(
        new DeployError(
          'Release 1.4.1 needs registry credentials that are no longer configured',
          ErrorCode.ROLLBACK_FAILED,
          'Restore `registry.username` and `registry.password` in config.yml, or roll back to a release that does not use the registry.',
        ),
      ),
    );

    await expectCliError(rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' })), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: 'Release 1.4.1 needs registry credentials that are no longer configured',
      suggestion:
        'Restore `registry.username` and `registry.password` in config.yml, or roll back to a release that does not use the registry.',
    });
    expect(orchestrator.events.slice(orchestrator.events.indexOf('stack.apply:app') + 1)).toEqual([]);
    expect(orchestrator.storedReleases(STACK)).toMatchObject({ current: '1.4.2', versions: ['1.4.2', '1.4.1', '1.4.0'] });
  });
});

describe('RB8: rollback across a kind switch (K15), flow side', () => {
  it('a stranded-claim refusal of the apply becomes ROLLBACK_FAILED and stops the rollback', async () => {
    const orchestrator = seeded();
    orchestrator.program(
      'stack.apply',
      err(
        new DeployError(
          'Service db changes from StatefulSet to Deployment and would stop using volume db-data, whose data is kept but no longer mounted',
          ErrorCode.DEPLOY_FAILED,
          'Keep the volume in the new definition, or move the data and remove it with `dockflow volumes rm production db-data`.',
        ),
      ),
    );

    const error = await expectCliError(rollbackRelease(orchestrator, args({ failedVersion: '1.4.2' })), {
      type: DeployError,
      code: ErrorCode.ROLLBACK_FAILED,
      message: /^Service db changes from StatefulSet to Deployment/,
    });
    expect(error.suggestion).toContain('dockflow volumes rm production db-data');
    expect(orchestrator.callsTo('stack.waitConvergence')).toEqual([]);
    expect(orchestrator.callsTo('releases.setCurrent')).toEqual([]);
  });
});
