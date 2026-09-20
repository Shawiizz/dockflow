// API core routes over the orchestrator (design-06 8.1, 8.2; design-07 14.2 U-API-01..06). Every
// route is exercised through its real handler with a FakeOrchestrator swapped in through
// `__setOrchestratorOpenerForTests`, so these tests prove the wiring end to end rather than just the
// pure helpers.

import { afterEach, describe, expect, it } from 'bun:test';
import { handleServicesRoutes } from '../../../api/routes/services';
import { handleAccessoriesRoutes } from '../../../api/routes/accessories';
import { __setOrchestratorOpenerForTests, isValidDockerName } from '../../../api/routes/_helpers';
import { capabilitiesFor, requireCapabilityFor } from '../../../services/orchestrator/capabilities';
import type { ServiceInfo } from '../../../services/orchestrator/interfaces';
import { UnsupportedOperationError } from '../../../utils/errors';
import { config } from '../support/builders';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function serviceInfo(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'web',
    nativeName: 'web',
    kind: 'service',
    role: 'app',
    mode: 'replicated',
    image: 'nginx:1.27',
    replicas: { running: 1, desired: 1 },
    ports: [],
    state: 'running',
    ...overrides,
  };
}

/** app role first, accessory role second — matches resolveApiService's own search order. */
function withServices(fake: FakeOrchestrator, app: ServiceInfo[], accessory: ServiceInfo[] = []): void {
  fake.program('stack.getServices', (ref) => (ref.role === 'app' ? app : accessory));
}

function useFake(fake: FakeOrchestrator): void {
  __setOrchestratorOpenerForTests(async () => ({ config: config(), orchestrator: fake }));
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init);
}

function postJson(path: string, body: unknown): Request {
  return req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
});

describe('UnsupportedOperationError -> HTTP 501 (U-API-01)', () => {
  it('a route that throws UnsupportedOperationError answers 501 with success, message and suggestion', async () => {
    const fake = new FakeOrchestrator('k3s');
    withServices(fake, [serviceInfo()]);
    fake.program('stack.restart', new UnsupportedOperationError('restart is not supported here', 'Do something else instead.'));
    useFake(fake);

    const res = await handleServicesRoutes(postJson('/api/services/web/restart?env=production', {}));

    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      success: false,
      error: 'restart is not supported here',
      message: 'restart is not supported here',
      suggestion: 'Do something else instead.',
    });
  });

  it('an accessory rollback is refused as UnsupportedOperationError before the backend is called (R-12)', async () => {
    const fake = new FakeOrchestrator('k3s');
    withServices(fake, [], [serviceInfo({ role: 'accessory' })]);
    useFake(fake);

    const res = await handleServicesRoutes(postJson('/api/services/web/rollback?env=production', {}));

    expect(res.status).toBe(501);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Service web is an accessory; accessories have no release history');
    expect(fake.callsTo('stack.rollbackService')).toHaveLength(0);
  });
});

describe('getOrchestratorContext (U-API-02)', () => {
  it('stackName is "<project>-<env>", not the bare project name', async () => {
    const fake = new FakeOrchestrator('k3s', { target: { project: 'shop', env: 'production' } });
    withServices(fake, [serviceInfo()]);
    useFake(fake);

    const res = await handleServicesRoutes(req('/api/services?env=production'));
    const body = (await res.json()) as { stackName: string };

    expect(body.stackName).toBe('shop-production');
    expect(body.stackName).not.toBe('shop');
  });
});

