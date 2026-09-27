// Convergence evaluator and fail-fast classifier (design-03 9.3, 9.4, 22.2; design-07 9.5
// U-STATUS-CONV-*), fed by the kubectl fixtures of design-07 3.11. Pure: every poll is a snapshot
// and a `now`.

import { describe, expect, it, mock } from 'bun:test';
import type { WorkloadChange } from '../../../services/orchestrator/interfaces';
import type { Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { PersistentVolumeClaim, Pod } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  classifyPods,
  convergenceStep,
  currentPods,
  type EvaluationContext,
  evaluateConvergence,
  type FailedVerdict,
  K8S_FAILFAST_GRACE_S,
  type LbWatchTarget,
  lbTargetKey,
  NO_PROVISIONING_EVENT,
  type PollObject,
  type PollSnapshot,
  pollSnapshot,
  progressLine,
  targetKey,
  timeoutVerdicts,
  type Verdict,
  type WatchState,
  type WatchTarget,
  watchTarget,
} from '../../../services/orchestrator/kubernetes/status/convergence';
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

/** the crash-looping pod of the crashloop recording */
const CRASHLOOP_POD = 'web-app-fbf7d977d-dqwf8';

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** one K12 poll of a scenario; `pvcs` adds the K09 read */
function snapshotOf(scenario: string, options: { capture?: string; pvcs?: boolean } = {}): PollSnapshot {
  const capture = options.capture ?? '';
  const items = loadKubectlResources<PollObject>(scenario, POLL_RESOURCES, capture).items;
  const pvcs = options.pvcs ? loadKubectlList<PersistentVolumeClaim>(scenario, 'persistentvolumeclaims', capture).items : null;
  return pollSnapshot(items, pvcs);
}

function contextOf(scenario: string, overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    importedPrefix: 'dockflow.invalid/',
    nodeNames: { ...FIXTURE_SERVERS },
    role: 'app',
    env: 'production',
    namespace: fixtureNamespace(scenario),
    timeoutS: 300,
    ...overrides,
  };
}

function target(kind: WatchTarget['kind'], service: string, name: string, generation: number): WatchTarget {
  return { service, kind, name, serviceLabel: name, generation };
}

const EMPTY: WatchState = { firstSeen: {} };

function evaluate(
  t: WatchTarget,
  snap: PollSnapshot,
  context: EvaluationContext,
  state: WatchState = EMPTY,
  now: Date = T0,
): { verdict: Verdict; state: WatchState } {
  const evaluation = evaluateConvergence([t], [], snap, state, now, context);
  return { verdict: evaluation.verdicts[targetKey(t)], state: evaluation.state };
}

function expectFailed(verdict: Verdict): FailedVerdict {
  if (verdict.state !== 'failed') throw new Error(`expected a failure, got ${JSON.stringify(verdict)}`);
  return verdict;
}

function podNamed(snap: PollSnapshot, name: string): Pod {
  const found = snap.pods.find((p) => p.metadata.name === name);
  if (!found) throw new Error(`no pod ${name}`);
  return found;
}

function firstPod(snap: PollSnapshot): Pod {
  const [first] = snap.pods;
  if (!first) throw new Error('no pod');
  return first;
}

function firstDeployment(snap: PollSnapshot): Deployment {
  const [first] = snap.deployments;
  if (!first) throw new Error('no deployment');
  return first;
}

/** a classifier spy that must not be reached */
function classifierSpy() {
  return mock(classifyPods);
}

describe('Deployment rollout (W1, U-STATUS-CONV-01/02)', () => {
  const web = target('Deployment', 'web', 'web', 2);

  it('rollout-progressing is progressing without a failure', () => {
    const { verdict } = evaluate(web, snapshotOf('rollout-progressing'), contextOf('rollout-progressing'));
    expect(verdict).toMatchObject({ state: 'progressing', summary: '1/3 updated', needsPvcs: false });
  });

  it('rollout-complete converges', () => {
    const { verdict } = evaluate(web, snapshotOf('rollout-complete'), contextOf('rollout-complete'));
    expect(verdict).toEqual({ state: 'converged', summary: '3/3 ready' });
  });

  it('progressing, progressing, complete: the step is pending twice, then converged', () => {
    const deadline = at(300);
    const polls = ['rollout-progressing', 'rollout-progressing', 'rollout-complete'];
    let state = EMPTY;
    const steps = polls.map((scenario, i) => {
      const now = at(2 + i * 3);
      const evaluation = evaluateConvergence([web], [], snapshotOf(scenario), state, now, contextOf(scenario));
      state = evaluation.state;
      return convergenceStep(evaluation, [web], [], now, deadline, contextOf(scenario)).status;
    });
    expect(steps).toEqual(['pending', 'pending', 'converged']);
  });

  it('only the pods of the new ReplicaSet are current', () => {
    const snap = snapshotOf('rollout-progressing');
    const pods = currentPods(firstDeployment(snap), snap) ?? [];
    expect(pods.map((p) => p.metadata.name)).toEqual(['web-96d55d8c4-l67lt']);
  });

  it('old pods still counted by the Deployment keep it progressing', () => {
    const snap = snapshotOf('rollout-complete');
    const w = firstDeployment(snap);
    w.status = { ...w.status, replicas: 4 };
    expect(evaluate(web, snap, contextOf('rollout-complete')).verdict).toMatchObject({
      state: 'progressing',
      summary: '1 old pod(s) pending termination',
    });
  });

  it('updated but not yet available pods keep it progressing', () => {
    const snap = snapshotOf('rollout-complete');
    const w = firstDeployment(snap);
    w.status = { ...w.status, availableReplicas: 2 };
    expect(evaluate(web, snap, contextOf('rollout-complete')).verdict).toMatchObject({ state: 'progressing', summary: '2/3 ready' });
  });
});

