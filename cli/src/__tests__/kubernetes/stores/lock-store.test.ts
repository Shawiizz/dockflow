// LeaseLockStore (DESIGN-CORE 6.7, design-03 14, 22.6 L*). Cluster mode over FakeCluster, renewal
// driven by FakeClock.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { LOCK_STALE_THRESHOLD_MINUTES } from '../../../constants';
import type { LockData } from '../../../services/orchestrator/interfaces';
import { formatMicroTime, LeaseLockStore, leaseYaml, parseLockData } from '../../../services/orchestrator/kubernetes/backends/lock-store';
import { ANNOTATIONS, K8S_LEASE_RENEW_INTERVAL_S, K8S_MANAGED_BY, K8S_SYSTEM_NAMESPACE, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import type { Lease } from '../../../services/orchestrator/kubernetes/resources/coordination';
import { OrchestratorUnavailableError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster } from '../fakes/fake-cluster';
import { FakeKubeExecutor, type KubeStep, REST } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const redactor = new Redactor([]);
const STACK_NAME = 'shop-production';
const STACK_ID = 'dockflow-shop-production';
const LEASE_NAME = `lock-${STACK_ID}`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let harnesses: { kube: FakeKubeExecutor; cluster: FakeCluster | null }[] = [];
let warnings: string[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  warnings = [];
  spies = [
    spyOn(output, 'printWarning').mockImplementation((message: string) => {
      warnings.push(message);
    }),
    spyOn(output, 'printDebug').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  const current = harnesses;
  harnesses = [];
  for (const { kube, cluster } of current) {
    kube.assertDone();
    assertExecutorInvariants({ kube, redactor });
    cluster?.assertNoProblems();
  }
});

function harness(options: { systemNamespace?: boolean; clock?: FakeClock } = {}): { kube: FakeKubeExecutor; cluster: FakeCluster; clock: FakeClock } {
  const clock = options.clock ?? new FakeClock();
  const cluster = new FakeCluster({ systemNamespace: options.systemNamespace ?? true, clock });
  const kube = new FakeKubeExecutor({ redactor, cluster, clock });
  harnesses.push({ kube, cluster });
  return { kube, cluster, clock };
}

function scripted(script: KubeStep[], clock: FakeClock): FakeKubeExecutor {
  const kube = new FakeKubeExecutor({ redactor, script, clock });
  harnesses.push({ kube, cluster: null });
  return kube;
}

function storeOf(kube: FakeKubeExecutor, clock: FakeClock, options: { performer?: string; staleThresholdMinutes?: number } = {}): LeaseLockStore {
  return new LeaseLockStore(
    { kubectl: kube, distribution: kube.distribution, clock, performer: options.performer ?? 'alice', env: 'production' },
    STACK_NAME,
    STACK_ID,
    options.staleThresholdMinutes ?? LOCK_STALE_THRESHOLD_MINUTES,
  );
}

function leaseOf(cluster: FakeCluster): Lease | undefined {
  return cluster.get('Lease', LEASE_NAME, K8S_SYSTEM_NAMESPACE) as Lease | undefined;
}

/**
 * Seeds a Lease as if `performer` acquired it `agoMs` ago and its process is gone (no live store
 * renewing it). A live `store.acquire()` kept for the whole test would instead self-renew across a
 * long `clock.advance()`, which is the correct behaviour K73 exists for (L12) but the wrong shape
 * for a scenario that needs a genuinely stale lock.
 */
function seedLease(cluster: FakeCluster, clock: FakeClock, performer: string, agoMs: number): LockData {
  const startedAt = new Date(clock.now().getTime() - agoMs);
  const data: LockData = {
    performer,
    started_at: startedAt.toISOString(),
    timestamp: Math.floor(startedAt.getTime() / 1000),
    version: '1.0.0',
    stack: STACK_NAME,
    message: 'Deploy 1.0.0',
  };
  cluster.seed({
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      name: LEASE_NAME,
      namespace: K8S_SYSTEM_NAMESPACE,
      labels: { [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.part]: 'system', [LABELS.stack]: STACK_ID },
      annotations: { [ANNOTATIONS.lock]: JSON.stringify(data) },
    },
    spec: {
      holderIdentity: performer,
      leaseDurationSeconds: LOCK_STALE_THRESHOLD_MINUTES * 60,
      acquireTime: formatMicroTime(startedAt),
      renewTime: formatMicroTime(startedAt),
    },
  });
  return data;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure', () => {
  it('formatMicroTime: exactly six fractional digits', () => {
    expect(formatMicroTime(new Date('2026-09-17T10:00:00.123Z'))).toBe('2026-09-17T10:00:00.123000Z');
  });

  it('leaseYaml: a fresh create has no resourceVersion and no leaseTransitions', () => {
    const now = new Date('2026-09-17T10:00:00.000Z');
    const data: LockData = { performer: 'alice', started_at: now.toISOString(), timestamp: 0, version: '1.4.2', stack: STACK_NAME, message: 'Deploy 1.4.2' };
    const yaml = leaseYaml(STACK_ID, data, now, 30);
    expect(yaml).toContain(`name: ${LEASE_NAME}`);
    expect(yaml).toContain(`namespace: ${K8S_SYSTEM_NAMESPACE}`);
    expect(yaml).toContain('holderIdentity: alice');
    expect(yaml).toContain('leaseDurationSeconds: 1800');
    expect(yaml).toContain('acquireTime: "2026-09-17T10:00:00.000000Z"');
    expect(yaml).toContain('renewTime: "2026-09-17T10:00:00.000000Z"');
    expect(yaml).not.toContain('resourceVersion');
    expect(yaml).not.toContain('leaseTransitions');
    expect(parseLockData(parseYaml(yaml) as Lease)).toEqual(data);
  });

  it('leaseYaml: a takeover carries the resourceVersion and increments leaseTransitions', () => {
    const now = new Date('2026-09-17T10:45:00.000Z');
    const data: LockData = { performer: 'bob', started_at: now.toISOString(), timestamp: 0, version: '1.4.2', stack: STACK_NAME };
    const existing: Lease = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: LEASE_NAME, namespace: K8S_SYSTEM_NAMESPACE, resourceVersion: '20' },
      spec: { acquireTime: '2026-09-17T10:00:00.000000Z', leaseTransitions: 0 },
    };
    const yaml = leaseYaml(STACK_ID, data, now, 30, { existing });
    expect(yaml).toContain('resourceVersion: "20"');
    expect(yaml).toContain('leaseTransitions: 1');
    expect(yaml).toContain('acquireTime: "2026-09-17T10:45:00.000000Z"'); // moves on a takeover
  });

  it('leaseYaml: a renewal keeps acquireTime and leaseTransitions, moves only renewTime', () => {
    const now = new Date('2026-09-17T10:01:00.000Z');
    const data: LockData = { performer: 'alice', started_at: now.toISOString(), timestamp: 0, version: '1.4.2', stack: STACK_NAME };
    const held: Lease = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: LEASE_NAME, namespace: K8S_SYSTEM_NAMESPACE, resourceVersion: '10' },
      spec: { acquireTime: '2026-09-17T10:00:00.000000Z', renewTime: '2026-09-17T10:00:00.000000Z', leaseTransitions: 2 },
    };
    const yaml = leaseYaml(STACK_ID, data, now, 30, { existing: held, renew: true });
    expect(yaml).toContain('resourceVersion: "10"');
    expect(yaml).toContain('acquireTime: "2026-09-17T10:00:00.000000Z"'); // unchanged
    expect(yaml).toContain('leaseTransitions: 2'); // unchanged: a renewal is not a transition
    expect(yaml).toContain('renewTime: "2026-09-17T10:01:00.000000Z"'); // moved
  });

  it('parseLockData: invalid or missing annotation is null', () => {
    const base: Lease = { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: LEASE_NAME } };
    expect(parseLockData(base)).toBeNull();
    expect(parseLockData({ ...base, metadata: { ...base.metadata, annotations: { [ANNOTATIONS.lock]: 'not json' } } })).toBeNull();
    const good: LockData = { performer: 'alice', started_at: '2026-09-17T10:00:00.000Z', timestamp: 0, version: '1.4.2', stack: STACK_NAME };
    expect(parseLockData({ ...base, metadata: { ...base.metadata, annotations: { [ANNOTATIONS.lock]: JSON.stringify(good) } } })).toEqual(good);
  });
});

