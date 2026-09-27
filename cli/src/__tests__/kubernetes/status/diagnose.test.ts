import { describe, expect, it } from 'bun:test';
import type { DiagnosticLineLevel, DiagnosticReport, ProxyStatus } from '../../../services/orchestrator/interfaces';
import type { ControllerRevision, Deployment, ReplicaSet } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Event, Namespace, Node, PersistentVolumeClaim, Pod } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  analyzeError,
  buildDiagnosticReport,
  CRASH_LOG_CONTAINERS,
  crashLogTargets,
  type DiagnoseHelmRelease,
  type DiagnoseHostFacts,
  type DiagnoseInput,
  describeTargets,
  KUBERNETES_FALLBACK_SUGGESTION,
  parseDfLine,
  parsePercent,
  SWARM_FALLBACK_SUGGESTION,
} from '../../../services/orchestrator/kubernetes/status/diagnose';
import {
  buildInventoryView,
  type HelmReleaseWorkloads,
  type InventoryObject,
  type InventoryView,
  nodeToServerMap,
  type RevisionIndex,
} from '../../../services/orchestrator/kubernetes/status/pods';
import { err, ok } from '../../../types/result';
import { Redactor } from '../../../utils/redact';
import { FIXTURE_SERVERS, fixtureCaptureTime, fixtureNamespace, loadKubectlList, loadKubectlResources } from '../support/kubectl-fixtures';

const P = 'dockflow.shawiizz.dev';
/** `now` of the hand-built events, all read with the rollout-complete capture */
const NOW = fixtureCaptureTime('rollout-complete');
const SERVERS = nodeToServerMap(Object.values(FIXTURE_SERVERS));
const SECRET = 's3cr3t-token-value';
const INVENTORY_RESOURCES = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'pods',
  'services',
  'persistentvolumeclaims',
] as const;
const LEVELS: readonly DiagnosticLineLevel[] = ['ok', 'warning', 'error', 'pending', 'dim', 'plain'];

const HOST_OK: DiagnoseHostFacts = {
  rootDisk: ok('/dev/sda1       41152736 12345678  26703112  32% /'),
  volumeDisk: null,
  memory: ok('41'),
};

function inventoryOf(scenario: string, helm: HelmReleaseWorkloads[] = []): InventoryView {
  const list = loadKubectlResources<InventoryObject>(scenario, INVENTORY_RESOURCES);
  return buildInventoryView(fixtureNamespace(scenario), list.items, helm);
}

function revisionsOf(scenario: string): RevisionIndex {
  return {
    replicaSets: loadKubectlList<ReplicaSet>(scenario, 'replicasets.apps').items,
    controllerRevisions: loadKubectlList<ControllerRevision>(scenario, 'controllerrevisions.apps').items,
  };
}

/** What `get events --field-selector type=Warning` returns. */
function warningEvents(scenario: string): Event[] {
  return loadKubectlList<Event>(scenario, 'events').items.filter((e) => e.type === 'Warning');
}

function namespaceObject(name: string, extra: Partial<Namespace> = {}): Namespace {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name }, status: { phase: 'Active' }, ...extra };
}

function diagnoseInput(scenario: string, overrides: Partial<DiagnoseInput> = {}): DiagnoseInput {
  const namespace = fixtureNamespace(scenario);
  return {
    env: 'production',
    namespace,
    namespaceObject: namespaceObject(namespace),
    currentRelease: '1.4.2',
    verbose: false,
    inventory: ok(inventoryOf(scenario)),
    revisions: revisionsOf(scenario),
    helmReleases: ok([]),
    events: ok(warningEvents(scenario)),
    nodes: ok(loadKubectlList<Node>(scenario, 'nodes').items),
    proxy: null,
    crashLogs: [],
    descriptions: [],
    host: HOST_OK,
    nodeToServer: SERVERS,
    redactor: new Redactor([SECRET]),
    ...overrides,
  };
}

/** read as `dockflow diagnose` would have read it right after the capture */
function diagnose(scenario: string, overrides: Partial<DiagnoseInput> = {}): DiagnosticReport {
  return buildDiagnosticReport(diagnoseInput(scenario, overrides), fixtureCaptureTime(scenario));
}

function titles(report: DiagnosticReport): string[] {
  return report.sections.map((s) => s.title);
}

function linesOf(report: DiagnosticReport, title: string): [DiagnosticLineLevel, string][] {
  const section = report.sections.find((s) => s.title === title);
  if (!section) throw new Error(`no section ${title} in ${titles(report).join(', ')}`);
  return section.lines.map((l) => [l.level, l.text]);
}

function issuesOf(report: DiagnosticReport, category: string) {
  return report.issues.filter((i) => i.category === category);
}

function withPods(inventory: InventoryView, pods: Pod[]): InventoryView {
  return { ...inventory, pods };
}

function podOf(inventory: InventoryView, name: string): Pod {
  const pod = inventory.pods.find((p) => p.metadata.name === name);
  if (!pod) throw new Error(`no pod ${name}`);
  return pod;
}

function event(name: string, reason: string, message: string, at: { last?: string; eventTime?: string }, kind = 'Pod'): Event {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `${name}.${reason}.${at.last ?? at.eventTime}` },
    involvedObject: { kind, name },
    type: 'Warning',
    reason,
    message,
    ...(at.last ? { lastTimestamp: at.last } : {}),
    ...(at.eventTime ? { eventTime: at.eventTime } : {}),
  };
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------

