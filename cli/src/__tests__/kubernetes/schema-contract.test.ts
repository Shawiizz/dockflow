// Validator self-tests (design-07 7.5, design-02 14.6, PD-11 (e)): a known-good artifact passes,
// and one mutation per structural keyword and per semantic rule fails with that rule's id.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ANNOTATIONS, KUBE_KEYS, LABELS } from '../../services/orchestrator/kubernetes/constants';
import type { DaemonSet, Deployment, StatefulSet } from '../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../services/orchestrator/kubernetes/resources/batch';
import type { Lease } from '../../services/orchestrator/kubernetes/resources/coordination';
import type {
  ClusterRoleBinding,
  ConfigMap,
  Container,
  Namespace,
  PersistentVolume,
  PersistentVolumeClaim,
  Pod,
  PodSpec,
  Probe,
  Secret,
  Service,
  ServiceAccount,
  TopologySpreadConstraint,
} from '../../services/orchestrator/kubernetes/resources/core';
import type { TemplateMetadata } from '../../services/orchestrator/kubernetes/resources/meta';
import { KIND_REGISTRY, type ManifestObject } from '../../services/orchestrator/kubernetes/resources/registry';
import type { StorageClass } from '../../services/orchestrator/kubernetes/resources/storage';
import type { IngressRoute, Middleware } from '../../services/orchestrator/kubernetes/resources/traefik';
import {
  failures,
  formatIssues,
  SEMANTIC_RULE_IDS,
  type SemanticContext,
  type SemanticIssue,
  validateArtifact,
  validateSemantics,
} from './support/schema/semantic';
import { canonicalQuantity, formatIssue, REF_PREFIX, type SchemaNode, schemaBundles, validateObject } from './support/schema/validate';

type Json = Record<string, unknown>;
type Role = 'app' | 'accessory';

const NS = 'dockflow-shop-production';
const RELEASE = '1.4.2';
const CONTEXT: SemanticContext = {
  namespace: NS,
  externalNames: ['shared-media', 'accessory-headers'],
  serverNames: ['manager', 'Worker_2'],
  strictMiddlewares: true,
};

// ---------------------------------------------------------------------------------------------
// Known-good artifact: every translator feature the rules look at, in translator output shape

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const sha8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);

function stackLabels(role: Role = 'app'): Record<string, string> {
  return {
    [LABELS.instance]: NS,
    [LABELS.managedBy]: 'dockflow',
    [LABELS.partOf]: 'shop',
    [LABELS.part]: 'stack',
    [LABELS.role]: role,
    [LABELS.stack]: NS,
  };
}

function serviceLabels(service: string): Record<string, string> {
  return { ...stackLabels(), [LABELS.name]: service, [LABELS.service]: service };
}

function selectorLabels(service: string): Record<string, string> {
  return { [LABELS.service]: service, [LABELS.stack]: NS };
}

function workloadMeta(name: string, service: string) {
  return {
    name,
    namespace: NS,
    annotations: { [ANNOTATIONS.composeService]: service, [ANNOTATIONS.release]: RELEASE },
    labels: serviceLabels(service),
  };
}

function templateMeta(service: string): TemplateMetadata {
  return {
    annotations: { [ANNOTATIONS.composeService]: service, [ANNOTATIONS.defaultContainer]: service },
    labels: { ...selectorLabels(service), [LABELS.instance]: NS, [LABELS.name]: service, [LABELS.role]: 'app' },
  };
}

function podSpec(containers: Container[], extra: Partial<PodSpec> = {}): PodSpec {
  return {
    automountServiceAccountToken: false,
    containers,
    enableServiceLinks: false,
    securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
    terminationGracePeriodSeconds: 10,
    ...extra,
  };
}

function probe(handler: Pick<Probe, 'exec' | 'httpGet' | 'tcpSocket'>, overrides: Partial<Probe> = {}): Probe {
  return { ...handler, failureThreshold: 5, initialDelaySeconds: 0, periodSeconds: 10, successThreshold: 1, timeoutSeconds: 3, ...overrides };
}

function hostnameSpread(service: string, deployment: boolean): TopologySpreadConstraint {
  return {
    labelSelector: { matchLabels: selectorLabels(service) },
    ...(deployment ? { matchLabelKeys: ['pod-template-hash'] } : {}),
    maxSkew: 1,
    topologyKey: KUBE_KEYS.hostname,
    whenUnsatisfiable: 'ScheduleAnyway',
  };
}

function clusterService(name: string, service: string, ports: Service['spec']['ports'], headless = false): Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: NS, annotations: { [ANNOTATIONS.composeService]: service }, labels: serviceLabels(service) },
    spec: { ...(headless ? { clusterIP: 'None' } : {}), ports, selector: selectorLabels(service) },
  };
}

function envSecret(service: string, environment: Record<string, string>): Secret {
  const variables = Object.keys(environment)
    .sort()
    .map((name) => ({ name, value: environment[name] }));
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: `${service}-env-${sha8(JSON.stringify(variables))}`, namespace: NS, labels: { ...serviceLabels(service), [LABELS.hashed]: 'true' } },
    data: Object.fromEntries(variables.map(({ name, value }) => [name, b64(value)])),
    immutable: true,
  };
}

function fileSecret(base: string, key: string, content: string): Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: `${base}-secret-${sha8(content)}`, namespace: NS, labels: { ...stackLabels(), [LABELS.hashed]: 'true' } },
    data: { [key]: b64(content) },
    immutable: true,
  };
}

function fileConfigMap(base: string, key: string, content: string): ConfigMap {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: `${base}-config-${sha8(content)}`, namespace: NS, labels: { ...stackLabels(), [LABELS.hashed]: 'true' } },
    data: { [key]: content },
    immutable: true,
  };
}

function middleware(name: string, spec: Middleware['spec']): Middleware {
  return { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name, namespace: NS, labels: stackLabels() }, spec };
}