describe('fail-fast classifier (design-03 9.4)', () => {
  const web = target('Deployment', 'web', 'web', 1);

  it('F1 ErrImageNeverPull fails at first sight', () => {
    const scenario = 'err-image-never-pull';
    const failed = expectFailed(evaluate(web, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'ErrImageNeverPull',
      message: 'Service web cannot start: image dockflow.invalid/shop-web:1.4.2 is not present on node server_1 and its pull policy is Never',
      instance: 'web-676dcfbd47-p9gx9',
      node: 'server_1',
    });
    expect(failed.suggestion).toBe('Remove pull_policy: never from services.web, or make sure the image exists on every node.');
    expect(failed.podUids).toEqual(['00000000-0000-4000-8000-000000000003']);
    expect(failed.ownerUids).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  });

  it('F2 InvalidImageName names the compose file of the role', () => {
    const scenario = 'invalid-image-name';
    const failed = expectFailed(evaluate(web, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure.reason).toBe('InvalidImageName');
    expect(failed.failure.message).toBe('Service web cannot start: image reference UPPER/Case:bad tag is invalid');
    expect(failed.suggestion).toBe('Fix the image of services.web in docker-compose.yml.');
    const accessory = expectFailed(evaluate(web, snapshotOf(scenario), contextOf(scenario, { role: 'accessory' })).verdict);
    expect(accessory.suggestion).toBe('Fix the image of services.web in accessories.yml.');
  });

  it('F3 an imported image missing on a node fails at first sight (W4)', () => {
    const scenario = 'image-pull-backoff';
    const snap = snapshotOf(scenario);
    const pod = firstPod(snap);
    const image = 'dockflow.invalid/shop-web-production:1.4.2';
    pod.spec.nodeName = 'agent-1';
    pod.spec.containers[0].image = image;
    const status = pod.status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.image = image;
    status.state = { waiting: { reason: 'ErrImagePull', message: 'failed to pull and unpack image' } };
    const failed = expectFailed(evaluate(web, snap, contextOf(scenario)).verdict);
    expect(failed.failure).toMatchObject({
      reason: 'ErrImagePull',
      message: `Service web cannot start: image ${image} was not imported on node agent_1`,
      node: 'agent_1',
    });
    expect(failed.suggestion).toBe('Deploy again without `--skip-build` and check the image distribution output.');
  });

  it('F4 a public image pull back-off fails after its 20 s grace', () => {
    const scenario = 'image-pull-backoff';
    const context = contextOf(scenario);
    const first = evaluate(web, snapshotOf(scenario), context, EMPTY, T0);
    expect(first.verdict.state).toBe('progressing');
    const second = evaluate(web, snapshotOf(scenario), context, first.state, at(10));
    expect(second.verdict.state).toBe('progressing');
    const third = evaluate(web, snapshotOf(scenario), context, second.state, at(25));
    const failed = expectFailed(third.verdict);
    const waiting = firstPod(snapshotOf(scenario)).status?.containerStatuses?.[0].state?.waiting?.message;
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'ImagePullBackOff',
      message: `Service web cannot pull image localhost:35010/e2e/missing:1 on node server_1: ${waiting}`,
      instance: 'web-679ff8548-l5hvb',
      node: 'server_1',
    });
    expect(failed.suggestion).toBe('Check that the tag exists and that the registry credentials in config.yml are valid.');
    expect(K8S_FAILFAST_GRACE_S.ImagePullBackOff).toBe(20);
  });

  it('F4 grace keeps running while kubelet alternates ErrImagePull and ImagePullBackOff', () => {
    const scenario = 'image-pull-backoff';
    const context = contextOf(scenario);
    const first = evaluate(web, snapshotOf(scenario), context, EMPTY, T0);
    const alternate = snapshotOf(scenario);
    const status = firstPod(alternate).status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.state = { waiting: { reason: 'ErrImagePull', message: 'rpc error' } };
    const second = evaluate(web, alternate, context, first.state, at(12));
    expect(second.verdict.state).toBe('progressing');
    expect(Object.values(second.state.firstSeen)).toEqual([T0.toISOString()]);
    expect(expectFailed(evaluate(web, snapshotOf(scenario), context, second.state, at(21)).verdict).failure.reason).toBe(
      'ImagePullBackOff',
    );
  });

  it('F5 CreateContainerConfigError fails after 15 s', () => {
    const scenario = 'create-container-config-error';
    const context = contextOf(scenario);
    const first = evaluate(web, snapshotOf(scenario), context, EMPTY, T0);
    expect(evaluate(web, snapshotOf(scenario), context, first.state, at(14)).verdict.state).toBe('progressing');
    const failed = expectFailed(evaluate(web, snapshotOf(scenario), context, first.state, at(15)).verdict);
    expect(failed.failure.message).toBe('Service web cannot create container web: secret "web-env-d521dbe6" not found');
    expect(failed.suggestion).toBe('Run `dockflow diagnose production`.');
  });

  it('F5 a transient signal resets firstSeen (W6)', () => {
    const scenario = 'create-container-config-error';
    const context = contextOf(scenario);
    const first = evaluate(web, snapshotOf(scenario), context, EMPTY, T0);
    expect(Object.keys(first.state.firstSeen)).toEqual(['00000000-0000-4000-8000-000000000003/web/CreateContainerConfigError']);
    const running = snapshotOf(scenario);
    const status = firstPod(running).status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.state = { running: { startedAt: '2026-01-01T00:16:35Z' } };
    const second = evaluate(web, running, context, first.state, at(5));
    expect(second.state.firstSeen).toEqual({});
    const third = evaluate(web, snapshotOf(scenario), context, second.state, at(20));
    expect(third.verdict.state).toBe('progressing');
    expect(Object.values(third.state.firstSeen)).toEqual([at(20).toISOString()]);
  });

  it('F6 CreateContainerError and RunContainerError keep the kubelet reason (U-STATUS-CONV-19)', () => {
    const scenario = 'create-container-config-error';
    const context = contextOf(scenario);
    for (const reason of ['CreateContainerError', 'RunContainerError']) {
      const snap = snapshotOf(scenario);
      const status = firstPod(snap).status?.containerStatuses?.[0];
      if (!status) throw new Error('no container status');
      status.state = { waiting: { reason, message: 'failed to create containerd task:\nexec: "/app": permission denied' } };
      const first = evaluate(web, snap, context, EMPTY, T0);
      expect(first.verdict.state).toBe('progressing');
      const failed = expectFailed(evaluate(web, snap, context, first.state, at(15)).verdict);
      expect(failed.failure.reason).toBe(reason);
      expect(failed.failure.message).toBe(
        'Service web cannot start container web: failed to create containerd task: exec: "/app": permission denied',
      );
      expect(failed.suggestion).toBe('Check command, entrypoint, user and volumes of services.web.');
    }
  });

  it('F7 CrashLoopBackOff names the compose service, the pod and the servers.yml key (U-STATUS-CONV-03)', () => {
    const scenario = 'crashloop';
    const webApp = target('Deployment', 'web_app', 'web-app', 1);
    const failed = expectFailed(evaluate(webApp, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'web_app',
      reason: 'CrashLoopBackOff',
      message: 'Service web_app keeps crashing: container web-app restarted 3 time(s), last exit code 1 (Error)',
      instance: CRASHLOOP_POD,
      node: 'server_1',
    });
    expect(failed.suggestion).toBe('Run `dockflow logs production web_app`.');
    const accessory = expectFailed(evaluate(webApp, snapshotOf(scenario), contextOf(scenario, { role: 'accessory' })).verdict);
    expect(accessory.suggestion).toBe('Run `dockflow accessories logs production web_app`.');
  });

  it('F7 when the kubelet reports the back-off as waiting in CrashLoopBackOff', () => {
    const scenario = 'crashloop';
    const snap = snapshotOf(scenario);
    const status = firstPod(snap).status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.state = { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s restarting failed container=web-app' } };
    status.lastState = { terminated: { exitCode: 2, reason: 'Error' } };
    const failed = expectFailed(evaluate(target('Deployment', 'web_app', 'web-app', 1), snap, contextOf(scenario)).verdict);
    expect(failed.failure).toMatchObject({
      reason: 'CrashLoopBackOff',
      message: 'Service web_app keeps crashing: container web-app restarted 3 time(s), last exit code 2 (Error)',
      instance: CRASHLOOP_POD,
    });
  });

  it('a completed init container is not a crash loop; a failed one that is retried is', () => {
    const scenario = 'crashloop';
    const snap = snapshotOf(scenario);
    const pod = firstPod(snap);
    pod.spec.initContainers = [{ name: 'migrate', image: 'busybox:1.37' }];
    const main = pod.status?.containerStatuses?.[0];
    if (!main || !pod.status) throw new Error('no container status');
    main.state = { waiting: { reason: 'PodInitializing' } };
    pod.status.initContainerStatuses = [{ name: 'migrate', image: 'busybox:1.37', ready: true, restartCount: 0, state: { terminated: { exitCode: 0, reason: 'Completed' } } }];
    const webApp = target('Deployment', 'web_app', 'web-app', 1);
    expect(evaluate(webApp, snap, contextOf(scenario)).verdict.state).toBe('progressing');

    pod.status.initContainerStatuses[0].state = { terminated: { exitCode: 1, reason: 'Error' } };
    expect(expectFailed(evaluate(webApp, snap, contextOf(scenario)).verdict).failure.reason).toBe('CrashLoopBackOff');
  });

  it('F7 without a last state reports an unknown exit code', () => {
    const scenario = 'crashloop';
    const snap = snapshotOf(scenario);
    const status = firstPod(snap).status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.state = { waiting: { reason: 'CrashLoopBackOff' } };
    status.lastState = {};
    const failed = expectFailed(evaluate(target('Deployment', 'web_app', 'web-app', 1), snap, contextOf(scenario)).verdict);
    expect(failed.failure.message).toBe('Service web_app keeps crashing: container web-app restarted 3 time(s), last exit code unknown');
  });

  it('F8 OOMKilled wins over the crash loop it causes (U-STATUS-CONV-05)', () => {
    const scenario = 'oom-killed';
    const failed = expectFailed(evaluate(web, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure).toMatchObject({
      reason: 'OOMKilled',
      message: 'Service web was killed for exceeding its memory limit (container web, limit 16Mi)',
      node: 'agent_1',
    });
    expect(failed.suggestion).toBe('Raise deploy.resources.limits.memory of services.web.');
  });

  it('F8 without a memory limit says none', () => {
    const scenario = 'oom-killed';
    const snap = snapshotOf(scenario);
    firstPod(snap).spec.containers[0].resources = {};
    expect(expectFailed(evaluate(web, snap, contextOf(scenario)).verdict).failure.message).toBe(
      'Service web was killed for exceeding its memory limit (container web, limit none)',
    );
  });

  for (const scenario of ['unschedulable-resources', 'unschedulable-node-selector']) {
    it(`F9 ${scenario} fails after 60 s with the scheduler message (W7, U-STATUS-CONV-06)`, () => {
      const context = contextOf(scenario);
      const first = evaluate(web, snapshotOf(scenario), context, EMPTY, T0);
      expect(first.verdict.state).toBe('progressing');
      expect(evaluate(web, snapshotOf(scenario), context, first.state, at(59)).verdict.state).toBe('progressing');
      const failed = expectFailed(evaluate(web, snapshotOf(scenario), context, first.state, at(60)).verdict);
      const message = firstPod(snapshotOf(scenario)).status?.conditions?.find((c) => c.type === 'PodScheduled')?.message;
      expect(failed.failure.reason).toBe('Unschedulable');
      expect(failed.failure.message).toBe(`Service web cannot be scheduled: ${message}`);
      expect(failed.failure.node).toBeUndefined();
      expect(failed.suggestion).toBe(
        'Check `deploy.placement`, `x-dockflow.node_selector` and node resources with `dockflow diagnose production`.',
      );
    });
  }

  it('F10 a Pending pod with a claim asks for PVCs, then fails after 60 s of a Pending claim (W14, U-STATUS-CONV-07)', () => {
    const scenario = 'pvc-pending-rwx';
    const context = contextOf(scenario);
    const withoutPvcs = evaluate(web, snapshotOf(scenario), context, EMPTY, T0);
    expect(withoutPvcs.verdict).toMatchObject({ state: 'progressing', needsPvcs: true });
    expect(withoutPvcs.state.firstSeen).toEqual({});
    const first = evaluate(web, snapshotOf(scenario, { pvcs: true }), context, withoutPvcs.state, at(3));
    expect(first.verdict).toMatchObject({ state: 'progressing', needsPvcs: true });
    expect(evaluate(web, snapshotOf(scenario, { pvcs: true }), context, first.state, at(62)).verdict.state).toBe('progressing');
    const failed = expectFailed(evaluate(web, snapshotOf(scenario, { pvcs: true }), context, first.state, at(63)).verdict);
    expect(failed.failure).toMatchObject({
      reason: 'PvcPending',
      message: `Service web is waiting for volume shared: ${NO_PROVISIONING_EVENT}`,
      instance: 'web-776897c7f5-khslt',
    });
    expect(failed.claims).toEqual([{ name: 'shared', uid: '00000000-0000-4000-8000-000000000004' }]);
    expect(failed.suggestion).toBe('Check the volume with `dockflow volumes list production`.');
  });

  /** the pvc-pending-rwx pod, rejected by the scheduler with `message` */
  function unschedulableClaimPod(message: string, options: { pvcs?: boolean } = {}): PollSnapshot {
    const snap = snapshotOf('pvc-pending-rwx', options);
    const pod = firstPod(snap);
    const others = (pod.status?.conditions ?? []).filter((c) => c.type !== 'PodScheduled');
    pod.status = { ...pod.status, conditions: [...others, { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message }] };
    return snap;
  }

  it('F10 wins over F9 when the scheduler blames an unbound Immediate claim', () => {
    const message = '0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims. not found';
    const context = contextOf('pvc-pending-rwx');
    const withoutPvcs = evaluate(web, unschedulableClaimPod(message), context, EMPTY, T0);
    expect(withoutPvcs.verdict).toMatchObject({ state: 'progressing', needsPvcs: true });
    expect(withoutPvcs.state.firstSeen).toEqual({});
    const first = evaluate(web, unschedulableClaimPod(message, { pvcs: true }), context, withoutPvcs.state, at(3));
    expect(evaluate(web, unschedulableClaimPod(message, { pvcs: true }), context, first.state, at(60)).verdict.state).toBe('progressing');
    const failed = expectFailed(evaluate(web, unschedulableClaimPod(message, { pvcs: true }), context, first.state, at(63)).verdict);
    expect(failed.failure).toMatchObject({ reason: 'PvcPending', message: `Service web is waiting for volume shared: ${NO_PROVISIONING_EVENT}` });
  });

  it('F9 still fails a claim-holding pod the scheduler rejects for its placement', () => {
    const message = "0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector.";
    const context = contextOf('pvc-pending-rwx');
    const first = evaluate(web, unschedulableClaimPod(message), context, EMPTY, T0);
    const failed = expectFailed(evaluate(web, unschedulableClaimPod(message), context, first.state, at(60)).verdict);
    expect(failed.failure).toMatchObject({ reason: 'Unschedulable', message: `Service web cannot be scheduled: ${message}` });
  });

  it('F10 a Bound claim is not a signal', () => {
    const scenario = 'pvc-pending-rwx';
    const snap = snapshotOf(scenario, { pvcs: true });
    for (const pvc of snap.pvcs ?? []) pvc.status = { phase: 'Bound' };
    const { verdict, state } = evaluate(web, snap, contextOf(scenario), EMPTY, at(120));
    expect(verdict.state).toBe('progressing');
    expect(state.firstSeen).toEqual({});
  });

  it('F11 ReplicaFailure (U-STATUS-CONV-09)', () => {
    const scenario = 'replica-failure-quota';
    const failed = expectFailed(evaluate(web, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'ReplicaFailure',
      message:
        'Service web cannot create pods: pods "web-ddff555b9-pjk2t" is forbidden: exceeded quota: pods, requested: pods=1, used: pods=1, limited: pods=1',
    });
    expect(failed.ownerUids).toContain('00000000-0000-4000-8000-000000000002');
    expect(failed.suggestion).toBe('Run `dockflow diagnose production`.');
  });

  it('F12 ProgressDeadlineExceeded names the deadline (W8, U-STATUS-CONV-08)', () => {
    const scenario = 'progress-deadline-exceeded';
    const failed = expectFailed(evaluate(web, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'ProgressDeadlineExceeded',
      message: 'Service web made no progress for 45s: 0/1 updated pod(s) ready',
    });
    expect(failed.suggestion).toBe('Run `dockflow logs production web`.');
    expect(failed.podUids).toEqual(['00000000-0000-4000-8000-000000000003']);
  });

  it('F13 a failed Job is TaskFailed (W13, U-STATUS-CONV-12)', () => {
    const scenario = 'job-failed';
    const migrate = target('Job', 'migrate', 'migrate-0a492d34', 1);
    const failed = expectFailed(evaluate(migrate, snapshotOf(scenario), contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'migrate',
      reason: 'TaskFailed',
      message: 'Job migrate failed: Job has reached the specified backoff limit',
    });
    expect(failed.suggestion).toBe('Run `dockflow logs production migrate`.');
  });

  it('F14 the deadline turns every unfinished target into a Timeout (U-STATUS-CONV-15)', () => {
    const scenario = 'rollout-progressing';
    const web2 = target('Deployment', 'web', 'web', 2);
    const context = contextOf(scenario);
    const evaluation = evaluateConvergence([web2], [], snapshotOf(scenario), EMPTY, at(300), context);
    expect(convergenceStep(evaluation, [web2], [], at(299), at(300), context).status).toBe('pending');
    const step = convergenceStep(evaluation, [web2], [], at(300), at(300), context);
    if (step.status !== 'timeout') throw new Error(`expected a timeout, got ${step.status}`);
    expect(step.failed).toHaveLength(1);
    expect(step.failed[0].failure).toEqual({
      service: 'web',
      reason: 'Timeout',
      message: 'Service web did not become ready within 300s: 1/3 updated',
    });
    expect(step.failed[0].suggestion).toBe('Run `dockflow diagnose production`.');
    expect(step.failed[0].podUids).toEqual(['00000000-0000-4000-8000-000000000007']);
  });

  it('F15 a paused Deployment fails right after gate 1 (W19)', () => {
    const scenario = 'rollout-progressing';
    const snap = snapshotOf(scenario);
    firstDeployment(snap).spec.paused = true;
    const failed = expectFailed(evaluate(target('Deployment', 'web', 'web', 2), snap, contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'Paused',
      message: 'Service web has a paused rollout, so the new version cannot start',
    });
    expect(failed.suggestion).toBe(
      'Resume it with `kubectl -n fixture-rollout-progressing rollout resume deployment/web`, then deploy again.',
    );
  });

  it('F15 does not preempt gate 1', () => {
    const scenario = 'rollout-progressing';
    const snap = snapshotOf(scenario);
    const w = firstDeployment(snap);
    w.spec.paused = true;
    w.metadata.generation = 3;
    expect(evaluate(target('Deployment', 'web', 'web', 3), snap, contextOf(scenario)).verdict).toMatchObject({
      state: 'progressing',
      summary: 'waiting for the controller',
    });
  });

  it('F16 a workload being deleted', () => {
    const scenario = 'rollout-progressing';
    const snap = snapshotOf(scenario);
    firstDeployment(snap).metadata.deletionTimestamp = '2026-01-01T00:18:30Z';
    const failed = expectFailed(evaluate(target('Deployment', 'web', 'web', 2), snap, contextOf(scenario)).verdict);
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'WorkloadDeleting',
      message: 'Service web (deployment/web) is being deleted while this deploy waits for it',
    });
    expect(failed.suggestion).toBe('Wait until it is gone, then run `dockflow deploy production` again.');
  });
});

