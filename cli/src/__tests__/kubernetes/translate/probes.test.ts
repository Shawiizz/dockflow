import { describe, expect, test } from 'bun:test';
import { ANNOTATIONS } from '../../../services/orchestrator/kubernetes/constants';
import { selectorLabels, serviceObjectLabels } from '../../../services/orchestrator/kubernetes/labels';
import type { CanonicalService, HealthSpec, ProbeOverride, RouteSpec } from '../../../services/orchestrator/kubernetes/model/types';
import type { Probe } from '../../../services/orchestrator/kubernetes/resources/core';
import type { TranslateContext } from '../../../services/orchestrator/kubernetes/translate/context';
import { buildPodTemplate } from '../../../services/orchestrator/kubernetes/translate/pod';
import {
  buildProbes,
  type ContainerProbes,
  DOCKER_HEALTHCHECK_DEFAULTS,
  probeSeconds,
  selectProbes,
} from '../../../services/orchestrator/kubernetes/translate/probes';
import { canonicalService, canonicalStack, type ServiceOverrides, translateContext } from '../support/builders';
import { k8sExpand } from '../support/k8s-expand';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const WGET = ['wget', '-qO-', 'http://127.0.0.1/'];

function health(overrides: Partial<HealthSpec> = {}): HealthSpec {
  return {
    test: { type: 'exec', argv: [...WGET] },
    ...DOCKER_HEALTHCHECK_DEFAULTS,
    path: 'services.web.healthcheck',
    ...overrides,
  };
}

function override(use: ProbeOverride['use'], handler: ProbeOverride['handler'] = null): ProbeOverride {
  return { use, handler };
}

const HTTP: ProbeOverride['handler'] = { type: 'http', path: '/health', port: 8080, scheme: 'HTTP' };
const TCP: ProbeOverride['handler'] = { type: 'tcp', port: 5432 };

function route(): RouteSpec {
  return {
    router: 'shop-production-web',
    rule: 'Host(`shop.example.com`)',
    entryPoints: ['websecure'],
    tls: { certResolver: 'letsencrypt' },
    middlewares: [],
    priority: null,
    port: 80,
    origin: 'injected',
    path: 'services.web',
  };
}

interface Probed {
  svc: CanonicalService;
  ctx: TranslateContext;
  probes: ContainerProbes;
  codes: [string, string, string][];
}

function probe(healthcheck: HealthSpec | null, probes: ProbeOverride | null = null, overrides: ServiceOverrides = {}): Probed {
  const svc = canonicalService({ ...overrides, healthcheck, extension: { ...overrides.extension, probes } });
  const ctx = translateContext(canonicalStack({ services: [svc] }));
  const built = buildProbes(svc, ctx);
  return { svc, ctx, probes: built, codes: ctx.sink.list().map((d) => [d.severity, d.code, d.path]) };
}

function kinds(p: Probed): string[] {
  return Object.keys(p.probes).sort();
}

/** The probes inside a pod template of a Deployment, validated structurally and semantically (S10). */
function expectValidTemplate(svc: CanonicalService): void {
  const ctx = translateContext(canonicalStack({ services: [svc] }));
  const template = buildPodTemplate(svc, null, ctx);
  const id = ctx.stack.identity;
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: svc.name,
      namespace: ctx.namespace,
      labels: serviceObjectLabels(id, svc.role, svc.name),
      annotations: { [ANNOTATIONS.composeService]: svc.composeName, [ANNOTATIONS.release]: id.version },
    },
    spec: {
      progressDeadlineSeconds: 240,
      replicas: svc.replicas,
      revisionHistoryLimit: 3,
      selector: { matchLabels: selectorLabels(id, svc.name) },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template,
    },
  };
  expect(formatIssues(failures(validateArtifact([deployment], { namespace: ctx.namespace })))).toBe('');
}

