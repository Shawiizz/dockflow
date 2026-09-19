// design-03 8.2 (22.2 `apply/prune-plan.test.ts`), DESIGN-CORE C11/C12, design-07 U-PRUNE-01..08:
// the prune plan, claim-template PVCs (K40) and the zero-workload guard counts.

import { describe, expect, it } from 'bun:test';
import {
  type LiveItem,
  type LiveObjectRef,
  parseHashedNames,
  perReplicaClaimNames,
  planPrune,
  type PrunePlanInput,
  pruneGuard,
  toLiveRefs,
  toPvcRefs,
} from '../../../services/orchestrator/kubernetes/apply/prune-plan';
import type { LiveWorkload, Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import type { StackRole } from '../../../services/orchestrator/kubernetes/model/types';
import type { Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { PersistentVolumeClaim, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import { KIND_REGISTRY, type ManifestKind, type ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { pick, randomInt, type Rng } from '../support/prng';
import { forAll } from '../support/property';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';

function deployment(name: string): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: NS },
    spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name, image: 'registry.example.com/app:1' }] } } },
  };
}

function statefulSet(name: string, templates: string[]): StatefulSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name, namespace: NS },
    spec: {
      selector: {},
      template: { metadata: {}, spec: { containers: [{ name, image: 'registry.example.com/app:1' }] } },
      volumeClaimTemplates: templates.map((t) => ({
        metadata: { name: t },
        spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
      })),
    },
  };
}

function service(name: string): Service {
  return { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: NS }, spec: {} };
}

function pvc(name: string): PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: NS, labels: { [`${P}/volume`]: name } },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
  };
}

const ref = (kind: ManifestKind, name: string, extra: Partial<LiveObjectRef> = {}): LiveObjectRef => ({ kind, name, service: name, ...extra });

function input(overrides: Partial<PrunePlanInput>): PrunePlanInput {
  return {
    rendered: [],
    live: [],
    liveHashed: [],
    references: new Set(),
    livePvcs: [],
    liveStatefulSets: [],
    ...overrides,
  };
}

function stackLabels(role: StackRole, part = 'stack'): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'dockflow',
    [`${P}/stack`]: NS,
    [`${P}/role`]: role,
    [`${P}/part`]: part,
  };
}

