import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { K3S_PIN } from '../../services/orchestrator/kubernetes/k3s/versions';
import type {
  ControllerRevision,
  DaemonSet,
  Deployment,
  ReplicaSet,
  StatefulSet,
} from '../../services/orchestrator/kubernetes/resources/apps';
import type { Job } from '../../services/orchestrator/kubernetes/resources/batch';
import type {
  ContainerStatus,
  Event,
  Node,
  PersistentVolumeClaim,
  Pod,
  Service,
} from '../../services/orchestrator/kubernetes/resources/core';
import type { KubeList } from '../../services/orchestrator/kubernetes/resources/meta';
import { HELM_PIN } from '../../services/orchestrator/kubernetes/versions';
import {
  CAPTURED_RESOURCES,
  CLUSTER_RESOURCES,
  type CapturedResource,
  DESIGN_SCENARIOS,
  FIXTURE_SERVERS,
  FIXTURES_ROOT,
  type FixtureFile,
  FixtureStore,
  fixtureNamespace,
  formatCompactJson,
  formatKubectlJson,
  loadFixtureMeta,
  loadHelmFixture,
  loadKubectlFixture,
  loadKubectlList,
  loadKubectlResources,
  loadMetricsFixture,
  metaErrors,
  RESOURCE_KINDS,
  readHelmFixture,
  readKubectlFixture,
  readMetricsFixture,
  scrubViolations,
  splitFixtureRef,
} from './support/kubectl-fixtures';

const store = new FixtureStore();
const kubectlScenarios = store.kubectlScenarios();
const helmScenarios = store.helmScenarios();
const metricsScenarios = store.metricsScenarios();

function minor(version: string): string {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match) throw new Error(`${version} is not a version`);
  return `${match[1]}.${match[2]}`;
}

function isClusterResource(resource: CapturedResource): boolean {
  return (CLUSTER_RESOURCES as readonly string[]).includes(resource);
}

interface ListShape {
  apiVersion: string;
  kind: string;
  metadata: { resourceVersion: string };
  items: { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } }[];
}

function list<T>(scenario: string, resource: CapturedResource, capture = ''): T[] {
  return loadKubectlList<T>(scenario, resource, capture).items;
}

function condition(conditions: { type: string; status: string; reason?: string }[] | undefined, type: string) {
  return conditions?.find((c) => c.type === type);
}