describe('-lb Service targets (K19, F14b)', () => {
  const scenario = 'rollout-complete';
  const webLb: LbWatchTarget = { service: 'web', name: 'web-lb', ports: [{ port: 8080, protocol: 'TCP' }] };

  function lbVerdict(snap: PollSnapshot, state: WatchState, now: Date): { verdict: Verdict; state: WatchState } {
    const evaluation = evaluateConvergence([], [webLb], snap, state, now, contextOf(scenario));
    return { verdict: evaluation.verdicts[lbTargetKey(webLb)], state: evaluation.state };
  }

  function unbound(): PollSnapshot {
    const snap = snapshotOf(scenario);
    for (const service of snap.services) service.status = { loadBalancer: {} };
    return snap;
  }

  it('with an ingress address it converges', () => {
    expect(lbVerdict(snapshotOf(scenario), EMPTY, T0).verdict).toEqual({ state: 'converged', summary: '8080/TCP bound' });
  });

  it('without an address it is pending at +59 s and LoadBalancerPending at +60 s', () => {
    const first = lbVerdict(unbound(), EMPTY, T0);
    expect(first.verdict).toMatchObject({ state: 'progressing', summary: 'waiting for 8080/TCP on every node' });
    expect(lbVerdict(unbound(), first.state, at(59)).verdict.state).toBe('progressing');
    const failed = expectFailed(lbVerdict(unbound(), first.state, at(60)).verdict);
    expect(failed.failure).toEqual({
      service: 'web',
      reason: 'LoadBalancerPending',
      message: 'Published port 8080/TCP of service web was not bound by the load balancer within 60s',
    });
    expect(failed.suggestion).toBe('Change the published port of `web` in docker-compose.yml, or stop the stack that uses it.');
    expect(failed.loadBalancer).toEqual({ namespace: 'fixture-rollout-complete', name: 'web-lb', ports: [{ port: 8080, protocol: 'TCP' }] });
  });

  it('an address gained within the grace converges (W17)', () => {
    const first = lbVerdict(unbound(), EMPTY, T0);
    const later = lbVerdict(snapshotOf(scenario), first.state, at(40));
    expect(later.verdict.state).toBe('converged');
    expect(later.state.firstSeen).toEqual({});
  });

  it('a Service not returned yet is waited for', () => {
    const snap = snapshotOf(scenario);
    snap.services = [];
    expect(lbVerdict(snap, EMPTY, at(600)).verdict).toMatchObject({ state: 'progressing', summary: 'waiting for the Service' });
  });

  it('ready workloads do not save a deploy whose -lb Service never binds (W16)', () => {
    const web = target('Deployment', 'web', 'web', 2);
    const context = contextOf(scenario);
    const first = evaluateConvergence([web], [webLb], unbound(), EMPTY, T0, context);
    expect(convergenceStep(first, [web], [webLb], T0, at(300), context).status).toBe('pending');
    const second = evaluateConvergence([web], [webLb], unbound(), first.state, at(60), context);
    const step = convergenceStep(second, [web], [webLb], at(60), at(300), context);
    if (step.status !== 'failed') throw new Error(`expected a failure, got ${step.status}`);
    expect(step.failed.map((f) => f.failure.reason)).toEqual(['LoadBalancerPending']);
  });

  it('at the deadline an unbound -lb Service is reported as F14b', () => {
    const context = contextOf(scenario);
    const evaluation = evaluateConvergence([], [webLb], unbound(), EMPTY, T0, context);
    const [failed] = timeoutVerdicts(evaluation, [], [webLb], context);
    expect(failed.failure.reason).toBe('LoadBalancerPending');
    expect(failed.loadBalancer?.name).toBe('web-lb');
    expect(failed.ownerUids).toEqual(['00000000-0000-4000-8000-000000000008']);
  });
});

