import { describe, expect, it } from 'bun:test';
import { formatPorts } from '../../../services/orchestrator/format';
import type { HelmReleaseStatus, StackRole } from '../../../services/orchestrator/interfaces';
import type { DaemonSet, Deployment, StatefulSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Container, ContainerStatus, Pod, Service, ServicePort } from '../../../services/orchestrator/kubernetes/resources/core';
import type { Condition } from '../../../services/orchestrator/kubernetes/resources/meta';
import {
  buildInventoryView,
  type HelmReleaseWorkloads,
  type InventoryObject,
  type InventoryView,
  type WorkloadRecord,
} from '../../../services/orchestrator/kubernetes/status/pods';
import {
  helmChartDisplay,
  podsByWorkload,
  rolloutFailing,
  servicePorts,
  toServiceInfos,
  workloadImage,
  workloadReplicas,
  workloadState,
} from '../../../services/orchestrator/kubernetes/status/services';
import { fixtureNamespace, loadKubectlResources } from '../support/kubectl-fixtures';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const INVENTORY_RESOURCES = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'pods',
  'services',
  'persistentvolumeclaims',
] as const;

function inventoryOf(scenario: string, capture = '', helm: HelmReleaseWorkloads[] = []): InventoryView {
  const list = loadKubectlResources<InventoryObject>(scenario, INVENTORY_RESOURCES, capture);
  return buildInventoryView(fixtureNamespace(scenario), list.items, helm);
}

function recordOf(inventory: InventoryView, service: string): WorkloadRecord {
  const record = inventory.composeWorkloads.get(service);
  if (!record) throw new Error(`no compose workload ${service}`);
  return record;
}

function podsOf(inventory: InventoryView, record: WorkloadRecord): Pod[] {
  return podsByWorkload(inventory.pods).get(`${record.object.kind}/${record.object.metadata.name}`) ?? [];
}

// ---------------------------------------------------------------------------
// Hand-built objects
// ---------------------------------------------------------------------------

function stackMeta(name: string, compose: string, role: StackRole = 'app') {
  return {
    name,
    namespace: NS,
    uid: `uid-${name}`,
    generation: 1,
    labels: {
      'app.kubernetes.io/managed-by': 'dockflow',
      [`${P}/part`]: 'stack',
      [`${P}/role`]: role,
      [`${P}/service`]: name,
    },
    annotations: { [`${P}/compose-service`]: compose },
  };
}

function chartMeta(name: string, release: string) {
  return {
    name,
    namespace: NS,
    uid: `uid-${name}`,
    generation: 1,
    labels: { 'app.kubernetes.io/managed-by': 'Helm', 'app.kubernetes.io/instance': release },
  };
}

function deployment(
  meta: Deployment['metadata'],
  containers: Container[],
  replicas: number | undefined,
  status: Deployment['status'],
  templateAnnotations?: Record<string, string>,
): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta,
    spec: {
      ...(replicas === undefined ? {} : { replicas }),
      selector: {},
      template: { metadata: templateAnnotations ? { annotations: templateAnnotations } : {}, spec: { containers } },
    },
    ...(status ? { status } : {}),
  };
}

function statefulSet(meta: StatefulSet['metadata'], replicas: number, status: StatefulSet['status']): StatefulSet {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta,
    spec: { replicas, selector: {}, template: { metadata: {}, spec: { containers: [{ name: meta.name, image: 'postgres:17' }] } } },
    ...(status ? { status } : {}),
  };
}

function service(name: string, owner: string, spec: Service['spec'], part = 'stack'): Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: NS, labels: { [`${P}/service`]: owner, [`${P}/part`]: part } },
    spec,
  };
}

function port(p: number, targetPort?: number | string, protocol: ServicePort['protocol'] = 'TCP', name?: string): ServicePort {
  return { port: p, protocol, ...(targetPort === undefined ? {} : { targetPort }), ...(name ? { name } : {}) };
}

function container(name: string, extra: Partial<ContainerStatus> = {}): ContainerStatus {
  return { name, ready: true, restartCount: 0, image: 'busybox:1.37', state: { running: {} }, ...extra };
}