describe('kubectl fixtures', () => {
  test('the scenarios are exactly those of design-07 3.11', () => {
    expect(kubectlScenarios).toEqual([...DESIGN_SCENARIOS.kubectl].sort());
  });

  test.each(kubectlScenarios)('%s: meta.json is valid and its k3s minor equals the pin', (scenario) => {
    const meta = store.meta('kubectl', scenario);
    expect(minor(meta.k3sVersion)).toBe(minor(K3S_PIN.version));
    if (meta.synthetic) expect(meta.k3sVersion).toBe(K3S_PIN.version);
  });

  test.each(kubectlScenarios)('%s: every capture holds one List per captured resource, laid out as kubectl prints it', (scenario) => {
    for (const capture of store.captures(scenario)) {
      const dir = join(FIXTURES_ROOT, 'kubectl', scenario, capture);
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
      const expected = CAPTURED_RESOURCES.map((r) => `${r}.json`);
      expect(files).toEqual((capture === '' ? [...expected, 'meta.json'] : expected).sort());
      for (const resource of CAPTURED_RESOURCES) {
        const path = capture ? `${capture}/${resource}` : resource;
        const text = readKubectlFixture(scenario, path);
        const parsed = JSON.parse(text) as ListShape;
        expect(text).toBe(formatKubectlJson(parsed));
        expect(parsed.apiVersion).toBe('v1');
        expect(parsed.kind).toBe('List');
        expect(parsed.metadata).toEqual({ resourceVersion: '' });
        const names = parsed.items.map((i) => i.metadata.name);
        expect(names).toEqual([...names].sort());
        for (const item of parsed.items) {
          expect({ apiVersion: item.apiVersion, kind: item.kind }).toEqual(RESOURCE_KINDS[resource]);
          expect(item.metadata.namespace).toBe(isClusterResource(resource) ? undefined : fixtureNamespace(scenario));
        }
      }
    }
  });

  test.each(kubectlScenarios)('%s: the scrub rules hold', (scenario) => {
    expect(store.violations('kubectl', scenario)).toEqual([]);
  });

  // The convergence gates (design-03 9.3) and `isCurrentRevision` (design-06 2.3) follow these chains.
  test.each(kubectlScenarios)('%s: owner and revision chains resolve inside each capture', (scenario) => {
    for (const capture of store.captures(scenario)) {
      const replicaSets = list<ReplicaSet>(scenario, 'replicasets.apps', capture);
      const revisions = list<ControllerRevision>(scenario, 'controllerrevisions.apps', capture);
      const owners = new Map<string, string>();
      for (const resource of ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps', 'jobs.batch', 'replicasets.apps'] as const) {
        for (const o of list<{ kind: string; metadata: { name: string; uid?: string } }>(scenario, resource, capture)) {
          owners.set(`${o.kind}/${o.metadata.name}`, o.metadata.uid ?? '');
        }
      }
      const ownedBy = (uid: string | undefined) => (x: { metadata: { ownerReferences?: { uid: string }[] } }) =>
        x.metadata.ownerReferences?.some((r) => r.uid === uid) ?? false;
      for (const d of list<Deployment>(scenario, 'deployments.apps', capture)) {
        const revision = d.metadata.annotations?.['deployment.kubernetes.io/revision'];
        const current = replicaSets.filter(ownedBy(d.metadata.uid));
        expect(current.map((rs) => rs.metadata.annotations?.['deployment.kubernetes.io/revision'])).toContain(revision);
      }
      for (const sts of list<StatefulSet>(scenario, 'statefulsets.apps', capture)) {
        const names = revisions.filter(ownedBy(sts.metadata.uid)).map((r) => r.metadata.name);
        expect(names).toContain(sts.status?.updateRevision ?? '(unset)');
        expect(names).toContain(sts.status?.currentRevision ?? '(unset)');
      }
      for (const ds of list<DaemonSet>(scenario, 'daemonsets.apps', capture)) {
        const hashes = revisions.filter(ownedBy(ds.metadata.uid)).map((r) => r.metadata.labels?.['controller-revision-hash']);
        for (const pod of list<Pod>(scenario, 'pods', capture).filter(ownedBy(ds.metadata.uid))) {
          expect(hashes).toContain(pod.metadata.labels?.['controller-revision-hash']);
        }
      }
      for (const item of [...replicaSets, ...list<Pod>(scenario, 'pods', capture)]) {
        const refs = item.metadata.ownerReferences ?? [];
        if (item.metadata.labels?.['dockflow.shawiizz.dev/part'] === 'helper') {
          expect(refs).toEqual([]);
          continue;
        }
        expect(refs.length).toBe(1);
        expect(owners.get(`${refs[0].kind}/${refs[0].name}`)).toBe(refs[0].uid);
      }
    }
  });

  test.each(kubectlScenarios)('%s: nodes run the recorded k3s version and every pod sits on one of them', (scenario) => {
    const meta = store.meta('kubectl', scenario);
    for (const capture of store.captures(scenario)) {
      const nodes = list<Node>(scenario, 'nodes', capture);
      expect(nodes.map((n) => n.metadata.name).sort()).toEqual(Object.keys(FIXTURE_SERVERS).sort());
      for (const node of nodes) expect(node.status?.nodeInfo?.kubeletVersion).toBe(meta.k3sVersion);
      for (const pod of list<Pod>(scenario, 'pods', capture)) {
        if (pod.spec.nodeName) expect(Object.keys(FIXTURE_SERVERS)).toContain(pod.spec.nodeName);
      }
    }
  });
});

