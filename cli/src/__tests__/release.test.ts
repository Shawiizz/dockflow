import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { DeployReceipt, ReleaseMetadata, RevertResult, StackRef } from '../services/orchestrator/interfaces';
import {
  composeImages,
  importedImages,
  releaseEpoch,
  rollbackRelease,
  selectRetention,
  selectRollbackTarget,
  settles,
} from '../services/release';
import { ok } from '../types/result';
import { DeployError, ErrorCode } from '../utils/errors';
import * as output from '../utils/output';
import { FakeOrchestrator } from './kubernetes/fakes/fake-orchestrator';
import { expectCliError } from './kubernetes/support/matchers';

const STACK = 'shop-production';
const APP_REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const WAIT = { timeoutS: 300, intervalS: 5 };

function meta(version: string, epoch: number, fields: Partial<ReleaseMetadata> = {}): ReleaseMetadata {
  return {
    project_name: 'shop',
    version,
    env: 'production',
    timestamp: new Date(Date.UTC(2026, 0, 1) + epoch * 1000).toISOString(),
    epoch,
    performer: 'ci',
    branch: 'main',
    ...fields,
  };
}

const versions = (list: readonly ReleaseMetadata[]): string[] => list.map((r) => r.version);

let warnings: string[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  warnings = [];
  spies = [
    spyOn(output, 'printWarning').mockImplementation((message: string) => {
      warnings.push(message);
    }),
    spyOn(output, 'printInfo').mockImplementation(() => {}),
    spyOn(output, 'printDim').mockImplementation(() => {}),
    spyOn(output, 'printDebug').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

// ---------------------------------------------------------------------------
// Pure helpers (design-03 22.2)
// ---------------------------------------------------------------------------

describe('selectRetention', () => {
  const list = [meta('1.0.0', 1), meta('1.1.0', 2), meta('1.2.0', 3), meta('1.3.0', 4), meta('1.4.0', 5)];

  it('keeps the newest `keep` releases by epoch and removes the rest, newest first', () => {
    const { kept, removed } = selectRetention(list, '1.4.0', 3);
    expect(versions(kept)).toEqual(['1.4.0', '1.3.0', '1.2.0']);
    expect(versions(removed)).toEqual(['1.1.0', '1.0.0']);
  });

  it('keeps current when it is older than the newest `keep` (after a rollback)', () => {
    const { kept, removed } = selectRetention(list, '1.0.0', 3);
    expect(versions(kept)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.0.0']);
    expect(versions(removed)).toEqual(['1.1.0']);
  });

  it('removes nothing when keep >= the number of releases', () => {
    expect(versions(selectRetention(list, '1.4.0', 5).removed)).toEqual([]);
    expect(versions(selectRetention(list, '1.4.0', 9).kept)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']);
  });

  it('keep 0 keeps current only; a current absent from the list keeps nothing extra', () => {
    expect(versions(selectRetention(list, '1.2.0', 0).kept)).toEqual(['1.2.0']);
    expect(versions(selectRetention(list, '9.9.9', 2).kept)).toEqual(['1.4.0', '1.3.0']);
    expect(versions(selectRetention(list, null, 2).removed)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
  });

  it('sorts unsorted input, ties on epoch by version descending', () => {
    const shuffled = [meta('1.0.0', 1), meta('1.2.0', 3), meta('1.1.b', 2), meta('1.1.a', 2)];
    expect(versions(selectRetention(shuffled, null, 2).kept)).toEqual(['1.2.0', '1.1.b']);
  });
});

describe('selectRollbackTarget', () => {
  const list = [meta('1.2.0', 3), meta('1.0.0', 1), meta('1.1.0', 2)];

  it('targets the release right before current', () => {
    expect(selectRollbackTarget(list, '1.2.0', null)?.version).toBe('1.1.0');
  });

  it('after a rollback, targets the release before current, not current again', () => {
    expect(selectRollbackTarget(list, '1.1.0', null)?.version).toBe('1.0.0');
  });

  it('with the failed version known, the newest release other than it', () => {
    expect(selectRollbackTarget(list, '1.1.0', '1.2.0')?.version).toBe('1.1.0');
    expect(selectRollbackTarget(list, '1.2.0', '9.9.9')?.version).toBe('1.2.0');
    expect(selectRollbackTarget([meta('1.2.0', 3)], '1.2.0', '1.2.0')).toBeNull();
  });

  it('without a current record, skips the newest (what runs)', () => {
    expect(selectRollbackTarget(list, null, null)?.version).toBe('1.1.0');
    expect(selectRollbackTarget(list, '7.0.0', null)?.version).toBe('1.1.0');
  });

  it('null when nothing is older', () => {
    expect(selectRollbackTarget(list, '1.0.0', null)).toBeNull();
    expect(selectRollbackTarget([meta('1.0.0', 1)], null, null)).toBeNull();
    expect(selectRollbackTarget([], null, null)).toBeNull();
  });
});

describe('releaseEpoch', () => {
  const t0 = Date.UTC(2026, 0, 1) / 1000;
  const now = new Date((t0 + 100.5) * 1000);

  it('is the deploy time in seconds when every stored release is older', () => {
    expect(releaseEpoch(now, [])).toBe(t0 + 100);
    expect(releaseEpoch(now, [meta('1.0.0', t0 + 99)])).toBe(t0 + 100);
  });

  it('comes after a release written by a machine whose clock was ahead, or in the same second', () => {
    expect(releaseEpoch(now, [meta('1.0.0', t0), meta('1.0.1', t0 + 160)])).toBe(t0 + 161);
    expect(releaseEpoch(now, [meta('1.0.1', t0 + 100)])).toBe(t0 + 101);
  });

  it('keeps the order of the deploys for the rollback target', () => {
    const stored = [meta('1.0.0', t0), meta('1.0.1', t0 + 160)];
    const list = [...stored, meta('1.0.2', releaseEpoch(now, stored))];
    expect(selectRollbackTarget(list, '1.0.2', null)?.version).toBe('1.0.1');
  });
});

describe('composeImages', () => {
  it('lists service images in order without duplicates, whatever the quoting', () => {
    const compose = [
      'services:',
      '  web:',
      '    image: registry.example.com/shop/web:1.4.2',
      '  worker:',
      "    image: 'registry.example.com/shop/web:1.4.2'",
      '  cache:',
      '    image: "redis:8-alpine"',
      '  built:',
      '    build: .',
    ].join('\n');
    expect(composeImages(compose)).toEqual(['registry.example.com/shop/web:1.4.2', 'redis:8-alpine']);
  });

  it('resolves merge keys', () => {
    const compose = ['x-base: &base', '  image: shop/api:2', 'services:', '  api:', '    <<: *base'].join('\n');
    expect(composeImages(compose)).toEqual(['shop/api:2']);
  });

  it('null, empty and unreadable composes have no images', () => {
    expect(composeImages(null)).toEqual([]);
    expect(composeImages('')).toEqual([]);
    expect(composeImages('services: [unclosed')).toEqual([]);
    expect(composeImages('services: {}')).toEqual([]);
  });
});

describe('importedImages', () => {
  it('keeps the references Dockflow imported into the nodes, from containers and init containers', () => {
    const content = [
      '# dockflow-artifact: k8s-manifests/1',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata: {name: web, namespace: dockflow-shop-production}',
      'spec:',
      '  template:',
      '    spec:',
      '      initContainers:',
      '        - {name: migrate, image: dockflow.invalid/shop-web:1.4.1}',
      '      containers:',
      '        - {name: web, image: dockflow.invalid/shop-web:1.4.1}',
      '        - {name: proxy, image: "nginx:1.27"}',
      '---',
      'apiVersion: apps/v1',
      'kind: StatefulSet',
      'metadata: {name: api, namespace: dockflow-shop-production}',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - {name: api, image: dockflow.invalid/shop-api:1.4.1}',
      '        - {name: sidecar, image: registry.example.com/shop/sidecar:3}',
    ].join('\n');
    expect(importedImages(content)).toEqual(['dockflow.invalid/shop-web:1.4.1', 'dockflow.invalid/shop-api:1.4.1']);
  });

  it('reads Job pod templates, and never an `image` key outside a container list', () => {
    const content = [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata: {name: migrate, namespace: dockflow-shop-production}',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - {name: migrate, image: dockflow.invalid/shop-migrate:1.4.1}',
      '---',
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata: {name: settings, namespace: dockflow-shop-production}',
      'data:',
      '  image: dockflow.invalid/not-an-image:1',
    ].join('\n');
    expect(importedImages(content)).toEqual(['dockflow.invalid/shop-migrate:1.4.1']);
  });

  it('a Swarm stack file has none', () => {
    expect(importedImages('# dockflow-artifact: swarm-compose/1\nservices:\n  web:\n    image: shop/web:1.4.1\n')).toEqual([]);
  });
});

describe('settles (design-03 3.4, PD-8)', () => {
  const reverted: RevertResult = { status: 'reverted', services: ['web'], message: 'reverted web to 1.4.1' };
  const nothing: RevertResult = { status: 'nothing-to-revert', services: [] };
  const failed: RevertResult = { status: 'failed', services: ['web'], message: 'did not converge' };
  const native: RevertResult = { status: 'native', services: [] };

  it('a confirmed revert settles the role', () => {
    expect(settles(reverted, '1.4.1', false)).toBe(true);
    expect(settles(reverted, null, false)).toBe(true);
  });

  it('nothing-to-revert settles only a first deploy', () => {
    expect(settles(nothing, null, false)).toBe(true);
    // failure_action pause/continue or a Job: the failed version still runs
    expect(settles(nothing, '1.4.1', false)).toBe(false);
  });

  it('a failed revert never settles', () => {
    expect(settles(failed, '1.4.1', false)).toBe(false);
    expect(settles(failed, null, true)).toBe(false);
  });

  it('native settles exactly when Swarm rolled back', () => {
    expect(settles(native, '1.4.1', true)).toBe(true);
    expect(settles(native, '1.4.1', false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Swarm regression rows (design-07 15)
// ---------------------------------------------------------------------------

describe('U-SWARM-08: a release written before stack.yml existed', () => {
  // FileReleaseStore.readArtifact falls back to docker-compose.yml with format swarm-compose/1
  // (asserted against the store in stores/file-stores.test.ts); here, what the rollback does with it.
  const oldCompose = 'services:\n  web:\n    image: shop/web:1.4.1\n';
  const oldRelease = {
    version: '1.4.1',
    epoch: 1,
    compose: oldCompose,
    artifact: { format: 'swarm-compose/1' as const, content: oldCompose, digest: '' },
    metadata: { orchestrator: undefined, artifact_format: undefined },
  };

  it('is applied as a swarm-compose/1 artifact on Swarm', async () => {
    const swarm = new FakeOrchestrator('swarm');
    swarm.seedRelease(STACK, oldRelease);
    swarm.seedRelease(STACK, { version: '1.4.2', epoch: 2 });

    expect(await rollbackRelease(swarm, { ref: APP_REF, stackName: STACK, to: null, failedVersion: null, wait: WAIT })).toBe('1.4.1');

    const [, version, artifact, options] = swarm.callsTo('stack.apply')[0] ?? [];
    expect(version).toBe('1.4.1');
    expect(artifact).toMatchObject({ format: 'swarm-compose/1', content: oldCompose });
    expect(options).toEqual({ prune: true, services: null });
    expect(swarm.callsTo('images.verifyPresence')).toEqual([]);
    expect(swarm.storedReleases(STACK).current).toBe('1.4.1');
  });

  it('is refused on k3s before anything is applied', async () => {
    const k3s = new FakeOrchestrator('k3s');
    k3s.seedRelease(STACK, oldRelease);
    k3s.seedRelease(STACK, { version: '1.4.2', epoch: 2 });

    await expectCliError(
      rollbackRelease(k3s, { ref: APP_REF, stackName: STACK, to: null, failedVersion: null, wait: WAIT }),
      {
        type: DeployError,
        code: ErrorCode.ROLLBACK_FAILED,
        message: 'Release 1.4.1 was produced for swarm-compose/1 and cannot be applied with orchestrator: k3s',
      },
    );
    expect(k3s.events).not.toContain('stack.apply:app');
    expect(k3s.storedReleases(STACK).current).toBe('1.4.2');
  });
});

describe('U-SWARM-10: rollbackRelease finalizes on both orchestrators', () => {
  for (const kind of ['swarm', 'k3s'] as const) {
    it(`${kind}: finalize receives the apply receipt, after the convergence wait and before setCurrent`, async () => {
      const orchestrator = new FakeOrchestrator(kind);
      orchestrator.seedRelease(STACK, { version: '1.4.1', epoch: 1 });
      orchestrator.seedRelease(STACK, { version: '1.4.2', epoch: 2 });
      const receipt: DeployReceipt = {
        ref: APP_REF,
        version: '1.4.1',
        startedAt: new Date(Date.UTC(2026, 0, 1)),
        services: null,
        skipped: false,
        artifactDigest: 'fake-app-1.4.1',
        changes: [],
        helm: [],
        helmChanges: [],
        helmDeclared: [],
        previousVersion: null,
      };
      orchestrator.program('stack.apply', ok(receipt));

      await rollbackRelease(orchestrator, { ref: APP_REF, stackName: STACK, to: null, failedVersion: '1.4.2', wait: WAIT });

      expect(orchestrator.callsTo('stack.finalize')).toEqual([[receipt]]);
      expect(orchestrator.callsTo('stack.waitConvergence')[0]?.[0]).toBe(receipt);
      const events = orchestrator.events;
      expect(events.indexOf('stack.waitConvergence:app')).toBeLessThan(events.indexOf('stack.finalize:app'));
      expect(events.indexOf('stack.finalize:app')).toBeLessThan(events.indexOf('releases.setCurrent:1.4.1'));
    });

    it(`${kind}: a finalize that rejects does not undo a converged rollback`, async () => {
      const orchestrator = new FakeOrchestrator(kind);
      orchestrator.seedRelease(STACK, { version: '1.4.1', epoch: 1 });
      orchestrator.seedRelease(STACK, { version: '1.4.2', epoch: 2 });
      orchestrator.program('stack.finalize', new Error('prune failed'));

      expect(await rollbackRelease(orchestrator, { ref: APP_REF, stackName: STACK, to: null, failedVersion: '1.4.2', wait: WAIT })).toBe(
        '1.4.1',
      );
      expect(orchestrator.storedReleases(STACK)).toMatchObject({ current: '1.4.1', versions: ['1.4.1'] });
      expect(warnings).toEqual(['Cleanup after rollback failed: prune failed; the rollback itself succeeded']);
    });
  }
});