function statefulSetPod(statefulSetName: string, ordinal: number, statuses: ContainerStatus[]): Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${statefulSetName}-${ordinal}`,
      namespace: NS,
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: statefulSetName, uid: `uid-${statefulSetName}`, controller: true }],
    },
    spec: { containers: statuses.map((s) => ({ name: s.name, image: s.image })) },
    status: { phase: 'Running', containerStatuses: statuses },
  };
}

const HEALTHY_DEPLOYMENT = { observedGeneration: 1, replicas: 2, updatedReplicas: 2, readyReplicas: 2 };

function inventory(items: InventoryObject[], helm: HelmReleaseWorkloads[] = []): InventoryView {
  return buildInventoryView(NS, items, helm);
}

function helmStatus(name: string, chart: string, role: StackRole | null = 'app'): HelmReleaseStatus {
  return { name, namespace: NS, role, revision: 4, status: 'deployed', chart, appVersion: '2.4.1', updated: null };
}

// ---------------------------------------------------------------------------

describe('workloadReplicas', () => {
  it('Deployment: missing readyReplicas counts 0, missing spec.replicas counts 1', () => {
    const crashloop = inventoryOf('crashloop');
    expect(workloadReplicas(recordOf(crashloop, 'web_app').object)).toEqual({ running: 0, desired: 1 });
    const defaulted = deployment(stackMeta('web', 'web'), [{ name: 'web', image: 'nginx:1.28' }], undefined, undefined);
    expect(workloadReplicas(defaulted)).toEqual({ running: 0, desired: 1 });
    expect(workloadReplicas(recordOf(inventoryOf('rollout-complete'), 'web').object)).toEqual({ running: 3, desired: 3 });
  });

  it('StatefulSet: readyReplicas over spec.replicas', () => {
    expect(workloadReplicas(recordOf(inventoryOf('statefulset-stuck'), 'db').object)).toEqual({ running: 1, desired: 2 });
  });

  it('DaemonSet: numberReady over desiredNumberScheduled', () => {
    expect(workloadReplicas(recordOf(inventoryOf('daemonset-rolling'), 'agent').object)).toEqual({ running: 2, desired: 2 });
    const empty: DaemonSet = {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: stackMeta('agent', 'agent'),
      spec: { selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'agent', image: 'busybox:1.37' }] } } },
    };
    expect(workloadReplicas(empty)).toEqual({ running: 0, desired: 0 });
  });

  it('Job: succeeded over completions', () => {
    expect(workloadReplicas(recordOf(inventoryOf('job-complete'), 'migrate').object)).toEqual({ running: 1, desired: 1 });
    expect(workloadReplicas(recordOf(inventoryOf('job-failed'), 'migrate').object)).toEqual({ running: 0, desired: 1 });
  });
});

describe('servicePorts', () => {
  it('ClusterIP -> cluster and the -lb LoadBalancer -> ingress (recorded)', () => {
    const inv = inventoryOf('rollout-complete');
    const ports = servicePorts(inv, recordOf(inv, 'web'));
    expect(ports).toEqual([
      { target: 80, published: null, protocol: 'tcp', mode: 'cluster' },
      { target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' },
    ]);
    expect(formatPorts(ports)).toBe('80/tcp, *:8080->80/tcp');
  });

  it('skips the headless placeholder port and a headless Service without ports', () => {
    const inv = inventoryOf('headless-no-ports');
    expect(servicePorts(inv, recordOf(inv, 'cache'))).toEqual([]);
    expect(servicePorts(inv, recordOf(inv, 'worker'))).toEqual([]);
  });

  it('resolves numeric and named targetPorts, maps hostPort, dedupes and sorts', () => {
    const api = deployment(
      stackMeta('api', 'api'),
      [
        {
          name: 'api',
          image: 'registry.example.com/shop/api:1.4.2',
          ports: [
            { name: 'http', containerPort: 8080, protocol: 'TCP' },
            { name: 'pg', containerPort: 5432, protocol: 'TCP' },
            { name: 'dns', containerPort: 53, protocol: 'UDP', hostPort: 53 },
          ],
        },
      ],
      2,
      HEALTHY_DEPLOYMENT,
    );
    const inv = inventory([
      api,
      service('api', 'api', { type: 'ClusterIP', ports: [port(5432, 'pg'), port(9000, 'http'), port(7000, 'missing')] }),
      service('api-hl', 'api', { clusterIP: 'None', ports: [port(5432)] }),
      service('api-lb', 'api', { type: 'LoadBalancer', ports: [port(8080, 8080), port(8080, '8080')] }),
      service('other', 'other', { ports: [port(1234)] }),
      service('api-foreign', 'api', { ports: [port(4444)] }, 'system'),
    ]);
    expect(servicePorts(inv, recordOf(inv, 'api'))).toEqual([
      { target: 53, published: 53, protocol: 'udp', mode: 'host' },
      { target: 5432, published: null, protocol: 'tcp', mode: 'cluster' },
      { target: 8080, published: null, protocol: 'tcp', mode: 'cluster' },
      { target: 8080, published: 8080, protocol: 'tcp', mode: 'ingress' },
    ]);
  });

  it('prints as `*:8080->80/tcp, 5432/tcp` through formatPorts', () => {
    const db = deployment(
      stackMeta('web', 'web'),
      [
        {
          name: 'web',
          image: 'nginx:1.28',
          ports: [
            { containerPort: 80, protocol: 'TCP' },
            { containerPort: 5432, protocol: 'TCP' },
          ],
        },
      ],
      1,
      HEALTHY_DEPLOYMENT,
    );
    const inv = inventory([
      db,
      service('web', 'web', { ports: [port(5432)] }),
      service('web-lb', 'web', { type: 'LoadBalancer', ports: [port(8080, 80)] }),
    ]);
    expect(formatPorts(servicePorts(inv, recordOf(inv, 'web')))).toBe('*:8080->80/tcp, 5432/tcp');
  });
});

describe('workloadState', () => {
  const stateOf = (scenario: string, service: string, capture = '') => {
    const inv = inventoryOf(scenario, capture);
    const record = recordOf(inv, service);
    return workloadState(record.object, podsOf(inv, record));
  };

  it('desired 0 -> stopped', () => {
    const stopped = deployment(stackMeta('web', 'web'), [{ name: 'web', image: 'nginx:1.28' }], 0, { observedGeneration: 1 });
    expect(workloadState(stopped, [])).toBe('stopped');
  });

  it('every replica ready on the newest template -> running', () => {
    expect(stateOf('rollout-complete', 'web')).toBe('running');
    expect(stateOf('metrics-top', 'db')).toBe('running');
    expect(stateOf('daemonset-rolling', 'agent', 'completed')).toBe('running');
    expect(stateOf('job-complete', 'migrate')).toBe('running');
  });

  it('a pod of severity error -> degraded', () => {
    expect(stateOf('crashloop', 'web_app')).toBe('degraded');
    expect(stateOf('statefulset-stuck', 'db')).toBe('degraded');
    expect(stateOf('job-failed', 'migrate')).toBe('degraded');
  });

  it('Progressing=False or ReplicaFailure=True -> degraded', () => {
    const inv = inventoryOf('progress-deadline-exceeded');
    const record = recordOf(inv, 'web');
    expect(podsOf(inv, record).map((p) => p.status?.phase)).toEqual(['Running']);
    expect(rolloutFailing(record.object)).toBe(true);
    expect(workloadState(record.object, podsOf(inv, record))).toBe('degraded');
    expect(stateOf('replica-failure-quota', 'web')).toBe('degraded');
    expect(rolloutFailing(recordOf(inventoryOf('rollout-complete'), 'web').object)).toBe(false);
  });

  it('old pods remaining -> converging', () => {
    expect(stateOf('rollout-progressing', 'web')).toBe('converging');
    expect(stateOf('daemonset-rolling', 'agent')).toBe('converging');
  });

  it('a generation not yet observed -> converging although every replica is ready', () => {
    const meta = { ...stackMeta('web', 'web'), generation: 3 };
    const pending = deployment(meta, [{ name: 'web', image: 'nginx:1.28' }], 2, { ...HEALTHY_DEPLOYMENT, observedGeneration: 2 });
    expect(workloadState(pending, [])).toBe('converging');
  });

  it('an evicted pod left behind by its replacement does not degrade the service', () => {
    expect(stateOf('evicted-pod', 'web')).toBe('running');
  });

  it('a Job that completed after a failed attempt is running', () => {
    const inv = inventoryOf('job-complete');
    const record = recordOf(inv, 'migrate');
    const failedAttempt: Pod = { ...podsOf(inv, record)[0], status: { phase: 'Failed', reason: 'Error' } };
    expect(workloadState(record.object, [...podsOf(inv, record), failedAttempt])).toBe('running');
  });
});

describe('images', () => {
  it('strips the imported-image registry', () => {
    const inv = inventoryOf('err-image-never-pull');
    expect(workloadImage(recordOf(inv, 'web'))).toBe('shop-web:1.4.2');
    expect(workloadImage(recordOf(inventoryOf('rollout-complete'), 'web'))).toBe('nginx:1.28-alpine');
  });

  it('takes the container a command would target', () => {
    const multi = inventoryOf('multi-container');
    expect(workloadImage(recordOf(multi, 'api'))).toBe('nginx:1.27-alpine');
    const sidecarFirst = deployment(
      stackMeta('web', 'web'),
      [
        { name: 'proxy', image: 'envoy:1.33' },
        { name: 'web', image: 'dockflow.invalid/shop-web:1.4.2' },
      ],
      1,
      HEALTHY_DEPLOYMENT,
    );
    expect(workloadImage({ object: sidecarFirst, serviceName: 'web' })).toBe('shop-web:1.4.2');
  });

  it('shows a Helm chart as `chart <name>@<version>`', () => {
    expect(helmChartDisplay('search-2.4.1')).toBe('chart search@2.4.1');
    expect(helmChartDisplay('search-api-v1.0.0-rc.1')).toBe('chart search-api@v1.0.0-rc.1');
    expect(helmChartDisplay('local')).toBe('chart local');
  });
});

describe('toServiceInfos', () => {
  it('maps every compose workload kind (U-STATUS-SVC-01)', () => {
    expect(toServiceInfos(inventoryOf('rollout-complete'), 'app', [])).toEqual([
      {
        name: 'web',
        nativeName: 'web',
        kind: 'service',
        role: 'app',
        mode: 'replicated',
        image: 'nginx:1.28-alpine',
        replicas: { running: 3, desired: 3 },
        ports: [
          { target: 80, published: null, protocol: 'tcp', mode: 'cluster' },
          { target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' },
        ],
        state: 'running',
      },
    ]);
    expect(toServiceInfos(inventoryOf('statefulset-stuck'), 'accessory', [])).toMatchObject([
      { name: 'db', nativeName: 'db', mode: 'replicated', role: 'accessory', replicas: { running: 1, desired: 2 }, state: 'degraded' },
    ]);
    expect(toServiceInfos(inventoryOf('daemonset-rolling'), 'app', [])).toMatchObject([
      { name: 'agent', mode: 'global', replicas: { running: 2, desired: 2 }, state: 'converging' },
    ]);
    // the Job object name carries its template checksum; the native name is the service's
    expect(toServiceInfos(inventoryOf('job-complete'), 'app', [])).toMatchObject([
      { name: 'migrate', nativeName: 'migrate', mode: 'job', replicas: { running: 1, desired: 1 }, state: 'running', ports: [] },
    ]);
  });

  it('names a service after its compose key when the Kubernetes name is sanitized', () => {
    expect(toServiceInfos(inventoryOf('crashloop'), 'app', [])).toMatchObject([
      { name: 'web_app', nativeName: 'web-app', kind: 'service', state: 'degraded', replicas: { running: 0, desired: 1 } },
    ]);
  });

  it('filters rows by role', () => {
    const inv = inventoryOf('metrics-top');
    expect(toServiceInfos(inv, 'app', []).map((s) => s.name)).toEqual(['web']);
    expect(toServiceInfos(inv, 'accessory', []).map((s) => s.name)).toEqual(['db']);
  });

  it('ignores workloads that are not Dockflow stack objects', () => {
    const chart = deployment(chartMeta('chart-web', 'search'), [{ name: 'web', image: 'nginx:1.28' }], 1, HEALTHY_DEPLOYMENT);
    const helper = deployment(
      { ...stackMeta('helper', 'helper'), labels: { ...stackMeta('helper', 'helper').labels, [`${P}/part`]: 'helper' } },
      [{ name: 'helper', image: 'busybox:1.37' }],
      1,
      HEALTHY_DEPLOYMENT,
    );
    const web = deployment(stackMeta('web', 'web'), [{ name: 'web', image: 'nginx:1.28' }], 2, HEALTHY_DEPLOYMENT);
    expect(toServiceInfos(inventory([chart, helper, web]), 'app', []).map((s) => s.name)).toEqual(['web']);
  });

  it('sums Helm release workloads, takes the role from the release label and sorts compose rows first (U-STATUS-SVC-02)', () => {
    const api = deployment(chartMeta('search-api', 'search'), [{ name: 'api', image: 'search:2.4.1' }], 2, HEALTHY_DEPLOYMENT);
    const index = statefulSet(chartMeta('search-index', 'search'), 1, { observedGeneration: 1, replicas: 1 });
    const crashing = statefulSetPod('search-index', 0, [
      container('index', { ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }),
    ]);
    const zeta = deployment(stackMeta('zeta', 'zeta'), [{ name: 'zeta', image: 'zeta:1' }], 2, HEALTHY_DEPLOYMENT);
    const alpha = deployment(stackMeta('alpha', 'alpha'), [{ name: 'alpha', image: 'alpha:1' }], 2, HEALTHY_DEPLOYMENT);
    const cacheChart = deployment(chartMeta('cache', 'cache'), [{ name: 'cache', image: 'redis:8' }], 1, {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
    });
    const releases: HelmReleaseWorkloads[] = [
      {
        release: 'search',
        role: 'app',
        namespace: NS,
        workloads: [
          { kind: 'Deployment', name: 'search-api' },
          { kind: 'StatefulSet', name: 'search-index' },
        ],
      },
      { release: 'cache', role: 'app', namespace: NS, workloads: [{ kind: 'Deployment', name: 'cache' }] },
      { release: 'orphan', role: null, namespace: NS, workloads: [] },
    ];
    const inv = inventory([api, index, crashing, zeta, alpha, cacheChart], releases);
    const rows = toServiceInfos(inv, 'app', [helmStatus('search', 'search-2.4.1'), helmStatus('cache', 'cache-8.0.0'), helmStatus('orphan', 'orphan-1.0.0', null)]);
    expect(rows.map((r) => [r.name, r.kind])).toEqual([
      ['alpha', 'service'],
      ['zeta', 'service'],
      ['cache', 'helm'],
      ['search', 'helm'],
    ]);
    expect(rows[3]).toEqual({
      name: 'search',
      nativeName: 'search',
      kind: 'helm',
      role: 'app',
      mode: 'replicated',
      image: 'chart search@2.4.1',
      replicas: { running: 2, desired: 3 },
      ports: [],
      state: 'degraded',
    });
    expect(rows[2]).toMatchObject({ image: 'chart cache@8.0.0', replicas: { running: 1, desired: 1 }, state: 'running' });
    expect(toServiceInfos(inv, 'accessory', [])).toEqual([]);
  });

  it('takes an accessory release role from its label and skips releases without one', () => {
    const db = deployment(chartMeta('pg', 'pg'), [{ name: 'pg', image: 'postgres:17' }], 1, HEALTHY_DEPLOYMENT);
    const releases: HelmReleaseWorkloads[] = [
      { release: 'pg', role: 'accessory', namespace: NS, workloads: [{ kind: 'Deployment', name: 'pg' }] },
      { release: 'unlabelled', role: null, namespace: NS, workloads: [{ kind: 'Deployment', name: 'pg' }] },
    ];
    const inv = inventory([db], releases);
    expect(toServiceInfos(inv, 'accessory', []).map((r) => [r.name, r.role, r.image])).toEqual([['pg', 'accessory', 'chart unknown']]);
    expect(toServiceInfos(inv, 'app', [])).toEqual([]);
  });

  it('a chart Deployment past its progress deadline degrades its release', () => {
    const conditions: Condition[] = [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }];
    const stuck = deployment(chartMeta('search-api', 'search'), [{ name: 'api', image: 'search:2.4.1' }], 1, {
      observedGeneration: 1,
      conditions,
    });
    const inv = inventory([stuck], [{ release: 'search', role: 'app', namespace: NS, workloads: [{ kind: 'Deployment', name: 'search-api' }] }]);
    expect(toServiceInfos(inv, 'app', [helmStatus('search', 'search-2.4.1')])).toMatchObject([{ name: 'search', kind: 'helm', state: 'degraded' }]);
  });
});
