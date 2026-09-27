// Health stability evaluation (design-03 10 and 22.4 H rows; design-07 9.5 U-STATUS-HEALTH-*),
// fed by the kubectl fixtures of design-07 3.11. Pure: every poll is a snapshot and a `now`.

import { describe, expect, it } from 'bun:test';
import * as genericConstants from '../../../constants';
import * as kubernetesConstants from '../../../services/orchestrator/kubernetes/constants';
import type { Pod } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  type EvaluationContext,
  evaluateHealth,
  type HealthProgress,
  type HealthStep,
  healthStep,
  initialHealthProgress,
  notReadyFailure,
  type PollObject,
  type PollSnapshot,
  podStateText,
  pollSnapshot,
  type WatchTarget,
} from '../../../services/orchestrator/kubernetes/status/convergence';
import { FIXTURE_SERVERS, fixtureNamespace, loadKubectlResources } from '../support/kubectl-fixtures';

const POLL_RESOURCES = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'controllerrevisions.apps',
  'jobs.batch',
  'pods',
] as const;

const T0 = new Date('2026-01-01T00:25:00.000Z');
const HEALTH_TIMEOUT_S = 120;
const STABILITY_S = genericConstants.HEALTH_STABILITY_WINDOW_S;

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

const DEADLINE = at(HEALTH_TIMEOUT_S);

function snapshotOf(scenario: string): PollSnapshot {
  return pollSnapshot(loadKubectlResources<PollObject>(scenario, POLL_RESOURCES).items);
}

function contextOf(scenario: string): EvaluationContext {
  return {
    importedPrefix: 'dockflow.invalid/',
    nodeNames: { ...FIXTURE_SERVERS },
    role: 'app',
    env: 'production',
    namespace: fixtureNamespace(scenario),
    timeoutS: HEALTH_TIMEOUT_S,
  };
}

function deployment(service: string, name: string, generation: number): WatchTarget {
  return { service, kind: 'Deployment', name, serviceLabel: name, generation };
}

const web = deployment('web', 'web', 2);

/** runs healthStep over the polls, stopping at the first terminal step */
function run(
  targets: WatchTarget[],
  polls: { snap: PollSnapshot; now: Date }[],
  context: EvaluationContext,
): { steps: HealthStep['status'][]; last: HealthStep } {
  let progress: HealthProgress = initialHealthProgress();
  const steps: HealthStep['status'][] = [];
  let last: HealthStep | null = null;
  for (const { snap, now } of polls) {
    last = healthStep(targets, snap, progress, now, DEADLINE, STABILITY_S, context);
    steps.push(last.status);
    progress = last.progress;
    if (last.status !== 'pending') break;
  }
  if (last === null) throw new Error('no poll');
  return { steps, last };
}

function podNamed(snap: PollSnapshot, name: string): Pod {
  const found = snap.pods.find((p) => p.metadata.name === name);
  if (!found) throw new Error(`no pod ${name}`);
  return found;
}

function restarted(snap: PollSnapshot, name: string, count: number): PollSnapshot {
  const status = podNamed(snap, name).status?.containerStatuses?.[0];
  if (!status) throw new Error('no container status');
  status.restartCount = count;
  status.lastState = { terminated: { exitCode: 137, reason: 'Error' } };
  return snap;
}

function unready(snap: PollSnapshot, name: string): PollSnapshot {
  const pod = podNamed(snap, name);
  pod.status = { ...pod.status, conditions: [{ type: 'Ready', status: 'False' }] };
  return snap;
}