function kitchenSinkObjects(): ManifestObject[] {
  const env = envSecret('web', { DATABASE_URL: 'postgres://db:5432/shop', LOG_LEVEL: 'info' });
  const apiKey = fileSecret('api-key', 'api_key', 's3cret-value');
  const nginx = fileConfigMap('nginx-conf', 'nginx_conf', 'server { listen 80; }\n');
  const auth = fileSecret('auth-auth', 'users', 'admin:$apr1$Qx1$hash\n');
  const claim: PersistentVolumeClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: 'postgres-data',
      namespace: NS,
      annotations: { [ANNOTATIONS.composeVolume]: 'postgres_data' },
      labels: { ...stackLabels(), [LABELS.volume]: 'postgres-data' },
    },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'dockflow-local' },
  };
  const web: Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: workloadMeta('web', 'web'),
    spec: {
      minReadySeconds: 30,
      progressDeadlineSeconds: 240,
      replicas: 2,
      revisionHistoryLimit: 10,
      selector: { matchLabels: selectorLabels('web') },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template: {
        metadata: templateMeta('web'),
        spec: podSpec(
          [
            {
              name: 'web',
              envFrom: [{ secretRef: { name: env.metadata.name } }],
              image: `dockflow.invalid/shop-web-production:${RELEASE}`,
              imagePullPolicy: 'IfNotPresent',
              livenessProbe: probe({ httpGet: { path: '/health', port: 3000 } }),
              ports: [{ name: 'tcp-3000', containerPort: 3000, protocol: 'TCP' }],
              readinessProbe: probe({ httpGet: { path: '/health', port: 3000 } }),
              resources: { limits: { cpu: '500m', memory: '512Mi' }, requests: { cpu: '250m', memory: '256Mi' } },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true },
              startupProbe: probe({ httpGet: { path: '/health', port: 3000 } }, { failureThreshold: 18, periodSeconds: 5 }),
              volumeMounts: [
                { name: 'config-nginx-conf-444', mountPath: '/etc/nginx/nginx.conf', readOnly: true, subPath: 'nginx_conf' },
                { name: 'host-5d41402a', mountPath: '/etc/shop', readOnly: true, recursiveReadOnly: 'IfPossible' },
                { name: 'secret-api-key-444', mountPath: '/run/secrets/api_key', readOnly: true, subPath: 'api_key' },
                { name: 'tmpfs-7c9e2b1a', mountPath: '/tmp/cache' },
              ],
            },
          ],
          {
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms: [{ matchExpressions: [{ key: KUBE_KEYS.hostname, operator: 'NotIn', values: ['worker-2'] }] }],
                },
              },
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  { labelSelector: { matchLabels: selectorLabels('web') }, matchLabelKeys: ['pod-template-hash'], topologyKey: KUBE_KEYS.hostname },
                ],
              },
            },
            dnsConfig: { nameservers: ['1.1.1.1'], options: [{ name: 'ndots', value: '2' }], searches: ['corp.example'] },
            hostAliases: [{ ip: '10.0.0.20', hostnames: ['db.internal', 'registry.internal'] }],
            imagePullSecrets: [{ name: 'dockflow-registry' }],
            nodeSelector: { [KUBE_KEYS.arch]: 'amd64' },
            securityContext: { seccompProfile: { type: 'RuntimeDefault' }, sysctls: [{ name: 'net.ipv4.tcp_syncookies', value: '1' }] },
            tolerations: [{ effect: 'NoExecute', key: 'dedicated', value: 'web', tolerationSeconds: 30 }],
            topologySpreadConstraints: [hostnameSpread('web', true)],
            volumes: [
              { name: 'config-nginx-conf-444', configMap: { name: nginx.metadata.name, defaultMode: 292, items: [{ key: 'nginx_conf', path: 'nginx_conf' }] } },
              { name: 'host-5d41402a', hostPath: { path: '/srv/shop/config' } },
              { name: 'secret-api-key-444', secret: { secretName: apiKey.metadata.name, defaultMode: 292, items: [{ key: 'api_key', path: 'api_key' }] } },
              { name: 'tmpfs-7c9e2b1a', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
            ],
          },
        ),
      },
    },
  };
  const db: Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: workloadMeta('db', 'db'),
    spec: {
      progressDeadlineSeconds: 240,
      replicas: 1,
      revisionHistoryLimit: 10,
      selector: { matchLabels: selectorLabels('db') },
      strategy: { type: 'Recreate' },
      template: {
        metadata: templateMeta('db'),
        spec: podSpec(
          [
            {
              name: 'db',
              image: 'postgres:16.4',
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'tcp-5432', containerPort: 5432, protocol: 'TCP' }],
              readinessProbe: probe({ exec: { command: ['pg_isready', '-U', 'shop'] } }),
              volumeMounts: [
                { name: 'pvc-postgres-data', mountPath: '/var/lib/postgresql/data' },
                { name: 'pvc-shared-media', mountPath: '/srv/media', readOnly: true },
              ],
            },
          ],
          {
            topologySpreadConstraints: [hostnameSpread('db', true)],
            volumes: [
              { name: 'pvc-postgres-data', persistentVolumeClaim: { claimName: 'postgres-data' } },
              { name: 'pvc-shared-media', persistentVolumeClaim: { claimName: 'shared-media' } },
            ],
          },
        ),
      },
    },
  };
  const queue: StatefulSet = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: workloadMeta('queue', 'queue'),
    spec: {
      minReadySeconds: 5,
      persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Retain', whenScaled: 'Retain' },
      podManagementPolicy: 'Parallel',
      replicas: 3,
      revisionHistoryLimit: 10,
      selector: { matchLabels: selectorLabels('queue') },
      serviceName: 'queue-hl',
      template: {
        metadata: templateMeta('queue'),
        spec: podSpec(
          [
            {
              name: 'queue',
              image: 'rabbitmq:3.13',
              imagePullPolicy: 'IfNotPresent',
              livenessProbe: probe({ exec: { command: ['/bin/sh', '-c', 'rabbitmq-diagnostics -q ping'] } }),
              ports: [{ name: 'tcp-5672', containerPort: 5672, protocol: 'TCP' }],
              readinessProbe: probe({ tcpSocket: { port: 5672 } }),
              volumeMounts: [{ name: 'queue-data', mountPath: '/var/lib/rabbitmq' }],
            },
          ],
          { topologySpreadConstraints: [hostnameSpread('queue', false)] },
        ),
      },
      updateStrategy: { type: 'RollingUpdate' },
      volumeClaimTemplates: [
        {
          metadata: {
            name: 'queue-data',
            annotations: { [ANNOTATIONS.composeVolume]: 'queue_data' },
            labels: { ...stackLabels(), [LABELS.volume]: 'queue-data' },
          },
          spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } }, storageClassName: 'dockflow-local' },
        },
      ],
    },
  };
  const agent: DaemonSet = {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: workloadMeta('agent', 'agent'),
    spec: {
      revisionHistoryLimit: 10,
      selector: { matchLabels: selectorLabels('agent') },
      template: {
        metadata: templateMeta('agent'),
        spec: podSpec(
          [
            {
              name: 'agent',
              image: 'registry.example.com/node-agent:2.1.0',
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'tcp-9100', containerPort: 9100, hostPort: 9100, protocol: 'TCP' }],
            },
          ],
          { tolerations: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane', operator: 'Exists' }] },
        ),
      },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } },
    },
  };
  const migrate: Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: workloadMeta('migrate-0c1d2e3f', 'migrate'),
    spec: {
      backoffLimit: 6,
      completions: 1,
      parallelism: 1,
      template: {
        metadata: templateMeta('migrate'),
        spec: podSpec(
          [{ name: 'migrate', args: ['migrate', '--to', 'latest'], image: `dockflow.invalid/shop-migrate-production:${RELEASE}`, imagePullPolicy: 'IfNotPresent' }],
          { restartPolicy: 'Never' },
        ),
      },
    },
  };
  const loadBalancer: Service = {
    ...clusterService('web-lb', 'web', [{ name: 'tcp-3000', port: 8080, protocol: 'TCP', targetPort: 3000 }]),
  };
  loadBalancer.spec = { ...loadBalancer.spec, type: 'LoadBalancer', allocateLoadBalancerNodePorts: false, loadBalancerSourceRanges: ['203.0.113.0/24'] };
  const route: IngressRoute = {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: { name: `web--${sha8('shop-production-web')}`, namespace: NS, annotations: { [ANNOTATIONS.composeService]: 'web' }, labels: serviceLabels('web') },
    spec: {
      entryPoints: ['websecure'],
      routes: [
        {
          kind: 'Rule',
          match: 'Host(`shop.example.com`)',
          middlewares: [{ name: 'strip-api' }, { name: 'auth' }, { name: 'accessory-headers' }],
          services: [{ name: 'web', port: 3000 }],
        },
      ],
      tls: { certResolver: 'letsencrypt' },
    },
  };
  return [
    env,
    apiKey,
    auth,
    nginx,
    claim,
    clusterService('web', 'web', [{ name: 'tcp-3000', port: 3000, protocol: 'TCP' }]),
    loadBalancer,
    clusterService('db', 'db', [{ name: 'tcp-5432', port: 5432, protocol: 'TCP' }]),
    clusterService('queue', 'queue', [{ name: 'tcp-5672', port: 5672, protocol: 'TCP' }]),
    clusterService('queue-hl', 'queue', [{ name: 'tcp-5672', port: 5672, protocol: 'TCP' }], true),
    clusterService('agent', 'agent', [{ name: 'tcp-9100', port: 9100, protocol: 'TCP' }]),
    clusterService('migrate', 'migrate', [{ name: 'placeholder', port: 9, protocol: 'TCP' }], true),
    web,
    db,
    queue,
    agent,
    migrate,
    middleware('add-prefix', { addPrefix: { prefix: '/v2' } }),
    middleware('allow-office', { ipAllowList: { sourceRange: ['10.0.0.0/8', '192.168.0.0/16'] } }),
    middleware('auth', { basicAuth: { realm: 'shop', secret: auth.metadata.name } }),
    middleware('errors', { errors: { query: '/{status}.html', service: { name: 'web', port: 3000 }, status: ['404', '500-599'] } }),
    // Traefik strips the first matching prefix, so declaration order is kept here.
    middleware('strip-api', { stripPrefix: { prefixes: ['/api/v1', '/api'] } }),
    route,
  ];
}