describe('Stack Status', () => {
  it('a missing namespace ends the report with the Stack not found issue', () => {
    const report = diagnose('crashloop', { namespaceObject: null });
    expect(report).toEqual({
      sections: [{ title: 'Stack Status', lines: [{ level: 'error', text: 'Namespace fixture-crashloop does not exist' }] }],
      issues: [
        { severity: 'error', category: 'Stack', message: 'Stack not found', suggestion: 'Deploy the stack with: `dockflow deploy production`.' },
      ],
    });
  });

  it('a namespace being deleted lists its finalizers and the report continues', () => {
    const ns = namespaceObject('fixture-crashloop', {
      metadata: { name: 'fixture-crashloop', finalizers: [`${P}/cleanup`] },
      spec: { finalizers: ['kubernetes'] },
      status: { phase: 'Terminating' },
    });
    const report = diagnose('crashloop', { namespaceObject: ns });
    expect(linesOf(report, 'Stack Status')).toEqual([
      ['error', 'Namespace fixture-crashloop is being deleted'],
      ['plain', `  Finalizers: kubernetes, ${P}/cleanup`],
    ]);
    expect(issuesOf(report, 'Stack')).toEqual([
      {
        severity: 'error',
        category: 'Stack',
        message: 'Namespace fixture-crashloop is being deleted',
        suggestion: 'Wait for the deletion to finish, then deploy again with: `dockflow deploy production`.',
      },
    ]);
    expect(titles(report)).toContain('Services');
  });

  it('names the current app release when known', () => {
    expect(linesOf(diagnose('rollout-complete'), 'Stack Status')).toEqual([['ok', 'Namespace fixture-rollout-complete exists (app release 1.4.2)']]);
    expect(linesOf(diagnose('rollout-complete', { currentRelease: null }), 'Stack Status')).toEqual([
      ['ok', 'Namespace fixture-rollout-complete exists'],
    ]);
  });
});

describe('healthy stack', () => {
  it('reports no issue', () => {
    const report = diagnose('rollout-complete');
    expect(report.issues).toEqual([]);
    expect(titles(report)).toEqual([
      'Stack Status',
      'Services',
      'Rollouts',
      'Pod Errors',
      'Pending Pods',
      'Volumes',
      'Warning Events',
      'Cluster Nodes',
      'System Resources',
    ]);
    expect(linesOf(report, 'Services')).toEqual([['ok', 'web: 3/3 replicas']]);
    expect(linesOf(report, 'Rollouts')).toEqual([['ok', 'web: rolled out (revision 2)']]);
    expect(linesOf(report, 'Pod Errors')).toEqual([['ok', 'No pod errors found']]);
    expect(linesOf(report, 'Pending Pods')).toEqual([['plain', 'No pending pods']]);
    expect(linesOf(report, 'Volumes')).toEqual([['plain', 'No volumes']]);
    // each new pod's first readiness probe runs before nginx listens: warnings of the rollout, no issue
    const refused = (ip: string) => `Unhealthy: Readiness probe failed: Get "http://${ip}:80/": dial tcp ${ip}:80: connect: connection refused`;
    expect(linesOf(report, 'Warning Events')).toEqual([
      ['warning', `43s Pod/web-b655d585b-vnpn8 ${refused('10.42.1.31')}`],
      ['warning', `1m Pod/web-b655d585b-7jdgc ${refused('10.42.0.60')}`],
      ['warning', `1m Pod/web-b655d585b-zjqjv ${refused('10.42.1.30')}`],
      ['warning', `2m Pod/web-c8998f889-l8mjc ${refused('10.42.0.50')}`],
      ['warning', `2m Pod/web-c8998f889-mm4gg ${refused('10.42.1.28')}`],
    ]);
    expect(linesOf(report, 'Cluster Nodes')).toEqual([
      ['ok', 'agent_1 Ready (worker) v1.36.4+k3s1'],
      ['ok', 'server_1 Ready (manager) v1.36.4+k3s1'],
    ]);
    expect(linesOf(report, 'System Resources')).toEqual([
      ['ok', 'Disk usage (/): 32%'],
      ['ok', 'Memory usage: 41%'],
    ]);
  });

  it('every line carries a level the printer colours from (U-STATUS-DIAG-03)', () => {
    const scenarios = ['rollout-complete', 'crashloop', 'node-not-ready', 'pvc-pending-rwx', 'unschedulable-resources', 'metrics-top'];
    for (const scenario of scenarios) {
      const report = diagnose(scenario, { verbose: true });
      for (const section of report.sections) {
        for (const line of section.lines) {
          expect(LEVELS).toContain(line.level);
          expect(line.text).not.toMatch(/^[✓✗!○·] /);
        }
      }
    }
  });

  it('lists helper pods in their own section', () => {
    expect(linesOf(diagnose('metrics-top'), 'Helper Pods')).toEqual([['dim', 'dockflow-helper-backup-3f9a2c1b: Running']]);
  });

  it('names accessory and Helm rows in Services', () => {
    const inventory = inventoryOf('metrics-top');
    const chart: Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'search-api', labels: { 'app.kubernetes.io/instance': 'search' } },
      spec: { replicas: 1, selector: {}, template: { metadata: {}, spec: { containers: [{ name: 'api', image: 'search:2.4.1' }] } } },
      status: { observedGeneration: 0, replicas: 1, updatedReplicas: 1, readyReplicas: 1 },
    };
    const helm: HelmReleaseWorkloads[] = [{ release: 'search', role: 'app', namespace: inventory.namespace, workloads: [{ kind: 'Deployment', name: 'search-api' }] }];
    const withChart = buildInventoryView(inventory.namespace, [...inventory.workloads, chart, ...inventory.pods], helm);
    const report = diagnose('metrics-top', { inventory: ok(withChart) });
    expect(linesOf(report, 'Services')).toEqual([
      ['ok', 'web: 2/2 replicas'],
      ['ok', 'search (helm): 1/1 replicas'],
      ['ok', 'db (accessory): 1/1 replicas'],
    ]);
    expect(linesOf(report, 'Rollouts')).toEqual([
      ['ok', 'search (deployment/search-api): rolled out'],
      ['ok', 'web: rolled out (revision 1)'],
    ]);
  });
});

