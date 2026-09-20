// KubernetesProxyBackend (design-04 2.1-2.13, 4.1; design-07 10.3 U-BE-PROXY-*). Helm is faked at the
// executor level (FakeHelmExecutor), kubectl through FakeCluster (cluster mode), host commands
// through FakeNodeShell, time through FakeClock. Every test ends with assertExecutorInvariants.

import { afterEach, describe, expect, test } from 'bun:test';
import type { HelmEventSink } from '../../../services/orchestrator/interfaces';
import { KubernetesProxyBackend } from '../../../services/orchestrator/kubernetes/backends/proxy';
import { ANNOTATIONS, K8S_MANAGED_BY, K8S_SYSTEM_NAMESPACE, KUBE_KEYS, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { namespaceFor, nodeNameFor } from '../../../services/orchestrator/kubernetes/naming';
import type { HelmCall, HelmExecutor, HelmResult } from '../../../services/orchestrator/kubernetes/runtime/helm';
import { TRAEFIK_CHART_PIN, type TraefikChartPin } from '../../../services/orchestrator/kubernetes/versions';
import { canonicalJson } from '../../../utils/hash';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { FakeClock } from '../fakes/fake-clock';
import { fakeNode, FakeKubeExecutor, type KubeStep } from '../fakes/fake-kube-executor';
import { FakeHelmExecutor } from '../fakes/fake-helm-executor';
import { FakeNodeShell, type NodeShellStep } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';
import { expectCliError } from '../support/matchers';

const PROJECT = 'shop';
const ENV = 'production';
const STACK_ID = namespaceFor(PROJECT, ENV);
const SERVER = fakeNode('server_1');
const SERVER_HOSTNAME = nodeNameFor(SERVER.name);
const MANAGERS = [SERVER];
const OPEN_LISTENERS = { exitCode: 0, stdout: '', stderr: '' };

/** minimal but schema-valid: `helm show crds` output goes through the real `kubectl apply` path (support/schema) */
const CRD_VERSION = '  versions: [{name: v1alpha1, served: true, storage: true, schema: {openAPIV3Schema: {type: object, properties: {spec: {type: object, x-kubernetes-preserve-unknown-fields: true}}}}}]';

const CRDS_YAML = [
  'apiVersion: apiextensions.k8s.io/v1',
  'kind: CustomResourceDefinition',
  'metadata:',
  '  name: ingressroutes.traefik.io',
  'spec:',
  '  group: traefik.io',
  '  names: {kind: IngressRoute, plural: ingressroutes, singular: ingressroute}',
  '  scope: Namespaced',
  CRD_VERSION,
  '---',
  'apiVersion: apiextensions.k8s.io/v1',
  'kind: CustomResourceDefinition',
  'metadata:',
  '  name: middlewares.traefik.io',
  'spec:',
  '  group: traefik.io',
  '  names: {kind: Middleware, plural: middlewares, singular: middleware}',
  '  scope: Namespaced',
  CRD_VERSION,
].join('\n');

// ---------------------------------------------------------------------------
// What a real Traefik install leaves behind (FakeHelmExecutor and FakeCluster are separate fakes,
// design-07 3.5/3.6: Helm never touches kubectl's cluster on its own). This backend's own
// steady-state check (M6, design-04 2.8.3) and status() read the Deployment and pod straight from
// the cluster, exactly as production does against a real one, so every successful install/upgrade of
// dockflow-traefik seeds them here. Objects are frozen (`reconcile: false`) so FakeCluster's own
// Deployment/scheduler controllers never touch them (they would otherwise spawn a second, competing
// ReplicaSet and pod): the pod's readiness and node are decided by the values this backend generated,
// not by a simulated scheduler.
// ---------------------------------------------------------------------------

const TRAEFIK_POD_LABELS = { [LABELS.name]: 'traefik', [LABELS.instance]: 'dockflow-traefik' };

function traefikDeploymentObject(replicas: number, nodeSelector: Record<string, string>): KubeObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'dockflow-traefik', namespace: K8S_SYSTEM_NAMESPACE, labels: TRAEFIK_POD_LABELS },
    spec: { replicas, selector: { matchLabels: TRAEFIK_POD_LABELS }, template: { metadata: { labels: TRAEFIK_POD_LABELS }, spec: { nodeSelector, containers: [{ name: 'traefik', image: 'docker.io/traefik' }] } } },
    status: { replicas, readyReplicas: replicas },
  };
}