/** Fresh plain records the mutations may change freely. */
function kitchenSink(): Json[] {
  return structuredClone(kitchenSinkObjects()) as unknown as Json[];
}

/** Objects Dockflow creates outside artifacts: structural validation only (design-07 7.4). */
function nonArtifactObjects(): Json[] {
  const namespace: Namespace = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: NS, annotations: { [ANNOTATIONS.stackName]: 'shop-production' }, labels: { [LABELS.managedBy]: 'dockflow', [LABELS.stack]: NS } },
  };
  const lease: Lease = {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: { name: `lock-${NS}`, namespace: 'dockflow-system', annotations: { [ANNOTATIONS.lock]: '{"holder":"ci"}' }, labels: { [LABELS.stack]: NS } },
    spec: { holderIdentity: 'ci', leaseDurationSeconds: 900, acquireTime: '2026-09-19T10:00:00.000000Z', renewTime: '2026-09-19T10:01:00.000000Z' },
  };
  const storageClass: StorageClass = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'dockflow-local', annotations: { [KUBE_KEYS.defaultStorageClass]: 'true' }, labels: { [LABELS.part]: 'system' } },
    provisioner: 'example.com/local-path',
    reclaimPolicy: 'Retain',
    volumeBindingMode: 'WaitForFirstConsumer',
  };
  const account: ServiceAccount = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'dockflow-deployer', namespace: 'dockflow-system' },
    automountServiceAccountToken: false,
  };
  const binding: ClusterRoleBinding = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: 'dockflow-deployer' },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    subjects: [{ kind: 'ServiceAccount', name: 'dockflow-deployer', namespace: 'dockflow-system' }],
  };
  const helper: Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'dockflow-helper-backup-1a2b3c4d', namespace: NS, labels: { [LABELS.part]: 'helper' } },
    spec: {
      containers: [{ name: 'helper', command: ['sh', '-c', 'true'], image: 'busybox:1.36', volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
      nodeName: 'worker-2',
      restartPolicy: 'Never',
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'postgres-data' } }],
    },
  };
  const volume: PersistentVolume = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: 'pvc-0a1b2c3d', annotations: { [ANNOTATIONS.reclaimPolicyBefore]: 'Retain' } },
    spec: {
      accessModes: ['ReadWriteOnce'],
      capacity: { storage: '1Gi' },
      claimRef: { name: 'postgres-data', namespace: NS },
      hostPath: { path: '/srv/volumes/postgres-data' },
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'dockflow-local',
    },
  };
  const release: Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: `dockflow-release-${RELEASE}`, namespace: NS, labels: { [LABELS.part]: 'release' } },
    type: 'dockflow.shawiizz.dev/release.v1',
    data: { 'metadata.json': b64('{}') },
  };
  return structuredClone([namespace, lease, storageClass, account, binding, helper, volume, release]) as unknown as Json[];
}

// ---------------------------------------------------------------------------------------------
// Mutation helpers

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Json;
}

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

function step(current: unknown, segment: string, path: string): unknown {
  return Array.isArray(current) ? current[Number(segment)] : asRecord(current, path)[segment];
}

/** Object at a dotted path; numeric segments index arrays. */
function at(root: unknown, path: string): Json {
  let current = root;
  for (const segment of path.split('.')) current = step(current, segment, path);
  return asRecord(current, path);
}

function listAt(root: unknown, path: string): unknown[] {
  let current = root;
  for (const segment of path.split('.')) current = step(current, segment, path);
  return asList(current, path);
}

function find(objects: Json[], kind: string, name: string): Json {
  const found = objects.find((object) => object.kind === kind && asRecord(object.metadata, 'metadata').name === name);
  if (found === undefined) throw new Error(`the kitchen sink has no ${kind} ${name}`);
  return found;
}

function named(objects: Json[], kind: string, prefix: string): Json {
  const found = objects.find((object) => object.kind === kind && String(asRecord(object.metadata, 'metadata').name).startsWith(prefix));
  if (found === undefined) throw new Error(`the kitchen sink has no ${kind} ${prefix}*`);
  return found;
}

const web = (objects: Json[]): Json => find(objects, 'Deployment', 'web');
const webPod = (objects: Json[]): Json => at(web(objects), 'spec.template.spec');
const webContainer = (objects: Json[]): Json => at(web(objects), 'spec.template.spec.containers.0');
const route = (objects: Json[]): Json => named(objects, 'IngressRoute', 'web--');
const envSecretOf = (objects: Json[]): Json => named(objects, 'Secret', 'web-env-');

interface Mutation {
  /** design-07 7.5 id, or the rule it exercises */
  id: string;
  /** the rule the mutation must trigger */
  rule: string;
  /** other rules the same change legitimately triggers */
  also?: string[];
  change: string;
  mutate(objects: Json[]): void;
  context?: Partial<SemanticContext>;
}

// ---------------------------------------------------------------------------------------------
// Structural mutations (design-07 7.5 U-SCHEMA-01..06 and 12, design-02 14.6 L1 rules)