describe('pod errors', () => {
  const crashSuggestion =
    'Inspect it with `dockflow logs production web_app --all-tasks` and `dockflow diagnose production --verbose`.';

  it('reports a crash-looping pod by its compose label (U-STATUS-DIAG-01)', () => {
    const report = diagnose('crashloop');
    // k3s 1.36 keeps the container terminated between restarts: its latest exit is the error
    const message = 'Error (exit 1) at 2026-01-01T00:01:32Z';
    expect(linesOf(report, 'Pod Errors')).toEqual([
      ['error', 'web_app.dqwf8 (pod web-app-fbf7d977d-dqwf8 on server_1)'],
      ['plain', '  State: Error (restarts 3)'],
      ['plain', `  Error: ${message}`],
    ]);
    expect(issuesOf(report, 'Pod')).toEqual([{ severity: 'error', category: 'Pod', message: `web_app.dqwf8: ${message}`, suggestion: crashSuggestion }]);
    expect(issuesOf(report, 'Replicas')).toEqual([
      { severity: 'error', category: 'Replicas', message: "Service 'web_app' has 0/1 replicas", suggestion: 'Check the pod errors below.' },
    ]);
    expect(linesOf(report, 'Services')).toEqual([['error', 'web_app: 0/1 replicas']]);
    expect(linesOf(report, 'Warning Events')).toEqual([
      [
        'warning',
        '0s Pod/web-app-fbf7d977d-dqwf8 BackOff: Back-off restarting failed container web-app in pod web-app-fbf7d977d-dqwf8_fixture-crashloop(00000000-0000-4000-8000-000000000003)',
      ],
    ]);
    expect(titles(report)).not.toContain('Crash Logs');
    expect(titles(report)).not.toContain('Describe');
  });

  it('adds crash logs and descriptions with --verbose', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1} ${i === 24 ? SECRET : ''}`.trim());
    const report = diagnose('crashloop', {
      verbose: true,
      crashLogs: [{ label: 'web_app.dqwf8', container: 'web-app', previous: true, lines }],
      descriptions: [{ label: 'web_app.dqwf8', text: `Name: web-app-fbf7d977d-dqwf8\nEnvironment:\n  TOKEN: ${SECRET}\n\n` }],
    });
    const crash = linesOf(report, 'Crash Logs');
    expect(crash[0]).toEqual(['dim', '(container output, may contain sensitive data)']);
    expect(crash[1]).toEqual(['dim', 'web_app.dqwf8 (previous run):']);
    expect(crash.slice(2).map(([, text]) => text)).toEqual(lines.slice(5).map((l) => `    ${l}`));
    // container output is user-requested and not redacted; describe output is
    expect(linesOf(report, 'Describe')).toEqual([
      ['dim', 'web_app.dqwf8:'],
      ['plain', '    Name: web-app-fbf7d977d-dqwf8'],
      ['plain', '    Environment:'],
      ['plain', '      TOKEN: ***'],
    ]);
  });

  it('says so when --verbose finds no crashed container', () => {
    const report = diagnose('rollout-complete', { verbose: true });
    expect(linesOf(report, 'Crash Logs')).toEqual([['plain', 'No crashed containers']]);
    expect(titles(report)).not.toContain('Describe');
  });

  it('picks crash-log and describe targets', () => {
    const inventory = inventoryOf('crashloop');
    // stopped after its crash: the plain log is that run, `--previous` would be the one before
    expect(crashLogTargets(inventory)).toEqual([
      { pod: 'web-app-fbf7d977d-dqwf8', container: 'web-app', label: 'web_app.dqwf8', previous: false },
    ]);
    expect(describeTargets(inventory)).toEqual([{ pod: 'web-app-fbf7d977d-dqwf8', label: 'web_app.dqwf8' }]);
    expect(crashLogTargets(inventoryOf('rollout-complete'))).toEqual([]);
    expect(describeTargets(inventoryOf('rollout-complete'))).toEqual([]);

    const base = podOf(inventory, 'web-app-fbf7d977d-dqwf8');
    const [status] = base.status?.containerStatuses ?? [];
    if (!status) throw new Error('no container status');
    const runsAgain = withPods(inventory, [{ ...base, status: { ...base.status, containerStatuses: [{ ...status, state: { running: {} } }] } }]);
    expect(crashLogTargets(runsAgain).map((t) => t.previous)).toEqual([true]);

    const many = Array.from({ length: 7 }, (_, i) => ({ ...base, metadata: { ...base.metadata, name: `web-app-fbf7d977d-c${i}` } }));
    const crowded = withPods(inventory, many);
    expect(crashLogTargets(crowded).map((t) => t.pod)).toEqual(many.slice(0, CRASH_LOG_CONTAINERS).map((p) => p.metadata.name));
    expect(describeTargets(crowded)).toHaveLength(3);
  });

  it('suggests re-importing a missing Dockflow-built image', () => {
    const report = diagnose('err-image-never-pull');
    expect(issuesOf(report, 'Pod')).toMatchObject([
      {
        severity: 'error',
        message: 'web.p9gx9: Container image "dockflow.invalid/shop-web:1.4.2" is not present with pull policy of Never',
        suggestion: 'The image built by Dockflow is missing on that node; import it again with: `dockflow deploy production`.',
      },
    ]);

    const inventory = inventoryOf('image-pull-backoff');
    const pod = podOf(inventory, 'web-679ff8548-l5hvb');
    const imported: Pod = {
      ...pod,
      status: {
        ...pod.status,
        containerStatuses: (pod.status?.containerStatuses ?? []).map((c) => ({
          ...c,
          state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "dockflow.invalid/shop-web:1.4.2"' } },
        })),
      },
    };
    const backoff = diagnose('image-pull-backoff', { inventory: ok(withPods(inventory, [imported])), events: ok([]) });
    expect(issuesOf(backoff, 'Pod')[0]?.suggestion).toBe(
      'The image built by Dockflow is missing on that node; import it again with: `dockflow deploy production`.',
    );
  });

  it('suggests checking the name and tag of a public image', () => {
    const report = diagnose('image-pull-backoff');
    expect(issuesOf(report, 'Pod')).toMatchObject([
      {
        severity: 'error',
        suggestion: 'Check the image name and tag; for a private registry, check the registry credentials in config.yml.',
      },
    ]);
    expect(linesOf(report, 'Pod Errors')[1]).toEqual(['plain', '  State: ImagePullBackOff (restarts 0)']);
  });

  it('names the missing Secret case', () => {
    expect(issuesOf(diagnose('create-container-config-error'), 'Pod')[0]?.suggestion).toBe(
      'A Secret or ConfigMap Dockflow created is missing; run `dockflow deploy production` again.',
    );
  });

  it('points an OOMKilled container at its memory limit', () => {
    expect(issuesOf(diagnose('oom-killed'), 'Pod')[0]?.suggestion).toBe(
      'Raise `deploy.resources.limits.memory` for this service; the container ran out of memory.',
    );
  });

  it('reports an evicted pod with the eviction message', () => {
    const report = diagnose('evicted-pod');
    const [first] = issuesOf(report, 'Pod');
    expect(first?.message).toStartWith('web.hxqlb: ');
    expect(linesOf(report, 'Pod Errors')[1]).toEqual(['plain', '  State: Evicted (restarts 0)']);
  });

  it('shows at most 10 failing pods', () => {
    const inventory = inventoryOf('crashloop');
    const base = podOf(inventory, 'web-app-fbf7d977d-dqwf8');
    const pods = Array.from({ length: 12 }, (_, i) => ({ ...base, metadata: { ...base.metadata, name: `web-app-fbf7d977d-x${String(i).padStart(2, '0')}` } }));
    const report = diagnose('crashloop', { inventory: ok(withPods(inventory, pods)) });
    expect(issuesOf(report, 'Pod')).toHaveLength(10);
    expect(linesOf(report, 'Pod Errors').at(-1)).toEqual(['dim', '... and 2 more']);
  });

  it('redacts pod errors and event messages', () => {
    const inventory = inventoryOf('crashloop');
    const pod = podOf(inventory, 'web-app-fbf7d977d-dqwf8');
    const leaking: Pod = {
      ...pod,
      status: {
        ...pod.status,
        containerStatuses: [
          {
            name: 'web-app',
            ready: false,
            restartCount: 0,
            image: 'busybox:1.37',
            state: { waiting: { reason: 'CreateContainerConfigError', message: `couldn't find key ${SECRET} in Secret` } },
          },
        ],
      },
    };
    const events = [event('web-app-fbf7d977d-dqwf8', 'Failed', `Error: value ${SECRET} rejected`, { last: minutesAgo(1) })];
    const report = diagnose('crashloop', { inventory: ok(withPods(inventory, [leaking])), events: ok(events) });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(issuesOf(report, 'Pod')[0]?.message).toBe("web_app.dqwf8: couldn't find key *** in Secret");
  });
});