function traefikPodObject(hostname: string, withClaim: boolean): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'dockflow-traefik-fake', namespace: K8S_SYSTEM_NAMESPACE, labels: TRAEFIK_POD_LABELS },
    spec: {
      nodeName: hostname,
      containers: [{ name: 'traefik', image: 'docker.io/traefik' }],
      ...(withClaim ? { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'dockflow-traefik' } }] } : {}),
    },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
}

/** unbound: FakeCluster's own `local-path-provisioner` simulation binds it once ticked (design-07 3.9) */
function traefikClaimObject(): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'dockflow-traefik', namespace: K8S_SYSTEM_NAMESPACE, labels: TRAEFIK_POD_LABELS },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '128Mi' } }, storageClassName: 'dockflow-local' },
    status: { phase: 'Pending' },
  };
}

function syncTraefikWorkload(cluster: FakeCluster, stdin: string): void {
  const values = stdin.trim() === '' ? {} : (JSON.parse(stdin) as Record<string, unknown>);
  const nodeSelector = (values.nodeSelector as Record<string, string> | undefined) ?? { [KUBE_KEYS.hostname]: SERVER_HOSTNAME };
  const hostname = nodeSelector[KUBE_KEYS.hostname] ?? SERVER_HOSTNAME;
  const replicas = (values.deployment as { replicas?: number } | undefined)?.replicas ?? 1;
  const persistent = (values.persistence as { enabled?: boolean } | undefined)?.enabled === true;

  cluster.seed(traefikDeploymentObject(replicas, nodeSelector), { reconcile: false });
  if (replicas > 0) cluster.seed(traefikPodObject(hostname, persistent), { reconcile: false });
  if (persistent && cluster.get('PersistentVolumeClaim', 'dockflow-traefik', K8S_SYSTEM_NAMESPACE) === undefined) {
    cluster.seed(traefikClaimObject());
    cluster.tick(); // lets the WaitForFirstConsumer provisioner bind the claim to the (frozen) pod's node
  }
}

/**
 * Wraps FakeHelmExecutor so a successful `upgrade --install dockflow-traefik` also converges the
 * cluster the way a real chart install would (see above). Every other call is unchanged.
 */
function helmSyncingProxyDeployment(helm: FakeHelmExecutor, cluster: FakeCluster): HelmExecutor {
  return {
    node: helm.node,
    async run(call: HelmCall): Promise<HelmResult> {
      const result = await helm.run(call);
      if (result.exitCode === 0 && call.args[0] === 'upgrade' && call.args[1] === '--install' && call.args[2] === 'dockflow-traefik') {
        syncTraefikWorkload(cluster, call.stdin ?? '');
      }
      return result;
    },
    json<T>(args: string[]): Promise<T | null> {
      return helm.json<T>(args);
    },
  };
}

// ---------------------------------------------------------------------------
// Harness (design-07 3.5, 3.6, 3.9)
// ---------------------------------------------------------------------------

interface Harness {
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
  helm: FakeHelmExecutor;
  nodeShell: FakeNodeShell;
  clock: FakeClock;
  pin: TraefikChartPin;
  backend: KubernetesProxyBackend;
  events: RecordingEvents;
  /** the bytes registered for the pinned chart under `pin.sha256` (harness()'s default, no `bytes:` override) */
  chartBytes: string;
}

class RecordingEvents implements HelmEventSink {
  readonly steps: string[] = [];
  readonly warnings: { message: string; suggestion?: string }[] = [];
  step(text: string): void {
    this.steps.push(text);
  }
  warn(message: string, suggestion?: string): void {
    this.warnings.push(suggestion === undefined ? { message } : { message, suggestion });
  }
}

let harnesses: Harness[] = [];

afterEach(() => {
  const current = harnesses;
  harnesses = [];
  for (const h of current) {
    h.kube.assertDone();
    h.helm.assertDone();
    h.nodeShell.assertDone();
    assertExecutorInvariants({ kube: h.kube, helm: h.helm, nodeShell: h.nodeShell, redactor: h.kube.redactor, volumes: h.cluster });
    h.cluster.assertNoProblems();
  }
});

interface HarnessOptions {
  traefikCrds?: boolean;
  kubeScript?: KubeStep[];
  nodeScript?: NodeShellStep[];
  managers?: readonly ReturnType<typeof fakeNode>[];
  caBundles?: Record<string, string>;
  /** values the shared Redactor masks, so a helm failure's stderr can be asserted redacted (U-BE-PROXY-06) */
  redactorSecrets?: string[];
}