const STRUCTURAL: Mutation[] = [
  {
    id: 'U-SCHEMA-01',
    rule: 'unknown-field',
    change: 'add containers[0].imagePullPolicyy',
    mutate: (o) => {
      webContainer(o).imagePullPolicyy = 'IfNotPresent';
    },
  },
  {
    id: 'U-SCHEMA-02',
    rule: 'type',
    change: 'spec.replicas: "2"',
    mutate: (o) => {
      at(web(o), 'spec').replicas = '2';
    },
  },
  {
    id: 'U-SCHEMA-03',
    rule: 'required',
    also: ['S04'],
    change: 'delete containers[0].name',
    mutate: (o) => {
      delete webContainer(o).name;
    },
  },
  {
    id: 'U-SCHEMA-04',
    rule: 'int32',
    also: ['S04'],
    change: 'containerPort: 2147483648',
    mutate: (o) => {
      at(webContainer(o), 'ports.0').containerPort = 2147483648;
    },
  },
  {
    id: 'U-SCHEMA-05',
    rule: 'quantity',
    change: 'limits.memory: "512 MB"',
    mutate: (o) => {
      at(webContainer(o), 'resources.limits').memory = '512 MB';
    },
  },
  {
    id: 'U-SCHEMA-06',
    rule: 'list-map-duplicate',
    also: ['S04'],
    change: 'duplicate (containerPort, protocol)',
    mutate: (o) => {
      listAt(webContainer(o), 'ports').push({ name: 'http', containerPort: 3000, protocol: 'TCP' });
    },
  },
  {
    id: 'U-SCHEMA-12',
    rule: 'enum',
    also: ['S16'],
    change: 'IngressRoute routes[0].kind: Route',
    mutate: (o) => {
      at(route(o), 'spec.routes.0').kind = 'Route';
    },
  },
  {
    id: 'L1-newer-field',
    rule: 'unknown-field',
    change: 'a PodSpec field added after v1.34.0 (schedulingGroup)',
    mutate: (o) => {
      webPod(o).schedulingGroup = { name: 'batch' };
    },
  },
  {
    id: 'L1-null',
    rule: 'null',
    change: 'spec.minReadySeconds: null',
    mutate: (o) => {
      at(web(o), 'spec').minReadySeconds = null;
    },
  },
  {
    id: 'L1-byte',
    rule: 'byte',
    also: ['S08', 'SEM-051'],
    change: 'Secret data that is not base64',
    mutate: (o) => {
      at(envSecretOf(o), 'data').LOG_LEVEL = 'not base64!';
    },
  },
  {
    id: 'L1-int-or-string',
    rule: 'int-or-string',
    also: ['S05'],
    change: 'Service targetPort: true',
    mutate: (o) => {
      at(find(o, 'Service', 'web-lb'), 'spec.ports.0').targetPort = true;
    },
  },
  {
    id: 'L1-gvk',
    rule: 'gvk',
    also: ['S20'],
    change: 'Deployment apiVersion extensions/v1beta1',
    mutate: (o) => {
      web(o).apiVersion = 'extensions/v1beta1';
    },
  },
  {
    id: 'L1-int64',
    rule: 'int64',
    change: 'tolerationSeconds beyond a safe int64',
    mutate: (o) => {
      at(webPod(o), 'tolerations.0').tolerationSeconds = 2 ** 60;
    },
  },
  {
    id: 'L1-crd-minimum',
    rule: 'minimum',
    change: 'errors middleware service weight: -1',
    mutate: (o) => {
      at(find(o, 'Middleware', 'errors'), 'spec.errors.service').weight = -1;
    },
  },
  {
    id: 'L1-crd-pattern',
    rule: 'pattern',
    change: 'errors middleware status: abc',
    mutate: (o) => {
      at(find(o, 'Middleware', 'errors'), 'spec.errors').status = ['404', 'abc'];
    },
  },
  {
    id: 'L1-crd-metadata',
    rule: 'unknown-field',
    change: 'IngressRoute metadata validated as ObjectMeta',
    mutate: (o) => {
      at(route(o), 'metadata').owner = 'web';
    },
  },
  {
    id: 'L1-set',
    rule: 'set-duplicate',
    change: 'metadata.finalizers repeats an entry',
    mutate: (o) => {
      at(web(o), 'metadata').finalizers = ['example.com/hold', 'example.com/hold'];
    },
  },
  {
    id: 'L1-required-list-map-key',
    rule: 'required',
    also: ['S06'],
    change: 'volumeMount without mountPath',
    mutate: (o) => {
      listAt(webContainer(o), 'volumeMounts').push({ name: 'tmpfs-7c9e2b1a' });
    },
  },
  {
    id: 'L1-boolean',
    rule: 'type',
    also: ['S25'],
    change: 'enableServiceLinks: "false"',
    mutate: (o) => {
      webPod(o).enableServiceLinks = 'false';
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Semantic mutations: one or more per rule (design-07 7.3 S01..S28, design-02 14.4)

const SEMANTIC: Mutation[] = [
  {
    id: 'S01',
    rule: 'S01',
    change: 'Deployment name web.app',
    mutate: (o) => {
      at(web(o), 'metadata').name = 'web.app';
    },
  },
  {
    id: 'S01-ingressroute',
    rule: 'S01',
    change: 'IngressRoute not named <service>--<8 hex>',
    mutate: (o) => {
      at(route(o), 'metadata').name = 'web-route';
    },
  },
  {
    id: 'U-SCHEMA-11',
    rule: 'S02',
    change: '64-character label value',
    mutate: (o) => {
      at(web(o), 'metadata.labels')[LABELS.partOf] = 'x'.repeat(64);
    },
  },
  {
    id: 'S02-annotation',
    rule: 'S02',
    change: 'annotation key that is not a qualified name',
    mutate: (o) => {
      at(web(o), 'metadata.annotations')['bad key'] = 'x';
    },
  },
  {
    id: 'S03',
    rule: 'S03',
    change: 'workload selector beyond {P/stack, P/service}',
    mutate: (o) => {
      at(web(o), 'spec.selector.matchLabels').tier = 'front';
    },
  },
  {
    id: 'S03-service',
    rule: 'S03',
    change: 'Service selector that is not the selector labels of its own service (SEM-043)',
    mutate: (o) => {
      at(find(o, 'Service', 'db'), 'spec.selector')[LABELS.service] = 'other';
    },
  },
  {
    id: 'S04',
    rule: 'S04',
    also: ['list-map-duplicate'],
    change: 'two containers named web',
    mutate: (o) => {
      listAt(webPod(o), 'containers').push({ name: 'web', image: 'busybox:1.36', imagePullPolicy: 'IfNotPresent' });
    },
  },
  {
    id: 'S04-port-name',
    rule: 'S04',
    change: 'container port name TCP_3000',
    mutate: (o) => {
      at(webContainer(o), 'ports.0').name = 'TCP_3000';
    },
  },
  {
    id: 'S04-host-network',
    rule: 'S04',
    change: 'hostNetwork with hostPort != containerPort',
    mutate: (o) => {
      const agent = find(o, 'DaemonSet', 'agent');
      at(agent, 'spec.template.spec').hostNetwork = true;
      at(agent, 'spec.template.spec.containers.0.ports.0').hostPort = 9101;
    },
  },
  {
    id: 'U-SCHEMA-08',
    rule: 'S05',
    change: 'Service targetPort: tcp-9999',
    mutate: (o) => {
      at(find(o, 'Service', 'web'), 'spec.ports.0').targetPort = 'tcp-9999';
    },
  },
  {
    id: 'S05-no-ports',
    rule: 'S05',
    also: ['S16'],
    change: 'ClusterIP Service without ports (SEM-041)',
    mutate: (o) => {
      delete at(find(o, 'Service', 'web'), 'spec').ports;
    },
  },
  {
    id: 'S05-lb-name',
    rule: 'S05',
    change: '-lb port named after the published port',
    mutate: (o) => {
      at(find(o, 'Service', 'web-lb'), 'spec.ports.0').name = 'tcp-8080';
    },
  },
  {
    id: 'S06',
    rule: 'S06',
    change: 'volumeMount naming no volume',
    mutate: (o) => {
      at(webContainer(o), 'volumeMounts.0').name = 'missing';
    },
  },
  {
    id: 'S06-recursive',
    rule: 'S06',
    change: 'recursiveReadOnly without readOnly',
    mutate: (o) => {
      delete at(webContainer(o), 'volumeMounts.1').readOnly;
    },
  },
  {
    id: 'S06-sources',
    rule: 'S06',
    change: 'pod volume with two sources',
    mutate: (o) => {
      at(webPod(o), 'volumes.1').emptyDir = {};
    },
  },
  {
    id: 'S07',
    rule: 'S07',
    change: 'envFrom naming an unknown Secret',
    mutate: (o) => {
      at(webContainer(o), 'envFrom.0.secretRef').name = 'missing-env';
    },
  },
  {
    id: 'S07-claim',
    rule: 'S07',
    change: 'claimName neither rendered nor external',
    mutate: (o) => {
      at(find(o, 'Deployment', 'db'), 'spec.template.spec.volumes.1.persistentVolumeClaim').claimName = 'unknown-claim';
    },
  },
  {
    id: 'S07-middleware-secret',
    rule: 'S07',
    change: 'basicAuth.secret naming no Secret of the artifact',
    mutate: (o) => {
      at(find(o, 'Middleware', 'auth'), 'spec.basicAuth').secret = 'missing-users';
    },
  },
  {
    id: 'S08',
    rule: 'S08',
    change: 'ConfigMap key with a space',
    mutate: (o) => {
      const data = at(named(o, 'ConfigMap', 'nginx-conf-config-'), 'data');
      data['nginx conf'] = data.nginx_conf;
      delete data.nginx_conf;
    },
  },
  {
    id: 'S08-both',
    rule: 'S08',
    also: ['SEM-051'],
    change: 'ConfigMap key in data and binaryData',
    mutate: (o) => {
      named(o, 'ConfigMap', 'nginx-conf-config-').binaryData = { nginx_conf: b64('x') };
    },
  },
  {
    id: 'U-SCHEMA-10',
    rule: 'S09',
    change: 'progressDeadlineSeconds: 30, minReadySeconds: 30',
    mutate: (o) => {
      Object.assign(at(web(o), 'spec'), { progressDeadlineSeconds: 30, minReadySeconds: 30 });
    },
  },
  {
    id: 'U-SCHEMA-10-cap',
    rule: 'S09',
    change: 'progressDeadlineSeconds: 300',
    mutate: (o) => {
      at(web(o), 'spec').progressDeadlineSeconds = 300;
    },
  },
  {
    id: 'S09-recreate',
    rule: 'S09',
    change: 'Recreate with rollingUpdate',
    mutate: (o) => {
      at(find(o, 'Deployment', 'db'), 'spec').strategy = { type: 'Recreate', rollingUpdate: { maxSurge: 1 } };
    },
  },
  {
    id: 'S09-zero',
    rule: 'S09',
    change: 'RollingUpdate with maxSurge and maxUnavailable both 0',
    mutate: (o) => {
      at(web(o), 'spec.strategy.rollingUpdate').maxSurge = 0;
    },
  },
  {
    id: 'S09-restart',
    rule: 'S09',
    change: 'restartPolicy OnFailure on a Deployment',
    mutate: (o) => {
      webPod(o).restartPolicy = 'OnFailure';
    },
  },
  {
    id: 'S10',
    rule: 'S10',
    change: 'probe without timeoutSeconds',
    mutate: (o) => {
      delete at(webContainer(o), 'readinessProbe').timeoutSeconds;
    },
  },
  {
    id: 'S10-startup',
    rule: 'S10',
    change: 'startupProbe without livenessProbe',
    mutate: (o) => {
      delete webContainer(o).livenessProbe;
    },
  },
  {
    id: 'S10-success',
    rule: 'S10',
    change: 'livenessProbe successThreshold: 2',
    mutate: (o) => {
      at(webContainer(o), 'livenessProbe').successThreshold = 2;
    },
  },
  {
    id: 'S10-handlers',
    rule: 'S10',
    change: 'probe with two handlers',
    mutate: (o) => {
      at(webContainer(o), 'readinessProbe').tcpSocket = { port: 3000 };
    },
  },
  {
    id: 'S11',
    rule: 'S11',
    change: 'memory request above the limit',
    mutate: (o) => {
      at(webContainer(o), 'resources.requests').memory = '1Gi';
    },
  },
  {
    id: 'U-SCHEMA-07',
    rule: 'S12',
    change: 'imagePullPolicy: Sometimes',
    mutate: (o) => {
      webContainer(o).imagePullPolicy = 'Sometimes';
    },
  },
  {
    id: 'S12-imported-always',
    rule: 'S12',
    change: 'dockflow.invalid image with imagePullPolicy Always (SEM-031)',
    mutate: (o) => {
      webContainer(o).imagePullPolicy = 'Always';
    },
  },
  {
    id: 'S12-missing-pull-policy',
    rule: 'S12',
    change: 'container without imagePullPolicy',
    mutate: (o) => {
      delete webContainer(o).imagePullPolicy;
    },
  },
  {
    id: 'S12-service-type',
    rule: 'S12',
    change: 'Service type Internal',
    mutate: (o) => {
      at(find(o, 'Service', 'db'), 'spec').type = 'Internal';
    },
  },
  {
    id: 'S12-access-mode',
    rule: 'S12',
    change: 'PVC access mode ReadWriteSometimes',
    mutate: (o) => {
      at(find(o, 'PersistentVolumeClaim', 'postgres-data'), 'spec').accessModes = ['ReadWriteSometimes'];
    },
  },
  {
    id: 'S13',
    rule: 'S13',
    change: 'PVC without storageClassName',
    mutate: (o) => {
      delete at(find(o, 'PersistentVolumeClaim', 'postgres-data'), 'spec').storageClassName;
    },
  },
  {
    id: 'S13-template',
    rule: 'S13',
    change: 'claim template without access modes',
    mutate: (o) => {
      at(find(o, 'StatefulSet', 'queue'), 'spec.volumeClaimTemplates.0.spec').accessModes = [];
    },
  },
  {
    id: 'S14',
    rule: 'S14',
    change: 'hostPort on a surging Deployment',
    mutate: (o) => {
      at(webContainer(o), 'ports.0').hostPort = 3000;
    },
  },
  {
    id: 'S15',
    rule: 'S15',
    change: 'Job restartPolicy OnFailure',
    mutate: (o) => {
      at(find(o, 'Job', 'migrate-0c1d2e3f'), 'spec.template.spec').restartPolicy = 'OnFailure';
    },
  },
  {
    id: 'S15-fields',
    rule: 'S15',
    also: ['unknown-field'],
    change: 'Job with minReadySeconds',
    mutate: (o) => {
      at(find(o, 'Job', 'migrate-0c1d2e3f'), 'spec').minReadySeconds = 5;
    },
  },
  {
    id: 'U-SCHEMA-09',
    rule: 'S16',
    change: 'IngressRoute port 8080 absent from the Service',
    mutate: (o) => {
      at(route(o), 'spec.routes.0.services.0').port = 8080;
    },
  },
  {
    id: 'S16-middleware',
    rule: 'S16',
    change: 'IngressRoute middleware defined nowhere (strict, SEM-071)',
    mutate: (o) => {
      listAt(route(o), 'spec.routes.0.middlewares').push({ name: 'nope' });
    },
  },
  {
    id: 'S16-routes',
    rule: 'S16',
    change: 'two routes in one IngressRoute (SEM-070)',
    mutate: (o) => {
      const routes = listAt(route(o), 'spec.routes');
      routes.push(structuredClone(routes[0]));
    },
  },
  {
    id: 'S16-errors',
    rule: 'S16',
    change: 'errors middleware naming an unknown Service',
    mutate: (o) => {
      at(find(o, 'Middleware', 'errors'), 'spec.errors.service').name = 'ghost';
    },
  },
  {
    id: 'S17',
    rule: 'S17',
    change: 'terminationGracePeriodSeconds: -1',
    mutate: (o) => {
      webPod(o).terminationGracePeriodSeconds = -1;
    },
  },
  {
    id: 'S18',
    rule: 'S18',
    change: 'toleration Exists with a value',
    mutate: (o) => {
      at(webPod(o), 'tolerations.0').operator = 'Exists';
    },
  },
  {
    id: 'S18-seconds',
    rule: 'S18',
    change: 'tolerationSeconds without NoExecute',
    mutate: (o) => {
      at(webPod(o), 'tolerations.0').effect = 'NoSchedule';
    },
  },
  {
    id: 'S19',
    rule: 'S19',
    change: 'topology spread maxSkew: 0',
    mutate: (o) => {
      at(webPod(o), 'topologySpreadConstraints.0').maxSkew = 0;
    },
  },
  {
    id: 'S19-selector',
    rule: 'S19',
    change: 'spread selector not matching the template',
    mutate: (o) => {
      at(webPod(o), 'topologySpreadConstraints.0.labelSelector.matchLabels')[LABELS.service] = 'db';
    },
  },
  {
    id: 'S19-match-label-keys',
    rule: 'S19',
    change: 'matchLabelKeys on a StatefulSet (SEM-030)',
    mutate: (o) => {
      at(find(o, 'StatefulSet', 'queue'), 'spec.template.spec.topologySpreadConstraints.0').matchLabelKeys = ['pod-template-hash'];
    },
  },
  {
    id: 'S20',
    rule: 'S20',
    change: 'object outside the stack namespace',
    mutate: (o) => {
      at(web(o), 'metadata').namespace = 'default';
    },
  },
  {
    id: 'S20-part',
    rule: 'S20',
    change: 'missing P/part',
    mutate: (o) => {
      delete at(web(o), 'metadata.labels')[LABELS.part];
    },
  },
  {
    id: 'S20-template-release',
    rule: 'S20',
    change: 'P/release on a pod template (SEM-005)',
    mutate: (o) => {
      at(web(o), 'spec.template.metadata.annotations')[ANNOTATIONS.release] = RELEASE;
    },
  },
  {
    id: 'S20-accessory-release',
    rule: 'S20',
    change: 'P/release on a role accessory workload',
    mutate: (o) => {
      const agent = find(o, 'DaemonSet', 'agent');
      at(agent, 'metadata.labels')[LABELS.role] = 'accessory';
      at(agent, 'spec.template.metadata.labels')[LABELS.role] = 'accessory';
    },
  },
  {
    id: 'S20-volume',
    rule: 'S20',
    change: 'P/volume not equal to the claim name',
    mutate: (o) => {
      at(find(o, 'PersistentVolumeClaim', 'postgres-data'), 'metadata.labels')[LABELS.volume] = 'other';
    },
  },
  {
    id: 'S20-kind',
    rule: 'S20',
    change: 'a Namespace inside the artifact',
    mutate: (o) => {
      o.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS, labels: stackLabels() } });
    },
  },
  {
    id: 'S21',
    rule: 'S21',
    change: 'PVC with ownerReferences',
    mutate: (o) => {
      at(find(o, 'PersistentVolumeClaim', 'postgres-data'), 'metadata').ownerReferences = [{ apiVersion: 'v1', kind: 'Pod', name: 'x', uid: 'u-1' }];
    },
  },
  {
    id: 'S21-status',
    rule: 'S21',
    change: 'status on an emitted object',
    mutate: (o) => {
      web(o).status = { replicas: 2 };
    },
  },
  {
    id: 'S22',
    rule: 'S22',
    also: ['S08', 'SEM-051'],
    change: 'environment key with =',
    mutate: (o) => {
      at(envSecretOf(o), 'data')['BAD=KEY'] = b64('x');
    },
  },
  {
    id: 'S23',
    rule: 'S23',
    change: 'three nameservers next to the cluster DNS',
    mutate: (o) => {
      at(webPod(o), 'dnsConfig').nameservers = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
    },
  },
  {
    id: 'S23-alias',
    rule: 'S23',
    change: 'hostAliases ip that is not an IP',
    mutate: (o) => {
      at(webPod(o), 'hostAliases.0').ip = 'db-host';
    },
  },
  {
    id: 'S23-none',
    rule: 'S23',
    change: 'dnsPolicy None without nameservers',
    mutate: (o) => {
      const pod = webPod(o);
      delete pod.dnsConfig;
      pod.dnsPolicy = 'None';
    },
  },
  {
    id: 'S24',
    rule: 'S24',
    change: 'StatefulSet serviceName not <name>-hl',
    mutate: (o) => {
      at(find(o, 'StatefulSet', 'queue'), 'spec').serviceName = 'queue';
    },
  },
  {
    id: 'S25',
    rule: 'S25',
    also: ['unknown-field'],
    change: 'DaemonSet with replicas',
    mutate: (o) => {
      at(find(o, 'DaemonSet', 'agent'), 'spec').replicas = 2;
    },
  },
  {
    id: 'S25-retention',
    rule: 'S25',
    change: 'StatefulSet without persistentVolumeClaimRetentionPolicy',
    mutate: (o) => {
      delete at(find(o, 'StatefulSet', 'queue'), 'spec').persistentVolumeClaimRetentionPolicy;
    },
  },
  {
    id: 'S25-retention-delete',
    rule: 'S25',
    change: 'StatefulSet retention whenScaled: Delete (SEM-061)',
    mutate: (o) => {
      at(find(o, 'StatefulSet', 'queue'), 'spec.persistentVolumeClaimRetentionPolicy').whenScaled = 'Delete';
    },
  },
  {
    id: 'S25-job',
    rule: 'S25',
    change: 'Job without completions',
    mutate: (o) => {
      delete at(find(o, 'Job', 'migrate-0c1d2e3f'), 'spec').completions;
    },
  },
  {
    id: 'S25-pod',
    rule: 'S25',
    change: 'pod template without terminationGracePeriodSeconds',
    mutate: (o) => {
      delete webPod(o).terminationGracePeriodSeconds;
    },
  },
  {
    id: 'S26',
    rule: 'S26',
    change: 'container port without protocol',
    mutate: (o) => {
      delete at(webContainer(o), 'ports.0').protocol;
    },
  },
  {
    id: 'S26-service',
    rule: 'S26',
    change: 'Service port without protocol',
    mutate: (o) => {
      delete at(find(o, 'Service', 'web'), 'spec.ports.0').protocol;
    },
  },
  {
    id: 'S26-route',
    rule: 'S26',
    change: 'IngressRoute route without kind',
    mutate: (o) => {
      delete at(route(o), 'spec.routes.0').kind;
    },
  },
  {
    id: 'S27',
    rule: 'S27',
    change: 'memory limit 0.5Gi instead of 512Mi',
    mutate: (o) => {
      at(webContainer(o), 'resources.limits').memory = '0.5Gi';
    },
  },
  {
    id: 'S27-cpu',
    rule: 'S27',
    change: 'cpu request 0.25 instead of 250m',
    mutate: (o) => {
      at(webContainer(o), 'resources.requests').cpu = '0.25';
    },
  },
  {
    id: 'S27-millibytes',
    rule: 'S27',
    change: 'memory in millibytes (SEM-006)',
    mutate: (o) => {
      at(webContainer(o), 'resources.requests').memory = '268435456000m';
    },
  },
  {
    id: 'S28',
    rule: 'S28',
    change: 'hostname selector naming no servers.yml key',
    mutate: (o) => {
      at(webPod(o), 'nodeSelector')[KUBE_KEYS.hostname] = 'worker-9';
    },
  },
  {
    id: 'S28-affinity',
    rule: 'S28',
    change: 'hostname NotIn value naming no servers.yml key',
    mutate: (o) => {
      at(webPod(o), 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms.0.matchExpressions.0').values = ['worker_2'];
    },
  },
  {
    id: 'SEM-013',
    rule: 'SEM-013',
    change: 'DaemonSet with maxSurge and maxUnavailable both 0',
    mutate: (o) => {
      at(find(o, 'DaemonSet', 'agent'), 'spec.updateStrategy.rollingUpdate').maxUnavailable = 0;
    },
  },
  {
    id: 'SEM-014',
    rule: 'SEM-014',
    change: 'podManagementPolicy OrderedReady',
    mutate: (o) => {
      at(find(o, 'StatefulSet', 'queue'), 'spec').podManagementPolicy = 'OrderedReady';
    },
  },
  {
    id: 'SEM-014-max-unavailable',
    rule: 'SEM-014',
    also: ['SEM-033'],
    change: 'StatefulSet rollingUpdate.maxUnavailable',
    mutate: (o) => {
      at(find(o, 'StatefulSet', 'queue'), 'spec.updateStrategy').rollingUpdate = { maxUnavailable: 1 };
    },
  },
  {
    id: 'SEM-025',
    rule: 'SEM-025',
    change: 'privileged with allowPrivilegeEscalation: false',
    mutate: (o) => {
      at(webContainer(o), 'securityContext').privileged = true;
    },
  },
  {
    id: 'SEM-025-sysctl',
    rule: 'SEM-025',
    change: 'sysctl outside the safe list',
    mutate: (o) => {
      at(webPod(o), 'securityContext.sysctls.0').name = 'kernel.msgmax';
    },
  },
  {
    id: 'SEM-025-seccomp',
    rule: 'SEM-025',
    change: 'Localhost seccomp profile without a profile',
    mutate: (o) => {
      at(webPod(o), 'securityContext.seccompProfile').type = 'Localhost';
    },
  },
  {
    id: 'SEM-025-host-pid',
    rule: 'SEM-025',
    change: 'shareProcessNamespace with hostPID',
    mutate: (o) => {
      Object.assign(webPod(o), { hostPID: true, shareProcessNamespace: true });
    },
  },
  {
    id: 'SEM-033',
    rule: 'SEM-033',
    change: 'hostnameOverride (alpha at v1.34.0)',
    mutate: (o) => {
      webPod(o).hostnameOverride = 'web-1';
    },
  },
  {
    id: 'SEM-033-stop-signal',
    rule: 'SEM-033',
    change: 'lifecycle.stopSignal',
    mutate: (o) => {
      webContainer(o).lifecycle = { stopSignal: 'SIGTERM' };
    },
  },
  {
    id: 'SEM-042',
    rule: 'SEM-042',
    change: 'allocateLoadBalancerNodePorts: true',
    mutate: (o) => {
      at(find(o, 'Service', 'web-lb'), 'spec').allocateLoadBalancerNodePorts = true;
    },
  },
  {
    id: 'SEM-042-sctp',
    rule: 'SEM-042',
    change: 'SCTP on a LoadBalancer Service',
    mutate: (o) => {
      at(find(o, 'Service', 'web-lb'), 'spec.ports.0').protocol = 'SCTP';
    },
  },
  {
    id: 'SEM-042-cidr',
    rule: 'SEM-042',
    change: 'invalid loadBalancerSourceRanges CIDR',
    mutate: (o) => {
      at(find(o, 'Service', 'web-lb'), 'spec').loadBalancerSourceRanges = ['203.0.113.0/33'];
    },
  },
  {
    id: 'SEM-042-ports',
    rule: 'SEM-042',
    change: 'more than MAX_LOAD_BALANCER_PORTS ports',
    mutate: (o) => {
      at(find(o, 'Service', 'web-lb'), 'spec').ports = Array.from({ length: 11 }, (_, index) => ({
        name: `tcp-${3000 + index}`,
        port: 8000 + index,
        protocol: 'TCP',
        targetPort: 3000 + index,
      }));
    },
  },
  {
    id: 'SEM-051',
    rule: 'SEM-051',
    change: 'hashed name that is not the content checksum',
    mutate: (o) => {
      const secret = envSecretOf(o);
      at(secret, 'metadata').name = 'web-env-00000000';
      at(webContainer(o), 'envFrom.0.secretRef').name = 'web-env-00000000';
    },
  },
  {
    id: 'SEM-051-immutable',
    rule: 'SEM-051',
    change: 'hashed ConfigMap that is not immutable',
    mutate: (o) => {
      named(o, 'ConfigMap', 'nginx-conf-config-').immutable = false;
    },
  },
  {
    id: 'SEM-072',
    rule: 'SEM-072',
    change: 'addPrefix.prefix without a leading /',
    mutate: (o) => {
      at(find(o, 'Middleware', 'add-prefix'), 'spec.addPrefix').prefix = 'v2';
    },
  },
  {
    id: 'SEM-072-order',
    rule: 'SEM-072',
    change: 'unsorted set-like middleware array',
    mutate: (o) => {
      at(find(o, 'Middleware', 'allow-office'), 'spec.ipAllowList').sourceRange = ['192.168.0.0/16', '10.0.0.0/8'];
    },
  },
  {
    id: 'SEM-073',
    rule: 'SEM-073',
    change: 'entry point admin',
    mutate: (o) => {
      at(route(o), 'spec').entryPoints = ['admin'];
    },
  },
];

/** Passing fixtures of the SEM rules without an S equivalent (design-02 14.6). */
const PASSING: Mutation[] = [
  {
    id: 'S03-job-service',
    rule: 'S03',
    change: 'the Service of a replicated-job with 0 replicas, whose Job the artifact never contains (design-02 4.6, 6.1)',
    mutate: (o) => {
      o.splice(o.indexOf(find(o, 'Job', 'migrate-0c1d2e3f')), 1);
    },
  },
  { id: 'SEM-013', rule: 'SEM-013', change: 'stop-first DaemonSet (maxSurge 0, maxUnavailable 1)', mutate: () => {} },
  {
    id: 'SEM-013-surge',
    rule: 'SEM-013',
    change: 'start-first DaemonSet without node ports',
    mutate: (o) => {
      const agent = find(o, 'DaemonSet', 'agent');
      delete at(agent, 'spec.template.spec.containers.0.ports.0').hostPort;
      at(agent, 'spec.updateStrategy').rollingUpdate = { maxSurge: 1, maxUnavailable: 0 };
    },
  },
  { id: 'SEM-014', rule: 'SEM-014', change: 'StatefulSet with the literal Parallel', mutate: () => {} },
  { id: 'SEM-025', rule: 'SEM-025', change: 'safe sysctl, no privilege escalation', mutate: () => {} },
  { id: 'SEM-033', rule: 'SEM-033', change: 'no gated field', mutate: () => {} },
  { id: 'SEM-042', rule: 'SEM-042', change: 'LoadBalancer without node ports', mutate: () => {} },
  {
    id: 'SEM-042-trait',
    rule: 'SEM-042',
    change: 'a load balancer that needs node ports: field omitted',
    context: { traits: { loadBalancerNodePorts: true } },
    mutate: (o) => {
      delete at(find(o, 'Service', 'web-lb'), 'spec').allocateLoadBalancerNodePorts;
    },
  },
  { id: 'SEM-051', rule: 'SEM-051', change: 'env, secret, config and auth objects named by content', mutate: () => {} },
  { id: 'SEM-072', rule: 'SEM-072', change: 'prefix with /, sorted sets, ordered prefixes', mutate: () => {} },
  {
    id: 'SEM-073',
    rule: 'SEM-073',
    change: 'both entry points',
    mutate: (o) => {
      at(route(o), 'spec').entryPoints = ['web', 'websecure'];
    },
  },
];

const SEM_ONLY_RULES = ['SEM-013', 'SEM-014', 'SEM-025', 'SEM-033', 'SEM-042', 'SEM-051', 'SEM-072', 'SEM-073'];

function run(mutation: Mutation): SemanticIssue[] {
  const objects = kitchenSink();
  mutation.mutate(objects);
  return validateArtifact(objects, { ...CONTEXT, ...mutation.context });
}

// ---------------------------------------------------------------------------------------------
// Tests

describe('vendored schema bundles (design-07 7.1, design-02 14.2)', () => {
  test('roots are the kinds Dockflow creates, each artifact kind included', () => {
    const { kubernetes, traefik } = schemaBundles();
    expect(Object.keys(kubernetes.roots).sort()).toEqual(
      [
        'apps/v1/DaemonSet',
        'apps/v1/Deployment',
        'apps/v1/StatefulSet',
        'batch/v1/Job',
        'coordination.k8s.io/v1/Lease',
        'rbac.authorization.k8s.io/v1/ClusterRoleBinding',
        'storage.k8s.io/v1/StorageClass',
        'v1/ConfigMap',
        'v1/Namespace',
        'v1/PersistentVolume',
        'v1/PersistentVolumeClaim',
        'v1/Pod',
        'v1/Secret',
        'v1/Service',
        'v1/ServiceAccount',
      ].sort(),
    );
    expect(Object.keys(traefik.roots).sort()).toEqual(['traefik.io/v1alpha1/IngressRoute', 'traefik.io/v1alpha1/Middleware']);
    for (const info of Object.values(KIND_REGISTRY)) {
      const key = `${info.apiVersion}/${info.kind}`;
      expect(Object.hasOwn(kubernetes.roots, key) || Object.hasOwn(traefik.roots, key)).toBe(true);
    }
  });

  test('every root and every $ref resolves inside its own bundle, descriptions are trimmed', () => {
    const { kubernetes, traefik } = schemaBundles();
    for (const bundle of [kubernetes, traefik]) {
      for (const name of Object.values(bundle.roots)) expect(bundle.schemas[name]).toBeDefined();
      const refs = new Set<string>();
      const keywords = new Set<string>();
      const visit = (node: SchemaNode): void => {
        for (const key of Object.keys(node)) keywords.add(key);
        if (node.$ref !== undefined) refs.add(node.$ref);
        for (const child of Object.values(node.properties ?? {})) visit(child);
        for (const member of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) visit(member);
        if (node.items !== undefined) visit(node.items);
        if (typeof node.additionalProperties === 'object') visit(node.additionalProperties);
      };
      for (const node of Object.values(bundle.schemas)) visit(node);
      for (const ref of refs) {
        expect(ref.startsWith(REF_PREFIX)).toBe(true);
        expect(bundle.schemas[ref.slice(REF_PREFIX.length)]).toBeDefined();
      }
      expect(keywords.has('description')).toBe(false);
      expect(keywords.has('example')).toBe(false);
      for (const source of bundle.sources) {
        expect(source.url.startsWith('https://')).toBe(true);
        expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('structural validator (design-07 7.2, 7.5; design-02 14.3)', () => {
  test('every object of the known-good artifact passes', () => {
    for (const object of kitchenSink()) expect(validateObject(object)).toEqual([]);
  });

  test('objects created outside artifacts pass', () => {
    for (const object of nonArtifactObjects()) expect(validateObject(object)).toEqual([]);
  });

  test('an unknown apiVersion/kind has no schema', () => {
    expect(validateObject({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'x' } }).map((found) => found.rule)).toEqual(['gvk']);
    expect(validateObject('not an object').map((found) => found.rule)).toEqual(['type']);
  });

  test('MicroTime fields must be RFC 3339', () => {
    const lease = nonArtifactObjects().find((object) => object.kind === 'Lease');
    if (lease === undefined) throw new Error('no Lease fixture');
    at(lease, 'spec').acquireTime = 'yesterday';
    expect(validateObject(lease).map((found) => found.rule)).toEqual(['date-time']);
  });

  test('a list-map key with a default may be absent (protocol defaults to TCP)', () => {
    const objects = kitchenSink();
    const deployment = web(objects);
    delete at(deployment, 'spec.template.spec.containers.0.ports.0').protocol;
    expect(validateObject(deployment)).toEqual([]);
  });

  test('a list-map key without a default must be present', () => {
    const account = nonArtifactObjects().find((object) => object.kind === 'ServiceAccount');
    if (account === undefined) throw new Error('no ServiceAccount fixture');
    account.secrets = [{ namespace: 'dockflow-system' }];
    expect(validateObject(account)).toEqual([{ path: 'secrets[0].name', rule: 'list-map-key', message: 'list-map key name is missing' }]);
  });

  test('issues carry the path of the offending value and print on one line', () => {
    const objects = kitchenSink();
    webContainer(objects).imagePullPolicyy = 'IfNotPresent';
    const issues = validateObject(web(objects));
    expect(issues).toEqual([
      { path: 'spec.template.spec.containers[0].imagePullPolicyy', rule: 'unknown-field', message: 'unknown field imagePullPolicyy' },
    ]);
    expect(formatIssue(web(objects), issues[0])).toBe('Deployment/web spec.template.spec.containers[0].imagePullPolicyy: unknown-field unknown field imagePullPolicyy');
  });

  for (const mutation of STRUCTURAL) {
    test(`${mutation.id}: ${mutation.change} -> ${mutation.rule}`, () => {
      const rules = run(mutation).map((found) => found.rule);
      expect(rules).toContain(mutation.rule);
      expect(rules.filter((rule) => rule !== mutation.rule && !(mutation.also ?? []).includes(rule))).toEqual([]);
    });
  }
});

describe('semantic rules (design-07 7.3, design-02 14.4)', () => {
  test('the known-good artifact has no issue at all, warnings included', () => {
    const issues = validateArtifact(kitchenSink(), CONTEXT);
    expect(formatIssues(issues)).toBe('');
  });

  for (const mutation of SEMANTIC) {
    test(`${mutation.id}: ${mutation.change} -> ${mutation.rule}`, () => {
      const issues = run(mutation);
      const rules = issues.map((found) => found.rule);
      expect(rules).toContain(mutation.rule);
      expect(rules.filter((rule) => rule !== mutation.rule && !(mutation.also ?? []).includes(rule))).toEqual([]);
      expect(failures(issues).map((found) => found.rule)).toContain(mutation.rule);
    });
  }

  for (const fixture of PASSING) {
    test(`${fixture.id} passes: ${fixture.change}`, () => {
      expect(formatIssues(run(fixture))).toBe('');
    });
  }

  test('an unresolved middleware is a warning unless strictMiddlewares is set (SEM-071)', () => {
    const objects = kitchenSink();
    listAt(route(objects), 'spec.routes.0.middlewares').push({ name: 'nope' });
    const lenient = validateSemantics(objects, { ...CONTEXT, strictMiddlewares: false });
    expect(lenient.map((found) => [found.rule, found.severity])).toEqual([['S16', 'warning']]);
    expect(failures(lenient)).toEqual([]);
    const strict = validateSemantics(objects, CONTEXT);
    expect(strict.map((found) => [found.rule, found.severity])).toEqual([['S16', undefined]]);
  });

  test('a hostname placement needs its servers.yml key in the context (S28)', () => {
    const issues = validateSemantics(kitchenSink(), { ...CONTEXT, serverNames: [] });
    expect(issues.map((found) => `${found.rule} ${found.path}`)).toEqual([
      'S28 spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]',
    ]);
  });

  test('skipped rules do not run (non-artifact objects skip S20/S21)', () => {
    const objects = kitchenSink();
    at(web(objects), 'metadata').namespace = 'default';
    web(objects).status = { replicas: 2 };
    expect(validateSemantics(objects, CONTEXT).map((found) => found.rule)).toEqual(['S20', 'S21']);
    expect(validateSemantics(objects, { ...CONTEXT, skipRules: ['S20', 'S21'] })).toEqual([]);
  });

  test('external names satisfy references the artifact does not contain (S07)', () => {
    const issues = validateSemantics(kitchenSink(), { ...CONTEXT, externalNames: ['accessory-headers'] });
    expect(issues.map((found) => `${found.kind}/${found.name} ${found.rule}`)).toEqual(['Deployment/db S07']);
  });

  test('a user-managed middleware auth Secret passes when declared external (S07)', () => {
    const objects = kitchenSink();
    at(find(objects, 'Middleware', 'auth'), 'spec.basicAuth').secret = 'user-htpasswd';
    const declared = validateSemantics(objects, { ...CONTEXT, externalNames: ['shared-media', 'accessory-headers', 'user-htpasswd'] });
    expect(declared).toEqual([]);
    const undeclared = validateSemantics(objects, CONTEXT);
    expect(undeclared.map((found) => `${found.kind}/${found.name} ${found.path}: ${found.rule}`)).toEqual([
      'Middleware/auth spec.basicAuth.secret: S07',
    ]);
  });

  test('every rule id has a failing mutation, every SEM-only rule a passing fixture', () => {
    const failing = new Set(SEMANTIC.map((mutation) => mutation.rule));
    expect(SEMANTIC_RULE_IDS.filter((id) => !failing.has(id))).toEqual([]);
    expect([...failing].filter((id) => !SEMANTIC_RULE_IDS.includes(id))).toEqual([]);
    const passing = new Set(PASSING.map((fixture) => fixture.rule));
    expect(SEM_ONLY_RULES.filter((id) => !passing.has(id))).toEqual([]);
    expect(SEMANTIC_RULE_IDS.filter((id) => id.startsWith('SEM-')).sort()).toEqual([...SEM_ONLY_RULES].sort());
    for (const id of ['S01', 'S09', 'S16', 'S25', 'S28']) expect(SEMANTIC_RULE_IDS).toContain(id);
  });

  test('issues print as <kind>/<name> <path>: <rule> <message> (design-02 14.5)', () => {
    const issues = run(SEMANTIC.find((mutation) => mutation.id === 'U-SCHEMA-08') ?? SEMANTIC[0]);
    expect(formatIssues(issues)).toBe('Service/web spec.ports[0].targetPort: S05 names no container port of a pod template the selector matches');
  });
});

describe('quantities (S27, emission rule 5)', () => {
  test('canonical form matches resource.Quantity', () => {
    const cases: [string, string][] = [
      ['0.5', '500m'],
      ['1000m', '1'],
      ['1.5', '1500m'],
      ['1024Mi', '1Gi'],
      ['1.5Gi', '1536Mi'],
      ['0.5Gi', '512Mi'],
      ['0.5Ki', '512'],
      ['1536', '1536'],
      ['1000', '1k'],
      ['1e3', '1e3'],
      ['+2', '2'],
      ['0', '0'],
      ['0Mi', '0'],
      ['100m', '100m'],
      ['0.1n', '1n'],
    ];
    for (const [input, canonical] of cases) expect(canonicalQuantity(input)).toBe(canonical);
    for (const invalid of ['512 MB', '1.2.3', 'Mi', '', '1Kb']) expect(canonicalQuantity(invalid)).toBeNull();
  });
});
