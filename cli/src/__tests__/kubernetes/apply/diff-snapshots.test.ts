// design-03 2.4 and 5.6 (22.2 `apply/diff-snapshots.test.ts`), design-07 U-APPLY-05: snapshots
// mapped from K07 + K08 and change detection.

import { describe, expect, it } from 'bun:test';
import {
  claimTemplatesOf,
  diffSnapshots,
  emptySnapshot,
  type LiveWorkload,
  type Snapshot,
  type SnapshotItem,
  toSnapshot,
} from '../../../services/orchestrator/kubernetes/apply/snapshot';
import type { ControllerRevision, DaemonSet, Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../../services/orchestrator/kubernetes/resources/batch';
import type { PodTemplateSpec, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const T0 = new Date('2026-09-17T10:00:00.000Z');

function template(extra: Partial<PodTemplateSpec['spec']> = {}): PodTemplateSpec {
  return { metadata: {}, spec: { containers: [{ name: 'app', image: 'registry.example.com/app:1' }], ...extra } };
}

function meta(name: string, service: string, extra: Record<string, unknown> = {}) {
  return { name, namespace: NS, annotations: { [`${P}/compose-service`]: service }, ...extra };
}

function deployment(name: string, service = name): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(name, service),
    spec: { replicas: 1, selector: {}, template: template() },
  };
}

function job(name: string, service: string): Job {
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: meta(name, service), spec: { template: template() } };
}

function service(name: string, composeName: string): Service {
  return { apiVersion: 'v1', kind: 'Service', metadata: meta(name, composeName), spec: { ports: [{ port: 80, protocol: 'TCP' }] } };
}

function live(kind: LiveWorkload['kind'], name: string, extra: Partial<LiveWorkload> = {}): LiveWorkload {
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
    job: kind === 'Job' ? { finished: null, active: 0 } : null,
    claimTemplates: [],
    refs: { secrets: [], configMaps: [], claims: [], images: [] },
    ...extra,
  };
}

function snap(workloads: LiveWorkload[]): Snapshot {
  return { takenAt: T0, workloads, services: [] };
}

describe('diffSnapshots', () => {
  it('reports a workload absent from before as created', () => {
    const changes = diffSnapshots(snap([]), snap([live('Deployment', 'web', { generation: 1 })]), [deployment('web')]);
    expect(changes).toEqual([
      {
        service: 'web',
        kind: 'Deployment',
        name: 'web',
        created: true,
        previousRevision: null,
        previousRevisionNumber: null,
        previousReplicas: null,
        generation: 1,
      },
    ]);
  });

  it('reports a generation bump with the previous revision, revision number and replicas', () => {
    const before = snap([live('Deployment', 'web', { generation: 7, revision: '3', revisionNumber: 3, replicas: 2 })]);
    const after = snap([live('Deployment', 'web', { generation: 8, revision: '4', revisionNumber: 4, replicas: 2 })]);
    expect(diffSnapshots(before, after, [deployment('web')])).toEqual([
      {
        service: 'web',
        kind: 'Deployment',
        name: 'web',
        created: false,
        previousRevision: '3',
        previousRevisionNumber: 3,
        previousReplicas: 2,
        generation: 8,
      },
    ]);
  });

  it('ignores a metadata-only change (the generation did not move)', () => {
    const before = snap([live('Deployment', 'web', { generation: 4 })]);
    const after = snap([live('Deployment', 'web', { generation: 4 })]);
    expect(diffSnapshots(before, after, [deployment('web')])).toEqual([]);
  });

  it('reports a replicas-only change, which bumps the generation but keeps the revision', () => {
    const before = snap([live('Deployment', 'web', { generation: 4, revision: '2', revisionNumber: 2, replicas: 2 })]);
    const after = snap([live('Deployment', 'web', { generation: 5, revision: '2', revisionNumber: 2, replicas: 3 })]);
    const [change] = diffSnapshots(before, after, [deployment('web')]);
    expect(change).toMatchObject({ created: false, previousRevision: '2', previousReplicas: 2, generation: 5 });
  });

  it('ignores an applied workload missing after a failed apply', () => {
    const changes = diffSnapshots(snap([]), snap([live('Deployment', 'web')]), [deployment('web'), deployment('worker')]);
    expect(changes.map((c) => c.name)).toEqual(['web']);
  });

  it('reports a new Job as created and never compares Jobs by revision', () => {
    const [change] = diffSnapshots(snap([]), snap([live('Job', 'migrate-3f9a1c2e', { service: 'migrate' })]), [
      job('migrate-3f9a1c2e', 'migrate'),
    ]);
    expect(change).toMatchObject({ service: 'migrate', kind: 'Job', created: true, previousRevision: null, previousReplicas: null });
  });

  it('reports a Job recreated under the same name as created although before lists it', () => {
    const before = snap([live('Job', 'migrate-3f9a1c2e', { service: 'migrate', generation: 1 })]);
    const after = snap([live('Job', 'migrate-3f9a1c2e', { service: 'migrate', generation: 1 })]);
    const applied = [job('migrate-3f9a1c2e', 'migrate')];
    expect(diffSnapshots(before, after, applied)).toEqual([]);
    const [change] = diffSnapshots(before, after, applied, [{ kind: 'Job', name: 'migrate-3f9a1c2e', service: 'migrate' }]);
    expect(change).toMatchObject({ kind: 'Job', name: 'migrate-3f9a1c2e', created: true });
  });

  it('fills previousRevisionNumber from the revision number, never from the ControllerRevision name', () => {
    const before = snap([live('StatefulSet', 'db', { generation: 2, revision: 'db-7c9d5f', revisionNumber: 4 })]);
    const after = snap([live('StatefulSet', 'db', { generation: 3, revision: 'db-7c9d5f', pendingRevision: 'db-66a1b2' })]);
    const statefulSet: StatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: meta('db', 'db'),
      spec: { selector: {}, template: template() },
    };
    const [change] = diffSnapshots(before, after, [statefulSet]);
    expect(change.previousRevision).toBe('db-7c9d5f');
    expect(change.previousRevisionNumber).toBe(4);
  });

  it('sorts by service, then kind, then name, and ignores non-workload objects', () => {
    const after = snap([
      live('Deployment', 'worker'),
      live('Job', 'api-seed-1', { service: 'api' }),
      live('Deployment', 'api'),
      live('Deployment', 'web'),
    ]);
    const applied: ManifestObject[] = [
      deployment('worker'),
      service('web', 'web'),
      deployment('web'),
      job('api-seed-1', 'api'),
      deployment('api'),
    ];
    expect(diffSnapshots(snap([]), after, applied).map((c) => `${c.service}:${c.kind}/${c.name}`)).toEqual([
      'api:Deployment/api',
      'api:Job/api-seed-1',
      'web:Deployment/web',
      'worker:Deployment/worker',
    ]);
  });
});

