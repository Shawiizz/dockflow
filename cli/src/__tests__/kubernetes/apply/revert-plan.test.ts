// design-03 11.2 and 11.3 (22.2 `apply/revert-plan.test.ts`), DESIGN-CORE DV2, design-07
// U-REVERT-01..04 and 08: the plan of the automatic revert, K17 stuck StatefulSet pods and the K18
// partial receipt of a Helm failure.

import { describe, expect, it } from 'bun:test';
import {
  type FailureAction,
  isEmptyRevertPlan,
  planRevert,
  type RevertPlanInput,
  withoutReleaseAnnotation,
} from '../../../services/orchestrator/kubernetes/apply/revert-plan';
import { emptySnapshot, type LiveWorkload, type Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import { stateFor } from '../../../services/orchestrator/kubernetes/backends/stack-state';
import type { HelmReleaseRecord, WorkloadChange, WorkloadKind } from '../../../services/orchestrator/interfaces';
import type { Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type { PersistentVolumeClaim, PodSpec, Secret, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import type { IngressRoute, Middleware } from '../../../services/orchestrator/kubernetes/resources/traefik';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const T0 = new Date('2026-09-17T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function metadata(name: string, service: string | null, version: string | null = null) {
  const annotations: Record<string, string> = {};
  if (service !== null) annotations[`${P}/compose-service`] = service;
  if (version !== null) annotations[`${P}/release`] = version;
  return { name, namespace: NS, annotations };
}

interface PodOptions {
  image?: string;
  port?: number;
  env?: string;
  claims?: string[];
}

function podSpec(name: string, o: PodOptions): PodSpec {
  return {
    containers: [
      {
        name,
        image: o.image ?? `registry.example.com/${name}:1`,
        ports: o.port === undefined ? undefined : [{ name: `tcp-${o.port}`, containerPort: o.port, protocol: 'TCP' }],
        envFrom: o.env === undefined ? undefined : [{ secretRef: { name: o.env } }],
      },
    ],
    volumes: (o.claims ?? []).map((c) => ({ name: `pvc-${c}`, persistentVolumeClaim: { claimName: c } })),
  };
}

function deployment(name: string, version: string, o: PodOptions = {}): Deployment {
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(name, name, version), spec: { selector: {}, template: { metadata: {}, spec: podSpec(name, o) } } };
}

function statefulSet(name: string, version: string, o: PodOptions = {}): StatefulSet {
  return { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: metadata(name, name, version), spec: { selector: {}, template: { metadata: {}, spec: podSpec(name, o) } } };
}

function job(name: string, service: string, version: string): Job {
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: metadata(name, service, version), spec: { template: { metadata: {}, spec: podSpec(service, {}) } } };
}

function service(name: string, composeName: string, port: number): Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata(name, composeName),
    spec: { ports: [{ name: `tcp-${port}`, port, protocol: 'TCP' }], selector: { [`${P}/service`]: composeName } },
  };
}

function secret(name: string): Secret {
  return { apiVersion: 'v1', kind: 'Secret', metadata: metadata(name, null), immutable: true, data: { KEY: 'dmFsdWU=' } };
}

function pvc(name: string): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: metadata(name, null),
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
  };
}

function route(name: string, composeName: string, port: number, middlewares: string[] = []): IngressRoute {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: metadata(name, composeName),
    spec: {
      routes: [
        {
          kind: 'Rule',
          match: 'Host(`shop.example.com`)',
          middlewares: middlewares.map((m) => ({ name: m })),
          services: [{ name: composeName, port }],
        },
      ],
    },
  };
}

function basicAuth(name: string, secretName: string): Middleware {
  return { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: metadata(name, null), spec: { basicAuth: { secret: secretName } } };
}

function live(kind: WorkloadKind, name: string, extra: Partial<LiveWorkload> = {}): LiveWorkload {
  return {
    kind,
    name,
    service: name,
    uid: `uid-${name}`,
    generation: 1,
    replicas: kind === 'Deployment' || kind === 'StatefulSet' ? 1 : null,
    revision: null,
    pendingRevision: null,
    revisionNumber: null,
    graceSeconds: 30,
    paused: false,
    deleting: false,
    job: kind === 'Job' ? { finished: 'complete', active: 0 } : null,
    claimTemplates: [],
    refs: { secrets: [], configMaps: [], claims: [], images: [] },
    ...extra,
  };
}