describe('stability window (H1)', () => {
  const scenario = 'rollout-complete';

  it('pods Ready for the whole window are healthy after three observations', () => {
    const polls = [0, 5, 10].map((s) => ({ snap: snapshotOf(scenario), now: at(s) }));
    const { steps, last } = run([web], polls, contextOf(scenario));
    expect(steps).toEqual(['pending', 'pending', 'healthy']);
    expect(last.progress.stableSince).toEqual(T0);
    expect(Object.keys(last.progress.baseline ?? {})).toHaveLength(3);
  });

  it('a pod that stops being Ready restarts the window', () => {
    const polls = [
      { snap: snapshotOf(scenario), now: at(0) },
      { snap: unready(snapshotOf(scenario), 'web-b655d585b-vnpn8'), now: at(5) },
      { snap: snapshotOf(scenario), now: at(10) },
      { snap: snapshotOf(scenario), now: at(15) },
      { snap: snapshotOf(scenario), now: at(20) },
    ];
    const { steps } = run([web], polls, contextOf(scenario));
    expect(steps).toEqual(['pending', 'pending', 'pending', 'pending', 'healthy']);
  });

  it('a window already running when the deadline passes completes', () => {
    const late = [115, 120, 125].map((s) => ({ snap: snapshotOf(scenario), now: at(s) }));
    expect(run([web], late, contextOf(scenario)).steps).toEqual(['pending', 'pending', 'healthy']);
  });

  it('the window length is the single generic constant (U-STATUS-HEALTH-03)', () => {
    expect(genericConstants.HEALTH_STABILITY_WINDOW_S).toBe(10);
    expect('K8S_STABILITY_WINDOW_S' in genericConstants).toBe(false);
    expect('K8S_STABILITY_WINDOW_S' in kubernetesConstants).toBe(false);
  });
});

describe('restarts during the window (H2, U-STATUS-HEALTH-01)', () => {
  const scenario = 'rollout-complete';

  it('a restart count above the baseline is ContainerRestarted', () => {
    const polls = [
      { snap: snapshotOf(scenario), now: at(0) },
      { snap: restarted(snapshotOf(scenario), 'web-b655d585b-vnpn8', 1), now: at(5) },
    ];
    const { steps, last } = run([web], polls, contextOf(scenario));
    expect(steps).toEqual(['pending', 'unhealthy']);
    if (last.status !== 'unhealthy') throw new Error('expected unhealthy');
    expect(last.failed).toHaveLength(1);
    expect(last.failed[0].failure).toEqual({
      service: 'web',
      reason: 'ContainerRestarted',
      message: 'Service web restarted during the health window: container web in pod web-b655d585b-vnpn8 (last exit code 137, Error)',
      instance: 'web-b655d585b-vnpn8',
      node: 'agent_1',
    });
    expect(last.failed[0].suggestion).toBe('Run `dockflow logs production web`.');
    expect(last.failed[0].ownerUids).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  });

  it('restarts before every pod was first Ready set the baseline, they are not failures', () => {
    const polls = [
      { snap: unready(restarted(snapshotOf(scenario), 'web-b655d585b-vnpn8', 2), 'web-b655d585b-vnpn8'), now: at(0) },
      { snap: restarted(snapshotOf(scenario), 'web-b655d585b-vnpn8', 2), now: at(5) },
      { snap: restarted(snapshotOf(scenario), 'web-b655d585b-vnpn8', 2), now: at(10) },
      { snap: restarted(snapshotOf(scenario), 'web-b655d585b-vnpn8', 2), now: at(15) },
    ];
    const { steps, last } = run([web], polls, contextOf(scenario));
    expect(steps).toEqual(['pending', 'pending', 'pending', 'healthy']);
    expect(last.progress.baseline?.['00000000-0000-4000-8000-000000000005/web']).toBe(2);
  });

  it('restart counts are reported per pod and container', () => {
    const evaluation = evaluateHealth([web], snapshotOf(scenario), null, { firstSeen: {} }, T0, contextOf(scenario));
    expect(evaluation.restartCounts).toEqual({
      '00000000-0000-4000-8000-000000000004/web': 0,
      '00000000-0000-4000-8000-000000000005/web': 0,
      '00000000-0000-4000-8000-000000000006/web': 0,
    });
    expect(evaluation.allReady).toBe(true);
    expect(evaluation.notReady).toEqual([]);
  });

  it('a restart without a recorded last state reports an unknown exit code', () => {
    const snap = snapshotOf(scenario);
    const status = podNamed(snap, 'web-b655d585b-vnpn8').status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.restartCount = 1;
    const evaluation = evaluateHealth(
      [web],
      snap,
      { '00000000-0000-4000-8000-000000000005/web': 0 },
      { firstSeen: {} },
      T0,
      contextOf(scenario),
    );
    expect(evaluation.failures[0].failure.message).toBe(
      'Service web restarted during the health window: container web in pod web-b655d585b-vnpn8 (last exit code unknown)',
    );
  });
});