describe('pending pods', () => {
  it('reports FailedScheduling with Insufficient memory as a Scheduling warning', () => {
    const report = diagnose('unschedulable-resources');
    const message = '0/2 nodes are available: 2 Insufficient memory. no new claims to deallocate, preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.';
    expect(linesOf(report, 'Pending Pods')).toEqual([['pending', `web.jhghd: ${message}`]]);
    expect(linesOf(report, 'Pod Errors')).toEqual([['ok', 'No pod errors found']]);
    expect(issuesOf(report, 'Scheduling')).toEqual([
      {
        severity: 'warning',
        category: 'Scheduling',
        message: 'Some pods cannot be scheduled',
        suggestion: 'Lower `deploy.resources.reservations` or add nodes; the request exceeds the free node capacity.',
      },
    ]);
    expect(issuesOf(report, 'Pod')).toEqual([]);
  });

  it('suggests checking placement when no node matches the selector', () => {
    expect(issuesOf(diagnose('unschedulable-node-selector'), 'Scheduling')[0]?.suggestion).toBe(
      'Check the placement constraints (`node.hostname`, `node.labels`, `x-dockflow.node_selector`); no node matches them.',
    );
  });

  it('lists a scheduled pod still waiting without a Scheduling issue', () => {
    const report = diagnose('pvc-pending-rwx');
    expect(linesOf(report, 'Pending Pods')).toEqual([['pending', 'web.khslt: Pending']]);
    expect(issuesOf(report, 'Scheduling')).toEqual([]);
  });
});

