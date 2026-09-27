// Enrichment of failures (design-03 9.5 and 22.2 events row; design-07 9.5 U-STATUS-CONV-16/17):
// events attached by uid, the claim event of F10, the K13b port-owner reduction of F14b, and
// redaction. Pure.

import { describe, expect, it } from 'bun:test';
import type { ServiceFailure } from '../../../services/orchestrator/interfaces';
import { K8S_EVENTS_PER_FAILURE } from '../../../services/orchestrator/kubernetes/constants';
import type { Event, PersistentVolumeClaim, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  attachEvents,
  claimEventText,
  EVENT_TEXT_MAX,
  type EvaluationContext,
  enrichFailure,
  enrichLoadBalancerFailure,
  evaluateConvergence,
  type FailedVerdict,
  findPortOwner,
  type LbWatchTarget,
  lbTargetKey,
  loadBalancerMessage,
  NO_PROVISIONING_EVENT,
  type PollObject,
  type PollSnapshot,
  pollSnapshot,
  redactFailure,
  targetKey,
  timeoutVerdicts,
  type Verdict,
  type WatchTarget,
} from '../../../services/orchestrator/kubernetes/status/convergence';
import { Redactor } from '../../../utils/redact';
import { FIXTURE_SERVERS, fixtureNamespace, loadKubectlList, loadKubectlResources } from '../support/kubectl-fixtures';

const POLL_RESOURCES = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'controllerrevisions.apps',
  'jobs.batch',
  'pods',
  'services',
] as const;

const T0 = new Date('2026-01-01T00:16:30.000Z');
const NO_SECRETS = new Redactor();

function snapshotOf(scenario: string, pvcs = false): PollSnapshot {
  const items = loadKubectlResources<PollObject>(scenario, POLL_RESOURCES).items;
  return pollSnapshot(items, pvcs ? loadKubectlList<PersistentVolumeClaim>(scenario, 'persistentvolumeclaims').items : null);
}

function eventsOf(scenario: string): Event[] {
  return loadKubectlList<Event>(scenario, 'events').items;
}

function contextOf(scenario: string, namespace = fixtureNamespace(scenario)): EvaluationContext {
  return { importedPrefix: 'dockflow.invalid/', nodeNames: { ...FIXTURE_SERVERS }, role: 'app', env: 'production', namespace, timeoutS: 300 };
}

function deployment(service: string, name: string, generation: number): WatchTarget {
  return { service, kind: 'Deployment', name, serviceLabel: name, generation };
}

function expectFailed(verdict: Verdict | undefined): FailedVerdict {
  if (verdict?.state !== 'failed') throw new Error(`expected a failure, got ${JSON.stringify(verdict)}`);
  return verdict;
}

function event(uid: string, reason: string, message: string, times: Partial<Pick<Event, 'lastTimestamp' | 'eventTime' | 'firstTimestamp'>>, type: Event['type'] = 'Warning'): Event {
  return {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `${reason}.${uid}` },
    involvedObject: { kind: 'Pod', name: 'web-1', uid },
    type,
    reason,
    message,
    ...times,
  };
}

const failure: ServiceFailure = { service: 'web', reason: 'CrashLoopBackOff', message: 'Service web keeps crashing' };

