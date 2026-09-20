// API refusal routes (design-06 8.1, 8.2; design-07 14.2 U-API-05): every refusal path answers 501
// with `success: false`, `message` and `suggestion`, and makes no backend call — the WebUI never
// deletes a volume on either orchestrator, and a target the orchestrator itself refuses (k3s
// `containers`/`networks`) is caught by `planPrune` before any backend method runs.

import { afterEach, describe, expect, it } from 'bun:test';
import { handleResourcesRoutes } from '../../../api/routes/resources';
import { __setOrchestratorOpenerForTests } from '../../../api/routes/_helpers';
import type { OrchestratorKind } from '../../../services/orchestrator/interfaces';
import { config } from '../support/builders';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

interface UnsupportedBody {
  success: boolean;
  error: string;
  message: string;
  suggestion?: string;
}

function useFake(fake: FakeOrchestrator): void {
  __setOrchestratorOpenerForTests(async () => ({ config: config({ orchestrator: fake.kind }), orchestrator: fake }));
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
});

describe('POST /api/resources/prune never deletes a volume (U-API-05)', () => {
  for (const kind of ['swarm', 'k3s'] as const satisfies readonly OrchestratorKind[]) {
    it(`targets: ["volumes"] on ${kind} answers 501 with message and suggestion, and calls no backend method`, async () => {
      const fake = new FakeOrchestrator(kind);
      useFake(fake);

      const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['volumes'] }));

      expect(res.status).toBe(501);
      const body = (await res.json()) as UnsupportedBody;
      expect(body.success).toBe(false);
      expect(body.message).toBe('POST /api/resources/prune does not prune volumes');
      expect(body.suggestion).toBeTruthy();
      expect(fake.calls).toHaveLength(0);
    });
  }

  it('volumes named alongside other targets refuses the whole request before any target runs', async () => {
    const fake = new FakeOrchestrator('swarm');
    useFake(fake);

    const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['images', 'volumes'] }));

    expect(res.status).toBe(501);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('POST /api/resources/prune refuses a target the orchestrator does not support', () => {
  it('containers on k3s answers 501 and never calls images.pruneRuntime', async () => {
    const fake = new FakeOrchestrator('k3s');
    useFake(fake);

    const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['containers'] }));

    expect(res.status).toBe(501);
    const body = (await res.json()) as UnsupportedBody;
    expect(body.suggestion).toBeTruthy();
    expect(fake.callsTo('images.pruneRuntime')).toHaveLength(0);
  });

  it('networks on k3s answers 501 and never calls images.pruneRuntime', async () => {
    const fake = new FakeOrchestrator('k3s');
    useFake(fake);

    const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['networks'] }));

    expect(res.status).toBe(501);
    expect(fake.callsTo('images.pruneRuntime')).toHaveLength(0);
  });

  it('an unknown target is rejected with 400 before the orchestrator is ever opened', async () => {
    const fake = new FakeOrchestrator('k3s');
    useFake(fake);

    const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['disk'] }));

    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('POST /api/resources/prune of a permitted target', () => {
  it('images on k3s with --all calls images.prune, never pruneRuntime', async () => {
    const fake = new FakeOrchestrator('k3s');
    useFake(fake);

    const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['images'], all: true }));

    expect(res.status).toBe(200);
    expect(fake.callsTo('images.prune')).toHaveLength(1);
    expect(fake.callsTo('images.pruneRuntime')).toHaveLength(0);
  });

  it('containers on Swarm calls images.pruneRuntime', async () => {
    const fake = new FakeOrchestrator('swarm');
    useFake(fake);

    const res = await handleResourcesRoutes(postJson('/api/resources/prune?env=production', { targets: ['containers'] }));

    expect(res.status).toBe(200);
    expect(fake.callsTo('images.pruneRuntime')).toEqual([[expect.anything(), 'containers']]);
  });
});
