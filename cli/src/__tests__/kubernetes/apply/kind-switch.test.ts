// design-03 5.4.3 and 5.4.5 (22.2 `apply/kind-switch.test.ts`, K15, K74), design-07 U-APPLY-07/08:
// workload kind switches over the transition table, the two SwitchFacts builders, and the
// foreign-ownership classification of the pre-apply checks.

import { describe, expect, it } from 'bun:test';
import {
  classifyOwnership,
  describeSwitches,
  factsFromObjects,
  factsFromStack,
  foreignObjects,
  foreignOwnerError,
  type KindSwitchPlan,
  planKindSwitches,
  type SwitchFacts,
} from '../../../services/orchestrator/kubernetes/apply/pre-apply';
import type { LiveWorkload, Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import type { StackRef, WorkloadKind } from '../../../services/orchestrator/interfaces';
import type {
  CanonicalService,
  CanonicalStack,
  CanonicalVolume,
  MountSpec,
  PortSpec,
} from '../../../services/orchestrator/kubernetes/model/types';
import type { PersistentVolumeClaimTemplate } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Container, PodSpec, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManagedFieldsEntry } from '../../../services/orchestrator/kubernetes/resources/meta';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { DeployError, ErrorCode } from '../../../utils/errors';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };

// ---------------------------------------------------------------------------
// Builders: one model service and the workload object the translator makes of it
// ---------------------------------------------------------------------------

interface Shape {
  kind: WorkloadKind;
  /** standalone claims mounted by the pod */
  claims?: string[];
  /** per-replica claim templates (StatefulSet) */
  templates?: string[];
  /** node ports bound by the containers */
  hostPorts?: number[];
  hostNetwork?: boolean;
}

function workloadObject(service: string, shape: Shape, name = service): ManifestObject {
  const containers: Container[] = [
    {
      name: service,
      image: `registry.example.com/${service}:1`,
      ports: (shape.hostPorts ?? []).map((p) => ({ containerPort: p, protocol: 'TCP' as const, hostPort: p })),
    },
  ];
  const spec: PodSpec = {
    containers,
    volumes: (shape.claims ?? []).map((c) => ({ name: `pvc-${c}`, persistentVolumeClaim: { claimName: c } })),
    hostNetwork: shape.hostNetwork,
  };
  const metadata = { name, namespace: NS, annotations: { [`${P}/compose-service`]: service } };
  const template = { metadata: {}, spec };
  const claimTemplates: PersistentVolumeClaimTemplate[] = (shape.templates ?? []).map((t) => ({
    metadata: { name: t },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
  }));
  switch (shape.kind) {
    case 'Deployment':
      return { apiVersion: 'apps/v1', kind: 'Deployment', metadata, spec: { selector: {}, template } };
    case 'StatefulSet':
      return { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata, spec: { selector: {}, template, volumeClaimTemplates: claimTemplates } };
    case 'DaemonSet':
      return { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata, spec: { selector: {}, template } };
    case 'Job':
      return { apiVersion: 'batch/v1', kind: 'Job', metadata, spec: { template } };
  }
}

