// translate/storage.ts (design-02 7, 4.3, 4.4, 13; K14, K35, K40): standalone PVCs, claim
// templates, the access-mode rules decidable on the model, the data-safety invariants of 7.4 and
// the claim-shape arithmetic of 7.4.1. Every emitted claim is validated with support/schema.

import { describe, expect, test } from 'bun:test';
import type { Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import { ANNOTATIONS, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { selectorLabels } from '../../../services/orchestrator/kubernetes/labels';
import type { CanonicalService, CanonicalVolume, VolumeMountSpec } from '../../../services/orchestrator/kubernetes/model/types';
import type { PersistentVolumeClaimTemplate, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { PersistentVolumeClaim } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import type { TranslateContext } from '../../../services/orchestrator/kubernetes/translate/context';
import {
  buildClaims,
  buildClaimTemplates,
  type ClaimShape,
  claimShapeConflicts,
  claimShapeError,
  claimShapeRebindNotice,
  claimShapeSuggestion,
  liveClaimShapes,
  renderedClaimShapes,
} from '../../../services/orchestrator/kubernetes/translate/storage';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalService, canonicalStack, canonicalVolume, identity, translateContext } from '../support/builders';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';
import { validateObject } from '../support/schema/validate';

const NS = 'dockflow-shop-production';
const ID = identity();
const P = 'dockflow.shawiizz.dev';
const TARGET = { env: 'production', role: 'app' } as const;

/** A defensive re-check (T6): a DeployError asking for a bug report, never a diagnostic. */
function expectBug(run: () => unknown): DeployError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeployError);
  const error = caught as DeployError;
  expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
  expect(error.suggestion).toBe('Report this as a Dockflow bug.');
  return error;
}

/** The sink holds exactly `expected`, messages and hints included. */
function expectDiagnostics(sink: DiagnosticSink, expected: Diagnostic[]): void {
  expect(sink.list()).toEqual(expected);
}

function mountOf(volume: string, target = `/data/${volume}`, service = 'web'): VolumeMountSpec {
  return { type: 'volume', volume, target, readOnly: false, subpath: null, path: `services.${service}.volumes[0]` };
}

function volume(key: string, overrides: Partial<CanonicalVolume> = {}): CanonicalVolume {
  return canonicalVolume({ key, ...overrides });
}

function statefulService(composeName: string, volumes: string[], overrides: Parameters<typeof canonicalService>[0] = {}): CanonicalService {
  return canonicalService({
    composeName,
    extension: { kind: 'statefulset' },
    mounts: volumes.map((key, i) => mountOf(key, `/data/${i}`, composeName)),
    ...overrides,
  });
}

function ctxFor(services: CanonicalService[], volumes: CanonicalVolume[], role: 'app' | 'accessory' = 'app', traits = {}): TranslateContext {
  return translateContext(canonicalStack({ role, services, volumes }), { traits });
}

/** A StatefulSet object as workloads.ts emits it, reduced to what the claim rules read. */
function statefulSetObject(name: string, templates: PersistentVolumeClaimTemplate[]): StatefulSet {
  const selector = selectorLabels(ID, name);
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name, namespace: NS },
    spec: {
      selector: { matchLabels: selector },
      serviceName: `${name}-hl`,
      template: { metadata: { labels: selector }, spec: { containers: [{ name, image: 'postgres:17' }] } },
      volumeClaimTemplates: templates,
    },
  };
}

/** The PVCs the StatefulSet controller creates from a template: `<template>-<statefulset>-<ordinal>`, labels inherited. */
function controllerClaims(statefulSet: string, template: PersistentVolumeClaimTemplate, replicas: number): PersistentVolumeClaim[] {
  return Array.from({ length: replicas }, (_, ordinal) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      ...structuredClone(template.metadata),
      name: `${template.metadata.name}-${statefulSet}-${ordinal}`,
      namespace: NS,
    },
    spec: structuredClone(template.spec),
  }));
}

function templateAsClaim(template: PersistentVolumeClaimTemplate): PersistentVolumeClaim {
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { ...template.metadata, namespace: NS }, spec: template.spec };
}

function expectValidArtifact(objects: readonly unknown[]): void {
  expect(formatIssues(failures(validateArtifact(objects, { namespace: NS })))).toBe('');
}

function livePvc(name: string, key: string, volumeLabel: string, part = 'stack'): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name,
      namespace: NS,
      annotations: { [ANNOTATIONS.composeVolume]: key },
      labels: { [LABELS.part]: part, [LABELS.volume]: volumeLabel },
      uid: `uid-${name}`,
    },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
    status: { phase: 'Bound' },
  };
}

