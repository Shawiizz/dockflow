import { describe, expect, test } from 'bun:test';
import { CONVERGENCE_TIMEOUT_S } from '../../../constants';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import {
  ANNOTATIONS,
  K8S_PROGRESS_DEADLINE_S,
  MAX_MIN_READY_S,
  progressDeadlineFor,
} from '../../../services/orchestrator/kubernetes/constants';
import {
  podTemplateLabels,
  selectorLabels,
  serviceObjectLabels,
  volumeClaimLabels,
} from '../../../services/orchestrator/kubernetes/labels';
import type {
  CanonicalService,
  CanonicalVolume,
  PortSpec,
  VolumeMountSpec,
} from '../../../services/orchestrator/kubernetes/model/types';
import { headlessServiceName, jobNameFor } from '../../../services/orchestrator/kubernetes/naming';
import type { PersistentVolumeClaimTemplate } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Container, ContainerPort, Service, VolumeMount } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ClaimTemplates, PodTemplate } from '../../../services/orchestrator/kubernetes/translate/context';
import { isTranslatorCode } from '../../../services/orchestrator/kubernetes/translate/diagnostics';
import {
  amount,
  buildWorkload,
  exclusiveHostPorts,
  JOB_DEFAULT_BACKOFF_LIMIT,
  jobBackoffLimit,
  rwoMounts,
  type Workload,
} from '../../../services/orchestrator/kubernetes/translate/workloads';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import {
  canonicalService,
  canonicalStack,
  canonicalVolume,
  DEFAULT_SERVER_NAMES,
  identity,
  type ServiceOverrides,
  type TranslateOptionsOverrides,
  translateContext,
} from '../support/builders';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';

const ID = identity();
const NS = 'dockflow-shop-production';
const P = 'dockflow.shawiizz.dev';

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function volumeMount(volume: string, target = '/data', readOnly = false, index = 0): VolumeMountSpec {
  return { type: 'volume', volume, target, readOnly, subpath: null, path: `services.web.volumes[${index}]` };
}

function port(published: number | null, target = 80, mode: PortSpec['mode'] = 'ingress', index = 0): PortSpec {
  return { target, published, protocol: 'TCP', mode, hostIp: null, name: null, appProtocol: null, path: `services.web.ports[${index}]` };
}

// ---------------------------------------------------------------------------
// Inputs the other translate modules would build (pod.ts, storage.ts, services.ts)
// ---------------------------------------------------------------------------

/** A valid pod template consistent with the model: node ports, host network and claim mounts. */
function podTemplate(svc: CanonicalService, volumes: readonly CanonicalVolume[]): PodTemplate {
  const byKey = new Map(volumes.map((v) => [v.key, v]));
  const mounted = [...new Set(svc.mounts.flatMap((m) => (m.type === 'volume' ? [m.volume] : [])))]
    .map((key) => byKey.get(key))
    .filter((v): v is CanonicalVolume => v !== undefined);
  const shared = mounted.filter((v) => !v.perReplica).map((v) => v.name);
  const perReplica = mounted.filter((v) => v.perReplica).map((v) => v.name);
  const mounts: VolumeMount[] = [...shared, ...perReplica].map((name, i) => ({ name, mountPath: `/mnt/${i}` }));
  const hostPort = svc.ports.find((p) => p.published !== null && (p.mode === 'host' || svc.extension.publish === 'hostport'));
  const ports: ContainerPort[] = svc.network.hostNetwork
    ? [{ name: 'tcp-80', containerPort: 80, hostPort: 80, protocol: 'TCP' }]
    : hostPort !== undefined && hostPort.published !== null
      ? [{ name: `tcp-${hostPort.target}`, containerPort: hostPort.target, hostPort: hostPort.published, protocol: 'TCP' }]
      : [];
  const container: Container = {
    name: svc.name,
    image: 'nginx:1.27',
    imagePullPolicy: 'IfNotPresent',
    ...(ports.length > 0 ? { ports } : {}),
    ...(mounts.length > 0 ? { volumeMounts: mounts } : {}),
  };
  return {
    metadata: {
      labels: podTemplateLabels(ID, svc.role, svc.name),
      annotations: { [ANNOTATIONS.composeService]: svc.composeName, [ANNOTATIONS.defaultContainer]: svc.name },
    },
    spec: {
      automountServiceAccountToken: false,
      containers: [container],
      enableServiceLinks: false,
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      terminationGracePeriodSeconds: 10,
      ...(svc.network.hostNetwork ? { hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet' as const } : {}),
      ...(shared.length > 0 ? { volumes: shared.map((name) => ({ name, persistentVolumeClaim: { claimName: name } })) } : {}),
    },
  };
}

function claimTemplate(volume: CanonicalVolume): PersistentVolumeClaimTemplate {
  return {
    metadata: {
      name: volume.name,
      labels: volumeClaimLabels(ID, volume.role, volume.name, volume.labels),
      annotations: { [ANNOTATIONS.composeVolume]: volume.key },
    },
    spec: {
      accessModes: [volume.accessMode],
      resources: { requests: { storage: volume.size } },
      storageClassName: volume.storageClass,
    },
  };
}

function claimTemplatesFor(svc: CanonicalService, volumes: readonly CanonicalVolume[]): ClaimTemplates {
  if (svc.workloadKind !== 'StatefulSet') return [];
  const keys = new Set(svc.mounts.flatMap((m) => (m.type === 'volume' ? [m.volume] : [])));
  return volumes.filter((v) => v.perReplica && keys.has(v.key)).map(claimTemplate);
}

function governingService(svc: CanonicalService): Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: headlessServiceName(svc.name),
      namespace: NS,
      labels: serviceObjectLabels(ID, svc.role, svc.name),
      annotations: { [ANNOTATIONS.composeService]: svc.composeName },
    },
    spec: { clusterIP: 'None', selector: selectorLabels(ID, svc.name) },
  };
}