describe('toSnapshot', () => {
  function revision(name: string, owner: { kind: string; name: string; uid: string }, number: number): ControllerRevision {
    return {
      apiVersion: 'apps/v1',
      kind: 'ControllerRevision',
      metadata: { name, namespace: NS, ownerReferences: [{ apiVersion: 'apps/v1', controller: true, ...owner }] },
      revision: number,
    };
  }

  it('maps a Deployment: revision annotation and its integer, paused, grace period, replicas and refs', () => {
    const d: Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        ...meta('web-app', 'web_app'),
        uid: 'u1',
        generation: 7,
        annotations: { [`${P}/compose-service`]: 'web_app', 'deployment.kubernetes.io/revision': '5' },
      },
      spec: {
        replicas: 3,
        paused: true,
        selector: {},
        template: template({
          terminationGracePeriodSeconds: 300,
          containers: [{ name: 'app', image: 'registry.example.com/web:2', envFrom: [{ secretRef: { name: 'web-app-env-3f9a1c2e' } }] }],
          volumes: [{ name: 'pvc-data', persistentVolumeClaim: { claimName: 'data' } }],
        }),
      },
    };
    const [w] = toSnapshot([d], [], T0).workloads;
    expect(w).toEqual({
      kind: 'Deployment',
      name: 'web-app',
      service: 'web_app',
      uid: 'u1',
      generation: 7,
      replicas: 3,
      revision: '5',
      pendingRevision: null,
      revisionNumber: 5,
      graceSeconds: 300,
      paused: true,
      deleting: false,
      job: null,
      claimTemplates: [],
      refs: { secrets: ['web-app-env-3f9a1c2e'], configMaps: [], claims: ['data'], images: ['registry.example.com/web:2'] },
    });
  });

  it('falls back to the P/service label, a 30 s grace period and one replica', () => {
    const d = deployment('worker');
    d.metadata.annotations = undefined;
    d.metadata.labels = { [`${P}/service`]: 'worker' };
    d.spec.replicas = undefined;
    d.metadata.deletionTimestamp = '2026-09-17T09:59:00Z';
    const [w] = toSnapshot([d], [], T0).workloads;
    expect(w).toMatchObject({ service: 'worker', graceSeconds: 30, replicas: 1, revision: null, revisionNumber: null, deleting: true });
  });

  it('maps a StatefulSet mid-update: currentRevision, updateRevision as pendingRevision, its number and claim templates (K17)', () => {
    const s: StatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { ...meta('queue', 'queue'), uid: 'sts-1', generation: 3 },
      spec: {
        replicas: 2,
        selector: {},
        template: template(),
        volumeClaimTemplates: [
          {
            metadata: { name: 'queue-data', annotations: { [`${P}/compose-volume`]: 'queue_data' } },
            spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1024Mi' } }, storageClassName: 'dockflow-local' },
          },
        ],
      },
      status: { currentRevision: 'queue-aaa', updateRevision: 'queue-bbb' },
    };
    const revisions = [
      revision('queue-aaa', { kind: 'StatefulSet', name: 'queue', uid: 'sts-1' }, 3),
      revision('queue-bbb', { kind: 'StatefulSet', name: 'queue', uid: 'sts-1' }, 4),
    ];
    const snapshot = toSnapshot([s], revisions, T0);
    expect(snapshot.workloads[0]).toMatchObject({
      revision: 'queue-aaa',
      pendingRevision: 'queue-bbb',
      revisionNumber: 3,
      replicas: 2,
      claimTemplates: [
        { name: 'queue-data', volumeKey: 'queue_data', storageClassName: 'dockflow-local', accessModes: ['ReadWriteOnce'], storage: '1Gi' },
      ],
      refs: { claims: [] },
    });
    expect(claimTemplatesOf(snapshot)).toEqual([{ name: 'queue', claimTemplates: ['queue-data'] }]);
  });

  it('uses currentRevision as pendingRevision when no update is in flight', () => {
    const s: StatefulSet = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { ...meta('db', 'db'), uid: 'sts-2' },
      spec: { selector: {}, template: template() },
      status: { currentRevision: 'db-aaa' },
    };
    const [w] = toSnapshot([s], [revision('db-aaa', { kind: 'StatefulSet', name: 'db', uid: 'sts-2' }, 9)], T0).workloads;
    expect(w).toMatchObject({ revision: 'db-aaa', pendingRevision: 'db-aaa', revisionNumber: 9 });
  });

  it('maps a DaemonSet to its own ControllerRevision with the highest revision', () => {
    const ds: DaemonSet = {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { ...meta('agent', 'agent'), uid: 'ds-1' },
      spec: { selector: {}, template: template() },
    };
    const revisions = [
      revision('agent-111', { kind: 'DaemonSet', name: 'agent', uid: 'ds-1' }, 1),
      revision('agent-333', { kind: 'DaemonSet', name: 'agent', uid: 'ds-1' }, 3),
      revision('agent-222', { kind: 'DaemonSet', name: 'agent', uid: 'ds-1' }, 2),
      revision('other-999', { kind: 'DaemonSet', name: 'other', uid: 'ds-9' }, 9),
    ];
    const [w] = toSnapshot([ds], revisions, T0).workloads;
    expect(w).toMatchObject({ revision: 'agent-333', revisionNumber: 3, pendingRevision: null, replicas: null });
  });

  it('maps Job conditions to a terminal state and the active count', () => {
    const withConditions = (name: string, conditions: { type: string; status: 'True' | 'False' }[], active?: number): Job => ({
      ...job(name, name),
      status: { conditions, active },
    });
    const items = [
      withConditions('a-complete', [{ type: 'Complete', status: 'True' }]),
      withConditions('b-criteria', [{ type: 'SuccessCriteriaMet', status: 'True' }]),
      withConditions('c-failed', [{ type: 'Failed', status: 'True' }]),
      withConditions('d-target', [{ type: 'FailureTarget', status: 'True' }], 1),
      withConditions('e-running', [{ type: 'Complete', status: 'False' }], 2),
    ];
    const jobs = toSnapshot(items, [], T0).workloads.map((w) => [w.name, w.job]);
    expect(jobs).toEqual([
      ['a-complete', { finished: 'complete', active: 0 }],
      ['b-criteria', { finished: 'complete', active: 0 }],
      ['c-failed', { finished: 'failed', active: 0 }],
      ['d-target', { finished: 'failed', active: 1 }],
      ['e-running', { finished: null, active: 2 }],
    ]);
  });

  it('maps Services with their type, clusterIP, ports and load-balancer ingress', () => {
    const lb: Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('web-lb', 'web'),
      spec: { type: 'LoadBalancer', clusterIP: '10.43.0.12', ports: [{ port: 8080, protocol: 'TCP', targetPort: 3000 }] },
      status: { loadBalancer: { ingress: [{ ip: '10.0.0.5' }] } },
    };
    const headless: Service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('web-hl', 'web'),
      spec: { clusterIP: 'None', ports: [{ port: 3000, protocol: 'UDP' }] },
    };
    expect(toSnapshot([lb, headless], [], T0).services).toEqual([
      {
        name: 'web-hl',
        service: 'web',
        type: 'ClusterIP',
        clusterIP: 'None',
        ports: [{ port: 3000, protocol: 'UDP', targetPort: null }],
        hasIngress: false,
      },
      {
        name: 'web-lb',
        service: 'web',
        type: 'LoadBalancer',
        clusterIP: '10.43.0.12',
        ports: [{ port: 8080, protocol: 'TCP', targetPort: 3000 }],
        hasIngress: true,
      },
    ]);
  });

  it('sorts workloads by kind rank, then name, and stamps the time it is given', () => {
    const items: SnapshotItem[] = [job('seed-1', 'seed'), deployment('web'), deployment('api')];
    const snapshot = toSnapshot(items, [], T0);
    expect(snapshot.workloads.map((w) => w.name)).toEqual(['api', 'web', 'seed-1']);
    expect(snapshot.takenAt).toBe(T0);
  });

  it('emptySnapshot has no workloads and no services', () => {
    expect(emptySnapshot(T0)).toEqual({ takenAt: T0, workloads: [], services: [] });
  });
});