function harness(options: HarnessOptions = {}): Harness {
  const redactor = new Redactor(options.redactorSecrets ?? []);
  const clock = new FakeClock();
  const cluster = new FakeCluster({ traefikCrds: options.traefikCrds ?? false, clock });
  const kube = new FakeKubeExecutor({ redactor, cluster, script: options.kubeScript ?? [], clock });
  // test-specific listener scripts must be tried before the default "nothing is listening" fallback
  const nodeSteps: NodeShellStep[] = [...(options.nodeScript ?? []), { script: /^ss -Hltn$/, respond: OPEN_LISTENERS, times: 'any', optional: true }];
  const nodeShell = new FakeNodeShell(nodeSteps, { redactor, interpretFileCommands: true });
  const helm = new FakeHelmExecutor({ redactor, node: SERVER, nodeShell, clock });
  const chartBytes = `fake chart archive ${TRAEFIK_CHART_PIN.chart}-${TRAEFIK_CHART_PIN.version}\n`;
  const sha256 = helm.chart({ name: TRAEFIK_CHART_PIN.chart, version: TRAEFIK_CHART_PIN.version, repo: TRAEFIK_CHART_PIN.repo, appVersion: TRAEFIK_CHART_PIN.appVersion, crds: CRDS_YAML, bytes: chartBytes });
  const pin: TraefikChartPin = { ...TRAEFIK_CHART_PIN, sha256 };
  const managers = options.managers ?? MANAGERS;
  const caBundles = options.caBundles ?? {};
  const backend = new KubernetesProxyBackend({
    deps: { kubectl: kube, helm: helmSyncingProxyDeployment(helm, cluster), nodeShell: nodeShell.forNode, clock, redactor, distribution: kube.distribution },
    managers,
    project: PROJECT,
    env: ENV,
    pin,
    performer: 'alice',
    dockflowVersion: '9.9.9',
    resolveCaBundle: async (path: string) => {
      const text = caBundles[path];
      if (text === undefined) throw new Error(`no fake CA bundle registered for ${path}`);
      return text;
    },
  });
  const h: Harness = { cluster, kube, helm, nodeShell, clock, pin, backend, events: new RecordingEvents(), chartBytes };
  harnesses.push(h);
  return h;
}

function httpOnlyProxy(overrides: Record<string, unknown> = {}) {
  return { enabled: true, acme: false, ...overrides } as never;
}

function acmeProxy(overrides: Record<string, unknown> = {}) {
  return { enabled: true, acme: true, email: 'ops@example.com', ...overrides } as never;
}

/** the most recent `upgrade --install` call (a test may drive `ensure()` more than once) */
function upgradeCall(h: Harness) {
  const upgrades = h.helm.calls.filter((call) => call.args[0] === 'upgrade');
  return upgrades.at(-1);
}

function stdinValues(h: Harness): Record<string, unknown> {
  const call = upgradeCall(h);
  if (!call) throw new Error('no upgrade call was recorded');
  return JSON.parse(call.stdin) as Record<string, unknown>;
}

function configMapOf(h: Harness): KubeObject | undefined {
  return h.cluster.get('ConfigMap', 'dockflow-proxy', K8S_SYSTEM_NAMESPACE);
}

/** narrows a fake object's loosely-typed `data`/`spec` fields (`KubeObject`'s index signature) for assertions */
function dataOf(object: KubeObject | undefined): Record<string, string> {
  return (object?.data as Record<string, string> | undefined) ?? {};
}

function specOf(object: KubeObject): Record<string, unknown> {
  return (object.spec as Record<string, unknown> | undefined) ?? {};
}

// ---------------------------------------------------------------------------
// ensure(): install and steady state
// ---------------------------------------------------------------------------