describe('attachEvents', () => {
  it('keeps the Warning events of the failing pod, its ReplicaSet and its workload only', () => {
    const events = [
      event('pod', 'BackOff', 'pod event', { lastTimestamp: '2026-01-01T00:16:03Z' }),
      event('rs', 'FailedCreate', 'rs event', { lastTimestamp: '2026-01-01T00:16:02Z' }),
      event('deploy', 'ProgressDeadline', 'deployment event', { lastTimestamp: '2026-01-01T00:16:01Z' }),
      event('other', 'BackOff', 'another pod', { lastTimestamp: '2026-01-01T00:16:04Z' }),
      event('pod', 'Pulled', 'normal event', { lastTimestamp: '2026-01-01T00:16:05Z' }, 'Normal'),
    ];
    expect(attachEvents(failure, events, ['pod', 'rs', 'deploy']).message).toBe(
      'Service web keeps crashing (events: BackOff: pod event | FailedCreate: rs event | ProgressDeadline: deployment event)',
    );
  });

  it('orders by lastTimestamp, then eventTime (MicroTime), then firstTimestamp, newest first', () => {
    const events = [
      event('pod', 'A', 'first timestamp only', { firstTimestamp: '2026-01-01T00:15:10Z' }),
      event('pod', 'B', 'event time', { eventTime: '2026-01-01T00:15:20.500000Z' }),
      event('pod', 'C', 'last timestamp', { lastTimestamp: '2026-01-01T00:15:20Z', firstTimestamp: '2026-01-01T00:15:30Z' }),
    ];
    expect(attachEvents(failure, events, ['pod']).message).toBe(
      'Service web keeps crashing (events: B: event time | C: last timestamp | A: first timestamp only)',
    );
  });

  it('attaches at most K8S_EVENTS_PER_FAILURE events', () => {
    const events = Array.from({ length: 6 }, (_, i) => event('pod', `R${i}`, `m${i}`, { lastTimestamp: `2026-01-01T00:16:0${i}Z` }));
    const message = attachEvents(failure, events, ['pod']).message;
    expect(K8S_EVENTS_PER_FAILURE).toBe(3);
    expect(message).toBe('Service web keeps crashing (events: R5: m5 | R4: m4 | R3: m3)');
  });

  it('cuts each event to 300 characters and keeps one paragraph', () => {
    const long = event('pod', 'Unhealthy', `Readiness probe failed:\n${'x'.repeat(400)}`, { lastTimestamp: '2026-01-01T00:16:00Z' });
    const message = attachEvents(failure, [long], ['pod']).message;
    const text = message.slice(message.indexOf('(events: ') + '(events: '.length, -1);
    expect(text).toHaveLength(EVENT_TEXT_MAX);
    expect(text.startsWith('Unhealthy: Readiness probe failed: xxx')).toBe(true);
    expect(text.endsWith('...')).toBe(true);
    expect(message).not.toContain('\n');
  });

  it('returns the failure unchanged when no event matches', () => {
    expect(attachEvents(failure, [event('other', 'BackOff', 'x', {})], ['pod'])).toBe(failure);
    expect(attachEvents(failure, [], ['pod'])).toBe(failure);
  });

  it('crashloop: the BackOff event of the pod is appended (W2)', () => {
    const scenario = 'crashloop';
    const target = deployment('web_app', 'web-app', 1);
    const evaluation = evaluateConvergence([target], [], snapshotOf(scenario), { firstSeen: {} }, T0, contextOf(scenario));
    const enriched = enrichFailure(expectFailed(evaluation.verdicts[targetKey(target)]), eventsOf(scenario), NO_SECRETS);
    expect(enriched).toEqual({
      service: 'web_app',
      reason: 'CrashLoopBackOff',
      message:
        'Service web_app keeps crashing: container web-app restarted 3 time(s), last exit code 1 (Error) (events: BackOff: Back-off restarting failed container web-app in pod web-app-fbf7d977d-dqwf8_fixture-crashloop(00000000-0000-4000-8000-000000000003))',
      instance: 'web-app-fbf7d977d-dqwf8',
      node: 'server_1',
    });
  });

  it('replica-failure-quota: the FailedCreate events of the new ReplicaSet are appended', () => {
    const scenario = 'replica-failure-quota';
    const target = deployment('web', 'web', 1);
    const evaluation = evaluateConvergence([target], [], snapshotOf(scenario), { firstSeen: {} }, T0, contextOf(scenario));
    const enriched = enrichFailure(expectFailed(evaluation.verdicts[targetKey(target)]), eventsOf(scenario), NO_SECRETS);
    // the event recorder folds repeated rejections into one "combined" event, the newest
    expect(enriched.message).toContain(
      '(events: FailedCreate: (combined from similar events): Error creating: pods "web-ddff555b9-jrptc" is forbidden',
    );
    expect(enriched.message.match(/FailedCreate/g)).toHaveLength(3);
  });

  it('a timeout carries the last Unhealthy event (W9)', () => {
    const scenario = 'progress-deadline-exceeded';
    const snap = snapshotOf(scenario);
    const w = snap.deployments[0];
    w.status = { ...w.status, conditions: [] };
    const target = deployment('web', 'web', 1);
    const context = contextOf(scenario);
    const evaluation = evaluateConvergence([target], [], snap, { firstSeen: {} }, T0, context);
    const [timeout] = timeoutVerdicts(evaluation, [target], [], context);
    expect(enrichFailure(timeout, eventsOf(scenario), NO_SECRETS).message).toBe(
      'Service web did not become ready within 300s: 0/1 ready (events: Unhealthy: Readiness probe failed:)',
    );
  });
});