// The condition each scenario is named after, so a re-recording that misses it fails here first.
const SHOWS: Record<string, (scenario: string) => void> = {
  'rollout-progressing': (s) => {
    const [d] = list<Deployment>(s, 'deployments.apps');
    expect(d.metadata.generation).toBe(2);
    expect(d.status?.updatedReplicas).toBe(1);
    expect(list<ReplicaSet>(s, 'replicasets.apps').map((rs) => rs.metadata.annotations?.['deployment.kubernetes.io/revision'])).toEqual(
      expect.arrayContaining(['1', '2']),
    );
  },
  'rollout-complete': (s) => {
    const [d] = list<Deployment>(s, 'deployments.apps');
    expect(d.status?.observedGeneration).toBe(d.metadata.generation);
    expect(d.status?.updatedReplicas).toBe(3);
    expect(condition(d.status?.conditions, 'Progressing')?.reason).toBe('NewReplicaSetAvailable');
    const lb = list<Service>(s, 'services').find((svc) => svc.spec.type === 'LoadBalancer');
    expect(lb?.status?.loadBalancer?.ingress?.length).toBeGreaterThan(0);
  },
  crashloop: (s) => crashLooping(list<Pod>(s, 'pods')[0].status?.containerStatuses?.[0]),
  'image-pull-backoff': (s) => waitingReason(s, 'ImagePullBackOff'),
  'err-image-never-pull': (s) => waitingReason(s, 'ErrImageNeverPull'),
  'invalid-image-name': (s) => waitingReason(s, 'InvalidImageName'),
  'create-container-config-error': (s) => waitingReason(s, 'CreateContainerConfigError'),
  'oom-killed': (s) => {
    const [pod] = list<Pod>(s, 'pods');
    const status = pod.status?.containerStatuses?.[0];
    expect([status?.lastState?.terminated?.reason, status?.state?.terminated?.reason]).toContain('OOMKilled');
  },
  'unschedulable-resources': (s) => unschedulable(s, /Insufficient memory/),
  'unschedulable-node-selector': (s) => unschedulable(s, /didn't match Pod's node affinity\/selector/),
  'pvc-pending-rwx': (s) => {
    const [claim] = list<PersistentVolumeClaim>(s, 'persistentvolumeclaims');
    expect(claim.status?.phase).toBe('Pending');
    expect(claim.spec.accessModes).toEqual(['ReadWriteMany']);
    const events = list<Event>(s, 'events').filter((e) => e.involvedObject?.name === claim.metadata.name);
    expect(events.map((e) => e.reason)).toContain('ProvisioningFailed');
    expect(list<Pod>(s, 'pods')[0].status?.phase).toBe('Pending');
  },
  'progress-deadline-exceeded': (s) => {
    const [d] = list<Deployment>(s, 'deployments.apps');
    expect(condition(d.status?.conditions, 'Progressing')).toMatchObject({ status: 'False', reason: 'ProgressDeadlineExceeded' });
  },
  'replica-failure-quota': (s) => {
    const [d] = list<Deployment>(s, 'deployments.apps');
    expect(condition(d.status?.conditions, 'ReplicaFailure')).toMatchObject({ status: 'True', reason: 'FailedCreate' });
  },
  'statefulset-stuck': (s) => {
    const [sts] = list<StatefulSet>(s, 'statefulsets.apps');
    expect(sts.status?.updateRevision).not.toBe(sts.status?.currentRevision);
    const updated = list<Pod>(s, 'pods').filter((p) => p.metadata.labels?.['controller-revision-hash'] === sts.status?.updateRevision);
    expect(updated.map((p) => p.metadata.name)).toEqual(['db-1']);
    crashLooping(updated[0].status?.containerStatuses?.[0]);
  },
  'daemonset-rolling': (s) => {
    const [mid] = list<DaemonSet>(s, 'daemonsets.apps');
    const [done] = list<DaemonSet>(s, 'daemonsets.apps', 'completed');
    expect(mid.status?.updatedNumberScheduled).toBe(1);
    expect(done.status?.updatedNumberScheduled).toBe(done.status?.desiredNumberScheduled);
    expect(done.metadata.uid).toBe(mid.metadata.uid);
  },
  'job-complete': (s) => {
    const [job] = list<Job>(s, 'jobs.batch');
    expect(condition(job.status?.conditions, 'Complete')?.status).toBe('True');
  },
  'job-failed': (s) => {
    const [job] = list<Job>(s, 'jobs.batch');
    expect(condition(job.status?.conditions, 'Failed')).toMatchObject({ status: 'True', reason: 'BackoffLimitExceeded' });
  },
  'init-container-crash': (s) => {
    const [pod] = list<Pod>(s, 'pods');
    crashLooping(pod.status?.initContainerStatuses?.[0]);
  },
  'multi-container': (s) => {
    const [pod] = list<Pod>(s, 'pods');
    expect(pod.spec.containers.map((c) => c.name)).toEqual(['api', 'log-shipper']);
    expect(pod.metadata.annotations?.['kubectl.kubernetes.io/default-container']).toBe('api');
  },
  'terminating-pods': (s) => {
    expect(list<Pod>(s, 'pods').filter((p) => p.metadata.deletionTimestamp).length).toBe(1);
  },
  'evicted-pod': (s) => {
    expect(list<Pod>(s, 'pods').map((p) => p.status?.reason)).toContain('Evicted');
  },
  'node-not-ready': (s) => {
    const agent = list<Node>(s, 'nodes').find((n) => n.metadata.name === 'agent-1');
    expect(condition(agent?.status?.conditions, 'Ready')?.status).toBe('Unknown');
  },
  'headless-no-ports': (s) => {
    const headless = list<Service>(s, 'services').filter((svc) => svc.spec.clusterIP === 'None');
    expect(headless.some((svc) => svc.spec.ports === undefined)).toBe(true);
  },
  'metrics-top': (s) => {
    expect(list<Pod>(s, 'pods').some((p) => p.metadata.labels?.['dockflow.shawiizz.dev/part'] === 'helper')).toBe(true);
  },
};