// ---------------------------------------------------------------------------
// Integration (cluster mode unless noted)
// ---------------------------------------------------------------------------

describe('acquire / status', () => {
  it('L1: acquire on a free lock creates the Lease with the expected shape', async () => {
    const { kube, cluster, clock } = harness();
    const store = storeOf(kube, clock);
    const result = await store.acquire({ message: 'Deploy 1.4.2', version: '1.4.2' });
    expect(result.success).toBe(true);
    const lease = leaseOf(cluster);
    expect(lease?.spec).toMatchObject({ holderIdentity: 'alice', leaseDurationSeconds: LOCK_STALE_THRESHOLD_MINUTES * 60 });
    expect(lease?.metadata.labels).toMatchObject({ [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.part]: 'system', [LABELS.stack]: STACK_ID });
    expect(lease?.metadata.annotations?.[ANNOTATIONS.lock]).toContain('"performer":"alice"');
  });

  it('L2: held and fresh refuses with the performer and age', async () => {
    const { kube, cluster, clock } = harness();
    seedLease(cluster, clock, 'bob', 5 * 60000);
    const result = await storeOf(kube, clock, { performer: 'alice' }).acquire({ message: 'Deploy', version: '1.0.1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('Already locked by bob (5 min ago)');
  });

  it('L3: a stale lock is taken over through replace, never delete-then-create', async () => {
    const { kube, cluster, clock } = harness();
    seedLease(cluster, clock, 'bob', (LOCK_STALE_THRESHOLD_MINUTES + 15) * 60000);
    const before = leaseOf(cluster);
    const result = await storeOf(kube, clock, { performer: 'alice' }).acquire({ version: '1.0.1' });
    expect(result.success).toBe(true);
    const after = leaseOf(cluster);
    expect(after?.spec?.leaseTransitions).toBe(1);
    expect(after?.metadata.uid).toBe(before?.metadata.uid); // replaced in place, never deleted
    expect(kube.calls.some((call) => call.method === 'delete')).toBe(false);
  });

  it('L4: two acquirers racing a stale lock -> exactly one wins (C-LOCK-07)', async () => {
    const { kube, cluster, clock } = harness();
    seedLease(cluster, clock, 'bob', (LOCK_STALE_THRESHOLD_MINUTES + 15) * 60000);
    const settled = await Promise.allSettled([
      storeOf(kube, clock, { performer: 'alice' }).acquire({ version: '1.0.1' }),
      storeOf(kube, clock, { performer: 'carol' }).acquire({ version: '1.0.2' }),
    ]);
    const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { success: false as const, error: s.reason as Error }));
    const winners = results.filter((r) => r.success);
    const losers = results.filter((r) => !r.success);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0].success) expect(losers[0].error.message).toBe('Lock was stale but another deploy acquired it first');
    expect(leaseOf(cluster)?.spec?.holderIdentity).not.toBe('bob');
  });

  it('L5: released between the create attempt and the read tries create once more', async () => {
    const clock = new FakeClock();
    const executor = scripted(
      [
        { id: 'K28', method: 'create', args: [REST], respond: { error: 'AlreadyExists' } },
        { id: 'K27', method: 'getJson', args: [REST], respond: { json: { apiVersion: 'v1', kind: 'List', items: [] } } },
        {
          id: 'K28b',
          method: 'create',
          args: [REST],
          respond: {
            json: { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: LEASE_NAME, namespace: K8S_SYSTEM_NAMESPACE, uid: 'u1', resourceVersion: '5' }, spec: {} },
          },
        },
      ],
      clock,
    );
    const store = storeOf(executor, clock);
    const result = await store.acquire({ version: '1.0.0' });
    expect(result.success).toBe(true);
  });

  it('L6: force replaces a live lock without a staleness check', async () => {
    const { kube, cluster, clock } = harness();
    await storeOf(kube, clock, { performer: 'bob' }).acquire({ version: '1.0.0' });
    const result = await storeOf(kube, clock, { performer: 'alice' }).acquire({ force: true, version: '1.0.1' });
    expect(result.success).toBe(true);
    expect(leaseOf(cluster)?.spec?.holderIdentity).toBe('alice');
  });

  it('L10: a missing dockflow-system namespace is reported clearly', async () => {
    const { kube, clock } = harness({ systemNamespace: false });
    const result = await storeOf(kube, clock).acquire({ version: '1.0.0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(OrchestratorUnavailableError);
      expect(result.error.message).toContain('dockflow-system is missing');
    }
  });

  it('L11: status of an unparsable Lease reports isStale without throwing', async () => {
    const { kube, cluster, clock } = harness();
    cluster.seed({
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: LEASE_NAME, namespace: K8S_SYSTEM_NAMESPACE },
      spec: { holderIdentity: 'bob', leaseDurationSeconds: 1800 },
    });
    const status = await storeOf(kube, clock).status();
    expect(status).toEqual({ success: true, data: { locked: true, isStale: true } });
  });

  it('C-LOCK-06: status reports durationMinutes, isStale and data.message', async () => {
    const { kube, cluster, clock } = harness();
    seedLease(cluster, clock, 'bob', 5 * 60000);
    const status = await storeOf(kube, clock).status();
    expect(status.success).toBe(true);
    if (status.success) {
      expect(status.data).toMatchObject({ locked: true, isStale: false, durationMinutes: 5 });
      expect(status.data.data?.message).toBe('Deploy 1.0.0');
    }
  });
});