describe('planPrune', () => {
  it('U-PRUNE-01: deletes a removed service in the order IngressRoute, Deployment, Service', () => {
    const plan = planPrune(
      input({
        rendered: [deployment('web'), service('web')],
        live: [
          ref('Service', 'worker'),
          ref('Deployment', 'web'),
          ref('Deployment', 'worker'),
          ref('IngressRoute', 'shop-production-worker'),
          ref('Service', 'web'),
        ],
      }),
    );
    expect(plan.delete.map((d) => `${d.kind}/${d.name}`)).toEqual([
      'IngressRoute/shop-production-worker',
      'Deployment/worker',
      'Service/worker',
    ]);
  });

  it('prunes the old Deployment after a Deployment -> StatefulSet switch', () => {
    const plan = planPrune(
      input({ rendered: [statefulSet('db', [])], live: [ref('Deployment', 'db'), ref('StatefulSet', 'db')] }),
    );
    expect(plan.delete).toEqual([ref('Deployment', 'db')]);
  });

  it('U-PRUNE-05/06: keeps hashed objects that are rendered or referenced and deletes the others', () => {
    const plan = planPrune(
      input({
        rendered: [{ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'web-env-3f9a1c2e', namespace: NS } }],
        liveHashed: [
          { kind: 'Secret', name: 'web-env-3f9a1c2e' },
          { kind: 'Secret', name: 'web-env-1b2c3d4e' },
          { kind: 'ConfigMap', name: 'app-conf-config-0c1d2e3f' },
          { kind: 'Secret', name: 'web-env-00000000' },
        ],
        references: new Set(['Secret/web-env-1b2c3d4e']),
      }),
    );
    expect(plan.keptHashed).toEqual([
      { kind: 'Secret', name: 'web-env-1b2c3d4e', reason: 'referenced' },
      { kind: 'Secret', name: 'web-env-3f9a1c2e', reason: 'rendered' },
    ]);
    expect(plan.deleteHashed).toEqual([
      { kind: 'ConfigMap', name: 'app-conf-config-0c1d2e3f' },
      { kind: 'Secret', name: 'web-env-00000000' },
    ]);
    expect(plan.delete).toEqual([]);
  });

  it('U-PRUNE-02: reports an orphan PVC and never deletes a claim', () => {
    const plan = planPrune(
      input({
        rendered: [deployment('web')],
        live: [ref('PersistentVolumeClaim', 'jobs-data', { service: null })],
        livePvcs: [
          { name: 'jobs-data', volume: 'jobs-data' },
          { name: 'uploads', volume: 'uploads' },
        ],
      }),
    );
    expect(plan.delete).toEqual([]);
    expect(plan.orphanPvcs).toEqual([
      { name: 'jobs-data', volume: 'jobs-data' },
      { name: 'uploads', volume: 'uploads' },
    ]);
  });

  it('keeps a still-running Job out of the delete list and reports it', () => {
    const plan = planPrune(
      input({
        live: [
          ref('Job', 'migrate-3f9a1c2e', { service: 'migrate', jobActive: true }),
          ref('Job', 'migrate-00000000', { service: 'migrate', jobActive: false }),
        ],
      }),
    );
    expect(plan.keptJobs).toEqual([ref('Job', 'migrate-3f9a1c2e', { service: 'migrate', jobActive: true })]);
    expect(plan.delete).toEqual([ref('Job', 'migrate-00000000', { service: 'migrate', jobActive: false })]);
  });

  describe('claim-template PVCs (K40)', () => {
    it('does not report the claims of a live StatefulSet template', () => {
      const plan = planPrune(
        input({
          rendered: [statefulSet('queue', ['queue-data'])],
          livePvcs: [
            { name: 'queue-data-queue-0', volume: 'queue-data' },
            { name: 'queue-data-queue-1', volume: 'queue-data' },
          ],
          liveStatefulSets: [{ name: 'queue', claimTemplates: ['queue-data'] }],
        }),
      );
      expect(plan.orphanPvcs).toEqual([]);
    });

    it('does not report a claim whose template left the render but is still on the live StatefulSet', () => {
      const plan = planPrune(
        input({
          rendered: [statefulSet('queue', [])],
          livePvcs: [{ name: 'queue-cache-queue-0', volume: 'queue-cache' }],
          liveStatefulSets: [{ name: 'queue', claimTemplates: ['queue-cache'] }],
        }),
      );
      expect(plan.orphanPvcs).toEqual([]);
    });

    it('reports a claim whose StatefulSet and template are both gone', () => {
      const plan = planPrune(
        input({ rendered: [deployment('web')], livePvcs: [{ name: 'queue-data-queue-0', volume: 'queue-data' }] }),
      );
      expect(plan.orphanPvcs).toEqual([{ name: 'queue-data-queue-0', volume: 'queue-data' }]);
    });

    it('matches a template name that contains `-`, and only digit ordinals', () => {
      const claimed = perReplicaClaimNames([statefulSet('db', ['pg-data'])], []);
      expect(claimed.prefixes).toEqual(['pg-data-db-']);
      expect(claimed.has('pg-data-db-0')).toBe(true);
      expect(claimed.has('pg-data-db-12')).toBe(true);
      expect(claimed.has('pg-data-db-')).toBe(false);
      expect(claimed.has('pg-data-db-x')).toBe(false);
      expect(claimed.has('pg-data-db2-0')).toBe(false);
      expect(claimed.has('pg-data')).toBe(false);
    });

    it('unions the templates of the rendered and the live StatefulSet of the same name', () => {
      const claimed = perReplicaClaimNames([statefulSet('queue', ['queue-data'])], [{ name: 'queue', claimTemplates: ['queue-data', 'queue-old'] }]);
      expect(claimed.prefixes).toEqual(['queue-data-queue-', 'queue-old-queue-']);
    });
  });

  describe('toLiveRefs', () => {
    const item = (kind: string, name: string, labels: Record<string, string>, extra: Partial<LiveItem> & { status?: unknown } = {}) =>
      ({ kind, metadata: { name, namespace: NS, labels, annotations: { [`${P}/compose-service`]: name } }, ...extra }) as LiveItem;

    it('U-PRUNE-03: drops objects of the other role', () => {
      expect(toLiveRefs([item('Deployment', 'redis', stackLabels('accessory'))], 'app')).toEqual([]);
    });

    it('U-PRUNE-04: drops release, state and registry objects and helper pods (no P/part=stack)', () => {
      const items = [
        item('Secret', 'dockflow-release-1.4.1', stackLabels('app', 'release')),
        item('ConfigMap', 'dockflow-state', stackLabels('app', 'state')),
        item('Secret', 'dockflow-registry', stackLabels('app', 'registry')),
        item('Pod', 'backup-helper', stackLabels('app', 'helper')),
        item('Deployment', 'web', { [`${P}/role`]: 'app' }),
      ];
      expect(toLiveRefs(items, 'app')).toEqual([]);
    });

    it('U-PRUNE-08: never lists a Namespace', () => {
      expect(toLiveRefs([item('Namespace', NS, stackLabels('app'))], 'app')).toEqual([]);
    });

    it('maps the compose service and the Job activity', () => {
      const items = [
        item('Deployment', 'worker', stackLabels('app')),
        { ...item('Job', 'migrate-3f9a1c2e', stackLabels('app')), status: { active: 1 } } as LiveItem,
      ];
      expect(toLiveRefs(items, 'app')).toEqual([
        { kind: 'Deployment', name: 'worker', service: 'worker' },
        { kind: 'Job', name: 'migrate-3f9a1c2e', service: 'migrate-3f9a1c2e', jobActive: true },
      ]);
      const plan = planPrune(input({ live: toLiveRefs(items, 'app') }));
      expect(plan.delete.map((d) => d.name)).toEqual(['worker']);
      expect(plan.keptJobs.map((d) => d.name)).toEqual(['migrate-3f9a1c2e']);
    });
  });

  it('toPvcRefs reads the P/volume label; parseHashedNames reads K15 `-o name` output', () => {
    const shared = pvc('jobs-data');
    const unlabelled: PersistentVolumeClaim = { ...pvc('legacy'), metadata: { name: 'legacy', namespace: NS } };
    expect(toPvcRefs([shared, unlabelled])).toEqual([
      { name: 'jobs-data', volume: 'jobs-data' },
      { name: 'legacy', volume: null },
    ]);
    expect(parseHashedNames('secret/web-env-3f9a1c2e\nconfigmap/app-conf-config-0c1d2e3f\r\n\npod/other\n')).toEqual([
      { kind: 'Secret', name: 'web-env-3f9a1c2e' },
      { kind: 'ConfigMap', name: 'app-conf-config-0c1d2e3f' },
    ]);
  });
});