describe('fail-fast signals during the window', () => {
  it('a crash loop fails the check with its F7 failure', () => {
    const scenario = 'crashloop';
    const { last } = run([deployment('web_app', 'web-app', 1)], [{ snap: snapshotOf(scenario), now: T0 }], contextOf(scenario));
    if (last.status !== 'unhealthy') throw new Error(`expected unhealthy, got ${last.status}`);
    expect(last.failed[0].failure).toMatchObject({ service: 'web_app', reason: 'CrashLoopBackOff', instance: 'web-app-fbf7d977d-dqwf8' });
  });

  it('a signal with a grace fails only once the grace has passed', () => {
    const scenario = 'image-pull-backoff';
    const polls = [0, 10, 20].map((s) => ({ snap: snapshotOf(scenario), now: at(s) }));
    const { steps } = run([deployment('web', 'web', 1)], polls, contextOf(scenario));
    expect(steps).toEqual(['pending', 'pending', 'unhealthy']);
  });
});

describe('deadline (U-STATUS-HEALTH timeouts)', () => {
  it('a pod not Ready at the deadline is a Timeout naming its state', () => {
    const scenario = 'node-not-ready';
    const target = deployment('web', 'web', 1);
    const polls = [0, 60, 120].map((s) => ({ snap: snapshotOf(scenario), now: at(s) }));
    const { steps, last } = run([target], polls, contextOf(scenario));
    expect(steps).toEqual(['pending', 'pending', 'timeout']);
    if (last.status !== 'timeout') throw new Error('expected timeout');
    expect(last.failed.map((f) => f.failure)).toEqual([
      {
        service: 'web',
        reason: 'Timeout',
        message: 'Service web is not healthy after 120s: pod web-56fd5fd7bf-42nbx is Running (not ready)',
        instance: 'web-56fd5fd7bf-42nbx',
        node: 'agent_1',
      },
    ]);
    expect(last.failed[0].suggestion).toBe('Run `dockflow diagnose production`.');
    expect(last.failed[0].podUids).toEqual(['00000000-0000-4000-8000-000000000003']);
  });

  it('fewer current pods than replicas at the deadline is a Timeout with the count', () => {
    const scenario = 'rollout-complete';
    const snap = snapshotOf(scenario);
    snap.deployments[0].spec.replicas = 4;
    const { last } = run([web], [{ snap, now: DEADLINE }], contextOf(scenario));
    if (last.status !== 'timeout') throw new Error(`expected timeout, got ${last.status}`);
    expect(last.failed.map((f) => f.failure.message)).toEqual(['Service web is not healthy after 120s: 3/4 pod(s) ready']);
    expect(last.failed[0].podUids).toHaveLength(3);
  });

  it('a workload whose generation is not observed has no current pods', () => {
    const scenario = 'rollout-complete';
    const snap = snapshotOf(scenario);
    snap.deployments[0].metadata.generation = 3;
    const evaluation = evaluateHealth([web], snap, null, { firstSeen: {} }, T0, contextOf(scenario));
    expect(evaluation.allReady).toBe(false);
    expect(evaluation.notReady).toEqual([
      { kind: 'count', service: 'web', ready: 0, desired: 3, podUids: [], ownerUids: ['00000000-0000-4000-8000-000000000001'] },
    ]);
    expect(notReadyFailure(evaluation.notReady[0], contextOf(scenario)).failure.message).toBe(
      'Service web is not healthy after 120s: 0/3 pod(s) ready',
    );
  });

  it('a missing workload is not ready', () => {
    const scenario = 'rollout-complete';
    const snap = snapshotOf(scenario);
    snap.deployments = [];
    const evaluation = evaluateHealth([web], snap, null, { firstSeen: {} }, T0, contextOf(scenario));
    expect(evaluation.allReady).toBe(false);
    expect(evaluation.notReady).toMatchObject([{ kind: 'count', ready: 0, desired: 1 }]);
  });
});