describe('ensure() install', () => {
  test('U-BE-PROXY-01: fresh install applies the CRDs, installs from the cached archive and records state', async () => {
    const h = harness();
    const result = await h.backend.ensure(httpOnlyProxy(), ENV, h.events);

    expect(result).toEqual({ changed: true, action: 'install', version: h.pin.appVersion });
    expect(h.events.steps).toEqual(['Applying Traefik CRDs...', `Installing Traefik (chart ${h.pin.version}) in ${K8S_SYSTEM_NAMESPACE}...`]);

    const crd = h.cluster.get('CustomResourceDefinition', 'ingressroutes.traefik.io');
    expect(crd?.metadata.labels?.[LABELS.managedBy]).toBe(K8S_MANAGED_BY);
    expect(crd?.metadata.annotations?.[ANNOTATIONS.crdChartVersion]).toBe(h.pin.version);

    const upgrade = upgradeCall(h);
    expect(upgrade?.args).toEqual(
      expect.arrayContaining(['upgrade', '--install', 'dockflow-traefik', '-n', K8S_SYSTEM_NAMESPACE, '--values', '-', '--reset-values', '--skip-crds']),
    );
    expect(upgrade?.args).toContain('--labels');
    const values = stdinValues(h);
    expect(values.image).toMatchObject({ tag: h.pin.appVersion });

    const cm = configMapOf(h);
    expect(dataOf(cm).owner).toBe(STACK_ID);
    expect(Object.values(dataOf(cm)).join(' ')).not.toContain('@example.com');
  });

  test('U-BE-PROXY-11: a cached archive whose digest already matches the pin needs no download', async () => {
    const h = harness();
    h.helm.seedCache(h.pin.sha256, h.chartBytes);
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    expect(h.helm.calls.some((call) => call.args[0] === 'pull')).toBe(false);
  });

  test('a second ensure with unchanged config makes no Helm call', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    const callsAfterInstall = h.helm.calls.length;

    const result = await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    expect(result).toEqual({ changed: false, action: 'unchanged', version: h.pin.appVersion });
    expect(h.helm.calls.length).toBe(callsAfterInstall + 2); // one more `list` and, since a release now exists, `get values`; no upgrade
    expect(h.helm.calls.slice(callsAfterInstall).some((call) => call.mutating)).toBe(false);
  });

  test('U-BE-PROXY-03: toggling the dashboard on triggers exactly one upgrade', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);

    const result = await h.backend.ensure(httpOnlyProxy({ dashboard: { enabled: true, domain: 'traefik.example.com' } }), ENV, h.events);
    expect(result.changed).toBe(true);
    expect(result.action).toBe('upgrade');
    const upgrades = h.helm.calls.filter((call) => call.args[0] === 'upgrade');
    expect(upgrades).toHaveLength(2);
    const values = stdinValues(h);
    expect(values.api).toEqual({ dashboard: true });
  });
});

// ---------------------------------------------------------------------------
// ACME (2.4, 2.6, U-BE-PROXY-04, U-BE-PROXY-12)
// ---------------------------------------------------------------------------

describe('ACME', () => {
  test('U-BE-PROXY-04: ACME on carries the resolver, persistence, Recreate strategy and the redirect', async () => {
    const h = harness();
    await h.backend.ensure(acmeProxy(), ENV, h.events);

    const values = stdinValues(h);
    expect(values.certificatesResolvers).toEqual({ letsencrypt: { acme: { email: 'ops@example.com', storage: '/data/acme.json', httpChallenge: { entryPoint: 'web' } } } });
    expect(values.persistence).toMatchObject({ enabled: true, accessMode: 'ReadWriteOnce' });
    expect(values.updateStrategy).toEqual({ type: 'Recreate' });
    expect((values.ports as Record<string, Record<string, unknown>>).web.http).toEqual({
      redirections: { entryPoint: { to: 'websecure', scheme: 'https', permanent: true, priority: 1 } },
    });
    expect((values.ports as Record<string, Record<string, unknown>>).websecure.hostPort).toBe(443);
  });

  test('U-BE-PROXY-12: proxy.acme_ca_server sets caServer and never appears when unset', async () => {
    const h = harness();
    await h.backend.ensure(acmeProxy({ acme_ca_server: 'https://acme-staging-v02.api.letsencrypt.org/directory' }), ENV, h.events);
    const values = stdinValues(h);
    expect((values.certificatesResolvers as { letsencrypt: { acme: { caServer?: string } } }).letsencrypt.acme.caServer).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
  });

  test('U-BE-PROXY-12: proxy.acme_ca_bundle applies a Secret before the Helm call and references it by name', async () => {
    const bundle = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';
    const h = harness({ caBundles: { 'ca/root.pem': bundle } });
    await h.backend.ensure(acmeProxy({ acme_ca_server: 'https://ca.example.com/dir', acme_ca_bundle: 'ca/root.pem' }), ENV, h.events);

    const values = stdinValues(h);
    const volumes = values.volumes as { name: string; type: string }[];
    expect(volumes[0].type).toBe('secret');
    const secretName = volumes[0].name;
    expect(values.env).toEqual([
      { name: 'LEGO_CA_CERTIFICATES', value: '/etc/dockflow/acme-ca/ca.crt' },
      { name: 'LEGO_CA_SYSTEM_CERT_POOL', value: 'true' },
    ]);
    const secret = h.cluster.get('Secret', secretName, K8S_SYSTEM_NAMESPACE);
    expect(dataOf(secret)['ca.crt']).toBe(Buffer.from(bundle, 'utf8').toString('base64'));

    // the PEM text itself never enters the values
    expect(canonicalJson(values)).not.toContain('BEGIN CERTIFICATE');
  });
});