function waitingReason(scenario: string, reason: string): void {
  const [pod] = list<Pod>(scenario, 'pods');
  expect(pod.status?.containerStatuses?.[0].state?.waiting?.reason).toBe(reason);
}

/** Restarted 3 times and backing off: k3s 1.36 keeps the container `terminated` most of that time, else `waiting` in CrashLoopBackOff. */
function crashLooping(status: ContainerStatus | undefined): void {
  expect(status?.restartCount).toBeGreaterThanOrEqual(3);
  expect(status?.state?.waiting?.reason === 'CrashLoopBackOff' || status?.state?.terminated !== undefined).toBe(true);
}

function unschedulable(scenario: string, message: RegExp): void {
  const [pod] = list<Pod>(scenario, 'pods');
  const scheduled = condition(pod.status?.conditions, 'PodScheduled');
  expect(scheduled).toMatchObject({ status: 'False', reason: 'Unschedulable' });
  expect(pod.status?.conditions?.[0].message).toMatch(message);
}

describe('scenario conditions', () => {
  test('every design scenario has a condition check', () => {
    expect(Object.keys(SHOWS).sort()).toEqual([...DESIGN_SCENARIOS.kubectl].sort());
  });

  test.each(kubectlScenarios)('%s shows the condition it is named after', (scenario) => {
    SHOWS[scenario](scenario);
  });
});

describe('helm fixtures', () => {
  test('the scenarios are exactly those of design-07 3.11', () => {
    expect(helmScenarios).toEqual([...DESIGN_SCENARIOS.helm].sort());
  });

  test.each(helmScenarios)('%s: meta.json is valid and its helm and k3s minors equal the pins', (scenario) => {
    const meta = store.meta('helm', scenario);
    expect(minor(meta.helmVersion ?? '')).toBe(minor(HELM_PIN.version));
    expect(minor(meta.k3sVersion)).toBe(minor(K3S_PIN.version));
  });

  test.each(helmScenarios)('%s: every file is named by the step that captures it, JSON as helm prints it', (scenario) => {
    const meta = store.meta('helm', scenario);
    const files = store.fileSet('helm', scenario);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(meta.steps.some((step) => step.startsWith(`${file.path}: `))).toBe(true);
      if (file.json !== undefined) expect(file.text).toBe(formatCompactJson(file.json));
    }
    for (const step of meta.steps) {
      const named = /^([\w.-]+\.(?:json|yaml|txt)): /.exec(step);
      if (named) expect(files.map((f) => f.path)).toContain(named[1]);
    }
  });

  test.each(helmScenarios)('%s: the scrub rules hold', (scenario) => {
    expect(store.violations('helm', scenario)).toEqual([]);
  });
});