interface Case {
  svc: CanonicalService;
  volumes?: CanonicalVolume[];
  options?: TranslateOptionsOverrides;
  claimTemplates?: ClaimTemplates;
  template?: PodTemplate;
}

interface Result {
  workload: Workload | null;
  template: PodTemplate;
  diagnostics: Diagnostic[];
}

function translate(c: Case): Result {
  const volumes = c.volumes ?? [];
  const template = c.template ?? podTemplate(c.svc, volumes);
  const ctx = translateContext(canonicalStack({ role: c.svc.role, services: [c.svc], volumes }), c.options);
  const workload = buildWorkload(c.svc, template, c.claimTemplates ?? claimTemplatesFor(c.svc, volumes), ctx);
  return { workload, template, diagnostics: ctx.sink.list() };
}

function service(overrides: ServiceOverrides = {}): CanonicalService {
  return canonicalService(overrides);
}

/** Structural and semantic validation of the workload plus what it references (PD-11 (e)). */
function expectValid(workload: Workload | null, svc: CanonicalService, volumes: readonly CanonicalVolume[] = []): void {
  expect(workload).not.toBeNull();
  const objects: unknown[] = [workload, ...(workload?.kind === 'StatefulSet' ? [governingService(svc)] : [])];
  const issues = failures(
    validateArtifact(objects, {
      namespace: NS,
      externalNames: volumes.map((v) => v.name),
      serverNames: [...DEFAULT_SERVER_NAMES],
    }),
  );
  expect(formatIssues(issues)).toBe('');
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.severity} ${d.code} ${d.path}`);
}

function valid(c: Case): Workload {
  const result = translate(c);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expectValid(result.workload, c.svc, c.volumes);
  return result.workload as Workload;
}

function deployment(workload: Workload | null) {
  if (workload?.kind !== 'Deployment') throw new Error(`expected a Deployment, got ${workload?.kind}`);
  return workload;
}

function statefulSet(workload: Workload | null) {
  if (workload?.kind !== 'StatefulSet') throw new Error(`expected a StatefulSet, got ${workload?.kind}`);
  return workload;
}

function daemonSet(workload: Workload | null) {
  if (workload?.kind !== 'DaemonSet') throw new Error(`expected a DaemonSet, got ${workload?.kind}`);
  return workload;
}

function job(workload: Workload | null) {
  if (workload?.kind !== 'Job') throw new Error(`expected a Job, got ${workload?.kind}`);
  return workload;
}

function bug(run: () => unknown): DeployError {
  let caught: unknown;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kind selection (design-02 3)', () => {
  const rows: { title: string; overrides: ServiceOverrides; kind: Workload['kind'] }[] = [
    { title: 'replicated, no x-dockflow.kind', overrides: {}, kind: 'Deployment' },
    { title: 'replicated, kind deployment', overrides: { extension: { kind: 'deployment' } }, kind: 'Deployment' },
    { title: 'replicated, kind statefulset', overrides: { extension: { kind: 'statefulset' } }, kind: 'StatefulSet' },
    { title: 'global', overrides: { mode: 'global' }, kind: 'DaemonSet' },
    { title: 'replicated-job', overrides: { mode: 'replicated-job' }, kind: 'Job' },
  ];
  for (const row of rows) {
    test(`${row.title} -> ${row.kind}`, () => {
      const svc = service(row.overrides);
      const workload = valid({ svc });
      expect(workload.kind).toBe(row.kind);
      expect(workload.apiVersion).toBe(row.kind === 'Job' ? 'batch/v1' : 'apps/v1');
    });
  }

  test('the kind comes from workloadKind, never re-derived from mode', () => {
    const svc = service({ mode: 'replicated', workloadKind: 'StatefulSet' });
    expect(translate({ svc }).workload?.kind).toBe('StatefulSet');
  });
});

describe('Deployment (design-02 4.1)', () => {
  test('reference output', () => {
    const svc = service({ replicas: 2 });
    const { workload, template, diagnostics } = translate({ svc, options: { revisionHistoryLimit: 10 } });
    expect(workload).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web',
        namespace: NS,
        annotations: { [`${P}/compose-service`]: 'web' },
        labels: {
          'app.kubernetes.io/instance': NS,
          'app.kubernetes.io/managed-by': 'dockflow',
          'app.kubernetes.io/name': 'web',
          'app.kubernetes.io/part-of': 'shop',
          [`${P}/part`]: 'stack',
          [`${P}/role`]: 'app',
          [`${P}/service`]: 'web',
          [`${P}/stack`]: NS,
        },
      },
      spec: {
        minReadySeconds: 30,
        progressDeadlineSeconds: 240,
        replicas: 2,
        revisionHistoryLimit: 10,
        selector: { matchLabels: { [`${P}/service`]: 'web', [`${P}/stack`]: NS } },
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        template,
      },
    });
    expect(diagnostics).toEqual([]);
    expectValid(workload, svc);
  });

  test('names come from the sanitized service name, the compose key stays on the annotation', () => {
    const svc = service({ composeName: 'web_app', name: 'web-app' });
    const workload = valid({ svc });
    expect(workload.metadata.name).toBe('web-app');
    expect(workload.metadata.annotations?.[ANNOTATIONS.composeService]).toBe('web_app');
    expect(workload.metadata.labels?.[`${P}/service`]).toBe('web-app');
    expect(deployment(workload).spec.selector).toEqual({ matchLabels: selectorLabels(ID, 'web-app') });
  });

  test('replicas 0 is emitted', () => {
    expect(deployment(valid({ svc: service({ replicas: 0 }) })).spec.replicas).toBe(0);
  });

  test('compose deploy.labels become workload annotations; Dockflow keys win', () => {
    const svc = service({
      serviceLabels: { 'com.example.team': 'payments', [ANNOTATIONS.composeService]: 'spoofed' },
    });
    const workload = translate({ svc }).workload;
    expect(workload?.metadata.annotations).toEqual({
      'com.example.team': 'payments',
      [ANNOTATIONS.composeService]: 'web',
    });
    expect(workload?.metadata.labels?.['com.example.team']).toBeUndefined();
  });

  test('the pod template is passed through without the release version and is never mutated', () => {
    const svc = service();
    const template = podTemplate(svc, []);
    const before = structuredClone(template);
    const workload = deployment(translate({ svc, template }).workload);
    expect(template).toEqual(before);
    expect(workload.spec.template).toEqual(template);
    expect(workload.spec.template.metadata.annotations?.[ANNOTATIONS.release]).toBeUndefined();
  });
});

describe('release version (emission rule 9)', () => {
  const kinds: ServiceOverrides[] = [{}, { extension: { kind: 'statefulset' } }, { mode: 'global' }, { mode: 'replicated-job' }];

  // A Deployment's generation moves on any annotation change: a workload that differs by version
  // would be reported changed, and waited for, on every deploy.
  for (const overrides of kinds) {
    for (const role of ['app', 'accessory'] as const) {
      test(`${overrides.mode ?? overrides.extension?.kind ?? 'deployment'} (${role}): renders identically whatever the release version`, () => {
        const svc = service({ ...overrides, role });
        const render = (version: string) => {
          const ctx = translateContext(canonicalStack({ role, identity: { version }, services: [svc] }));
          return canonicalJson(buildWorkload(svc, podTemplate(svc, []), [], ctx));
        };
        expect(render('2.0.0')).toBe(render('1.4.2'));
      });
    }
  }

  test('an app Job keeps its name across releases: the version is not part of its spec', () => {
    const svc = service({ mode: 'replicated-job', composeName: 'migrate' });
    const nameFor = (version: string) => {
      const ctx = translateContext(canonicalStack({ identity: { version }, services: [svc] }));
      return job(buildWorkload(svc, podTemplate(svc, []), [], ctx)).metadata.name;
    };
    expect(nameFor('2.0.0')).toBe(nameFor('1.4.2'));
  });
});

describe('strategy mapping (design-02 4.2)', () => {
  const data = canonicalVolume({ key: 'data' });

  test('amount(0) is "100%", any other parallelism is itself', () => {
    expect(amount(0)).toBe('100%');
    expect(amount(1)).toBe(1);
    expect(amount(4)).toBe(4);
  });

  test('RWO volume, replicas 1: Recreate with update.strategy-recreate', () => {
    const svc = service({ mounts: [volumeMount('data')] });
    const result = translate({ svc, volumes: [data] });
    expect(deployment(result.workload).spec.strategy).toEqual({ type: 'Recreate' });
    expect(codes(result.diagnostics)).toEqual(['info update.strategy-recreate services.web.deploy.update_config']);
    expect(result.diagnostics[0].message).toBe('Service web is updated with Recreate because it mounts volume data (ReadWriteOnce)');
    expectValid(result.workload, svc, [data]);
  });

  test('Recreate keeps minReadySeconds and progressDeadlineSeconds', () => {
    const svc = service({ mounts: [volumeMount('data')], update: { monitorMs: 90_000 } });
    const spec = deployment(translate({ svc, volumes: [data] }).workload).spec;
    expect(spec.minReadySeconds).toBe(90);
    expect(spec.progressDeadlineSeconds).toBe(240);
    expect(spec.strategy).toEqual({ type: 'Recreate' });
  });

  test('RWO volume, replicas 0: Recreate, no error', () => {
    const svc = service({ replicas: 0, mounts: [volumeMount('data')] });
    const result = translate({ svc, volumes: [data] });
    expect(deployment(result.workload).spec.strategy).toEqual({ type: 'Recreate' });
    expect(result.diagnostics.map((d) => d.severity)).toEqual(['info']);
  });

  test('RWO volume, replicas 3: Recreate and volumes.rwo-replicas', () => {
    const svc = service({ replicas: 3, mounts: [volumeMount('data')] });
    const result = translate({ svc, volumes: [data] });
    expect(deployment(result.workload).spec.strategy).toEqual({ type: 'Recreate' });
    expect(codes(result.diagnostics)).toEqual([
      'error volumes.rwo-replicas services.web.deploy.replicas',
      'info update.strategy-recreate services.web.deploy.update_config',
    ]);
    const error = result.diagnostics[0];
    expect(error.message).toBe('Service web mounts volume data (ReadWriteOnce) and cannot run 3 replicas');
    expect(error.hint).toBe(
      'Set `deploy.replicas: 1`, or set `x-dockflow.kind: statefulset` and `volumes.data.x-dockflow.per_replica: true`.',
    );
  });

  test('RWOP volume, replicas 2: volumes.rwo-replicas', () => {
    const rwop = canonicalVolume({ key: 'data', accessMode: 'ReadWriteOncePod' });
    const result = translate({ svc: service({ replicas: 2, mounts: [volumeMount('data')] }), volumes: [rwop] });
    expect(result.diagnostics.find((d) => d.code === 'volumes.rwo-replicas')?.message).toBe(
      'Service web mounts volume data (ReadWriteOncePod) and cannot run 2 replicas',
    );
  });

  test('an external RWO claim behaves like a generated one', () => {
    const external = canonicalVolume({ key: 'pgdata', name: 'shared-pgdata', external: true });
    const one = translate({ svc: service({ mounts: [volumeMount('pgdata')] }), volumes: [external] });
    expect(deployment(one.workload).spec.strategy).toEqual({ type: 'Recreate' });
    expectValid(one.workload, service({ mounts: [volumeMount('pgdata')] }), [external]);
    const two = translate({ svc: service({ replicas: 2, mounts: [volumeMount('pgdata')] }), volumes: [external] });
    expect(codes(two.diagnostics)).toContain('error volumes.rwo-replicas services.web.deploy.replicas');
  });

  test('a read-only mount of an RWO volume still selects Recreate (D8 is literal)', () => {
    const svc = service({ mounts: [volumeMount('data', '/data', true)] });
    expect(deployment(translate({ svc, volumes: [data] }).workload).spec.strategy).toEqual({ type: 'Recreate' });
  });

  test('RWX volume, replicas 2: rolling update, no diagnostic', () => {
    const rwx = canonicalVolume({ key: 'data', accessMode: 'ReadWriteMany' });
    const svc = service({ replicas: 2, mounts: [volumeMount('data')] });
    const result = translate({ svc, volumes: [rwx] });
    expect(deployment(result.workload).spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
    expect(result.diagnostics).toEqual([]);
    expect(rwoMounts(svc, translateContext(canonicalStack({ services: [svc], volumes: [rwx] })))).toEqual([]);
  });

  const rolling: { title: string; update: ServiceOverrides['update']; expected: { maxSurge: number | string; maxUnavailable: number | string } }[] = [
    { title: 'start-first, parallelism 2', update: { order: 'start-first', parallelism: 2 }, expected: { maxSurge: 2, maxUnavailable: 0 } },
    { title: 'start-first, parallelism 0', update: { order: 'start-first', parallelism: 0 }, expected: { maxSurge: '100%', maxUnavailable: 0 } },
    { title: 'stop-first, parallelism 2', update: { order: 'stop-first', parallelism: 2 }, expected: { maxSurge: 0, maxUnavailable: 2 } },
    { title: 'stop-first, parallelism 0', update: { order: 'stop-first', parallelism: 0 }, expected: { maxSurge: 0, maxUnavailable: '100%' } },
  ];
  for (const row of rolling) {
    test(`${row.title} -> ${JSON.stringify(row.expected)}`, () => {
      const svc = service({ replicas: 3, update: row.update });
      const workload = deployment(valid({ svc }));
      expect(workload.spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: row.expected });
    });
  }

  const exclusive: { title: string; overrides: ServiceOverrides }[] = [
    { title: 'a host-mode port', overrides: { ports: [port(8080, 80, 'host')] } },
    { title: 'publish: hostport', overrides: { ports: [port(8080)], extension: { publish: 'hostport' } } },
    { title: 'the node network', overrides: { network: { hostNetwork: true } } },
  ];
  for (const row of exclusive) {
    test(`start-first with ${row.title}: stop-first and update.surge-disabled`, () => {
      const svc = service({ ...row.overrides, update: { parallelism: 2 } });
      expect(exclusiveHostPorts(svc)).toBe(true);
      const result = translate({ svc });
      expect(deployment(result.workload).spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 2 } });
      // start-first is role app's injected default, hence info
      expect(codes(result.diagnostics)).toEqual(['info update.surge-disabled services.web.deploy.update_config.order']);
      expect(result.diagnostics[0].message).toBe('Service web binds node ports, so replicas are replaced stop-first (brief downtime per replica)');
      expectValid(result.workload, svc);
    });
  }

  test('update.surge-disabled is a warning when start-first was not the injected default', () => {
    const svc = service({ role: 'accessory', ports: [port(5432, 5432, 'host')], update: { order: 'start-first' } });
    const result = translate({ svc });
    expect(codes(result.diagnostics)).toEqual(['warning update.surge-disabled services.web.deploy.update_config.order']);
    expect(deployment(result.workload).spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } });
  });

  test('stop-first with node ports needs no diagnostic', () => {
    const svc = service({ ports: [port(8080, 80, 'host')], update: { order: 'stop-first' } });
    expect(translate({ svc }).diagnostics).toEqual([]);
  });

  test('ports published through the load balancer, or not at all, keep start-first', () => {
    for (const overrides of [
      { ports: [port(8080)] },
      { ports: [port(8080)], extension: { publish: 'none' as const } },
      { ports: [port(null)], extension: { publish: 'hostport' as const } },
    ]) {
      const svc = service(overrides);
      expect(exclusiveHostPorts(svc)).toBe(false);
      const result = translate({ svc });
      expect(deployment(result.workload).spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } });
      expect(result.diagnostics).toEqual([]);
    }
  });

  test('an RWO volume with node ports is Recreate without update.surge-disabled', () => {
    const svc = service({ mounts: [volumeMount('data')], ports: [port(8080, 80, 'host')] });
    const result = translate({ svc, volumes: [data] });
    expect(deployment(result.workload).spec.strategy).toEqual({ type: 'Recreate' });
    expect(codes(result.diagnostics)).toEqual(['info update.strategy-recreate services.web.deploy.update_config']);
    expectValid(result.workload, svc, [data]);
  });

  test('accessory Docker defaults: stop-first, one at a time, minReadySeconds 5', () => {
    const svc = service({ role: 'accessory', composeName: 'db', replicas: 1 });
    const result = translate({ svc });
    const spec = deployment(result.workload).spec;
    expect(spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } });
    expect(spec.minReadySeconds).toBe(5);
    expect(spec.progressDeadlineSeconds).toBe(K8S_PROGRESS_DEADLINE_S);
    expect(result.diagnostics).toEqual([]);
    expectValid(result.workload, svc);
  });

  test('a mount of a volume the stack does not declare throws (T6)', () => {
    const error = bug(() => translate({ svc: service({ mounts: [volumeMount('ghost')] }) }));
    expect(error.message).toBe('Service web mounts volume ghost, which the stack does not declare');
  });
});

describe('rollout timing (PD-5)', () => {
  const rows: { monitorMs: number; minReady: number | undefined; deadline: number }[] = [
    { monitorMs: 0, minReady: undefined, deadline: 240 },
    { monitorMs: 1_500, minReady: 2, deadline: 240 },
    { monitorMs: 30_000, minReady: 30, deadline: 240 },
    { monitorMs: 90_000, minReady: 90, deadline: 240 },
    { monitorMs: 180_000, minReady: 180, deadline: 240 },
    { monitorMs: 181_000, minReady: 181, deadline: 241 },
    { monitorMs: 200_000, minReady: 200, deadline: 260 },
    { monitorMs: 209_001, minReady: 210, deadline: 270 },
    { monitorMs: 210_000, minReady: 210, deadline: 270 },
  ];
  for (const row of rows) {
    test(`monitor ${row.monitorMs} ms -> minReadySeconds ${row.minReady ?? 'absent'}, progressDeadlineSeconds ${row.deadline}`, () => {
      const svc = service({ update: { monitorMs: row.monitorMs } });
      const spec = deployment(valid({ svc })).spec;
      expect(spec.minReadySeconds).toBe(row.minReady as number);
      expect('minReadySeconds' in spec).toBe(row.minReady !== undefined);
      expect(spec.progressDeadlineSeconds).toBe(row.deadline);
      expect(spec.progressDeadlineSeconds).toBe(progressDeadlineFor(row.minReady ?? 0));
      expect(spec.progressDeadlineSeconds).toBeGreaterThan(row.minReady ?? 0);
      expect(spec.progressDeadlineSeconds).toBeLessThan(CONVERGENCE_TIMEOUT_S);
    });
  }

  test('the largest accepted monitor is MAX_MIN_READY_S (210 s)', () => {
    expect(MAX_MIN_READY_S).toBe(210);
  });

  const tooLong: ServiceOverrides[] = [{}, { extension: { kind: 'statefulset' } }, { mode: 'global' }];
  for (const overrides of tooLong) {
    const kind = overrides.mode ?? overrides.extension?.kind ?? 'deployment';
    test(`${kind}: 211 s and 5 min are update.monitor-too-long`, () => {
      for (const [monitorMs, seconds] of [
        [211_000, 211],
        [210_001, 211],
        [300_000, 300],
      ]) {
        const result = translate({ svc: service({ ...overrides, update: { monitorMs } }) });
        const errors = result.diagnostics.filter((d) => d.severity === 'error');
        expect(codes(errors)).toEqual(['error update.monitor-too-long services.web.deploy.update_config.monitor']);
        expect(errors[0].message).toBe(
          `update_config.monitor of service web is ${seconds}s, which leaves no time to observe a rollout inside the 300s convergence deadline`,
        );
        expect(errors[0].hint).toBe('Set `update_config.monitor` to at most 210s.');
      }
    });
  }

  test('a Job never reads update_config: no minReadySeconds and no monitor error', () => {
    const result = translate({ svc: service({ mode: 'replicated-job', update: { monitorMs: 600_000 } }) });
    expect(result.diagnostics).toEqual([]);
    expect('minReadySeconds' in job(result.workload).spec).toBe(false);
  });
});

describe('StatefulSet (design-02 4.3)', () => {
  const queueData = canonicalVolume({ key: 'queue_data', name: 'queue-data', perReplica: true, usedBy: ['queue'] });
  const logs = canonicalVolume({ key: 'logs', name: 'logs', perReplica: true, usedBy: ['queue'] });

  function queue(overrides: ServiceOverrides = {}): CanonicalService {
    return service({ composeName: 'queue', extension: { kind: 'statefulset' }, replicas: 3, ...overrides });
  }

  test('fields: Parallel, <svc>-hl, retention Retain/Retain, rolling update, sorted claim templates', () => {
    const svc = queue({ mounts: [volumeMount('queue_data', '/data'), volumeMount('logs', '/logs', false, 1)] });
    const templates = [claimTemplate(queueData), claimTemplate(logs)];
    const result = translate({ svc, volumes: [queueData, logs], claimTemplates: templates });
    const workload = statefulSet(result.workload);
    expect(workload.metadata.name).toBe('queue');
    expect(workload.spec).toEqual({
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      podManagementPolicy: 'Parallel',
      replicas: 3,
      revisionHistoryLimit: 3,
      minReadySeconds: 30,
      selector: { matchLabels: selectorLabels(ID, 'queue') },
      serviceName: 'queue-hl',
      template: result.template,
      updateStrategy: { type: 'RollingUpdate' },
      volumeClaimTemplates: [claimTemplate(logs), claimTemplate(queueData)],
    });
    expect(templates.map((t) => t.metadata.name)).toEqual(['queue-data', 'logs']);
    expectValid(workload, svc, []);
  });

  test('no claim template: no volumeClaimTemplates key', () => {
    const workload = statefulSet(valid({ svc: queue() }));
    expect('volumeClaimTemplates' in workload.spec).toBe(false);
  });

  test('update.statefulset-order is default-aware', () => {
    const app = translate({ svc: queue() });
    expect(codes(app.diagnostics)).toEqual(['info update.statefulset-order services.queue.deploy.update_config.order']);
    expect(app.diagnostics[0].message).toBe('Service queue is a StatefulSet; replicas are replaced one at a time, stop-first');
    expect(translate({ svc: queue({ update: { order: 'stop-first' } }) }).diagnostics).toEqual([]);
    expect(translate({ svc: queue({ role: 'accessory' }) }).diagnostics).toEqual([]);
    const written = translate({ svc: queue({ role: 'accessory', update: { order: 'start-first' } }) });
    expect(codes(written.diagnostics)).toEqual(['warning update.statefulset-order services.queue.deploy.update_config.order']);
  });

  test('a shared RWO volume with replicas > 1 is volumes.rwo-replicas; a per-replica one is not', () => {
    const shared = canonicalVolume({ key: 'config', usedBy: ['queue'] });
    const refused = translate({ svc: queue({ mounts: [volumeMount('config')] }), volumes: [shared] });
    expect(codes(refused.diagnostics)).toContain('error volumes.rwo-replicas services.queue.deploy.replicas');
    const accepted = translate({ svc: queue({ mounts: [volumeMount('queue_data')] }), volumes: [queueData] });
    expect(accepted.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expectValid(accepted.workload, queue({ mounts: [volumeMount('queue_data')] }), []);
  });

  test('podManagementPolicy, serviceName and selector are identical through every model change (K13)', () => {
    const base: ServiceOverrides = { composeName: 'queue' };
    const steps: ServiceOverrides[] = [
      { replicas: 1 },
      { replicas: 3 },
      { replicas: 0 },
      { ports: [port(8080)] },
      { expose: [{ target: 80, protocol: 'TCP', path: 'services.queue.expose[0]' }] },
      { network: { endpointMode: 'vip' } },
      { network: { endpointMode: 'dnsrr' } },
      { update: { order: 'start-first' } },
      { update: { order: 'stop-first', parallelism: 3 } },
    ];
    const immutable = (svc: CanonicalService): string => {
      const spec = statefulSet(translate({ svc }).workload).spec;
      return canonicalJson({ podManagementPolicy: spec.podManagementPolicy, serviceName: spec.serviceName, selector: spec.selector });
    };
    const expected = canonicalJson({
      podManagementPolicy: 'Parallel',
      serviceName: 'queue-hl',
      selector: { matchLabels: selectorLabels(ID, 'queue') },
    });
    for (const step of steps) {
      expect(immutable(service({ ...base, ...step, extension: { kind: 'statefulset' } }))).toBe(expected);
    }
    // Deployment -> StatefulSet switch: the same model with only the kind changed.
    const before = service({ ...base, replicas: 2, ports: [port(8080)] });
    expect(translate({ svc: before }).workload?.kind).toBe('Deployment');
    const after = canonicalService({ ...before, extension: { ...before.extension, kind: 'statefulset' }, workloadKind: 'StatefulSet' });
    expect(immutable(after)).toBe(expected);
  });

  test('claim templates that do not match the per-replica mounts throw (T6)', () => {
    const svc = queue({ mounts: [volumeMount('queue_data')] });
    const missing = bug(() => translate({ svc, volumes: [queueData], claimTemplates: [] }));
    expect(missing.message).toBe('StatefulSet queue received claim templates [] for its per-replica volumes [queue-data]');
    bug(() => translate({ svc, volumes: [queueData, logs], claimTemplates: [claimTemplate(logs)] }));
    bug(() => translate({ svc, volumes: [queueData], claimTemplates: [claimTemplate(queueData), claimTemplate(queueData)] }));
  });

  test('claim templates handed to another kind throw (T6)', () => {
    const svc = service({ mounts: [volumeMount('data')] });
    const error = bug(() => translate({ svc, volumes: [canonicalVolume()], claimTemplates: [claimTemplate(canonicalVolume())] }));
    expect(error.message).toBe('Deployment web received volume claim templates, which only a StatefulSet has');
  });
});

describe('DaemonSet (design-02 4.4)', () => {
  function daemon(overrides: ServiceOverrides = {}): CanonicalService {
    return service({ composeName: 'agent', mode: 'global', ...overrides });
  }

  test('fields: no replicas, no progressDeadlineSeconds, no strategy', () => {
    const svc = daemon();
    const workload = daemonSet(valid({ svc }));
    expect(workload.spec).toEqual({
      minReadySeconds: 30,
      revisionHistoryLimit: 3,
      selector: { matchLabels: selectorLabels(ID, 'agent') },
      template: workload.spec.template,
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
    });
  });

  test('exactly one of maxSurge and maxUnavailable is non-zero for every order, node-port and parallelism combination', () => {
    for (const order of ['start-first', 'stop-first'] as const) {
      for (const bindsNodePorts of [false, true]) {
        for (const parallelism of [0, 1, 3]) {
          const svc = daemon({ update: { order, parallelism }, ports: bindsNodePorts ? [port(8080, 80, 'host')] : [] });
          const result = translate({ svc });
          const rolling = daemonSet(result.workload).spec.updateStrategy?.rollingUpdate;
          const surges = order === 'start-first' && !bindsNodePorts;
          expect(rolling).toEqual(
            surges ? { maxSurge: amount(parallelism), maxUnavailable: 0 } : { maxSurge: 0, maxUnavailable: amount(parallelism) },
          );
          expect([rolling?.maxSurge, rolling?.maxUnavailable].filter((v) => v !== 0)).toHaveLength(1);
          const found = result.diagnostics.map((d) => d.code);
          expect(found.includes('update.surge-disabled')).toBe(order === 'start-first' && bindsNodePorts);
          expect(found.includes('update.global-all-at-once')).toBe(!surges && parallelism === 0);
          expectValid(result.workload, svc);
        }
      }
    }
  });

  test('parallelism 0 without surge: "100%" unavailable and update.global-all-at-once', () => {
    const result = translate({ svc: daemon({ update: { order: 'stop-first', parallelism: 0 } }) });
    expect(daemonSet(result.workload).spec.updateStrategy).toEqual({
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: 0, maxUnavailable: '100%' },
    });
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'update.global-all-at-once',
        path: 'services.agent.deploy.update_config.parallelism',
        message: 'Global service agent sets update_config.parallelism: 0, so every node loses it at the same time during an update',
        hint: 'Set `update_config.parallelism: 1` to replace it node by node.',
      },
    ]);
  });

  test('spread preferences and max_replicas_per_node are placement.global-ignored', () => {
    for (const placement of [{ spreadLabels: ['zone'] }, { maxReplicasPerNode: 1 }, { spreadLabels: ['zone'], maxReplicasPerNode: 2 }]) {
      const result = translate({ svc: daemon({ placement }) });
      expect(codes(result.diagnostics)).toEqual(['warning placement.global-ignored services.agent.deploy.placement']);
      expect(result.diagnostics[0].message).toBe('Spread preferences of global service agent are ignored');
    }
    expect(translate({ svc: daemon() }).diagnostics).toEqual([]);
  });

  test('replicas and RWO volumes are not a DaemonSet concern of this module', () => {
    const data = canonicalVolume({ key: 'data', usedBy: ['agent'] });
    const result = translate({ svc: daemon({ replicas: 5, mounts: [volumeMount('data')] }), volumes: [data] });
    expect('replicas' in daemonSet(result.workload).spec).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('restart policy (design-02 4.5)', () => {
  const longRunning: ServiceOverrides[] = [{}, { extension: { kind: 'statefulset' } }, { mode: 'global' }];

  for (const overrides of longRunning) {
    const kind = overrides.mode ?? overrides.extension?.kind ?? 'deployment';
    test(`${kind}: restartPolicy omitted for every condition`, () => {
      for (const condition of ['any', 'on-failure', 'none'] as const) {
        const workload = valid({ svc: service({ ...overrides, restart: { condition } }) });
        if (workload.kind === 'Job') throw new Error('unexpected Job');
        expect('restartPolicy' in workload.spec.template.spec).toBe(false);
      }
    });
  }

  test('a restartPolicy on the incoming template is dropped for long-running kinds', () => {
    const svc = service();
    const template = podTemplate(svc, []);
    template.spec.restartPolicy = 'Always';
    const workload = deployment(translate({ svc, template }).workload);
    expect('restartPolicy' in workload.spec.template.spec).toBe(false);
    expect(template.spec.restartPolicy).toBe('Always');
  });

  test('delay, max_attempts and window on a long-running kind: one deploy.restart-policy-unsupported each', () => {
    const svc = service({ restart: { condition: 'on-failure', delayMs: 5_000, maxAttempts: 3, windowMs: 60_000 } });
    const result = translate({ svc });
    expect(codes(result.diagnostics)).toEqual([
      'warning deploy.restart-policy-unsupported services.web.deploy.restart_policy.delay',
      'warning deploy.restart-policy-unsupported services.web.deploy.restart_policy.max_attempts',
      'warning deploy.restart-policy-unsupported services.web.deploy.restart_policy.window',
    ]);
    expect(result.diagnostics[1].message).toBe(
      'restart_policy.max_attempts of service web cannot be expressed; Kubernetes retries with exponential backoff',
    );
    expect(result.diagnostics[1].hint).toBeUndefined();
  });

  test('nothing written, nothing reported', () => {
    expect(translate({ svc: service({ restart: { condition: 'on-failure' } }) }).diagnostics).toEqual([]);
  });

  test('Job: restartPolicy Never for every condition', () => {
    for (const condition of ['any', 'on-failure', 'none'] as const) {
      const workload = job(valid({ svc: service({ mode: 'replicated-job', restart: { condition } }) }));
      expect(workload.spec.template.spec.restartPolicy).toBe('Never');
    }
  });

  test('Job: backoffLimit 0 for restart "no", max_attempts when written, 6 otherwise', () => {
    expect(jobBackoffLimit({ condition: 'none', delayMs: null, maxAttempts: 3, windowMs: null })).toBe(0);
    expect(jobBackoffLimit({ condition: 'on-failure', delayMs: null, maxAttempts: 3, windowMs: null })).toBe(3);
    expect(jobBackoffLimit({ condition: 'any', delayMs: null, maxAttempts: null, windowMs: null })).toBe(6);
    expect(JOB_DEFAULT_BACKOFF_LIMIT).toBe(6);
    const backoff = (restart: ServiceOverrides['restart']) =>
      job(valid({ svc: service({ mode: 'replicated-job', restart }) })).spec.backoffLimit;
    expect(backoff({ condition: 'none' })).toBe(0);
    expect(backoff({ condition: 'none', maxAttempts: 4 })).toBe(0);
    expect(backoff({ condition: 'on-failure', maxAttempts: 3 })).toBe(3);
    expect(backoff({ condition: 'on-failure' })).toBe(6);
    expect(backoff({ condition: 'any' })).toBe(6);
  });

  test('Job: max_attempts is expressed, delay and window still warn', () => {
    const result = translate({
      svc: service({ mode: 'replicated-job', restart: { condition: 'on-failure', delayMs: 5_000, maxAttempts: 3, windowMs: 60_000 } }),
    });
    expect(codes(result.diagnostics)).toEqual([
      'warning deploy.restart-policy-unsupported services.web.deploy.restart_policy.delay',
      'warning deploy.restart-policy-unsupported services.web.deploy.restart_policy.window',
    ]);
    expect(job(result.workload).spec.backoffLimit).toBe(3);
  });
});

describe('Job (design-02 4.6)', () => {
  function migrate(overrides: ServiceOverrides = {}): CanonicalService {
    return service({ composeName: 'migrate', mode: 'replicated-job', ...overrides });
  }

  test('fields and name from the checksum of the complete spec', () => {
    const svc = migrate({ replicas: 2, restart: { condition: 'on-failure', maxAttempts: 3 } });
    const result = translate({ svc });
    const workload = job(result.workload);
    expect(workload.spec).toEqual({
      backoffLimit: 3,
      completions: 2,
      parallelism: 2,
      template: { metadata: result.template.metadata, spec: { ...result.template.spec, restartPolicy: 'Never' } },
    });
    expect(workload.metadata.name).toBe(jobNameFor('migrate', sha256Hex(canonicalJson(workload.spec))));
    expect(workload.metadata.name).toMatch(/^migrate-[0-9a-f]{8}$/);
    expect(workload.metadata.annotations).toEqual({ [ANNOTATIONS.composeService]: 'migrate' });
    expect(workload.metadata.labels).toEqual(serviceObjectLabels(ID, 'app', 'migrate'));
    expect(result.diagnostics).toEqual([]);
    expectValid(workload, svc);
  });

  test('no selector, manualSelector, ttlSecondsAfterFinished or activeDeadlineSeconds; no controller-uid label', () => {
    const workload = job(valid({ svc: migrate() }));
    for (const field of ['selector', 'manualSelector', 'ttlSecondsAfterFinished', 'activeDeadlineSeconds']) {
      expect(field in workload.spec).toBe(false);
    }
    const labels = Object.keys(workload.spec.template.metadata.labels ?? {});
    expect(labels.some((key) => key.includes('controller-uid'))).toBe(false);
  });

  test('the checksum covers completions: two services identical except replicas get two names', () => {
    const one = job(translate({ svc: migrate({ replicas: 1 }) }).workload);
    const two = job(translate({ svc: migrate({ replicas: 2 }) }).workload);
    expect(one.metadata.name).not.toBe(two.metadata.name);
    expect(one.spec.template).toEqual(two.spec.template);
  });

  test('the checksum covers backoffLimit and the template; an identical spec keeps its name', () => {
    const name = (svc: CanonicalService, template?: PodTemplate) => job(translate({ svc, template }).workload).metadata.name;
    const base = name(migrate());
    expect(name(migrate())).toBe(base);
    expect(name(migrate({ restart: { condition: 'none' } }))).not.toBe(base);
    const other = podTemplate(migrate(), []);
    other.spec.terminationGracePeriodSeconds = 60;
    expect(name(migrate(), other)).not.toBe(base);
    // workload annotations are outside the spec
    expect(name(migrate({ serviceLabels: { 'com.example.team': 'data' } }))).toBe(base);
  });

  test('replicas 0: no Job, deploy.job-zero-replicas', () => {
    const result = translate({ svc: migrate({ replicas: 0 }) });
    expect(result.workload).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'deploy.job-zero-replicas',
        path: 'services.migrate.deploy.replicas',
        message: 'Job service migrate has 0 replicas and is not created',
      },
    ]);
  });

  test('parallel pods on a shared RWO volume are volumes.rwo-replicas', () => {
    const data = canonicalVolume({ key: 'data', usedBy: ['migrate'] });
    const result = translate({ svc: migrate({ replicas: 2, mounts: [volumeMount('data')] }), volumes: [data] });
    expect(codes(result.diagnostics)).toEqual(['error volumes.rwo-replicas services.migrate.deploy.replicas']);
    const single = translate({ svc: migrate({ mounts: [volumeMount('data')] }), volumes: [data] });
    expect(single.diagnostics).toEqual([]);
  });
});

describe('per-kind field sets (DESIGN-CORE 4.2 rule 8, K30)', () => {
  const expected: { overrides: ServiceOverrides; kind: Workload['kind']; fields: string[] }[] = [
    {
      overrides: {},
      kind: 'Deployment',
      fields: ['minReadySeconds', 'progressDeadlineSeconds', 'replicas', 'revisionHistoryLimit', 'selector', 'strategy', 'template'],
    },
    {
      overrides: { extension: { kind: 'statefulset' } },
      kind: 'StatefulSet',
      fields: [
        'minReadySeconds',
        'persistentVolumeClaimRetentionPolicy',
        'podManagementPolicy',
        'replicas',
        'revisionHistoryLimit',
        'selector',
        'serviceName',
        'template',
        'updateStrategy',
      ],
    },
    {
      overrides: { mode: 'global' },
      kind: 'DaemonSet',
      fields: ['minReadySeconds', 'revisionHistoryLimit', 'selector', 'template', 'updateStrategy'],
    },
    { overrides: { mode: 'replicated-job' }, kind: 'Job', fields: ['backoffLimit', 'completions', 'parallelism', 'template'] },
  ];

  for (const row of expected) {
    test(`${row.kind}: ${row.fields.join(', ')}`, () => {
      const workload = valid({ svc: service(row.overrides) });
      expect(workload.kind).toBe(row.kind);
      expect(Object.keys(workload.spec).sort()).toEqual(row.fields);
    });
    test(`${row.kind}: minReadySeconds only when above 0`, () => {
      const workload = valid({ svc: service({ ...row.overrides, update: { monitorMs: 0 } }) });
      expect('minReadySeconds' in workload.spec).toBe(false);
    });
  }
});

describe('determinism and catalogue', () => {
  test('the same input yields the same object; user map key order is irrelevant', () => {
    const labels = { 'com.example.b': '2', 'com.example.a': '1' };
    const reordered = { 'com.example.a': '1', 'com.example.b': '2' };
    const first = translate({ svc: service({ serviceLabels: labels, replicas: 2 }) }).workload;
    const second = translate({ svc: service({ serviceLabels: reordered, replicas: 2 }) }).workload;
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  test('every emitted code is in TRANSLATOR_CODES', () => {
    const data = canonicalVolume({ key: 'data' });
    const inputs: Case[] = [
      { svc: service({ replicas: 3, mounts: [volumeMount('data')] }), volumes: [data] },
      { svc: service({ ports: [port(8080, 80, 'host')], update: { monitorMs: 300_000 } }) },
      { svc: service({ extension: { kind: 'statefulset' } }) },
      { svc: service({ mode: 'global', update: { order: 'stop-first', parallelism: 0 }, placement: { spreadLabels: ['zone'] } }) },
      { svc: service({ mode: 'replicated-job', replicas: 0, restart: { condition: 'any', delayMs: 1_000, windowMs: null, maxAttempts: null } }) },
      { svc: service({ restart: { condition: 'any', delayMs: null, windowMs: null, maxAttempts: 2 } }) },
    ];
    const emitted = new Set(inputs.flatMap((c) => translate(c).diagnostics.map((d) => d.code)));
    expect([...emitted].sort()).toEqual([
      'deploy.job-zero-replicas',
      'deploy.restart-policy-unsupported',
      'placement.global-ignored',
      'update.global-all-at-once',
      'update.monitor-too-long',
      'update.statefulset-order',
      'update.strategy-recreate',
      'update.surge-disabled',
      'volumes.rwo-replicas',
    ]);
    for (const code of emitted) expect(isTranslatorCode(code)).toBe(true);
  });
});