describe('pruneGuard (U-PRUNE-07 counts)', () => {
  const live = (name: string): LiveWorkload => ({
    kind: 'Deployment',
    name,
    service: name,
    uid: name,
    generation: 1,
    replicas: 1,
    revision: null,
    pendingRevision: null,
    revisionNumber: null,
    graceSeconds: 30,
    paused: false,
    deleting: false,
    job: null,
    claimTemplates: [],
    refs: { secrets: [], configMaps: [], claims: [], images: [] },
  });
  const before = (n: number): Snapshot => ({
    takenAt: new Date(0),
    workloads: Array.from({ length: n }, (_, i) => live(`svc-${i}`)),
    services: [],
  });

  it('refuses a render with zero workloads while 3 workloads of the role run', () => {
    expect(pruneGuard([service('web')], before(3))).toEqual({ renderedWorkloads: 0, liveWorkloads: 3, refuse: true });
  });

  it('lets a render with workloads, or an empty namespace, through', () => {
    expect(pruneGuard([deployment('web')], before(3)).refuse).toBe(false);
    expect(pruneGuard([], before(0)).refuse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Properties (generated inputs)
// ---------------------------------------------------------------------------

const KINDS: string[] = [...(Object.keys(KIND_REGISTRY) as ManifestKind[]), 'Namespace', 'Pod', 'ReplicaSet'];
const PARTS = ['stack', 'release', 'state', 'registry', 'helper', 'system', ''];
const ROLES: StackRole[] = ['app', 'accessory'];
const WORDS = ['web', 'api', 'db', 'pg-data', 'queue', 'queue-data', 'cache', 'a', 'a-b'];

interface Case {
  role: StackRole;
  items: (LiveItem & { status?: { active?: number } })[];
  rendered: ManifestObject[];
  liveStatefulSets: { name: string; claimTemplates: string[] }[];
  livePvcs: { name: string; volume: string | null }[];
}

function genCase(rng: Rng, size: number): Case {
  const role = pick(rng, ROLES);
  const count = randomInt(rng, 0, Math.min(30, size));
  const items: Case['items'] = [];
  for (let i = 0; i < count; i++) {
    const kind = pick(rng, KINDS);
    const labels: Record<string, string> = { [`${P}/role`]: pick(rng, ROLES) };
    const part = pick(rng, PARTS);
    if (part !== '') labels[`${P}/part`] = part;
    items.push({
      kind,
      metadata: { name: `${pick(rng, WORDS)}-${i}`, labels },
      status: kind === 'Job' ? { active: randomInt(rng, 0, 2) } : undefined,
    });
  }
  const liveStatefulSets = Array.from({ length: randomInt(rng, 0, 3) }, (_, i) => ({
    name: `${pick(rng, WORDS)}${i}`,
    claimTemplates: Array.from({ length: randomInt(rng, 0, 2) }, () => pick(rng, WORDS)),
  }));
  const rendered: ManifestObject[] = [];
  for (let i = 0; i < randomInt(rng, 0, 4); i++) {
    rendered.push(rng() < 0.5 ? deployment(`${pick(rng, WORDS)}-${i}`) : statefulSet(`${pick(rng, WORDS)}${i}`, [pick(rng, WORDS)]));
  }
  const livePvcs: Case['livePvcs'] = [];
  for (const s of liveStatefulSets) {
    for (const t of s.claimTemplates) livePvcs.push({ name: `${t}-${s.name}-${randomInt(rng, 0, 12)}`, volume: t });
  }
  for (let i = 0; i < randomInt(rng, 0, 4); i++) {
    const name = `${pick(rng, WORDS)}-${pick(rng, WORDS)}-${pick(rng, ['0', '1', 'x', ''])}`;
    livePvcs.push({ name, volume: rng() < 0.5 ? name : null });
  }
  return { role, items, rendered, liveStatefulSets, livePvcs };
}

function planOf(c: Case) {
  return planPrune({
    rendered: c.rendered,
    live: toLiveRefs(c.items, c.role),
    liveHashed: [],
    references: new Set(),
    livePvcs: c.livePvcs,
    liveStatefulSets: c.liveStatefulSets,
  });
}

forAll('the delete list holds no PVC, no Namespace, no hashed kind and nothing outside part=stack of the role', genCase, (c) => {
  for (const d of planOf(c).delete) {
    expect(['PersistentVolumeClaim', 'Namespace', 'Secret', 'ConfigMap']).not.toContain(d.kind);
    expect(KIND_REGISTRY[d.kind].prune).toBe('prune');
    const source = c.items.find((i) => i.kind === d.kind && i.metadata.name === d.name);
    expect(source?.metadata.labels?.[`${P}/part`]).toBe('stack');
    expect(source?.metadata.labels?.[`${P}/role`]).toBe(c.role);
  }
});

forAll('the delete list never holds an active Job', genCase, (c) => {
  const plan = planOf(c);
  expect(plan.delete.some((d) => d.kind === 'Job' && d.jobActive === true)).toBe(false);
  for (const j of plan.keptJobs) expect(j.jobActive).toBe(true);
});

forAll('orphanPvcs never holds <template>-<live statefulset>-<ordinal>', genCase, (c) => {
  for (const orphan of planOf(c).orphanPvcs) {
    for (const s of c.liveStatefulSets) {
      for (const t of s.claimTemplates) {
        const prefix = `${t}-${s.name}-`;
        const perReplica = orphan.name.startsWith(prefix) && /^[0-9]+$/.test(orphan.name.slice(prefix.length));
        expect(perReplica).toBe(false);
      }
    }
  }
});