describe('F10 claim event', () => {
  const scenario = 'pvc-pending-rwx';

  function pvcFailure(): FailedVerdict {
    const target = deployment('web', 'web', 1);
    const context = contextOf(scenario);
    const first = evaluateConvergence([target], [], snapshotOf(scenario, true), { firstSeen: {} }, T0, context);
    const later = evaluateConvergence([target], [], snapshotOf(scenario, true), first.state, new Date(T0.getTime() + 60_000), context);
    return expectFailed(later.verdicts[targetKey(target)]);
  }

  it('the last Warning event of the claim completes the message', () => {
    const verdict = pvcFailure();
    const provisioning =
      'failed to provision volume with StorageClass "dockflow-local": NodePath only supports ReadWriteOnce and ReadWriteOncePod (1.22+) access modes';
    expect(claimEventText(eventsOf(scenario), verdict.claims)).toBe(provisioning);
    // the other events of the scenario are Normal ones, so nothing else is attached
    expect(enrichFailure(verdict, eventsOf(scenario), NO_SECRETS).message).toBe(`Service web is waiting for volume shared: ${provisioning}`);
  });

  it('without a claim event the message says so', () => {
    const verdict = pvcFailure();
    expect(claimEventText([], verdict.claims)).toBeNull();
    expect(enrichFailure(verdict, [], NO_SECRETS).message).toBe(`Service web is waiting for volume shared: ${NO_PROVISIONING_EVENT}`);
  });

  it('an event naming the claim without a uid is matched by kind and name', () => {
    const named: Event = {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: 'shared.1' },
      involvedObject: { kind: 'PersistentVolumeClaim', name: 'shared' },
      type: 'Warning',
      reason: 'ProvisioningFailed',
      message: 'no node satisfies the claim',
      lastTimestamp: '2026-01-01T00:16:00Z',
    };
    expect(claimEventText([named], [{ name: 'shared', uid: 'uid-shared' }])).toBe('no node satisfies the claim');
  });
});

describe('redaction (U-STATUS-CONV-16)', () => {
  it('a registered secret never survives in the message, the events included', () => {
    const scenario = 'create-container-config-error';
    const snap = snapshotOf(scenario);
    const status = snap.pods[0].status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.state = { waiting: { reason: 'CreateContainerConfigError', message: 'invalid value s3cr3t-value for DB_PASSWORD' } };
    const target = deployment('web', 'web', 1);
    const context = contextOf(scenario);
    const first = evaluateConvergence([target], [], snap, { firstSeen: {} }, T0, context);
    const later = evaluateConvergence([target], [], snap, first.state, new Date(T0.getTime() + 15_000), context);
    const verdict = expectFailed(later.verdicts[targetKey(target)]);
    const events = [event('00000000-0000-4000-8000-000000000003', 'Failed', 'Error: czNjcjN0LXZhbHVl rejected', { lastTimestamp: '2026-01-01T00:16:00Z' })];
    const enriched = enrichFailure(verdict, events, new Redactor(['s3cr3t-value']));
    expect(enriched.message).toBe('Service web cannot create container web: invalid value *** for DB_PASSWORD (events: Failed: Error: *** rejected)');
  });

  it('redactFailure only touches the message', () => {
    const f: ServiceFailure = { service: 'web', reason: 'Timeout', message: 'token abcdef123 leaked', instance: 'web-1', node: 'server_1' };
    expect(redactFailure(f, new Redactor(['abcdef123']))).toEqual({ ...f, message: 'token *** leaked' });
  });
});