describe('the two gates, Deployment (K16)', () => {
  const scenario = 'crashloop';
  const context = contextOf(scenario);

  /** crashloop with the Deployment at `generation` while the controller last observed `observed` */
  function lagging(generation: number, observed: number, revision: string): PollSnapshot {
    const snap = snapshotOf(scenario);
    const w = firstDeployment(snap);
    w.metadata.generation = generation;
    w.metadata.annotations = { ...w.metadata.annotations, 'deployment.kubernetes.io/revision': revision };
    w.status = { ...w.status, observedGeneration: observed };
    return snap;
  }

  /** adds the ReplicaSet of `revision` with one pod in the given container state */
  function withNewReplicaSet(snap: PollSnapshot, revision: string, ready: boolean): void {
    const [oldRs] = snap.replicaSets;
    const oldPod = firstPod(snap);
    const rs = structuredClone(oldRs);
    rs.metadata.name = 'web-app-8c7d6f5b4a';
    rs.metadata.uid = 'rs-new';
    rs.metadata.annotations = { ...rs.metadata.annotations, 'deployment.kubernetes.io/revision': revision };
    const pod = structuredClone(oldPod);
    pod.metadata.name = 'web-app-8c7d6f5b4a-q2x7z';
    pod.metadata.uid = 'pod-new';
    pod.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: rs.metadata.name, uid: 'rs-new', controller: true }];
    pod.status = {
      phase: ready ? 'Running' : 'Pending',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [
        {
          name: 'web-app',
          image: 'busybox:1.37',
          ready,
          restartCount: 0,
          state: ready ? { running: { startedAt: '2026-01-01T00:16:40Z' } } : { waiting: { reason: 'ContainerCreating' } },
        },
      ],
    };
    snap.replicaSets.push(rs);
    snap.pods.push(pod);
  }

  it('generation not observed plus an old pod in CrashLoopBackOff -> progressing, at 2 s and at 30 s (U-STATUS-CONV-14b)', () => {
    const webApp = target('Deployment', 'web_app', 'web-app', 2);
    let state = EMPTY;
    for (const now of [at(2), at(30)]) {
      const spy = classifierSpy();
      const evaluation = evaluateConvergence([webApp], [], lagging(2, 1, '1'), state, now, context, spy);
      expect(evaluation.verdicts[targetKey(webApp)]).toMatchObject({ state: 'progressing', summary: 'waiting for the controller' });
      expect(spy).not.toHaveBeenCalled();
      expect(evaluation.state.firstSeen).toEqual({});
      state = evaluation.state;
    }
  });

  it('generation not observed with every pod Ready is not converged (U-STATUS-CONV-14)', () => {
    const snap = snapshotOf('rollout-complete');
    const w = firstDeployment(snap);
    w.metadata.generation = 3;
    const { verdict } = evaluate(target('Deployment', 'web', 'web', 3), snap, contextOf('rollout-complete'));
    expect(verdict).toMatchObject({ state: 'progressing', summary: 'waiting for the controller' });
  });

  it('generation observed but the new ReplicaSet not created yet -> no pod classified (U-STATUS-CONV-14c)', () => {
    const webApp = target('Deployment', 'web_app', 'web-app', 2);
    const spy = classifierSpy();
    const evaluation = evaluateConvergence([webApp], [], lagging(2, 2, '2'), EMPTY, at(2), context, spy);
    expect(evaluation.verdicts[targetKey(webApp)]).toMatchObject({ state: 'progressing', summary: 'waiting for the new revision' });
    expect(spy).not.toHaveBeenCalled();
    expect(evaluation.state.firstSeen).toEqual({});
  });

  it('an old ReplicaSet pod in CrashLoopBackOff is ignored once the new ReplicaSet exists (U-STATUS-CONV-13)', () => {
    const webApp = target('Deployment', 'web_app', 'web-app', 2);
    const snap = lagging(2, 2, '2');
    withNewReplicaSet(snap, '2', true);
    const w = firstDeployment(snap);
    w.status = { ...w.status, replicas: 1, updatedReplicas: 1, availableReplicas: 1, readyReplicas: 1 };
    const { verdict, state } = evaluate(webApp, snap, context, EMPTY, at(2));
    expect(verdict).toEqual({ state: 'converged', summary: '1/1 ready' });
    expect(state.firstSeen).toEqual({});
  });

  it('deploying a fix for a crash-looping service converges without a failure (W15)', () => {
    const webApp = target('Deployment', 'web_app', 'web-app', 8);
    const poll1 = lagging(8, 7, '7');
    poll1.replicaSets[0].metadata.annotations = { 'deployment.kubernetes.io/revision': '7' };

    const poll2 = lagging(8, 8, '8');
    poll2.replicaSets[0].metadata.annotations = { 'deployment.kubernetes.io/revision': '7' };
    withNewReplicaSet(poll2, '8', false);
    firstDeployment(poll2).status = { observedGeneration: 8, replicas: 2, updatedReplicas: 1 };

    const poll3 = lagging(8, 8, '8');
    poll3.replicaSets[0].metadata.annotations = { 'deployment.kubernetes.io/revision': '7' };
    withNewReplicaSet(poll3, '8', true);
    poll3.pods = poll3.pods.filter((p) => p.metadata.uid === 'pod-new');
    firstDeployment(poll3).status = { observedGeneration: 8, replicas: 1, updatedReplicas: 1, availableReplicas: 1 };

    let state = EMPTY;
    const verdicts = [poll1, poll2, poll3].map((snap, i) => {
      const result = evaluate(webApp, snap, context, state, at(2 + i * 3));
      state = result.state;
      return result.verdict;
    });
    expect(verdicts.map((v) => v.state)).toEqual(['progressing', 'progressing', 'converged']);
    expect(verdicts[0]).toMatchObject({ summary: 'waiting for the controller' });
    expect(verdicts[1]).toMatchObject({ summary: '1 old pod(s) pending termination' });
  });
});