describe('volumes', () => {
  it('reports a Pending claim and its ProvisioningFailed event', () => {
    const report = diagnose('pvc-pending-rwx');
    // a top-level volume has no service label: the one service mounting it is named
    const fallback = 'Inspect it with `dockflow logs production web --all-tasks` and `dockflow diagnose production --verbose`.';
    expect(linesOf(report, 'Volumes')).toEqual([['warning', 'shared Pending']]);
    expect(issuesOf(report, 'Volume')).toEqual([
      { severity: 'warning', category: 'Volume', message: 'Volume shared is not bound', suggestion: fallback },
      {
        severity: 'error',
        category: 'Volume',
        message:
          'Volume shared: failed to provision volume with StorageClass "dockflow-local": NodePath only supports ReadWriteOnce and ReadWriteOncePod (1.22+) access modes',
        suggestion: fallback,
      },
    ]);
  });

  it('names no service for a claim several services mount', () => {
    const items = loadKubectlResources<InventoryObject>('pvc-pending-rwx', INVENTORY_RESOURCES).items;
    const web = items.find((i): i is Deployment => i.kind === 'Deployment');
    const pod = items.find((i): i is Pod => i.kind === 'Pod');
    if (!web || !pod) throw new Error('no web Deployment or pod');
    const api: Deployment = {
      ...web,
      metadata: {
        ...web.metadata,
        name: 'api',
        labels: { ...web.metadata.labels, [`${P}/service`]: 'api' },
        annotations: { ...web.metadata.annotations, [`${P}/compose-service`]: 'api' },
      },
    };
    const apiPod: Pod = {
      ...pod,
      metadata: {
        ...pod.metadata,
        name: 'api-5c9d8f7b6-x2x4q',
        labels: { ...pod.metadata.labels, [`${P}/service`]: 'api', 'pod-template-hash': '5c9d8f7b6' },
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api-5c9d8f7b6', uid: 'rs-api', controller: true }],
      },
    };
    const shared = buildInventoryView(fixtureNamespace('pvc-pending-rwx'), [...items, api, apiPod], []);
    const generic = 'Inspect it with `dockflow logs production <service> --all-tasks` and `dockflow diagnose production --verbose`.';
    expect(issuesOf(diagnose('pvc-pending-rwx', { inventory: ok(shared) }), 'Volume').map((i) => i.suggestion)).toEqual([generic, generic]);
  });

  it('shows bound claims with the compose volume name, capacity and node', () => {
    const report = diagnose('statefulset-stuck');
    expect(linesOf(report, 'Volumes')).toEqual([
      ['ok', 'data (pvc/data-db-0) Bound 1Gi on server_1'],
      ['ok', 'data (pvc/data-db-1) Bound 1Gi on agent_1'],
    ]);
    expect(issuesOf(report, 'Volume')).toEqual([]);
    expect(linesOf(report, 'Services')).toEqual([['warning', 'db (accessory): 1/2 replicas']]);
    expect(linesOf(report, 'Rollouts')).toEqual([['plain', 'No Deployments']]);
  });

  it('reports FailedMount as an error on the pod, once per object', () => {
    const inventory = inventoryOf('rollout-complete');
    const pod = inventory.pods[0];
    const mount = 'MountVolume.SetUp failed for volume "data" : hostPath type check failed: /srv/data is not a directory';
    const events = [
      event(pod.metadata.name, 'FailedMount', mount, { last: minutesAgo(1) }),
      event(pod.metadata.name, 'FailedMount', mount, { last: minutesAgo(2) }),
    ];
    const lost: PersistentVolumeClaim = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'cache-data', annotations: { [`${P}/compose-volume`]: 'cache_data' } },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
      status: { phase: 'Lost' },
    };
    const report = diagnose('rollout-complete', { inventory: ok({ ...inventory, claims: [lost] }), events: ok(events) });
    expect(issuesOf(report, 'Volume')).toEqual([
      {
        severity: 'warning',
        category: 'Volume',
        message: 'Volume cache_data (pvc/cache-data) is not bound',
        suggestion: 'Inspect it with `dockflow logs production <service> --all-tasks` and `dockflow diagnose production --verbose`.',
      },
      {
        severity: 'error',
        category: 'Volume',
        message: `web.${pod.metadata.name.slice(-5)}: ${mount}`,
        suggestion: 'Inspect it with `dockflow logs production web --all-tasks` and `dockflow diagnose production --verbose`.',
      },
    ]);
    expect(linesOf(report, 'Volumes')).toEqual([['error', 'cache_data (pvc/cache-data) Lost']]);
  });
});

describe('rollouts', () => {
  it('reports ProgressDeadlineExceeded with the deadline', () => {
    const report = diagnose('progress-deadline-exceeded');
    expect(linesOf(report, 'Rollouts')).toEqual([['error', 'web: ProgressDeadlineExceeded (45s)']]);
    expect(issuesOf(report, 'Rollout')).toEqual([
      {
        severity: 'error',
        category: 'Rollout',
        message: 'Service web did not finish its rollout within 45s',
        suggestion: 'Read the Pod Errors section above; the rollout did not progress.',
      },
    ]);
  });

  it('reports ReplicaFailure with the condition message', () => {
    const report = diagnose('replica-failure-quota');
    const message = 'pods "web-ddff555b9-pjk2t" is forbidden: exceeded quota: pods, requested: pods=1, used: pods=1, limited: pods=1';
    expect(linesOf(report, 'Rollouts')).toEqual([['error', `web: ReplicaFailure: ${message}`]]);
    expect(issuesOf(report, 'Rollout')).toEqual([
      { severity: 'error', category: 'Rollout', message: `Service web: ${message}`, suggestion: KUBERNETES_FALLBACK_SUGGESTION.replaceAll('<env>', 'production').replace('<service>', 'web') },
    ]);
    expect(issuesOf(report, 'Replicas')).toEqual([{ severity: 'warning', category: 'Replicas', message: "Service 'web' has 1/3 replicas" }]);
  });

  it('shows a rollout in progress', () => {
    expect(linesOf(diagnose('rollout-progressing'), 'Rollouts')).toEqual([['pending', 'web: rolling out (1/3 updated)']]);
  });
});