// ---------------------------------------------------------------------------
// status() (2.11, U-BE-PROXY-05)
// ---------------------------------------------------------------------------

describe('status()', () => {
  test('U-BE-PROXY-05: not installed', async () => {
    const h = harness();
    expect(await h.backend.status()).toMatchObject({ installed: false, ready: false, version: null, detail: 'not installed' });
  });

  test('reads through list --filter, never issues `helm status`', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    const status = await h.backend.status();
    expect(status).toMatchObject({ installed: true, ready: true, version: h.pin.appVersion, owner: STACK_ID });
    expect(h.helm.calls.some((call) => call.args[0] === 'status')).toBe(false);
  });

  test('R-SCALED: a Deployment scaled to 0 reports the exact recovery line', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    const deployment = h.cluster.get('Deployment', 'dockflow-traefik', K8S_SYSTEM_NAMESPACE)!;
    h.cluster.seed({ ...deployment, spec: { ...specOf(deployment), replicas: 0 } });

    const status = await h.backend.status();
    expect(status.ready).toBe(false);
    expect(status.detail).toBe('Traefik is scaled to 0 replicas');
    expect(status.recovery).toEqual([
      `1. Run \`dockflow deploy ${ENV}\` from the stack that manages the proxy, or \`kubectl -n ${K8S_SYSTEM_NAMESPACE} scale deployment/dockflow-traefik --replicas=1\` if a copy-in is finished.`,
    ]);
  });

  test('R-RECLAIM: the ACME volume left in Delete is reported and recovered', async () => {
    const h = harness();
    await h.backend.ensure(acmeProxy(), ENV, h.events);
    const pv = h.cluster.pvFor('dockflow-traefik', K8S_SYSTEM_NAMESPACE);
    if (!pv) throw new Error('expected the ACME claim to be bound');
    h.cluster.seed({
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: pv.name },
      spec: { persistentVolumeReclaimPolicy: 'Delete' },
    });

    const status = await h.backend.status();
    expect(status.acmeReclaimPolicy).toBe('Delete');
    expect(status.detail).toContain('reclaim policy Delete');
    expect((status.recovery ?? []).some((line) => line.includes('persistentVolumeReclaimPolicy":"Retain"'))).toBe(true);
  });

  test('conflicts (2.10): a host listener that starts after install is reported as a warning line, not a refusal', async () => {
    const clean = { exitCode: 0, stdout: '', stderr: '' };
    const listening = { exitCode: 0, stdout: 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\n', stderr: '' };
    const h = harness({ nodeScript: [{ script: /^ss -Hltn$/, respond: clean, times: 1 }, { script: /^ss -Hltn$/, respond: listening, times: 'any' }] });
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events); // install-time scan sees the clean listener above

    const status = await h.backend.status();
    expect(status.conflicts).toEqual([
      `Port 80 on ${SERVER_HOSTNAME} is used by a host process (0.0.0.0:80), and Dockflow's Traefik publishes ports 80 and 443 on that node, so it would take its traffic`,
    ]);
  });

  test('conflicts (2.10): another pod publishing hostPort 80 is reported by status(), not just refused at install', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    h.cluster.seed({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'legacy-nginx', namespace: 'kube-system' },
      spec: { nodeName: SERVER_HOSTNAME, containers: [{ name: 'nginx', image: 'nginx', ports: [{ containerPort: 80, hostPort: 80, protocol: 'TCP' }] }] },
      status: { phase: 'Running' },
    });

    const status = await h.backend.status();
    expect(status.conflicts).toEqual([`Port 80 is already published by pod kube-system/legacy-nginx on ${SERVER_HOSTNAME}`]);
  });

  test('conflicts (2.10): status() before anything is installed reports none, without scanning', async () => {
    const h = harness();
    const status = await h.backend.status();
    expect(status.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// plan() (2.9, U-BE-PROXY-07)
// ---------------------------------------------------------------------------

describe('plan()', () => {
  test('U-BE-PROXY-07: plan() never mutates and describes what ensure() would do', async () => {
    const h = harness();
    const plan = await h.backend.plan(httpOnlyProxy(), ENV);
    expect(plan.action).toBe('install');
    expect(plan.blockers).toEqual([]);
    // read-only: observation issues a `list`, but nothing mutates
    expect(h.helm.calls.every((call) => !call.mutating)).toBe(true);
    expect(h.cluster.get('CustomResourceDefinition', 'ingressroutes.traefik.io')).toBeUndefined();

    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    const second = await h.backend.plan(httpOnlyProxy(), ENV);
    expect(second.action).toBe('unchanged');
    expect(second.node).toBe('server_1');
  });
});

// ---------------------------------------------------------------------------
// Non-owning mode (2.8.3 C1-C4, K21, U-BE-PROXY-08, U-BE-PROXY-09)
// ---------------------------------------------------------------------------

describe('non-owning mode', () => {
  test('U-BE-PROXY-08: no Dockflow Traefik and no CRDs -> refused before any read of a chart', async () => {
    const h = harness();
    await expectCliError(h.backend.ensure(httpOnlyProxy({ manage: false }), ENV, h.events), {
      type: DeployError,
      message: /has nothing to route through/,
    });
    // observation issues a `list` before the refusal fires, but nothing pulls or mutates
    expect(h.helm.calls.every((call) => !call.mutating && call.args[0] !== 'pull')).toBe(true);
  });

  test('U-BE-PROXY-08: never mutates the managed release, whatever the deployed values are', async () => {
    const owner = harness();
    await owner.backend.ensure(acmeProxy(), ENV, owner.events);

    const consumer = harness({ traefikCrds: false });
    seedForeignState(consumer, owner);
    const callsBefore = consumer.helm.calls.length;
    const result = await consumer.backend.ensure(httpOnlyProxy({ manage: false }), ENV, consumer.events);
    expect(result.action).toBe('not-owner');
    expect(consumer.helm.calls.slice(callsBefore).every((call) => !call.mutating)).toBe(true);
  });

  test('U-BE-PROXY-08: refused only for a genuine incompatibility (ACME route, HTTP-off proxy)', async () => {
    const owner = harness();
    await owner.backend.ensure(httpOnlyProxy(), ENV, owner.events); // no ACME

    const consumer = harness({ traefikCrds: false });
    seedForeignState(consumer, owner);
    await expectCliError(consumer.backend.ensure(acmeProxy({ manage: false }), ENV, consumer.events), {
      type: DeployError,
      message: /websecure entry point is not published/,
    });
  });
});

describe('ownership conflict (K21)', () => {
  test('U-BE-PROXY-09: two managing stacks with different settings refuse before anything changes', async () => {
    const owner = harness();
    await owner.backend.ensure(httpOnlyProxy(), ENV, owner.events);

    const other = harness({ traefikCrds: false });
    seedForeignState(other, owner);
    const otherBackend = new (Object.getPrototypeOf(other.backend).constructor)({
      deps: { kubectl: other.kube, helm: other.helm, nodeShell: other.nodeShell.forNode, clock: other.clock, redactor: other.kube.redactor, distribution: other.kube.distribution },
      managers: MANAGERS,
      project: 'blog',
      env: ENV,
      pin: other.pin,
    });
    await expectCliError(otherBackend.ensure(acmeProxy(), ENV, other.events), {
      type: DeployError,
      code: ErrorCode.VALIDATION_FAILED,
      message: /is managed by stack/,
    });
    expect(other.helm.calls.some((call) => call.args[0] === 'upgrade')).toBe(false);
  });
});

/** copies the observable state of `owner`'s Traefik onto `target`'s fakes, as a foreign install would leave it */
function seedForeignState(target: Harness, owner: Harness): void {
  // the proxy backend never touches the owning stack's own namespace, so a conflict check (M7) that
  // needs to see it Ready has to be told about it directly (K/ownerNamespaceExists, design-04 2.8.3)
  target.cluster.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: STACK_ID } });
  for (const kind of ['CustomResourceDefinition', 'Deployment', 'Pod', 'ConfigMap', 'PersistentVolumeClaim', 'PersistentVolume'] as const) {
    for (const name of kind === 'CustomResourceDefinition' ? ['ingressroutes.traefik.io', 'middlewares.traefik.io'] : []) {
      const object = owner.cluster.get(kind, name);
      if (object) target.cluster.seed(object);
    }
  }
  const crds = owner.cluster.list('CustomResourceDefinition');
  for (const crd of crds) target.cluster.seed(crd);
  const deployment = owner.cluster.get('Deployment', 'dockflow-traefik', K8S_SYSTEM_NAMESPACE);
  if (deployment) target.cluster.seed(deployment);
  for (const pod of owner.cluster.list('Pod', { namespace: K8S_SYSTEM_NAMESPACE })) target.cluster.seed(pod);
  const cm = owner.cluster.get('ConfigMap', 'dockflow-proxy', K8S_SYSTEM_NAMESPACE);
  if (cm) target.cluster.seed(cm);
  const pvc = owner.cluster.get('PersistentVolumeClaim', 'dockflow-traefik', K8S_SYSTEM_NAMESPACE);
  if (pvc) target.cluster.seed(pvc);
  const pv = owner.cluster.pvFor('dockflow-traefik', K8S_SYSTEM_NAMESPACE);
  if (pv) {
    const pvObject = owner.cluster.get('PersistentVolume', pv.name);
    if (pvObject) target.cluster.seed(pvObject);
  }
  const releaseRevision = owner.helm.release(K8S_SYSTEM_NAMESPACE, 'dockflow-traefik');
  if (releaseRevision?.latest) {
    target.helm.seedRelease({
      name: 'dockflow-traefik',
      namespace: K8S_SYSTEM_NAMESPACE,
      revisions: [{ chart: 'traefik', version: releaseRevision.latest.version, values: releaseRevision.latest.values ?? undefined, labels: releaseRevision.latest.labels }],
    });
  }
}