describe('K13b port owner (U-STATUS-CONV-17, W16)', () => {
  const NS = 'dockflow-shop-production';

  function lbService(namespace: string, name: string, ports: [number, 'TCP' | 'UDP'][], bound: boolean): Service {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace, uid: `${namespace}/${name}` },
      spec: { type: 'LoadBalancer', ports: ports.map(([port, protocol]) => ({ port, protocol, targetPort: port })) },
      status: { loadBalancer: bound ? { ingress: [{ ip: '192.0.2.11' }] } : {} },
    };
  }

  const self = { namespace: NS, name: 'web-lb' };
  const failing = lbService(NS, 'web-lb', [[80, 'TCP']], false);

  it('Dockflow Traefik in dockflow-system is named as such', () => {
    const traefik = lbService('dockflow-system', 'dockflow-traefik', [[80, 'TCP'], [443, 'TCP']], true);
    expect(findPortOwner([failing, traefik], self, [{ port: 80, protocol: 'TCP' }])).toEqual({
      port: { port: 80, protocol: 'TCP' },
      name: 'dockflow-traefik',
      namespace: 'dockflow-system',
    });
  });

  it('another service of the same stack', () => {
    const api = lbService(NS, 'api-lb', [[80, 'TCP']], true);
    expect(findPortOwner([failing, api], self, [{ port: 80, protocol: 'TCP' }])).toMatchObject({ name: 'api-lb', namespace: NS });
  });

  it('a service of the sibling role in the same namespace', () => {
    const adminer = lbService(NS, 'adminer-lb', [[80, 'TCP']], true);
    adminer.metadata.labels = { 'dockflow.shawiizz.dev/role': 'accessory' };
    expect(findPortOwner([adminer, failing], self, [{ port: 80, protocol: 'TCP' }])).toMatchObject({ name: 'adminer-lb', namespace: NS });
  });

  it('a Service of another project entirely', () => {
    const other = lbService('dockflow-blog-production', 'web-lb', [[80, 'TCP']], true);
    expect(findPortOwner([failing, other], self, [{ port: 80, protocol: 'TCP' }])).toMatchObject({
      name: 'web-lb',
      namespace: 'dockflow-blog-production',
    });
  });

  it('the Service holding the port wins over another one also waiting for it', () => {
    const waiting = lbService('dockflow-a-production', 'a-lb', [[80, 'TCP']], false);
    const holder = lbService('dockflow-b-production', 'b-lb', [[80, 'TCP']], true);
    expect(findPortOwner([waiting, holder], self, [{ port: 80, protocol: 'TCP' }])).toMatchObject({ name: 'b-lb' });
    expect(findPortOwner([waiting], self, [{ port: 80, protocol: 'TCP' }])).toMatchObject({ name: 'a-lb' });
  });

  it('ignores the failing Service, other protocols and non-LoadBalancer Services', () => {
    const udp = lbService('dockflow-dns-production', 'dns-lb', [[80, 'UDP']], true);
    const clusterIp: Service = { ...lbService(NS, 'web', [[80, 'TCP']], false), spec: { ports: [{ port: 80, protocol: 'TCP' }] } };
    expect(findPortOwner([failing, udp, clusterIp], self, [{ port: 80, protocol: 'TCP' }])).toBeNull();
  });

  it('names the port that conflicts among several', () => {
    const traefik = lbService('dockflow-system', 'dockflow-traefik', [[443, 'TCP']], true);
    expect(findPortOwner([traefik], self, [{ port: 8080, protocol: 'TCP' }, { port: 443, protocol: 'TCP' }])?.port).toEqual({
      port: 443,
      protocol: 'TCP',
    });
  });

  function lbFailure(): FailedVerdict {
    const scenario = 'rollout-complete';
    const snap = snapshotOf(scenario);
    for (const s of snap.services) s.status = { loadBalancer: {} };
    const webLb: LbWatchTarget = { service: 'web', name: 'web-lb', ports: [{ port: 80, protocol: 'TCP' }] };
    const context = contextOf(scenario, NS);
    const first = evaluateConvergence([], [webLb], snap, { firstSeen: {} }, T0, context);
    const later = evaluateConvergence([], [webLb], snap, first.state, new Date(T0.getTime() + 60_000), context);
    return expectFailed(later.verdicts[lbTargetKey(webLb)]);
  }

  it('the F14b failure names the owner found cluster-wide (W16)', () => {
    const traefik = lbService('dockflow-system', 'dockflow-traefik', [[80, 'TCP'], [443, 'TCP']], true);
    expect(enrichLoadBalancerFailure(lbFailure(), [failing, traefik], NO_SECRETS)).toEqual({
      service: 'web',
      reason: 'LoadBalancerPending',
      message: 'Published port 80/TCP of service web cannot be bound: it is already used by service dockflow-traefik in namespace dockflow-system',
    });
  });

  it('without an owner the message keeps the not-bound wording', () => {
    expect(enrichLoadBalancerFailure(lbFailure(), [failing], NO_SECRETS).message).toBe(
      'Published port 80/TCP of service web was not bound by the load balancer within 60s',
    );
    expect(loadBalancerMessage('web', undefined, null)).toBe('The published ports of service web were not bound by the load balancer within 60s');
  });

  it('a verdict that is not a LoadBalancerPending one is only redacted', () => {
    const verdict: FailedVerdict = {
      state: 'failed',
      failure: { service: 'web', reason: 'Timeout', message: 'secret-token-1 timed out' },
      suggestion: '',
      podUids: [],
      ownerUids: [],
      claims: [],
      loadBalancer: null,
    };
    expect(enrichLoadBalancerFailure(verdict, [], new Redactor(['secret-token-1'])).message).toBe('*** timed out');
  });
});