function change(service: string, kind: WorkloadKind, name: string, extra: Partial<WorkloadChange> = {}): WorkloadChange {
  return {
    service,
    kind,
    name,
    created: false,
    previousRevision: null,
    previousRevisionNumber: null,
    previousReplicas: null,
    generation: 2,
    ...extra,
  };
}

const snapshot = (...workloads: LiveWorkload[]): Snapshot => ({ takenAt: T0, workloads, services: [] });

function input(overrides: Partial<RevertPlanInput>): RevertPlanInput {
  return {
    role: 'app',
    targets: null,
    changes: [],
    applied: [],
    previous: null,
    helmApplied: [],
    failureActions: {},
    disruptive: [],
    before: snapshot(),
    now: snapshot(),
    livePvcNames: [],
    ...overrides,
  };
}

const names = (objects: { kind: string; metadata?: { name: string }; name?: string }[]) =>
  objects.map((o) => `${o.kind}/${o.metadata?.name ?? o.name}`);

function helmRecord(name: string, version: string, valuesSha256: string): HelmReleaseRecord {
  return {
    name,
    role: 'app',
    namespace: NS,
    chart: { kind: 'repo', repo: 'https://charts.example.com', chart: name },
    version,
    values: {},
    valuesSha256,
    timeoutS: 300,
    chartSha256: null,
  };
}

// ---------------------------------------------------------------------------
// The worked example of design-03 11.3
// ---------------------------------------------------------------------------

/** 1.4.1: web on 8080 and api. 1.4.2: web on 3000 with a new image and env, worker added, api unchanged. */
function example(): { previous: ManifestObject[]; applied: ManifestObject[] } {
  const previous: ManifestObject[] = [
    secret('web-env-1b2c3d4e'),
    service('web', 'web', 8080),
    deployment('web', '1.4.1', { image: 'dockflow.invalid/shop-web-production:1.4.1', port: 8080, env: 'web-env-1b2c3d4e' }),
    route('shop-production-web', 'web', 8080),
    secret('api-env-aaaa1111'),
    service('api', 'api', 9000),
    deployment('api', '1.4.1', { port: 9000, env: 'api-env-aaaa1111' }),
  ];
  const applied: ManifestObject[] = [
    secret('web-env-3f9a1c2e'),
    service('web', 'web', 3000),
    deployment('web', '1.4.2', { image: 'dockflow.invalid/shop-web-production:1.4.2', port: 3000, env: 'web-env-3f9a1c2e' }),
    route('shop-production-web', 'web', 3000),
    secret('api-env-aaaa1111'),
    service('api', 'api', 9000),
    deployment('api', '1.4.2', { port: 9000, env: 'api-env-aaaa1111' }),
    service('worker', 'worker', 7000),
    deployment('worker', '1.4.2', { port: 7000 }),
    route('shop-production-worker', 'worker', 7000),
  ];
  return { previous, applied };
}