describe('Helm Releases', () => {
  const release = (name: string, status: string, revision: number, description?: string): DiagnoseHelmRelease => ({
    name,
    namespace: 'fixture-rollout-complete',
    role: 'app',
    revision,
    status,
    chart: `${name}-1.0.0`,
    appVersion: '1.0.0',
    updated: null,
    ...(description === undefined ? {} : { description }),
  });

  it('reports failed and stuck releases', () => {
    const report = diagnose('rollout-complete', {
      helmReleases: ok([
        release('search', 'failed', 4, `Upgrade "search" failed: token ${SECRET} rejected`),
        release('cache', 'pending-upgrade', 2),
        release('analytics', 'deployed', 7),
        release('old', 'superseded', 1),
        release('odd', 'unknown', 1),
      ]),
    });
    expect(linesOf(report, 'Helm Releases')).toEqual([
      ['ok', 'analytics: deployed (revision 7)'],
      ['error', 'cache: pending-upgrade (revision 2)'],
      ['warning', 'odd: unknown (revision 1)'],
      ['dim', 'old: superseded (revision 1)'],
      ['error', 'search: failed (revision 4)'],
    ]);
    expect(issuesOf(report, 'Helm')).toEqual([
      {
        severity: 'error',
        category: 'Helm',
        message: 'Helm release cache is stuck in pending-upgrade',
        suggestion: 'Check it with: `dockflow helm status production cache`.',
      },
      {
        severity: 'error',
        category: 'Helm',
        message: 'Helm release search failed: Upgrade "search" failed: token *** rejected',
        suggestion: 'Check it with: `dockflow helm status production search`.',
      },
    ]);
  });

  it('has no section without releases and a warning line when the list failed', () => {
    expect(titles(diagnose('rollout-complete'))).not.toContain('Helm Releases');
    const report = diagnose('rollout-complete', { helmReleases: err(`helm: token ${SECRET} expired`) });
    expect(linesOf(report, 'Helm Releases')).toEqual([['warning', 'Could not list Helm releases: helm: token *** expired']]);
  });
});

describe('Proxy', () => {
  const status = (fields: Partial<ProxyStatus>): ProxyStatus => ({
    installed: true,
    ready: true,
    version: '3.5.0',
    owner: 'shop-production',
    entryPoints: ['web', 'websecure'],
    acme: false,
    acmeReclaimPolicy: null,
    ...fields,
  });

  it('reports a ready Traefik', () => {
    const report = diagnose('rollout-complete', { proxy: ok(status({})) });
    expect(linesOf(report, 'Proxy')).toEqual([['ok', 'Traefik 3.5.0 ready']]);
    expect(report.issues).toEqual([]);
  });

  it('reports Traefik not ready with its conflicts and recovery steps', () => {
    const report = diagnose('rollout-complete', {
      proxy: ok(
        status({
          ready: false,
          detail: 'pod dockflow-traefik-7d9f is Pending',
          conflicts: ['port 443 is held by nginx on server_1'],
          recovery: ['Stop nginx on server_1, then run `dockflow deploy production`.'],
        }),
      ),
    });
    expect(linesOf(report, 'Proxy')).toEqual([
      ['error', 'Traefik is not ready in dockflow-system: pod dockflow-traefik-7d9f is Pending'],
      ['warning', 'port 443 is held by nginx on server_1'],
      ['plain', 'Stop nginx on server_1, then run `dockflow deploy production`.'],
    ]);
    expect(issuesOf(report, 'Proxy')).toEqual([
      {
        severity: 'error',
        category: 'Proxy',
        message: 'Traefik is not ready in dockflow-system',
        suggestion: 'Reinstall it with: `dockflow deploy production`.',
      },
    ]);
    expect(issuesOf(diagnose('rollout-complete', { proxy: ok(status({ installed: false, ready: false })) }), 'Proxy')).toHaveLength(1);
  });

  it('has no section with the proxy disabled and a warning line when the read failed', () => {
    expect(titles(diagnose('rollout-complete', { proxy: null }))).not.toContain('Proxy');
    expect(linesOf(diagnose('rollout-complete', { proxy: err('timeout') }), 'Proxy')).toEqual([
      ['warning', 'Could not read the proxy status: timeout'],
    ]);
  });
});

describe('Warning Events', () => {
  // 17 events inside the 15-minute window (one dated by eventTime only), 3 older ones
  const recent = Array.from({ length: 16 }, (_, i) => event(`web-${i}`, 'BackOff', `back-off ${i}`, { last: minutesAgo(i * 0.9) }));
  const microTime = event('web-mt', 'Unhealthy', `Readiness probe failed: ${SECRET}`, { eventTime: minutesAgo(0.5).replace(/Z$/, '001Z') });
  const old = [20, 30, 40].map((m) => event(`web-old-${m}`, 'BackOff', `old ${m}`, { last: minutesAgo(m) }));
  const events = [...old, ...recent.slice(8), microTime, ...recent.slice(0, 8)];

  it('shows the 15 newest events of the last 15 minutes, newest first', () => {
    const lines = linesOf(diagnose('rollout-complete', { events: ok(events) }), 'Warning Events');
    expect(lines).toHaveLength(15);
    expect(lines[0]).toEqual(['warning', '0s Pod/web-0 BackOff: back-off 0']);
    expect(lines[1]).toEqual(['warning', '30s Pod/web-mt Unhealthy: Readiness probe failed: ***']);
    expect(lines.map(([, text]) => text.split(' ')[1])).toEqual([
      'Pod/web-0',
      'Pod/web-mt',
      ...Array.from({ length: 13 }, (_, i) => `Pod/web-${i + 1}`),
    ]);
  });

  it('shows every event with --verbose', () => {
    const lines = linesOf(diagnose('rollout-complete', { events: ok(events), verbose: true }), 'Warning Events');
    expect(lines).toHaveLength(20);
    expect(lines.slice(-3).map(([, text]) => text)).toEqual(['20m Pod/web-old-20 BackOff: old 20', '30m Pod/web-old-30 BackOff: old 30', '40m Pod/web-old-40 BackOff: old 40']);
  });

  it('says so when nothing is recent, and warns when events could not be read', () => {
    expect(linesOf(diagnose('rollout-complete', { events: ok(old) }), 'Warning Events')).toEqual([
      ['plain', 'No warning events in the last 15 minutes'],
    ]);
    expect(linesOf(diagnose('rollout-complete', { events: ok([]), verbose: true }), 'Warning Events')).toEqual([['plain', 'No warning events']]);
    expect(linesOf(diagnose('rollout-complete', { events: err('forbidden') }), 'Warning Events')).toEqual([
      ['warning', 'Could not read events: forbidden'],
    ]);
  });
});