describe('pods that do not count', () => {
  it('an evicted pod left as Failed is ignored', () => {
    const scenario = 'evicted-pod';
    const polls = [0, 5, 10].map((s) => ({ snap: snapshotOf(scenario), now: at(s) }));
    expect(run([deployment('web', 'web', 1)], polls, contextOf(scenario)).steps).toEqual(['pending', 'pending', 'healthy']);
  });

  it('a terminating pod is ignored', () => {
    const scenario = 'terminating-pods';
    const polls = [0, 5, 10].map((s) => ({ snap: snapshotOf(scenario), now: at(s) }));
    expect(run([deployment('web', 'web', 1)], polls, contextOf(scenario)).steps).toEqual(['pending', 'pending', 'healthy']);
  });

  it('Job targets are not part of the health check', () => {
    const scenario = 'job-failed';
    const job: WatchTarget = { service: 'migrate', kind: 'Job', name: 'migrate-0a492d34', serviceLabel: 'migrate', generation: 1 };
    const evaluation = evaluateHealth([job], snapshotOf(scenario), null, { firstSeen: {} }, T0, contextOf(scenario));
    expect(evaluation).toEqual({ failures: [], allReady: true, restartCounts: {}, notReady: [], state: { firstSeen: {} } });
  });

  it('a DaemonSet is healthy once every scheduled node runs a Ready current pod', () => {
    const agent: WatchTarget = { service: 'agent', kind: 'DaemonSet', name: 'agent', serviceLabel: 'agent', generation: 2 };
    const rolling = evaluateHealth([agent], snapshotOf('daemonset-rolling'), null, { firstSeen: {} }, T0, contextOf('daemonset-rolling'));
    expect(rolling.allReady).toBe(false);
    // mid-rollout: agent-1 still runs the previous revision, so one current pod of two
    expect(rolling.notReady).toMatchObject([{ kind: 'count', service: 'agent', ready: 1, desired: 2 }]);
    const completed = pollSnapshot(loadKubectlResources<PollObject>('daemonset-rolling', POLL_RESOURCES, 'completed').items);
    expect(evaluateHealth([agent], completed, null, { firstSeen: {} }, T0, contextOf('daemonset-rolling')).allReady).toBe(true);
  });
});

describe('podStateText', () => {
  function pod(status: Pod['status'], deletionTimestamp?: string): Pod {
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-1', ...(deletionTimestamp ? { deletionTimestamp } : {}) },
      spec: { containers: [{ name: 'web', image: 'nginx:1.27-alpine' }] },
      status,
    };
  }
  const waiting = (reason: string) => ({ name: 'web', image: 'nginx', ready: false, restartCount: 0, state: { waiting: { reason } } });

  it.each([
    ['Terminating', pod({ phase: 'Running' }, '2026-01-01T00:20:00Z')],
    ['Evicted', pod({ phase: 'Failed', reason: 'Evicted' })],
    ['Init:CrashLoopBackOff', pod({ phase: 'Pending', initContainerStatuses: [waiting('CrashLoopBackOff')] })],
    [
      'Init:ExitCode:3',
      pod({ phase: 'Pending', initContainerStatuses: [{ name: 'init', image: 'x', ready: false, restartCount: 0, state: { terminated: { exitCode: 3 } } }] }),
    ],
    ['CrashLoopBackOff', pod({ phase: 'Running', containerStatuses: [waiting('CrashLoopBackOff')] })],
    ['Pending (Unschedulable)', pod({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] })],
    ['Pending', pod({ phase: 'Pending' })],
    ['Running (not ready)', pod({ phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] })],
    ['Running', pod({ phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] })],
    ['Unknown', pod(undefined)],
  ])('%s', (expected, input) => {
    expect(podStateText(input)).toBe(expected);
  });
});