describe('services routes with FakeOrchestrator k3s (U-API-03)', () => {
  it('restart calls stack.restart with wait: false', async () => {
    const fake = new FakeOrchestrator('k3s');
    withServices(fake, [serviceInfo()]);
    useFake(fake);

    const res = await handleServicesRoutes(postJson('/api/services/web/restart?env=production', {}));

    expect(res.status).toBe(200);
    expect(fake.callsTo('stack.restart')).toEqual([[expect.objectContaining({ role: 'app' }), 'web', { wait: false, timeoutS: 0 }]]);
  });

  it('scale calls stack.scale with wait: false', async () => {
    const fake = new FakeOrchestrator('k3s');
    withServices(fake, [serviceInfo()]);
    useFake(fake);

    const res = await handleServicesRoutes(postJson('/api/services/web/scale?env=production', { replicas: 3 }));

    expect(res.status).toBe(200);
    expect(fake.callsTo('stack.scale')).toEqual([[expect.objectContaining({ role: 'app' }), 'web', 3, { wait: false, timeoutS: 0 }]]);
  });

  it('stop calls stack.stop, never scale(..., 0), and records the Helm warning in message for a Helm row', async () => {
    const fake = new FakeOrchestrator('k3s');
    withServices(fake, [serviceInfo({ name: 'cache', kind: 'helm' })]);
    useFake(fake);

    const res = await handleServicesRoutes(postJson('/api/services/cache/stop?env=production', {}));
    const body = (await res.json()) as { message: string };

    expect(fake.callsTo('stack.stop')).toEqual([[expect.objectContaining({ role: 'app' }), ['cache'], { wait: false, timeoutS: 0 }]]);
    expect(fake.callsTo('stack.scale')).toHaveLength(0);
    expect(body.message).toBe("Helm release cache was scaled to 0; its next upgrade restores the chart's replica count");
  });

  it('logs reads with timestamps: true and includeTerminated: true, and sorts by timestamp', async () => {
    const fake = new FakeOrchestrator('k3s');
    withServices(fake, [serviceInfo()]);
    fake.program('containers.streamLogs', (_ref, _service, _options, sink) => {
      sink.line({ service: 'web', instance: 'web', timestamp: '2026-01-01T00:00:02.000Z', text: 'second' });
      sink.line({ service: 'web', instance: 'web', timestamp: '2026-01-01T00:00:01.000Z', text: 'first' });
    });
    useFake(fake);

    const res = await handleServicesRoutes(req('/api/services/web/logs?env=production&lines=50'));
    const body = (await res.json()) as { logs: { message: string }[] };

    expect(fake.callsTo('containers.streamLogs')[0][2]).toMatchObject({ timestamps: true, includeTerminated: true, follow: false, tail: 50 });
    expect(body.logs.map((l) => l.message)).toEqual(['first', 'second']);
  });
});

describe('accessories routes with FakeOrchestrator k3s (U-API-03)', () => {
  it('restart and stop target the accessory role with wait: false', async () => {
    const fake = new FakeOrchestrator('k3s');
    useFake(fake);

    await handleAccessoriesRoutes(postJson('/api/accessories/cache/restart?env=production', {}));
    await handleAccessoriesRoutes(postJson('/api/accessories/cache/stop?env=production', {}));

    expect(fake.callsTo('stack.restart')).toEqual([[expect.objectContaining({ role: 'accessory' }), 'cache', { wait: false, timeoutS: 0 }]]);
    expect(fake.callsTo('stack.stop')).toEqual([[expect.objectContaining({ role: 'accessory' }), ['cache'], { wait: false, timeoutS: 0 }]]);
  });
});

describe('name validation (U-API-04)', () => {
  it('Kubernetes-safe names are accepted', () => {
    expect(isValidDockerName('web')).toBe(true);
    expect(isValidDockerName('web-app')).toBe(true);
    expect(isValidDockerName('web-app-1')).toBe(true);
  });

  it('shell metacharacters are rejected', () => {
    expect(isValidDockerName('web; rm -rf /')).toBe(false);
    expect(isValidDockerName('$(whoami)')).toBe(false);
    expect(isValidDockerName('a`b`')).toBe(false);
  });

  it('a route rejects a shell-metacharacter name before touching the orchestrator', async () => {
    const fake = new FakeOrchestrator('k3s');
    useFake(fake);

    const res = await handleServicesRoutes(postJson('/api/services/web%3B%20rm%20-rf%20%2F/restart?env=production', {}));

    expect(res.status).toBe(400);
    expect(fake.callsTo('stack.restart')).toHaveLength(0);
  });
});

describe('capability probe before opening the orchestrator (U-API-06)', () => {
  it('requireCapabilityFor refuses before any opener call, so a missing capability costs no SSH', () => {
    let opened = 0;
    __setOrchestratorOpenerForTests(async () => {
      opened++;
      return { config: config(), orchestrator: new FakeOrchestrator('swarm') };
    });

    expect(capabilitiesFor('swarm').helm).toBe(false);
    expect(() => requireCapabilityFor('swarm', 'helm', 'dockflow helm list')).toThrow(UnsupportedOperationError);
    expect(opened).toBe(0);
  });
});