describe('metrics fixtures', () => {
  test('the scenarios are exactly those of design-07 3.11', () => {
    expect(metricsScenarios).toEqual([...DESIGN_SCENARIOS.metrics].sort());
  });

  test.each(metricsScenarios)('%s: a metrics.k8s.io body as kubectl get --raw prints it, naming pods of its capture', (scenario) => {
    const text = readMetricsFixture(scenario);
    const body = JSON.parse(text) as {
      kind: string;
      apiVersion: string;
      items: { metadata: { name: string; namespace: string }; containers: { name: string; usage: { cpu: string; memory: string } }[] }[];
    };
    expect(text).toBe(formatCompactJson(body));
    expect(body.kind).toBe('PodMetricsList');
    expect(body.apiVersion).toBe('metrics.k8s.io/v1beta1');
    const pods = new Map(list<Pod>(scenario, 'pods').map((p) => [p.metadata.name, p]));
    expect(body.items.length).toBe(pods.size);
    for (const item of body.items) {
      expect(item.metadata.namespace).toBe(fixtureNamespace(scenario));
      const pod = pods.get(item.metadata.name);
      expect(pod).toBeDefined();
      for (const c of item.containers) expect(pod?.spec.containers.map((x) => x.name)).toContain(c.name);
    }
  });

  test.each(metricsScenarios)('%s: scrubbed as part of the kubectl file set of the same scenario', (scenario) => {
    expect(store.fileSet('kubectl', scenario).map((f) => f.path)).toContain(`metrics/${scenario}.json`);
    expect(store.violations('kubectl', scenario)).toEqual([]);
  });
});

describe('serialization of the recorded tools', () => {
  const backslash = String.fromCharCode(92);
  const escaped = (hex: string) => `${backslash}u00${hex}`;

  test('formatKubectlJson sorts keys at every level, indents by 4 and escapes like Go', () => {
    const value = { metadata: { name: 'web', labels: { b: '1', a: '2' } }, apiVersion: 'v1', note: 'a<b>&c', unset: undefined };
    expect(formatKubectlJson(value)).toBe(
      [
        '{',
        '    "apiVersion": "v1",',
        '    "metadata": {',
        '        "labels": {',
        '            "a": "2",',
        '            "b": "1"',
        '        },',
        '        "name": "web"',
        '    },',
        `    "note": "a${escaped('3c')}b${escaped('3e')}${escaped('26')}c"`,
        '}',
        '',
      ].join('\n'),
    );
    expect(JSON.parse(formatKubectlJson(value)).note).toBe('a<b>&c');
  });

  test('formatCompactJson keeps field order and adds the encoder newline', () => {
    expect(formatCompactJson({ name: 'web', revision: '2', note: '<' })).toBe(`{"name":"web","revision":"2","note":"${escaped('3c')}"}\n`);
    expect(formatCompactJson(null)).toBe('null\n');
    expect(formatCompactJson([])).toBe('[]\n');
  });
});