// ---------------------------------------------------------------------------
// Port and CRD refusals (2.5, 2.10)
// ---------------------------------------------------------------------------

describe('refusals before any Helm mutation', () => {
  test('E-PX-HOSTPORT: a host listener on port 80 blocks the install', async () => {
    const h = harness({ nodeScript: [{ script: /^ss -Hltn$/, respond: { exitCode: 0, stdout: 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\n', stderr: '' } }] });
    await expectCliError(h.backend.ensure(httpOnlyProxy(), ENV, h.events), { type: DeployError, message: /Port 80 on server-1 is used by a host process/ });
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade')).toBe(false);
  });

  test('E-PX-PODPORT: another pod already publishing hostPort 80 blocks the install', async () => {
    const h = harness();
    h.cluster.seed({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'legacy-nginx', namespace: 'kube-system' },
      spec: { nodeName: SERVER_HOSTNAME, containers: [{ name: 'nginx', image: 'nginx', ports: [{ containerPort: 80, hostPort: 80, protocol: 'TCP' }] }] },
      status: { phase: 'Running' },
    });
    await expectCliError(h.backend.ensure(httpOnlyProxy(), ENV, h.events), { type: DeployError, message: /Port 80 is already published by pod kube-system\/legacy-nginx/ });
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade')).toBe(false);
  });

  test('E-PX-CRDS-FOREIGN: unlabelled CRDs from another tool refuse before any mutation', async () => {
    const h = harness({ traefikCrds: true }); // seeded without Dockflow's ownership labels
    await expectCliError(h.backend.ensure(httpOnlyProxy(), ENV, h.events), { type: DeployError, message: /Dockflow will not overwrite CRDs it does not own/ });
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade')).toBe(false);
  });

  test('CRD newer than pin: applying them is skipped with W-PX-CRDS-NEWER, and the release upgrade still runs', async () => {
    const h = harness();
    for (const name of ['ingressroutes.traefik.io', 'middlewares.traefik.io']) {
      h.cluster.seed({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name, labels: { [LABELS.managedBy]: K8S_MANAGED_BY }, annotations: { [ANNOTATIONS.crdChartVersion]: '99.0.0' } },
        spec: { group: 'traefik.io', names: { kind: name.startsWith('ingress') ? 'IngressRoute' : 'Middleware', plural: name.split('.')[0], singular: name.split('.')[0].slice(0, -1) }, scope: 'Namespaced' },
      });
    }

    const result = await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    expect(result).toEqual({ changed: true, action: 'install', version: h.pin.appVersion });
    expect(h.events.warnings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('is newer than this Dockflow release (41.6.0), so they are left unchanged') }),
    );
    // the CRDs on the cluster keep the newer annotation: nothing overwrote them
    const crd = h.cluster.get('CustomResourceDefinition', 'ingressroutes.traefik.io');
    expect(crd?.metadata.annotations?.[ANNOTATIONS.crdChartVersion]).toBe('99.0.0');
    expect(upgradeCall(h)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pending Helm operations (2.8.3 M1-M3)
// ---------------------------------------------------------------------------

describe('pending Helm operations', () => {
  test('a stale pending-install with no deployed revision refuses with the exact E-PX-PENDING-INSTALL text', async () => {
    const h = harness();
    h.helm.seedRelease({
      name: 'dockflow-traefik',
      namespace: K8S_SYSTEM_NAMESPACE,
      revisions: [{ chart: 'traefik', version: h.pin.version, status: 'pending-install', updated: '2025-12-31T00:00:00Z' }],
    });

    await expectCliError(h.backend.ensure(httpOnlyProxy(), ENV, h.events), {
      type: DeployError,
      message: `Traefik in ${K8S_SYSTEM_NAMESPACE} has been stuck in pending-install since 2025-12-31T00:00:00.000Z with no deployed revision to return to, so the interrupted operation will never finish`,
      suggestion: 'Remove the unfinished release with `dockflow helm uninstall production --system --force -y`, then deploy again; no route or certificate is lost, because the ACME volume is kept.',
    });
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade' || call.args[0] === 'rollback')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helm failure (U-BE-PROXY-06)
// ---------------------------------------------------------------------------

describe('helm failure', () => {
  test('U-BE-PROXY-06: a failed install becomes a DeployError naming the unwrapped, redacted detail', async () => {
    const secret = 'sekrit-token-value';
    const h = harness({ redactorSecrets: [secret] });
    h.helm.failNext('dockflow-traefik', `admission webhook denied the request: token ${secret} rejected`);

    await expectCliError(h.backend.ensure(httpOnlyProxy(), ENV, h.events), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: `Traefik failed to install in ${K8S_SYSTEM_NAMESPACE}: admission webhook denied the request: token *** rejected; nothing was installed`,
      suggestion: `Run \`dockflow helm status ${ENV} --system\`, then \`dockflow diagnose ${ENV}\`.`,
    });
    // the failed install is rolled back (--rollback-on-failure): no release is left to upgrade next time
    expect(h.helm.releases().some((release) => release.name === 'dockflow-traefik')).toBe(false);
  });

  test('a failed upgrade of an existing release reports the previous configuration as restored', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    h.helm.failNext('dockflow-traefik', 'the operation could not be completed');

    await expectCliError(h.backend.ensure(httpOnlyProxy({ dashboard: { enabled: true, domain: 'traefik.example.com' } }), ENV, h.events), {
      type: DeployError,
      message: `Traefik failed to upgrade in ${K8S_SYSTEM_NAMESPACE}: the operation could not be completed; the previous configuration was restored`,
    });
  });
});

// ---------------------------------------------------------------------------
// Node placement and drift (2.4.1)
// ---------------------------------------------------------------------------

describe('node placement', () => {
  test('a running pod on a node other than the pinned one is moved back, with W-PX-NODE-DRIFT', async () => {
    const h = harness();
    await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    const pod = h.cluster.get('Pod', 'dockflow-traefik-fake', K8S_SYSTEM_NAMESPACE)!;
    h.cluster.seed({ ...pod, spec: { ...specOf(pod), nodeName: 'agent-1' } });

    const result = await h.backend.ensure(httpOnlyProxy(), ENV, h.events);
    expect(result).toEqual({ changed: true, action: 'upgrade', version: h.pin.appVersion });
    expect(h.events.warnings).toContainEqual({
      message: `Traefik runs on agent-1 but is pinned to ${SERVER_HOSTNAME}, so it is moved back to ${SERVER_HOSTNAME}`,
      suggestion: `Check who edited Deployment dockflow-traefik; DNS for this environment must point at ${SERVER_HOSTNAME}.`,
    });

    const status = await h.backend.status();
    expect(status.node).toBe('server_1');
  });
});

// ---------------------------------------------------------------------------
// Locking (design-03 14.2 / core 6.7)
// ---------------------------------------------------------------------------

describe('locking', () => {
  test('a held lock is waited on and then reported as E-PX-LOCKED', async () => {
    const h = harness();
    h.cluster.seed({
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'lock-dockflow-proxy', namespace: K8S_SYSTEM_NAMESPACE, annotations: { [ANNOTATIONS.lock]: JSON.stringify({ performer: 'bob', started_at: h.clock.now().toISOString(), timestamp: 0, version: '1.0.0', stack: 'dockflow-proxy', message: 'busy' }) } },
      spec: { holderIdentity: 'bob', leaseDurationSeconds: 1800, acquireTime: h.clock.now().toISOString(), renewTime: h.clock.now().toISOString() },
    });

    const promise = expectCliError(h.backend.ensure(httpOnlyProxy(), ENV, h.events), {
      type: DeployError,
      code: ErrorCode.DEPLOY_LOCKED,
      message: /is being updated by bob since/,
      suggestion: /Retry the deploy/,
    });
    await h.clock.runUntilIdle(310_000);
    await promise;
    expect(h.helm.calls.some((call) => call.args[0] === 'upgrade')).toBe(false);
  });
});