function modelService(composeName: string, kind: WorkloadKind, extra: Partial<CanonicalService> = {}): CanonicalService {
  return {
    composeName,
    name: composeName,
    role: 'app',
    path: `services.${composeName}`,
    mode: kind === 'DaemonSet' ? 'global' : kind === 'Job' ? 'replicated-job' : 'replicated',
    workloadKind: kind,
    replicas: 1,
    image: { ref: `registry.example.com/${composeName}:1`, composeRef: `${composeName}:1`, origin: 'pulled', pullPolicy: 'IfNotPresent' },
    process: {
      entrypoint: null,
      command: null,
      workingDir: null,
      user: null,
      groupAdd: [],
      tty: false,
      stdinOpen: false,
      init: false,
      stopGracePeriodMs: 10_000,
      hostname: null,
      postStart: null,
      preStop: null,
    },
    environment: [],
    ports: [],
    expose: [],
    mounts: [],
    files: [],
    healthcheck: null,
    update: {
      parallelism: 1,
      delayMs: 0,
      failureAction: 'rollback',
      monitorMs: 0,
      order: 'stop-first',
      maxFailureRatio: 0,
      defaults: 'dockflow',
    },
    restart: { condition: 'any', delayMs: null, maxAttempts: null, windowMs: null },
    resources: { limits: { cpu: null, memory: null, pids: null }, reservations: { cpu: null, memory: null } },
    placement: { constraints: [], spreadLabels: [], maxReplicasPerNode: null },
    security: {
      privileged: false,
      capAdd: [],
      capDrop: [],
      readOnlyRootFilesystem: false,
      noNewPrivileges: false,
      seccomp: 'default',
      apparmor: 'default',
      sysctls: {},
      hostPid: false,
      hostIpc: false,
    },
    network: {
      networks: [],
      aliases: [],
      endpointMode: 'vip',
      hostNetwork: false,
      dns: [],
      dnsSearch: [],
      dnsOptions: [],
      extraHosts: [],
    },
    routes: [],
    containerLabels: {},
    serviceLabels: {},
    podAnnotations: {},
    extension: {
      kind: kind === 'StatefulSet' ? 'statefulset' : null,
      publish: null,
      loadBalancerSourceRanges: [],
      probes: null,
      nodeSelector: {},
      tolerations: [],
      fsGroup: null,
      podLabels: {},
    },
    ...extra,
  };
}

function volume(key: string, name: string, extra: Partial<CanonicalVolume> = {}): CanonicalVolume {
  return {
    key,
    name,
    role: 'app',
    external: false,
    size: '1Gi',
    storageClass: 'dockflow-local',
    accessMode: 'ReadWriteOnce',
    perReplica: false,
    labels: {},
    usedBy: [],
    path: `volumes.${key}`,
    ...extra,
  };
}

const mount = (key: string): MountSpec => ({ type: 'volume', volume: key, target: `/data/${key}`, readOnly: false, subpath: null, path: 'x' });

function port(target: number, published: number | null, mode: 'ingress' | 'host'): PortSpec {
  return { target, published, protocol: 'TCP', mode, hostIp: null, name: null, appProtocol: null, path: 'x' };
}

function stack(services: CanonicalService[], volumes: CanonicalVolume[] = []): CanonicalStack {
  return {
    schema: 1,
    identity: { project: 'shop', env: 'production', stackName: 'shop-production', namespace: NS, version: '1.4.2' },
    role: 'app',
    services,
    volumes,
    files: [],
    middlewares: [],
    proxy: null,
  };
}