describe('meta.json rules', () => {
  const steps = ['kubectl create namespace fixture-x', 'capture'];

  test('a synthetic scenario is accepted', () => {
    expect(metaErrors({ synthetic: true, k3sVersion: K3S_PIN.version, steps }, 'kubectl')).toEqual([]);
    expect(loadFixtureMeta('helm', 'helm-list').synthetic).toBe(true);
  });

  test('a recorded scenario is accepted', () => {
    expect(metaErrors({ k3sVersion: 'v1.36.4+k3s1', recordedOn: '2026-09-17', steps }, 'kubectl')).toEqual([]);
    expect(metaErrors({ k3sVersion: 'v1.36.4+k3s1', recordedOn: '2026-09-17', helmVersion: 'v4.3.0', steps }, 'helm')).toEqual([]);
    expect(loadFixtureMeta('kubectl', 'crashloop').recordedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('exactly one of synthetic and recordedOn', () => {
    const both = { synthetic: true, recordedOn: '2026-09-17', k3sVersion: K3S_PIN.version, steps };
    expect(metaErrors(both, 'kubectl')).toContain('exactly one of synthetic and recordedOn must be set');
    expect(metaErrors({ k3sVersion: K3S_PIN.version, steps }, 'kubectl')).toContain('exactly one of synthetic and recordedOn must be set');
    expect(metaErrors({ synthetic: false, k3sVersion: K3S_PIN.version, steps }, 'kubectl')).toContain('synthetic must be true when present');
  });

  test('versions, steps and unknown keys', () => {
    expect(metaErrors({ synthetic: true, k3sVersion: '1.36', steps }, 'kubectl')).toContain('k3sVersion must look like v1.36.4+k3s1');
    expect(metaErrors({ synthetic: true, k3sVersion: K3S_PIN.version, steps: [] }, 'kubectl')).toContain(
      'steps must be a non-empty list of non-empty strings',
    );
    expect(metaErrors({ synthetic: true, k3sVersion: K3S_PIN.version, steps, note: 'x' }, 'kubectl')).toContain('unknown key note');
    expect(metaErrors({ synthetic: true, k3sVersion: K3S_PIN.version, steps }, 'helm')).toContain('helmVersion must look like v4.3.0');
    expect(metaErrors({ synthetic: true, k3sVersion: K3S_PIN.version, helmVersion: 'v4.3.0', steps }, 'kubectl')).toContain(
      'helmVersion belongs to helm scenarios only',
    );
    expect(metaErrors([], 'kubectl')).toEqual(['meta.json is not an object']);
  });
});

// ---------------------------------------------------------------------------
// Scrub checker: each rule fires on a crafted copy of a clean file set
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

const baseline = store.fileSet('kubectl', 'crashloop');

function mutate(path: string, change: (items: JsonRecord[]) => void): FixtureFile[] {
  return baseline.map((file) => {
    if (file.path !== path) return file;
    const json = structuredClone(file.json) as { items: JsonRecord[] };
    change(json.items);
    return { ...file, json, text: formatKubectlJson(json) };
  });
}

function field(item: JsonRecord, ...path: (string | number)[]): JsonRecord {
  let current: unknown = item;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current as JsonRecord;
}

function expectViolation(files: FixtureFile[], pattern: RegExp): void {
  const found = scrubViolations(files);
  expect(found.some((v) => pattern.test(v))).toBe(true);
}

describe('scrub checker', () => {
  test('the clean file set passes', () => {
    expect(scrubViolations(baseline)).toEqual([]);
  });

  test('managedFields are refused', () => {
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'metadata').managedFields = [{ manager: 'kubectl-client-side-apply', operation: 'Update' }];
      }),
      /managedFields must be removed/,
    );
  });

  test('uids must be mapped to 00000000-0000-4000-8000-<counter>, in fields and in text', () => {
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'metadata').uid = '5d1c7e02-9f4b-4c3a-8a61-3f2e9b7c1d20';
      }),
      /uid 5d1c7e02-9f4b-4c3a-8a61-3f2e9b7c1d20 is not scrubbed/,
    );
    expectViolation(
      mutate('events.json', ([event]) => {
        event.message = 'pod web_fixture-crashloop(5d1c7e02-9f4b-4c3a-8a61-3f2e9b7c1d20)';
      }),
      /uid 5d1c7e02-9f4b-4c3a-8a61-3f2e9b7c1d20 is not scrubbed/,
    );
  });

  test('timestamps must be shifted to 2026-01-01 UTC and start at midnight', () => {
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'metadata').creationTimestamp = '2025-11-03T09:12:44Z';
      }),
      /timestamp 2025-11-03T09:12:44Z is not shifted/,
    );
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'status').startTime = '2026-01-01T02:15:00+02:00';
      }),
      /timestamp 2026-01-01T02:15:00\+02:00 is not shifted/,
    );
    // server-1 registered at midnight: its creation and first condition transitions are the earliest
    const midnight = '2026-01-01T00:00:00Z';
    const late = (value: unknown): unknown => {
      if (value === midnight) return '2026-01-01T00:00:05Z';
      if (Array.isArray(value)) return value.map(late);
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, late(v)]));
      return value;
    };
    expectViolation(
      mutate('nodes.json', (nodes) => {
        nodes.splice(0, nodes.length, ...nodes.map((n) => late(n) as JsonRecord));
      }),
      /earliest timestamp 2026-01-01T00:00:05Z is not 2026-01-01T00:00:00Z/,
    );
    expect(scrubViolations([{ path: 'list.json', text: '', json: [{ updated: '2025-12-31 23:59:59.5 +0000 UTC' }] }])).toEqual([
      'list.json[0].updated: timestamp 2025-12-31 23:59:59.5 +0000 UTC is not shifted to 2026-01-01 UTC',
    ]);
  });

  test('resourceVersions must be sequential numbers', () => {
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'metadata').resourceVersion = '48213';
      }),
      /resourceVersion 48213 exceeds/,
    );
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'metadata').resourceVersion = 'a1';
      }),
      /resourceVersion a1 is not a sequential number/,
    );
  });

  test('node names, pod IPs and host IPs must be scrubbed', () => {
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'spec').nodeName = 'k3s-agent-7f2c';
      }),
      /node name k3s-agent-7f2c is not scrubbed/,
    );
    expectViolation(
      mutate('nodes.json', ([node]) => {
        field(node, 'metadata', 'labels')['kubernetes.io/hostname'] = 'worker-a';
      }),
      /node name worker-a is not scrubbed/,
    );
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'status').podIP = '10.244.0.5';
      }),
      /pod IP 10\.244\.0\.5 is not 10\.42/,
    );
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'status').hostIP = '203.0.113.7';
      }),
      /host IP 203\.0\.113\.7 is not 192\.0\.2/,
    );
    expect(scrubViolations([{ path: 'upgrade-stderr.txt', text: 'dial tcp 198.51.100.4:443: i/o timeout' }])).toEqual([
      'upgrade-stderr.txt: IP address 198.51.100.4 is not scrubbed',
    ]);
  });

  test('container and image IDs must be containerd://<12 hex>', () => {
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'status', 'containerStatuses', 0).containerID = `containerd://${'ab12'.repeat(16)}`;
      }),
      /containerID containerd:\/\/(ab12)+ is not containerd:\/\/<12 hex>/,
    );
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'status', 'containerStatuses', 0).imageID = 'docker.io/library/busybox@sha256:0123';
      }),
      /imageID docker\.io\/library\/busybox@sha256:0123 is not containerd/,
    );
  });

  test('a string matching E2E_SECRET_ fails the recording', () => {
    expectViolation(
      mutate('events.json', ([event]) => {
        event.message = 'password=E2E_SECRET_db';
      }),
      /contains E2E_SECRET_/,
    );
  });

  test('ownerReferences must point at the mapped uid of their owner, and a uid names one object', () => {
    const deploymentUid = field(baseline.find((f) => f.path === 'deployments.apps.json')?.json as JsonRecord, 'items', 0, 'metadata').uid;
    expectViolation(
      mutate('pods.json', ([pod]) => {
        field(pod, 'metadata', 'ownerReferences', 0).uid = deploymentUid;
      }),
      /ownerReferences ReplicaSet\/web-app-\w+ has uid/,
    );
    expectViolation(
      mutate('replicasets.apps.json', ([rs]) => {
        field(rs, 'metadata').uid = deploymentUid;
      }),
      /is also the uid of Deployment\/fixture-crashloop\/web-app|is also the uid of ReplicaSet/,
    );
  });
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe('loader', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dockflow-fixtures-'));

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  test('loadKubectlFixture parses one List, with or without the .json suffix', () => {
    type PodList = { kind: string; items: Pod[] };
    const pods = loadKubectlFixture<PodList>('crashloop', 'pods');
    expect(pods.kind).toBe('List');
    expect(pods.items[0].metadata.namespace).toBe('fixture-crashloop');
    expect(loadKubectlFixture<PodList>('crashloop', 'pods.json')).toEqual(pods);
    expect(JSON.parse(readKubectlFixture('crashloop', 'pods'))).toEqual(pods);
  });

  test('a capture subdirectory is addressed through the file path or the capture argument', () => {
    const [mid] = loadKubectlList<DaemonSet>('daemonset-rolling', 'daemonsets.apps').items;
    const [done] = loadKubectlList<DaemonSet>('daemonset-rolling', 'daemonsets.apps', 'completed').items;
    expect(mid.status?.numberUnavailable).toBe(1);
    expect(done.status?.numberUnavailable).toBeUndefined();
    expect(loadKubectlFixture<KubeList<DaemonSet>>('daemonset-rolling', 'completed/daemonsets.apps')).toEqual(
      loadKubectlList<DaemonSet>('daemonset-rolling', 'daemonsets.apps', 'completed'),
    );
  });

  test('loadKubectlResources joins several Lists in the order asked, like one multi-resource get', () => {
    const joined = loadKubectlResources<{ kind: string }>('rollout-progressing', ['deployments.apps', 'replicasets.apps', 'pods']);
    expect(joined.apiVersion).toBe('v1');
    expect(joined.kind).toBe('List');
    expect(joined.items.map((i) => i.kind)).toEqual(['Deployment', 'ReplicaSet', 'ReplicaSet', 'Pod', 'Pod', 'Pod', 'Pod']);
  });

  test('splitFixtureRef splits on the first slash only', () => {
    expect(splitFixtureRef('daemonset-rolling/completed/pods')).toEqual({ scenario: 'daemonset-rolling', file: 'completed/pods' });
    expect(splitFixtureRef('crashloop/pods')).toEqual({ scenario: 'crashloop', file: 'pods' });
    expect(() => splitFixtureRef('crashloop')).toThrow('is not <scenario>/<file>');
    expect(() => splitFixtureRef('crashloop/')).toThrow('is not <scenario>/<file>');
  });

  test('helm and metrics fixtures load as recorded', () => {
    const history = loadHelmFixture<{ revision: number; status: string }[]>('helm-history-rollback', 'history');
    expect(history.map((h) => h.status)).toEqual(['superseded', 'failed', 'deployed']);
    expect(readHelmFixture('helm-status-failed', 'upgrade-stderr.txt')).toStartWith('Error: UPGRADE FAILED: ');
    expect(loadMetricsFixture<{ kind: string }>('metrics-top').kind).toBe('PodMetricsList');
  });

  test('paths leaving the scenario and unknown files are refused', () => {
    expect(() => loadKubectlFixture('crashloop', '../job-failed/pods')).toThrow('must be relative and stay inside its scenario');
    expect(() => loadKubectlFixture('../kubectl/crashloop', 'pods')).toThrow('must be relative and stay inside its scenario');
    expect(() => loadKubectlFixture('crashloop', 'secrets')).toThrow('does not exist');
    expect(() => loadKubectlFixture('no-such-scenario', 'pods')).toThrow('No kubectl fixture scenario no-such-scenario');
  });

  test('unscrubbed content is refused by every read of its scenario', () => {
    cpSync(join(FIXTURES_ROOT, 'kubectl', 'crashloop'), join(temp, 'kubectl', 'crashloop'), { recursive: true });
    const podsPath = join(temp, 'kubectl', 'crashloop', 'pods.json');
    const pods = JSON.parse(readKubectlFixture('crashloop', 'pods')) as { items: JsonRecord[] };
    field(pods.items[0], 'metadata').managedFields = [{ manager: 'kubectl' }];
    writeFileSync(podsPath, formatKubectlJson(pods));
    const tampered = new FixtureStore(temp);
    expect(() => tampered.kubectl('crashloop', 'events')).toThrow(/Fixture kubectl\/crashloop is not scrubbed[\s\S]*managedFields must be removed/);

    mkdirSync(join(temp, 'helm', 'leaky'), { recursive: true });
    writeFileSync(join(temp, 'helm', 'leaky', 'upgrade-stderr.txt'), 'Error: dial tcp 198.51.100.4:443: connect: connection refused\n');
    expect(() => tampered.helmText('leaky', 'upgrade-stderr.txt')).toThrow(/IP address 198\.51\.100\.4 is not scrubbed/);
  });

  test('CRLF line endings of a Windows checkout are read as LF', () => {
    cpSync(join(FIXTURES_ROOT, 'kubectl', 'job-complete'), join(temp, 'kubectl', 'job-complete'), { recursive: true });
    const path = join(temp, 'kubectl', 'job-complete', 'jobs.batch.json');
    const text = readKubectlFixture('job-complete', 'jobs.batch');
    writeFileSync(path, text.replace(/\n/g, '\r\n'));
    expect(new FixtureStore(temp).kubectlText('job-complete', 'jobs.batch')).toBe(text);
  });
});
