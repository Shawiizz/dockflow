import { describe, expect, it } from 'bun:test';
import type { PodTemplateSpec } from '../../services/orchestrator/kubernetes/resources/core';
import {
  isManifestKind,
  KIND_REGISTRY,
  type KindInfo,
  type ManifestKind,
  type ManifestObject,
} from '../../services/orchestrator/kubernetes/resources/registry';

const NS = 'dockflow-shop-production';

/** The DESIGN-CORE 4.1 table, row for row. */
const EXPECTED: typeof KIND_REGISTRY = {
  Secret: { apiVersion: 'v1', kind: 'Secret', resource: 'secrets', namespaced: true, rank: 10, prune: 'prune-hashed' },
  ConfigMap: { apiVersion: 'v1', kind: 'ConfigMap', resource: 'configmaps', namespaced: true, rank: 20, prune: 'prune-hashed' },
  PersistentVolumeClaim: {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    resource: 'persistentvolumeclaims',
    namespaced: true,
    rank: 30,
    prune: 'never',
  },
  Service: { apiVersion: 'v1', kind: 'Service', resource: 'services', namespaced: true, rank: 40, prune: 'prune' },
  Deployment: { apiVersion: 'apps/v1', kind: 'Deployment', resource: 'deployments.apps', namespaced: true, rank: 50, prune: 'prune' },
  StatefulSet: { apiVersion: 'apps/v1', kind: 'StatefulSet', resource: 'statefulsets.apps', namespaced: true, rank: 51, prune: 'prune' },
  DaemonSet: { apiVersion: 'apps/v1', kind: 'DaemonSet', resource: 'daemonsets.apps', namespaced: true, rank: 52, prune: 'prune' },
  Job: { apiVersion: 'batch/v1', kind: 'Job', resource: 'jobs.batch', namespaced: true, rank: 53, prune: 'prune' },
  Middleware: {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    resource: 'middlewares.traefik.io',
    namespaced: true,
    rank: 60,
    prune: 'prune',
  },
  IngressRoute: {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    resource: 'ingressroutes.traefik.io',
    namespaced: true,
    rank: 61,
    prune: 'prune',
  },
};

const selector = { matchLabels: { 'dockflow.shawiizz.dev/service': 'web', 'dockflow.shawiizz.dev/stack': NS } };

const template: PodTemplateSpec = {
  metadata: { labels: { ...selector.matchLabels, 'dockflow.shawiizz.dev/role': 'app' } },
  spec: {
    automountServiceAccountToken: false,
    containers: [
      {
        name: 'web',
        envFrom: [{ secretRef: { name: 'web-env-3f9a1c2e' } }],
        image: 'dockflow.invalid/shop-web-production:1.4.2',
        imagePullPolicy: 'IfNotPresent',
        ports: [{ name: 'tcp-3000', containerPort: 3000, protocol: 'TCP' }],
      },
    ],
    enableServiceLinks: false,
    securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
    terminationGracePeriodSeconds: 10,
  },
};

/** One object per artifact kind, shaped like design-02's reference outputs. */
const SAMPLES: ManifestObject[] = [
  {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'web-env-3f9a1c2e', namespace: NS },
    data: { DATABASE_URL: 'cG9zdGdyZXM6Ly9kYjo1NDMyL3Nob3A=' },
    immutable: true,
  },
  {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'nginx-conf-config-1a2b3c4d', namespace: NS },
    data: { nginx_conf: 'server { listen 80; }\n' },
    immutable: true,
  },
  {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'postgres-data', namespace: NS },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
  },
  {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'web-lb', namespace: NS },
    spec: {
      type: 'LoadBalancer',
      allocateLoadBalancerNodePorts: false,
      ports: [{ name: 'tcp-3000', port: 8080, protocol: 'TCP', targetPort: 3000 }],
      selector: selector.matchLabels,
    },
  },
  {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: NS },
    spec: {
      minReadySeconds: 30,
      progressDeadlineSeconds: 240,
      replicas: 2,
      revisionHistoryLimit: 10,
      selector,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template,
    },
  },
  {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: 'queue', namespace: NS },
    spec: {
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      podManagementPolicy: 'Parallel',
      replicas: 3,
      revisionHistoryLimit: 10,
      selector,
      serviceName: 'queue-hl',
      template,
      updateStrategy: { type: 'RollingUpdate' },
      volumeClaimTemplates: [
        {
          metadata: { name: 'queue-data', annotations: { 'dockflow.shawiizz.dev/compose-volume': 'queue_data' } },
          spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } }, storageClassName: 'dockflow-local' },
        },
      ],
    },
  },
  {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: 'agent', namespace: NS },
    spec: {
      minReadySeconds: 30,
      revisionHistoryLimit: 10,
      selector,
      template,
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: '100%' } },
    },
  },
  {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'migrate-0c1d2e3f', namespace: NS },
    spec: {
      backoffLimit: 3,
      completions: 1,
      parallelism: 1,
      template: { ...template, spec: { ...template.spec, restartPolicy: 'Never' } },
    },
  },
  {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: { name: 'strip-api', namespace: NS },
    spec: { stripPrefix: { prefixes: ['/api'] }, basicAuth: { secret: 'strip-api-auth-secret-0a1b2c3d', realm: 'shop' } },
  },
  {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: { name: 'web--3f9a1c2e', namespace: NS },
    spec: {
      entryPoints: ['websecure'],
      routes: [
        {
          kind: 'Rule',
          match: 'Host(`shop.example.com`)',
          middlewares: [{ name: 'strip-api' }],
          services: [{ name: 'web', port: 3000 }],
        },
      ],
      tls: { certResolver: 'letsencrypt' },
    },
  },
];

describe('U-REG-01 KIND_REGISTRY', () => {
  it('equals the DESIGN-CORE 4.1 table', () => {
    expect(KIND_REGISTRY).toEqual(EXPECTED);
  });

  it('satisfies the core signature Record<ManifestKind, KindInfo>', () => {
    const asCoreType: Record<ManifestKind, KindInfo> = KIND_REGISTRY;
    expect(Object.keys(asCoreType)).toHaveLength(10);
  });

  it('keys each entry by its own kind', () => {
    for (const [key, info] of Object.entries(KIND_REGISTRY)) {
      expect(info.kind).toBe(key as ManifestKind);
      expect(info.namespaced).toBe(true);
    }
  });

  it('has unique ranks', () => {
    const ranks = Object.values(KIND_REGISTRY).map((info) => info.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('never prunes claims, and keeps content-hashed kinds behind the reference check', () => {
    expect(KIND_REGISTRY.PersistentVolumeClaim.prune).toBe('never');
    expect(KIND_REGISTRY.Secret.prune).toBe('prune-hashed');
    expect(KIND_REGISTRY.ConfigMap.prune).toBe('prune-hashed');
  });

  it('registers every ManifestObject kind with the apiVersion its interface declares', () => {
    const sampleKinds = SAMPLES.map((object) => object.kind).sort();
    expect(sampleKinds).toEqual((Object.keys(KIND_REGISTRY) as ManifestKind[]).sort());
    for (const object of SAMPLES) {
      expect(KIND_REGISTRY[object.kind].apiVersion).toBe(object.apiVersion);
    }
  });

  it('isManifestKind accepts registered kinds only', () => {
    for (const kind of Object.keys(EXPECTED)) expect(isManifestKind(kind)).toBe(true);
    for (const kind of ['Namespace', 'Pod', 'Lease', 'StorageClass', 'List', 'secret', 'toString', 'constructor', '']) {
      expect(isManifestKind(kind)).toBe(false);
    }
  });
});