describe('Cluster Nodes', () => {
  it('reports a node that is not ready by its servers.yml key (U-STATUS-DIAG-02)', () => {
    const report = diagnose('node-not-ready');
    expect(linesOf(report, 'Cluster Nodes')).toEqual([
      ['error', 'agent_1 NotReady (worker) v1.36.4+k3s1'],
      ['ok', 'server_1 Ready (manager) v1.36.4+k3s1'],
    ]);
    expect(issuesOf(report, 'Node')).toEqual([{ severity: 'error', category: 'Node', message: 'Node agent_1 is not ready' }]);
  });

  it('reports pressure and cordoned nodes', () => {
    const nodes = loadKubectlList<Node>('rollout-complete', 'nodes').items.map((node) =>
      node.metadata.name !== 'server-1'
        ? node
        : {
            ...node,
            spec: { ...node.spec, unschedulable: true },
            status: {
              ...node.status,
              conditions: (node.status?.conditions ?? []).map((c) => (c.type === 'DiskPressure' ? { ...c, status: 'True' as const } : c)),
            },
          },
    );
    const report = diagnose('rollout-complete', { nodes: ok(nodes) });
    expect(linesOf(report, 'Cluster Nodes')[1]).toEqual(['warning', 'server_1 Ready,SchedulingDisabled (manager) v1.36.4+k3s1 DiskPressure']);
    expect(issuesOf(report, 'Node')).toEqual([
      { severity: 'warning', category: 'Node', message: 'Node server_1 reports DiskPressure' },
      { severity: 'warning', category: 'Node', message: 'Node server_1 is cordoned' },
    ]);
  });

  it('warns when nodes could not be read', () => {
    expect(linesOf(diagnose('rollout-complete', { nodes: err('the server has asked for the client to provide credentials') }), 'Cluster Nodes')).toEqual([
      ['warning', 'Could not read nodes: the server has asked for the client to provide credentials'],
    ]);
  });
});