// ---------------------------------------------------------------------------------------------
// Standalone PVCs (7.1, 7.2)

describe('buildClaims (design-02 7.1, 7.2)', () => {
  test('T-STOR-01: the standalone PVC of 7.1, field by field', () => {
    const db = canonicalService({ composeName: 'postgres', role: 'accessory', mounts: [mountOf('postgres_data', '/var/lib/postgresql/data', 'postgres')] });
    const data = volume('postgres_data', { role: 'accessory', usedBy: ['postgres'] });
    expect(buildClaims(ctxFor([db], [data], 'accessory'))).toEqual([
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: 'postgres-data',
          namespace: NS,
          annotations: { [`${P}/compose-volume`]: 'postgres_data' },
          labels: {
            'app.kubernetes.io/instance': NS,
            'app.kubernetes.io/managed-by': 'dockflow',
            'app.kubernetes.io/part-of': 'shop',
            [`${P}/part`]: 'stack',
            [`${P}/role`]: 'accessory',
            [`${P}/stack`]: NS,
            [`${P}/volume`]: 'postgres-data',
          },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '1Gi' } },
          storageClassName: 'dockflow-local',
        },
      },
    ]);
  });

  test('never emits volumeMode, selector, volumeName, dataSource or ownerReferences', () => {
    const [claim] = buildClaims(ctxFor([canonicalService({ mounts: [mountOf('data')] })], [volume('data')]));
    expect(Object.keys(claim.spec).sort()).toEqual(['accessModes', 'resources', 'storageClassName']);
    expect(Object.keys(claim.metadata).sort()).toEqual(['annotations', 'labels', 'name', 'namespace']);
  });

  test('top-level volume labels merge under the Dockflow labels, which win', () => {
    const data = volume('data', { labels: { tier: 'db', [LABELS.part]: 'user-value', [LABELS.volume]: 'other' } });
    const [claim] = buildClaims(ctxFor([canonicalService({ mounts: [mountOf('data')] })], [data]));
    expect(claim.metadata.labels?.tier).toBe('db');
    expect(claim.metadata.labels?.[LABELS.part]).toBe('stack');
    expect(claim.metadata.labels?.[LABELS.volume]).toBe('data');
  });

  test('T-STOR-05: size is emitted in canonical quantity form; a non-quantity size is a Dockflow bug', () => {
    const svc = canonicalService({ mounts: [mountOf('data')] });
    for (const [size, canonical] of [
      ['1024Mi', '1Gi'],
      ['2048Ki', '2Mi'],
      ['10G', '10G'],
      ['1.5Gi', '1536Mi'],
    ]) {
      const [claim] = buildClaims(ctxFor([svc], [volume('data', { size })]));
      expect(claim.spec.resources.requests.storage).toBe(canonical);
    }
    expectBug(() => buildClaims(ctxFor([svc], [volume('data', { size: 'ten gigs' })])));
  });

  test('another storage class is emitted as requested, whatever its access mode', () => {
    const svc = canonicalService({ mounts: [mountOf('shared')] });
    const ctx = ctxFor([svc], [volume('shared', { storageClass: 'fast-nfs', accessMode: 'ReadWriteMany' })]);
    const [claim] = buildClaims(ctx);
    expect(claim.spec.storageClassName).toBe('fast-nfs');
    expect(claim.spec.accessModes).toEqual(['ReadWriteMany']);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('T-STOR-02: an external volume and a per-replica volume have no standalone PVC', () => {
    const web = canonicalService({ mounts: [mountOf('legacy')] });
    const queue = statefulService('queue', ['queue_data']);
    const claims = buildClaims(
      ctxFor([queue, web], [volume('legacy', { external: true, name: 'legacy-data' }), volume('queue_data', { perReplica: true, usedBy: ['queue'] })]),
    );
    expect(claims).toEqual([]);
  });

  test('claims validate (S01, S13, S20, S27)', () => {
    const svc = canonicalService({ mounts: [mountOf('data'), mountOf('media', '/media')] });
    expectValidArtifact(
      buildClaims(ctxFor([svc], [volume('data', { size: '10Gi' }), volume('media', { labels: { tier: 'media' }, accessMode: 'ReadWriteOncePod' })])),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Access modes (7.3) and global services (4.4)

describe('access-mode rules (design-02 7.3, 4.4)', () => {
  test('ReadWriteMany on the default class is volumes.access-mode-unsupported', () => {
    const svc = canonicalService({ mounts: [mountOf('shared')] });
    const ctx = ctxFor([svc], [volume('shared', { accessMode: 'ReadWriteMany' })]);
    buildClaims(ctx);
    expectDiagnostics(
      ctx.sink,
      [
        {
          severity: 'error',
          code: 'volumes.access-mode-unsupported',
          path: 'volumes.shared.x-dockflow.access_mode',
          message: 'Volume shared asks for ReadWriteMany, which storage class dockflow-local cannot provision',
          hint: 'Use `ReadWriteOnce`, or set `x-dockflow.storage_class` to a class that supports `ReadWriteMany`.',
        },
      ],
    );
  });

  test('the rule reads traits.defaultStorageClassAccessModes, never a hard-coded fact', () => {
    const svc = canonicalService({ mounts: [mountOf('shared')] });
    const allowing = ctxFor([svc], [volume('shared', { accessMode: 'ReadWriteMany' })], 'app', {
      defaultStorageClassAccessModes: ['ReadWriteOnce', 'ReadWriteMany'],
    });
    buildClaims(allowing);
    expect(allowing.sink.list()).toEqual([]);

    const refusingRwo = ctxFor([svc], [volume('shared', { accessMode: 'ReadWriteOnce' })], 'app', {
      defaultStorageClassAccessModes: ['ReadWriteOncePod'],
    });
    buildClaims(refusingRwo);
    expect(refusingRwo.sink.list().map((d) => d.code)).toEqual(['volumes.access-mode-unsupported']);
  });

  test('ReadWriteOncePod on the default class of k3s is accepted', () => {
    const ctx = ctxFor([canonicalService({ mounts: [mountOf('data')] })], [volume('data', { accessMode: 'ReadWriteOncePod' })]);
    buildClaims(ctx);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('an external claim is not held to the default class trait', () => {
    const ctx = ctxFor([canonicalService({ mounts: [mountOf('legacy')] })], [volume('legacy', { external: true, name: 'legacy-data', accessMode: 'ReadWriteMany' })]);
    buildClaims(ctx);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('a ReadWriteOnce volume used by two services is volumes.rwo-shared (warning)', () => {
    const web = canonicalService({ mounts: [mountOf('media')] });
    const worker = canonicalService({ composeName: 'worker', mounts: [mountOf('media', '/media', 'worker')] });
    const ctx = ctxFor([web, worker], [volume('media', { usedBy: ['web', 'worker'] })]);
    buildClaims(ctx);
    expectDiagnostics(
      ctx.sink,
      [
        {
          severity: 'warning',
          code: 'volumes.rwo-shared',
          path: 'volumes.media',
          message: 'Volume media (ReadWriteOnce) is used by web, worker; all of them run on the node that holds it',
          hint: 'Give each service its own volume if they may run on different nodes.',
        },
      ],
    );
  });

  test('an external ReadWriteOnce claim used by two services warns the same way', () => {
    const ctx = ctxFor([], [volume('legacy', { external: true, name: 'legacy-data', usedBy: ['api', 'web'] })]);
    buildClaims(ctx);
    expect(ctx.sink.list().map((d) => [d.severity, d.code])).toEqual([['warning', 'volumes.rwo-shared']]);
  });

  test('a ReadWriteOncePod volume used by two services is volumes.rwop-shared (error)', () => {
    const ctx = ctxFor([], [volume('media', { accessMode: 'ReadWriteOncePod', usedBy: ['web', 'worker'] })]);
    buildClaims(ctx);
    expectDiagnostics(
      ctx.sink,
      [
        {
          severity: 'error',
          code: 'volumes.rwop-shared',
          path: 'volumes.media',
          message: 'Volume media (ReadWriteOncePod) is used by web, worker, but only one pod can mount it',
          hint: 'Give each service its own volume, or set `x-dockflow.access_mode: ReadWriteOnce`.',
        },
      ],
    );
  });

  test('a per-replica volume mounted by two StatefulSets is volumes.per-replica-shared only', () => {
    const ctx = ctxFor([], [volume('queue_data', { perReplica: true, usedBy: ['queue_a', 'queue_b'] })]);
    buildClaims(ctx);
    expectDiagnostics(
      ctx.sink,
      [
        {
          severity: 'error',
          code: 'volumes.per-replica-shared',
          path: 'volumes.queue_data',
          message: 'Volume queue_data has per_replica: true and is mounted by queue_a, queue_b; a claim template belongs to one StatefulSet',
          hint: 'Declare one per-replica volume per service.',
        },
      ],
    );
  });

  test('a ReadWriteMany volume of a class that supports it can be shared silently; one consumer is always fine', () => {
    const ctx = ctxFor([], [volume('shared', { storageClass: 'fast-nfs', accessMode: 'ReadWriteMany', usedBy: ['a', 'b'] }), volume('single')]);
    buildClaims(ctx);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('a global service mounting an RWO volume is volumes.rwo-global', () => {
    const agent = canonicalService({ composeName: 'agent', mode: 'global', mounts: [mountOf('state', '/state', 'agent')] });
    const ctx = ctxFor([agent], [volume('state', { usedBy: ['agent'] })]);
    buildClaims(ctx);
    expectDiagnostics(
      ctx.sink,
      [
        {
          severity: 'error',
          code: 'volumes.rwo-global',
          path: 'services.agent.deploy.mode',
          message: 'Global service agent runs on every node and cannot share volume state (ReadWriteOnce)',
          hint: 'Use a bind mount for per-node data, or a `ReadWriteMany` storage class.',
        },
      ],
    );
  });

  test('volumes.rwo-global covers external claims and ReadWriteOncePod (K35)', () => {
    const external = canonicalService({ composeName: 'agent', mode: 'global', mounts: [mountOf('legacy', '/legacy', 'agent')] });
    const rwop = canonicalService({ composeName: 'probe', mode: 'global', mounts: [mountOf('pod_only', '/p', 'probe')] });
    const ctx = ctxFor(
      [external, rwop],
      [volume('legacy', { external: true, name: 'legacy-data', usedBy: ['agent'] }), volume('pod_only', { accessMode: 'ReadWriteOncePod', usedBy: ['probe'] })],
    );
    buildClaims(ctx);
    expect(ctx.sink.list().map((d) => [d.code, d.path, d.message])).toEqual([
      ['volumes.rwo-global', 'services.agent.deploy.mode', 'Global service agent runs on every node and cannot share volume legacy (ReadWriteOnce)'],
      ['volumes.rwo-global', 'services.probe.deploy.mode', 'Global service probe runs on every node and cannot share volume pod_only (ReadWriteOncePod)'],
    ]);
  });

  test('volumes.rwo-global: one report per service, naming its first RWO mount; RWX and replicated services are fine', () => {
    const agent = canonicalService({ composeName: 'agent', mode: 'global', mounts: [mountOf('b_vol', '/a', 'agent'), mountOf('a_vol', '/b', 'agent')] });
    const shared = canonicalService({ composeName: 'shared', mode: 'global', mounts: [mountOf('nfs', '/n', 'shared')] });
    const web = canonicalService({ mounts: [mountOf('web_data')] });
    const ctx = ctxFor(
      [agent, shared, web],
      [
        volume('a_vol', { usedBy: ['agent'] }),
        volume('b_vol', { usedBy: ['agent'] }),
        volume('nfs', { storageClass: 'fast-nfs', accessMode: 'ReadWriteMany', usedBy: ['shared'] }),
        volume('web_data'),
      ],
    );
    buildClaims(ctx);
    expect(ctx.sink.list().map((d) => [d.code, d.path, d.message])).toEqual([
      ['volumes.rwo-global', 'services.agent.deploy.mode', 'Global service agent runs on every node and cannot share volume b_vol (ReadWriteOnce)'],
    ]);
  });

  test('T6: a mount of a volume the stack does not define throws a Dockflow bug', () => {
    const agent = canonicalService({ composeName: 'agent', mode: 'global', mounts: [mountOf('ghost', '/g', 'agent')] });
    expectBug(() => buildClaims(ctxFor([agent], [])));
    const queue = statefulService('queue', ['ghost']);
    expectBug(() => buildClaimTemplates(queue, ctxFor([queue], [])));
  });
});

// ---------------------------------------------------------------------------------------------
// Claim templates (4.3, K40)

describe('buildClaimTemplates (design-02 4.3, K40)', () => {
  test('one template per per-replica volume, P/volume = template name, no namespace', () => {
    const queue = statefulService('queue', ['queue_data'], { role: 'accessory' });
    const data = volume('queue_data', { role: 'accessory', perReplica: true, size: '10Gi', usedBy: ['queue'] });
    expect(buildClaimTemplates(queue, ctxFor([queue], [data], 'accessory'))).toEqual([
      {
        metadata: {
          name: 'queue-data',
          annotations: { [`${P}/compose-volume`]: 'queue_data' },
          labels: {
            'app.kubernetes.io/instance': NS,
            'app.kubernetes.io/managed-by': 'dockflow',
            'app.kubernetes.io/part-of': 'shop',
            [`${P}/part`]: 'stack',
            [`${P}/role`]: 'accessory',
            [`${P}/stack`]: NS,
            [`${P}/volume`]: 'queue-data',
          },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '10Gi' } },
          storageClassName: 'dockflow-local',
        },
      },
    ]);
  });

  test('sorted by name, one per volume however often it is mounted; shared and external volumes have none', () => {
    const svc = statefulService('db', ['z_data', 'a_data', 'shared', 'legacy'], {
      mounts: [mountOf('z_data', '/z', 'db'), mountOf('a_data', '/a', 'db'), mountOf('z_data', '/z2', 'db'), mountOf('shared', '/s', 'db'), mountOf('legacy', '/l', 'db')],
    });
    const ctx = ctxFor(
      [svc],
      [
        volume('a_data', { perReplica: true, usedBy: ['db'] }),
        volume('z_data', { perReplica: true, usedBy: ['db'] }),
        volume('shared', { usedBy: ['db'] }),
        volume('legacy', { external: true, name: 'legacy-data', usedBy: ['db'] }),
      ],
    );
    expect(buildClaimTemplates(svc, ctx).map((t) => t.metadata.name)).toEqual(['a-data', 'z-data']);
    expect(buildClaims(ctx).map((c) => c.metadata.name)).toEqual(['shared']);
  });

  test('T6: per_replica on an external volume (refused by the normalizer, X4) throws a Dockflow bug', () => {
    const queue = statefulService('queue', ['legacy']);
    const legacy = volume('legacy', { external: true, name: 'legacy-data', perReplica: true, usedBy: ['queue'] });
    expectBug(() => buildClaimTemplates(queue, ctxFor([queue], [legacy])));
    expectBug(() => buildClaims(ctxFor([], [legacy])));
  });

  test('every kind other than StatefulSet has no template', () => {
    const data = volume('data', { perReplica: true });
    for (const svc of [
      canonicalService({ mounts: [mountOf('data')] }),
      canonicalService({ mode: 'global', mounts: [mountOf('data')] }),
      canonicalService({ mode: 'replicated-job', mounts: [mountOf('data')] }),
    ]) {
      expect(buildClaimTemplates(svc, ctxFor([svc], [data]))).toEqual([]);
    }
  });

  test('templates validate as the claims the controller creates, and inside a StatefulSet', () => {
    const svc = statefulService('queue', ['queue_data', 'queue_logs']);
    const ctx = ctxFor([svc], [volume('queue_data', { perReplica: true, usedBy: ['queue'] }), volume('queue_logs', { perReplica: true, size: '512Mi', usedBy: ['queue'] })]);
    const templates = buildClaimTemplates(svc, ctx);
    expectValidArtifact(templates.map(templateAsClaim));
    expect(validateObject(statefulSetObject('queue', templates))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Data-safety invariants (7.4)

describe('data-safety invariants (design-02 7.4)', () => {
  function mixedStack(overrides: Partial<CanonicalVolume> = {}): TranslateContext {
    const web = canonicalService({ mounts: [mountOf('media'), mountOf('legacy', '/legacy')] });
    const queue = statefulService('queue', ['queue_data']);
    return ctxFor(
      [queue, web],
      [
        volume('legacy', { external: true, name: 'legacy-data' }),
        volume('media', overrides),
        volume('queue_data', { perReplica: true, usedBy: ['queue'], ...overrides }),
      ],
    );
  }

  test('1, 2, 4: no ownerReferences, an explicit storage class everywhere, only PVCs and no reclaim policy', () => {
    const ctx = mixedStack();
    const claims = buildClaims(ctx);
    const templates = ctx.stack.services.flatMap((svc) => buildClaimTemplates(svc, ctx));
    expect(claims.map((c) => c.kind)).toEqual(['PersistentVolumeClaim']);
    for (const claim of [...claims, ...templates]) {
      expect(claim.metadata).not.toHaveProperty('ownerReferences');
      expect(claim.spec.storageClassName).toBe('dockflow-local');
    }
    expect(JSON.stringify([claims, templates])).not.toContain('persistentVolumeReclaimPolicy');
  });

  test('5: size, class and access mode changes never rename a claim', () => {
    const before = mixedStack();
    const after = mixedStack({ size: '20Gi', storageClass: 'fast-ssd', accessMode: 'ReadWriteOncePod' });
    const names = (ctx: TranslateContext): string[] => [
      ...buildClaims(ctx).map((c) => c.metadata.name),
      ...ctx.stack.services.flatMap((svc) => buildClaimTemplates(svc, ctx)).map((t) => t.metadata.name),
    ];
    expect(names(after)).toEqual(names(before));
  });

  test('6: P/volume is the claim name on a PVC and the template name on a template (K40)', () => {
    const ctx = mixedStack();
    for (const claim of buildClaims(ctx)) expect(claim.metadata.labels?.[LABELS.volume]).toBe(claim.metadata.name);
    const [template] = buildClaimTemplates(ctx.stack.services[0], ctx);
    expect(template.metadata.labels?.[LABELS.volume]).toBe('queue-data');
    for (const pvc of controllerClaims('queue', template, 3)) {
      expect(pvc.metadata.labels?.[LABELS.volume]).toBe('queue-data');
      expect(pvc.metadata.name).not.toBe('queue-data');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Claim shape and rebinding (7.4.1, K14)

describe('renderedClaimShapes and liveClaimShapes (design-02 7.4.1)', () => {
  test('rendered: a PVC is shared, a claim template is per-replica on its StatefulSet', () => {
    const web = canonicalService({ composeName: 'db', mounts: [mountOf('postgres_data', '/pg', 'db')] });
    const queue = statefulService('queue', ['queue_data']);
    const ctx = ctxFor([web, queue], [volume('postgres_data', { usedBy: ['db'] }), volume('queue_data', { perReplica: true, usedBy: ['queue'] })]);
    const objects: ManifestObject[] = [...buildClaims(ctx), statefulSetObject('queue', buildClaimTemplates(queue, ctx))];
    expect(Object.fromEntries(renderedClaimShapes(objects))).toEqual({
      postgres_data: { shape: 'shared', claim: 'postgres-data' },
      queue_data: { shape: 'per-replica', template: 'queue-data', statefulSet: 'queue' },
    });
  });

  test('rendered: objects without the compose-volume annotation are ignored', () => {
    const foreign = livePvc('other', 'x', 'other');
    delete foreign.metadata.annotations;
    expect(renderedClaimShapes([foreign]).size).toBe(0);
  });

  test('live: shared and per-replica claims, ordinals collapsed into one shape', () => {
    const shapes = liveClaimShapes([
      livePvc('postgres-data', 'postgres_data', 'postgres-data'),
      livePvc('queue-data-queue-2', 'queue_data', 'queue-data'),
      livePvc('queue-data-queue-0', 'queue_data', 'queue-data'),
      livePvc('queue-data-queue-1', 'queue_data', 'queue-data'),
    ]);
    expect(Object.fromEntries(shapes)).toEqual({
      postgres_data: [{ shape: 'shared', claim: 'postgres-data' }],
      queue_data: [{ shape: 'per-replica', template: 'queue-data', statefulSet: 'queue' }],
    });
  });

  test('live: the ordinal pattern splits template and StatefulSet names that contain `-`', () => {
    const shapes = liveClaimShapes([livePvc('queue-data-queue-a-2', 'queue_data', 'queue-data'), livePvc('queue-data-queue-a-10', 'queue_data', 'queue-data')]);
    expect(shapes.get('queue_data')).toEqual([{ shape: 'per-replica', template: 'queue-data', statefulSet: 'queue-a' }]);
  });

  test('live: a template name with regexp characters is matched literally', () => {
    const shapes = liveClaimShapes([livePvc('a.b-db-0', 'a_b', 'a.b'), livePvc('aXb-db-0', 'a_b', 'a.b')]);
    expect(shapes.get('a_b')).toEqual([{ shape: 'per-replica', template: 'a.b', statefulSet: 'db' }]);
  });

  test('live: claims of other keys, other parts, without Dockflow metadata or of another name form are ignored or kept apart', () => {
    const bare = livePvc('bare', 'bare', 'bare');
    delete bare.metadata.labels;
    const unannotated = livePvc('plain', 'plain', 'plain');
    delete unannotated.metadata.annotations;
    const shapes = liveClaimShapes([
      livePvc('postgres-data', 'postgres_data', 'postgres-data'),
      livePvc('other-data', 'other_data', 'other-data'),
      livePvc('postgres-data', 'postgres_data', 'postgres-data', 'release'),
      livePvc('renamed-claim', 'postgres_data', 'postgres-data'),
      bare,
      unannotated,
    ]);
    expect(Object.fromEntries(shapes)).toEqual({
      other_data: [{ shape: 'shared', claim: 'other-data' }],
      postgres_data: [{ shape: 'shared', claim: 'postgres-data' }],
    });
  });

  test('live: several shapes of one key are listed shared first, then by StatefulSet', () => {
    const shapes = liveClaimShapes([
      livePvc('data-web-b-0', 'data', 'data'),
      livePvc('data-web-a-0', 'data', 'data'),
      livePvc('data', 'data', 'data'),
    ]);
    expect(shapes.get('data')).toEqual([
      { shape: 'shared', claim: 'data' },
      { shape: 'per-replica', template: 'data', statefulSet: 'web-a' },
      { shape: 'per-replica', template: 'data', statefulSet: 'web-b' },
    ]);
  });
});

describe('claimShapeConflicts (design-02 7.4.1, K14)', () => {
  const shared: ClaimShape = { shape: 'shared', claim: 'postgres-data' };
  const perReplica = (statefulSet: string): ClaimShape => ({ shape: 'per-replica', template: 'postgres-data', statefulSet });

  test('shared -> per-replica: refused naming both claims (the example of 7.4.1)', () => {
    const [conflict, ...rest] = claimShapeConflicts(new Map([['postgres_data', perReplica('db')]]), new Map([['postgres_data', [shared]]]));
    expect(rest).toEqual([]);
    expect(conflict).toEqual({
      key: 'postgres_data',
      live: shared,
      rendered: perReplica('db'),
      from: 'postgres-data',
      to: 'postgres-data-db-<ordinal>',
      message:
        'Volume postgres_data would move from the claim postgres-data to the new per-replica claims postgres-data-db-<ordinal>, which start empty; postgres-data and its data are kept',
    });
    expect(claimShapeSuggestion(conflict, TARGET)).toBe(
      'Revert the x-dockflow.per_replica change to keep using postgres-data, or run `dockflow deploy production --rebind-volumes` and copy the data across (`dockflow volumes list production` shows both claims).',
    );
  });

  test('per-replica -> shared: the claims are named the other way round', () => {
    const [conflict] = claimShapeConflicts(new Map([['postgres_data', shared]]), new Map([['postgres_data', [perReplica('db')]]]));
    expect(conflict.message).toBe(
      'Volume postgres_data would move from the per-replica claims postgres-data-db-<ordinal> to the new claim postgres-data, which starts empty; postgres-data-db-<ordinal> and their data are kept',
    );
    expect(claimShapeSuggestion(conflict, TARGET)).toBe(
      'Revert the x-dockflow.per_replica, x-dockflow.kind or deploy.mode change to keep using postgres-data-db-<ordinal>, or run `dockflow deploy production --rebind-volumes` and copy the data across (`dockflow volumes list production` shows both claims).',
    );
  });

  test('StatefulSet rename: both StatefulSets claim patterns are named', () => {
    const rendered = new Map<string, ClaimShape>([['queue_data', { shape: 'per-replica', template: 'queue-data', statefulSet: 'queue-b' }]]);
    const live = new Map<string, ClaimShape[]>([['queue_data', [{ shape: 'per-replica', template: 'queue-data', statefulSet: 'queue-a' }]]]);
    const [conflict] = claimShapeConflicts(rendered, live);
    expect(conflict.message).toBe(
      'Volume queue_data would move from the per-replica claims queue-data-queue-a-<ordinal> to the new per-replica claims queue-data-queue-b-<ordinal>, which start empty; queue-data-queue-a-<ordinal> and their data are kept',
    );
    expect(claimShapeSuggestion(conflict, TARGET)).toBe(
      'Revert the rename of the service that ran StatefulSet queue-a to keep using queue-data-queue-a-<ordinal>, or run `dockflow deploy production --rebind-volumes` and copy the data across (`dockflow volumes list production` shows both claims).',
    );
  });

  test('Deployment -> StatefulSet with per_replica: true, end to end through the builders and the live claims', () => {
    const data = volume('postgres_data', { usedBy: ['db'] });
    const before = canonicalService({ composeName: 'db', mounts: [mountOf('postgres_data', '/pg', 'db')] });
    const live = buildClaims(ctxFor([before], [data])).map((claim) => ({ ...claim, status: { phase: 'Bound' as const } }));

    const after = statefulService('db', ['postgres_data']);
    const afterCtx = ctxFor([after], [{ ...data, perReplica: true }]);
    const rendered = [...buildClaims(afterCtx), statefulSetObject('db', buildClaimTemplates(after, afterCtx))];

    const conflicts = claimShapeConflicts(renderedClaimShapes(rendered), liveClaimShapes(live));
    expect(conflicts.map((c) => c.message)).toEqual([
      'Volume postgres_data would move from the claim postgres-data to the new per-replica claims postgres-data-db-<ordinal>, which start empty; postgres-data and its data are kept',
    ]);
  });

  test('no-op: first deploy, same shape, and Deployment -> StatefulSet keeping a shared volume', () => {
    expect(claimShapeConflicts(new Map([['postgres_data', shared]]), new Map())).toEqual([]);
    expect(claimShapeConflicts(new Map([['postgres_data', shared]]), new Map([['postgres_data', [shared]]]))).toEqual([]);
    expect(claimShapeConflicts(new Map([['postgres_data', perReplica('db')]]), new Map([['postgres_data', [perReplica('db')]]]))).toEqual([]);

    const data = volume('postgres_data', { usedBy: ['db'] });
    const before = canonicalService({ composeName: 'db', mounts: [mountOf('postgres_data', '/pg', 'db')] });
    const live = buildClaims(ctxFor([before], [data]));
    const after = statefulService('db', ['postgres_data']);
    const afterCtx = ctxFor([after], [data]);
    const rendered = [...buildClaims(afterCtx), statefulSetObject('db', buildClaimTemplates(after, afterCtx))];
    expect(claimShapeConflicts(renderedClaimShapes(rendered), liveClaimShapes(live))).toEqual([]);
  });

  test('no-op: the claims a --rebind-volumes deploy left behind never block the next deploy', () => {
    const live = liveClaimShapes([
      livePvc('postgres-data', 'postgres_data', 'postgres-data'),
      livePvc('postgres-data-db-0', 'postgres_data', 'postgres-data'),
    ]);
    expect(claimShapeConflicts(new Map([['postgres_data', perReplica('db')]]), live)).toEqual([]);
  });

  test('no-op: an external volume has no rendered claim and is never compared; other keys are ignored', () => {
    const live = liveClaimShapes([livePvc('legacy-data-db-0', 'legacy', 'legacy-data'), livePvc('other', 'other', 'other')]);
    expect(claimShapeConflicts(new Map([['postgres_data', shared]]), live)).toEqual([]);
  });

  test('conflicts are listed by compose key, independent of map order', () => {
    const rendered = new Map<string, ClaimShape>([
      ['zeta', { shape: 'per-replica', template: 'zeta', statefulSet: 'db' }],
      ['alpha', { shape: 'per-replica', template: 'alpha', statefulSet: 'db' }],
    ]);
    const live = new Map<string, ClaimShape[]>([
      ['alpha', [{ shape: 'shared', claim: 'alpha' }]],
      ['zeta', [{ shape: 'shared', claim: 'zeta' }]],
    ]);
    expect(claimShapeConflicts(rendered, live).map((c) => c.key)).toEqual(['alpha', 'zeta']);
  });

  test('claimShapeError is the DeployError the engine throws before any mutation', () => {
    const [conflict] = claimShapeConflicts(new Map([['postgres_data', perReplica('db')]]), new Map([['postgres_data', [shared]]]));
    const error = claimShapeError(conflict, TARGET);
    expect(error).toBeInstanceOf(DeployError);
    expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(error.message).toBe(conflict.message);
    expect(error.suggestion).toBe(claimShapeSuggestion(conflict, TARGET));
  });

  test('role accessory points at `dockflow accessories deploy <env> --rebind-volumes`', () => {
    const [conflict] = claimShapeConflicts(new Map([['postgres_data', perReplica('db')]]), new Map([['postgres_data', [shared]]]));
    expect(claimShapeSuggestion(conflict, { env: 'staging', role: 'accessory' })).toBe(
      'Revert the x-dockflow.per_replica change to keep using postgres-data, or run `dockflow accessories deploy staging --rebind-volumes` and copy the data across (`dockflow volumes list staging` shows both claims).',
    );
  });

  test('the rebind notice names the claim left behind', () => {
    const [toPerReplica] = claimShapeConflicts(new Map([['postgres_data', perReplica('db')]]), new Map([['postgres_data', [shared]]]));
    expect(claimShapeRebindNotice(toPerReplica)).toBe(
      'Volume postgres_data now uses postgres-data-db-<ordinal>; postgres-data is kept and listed by dockflow volumes list',
    );
    const [toShared] = claimShapeConflicts(new Map([['postgres_data', shared]]), new Map([['postgres_data', [perReplica('db')]]]));
    expect(claimShapeRebindNotice(toShared)).toBe(
      'Volume postgres_data now uses postgres-data; postgres-data-db-<ordinal> are kept and listed by dockflow volumes list',
    );
  });
});