describe('release', () => {
  it('L7: conditional release carries the held uid and resourceVersion, and no -n', async () => {
    const { kube, clock } = harness();
    const store = storeOf(kube, clock);
    await store.acquire({ version: '1.0.0' });
    const result = await store.release();
    expect(result.success).toBe(true);
    const call = kube.calls.find((c) => c.call.args.some((arg) => arg.startsWith('--raw=')));
    expect(call).toBeDefined();
    expect(call?.call.namespace).toBeUndefined();
    expect(call?.call.args.some((arg) => arg === `--raw=/apis/coordination.k8s.io/v1/namespaces/${K8S_SYSTEM_NAMESPACE}/leases/${LEASE_NAME}`)).toBe(true);
    const body = JSON.parse(call?.stdinText ?? '{}') as { apiVersion: string; kind: string; preconditions: { uid: string; resourceVersion: string } };
    expect(body.apiVersion).toBe('v1');
    expect(body.kind).toBe('DeleteOptions');
    expect(body.preconditions.uid).toBeTruthy();
    expect(body.preconditions.resourceVersion).toBeTruthy();
  });

  it('L7b: release ends the wait between renewals, so no timer keeps the process alive after the command', async () => {
    const { kube, clock } = harness();
    const store = storeOf(kube, clock);
    await store.acquire({ version: '1.0.0' });
    await clock.advance(0);
    expect(clock.pending).toBe(1);
    await store.release();
    await clock.advance(0);
    expect(clock.pending).toBe(0);
  });

  it('L8: release after a forced takeover reports the new holder and deletes nothing', async () => {
    const { kube, cluster, clock } = harness();
    const first = storeOf(kube, clock, { performer: 'alice' });
    await first.acquire({ version: '1.0.0' });
    await storeOf(kube, clock, { performer: 'carol' }).acquire({ force: true, version: '1.0.1' });
    const result = await first.release();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe(`Lock for ${STACK_NAME} is now held by carol; it was not released`);
    expect(leaseOf(cluster)?.spec?.holderIdentity).toBe('carol');
  });

  it('L9: a fresh instance releases unconditionally', async () => {
    const { kube, clock } = harness();
    await storeOf(kube, clock, { performer: 'bob' }).acquire({ version: '1.0.0' });
    const result = await storeOf(kube, clock).release(); // no held identity
    expect(result.success).toBe(true);
    const status = await storeOf(kube, clock).status();
    expect(status).toEqual({ success: true, data: { locked: false } });
  });
});