describe('the two gates, StatefulSet (K16, U-STATUS-CONV-10)', () => {
  const scenario = 'statefulset-stuck';
  const context = contextOf(scenario, { role: 'accessory' });
  const db = target('StatefulSet', 'db', 'db', 2);

  it('only the ordinal on updateRevision is classified', () => {
    const failed = expectFailed(evaluate(db, snapshotOf(scenario), context).verdict);
    expect(failed.failure).toEqual({
      service: 'db',
      reason: 'CrashLoopBackOff',
      message: 'Service db keeps crashing: container db restarted 3 time(s), last exit code 1 (Error)',
      instance: 'db-1',
      node: 'agent_1',
    });
    expect(failed.suggestion).toBe('Run `dockflow accessories logs production db`.');
  });

  it('generation not observed while db-1 crash-loops -> waiting for the controller, no pod classified (U-STATUS-CONV-14b)', () => {
    const snap = snapshotOf(scenario);
    snap.statefulSets[0].metadata.generation = 3;
    const spy = classifierSpy();
    const evaluation = evaluateConvergence([target('StatefulSet', 'db', 'db', 3)], [], snap, EMPTY, T0, context, spy);
    expect(evaluation.verdicts['StatefulSet/db']).toMatchObject({ state: 'progressing', summary: 'waiting for the controller' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('updateRevision without its ControllerRevision -> waiting for the new revision, no pod classified', () => {
    const snap = snapshotOf(scenario);
    const sts = snap.statefulSets[0];
    sts.status = { ...sts.status, updateRevision: 'db-7c9d8e6f5a' };
    const spy = classifierSpy();
    const evaluation = evaluateConvergence([db], [], snap, EMPTY, T0, context, spy);
    expect(evaluation.verdicts['StatefulSet/db']).toMatchObject({ state: 'progressing', summary: 'waiting for the new revision' });
    expect(spy).not.toHaveBeenCalled();
  });

  /** db-1 Ready on the update revision */
  function healed(): PollSnapshot {
    const snap = snapshotOf(scenario);
    const db0 = podNamed(snap, 'db-0');
    const db1 = podNamed(snap, 'db-1');
    db1.status = structuredClone(db0.status);
    return snap;
  }

  it('an old-revision ordinal in CrashLoopBackOff is not a failure', () => {
    const snap = healed();
    const db0 = podNamed(snap, 'db-0');
    db0.status = structuredClone(podNamed(snapshotOf(scenario), 'db-1').status);
    const sts = snap.statefulSets[0];
    sts.status = { ...sts.status, readyReplicas: 1 };
    const { verdict } = evaluate(db, snap, context);
    expect(verdict).toMatchObject({ state: 'progressing', summary: '1/2 ready' });
  });

  it('updateRevision !== currentRevision keeps it progressing even with every replica ready', () => {
    const snap = healed();
    const sts = snap.statefulSets[0];
    sts.status = { ...sts.status, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 };
    expect(evaluate(db, snap, context).verdict).toMatchObject({ state: 'progressing', summary: '2/2 updated' });
  });

  it('converges once currentRevision reaches updateRevision', () => {
    const snap = healed();
    const sts = snap.statefulSets[0];
    sts.status = {
      ...sts.status,
      readyReplicas: 2,
      availableReplicas: 2,
      updatedReplicas: 2,
      currentReplicas: 2,
      currentRevision: sts.status?.updateRevision,
    };
    expect(evaluate(db, snap, context).verdict).toEqual({ state: 'converged', summary: '2/2 ready' });
  });
});

describe('the two gates, DaemonSet (K16, U-STATUS-CONV-11)', () => {
  const scenario = 'daemonset-rolling';
  const context = contextOf(scenario);
  const agent = target('DaemonSet', 'agent', 'agent', 2);

  it('mid-rollout is progressing, the completed capture converges', () => {
    expect(evaluate(agent, snapshotOf(scenario), context).verdict).toMatchObject({ state: 'progressing', summary: '1/2 nodes updated' });
    expect(evaluate(agent, snapshotOf(scenario, { capture: 'completed' }), context).verdict).toEqual({
      state: 'converged',
      summary: '2/2 nodes ready',
    });
  });

  it('the newest ControllerRevision hash selects the current pods', () => {
    const snap = snapshotOf(scenario);
    const pods = currentPods(snap.daemonSets[0], snap) ?? [];
    expect(pods.map((p) => p.metadata.name)).toEqual(['agent-gwt4s']);
    for (const revision of snap.controllerRevisions) delete revision.metadata.labels;
    expect((currentPods(snap.daemonSets[0], snap) ?? []).map((p) => p.metadata.name)).toEqual(['agent-gwt4s']);
  });

  it('an updateStrategy-only change (new generation, no new revision) converges', () => {
    const snap = snapshotOf(scenario, { capture: 'completed' });
    const ds = snap.daemonSets[0];
    ds.metadata.generation = 3;
    ds.spec.updateStrategy = { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 2 } };
    ds.status = { ...ds.status, observedGeneration: 3 };
    expect(evaluate(target('DaemonSet', 'agent', 'agent', 3), snap, context).verdict.state).toBe('converged');
  });

  it('generation not observed plus crash-looping pods -> waiting for the controller, no pod classified (U-STATUS-CONV-14b)', () => {
    const snap = snapshotOf(scenario, { capture: 'completed' });
    snap.daemonSets[0].metadata.generation = 3;
    for (const pod of snap.pods) {
      pod.status = {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'False' }],
        containerStatuses: [
          {
            name: 'agent',
            image: 'busybox:1.37',
            ready: false,
            restartCount: 5,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 1, reason: 'Error' } },
          },
        ],
      };
    }
    const spy = classifierSpy();
    const evaluation = evaluateConvergence([target('DaemonSet', 'agent', 'agent', 3)], [], snap, EMPTY, T0, context, spy);
    expect(evaluation.verdicts['DaemonSet/agent']).toMatchObject({ state: 'progressing', summary: 'waiting for the controller' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('no ControllerRevision at all -> waiting for the new revision', () => {
    const snap = snapshotOf(scenario);
    snap.controllerRevisions = [];
    expect(evaluate(agent, snap, context).verdict).toMatchObject({ state: 'progressing', summary: 'waiting for the new revision' });
  });

  it('a crash-looping pod of the previous revision is ignored', () => {
    const snap = snapshotOf(scenario);
    const old = podNamed(snap, 'agent-gg8cw');
    old.status = {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [
        { name: 'agent', image: 'busybox:1.37', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      ],
    };
    expect(evaluate(agent, snap, context).verdict.state).toBe('progressing');
  });
});

describe('Jobs (U-STATUS-CONV-12)', () => {
  it('Complete converges', () => {
    const scenario = 'job-complete';
    const migrate = target('Job', 'migrate', 'migrate-8d802302', 1);
    expect(evaluate(migrate, snapshotOf(scenario), contextOf(scenario)).verdict).toEqual({ state: 'converged', summary: 'completed' });
  });

  it('SuccessCriteriaMet alone converges', () => {
    const scenario = 'job-complete';
    const snap = snapshotOf(scenario);
    const job = snap.jobs[0];
    job.status = { ...job.status, conditions: job.status?.conditions?.filter((c) => c.type === 'SuccessCriteriaMet') };
    expect(evaluate(target('Job', 'migrate', 'migrate-8d802302', 1), snap, contextOf(scenario)).verdict.state).toBe('converged');
  });

  it('FailureTarget alone is TaskFailed', () => {
    const scenario = 'job-failed';
    const snap = snapshotOf(scenario);
    const job = snap.jobs[0];
    job.status = { ...job.status, conditions: job.status?.conditions?.filter((c) => c.type === 'FailureTarget') };
    const failed = expectFailed(evaluate(target('Job', 'migrate', 'migrate-0a492d34', 1), snap, contextOf(scenario)).verdict);
    expect(failed.failure.reason).toBe('TaskFailed');
  });

  function running(state: 'running' | 'crashing'): PollSnapshot {
    const snap = snapshotOf('job-complete');
    const job = snap.jobs[0];
    job.status = { active: 1, startTime: '2026-01-01T00:15:00Z' };
    const pod = firstPod(snap);
    pod.status = {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'migrate',
          image: 'busybox:1.37',
          ready: state === 'running',
          restartCount: state === 'running' ? 0 : 2,
          state: state === 'running' ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: state === 'running' ? {} : { terminated: { exitCode: 2, reason: 'Error' } },
        },
      ],
    };
    return snap;
  }

  it('a running Job reports its pods; Jobs have no generation gate', () => {
    const migrate = target('Job', 'migrate', 'migrate-8d802302', 1);
    const snap = running('running');
    delete snap.jobs[0].metadata.generation;
    expect(evaluate(migrate, snap, contextOf('job-complete')).verdict).toMatchObject({
      state: 'progressing',
      summary: '1 running, 0 succeeded',
    });
  });

  it('a Job pod in CrashLoopBackOff fails the wait', () => {
    const failed = expectFailed(evaluate(target('Job', 'migrate', 'migrate-8d802302', 1), running('crashing'), contextOf('job-complete')).verdict);
    expect(failed.failure).toMatchObject({ reason: 'CrashLoopBackOff', instance: 'migrate-8d802302-rcg26' });
  });

  it('an exited container of a restartPolicy Never pod is left to the Job conditions, not read as a crash loop', () => {
    const snap = running('running');
    const pod = firstPod(snap);
    pod.spec.restartPolicy = 'Never';
    const status = pod.status?.containerStatuses?.[0];
    if (!status) throw new Error('no container status');
    status.state = { terminated: { exitCode: 1, reason: 'Error' } };
    expect(evaluate(target('Job', 'migrate', 'migrate-8d802302', 1), snap, contextOf('job-complete')).verdict).toMatchObject({
      state: 'progressing',
      summary: '1 running, 0 succeeded',
    });
  });
});

describe('status counters omitted by Kubernetes (?? 0)', () => {
  it('a Deployment scaled to 0 converges', () => {
    const scenario = 'rollout-complete';
    const snap = snapshotOf(scenario);
    const w = firstDeployment(snap);
    w.spec.replicas = 0;
    w.status = { observedGeneration: 2 };
    snap.pods = [];
    expect(evaluate(target('Deployment', 'web', 'web', 2), snap, contextOf(scenario)).verdict).toEqual({
      state: 'converged',
      summary: '0/0 ready',
    });
  });

  it('a StatefulSet scaled to 0 converges', () => {
    const scenario = 'statefulset-stuck';
    const snap = snapshotOf(scenario);
    const sts = snap.statefulSets[0];
    const revision = sts.status?.updateRevision;
    sts.spec.replicas = 0;
    sts.status = { observedGeneration: 2, updateRevision: revision, currentRevision: revision };
    snap.pods = [];
    expect(evaluate(target('StatefulSet', 'db', 'db', 2), snap, contextOf(scenario)).verdict.state).toBe('converged');
  });

  it('a DaemonSet scheduled nowhere converges', () => {
    const scenario = 'daemonset-rolling';
    const snap = snapshotOf(scenario, { capture: 'completed' });
    snap.daemonSets[0].status = { observedGeneration: 2 };
    snap.pods = [];
    expect(evaluate(target('DaemonSet', 'agent', 'agent', 2), snap, contextOf(scenario)).verdict).toEqual({
      state: 'converged',
      summary: '0/0 nodes ready',
    });
  });
});

describe('targets and nodes', () => {
  it('a workload missing from the poll is waited for', () => {
    const scenario = 'rollout-complete';
    const snap = snapshotOf(scenario);
    snap.deployments = [];
    expect(evaluate(target('Deployment', 'web', 'web', 2), snap, contextOf(scenario)).verdict).toMatchObject({
      state: 'progressing',
      summary: 'waiting for Deployment web',
    });
  });

  it('the node is the servers.yml key when mapped, else the Kubernetes node name', () => {
    const scenario = 'crashloop';
    const webApp = target('Deployment', 'web_app', 'web-app', 1);
    expect(expectFailed(evaluate(webApp, snapshotOf(scenario), contextOf(scenario)).verdict).failure.node).toBe('server_1');
    expect(expectFailed(evaluate(webApp, snapshotOf(scenario), contextOf(scenario, { nodeNames: {} })).verdict).failure.node).toBe(
      'server-1',
    );
  });

  it('watchTarget reads the P/service label of the applied object, else derives it from the compose name', () => {
    const snap = snapshotOf('crashloop');
    const change: WorkloadChange = {
      service: 'web_app',
      kind: 'Deployment',
      name: 'web-app',
      created: false,
      previousRevision: '1',
      previousRevisionNumber: 1,
      previousReplicas: 1,
      generation: 4,
    };
    const applied = firstDeployment(snap);
    applied.metadata.labels = { ...applied.metadata.labels, 'dockflow.shawiizz.dev/service': 'web-app-label' };
    expect(watchTarget(change, [applied])).toEqual({
      service: 'web_app',
      kind: 'Deployment',
      name: 'web-app',
      serviceLabel: 'web-app-label',
      generation: 4,
    });
    expect(watchTarget(change, []).serviceLabel).toBe('web-app');
  });
});

describe('poll snapshot, step and progress line', () => {
  it('pollSnapshot splits one multi-resource List by kind', () => {
    const items = loadKubectlResources<PollObject>('rollout-complete', POLL_RESOURCES).items;
    const events = loadKubectlList('rollout-complete', 'events').items as unknown as PollObject[];
    const snap = pollSnapshot([...items, ...events], []);
    expect(snap.deployments.map((d) => d.metadata.name)).toEqual(['web']);
    expect(snap.replicaSets).toHaveLength(2);
    expect(snap.pods).toHaveLength(3);
    expect(snap.services.map((s) => s.metadata.name)).toEqual(['web', 'web-lb']);
    expect(snap.statefulSets).toEqual([]);
    expect(snap.pvcs).toEqual([]);
    expect(pollSnapshot([]).pvcs).toBeNull();
  });

  it('no target converges immediately', () => {
    const context = contextOf('rollout-complete');
    const evaluation = evaluateConvergence([], [], pollSnapshot([]), EMPTY, T0, context);
    expect(convergenceStep(evaluation, [], [], T0, at(300), context)).toEqual({ status: 'converged' });
  });

  it('a pending step asks for PVCs when a progressing target needs them', () => {
    const scenario = 'pvc-pending-rwx';
    const web = target('Deployment', 'web', 'web', 1);
    const context = contextOf(scenario);
    const evaluation = evaluateConvergence([web], [], snapshotOf(scenario), EMPTY, T0, context);
    expect(convergenceStep(evaluation, [web], [], T0, at(300), context)).toEqual({ status: 'pending', wantPvcs: true });
  });

  it('a failure ends the wait before the deadline is considered', () => {
    const scenario = 'crashloop';
    const webApp = target('Deployment', 'web_app', 'web-app', 1);
    const context = contextOf(scenario);
    const evaluation = evaluateConvergence([webApp], [], snapshotOf(scenario), EMPTY, at(400), context);
    expect(convergenceStep(evaluation, [webApp], [], at(400), at(300), context).status).toBe('failed');
  });

  it('progressLine lists every target', () => {
    const targets = [target('Deployment', 'web', 'web', 1), target('Deployment', 'api', 'api', 1), target('Job', 'worker', 'worker-1a2b3c4d', 1)];
    const lb: LbWatchTarget[] = [{ service: 'web', name: 'web-lb', ports: [{ port: 80, protocol: 'TCP' }] }];
    const verdicts: Record<string, Verdict> = {
      'Deployment/web': { state: 'progressing', summary: '1/2 updated', needsPvcs: false, podUids: [], ownerUids: [] },
      'Deployment/api': { state: 'progressing', summary: '0/1 ready', needsPvcs: false, podUids: [], ownerUids: [] },
      'Job/worker-1a2b3c4d': { state: 'converged', summary: 'completed' },
      'Service/web-lb': { state: 'progressing', summary: 'waiting for 80/TCP on every node', needsPvcs: false, podUids: [], ownerUids: [] },
    };
    expect(progressLine(targets, lb, verdicts)).toBe('web 1/2 updated · api 0/1 ready · worker ready · web-lb pending');
  });
});