function live(kind: WorkloadKind, name: string, extra: Partial<LiveWorkload> = {}): LiveWorkload {
  return {
    kind,
    name,
    service: name,
    uid: `uid-${name}`,
    generation: 3,
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

const before = (...workloads: LiveWorkload[]): Snapshot => ({ takenAt: new Date(0), workloads, services: [] });

/**
 * One transition: the model of the new definition and its object, so every row runs with the
 * facts of deploy() and of apply().
 */
interface Row {
  model: CanonicalStack;
  object: ManifestObject;
}

function bothFacts(row: Row): [string, SwitchFacts][] {
  return [
    ['factsFromStack', factsFromStack(row.model)],
    ['factsFromObjects', factsFromObjects([row.object])],
  ];
}

function plan(row: Row, snapshot: Snapshot): KindSwitchPlan[] {
  return bothFacts(row).map(([, facts]) => planKindSwitches([row.object], snapshot, facts, REF));
}

function throws(row: Row, snapshot: Snapshot): DeployError[] {
  return bothFacts(row).map(([, facts]) => {
    try {
      planKindSwitches([row.object], snapshot, facts, REF);
    } catch (error) {
      if (error instanceof DeployError) return error;
      throw error;
    }
    throw new Error('planKindSwitches did not refuse');
  });
}

// the transitions of the design-03 5.4.3 table
const ROWS = {
  statefulSharedClaim: {
    model: stack([modelService('db', 'StatefulSet', { mounts: [mount('pgdata')] })], [volume('pgdata', 'pgdata')]),
    object: workloadObject('db', { kind: 'StatefulSet', claims: ['pgdata'] }),
  },
  statefulPerReplica: {
    model: stack([modelService('db', 'StatefulSet', { mounts: [mount('pgdata')] })], [volume('pgdata', 'pgdata', { perReplica: true })]),
    object: workloadObject('db', { kind: 'StatefulSet', templates: ['pgdata'] }),
  },
  statefulWithoutVolume: {
    model: stack([modelService('db', 'StatefulSet')]),
    object: workloadObject('db', { kind: 'StatefulSet' }),
  },
  globalHostPort: {
    model: stack([modelService('edge', 'DaemonSet', { ports: [port(80, 8080, 'host')] })]),
    object: workloadObject('edge', { kind: 'DaemonSet', hostPorts: [8080] }),
  },
  globalPublishHostport: {
    model: stack([
      modelService('edge', 'DaemonSet', {
        ports: [port(80, 8080, 'ingress')],
        extension: { ...modelService('edge', 'DaemonSet').extension, publish: 'hostport' },
      }),
    ]),
    object: workloadObject('edge', { kind: 'DaemonSet', hostPorts: [8080] }),
  },
  globalHostNetwork: {
    model: stack([modelService('probe', 'DaemonSet', { network: { ...modelService('probe', 'DaemonSet').network, hostNetwork: true } })]),
    object: workloadObject('probe', { kind: 'DaemonSet', hostNetwork: true }),
  },
  globalStateless: {
    model: stack([modelService('api', 'DaemonSet', { ports: [port(80, 8080, 'ingress')] })]),
    object: workloadObject('api', { kind: 'DaemonSet' }),
  },
  job: {
    model: stack([modelService('seed', 'Job')]),
    object: workloadObject('seed', { kind: 'Job' }, 'seed-3f9a1c2e'),
  },
  deploymentFromJob: {
    model: stack([modelService('seed', 'Deployment')]),
    object: workloadObject('seed', { kind: 'Deployment' }),
  },
  deploymentStateless: {
    model: stack([modelService('agent', 'Deployment')]),
    object: workloadObject('agent', { kind: 'Deployment' }),
  },
} satisfies Record<string, Row>;

describe('planKindSwitches (K15)', () => {
  it('Deployment -> StatefulSet sharing the RWO claim: replace', () => {
    for (const p of plan(ROWS.statefulSharedClaim, before(live('Deployment', 'db', { refs: { secrets: [], configMaps: [], claims: ['pgdata'], images: [] } })))) {
      expect(p).toEqual({
        replace: [{ kind: 'Deployment', name: 'db', service: 'db', to: { kind: 'StatefulSet', name: 'db' } }],
        overlap: [],
      });
    }
  });

  it('shared -> per-replica on the same key: no 5.4.3 refusal (left to the claim-shape rule), and replace', () => {
    const snapshot = before(live('Deployment', 'db', { refs: { secrets: [], configMaps: [], claims: ['pgdata'], images: [] } }));
    for (const p of plan(ROWS.statefulPerReplica, snapshot)) {
      expect(p.replace.map((r) => `${r.kind}/${r.name}`)).toEqual(['Deployment/db']);
    }
  });

  it('Deployment -> StatefulSet that no longer mounts the volume: refused, naming the claim', () => {
    const snapshot = before(live('Deployment', 'db', { refs: { secrets: [], configMaps: [], claims: ['pgdata'], images: [] } }));
    for (const error of throws(ROWS.statefulWithoutVolume, snapshot)) {
      expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
      expect(error.message).toBe(
        'Service db changes from Deployment to StatefulSet and would stop using volume pgdata, whose data is kept but no longer mounted',
      );
      expect(error.suggestion).toBe(
        'Keep the volume in the new definition, or move the data and remove it with `dockflow volumes rm production pgdata`.',
      );
    }
  });

  it('a claim template of the old StatefulSet counts as a mounted claim too', () => {
    const snapshot = before(
      live('StatefulSet', 'db', {
        claimTemplates: [{ name: 'pgdata', volumeKey: 'pgdata', storageClassName: 'dockflow-local', accessModes: ['ReadWriteOnce'], storage: '1Gi' }],
      }),
    );
    const row = { model: stack([modelService('db', 'Deployment')]), object: workloadObject('db', { kind: 'Deployment' }) };
    for (const error of throws(row, snapshot)) expect(error.message).toContain('would stop using volume pgdata');
  });

  it('Deployment -> DaemonSet with a host-mode port, `publish: hostport` or `network_mode: host`: replace each', () => {
    for (const [row, service] of [
      [ROWS.globalHostPort, 'edge'],
      [ROWS.globalPublishHostport, 'edge'],
      [ROWS.globalHostNetwork, 'probe'],
    ] as const) {
      for (const p of plan(row, before(live('Deployment', service)))) {
        expect(p.replace).toEqual([{ kind: 'Deployment', name: service, service, to: { kind: 'DaemonSet', name: service } }]);
        expect(p.overlap).toEqual([]);
      }
    }
  });

  it('U-APPLY-08: Deployment -> DaemonSet with nothing exclusive: overlap, nothing deleted first', () => {
    for (const p of plan(ROWS.globalStateless, before(live('Deployment', 'api')))) {
      expect(p).toEqual({ replace: [], overlap: [{ service: 'api', from: 'Deployment', to: 'DaemonSet' }] });
    }
  });

  it('DaemonSet -> Deployment with nothing exclusive: overlap', () => {
    for (const p of plan(ROWS.deploymentStateless, before(live('DaemonSet', 'agent')))) {
      expect(p.overlap).toEqual([{ service: 'agent', from: 'DaemonSet', to: 'Deployment' }]);
    }
  });

  it('Deployment -> Job: replace', () => {
    for (const p of plan(ROWS.job, before(live('Deployment', 'seed')))) {
      expect(p.replace).toEqual([{ kind: 'Deployment', name: 'seed', service: 'seed', to: { kind: 'Job', name: 'seed-3f9a1c2e' } }]);
    }
  });

  it('completed (or failed) Job -> Deployment: replace', () => {
    for (const finished of ['complete', 'failed'] as const) {
      const snapshot = before(live('Job', 'seed-00000000', { service: 'seed', job: { finished, active: 0 } }));
      for (const p of plan(ROWS.deploymentFromJob, snapshot)) {
        expect(p.replace).toEqual([{ kind: 'Job', name: 'seed-00000000', service: 'seed', to: { kind: 'Deployment', name: 'seed' } }]);
      }
    }
  });

  it('active Job -> anything: refused', () => {
    const snapshot = before(live('Job', 'seed-00000000', { service: 'seed', job: { finished: null, active: 1 } }));
    for (const error of throws(ROWS.deploymentFromJob, snapshot)) {
      expect(error.message).toBe('Service seed changes from Job to Deployment while its job is still running');
      expect(error.suggestion).toBe('Wait for it to finish (`dockflow ps production`), then deploy again.');
    }
  });

  it('Job -> Job under another name is not a switch; a service without a live workload neither', () => {
    const snapshot = before(live('Job', 'seed-00000000', { service: 'seed', job: { finished: 'complete', active: 0 } }));
    for (const p of plan(ROWS.job, snapshot)) expect(p).toEqual({ replace: [], overlap: [] });
    for (const p of plan(ROWS.statefulSharedClaim, before())) expect(p).toEqual({ replace: [], overlap: [] });
  });

  it('describeSwitches records replacements and re-run Jobs for the receipt', () => {
    const switches: KindSwitchPlan = {
      replace: [{ kind: 'Deployment', name: 'db', service: 'db', to: { kind: 'StatefulSet', name: 'db' } }],
      overlap: [{ service: 'api', from: 'Deployment', to: 'DaemonSet' }],
    };
    expect(describeSwitches(switches, [{ kind: 'Job', name: 'migrate-3f9a1c2e', service: 'migrate' }])).toEqual([
      { service: 'db', from: 'Deployment', to: 'StatefulSet', deleted: { kind: 'Deployment', name: 'db' } },
      { service: 'migrate', from: null, to: 'Job', deleted: { kind: 'Job', name: 'migrate-3f9a1c2e' } },
    ]);
  });
});

describe('SwitchFacts builders', () => {
  it('factsFromStack and factsFromObjects agree on every service shape', () => {
    const rows: Row[] = [
      ...Object.values(ROWS),
      {
        model: stack(
          [modelService('files', 'Deployment', { mounts: [mount('ext'), mount('ext')] })],
          [volume('ext', 'shared-uploads', { external: true })],
        ),
        object: workloadObject('files', { kind: 'Deployment', claims: ['shared-uploads'] }),
      },
      {
        model: stack([modelService('web', 'Deployment', { ports: [port(3000, 8080, 'ingress'), port(9000, null, 'host')] })]),
        object: workloadObject('web', { kind: 'Deployment' }),
      },
    ];
    for (const row of rows) {
      const service = row.model.services[0].composeName;
      const [[, a], [, b]] = bothFacts(row);
      expect({ service, bases: a.claimBases(service), exclusive: a.exclusive(service) }).toEqual({
        service,
        bases: b.claimBases(service),
        exclusive: b.exclusive(service),
      });
    }
  });

  it('an unknown service has no claim and nothing exclusive', () => {
    for (const [, facts] of bothFacts(ROWS.statefulSharedClaim)) {
      expect(facts.claimBases('ghost')).toEqual([]);
      expect(facts.exclusive('ghost')).toBe(false);
    }
  });
});

describe('foreign ownership (K74)', () => {
  const managed = (...managers: string[]): ManagedFieldsEntry[] => managers.map((manager) => ({ manager, operation: 'Apply' }));
  const liveService = (name: string, labels: Record<string, string>, managedFields: ManagedFieldsEntry[]): Service => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: NS, labels, managedFields },
    spec: {},
  });
  const renderedService = (name: string): Service => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: NS, annotations: { [`${P}/compose-service`]: name } },
    spec: {},
  });

  it('SD34: a Helm-managed Service is foreign and refused with the manager and the service', () => {
    const found = foreignObjects(
      [renderedService('web')],
      [liveService('web', { 'app.kubernetes.io/managed-by': 'Helm' }, managed('helm'))],
    );
    expect(found).toEqual([{ kind: 'Service', name: 'web', manager: 'helm', claimant: 'service web' }]);
    const error = foreignOwnerError(found[0], NS);
    expect(error.message).toBe('Service web in namespace dockflow-shop-production is owned by helm and would be taken over by service web');
    expect(error.suggestion).toBe(
      'Rename the service, or move the Helm release that creates it to its own namespace with `helm.releases[].namespace`.',
    );
    expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
  });

  it('classifies by label and by field managers', () => {
    const meta = (labels: Record<string, string>, ...managers: string[]) => ({ name: 'x', labels, managedFields: managed(...managers) });
    const dockflow = { 'app.kubernetes.io/managed-by': 'dockflow' };
    expect(classifyOwnership(meta({ 'app.kubernetes.io/managed-by': 'Helm' }))).toEqual({ foreign: true, manager: 'Helm' });
    expect(classifyOwnership(meta({}, 'kubectl-edit'))).toEqual({ foreign: true, manager: 'kubectl-edit' });
    // Dockflow owns it: whatever else wrote to it, it is not foreign
    expect(classifyOwnership(meta(dockflow, 'dockflow', 'kube-controller-manager', 'kubectl-edit'))).toEqual({ foreign: false });
    expect(classifyOwnership(meta(dockflow, 'dockflow-release-state'))).toEqual({ foreign: false });
    expect(classifyOwnership(meta({}, 'kubectl-rollout', 'kubectl-client-side-apply'))).toEqual({ foreign: false });
    expect(classifyOwnership({ name: 'x' })).toEqual({ foreign: false });
  });

  it('ignores objects that do not exist and names a volume claimant for a PVC', () => {
    const claim: ManifestObject = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'pg-data', namespace: NS, annotations: { [`${P}/compose-volume`]: 'pg_data' } },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
    };
    const found = foreignObjects(
      [renderedService('api'), claim],
      [{ kind: 'PersistentVolumeClaim', metadata: { name: 'pg-data', managedFields: managed('operator') } }],
    );
    expect(found).toEqual([{ kind: 'PersistentVolumeClaim', name: 'pg-data', manager: 'operator', claimant: 'volume pg_data' }]);
  });
});