describe('planRevert', () => {
  it('worked example 11.3 (U-REVERT-01): restores web from 1.4.1 and removes worker, api untouched', () => {
    const { previous, applied } = example();
    const plan = planRevert(
      input({
        applied,
        previous: { version: '1.4.1', objects: previous, helm: [] },
        changes: [change('web', 'Deployment', 'web', { generation: 8 }), change('worker', 'Deployment', 'worker', { created: true })],
        before: snapshot(live('Deployment', 'web', { generation: 7 }), live('Deployment', 'api')),
        now: snapshot(live('Deployment', 'web', { generation: 8 }), live('Deployment', 'api'), live('Deployment', 'worker')),
      }),
    );
    expect(names(plan.apply)).toEqual(['Secret/web-env-1b2c3d4e', 'Service/web', 'Deployment/web', 'IngressRoute/shop-production-web']);
    expect(plan.apply.find((o) => o.kind === 'Deployment')?.metadata.annotations?.[`${P}/release`]).toBe('1.4.1');
    expect(names(plan.remove)).toEqual(['IngressRoute/shop-production-worker', 'Deployment/worker', 'Service/worker']);
    expect(plan.services).toEqual(['web', 'worker']);
    expect(plan.watch).toEqual([{ service: 'web', kind: 'Deployment', name: 'web' }]);
    expect(plan.undo).toEqual([]);
    expect(plan.scale).toEqual([]);
    expect(plan.deleteFirst).toEqual([]);
    expect(plan.leftInPlace).toEqual([]);
    expect(plan.helm).toEqual([]);
  });

  it('compares releases without the release annotation, which names the version and not a change', () => {
    const stripped = withoutReleaseAnnotation(deployment('web', '1.4.2'));
    expect(stripped.metadata.annotations).toEqual({ [`${P}/compose-service`]: 'web' });
    const bare = withoutReleaseAnnotation(secret('web-env-3f9a1c2e'));
    expect('annotations' in bare.metadata).toBe(false);
    const { previous, applied } = example();
    const plan = planRevert(
      input({ applied, previous: { version: '1.4.1', objects: previous, helm: [] }, targets: ['api'] }),
    );
    expect(plan.services).toEqual([]);
    expect(isEmptyRevertPlan(plan)).toBe(true);
  });

  it('U-REVERT-04: a first deployment leaves the created workloads in place', () => {
    const plan = planRevert(input({ changes: [change('web', 'Deployment', 'web', { created: true })], applied: example().applied }));
    expect(plan.leftInPlace).toEqual([{ service: 'web', reason: 'first-deploy' }]);
    expect(isEmptyRevertPlan(plan)).toBe(true);
    expect(plan.services).toEqual([]);
  });

  it('U-REVERT-03: an accessory without history is undone to the integer revision, and a created one has no history', () => {
    const plan = planRevert(
      input({
        role: 'accessory',
        changes: [
          change('redis', 'Deployment', 'redis', { previousRevision: '3', previousRevisionNumber: 3, previousReplicas: 1 }),
          change('mongo', 'Deployment', 'mongo', { created: true }),
        ],
        before: snapshot(live('Deployment', 'redis', { revision: '3', revisionNumber: 3 })),
        now: snapshot(live('Deployment', 'redis', { revision: '4', revisionNumber: 4 }), live('Deployment', 'mongo')),
      }),
    );
    expect(plan.undo).toEqual([{ service: 'redis', kind: 'Deployment', name: 'redis', toRevision: 3 }]);
    expect(plan.scale).toEqual([]);
    expect(plan.leftInPlace).toEqual([{ service: 'mongo', reason: 'no-history' }]);
    expect(plan.services).toEqual(['redis']);
    expect(plan.watch).toEqual([{ service: 'redis', kind: 'Deployment', name: 'redis' }]);
  });

  it('a replicas-only change is scaled back, not undone', () => {
    const plan = planRevert(
      input({
        role: 'accessory',
        changes: [change('redis', 'Deployment', 'redis', { previousRevision: '3', previousRevisionNumber: 3, previousReplicas: 2 })],
        before: snapshot(live('Deployment', 'redis', { revision: '3', revisionNumber: 3, replicas: 2 })),
        now: snapshot(live('Deployment', 'redis', { revision: '3', revisionNumber: 3, replicas: 4 })),
      }),
    );
    expect(plan.undo).toEqual([]);
    expect(plan.scale).toEqual([{ service: 'redis', kind: 'Deployment', name: 'redis', replicas: 2 }]);
  });

  it('sorts undone and scaled services by name when several are reverted together', () => {
    const plan = planRevert(
      input({
        role: 'accessory',
        changes: [
          change('delta', 'Deployment', 'delta', { previousRevision: 'r3', previousRevisionNumber: 3, previousReplicas: 1 }),
          change('beta', 'Deployment', 'beta', { previousRevision: 'r3', previousRevisionNumber: 3, previousReplicas: 1 }),
          change('gamma', 'Deployment', 'gamma', { previousRevision: 'r3', previousRevisionNumber: 3, previousReplicas: 2 }),
          change('alpha', 'Deployment', 'alpha', { previousRevision: 'r3', previousRevisionNumber: 3, previousReplicas: 2 }),
        ],
        before: snapshot(
          live('Deployment', 'delta', { revision: 'r3', revisionNumber: 3 }),
          live('Deployment', 'beta', { revision: 'r3', revisionNumber: 3 }),
          live('Deployment', 'gamma', { revision: 'r3', revisionNumber: 3, replicas: 2 }),
          live('Deployment', 'alpha', { revision: 'r3', revisionNumber: 3, replicas: 2 }),
        ),
        now: snapshot(
          live('Deployment', 'delta', { revision: 'r4', revisionNumber: 4 }),
          live('Deployment', 'beta', { revision: 'r4', revisionNumber: 4 }),
          live('Deployment', 'gamma', { revision: 'r3', revisionNumber: 3, replicas: 4 }),
          live('Deployment', 'alpha', { revision: 'r3', revisionNumber: 3, replicas: 4 }),
        ),
      }),
    );
    expect(plan.undo).toEqual([
      { service: 'beta', kind: 'Deployment', name: 'beta', toRevision: 3 },
      { service: 'delta', kind: 'Deployment', name: 'delta', toRevision: 3 },
    ]);
    expect(plan.scale).toEqual([
      { service: 'alpha', kind: 'Deployment', name: 'alpha', replicas: 2 },
      { service: 'gamma', kind: 'Deployment', name: 'gamma', replicas: 2 },
    ]);
  });

  it('a StatefulSet stuck mid-update is undone although currentRevision did not move (K17)', () => {
    const plan = planRevert(
      input({
        role: 'accessory',
        changes: [change('queue', 'StatefulSet', 'queue', { previousRevision: 'queue-aaa', previousRevisionNumber: 2, previousReplicas: 1 })],
        before: snapshot(live('StatefulSet', 'queue', { revision: 'queue-aaa', pendingRevision: 'queue-aaa', revisionNumber: 2 })),
        now: snapshot(live('StatefulSet', 'queue', { revision: 'queue-aaa', pendingRevision: 'queue-bbb', revisionNumber: 2 })),
      }),
    );
    expect(plan.undo).toEqual([{ service: 'queue', kind: 'StatefulSet', name: 'queue', toRevision: 2 }]);
    expect(plan.statefulSetPods).toEqual([{ service: 'queue', statefulSet: 'queue', failedRevision: 'queue-bbb' }]);
  });

  it('failure_action pause or continue leaves the service in place', () => {
    const { previous, applied } = example();
    for (const action of ['pause', 'continue'] as FailureAction[]) {
      const plan = planRevert(
        input({
          applied,
          previous: { version: '1.4.1', objects: previous, helm: [] },
          changes: [change('web', 'Deployment', 'web')],
          failureActions: { web: action, worker: 'rollback' },
        }),
      );
      expect(plan.leftInPlace).toEqual([{ service: 'web', reason: 'failure-action' }]);
      expect(names(plan.apply)).toEqual([]);
      expect(plan.services).toEqual(['worker']);
    }
  });

  it('sorts left-in-place services by name when several are left for different reasons', () => {
    const plan = planRevert(
      input({
        role: 'accessory',
        changes: [change('zulu', 'Deployment', 'zulu', { created: true }), change('echo', 'Deployment', 'echo')],
        failureActions: { echo: 'pause' },
      }),
    );
    expect(plan.leftInPlace).toEqual([
      { service: 'echo', reason: 'failure-action' },
      { service: 'zulu', reason: 'no-history' },
    ]);
  });

  it('a change made only of a Job run is left in place', () => {
    const objects = [job('migrate-3f9a1c2e', 'migrate', '1.4.1')];
    const plan = planRevert(
      input({
        applied: [job('migrate-3f9a1c2e', 'migrate', '1.4.2')],
        previous: { version: '1.4.1', objects, helm: [] },
        changes: [change('migrate', 'Job', 'migrate-3f9a1c2e', { created: true })],
      }),
    );
    expect(plan.leftInPlace).toEqual([{ service: 'migrate', reason: 'job' }]);
    expect(isEmptyRevertPlan(plan)).toBe(true);
  });

  it('never re-applies a Job that still exists (K43)', () => {
    const previous = [deployment('web', '1.4.1', { port: 8080 }), job('migrate-00000000', 'migrate', '1.4.1')];
    const applied = [deployment('web', '1.4.2', { port: 3000 }), job('migrate-3f9a1c2e', 'migrate', '1.4.2')];
    const plan = planRevert(
      input({
        applied,
        previous: { version: '1.4.1', objects: previous, helm: [] },
        changes: [change('migrate', 'Job', 'migrate-3f9a1c2e', { created: true }), change('web', 'Deployment', 'web')],
        now: snapshot(live('Deployment', 'web'), live('Job', 'migrate-00000000', { service: 'migrate' }), live('Job', 'migrate-3f9a1c2e', { service: 'migrate' })),
      }),
    );
    expect(names(plan.apply)).toEqual(['Deployment/web']);
    expect(plan.deleteFirst).toEqual([]);
  });

  it('restores a missing PVC and never re-applies an existing one (restore mode)', () => {
    const previous = [deployment('web', '1.4.1', { claims: ['uploads', 'data'] }), pvc('uploads'), pvc('data')];
    const applied = [deployment('web', '1.4.2', { claims: ['uploads', 'data'], image: 'registry.example.com/web:2' }), pvc('uploads'), pvc('data')];
    const plan = planRevert(
      input({
        applied,
        previous: { version: '1.4.1', objects: previous, helm: [] },
        changes: [change('web', 'Deployment', 'web')],
        livePvcNames: ['uploads'],
      }),
    );
    expect(names(plan.apply)).toEqual(['PersistentVolumeClaim/data', 'Deployment/web']);
  });

  it('restores a Helm release the failed deploy upgraded, never one it installed or left equal', () => {
    const a = helmRecord('search', '1.2.0', 'a'.repeat(64));
    const aNew = helmRecord('search', '1.3.0', 'a'.repeat(64));
    const b = helmRecord('metrics', '2.0.0', 'b'.repeat(64));
    const c = helmRecord('cache', '1.0.0', 'c'.repeat(64));
    const plan = planRevert(
      input({
        helmApplied: [
          { release: aNew, replaced: a },
          { release: b, replaced: null },
          { release: c, replaced: c },
        ],
      }),
    );
    expect(plan.helm).toEqual([a]);
    expect(isEmptyRevertPlan(plan)).toBe(false);
  });

  describe('Middlewares (K46)', () => {
    function middlewareCase(failureActions: Record<string, FailureAction>) {
      const previous = [
        deployment('web', '1.4.1'),
        route('shop-production-web', 'web', 80, ['admin-auth']),
        basicAuth('admin-auth', 'admin-auth-auth-secret-1111aaaa'),
        secret('admin-auth-auth-secret-1111aaaa'),
      ];
      const applied = [
        deployment('web', '1.4.2'),
        route('shop-production-web', 'web', 80, ['admin-auth', 'rate-limit']),
        basicAuth('admin-auth', 'admin-auth-auth-secret-2222bbbb'),
        secret('admin-auth-auth-secret-2222bbbb'),
        { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: metadata('rate-limit', null), spec: { rateLimit: { average: 10 } } } as Middleware,
      ];
      return planRevert(input({ applied, previous: { version: '1.4.1', objects: previous, helm: [] }, failureActions }));
    }

    it('a changed Middleware is restored with its auth Secret, an added one is removed', () => {
      const plan = middlewareCase({});
      expect(names(plan.apply)).toEqual([
        'Secret/admin-auth-auth-secret-1111aaaa',
        'Deployment/web',
        'Middleware/admin-auth',
        'IngressRoute/shop-production-web',
      ]);
      expect(names(plan.remove)).toEqual(['Middleware/rate-limit']);
    });

    it('the Middleware restore does not depend on the services being reverted', () => {
      const plan = middlewareCase({ web: 'pause' });
      expect(plan.leftInPlace).toEqual([{ service: 'web', reason: 'failure-action' }]);
      expect(names(plan.apply)).toEqual(['Secret/admin-auth-auth-secret-1111aaaa', 'Middleware/admin-auth']);
      expect(names(plan.remove)).toEqual(['Middleware/rate-limit']);
    });
  });

  it('--only targets restrict the reverted services', () => {
    const { previous, applied } = example();
    const plan = planRevert(
      input({
        targets: ['web'],
        applied,
        previous: { version: '1.4.1', objects: previous, helm: [] },
        changes: [change('web', 'Deployment', 'web'), change('worker', 'Deployment', 'worker', { created: true })],
      }),
    );
    expect(plan.services).toEqual(['web']);
    expect(plan.remove).toEqual([]);
  });

  it('U-REVERT-03b: a disruptive kind switch deletes the live workload of the new kind first', () => {
    const previous = [deployment('db', '1.4.1', { claims: ['pgdata'] }), pvc('pgdata')];
    const applied = [statefulSet('db', '1.4.2', { claims: ['pgdata'] }), pvc('pgdata')];
    const plan = planRevert(
      input({
        applied,
        previous: { version: '1.4.1', objects: previous, helm: [] },
        changes: [change('db', 'StatefulSet', 'db', { created: true })],
        disruptive: [{ service: 'db', from: 'Deployment', to: 'StatefulSet', deleted: { kind: 'Deployment', name: 'db' } }],
        now: snapshot(live('StatefulSet', 'db', { revision: 'db-aaa', pendingRevision: 'db-bbb' })),
        livePvcNames: ['pgdata'],
      }),
    );
    expect(plan.deleteFirst).toEqual([{ kind: 'StatefulSet', name: 'db', service: 'db' }]);
    expect(names(plan.apply)).toEqual(['Deployment/db']);
    expect(plan.statefulSetPods).toEqual([]);
    expect(plan.watch).toEqual([{ service: 'db', kind: 'Deployment', name: 'db' }]);
  });

  it('an overlapping switch deletes the new kind first and keeps the old workload', () => {
    const plan = planRevert(
      input({
        applied: [{ ...deployment('api', '1.4.2'), kind: 'DaemonSet' } as ManifestObject],
        previous: { version: '1.4.1', objects: [deployment('api', '1.4.1')], helm: [] },
        changes: [change('api', 'DaemonSet', 'api', { created: true })],
        now: snapshot(live('Deployment', 'api'), live('DaemonSet', 'api')),
      }),
    );
    expect(plan.deleteFirst).toEqual([{ kind: 'DaemonSet', name: 'api', service: 'api' }]);
    expect(names(plan.apply)).toEqual(['Deployment/api']);
  });

  it('sorts multiple deleteFirst entries by service name', () => {
    const previous = [deployment('api', '1.4.1'), deployment('db', '1.4.1', { claims: ['pgdata'] }), pvc('pgdata')];
    const applied = [
      { ...deployment('api', '1.4.2'), kind: 'DaemonSet' } as ManifestObject,
      statefulSet('db', '1.4.2', { claims: ['pgdata'] }),
      pvc('pgdata'),
    ];
    const plan = planRevert(
      input({
        applied,
        previous: { version: '1.4.1', objects: previous, helm: [] },
        changes: [change('api', 'DaemonSet', 'api', { created: true }), change('db', 'StatefulSet', 'db', { created: true })],
        disruptive: [{ service: 'db', from: 'Deployment', to: 'StatefulSet', deleted: { kind: 'Deployment', name: 'db' } }],
        now: snapshot(
          live('Deployment', 'api'),
          live('DaemonSet', 'api'),
          live('StatefulSet', 'db', { revision: 'db-aaa', pendingRevision: 'db-bbb' }),
        ),
        livePvcNames: ['pgdata'],
      }),
    );
    expect(plan.deleteFirst).toEqual([
      { kind: 'DaemonSet', name: 'api', service: 'api' },
      { kind: 'StatefulSet', name: 'db', service: 'db' },
    ]);
    // db's stuck pod is covered by the deletion above, not reported again (K17)
    expect(plan.statefulSetPods).toEqual([]);
  });

  describe('StatefulSet forced rollback (K17)', () => {
    const previous = [statefulSet('queue', '1.4.1'), statefulSet('cache', '1.4.1')];
    const applied = [statefulSet('queue', '1.4.2', { image: 'registry.example.com/queue:2' }), statefulSet('cache', '1.4.2', { image: 'registry.example.com/cache:2' })];
    const now = snapshot(
      live('StatefulSet', 'cache', { revision: 'cache-aaa', pendingRevision: 'cache-aaa' }),
      live('StatefulSet', 'queue', { revision: 'queue-aaa', pendingRevision: 'queue-bbb' }),
    );

    it('keys on updateRevision !== currentRevision of the live StatefulSet, whatever before says', () => {
      for (const before of [snapshot(), snapshot(live('StatefulSet', 'queue', { revision: 'queue-aaa', pendingRevision: 'queue-bbb' }))]) {
        const plan = planRevert(
          input({
            applied,
            previous: { version: '1.4.1', objects: previous, helm: [] },
            changes: [change('queue', 'StatefulSet', 'queue'), change('cache', 'StatefulSet', 'cache')],
            before,
            now,
          }),
        );
        expect(plan.statefulSetPods).toEqual([{ service: 'queue', statefulSet: 'queue', failedRevision: 'queue-bbb' }]);
      }
    });

    it('no stuck pods when updateRevision equals currentRevision', () => {
      const plan = planRevert(
        input({
          applied,
          previous: { version: '1.4.1', objects: previous, helm: [] },
          changes: [change('cache', 'StatefulSet', 'cache')],
          now,
        }),
      );
      expect(plan.services).toEqual(['cache', 'queue']);
      expect(plan.statefulSetPods.map((p) => p.statefulSet)).toEqual(['queue']);
      const onlyCache = planRevert(
        input({
          applied: [applied[1]],
          previous: { version: '1.4.1', objects: previous, helm: [] },
          changes: [change('cache', 'StatefulSet', 'cache')],
          now,
        }),
      );
      expect(onlyCache.statefulSetPods).toEqual([]);
    });

    it('sorts several stuck pods by StatefulSet name', () => {
      const bothStuck = snapshot(
        live('StatefulSet', 'cache', { revision: 'cache-aaa', pendingRevision: 'cache-bbb' }),
        live('StatefulSet', 'queue', { revision: 'queue-aaa', pendingRevision: 'queue-bbb' }),
      );
      const plan = planRevert(
        input({
          applied,
          previous: { version: '1.4.1', objects: previous, helm: [] },
          changes: [change('queue', 'StatefulSet', 'queue'), change('cache', 'StatefulSet', 'cache')],
          now: bothStuck,
        }),
      );
      expect(plan.statefulSetPods).toEqual([
        { service: 'cache', statefulSet: 'cache', failedRevision: 'cache-bbb' },
        { service: 'queue', statefulSet: 'queue', failedRevision: 'queue-bbb' },
      ]);
    });
  });

  it('K18: the partial receipt of a Helm failure plans only the Helm restore, without a TypeError', () => {
    const a = helmRecord('search', '1.2.0', 'a'.repeat(64));
    const aNew = helmRecord('search', '1.3.0', 'd'.repeat(64));
    const st = stateFor({
      ref: { project: 'shop', env: 'production', role: 'app' },
      namespace: NS,
      objects: example().applied,
      now: T0,
      applied: [],
      helmApplied: [{ release: aNew, replaced: a }],
    });
    expect(st.previous).toBeNull();
    expect(st.targets).toBeNull();
    expect(st.before).toEqual(emptySnapshot(T0));
    expect(st.after).toEqual(emptySnapshot(T0));
    const plan = planRevert({
      role: st.ref.role,
      targets: st.targets,
      changes: [],
      applied: st.applied,
      previous: st.previous,
      helmApplied: st.helmApplied,
      failureActions: st.failureActions,
      disruptive: st.disruptive,
      before: st.before,
      now: emptySnapshot(T0),
      livePvcNames: [],
    });
    expect(plan).toEqual({
      services: [],
      deleteFirst: [],
      apply: [],
      remove: [],
      undo: [],
      scale: [],
      statefulSetPods: [],
      helm: [a],
      leftInPlace: [],
      watch: [],
    });
  });
});
