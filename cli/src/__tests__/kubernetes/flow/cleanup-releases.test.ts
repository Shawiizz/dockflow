// Release cleanup after a deploy (design-03 12.5, 22.8 CR rows) with FakeOrchestrator.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';
import { cleanupReleases } from '../../../services/release';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

const STACK = 'shop-production';

function compose(version: string): string {
  return ['services:', '  web:', `    image: shop/web:${version}`, '  cache:', '    image: redis:8-alpine', ''].join('\n');
}

/** 1.0.0 .. 1.4.0, each with its compose; `current` defaults to the newest */
function seeded(current = '1.4.0'): FakeOrchestrator {
  const orchestrator = new FakeOrchestrator('k3s');
  ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'].forEach((version, i) => {
    orchestrator.seedRelease(STACK, { version, epoch: i + 1, compose: compose(version) }, { current: version === current });
  });
  return orchestrator;
}

let warnings: string[] = [];
let infos: string[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  warnings = [];
  infos = [];
  spies = [
    spyOn(output, 'printWarning').mockImplementation((message: string) => {
      warnings.push(message);
    }),
    spyOn(output, 'printInfo').mockImplementation((message: string) => {
      infos.push(message);
    }),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('CR1: cleanupReleases', () => {
  it('reads the composes of the releases to drop before prune, then collects their images', async () => {
    const orchestrator = seeded();

    await cleanupReleases(orchestrator, STACK, 3);

    const events = orchestrator.events;
    const prune = events.indexOf('releases.prune');
    expect(prune).toBeGreaterThan(-1);
    expect(events.indexOf('releases.readCompose:1.1.0')).toBeLessThan(prune);
    expect(events.indexOf('releases.readCompose:1.0.0')).toBeLessThan(prune);
    expect(events.indexOf('images.collectGarbage')).toBeGreaterThan(prune);
    expect(orchestrator.callsTo('releases.prune')).toEqual([[STACK, 3]]);

    const [nodes, removed, kept] = orchestrator.callsTo('images.collectGarbage')[0] ?? [];
    expect((nodes as ClusterNodeRef[]).map((node) => node.name)).toEqual(['server_1', 'agent_1']);
    expect(removed).toEqual(['shop/web:1.1.0', 'redis:8-alpine', 'shop/web:1.0.0']);
    expect(kept).toEqual(['shop/web:1.4.0', 'redis:8-alpine', 'shop/web:1.3.0', 'shop/web:1.2.0']);
    expect(orchestrator.storedReleases(STACK).versions).toEqual(['1.4.0', '1.3.0', '1.2.0']);
    expect(infos).toEqual(['Cleaned up 2 old release(s)']);
    expect(warnings).toEqual([]);
  });

  it('only the images of releases the store actually removed are candidates (I-6)', async () => {
    const orchestrator = seeded();
    const [oldest] = (await orchestrator.releases.list(STACK)).filter((r) => r.version === '1.0.0');
    orchestrator.program('releases.prune', oldest ? [oldest] : []);

    await cleanupReleases(orchestrator, STACK, 3);

    const [, removed] = orchestrator.callsTo('images.collectGarbage')[0] ?? [];
    expect(removed).toEqual(['shop/web:1.0.0', 'redis:8-alpine']);
    expect(infos).toEqual(['Cleaned up 1 old release(s)']);
  });

  it('a current release older than the newest `keep` stays, and its images are kept', async () => {
    const orchestrator = seeded('1.0.0');
    const [second] = (await orchestrator.releases.list(STACK)).filter((r) => r.version === '1.1.0');
    orchestrator.program('releases.prune', second ? [second] : []);

    await cleanupReleases(orchestrator, STACK, 3);

    expect(orchestrator.events.filter((e) => e.startsWith('releases.readCompose'))).toEqual([
      'releases.readCompose:1.1.0',
      'releases.readCompose:1.4.0',
      'releases.readCompose:1.3.0',
      'releases.readCompose:1.2.0',
      'releases.readCompose:1.0.0',
    ]);
    const [, removed, kept] = orchestrator.callsTo('images.collectGarbage')[0] ?? [];
    expect(removed).toEqual(['shop/web:1.1.0', 'redis:8-alpine']);
    expect(kept).toContain('shop/web:1.0.0');
  });

  it('nothing beyond `keep`: no read, no prune, no garbage collection', async () => {
    const orchestrator = seeded();
    await cleanupReleases(orchestrator, STACK, 5);
    expect(orchestrator.events).toEqual(['releases.list', 'releases.current']);
    expect(infos).toEqual([]);
  });

  it('removed releases without images still reach the image backend, with no candidate', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(STACK, { version: '1.0.0', epoch: 1, compose: '' });
    orchestrator.seedRelease(STACK, { version: '1.1.0', epoch: 2, compose: compose('1.1.0') });

    await cleanupReleases(orchestrator, STACK, 1);

    const [, removed, kept] = orchestrator.callsTo('images.collectGarbage')[0] ?? [];
    expect(removed).toEqual([]);
    expect(kept).toEqual(['shop/web:1.1.0', 'redis:8-alpine']);
    expect(orchestrator.storedReleases(STACK).versions).toEqual(['1.1.0']);
    expect(infos).toEqual(['Cleaned up 1 old release(s)']);
  });

  it('a prune that removed nothing collects nothing and says nothing', async () => {
    const orchestrator = seeded();
    orchestrator.program('releases.prune', []);

    await cleanupReleases(orchestrator, STACK, 3);

    expect(orchestrator.callsTo('images.collectGarbage')).toEqual([]);
    expect(infos).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('runs the same on Swarm', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    ['1.0.0', '1.1.0', '1.2.0'].forEach((version, i) => {
      orchestrator.seedRelease(STACK, { version, epoch: i + 1, compose: compose(version) });
    });

    await cleanupReleases(orchestrator, STACK, 2);

    const [, removed, kept] = orchestrator.callsTo('images.collectGarbage')[0] ?? [];
    expect(removed).toEqual(['shop/web:1.0.0', 'redis:8-alpine']);
    expect(kept).toEqual(['shop/web:1.2.0', 'redis:8-alpine', 'shop/web:1.1.0']);
    expect(orchestrator.storedReleases(STACK).versions).toEqual(['1.2.0', '1.1.0']);
  });
});

describe('CR2: cleanupReleases errors', () => {
  it('a failing store read is a warning, never an error', async () => {
    const orchestrator = seeded();
    orchestrator.program('releases.list', new Error('connection reset'));

    await cleanupReleases(orchestrator, STACK, 3);

    expect(warnings).toEqual(['Release cleanup failed: connection reset']);
    expect(orchestrator.callsTo('releases.prune')).toEqual([]);
  });

  it('a failing garbage collection is a warning after the releases were pruned', async () => {
    const orchestrator = seeded();
    orchestrator.program('images.collectGarbage', new Error('sudo refused'));

    await cleanupReleases(orchestrator, STACK, 3);

    expect(warnings).toEqual(['Release cleanup failed: sudo refused']);
    expect(orchestrator.storedReleases(STACK).versions).toEqual(['1.4.0', '1.3.0', '1.2.0']);
  });

  it('an unreadable compose only loses its images', async () => {
    const orchestrator = seeded();
    orchestrator.program('releases.readCompose', (_stack: string, version: string) => {
      if (version === '1.0.0') throw new Error('gone');
      return compose(version);
    });

    await cleanupReleases(orchestrator, STACK, 3);

    const [, removed] = orchestrator.callsTo('images.collectGarbage')[0] ?? [];
    expect(removed).toEqual(['shop/web:1.1.0', 'redis:8-alpine']);
    expect(warnings).toEqual([]);
  });

  it('a failing prune is a warning and collects nothing', async () => {
    const orchestrator = seeded();
    orchestrator.program('releases.prune', new Error('Forbidden'));

    await cleanupReleases(orchestrator, STACK, 3);

    expect(warnings).toEqual(['Release cleanup failed: Forbidden']);
    expect(orchestrator.callsTo('images.collectGarbage')).toEqual([]);
  });
});