describe('System Resources', () => {
  const df = (percent: number, mount = '/') => ok(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 ${percent} ${100 - percent} ${percent}% ${mount}`);

  it('disk at 91% is an error, 85% a warning', () => {
    const full = diagnose('rollout-complete', { host: { ...HOST_OK, rootDisk: df(91) } });
    expect(linesOf(full, 'System Resources')[0]).toEqual(['error', 'Disk usage (/): 91%']);
    expect(issuesOf(full, 'System')).toEqual([
      { severity: 'error', category: 'System', message: 'Disk at 91% on /', suggestion: 'Free disk space with: `dockflow prune production --images --all`.' },
    ]);
    const high = diagnose('rollout-complete', { host: { ...HOST_OK, rootDisk: df(85) } });
    expect(linesOf(high, 'System Resources')[0]).toEqual(['warning', 'Disk usage (/): 85%']);
    expect(issuesOf(high, 'System')).toEqual([{ severity: 'warning', category: 'System', message: 'Disk at 85% on /' }]);
  });

  it('memory at 92% is a warning issue', () => {
    const report = diagnose('rollout-complete', { host: { ...HOST_OK, memory: ok('92') } });
    expect(linesOf(report, 'System Resources')[1]).toEqual(['error', 'Memory usage: 92%']);
    expect(issuesOf(report, 'System')).toEqual([
      {
        severity: 'warning',
        category: 'System',
        message: 'Memory at 92%',
        suggestion: 'Free memory or add nodes; high usage may prevent containers from starting.',
      },
    ]);
    const high = diagnose('rollout-complete', { host: { ...HOST_OK, memory: ok('85') } });
    expect(linesOf(high, 'System Resources')[1]).toEqual(['warning', 'Memory usage: 85%']);
    expect(issuesOf(high, 'System')).toEqual([]);
  });

  it('adds the volume root when it is another filesystem', () => {
    const report = diagnose('rollout-complete', { host: { ...HOST_OK, volumeDisk: df(50, '/var/lib/dockflow') } });
    expect(linesOf(report, 'System Resources')).toEqual([
      ['ok', 'Disk usage (/): 32%'],
      ['ok', 'Disk usage (/var/lib/dockflow): 50%'],
      ['ok', 'Memory usage: 41%'],
    ]);
    const same = diagnose('rollout-complete', { host: { ...HOST_OK, volumeDisk: df(32, '/') } });
    expect(linesOf(same, 'System Resources')).toHaveLength(2);
  });

  it('a failed df or free prints an info line and never throws', () => {
    const report = diagnose('rollout-complete', { host: { rootDisk: err('df: not found'), volumeDisk: ok(''), memory: ok('garbage') } });
    expect(linesOf(report, 'System Resources')).toEqual([
      ['plain', 'Could not check disk space'],
      ['plain', 'Could not check memory usage'],
    ]);
    expect(issuesOf(report, 'System')).toEqual([]);
  });

  it('parses df -P and free output', () => {
    expect(parseDfLine('/dev/mapper/vg-root  41152736 12345678 26703112  32% /')).toEqual({ percent: 32, mount: '/' });
    expect(parseDfLine('tmpfs 100 1 99 1% /var/lib/my data\n')).toEqual({ percent: 1, mount: '/var/lib/my data' });
    expect(parseDfLine('')).toBeNull();
    expect(parsePercent(' 73\n')).toBe(73);
    expect(parsePercent('73.5')).toBeNull();
  });
});

describe('failed reads', () => {
  it('a failed namespace read is a warning line and the report continues', () => {
    const report = diagnose('rollout-complete', { inventory: err(`Unable to connect: token ${SECRET}`) });
    expect(linesOf(report, 'Services')).toEqual([['warning', 'Could not read the namespace: Unable to connect: token ***']]);
    expect(titles(report)).toEqual(['Stack Status', 'Services', 'Warning Events', 'Cluster Nodes', 'System Resources']);
  });
});

describe('analyzeError pattern table', () => {
  const k8s = { source: 'kubernetes', env: 'production', service: 'web' } as const;
  const rows: [string, string][] = [
    ['ErrImageNeverPull: dockflow.invalid/shop-web:1.4.2', 'The image built by Dockflow is missing on that node; import it again with: `dockflow deploy production`.'],
    ['ErrImagePull registry.example.com/shop/web:2', 'Check the image name and tag; for a private registry, check the registry credentials in config.yml.'],
    ['manifest unknown', 'Check the image name and tag; for a private registry, check the registry credentials in config.yml.'],
    ['image "registry.example.com/shop/web:2" not found', 'Check the image name and tag; for a private registry, check the registry credentials in config.yml.'],
    ['InvalidImageName', 'Fix `image:` in docker-compose.yml; the reference is not a valid image name.'],
    ['CreateContainerConfigError: secret "web-env" not found', 'A Secret or ConfigMap Dockflow created is missing; run `dockflow deploy production` again.'],
    ['OOMKilled (exit 137)', 'Raise `deploy.resources.limits.memory` for this service; the container ran out of memory.'],
    ['0/2 nodes are available: 2 Insufficient cpu.', 'Lower `deploy.resources.reservations` or add nodes; the request exceeds the free node capacity.'],
    [
      "0/2 nodes are available: 2 node(s) didn't match Pod's node affinity/selector.",
      'Check the placement constraints (`node.hostname`, `node.labels`, `x-dockflow.node_selector`); no node matches them.',
    ],
    ['1 node(s) had volume node affinity conflict', 'Start or uncordon the node holding the volume; local volumes cannot move between nodes.'],
    ['1 node(s) had untolerated taint {node-role: db}', 'Add workers, or declare `x-dockflow.tolerations` for the tainted nodes.'],
    ['Liveness probe failed: HTTP probe failed with statuscode: 500', 'Run the healthcheck yourself with: `dockflow exec production web -- <command>`.'],
    ['Startup probe failed: connection refused', 'Run the healthcheck yourself with: `dockflow exec production web -- <command>`.'],
    ['ProgressDeadlineExceeded', 'Read the Pod Errors section above; the rollout did not progress.'],
    ['exec /app: exec format error', 'Image architecture mismatch. Rebuild for the correct platform (linux/amd64 or linux/arm64).'],
    ['open /data/db: permission denied', 'Check file ownership on volumes and bind mounts; set `user:` or `x-dockflow.fs_group`.'],
    ['write /data: no space left on device', 'Free disk space with: `dockflow prune production --images --all`.'],
    ['cannot re-use a name that is still in use', 'Check the release with: `dockflow helm status production web`; a previous Helm operation did not finish.'],
    ['bind source path does not exist: /srv/data', 'Create the directory on the server: mkdir -p /srv/data'],
    ['No such image: shop/web:2', 'The Docker image may not have been pushed. Try redeploying.'],
    ['port is already allocated', 'Another service is using this port. Check running containers with: docker ps'],
    ['task: non-zero exit (137): out of memory', 'Container ran out of memory. Increase memory limits or reduce memory usage.'],
    ['network shop_default not found', 'Docker network may have been removed. Try redeploying the stack.'],
  ];
  for (const [text, suggestion] of rows) {
    it(`${text} -> its row`, () => {
      expect(analyzeError(text, k8s)).toBe(suggestion);
    });
  }

  it('the first matching row wins', () => {
    // both the Dockflow-image row and the generic pull row match
    expect(analyzeError('ImagePullBackOff: dockflow.invalid/shop-web:1.4.2 not found', k8s)).toStartWith('The image built by Dockflow');
    // the Kubernetes rows are checked before the Swarm rows they shadow
    expect(analyzeError('OOMKilled: out of memory', k8s)).toStartWith('Raise `deploy.resources.limits.memory`');
    expect(analyzeError('permission denied', { source: 'swarm', env: 'production' })).toBe(
      'Check file ownership on volumes and bind mounts; set `user:` or `x-dockflow.fs_group`.',
    );
    expect(analyzeError('ImagePullBackOff and Insufficient memory', k8s)).toStartWith('Check the image name and tag');
  });

  it('falls back per orchestrator', () => {
    expect(analyzeError('something else entirely', k8s)).toBe(
      'Inspect it with `dockflow logs production web --all-tasks` and `dockflow diagnose production --verbose`.',
    );
    expect(analyzeError('something else entirely', { source: 'kubernetes', env: 'staging' })).toBe(
      'Inspect it with `dockflow logs staging <service> --all-tasks` and `dockflow diagnose staging --verbose`.',
    );
    expect(analyzeError('something else entirely', { source: 'swarm', env: 'production', service: 'web' })).toBe(SWARM_FALLBACK_SUGGESTION);
    expect(SWARM_FALLBACK_SUGGESTION).toBe('Check Docker logs for more details: docker service logs <service_name>');
  });
});