describe('renewal (K73)', () => {
  it('L12: a long deploy is never reported stale by another instance', async () => {
    const { kube, cluster, clock } = harness();
    const store = storeOf(kube, clock, { performer: 'alice' });
    await store.acquire({ version: '1.0.0' });
    const before = leaseOf(cluster);

    await clock.advance(K8S_LEASE_RENEW_INTERVAL_S * 1000);
    const afterOneTick = leaseOf(cluster);
    expect(afterOneTick?.spec?.acquireTime).toBe(before?.spec?.acquireTime);
    expect(afterOneTick?.spec?.leaseTransitions ?? 0).toBe(before?.spec?.leaseTransitions ?? 0);
    expect(afterOneTick?.spec?.renewTime).not.toBe(before?.spec?.renewTime);

    // real elapsed time is now well past the stale threshold; renewal keeps moving started_at
    await clock.advance(LOCK_STALE_THRESHOLD_MINUTES * 60000 + 5 * 60000);
    const status = await storeOf(kube, clock).status();
    expect(status.success).toBe(true);
    if (status.success) expect(status.data.isStale).toBe(false);

    const released = await store.release();
    expect(released.success).toBe(true);
  });

  it('L13: a renewal that loses the object warns and leaves release a no-op', async () => {
    const { kube, cluster, clock } = harness();
    const store = storeOf(kube, clock, { performer: 'alice' });
    await store.acquire({ version: '1.0.0' });
    await storeOf(kube, clock, { performer: 'carol' }).acquire({ force: true, version: '1.0.1' });

    await clock.advance(K8S_LEASE_RENEW_INTERVAL_S * 1000);
    expect(warnings.some((message) => message.includes('was taken over by another deploy'))).toBe(true);

    const deletesBefore = kube.calls.filter((c) => c.method === 'delete').length;
    const result = await store.release();
    expect(result.success).toBe(true);
    const deletesAfter = kube.calls.filter((c) => c.method === 'delete').length;
    expect(deletesAfter).toBe(deletesBefore); // no K30, no K31
    expect(leaseOf(cluster)?.spec?.holderIdentity).toBe('carol');
  });

  it('L14: a transient renewal failure is only a debug line; the lock stays held and recovers', async () => {
    const { kube, cluster, clock } = harness();
    const store = storeOf(kube, clock, { performer: 'alice' });
    await store.acquire({ version: '1.0.0' });
    const before = leaseOf(cluster);
    cluster.rejectOn({ verb: 'replace' }, 'Unauthorized', undefined, { times: 1 });

    await clock.advance(K8S_LEASE_RENEW_INTERVAL_S * 1000);
    expect(warnings.some((message) => message.includes('taken over'))).toBe(false);
    expect(leaseOf(cluster)?.metadata.resourceVersion).toBe(before?.metadata.resourceVersion); // the rejected attempt changed nothing

    await clock.advance(K8S_LEASE_RENEW_INTERVAL_S * 1000); // recovers on the next tick
    expect(leaseOf(cluster)?.spec?.renewTime).not.toBe(before?.spec?.renewTime);

    const status = await storeOf(kube, clock).status();
    expect(status.success && status.data.locked).toBe(true);
    const released = await store.release();
    expect(released.success).toBe(true);
  });

  it('L15: a release while a renewal is on the wire waits for it and deletes the renewed Lease', async () => {
    const { kube, cluster, clock } = harness();
    const store = storeOf(kube, clock, { performer: 'alice' });
    await store.acquire({ version: '1.0.0' });

    // the renewal reaches the API server before the delete does
    const gate = (): { wait: Promise<void>; open: () => void } => {
      let open: () => void = () => {};
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    };
    const renewalGate = gate();
    const deleteGate = gate();
    const replace = kube.replace.bind(kube);
    const run = kube.run.bind(kube);
    const spies = [
      spyOn(kube, 'replace').mockImplementation(async (manifest, options) => {
        await renewalGate.wait;
        return replace(manifest, options);
      }),
      spyOn(kube, 'run').mockImplementation(async (call) => {
        if (call.args[0] === 'delete') await deleteGate.wait;
        return run(call);
      }),
    ];
    try {
      await clock.advance(K8S_LEASE_RENEW_INTERVAL_S * 1000); // the renewal is sent and held at its gate
      const releasing = store.release();
      renewalGate.open();
      await clock.advance(0); // the renewal lands: the Lease has a new resourceVersion
      deleteGate.open();
      const result = await releasing;

      expect(result.success).toBe(true);
      expect(leaseOf(cluster)).toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