function timings(p: Probe | undefined): Omit<Probe, 'exec' | 'httpGet' | 'tcpSocket'> | undefined {
  if (p === undefined) return undefined;
  const { exec: _exec, httpGet: _httpGet, tcpSocket: _tcpSocket, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------------------
// Handlers (design-02 5.6)
// ---------------------------------------------------------------------------

describe('probe handlers', () => {
  test('exec healthchecks run their argv, every $ doubled', () => {
    const p = probe(health({ test: { type: 'exec', argv: ['check', '$(HOME)', '$HOME', '$$'] } }));
    expect(p.probes.readinessProbe?.exec).toEqual({ command: ['check', '$$(HOME)', '$$HOME', '$$$$'] });
    expect(p.probes.livenessProbe?.exec).toEqual({ command: ['check', '$$(HOME)', '$$HOME', '$$$$'] });
  });

  test('shell healthchecks run through /bin/sh -c, the command escaped as one string', () => {
    const p = probe(health({ test: { type: 'shell', command: 'wget -qO- http://127.0.0.1:3000/health || exit 1' } }));
    expect(p.probes.readinessProbe?.exec).toEqual({ command: ['/bin/sh', '-c', 'wget -qO- http://127.0.0.1:3000/health || exit 1'] });
  });

  test('CMD-SHELL with $$HOME in compose: the model holds $HOME, the probe $$HOME, the shell receives $HOME', () => {
    const p = probe(health({ test: { type: 'shell', command: 'test -d $HOME' } }));
    const command = p.probes.livenessProbe?.exec?.command ?? [];
    expect(command).toEqual(['/bin/sh', '-c', 'test -d $$HOME']);
    expect(k8sExpand(command, { HOME: '/root' })).toEqual(['/bin/sh', '-c', 'test -d $HOME']);
  });

  test('T-PROBE-08: the kubelet expansion gives back the literal command', () => {
    const literal = 'curl -f http://localhost/$(hostname)';
    const p = probe(health({ test: { type: 'shell', command: literal } }));
    for (const kind of ['readinessProbe', 'livenessProbe'] as const) {
      const command = p.probes[kind]?.exec?.command ?? [];
      expect(k8sExpand(command, {})).toEqual(['/bin/sh', '-c', literal]);
      expect(k8sExpand(command, { hostname: 'web-0' })).toEqual(['/bin/sh', '-c', literal]);
    }
  });

  test('T-PROBE-06: an http override replaces the command and keeps the healthcheck timings; HTTP scheme omitted', () => {
    const p = probe(health({ intervalMs: 10_000, timeoutMs: 3_000, retries: 5 }), override('both', { ...HTTP, scheme: 'HTTPS' }));
    expect(p.probes.readinessProbe).toEqual({
      httpGet: { path: '/health', port: 8080, scheme: 'HTTPS' },
      failureThreshold: 5,
      initialDelaySeconds: 0,
      periodSeconds: 10,
      successThreshold: 1,
      timeoutSeconds: 3,
    });
    expect(probe(health(), override('both', HTTP)).probes.readinessProbe?.httpGet).toEqual({ path: '/health', port: 8080 });
    expect(p.codes).toEqual([]);
  });

  test('T-PROBE-07: a tcp override without healthcheck uses Docker default timings', () => {
    const p = probe(null, override('both', TCP));
    expect(p.probes.readinessProbe).toEqual({
      tcpSocket: { port: 5432 },
      failureThreshold: 3,
      initialDelaySeconds: 0,
      periodSeconds: 30,
      successThreshold: 1,
      timeoutSeconds: 30,
    });
    expect(p.probes.livenessProbe?.initialDelaySeconds).toBe(30);
  });

  test('no two probes share a handler object', () => {
    const p = probe(health({ startPeriodMs: 10_000 }), override('both', HTTP));
    const handlers = [p.probes.startupProbe?.httpGet, p.probes.readinessProbe?.httpGet, p.probes.livenessProbe?.httpGet];
    expect(new Set(handlers).size).toBe(3);
    expect(handlers.every((h) => h !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Which probes (design-02 5.6, K35, K72)
// ---------------------------------------------------------------------------

describe('which probes', () => {
  const withStart = health({ startPeriodMs: 40_000 });

  test.each([
    ['no healthcheck, no override', null, null, [], []],
    ['no healthcheck, override without handler', null, override('both'), [], []],
    ['no healthcheck, handler, use both', null, override('both', HTTP), ['livenessProbe', 'readinessProbe'], ['probes.override-defaults']],
    ['no healthcheck, handler, use readiness', null, override('readiness', HTTP), ['readinessProbe'], ['probes.override-defaults']],
    ['no healthcheck, handler, use liveness', null, override('liveness', TCP), ['livenessProbe'], ['probes.override-defaults']],
    ['no healthcheck, handler, use none', null, override('none', HTTP), [], []],
    ['healthcheck with start period, no override', withStart, null, ['livenessProbe', 'readinessProbe', 'startupProbe'], []],
    ['healthcheck with start period, use both', withStart, override('both'), ['livenessProbe', 'readinessProbe', 'startupProbe'], []],
    ['healthcheck with start period, use readiness', withStart, override('readiness'), ['readinessProbe'], []],
    ['healthcheck with start period, use liveness', withStart, override('liveness', TCP), ['livenessProbe', 'startupProbe'], []],
    ['healthcheck with start period, use none', withStart, override('none', HTTP), [], []],
    ['healthcheck without start period', health(), null, ['livenessProbe', 'readinessProbe'], []],
    ['healthcheck without start period, use liveness', health(), override('liveness'), ['livenessProbe'], []],
  ] as [string, HealthSpec | null, ProbeOverride | null, string[], string[]][])('%s', (_title, h, o, expected, diagnostics) => {
    const p = probe(h, o);
    expect(kinds(p)).toEqual(expected);
    expect(p.codes.map(([, code]) => code)).toEqual(diagnostics);
    const selection = selectProbes(h, o);
    expect(
      [selection.liveness && 'livenessProbe', selection.readiness && 'readinessProbe', selection.startup && 'startupProbe'].filter((k) => k !== false),
    ).toEqual(expected);
  });

  test('probes.override-defaults names the x-dockflow.probes path', () => {
    const p = probe(null, override('readiness', HTTP));
    expect(p.codes).toEqual([['info', 'probes.override-defaults', 'services.web.x-dockflow.probes']]);
    expect(p.ctx.sink.list()[0].message).toBe("Probes of service web use Docker's default timings (no healthcheck)");
  });

  test('T-PROBE-03c: sub-second timings, readiness then liveness then none', () => {
    const sub = health({ intervalMs: 1_500, timeoutMs: 900, retries: 3, startPeriodMs: 500 });
    expect(kinds(probe(sub, override('readiness')))).toEqual(['readinessProbe']);
    expect(kinds(probe(sub, override('liveness')))).toEqual(['livenessProbe', 'startupProbe']);
    expect(kinds(probe(sub, override('none')))).toEqual([]);
  });

  test('T-PROBE-04: disable: true and [NONE] leave the model without a healthcheck: no probe keys', () => {
    const svc = canonicalService({ healthcheck: null });
    const ctx = translateContext(canonicalStack({ services: [svc] }));
    const container = buildPodTemplate(svc, null, ctx).spec.containers[0];
    expect(['startupProbe', 'readinessProbe', 'livenessProbe'].filter((k) => k in container)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Timings (design-02 5.6, whole seconds, K35)
// ---------------------------------------------------------------------------

describe('probe timings', () => {
  test('T-PROBE-01: Docker defaults', () => {
    const p = probe(health());
    expect(p.probes).toEqual({
      readinessProbe: { exec: { command: WGET }, periodSeconds: 30, timeoutSeconds: 30, failureThreshold: 3, successThreshold: 1, initialDelaySeconds: 0 },
      livenessProbe: { exec: { command: WGET }, periodSeconds: 30, timeoutSeconds: 30, failureThreshold: 3, successThreshold: 1, initialDelaySeconds: 30 },
    });
  });

  test('T-PROBE-02: a start period adds a startup probe and removes the liveness delay', () => {
    const p = probe(health({ intervalMs: 30_000, retries: 3, startPeriodMs: 60_000, startIntervalMs: 5_000 }));
    expect(timings(p.probes.startupProbe)).toEqual({ periodSeconds: 5, timeoutSeconds: 30, failureThreshold: 30, successThreshold: 1, initialDelaySeconds: 0 });
    expect(p.probes.livenessProbe?.initialDelaySeconds).toBe(0);
    expect(p.probes.readinessProbe?.initialDelaySeconds).toBe(0);
  });

  test('the design-02 5.6 example: interval 10s, timeout 3s, retries 5, start_period 40s', () => {
    const p = probe(health({ test: { type: 'shell', command: 'wget -qO- http://127.0.0.1:3000/health || exit 1' }, intervalMs: 10_000, timeoutMs: 3_000, retries: 5, startPeriodMs: 40_000 }));
    const exec = { command: ['/bin/sh', '-c', 'wget -qO- http://127.0.0.1:3000/health || exit 1'] };
    expect(p.probes).toEqual({
      startupProbe: { exec, failureThreshold: 18, initialDelaySeconds: 0, periodSeconds: 5, successThreshold: 1, timeoutSeconds: 3 },
      readinessProbe: { exec, failureThreshold: 5, initialDelaySeconds: 0, periodSeconds: 10, successThreshold: 1, timeoutSeconds: 3 },
      livenessProbe: { exec, failureThreshold: 5, initialDelaySeconds: 0, periodSeconds: 10, successThreshold: 1, timeoutSeconds: 3 },
    });
  });

  test('T-PROBE-03: sub-second interval and timeout round up to whole seconds', () => {
    const p = probe(health({ intervalMs: 2_500, timeoutMs: 500 }));
    expect(p.probes.readinessProbe?.periodSeconds).toBe(3);
    expect(p.probes.readinessProbe?.timeoutSeconds).toBe(1);
    expect(p.probes.livenessProbe?.initialDelaySeconds).toBe(3);
  });

  test('T-PROBE-03b: the worked sub-second example gives failureThreshold 2, then 4 with start_interval 1200ms', () => {
    const first = probeSeconds({ intervalMs: 1_500, timeoutMs: 900, retries: 3, startPeriodMs: 500, startIntervalMs: 5_000 });
    expect(first).toEqual({ interval: 2, timeout: 1, retries: 3, startPeriod: 1, startInterval: 5, startupFailureThreshold: 2 });
    const second = probeSeconds({ intervalMs: 1_500, timeoutMs: 900, retries: 3, startPeriodMs: 500, startIntervalMs: 1_200 });
    expect(second.startInterval).toBe(2);
    expect(second.startupFailureThreshold).toBe(4);
    const p = probe(health({ intervalMs: 1_500, timeoutMs: 900, retries: 3, startPeriodMs: 500 }));
    expect(timings(p.probes.startupProbe)).toEqual({ periodSeconds: 5, timeoutSeconds: 1, failureThreshold: 2, successThreshold: 1, initialDelaySeconds: 0 });
  });

  test('retries 0 counts as 1; the startup threshold is never below 1', () => {
    expect(probeSeconds({ ...DOCKER_HEALTHCHECK_DEFAULTS, retries: 0 }).retries).toBe(1);
    expect(probe(health({ retries: 0 })).probes.readinessProbe?.failureThreshold).toBe(1);
    expect(probeSeconds({ intervalMs: 1, timeoutMs: 1, retries: 1, startPeriodMs: 1, startIntervalMs: 3_600_000 }).startupFailureThreshold).toBe(1);
  });

  test('a timeout above the interval is kept', () => {
    const p = probe(health({ intervalMs: 5_000, timeoutMs: 10_000 }));
    expect(p.probes.readinessProbe?.periodSeconds).toBe(5);
    expect(p.probes.readinessProbe?.timeoutSeconds).toBe(10);
  });

  test('T-PROBE-09: every probe carries the five timing fields', () => {
    const cases = [probe(health({ startPeriodMs: 1_000 })), probe(null, override('both', HTTP)), probe(health(), override('liveness', TCP))];
    for (const p of cases) {
      for (const built of Object.values(p.probes) as Probe[]) {
        expect(Object.keys(timings(built) ?? {}).sort()).toEqual(['failureThreshold', 'initialDelaySeconds', 'periodSeconds', 'successThreshold', 'timeoutSeconds']);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Routed services without probes, and validation
// ---------------------------------------------------------------------------

describe('routed services', () => {
  test('a routed service without probes gets probes.routed-without-healthcheck', () => {
    const p = probe(null, null, { routes: [route()] });
    expect(p.codes).toEqual([['info', 'probes.routed-without-healthcheck', 'services.web']]);
    expect(p.ctx.sink.list()[0]).toMatchObject({
      message: 'Service web is routed by Traefik but has no healthcheck; traffic starts as soon as the container starts',
      hint: 'Add a healthcheck.',
    });
    expect(probe(health(), override('none'), { routes: [route()] }).codes.map(([, code]) => code)).toEqual(['probes.routed-without-healthcheck']);
  });

  test('a routed service with probes, or an unrouted one without, says nothing', () => {
    expect(probe(health(), null, { routes: [route()] }).codes).toEqual([]);
    expect(probe(null, override('readiness', HTTP), { routes: [route()] }).codes.map(([, code]) => code)).toEqual(['probes.override-defaults']);
    expect(probe(null).codes).toEqual([]);
  });
});

describe('probes validate inside a pod template', () => {
  test.each([
    ['defaults', health(), null],
    ['start period', health({ startPeriodMs: 40_000 }), null],
    ['sub-second', health({ intervalMs: 1_500, timeoutMs: 900, startPeriodMs: 500 }), null],
    ['shell', health({ test: { type: 'shell', command: 'pg_isready -U $POSTGRES_USER' } }), null],
    ['http override', health(), override('both', { ...HTTP, scheme: 'HTTPS' })],
    ['tcp override without healthcheck', null, override('liveness', TCP)],
    ['liveness with startup', health({ startPeriodMs: 10_000 }), override('liveness')],
  ] as [string, HealthSpec | null, ProbeOverride | null][])('%s', (_title, h, o) => {
    expectValidTemplate(canonicalService({ healthcheck: h, extension: { probes: o } }));
  });
});
