// Shared store contract (design-07 11.1): one suite of assertions run against both
// ClusterReleaseStore/LeaseLockStore (FakeCluster) and FileReleaseStore/FileLockStore
// (fakes/local-shell.ts, POSIX only). Deep, backend-specific behaviour lives in
// stores/release-store.test.ts, stores/lock-store.test.ts and stores/file-stores.test.ts; this file
// only asserts what both implementations must agree on through the `ReleaseStore`/`LockStore`
// interfaces themselves.

import { describe, expect, it } from 'bun:test';
import type { HelmReleaseRecord, LockStore, ReleaseInput, ReleaseMetadata, ReleaseStore, StackArtifact } from '../../../services/orchestrator/interfaces';
import { ApplyEngine } from '../../../services/orchestrator/kubernetes/apply/engine';
import { ClusterReleaseStore } from '../../../services/orchestrator/kubernetes/backends/release-store';
import { LeaseLockStore } from '../../../services/orchestrator/kubernetes/backends/lock-store';
import { ANNOTATIONS, K8S_SYSTEM_NAMESPACE } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo, systemClock } from '../../../services/orchestrator/kubernetes/deps';
import { leaseNameFor } from '../../../services/orchestrator/kubernetes/naming';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster } from '../fakes/fake-cluster';
import { FakeKubeExecutor } from '../fakes/fake-kube-executor';
import { hasPosixShell, LocalShell } from '../fakes/local-shell';
import { FileLockStore } from '../../../services/orchestrator/stores/file-lock-store';
import { FileReleaseStore } from '../../../services/orchestrator/stores/file-release-store';
import { assertExecutorInvariants } from '../support/invariants';

const redactor = new Redactor([]);
const STACK_NAME = 'shop-production';

// ---------------------------------------------------------------------------
// Fixtures (orchestrator-neutral: format follows the backend under test)
// ---------------------------------------------------------------------------

function metadata(version: string, epoch: number, format: 'k8s-manifests/1' | 'swarm-compose/1'): ReleaseMetadata {
  return {
    project_name: 'shop',
    version,
    env: 'production',
    timestamp: new Date(epoch * 1000).toISOString(),
    epoch,
    performer: 'ci@runner',
    branch: 'main',
    orchestrator: format === 'k8s-manifests/1' ? 'k3s' : 'swarm',
    artifact_format: format,
  };
}

function artifactOf(content: string, format: 'k8s-manifests/1' | 'swarm-compose/1', helm: HelmReleaseRecord[] = []): StackArtifact {
  return { format, role: 'app', content, helm, diagnostics: [], digest: sha256Hex(`${content}\n${canonicalJson(helm)}`) };
}

function releaseOf(version: string, epoch: number, format: 'k8s-manifests/1' | 'swarm-compose/1'): ReleaseInput {
  const header = format === 'k8s-manifests/1' ? '# dockflow-artifact: k8s-manifests/1\n' : '# dockflow-artifact: swarm-compose/1\n';
  const compose = `services:\n  web:\n    image: web:${version}\n`;
  return { version, compose, artifact: artifactOf(`${header}${compose}`, format), metadata: metadata(version, epoch, format) };
}

// ---------------------------------------------------------------------------
// Backend adapters
// ---------------------------------------------------------------------------

interface ReleaseHarness {
  store: ReleaseStore;
  format: 'k8s-manifests/1' | 'swarm-compose/1';
  cleanup(): void;
}

interface ReleaseBackend {
  name: string;
  posixOnly: boolean;
  open(): ReleaseHarness;
}

const clusterReleaseBackend: ReleaseBackend = {
  name: 'ClusterReleaseStore',
  posixOnly: false,
  open() {
    const cluster = new FakeCluster();
    const kube = new FakeKubeExecutor({ redactor, cluster });
    const engine = new ApplyEngine({ kubectl: kube, clock: systemClock, distribution: kube.distribution, memo: createSharedMemo() });
    const store = new ClusterReleaseStore({ kubectl: kube, distribution: kube.distribution, engine }, { project: 'shop', env: 'production' });
    return {
      store,
      format: 'k8s-manifests/1',
      cleanup: () => {
        kube.assertDone();
        assertExecutorInvariants({ kube, redactor });
        cluster.assertNoProblems();
      },
    };
  },
};

const fileReleaseBackend: ReleaseBackend = {
  name: 'FileReleaseStore',
  posixOnly: true,
  open() {
    const shell = new LocalShell();
    const store = new FileReleaseStore(shell, { root: shell.root });
    return { store, format: 'swarm-compose/1', cleanup: () => shell.cleanup() };
  },
};

interface LockHarness {
  open(performer: string): LockStore;
  advance(ms: number): Promise<void>;
  /**
   * As if `performer` acquired the lock `agoMs` ago and its process is gone. A plain
   * `open(performer).acquire()` kept alive across a long `advance()` would instead self-renew on the
   * Lease backend (K73), which is correct production behaviour but the wrong shape for a scenario
   * that needs a genuinely stale lock; this seeds the stored state directly instead.
   */
  holdStale(performer: string, message: string, agoMs: number): Promise<void>;
  cleanup(): void;
}

interface LockBackend {
  name: string;
  posixOnly: boolean;
  open(): LockHarness;
}

const clusterLockBackend: LockBackend = {
  name: 'LeaseLockStore',
  posixOnly: false,
  open() {
    const clock = new FakeClock();
    const cluster = new FakeCluster({ clock });
    const kube = new FakeKubeExecutor({ redactor, cluster, clock });
    const stackId = 'dockflow-shop-production';
    return {
      open: (performer) => new LeaseLockStore({ kubectl: kube, distribution: kube.distribution, clock, performer, env: 'production' }, STACK_NAME, stackId),
      advance: (ms) => clock.advance(ms),
      holdStale: (performer, message, agoMs) => {
        const startedAt = new Date(clock.now().getTime() - agoMs);
        const data = {
          performer,
          started_at: startedAt.toISOString(),
          timestamp: Math.floor(startedAt.getTime() / 1000),
          version: '1.0.0',
          stack: STACK_NAME,
          message,
        };
        cluster.seed({
          apiVersion: 'coordination.k8s.io/v1',
          kind: 'Lease',
          metadata: { name: leaseNameFor(stackId), namespace: K8S_SYSTEM_NAMESPACE, annotations: { [ANNOTATIONS.lock]: JSON.stringify(data) } },
          spec: { holderIdentity: performer, leaseDurationSeconds: 1800, acquireTime: startedAt.toISOString(), renewTime: startedAt.toISOString() },
        });
        return Promise.resolve();
      },
      cleanup: () => {
        kube.assertDone();
        assertExecutorInvariants({ kube, redactor });
        cluster.assertNoProblems();
      },
    };
  },
};

const fileLockBackend: LockBackend = {
  name: 'FileLockStore',
  posixOnly: true,
  open() {
    const shell = new LocalShell();
    const box = { ms: 0 };
    const store = (performer: string): FileLockStore => new FileLockStore(shell, STACK_NAME, { root: shell.root, performer, now: () => box.ms });
    return {
      open: store,
      advance: (ms) => {
        box.ms += ms;
        return Promise.resolve();
      },
      holdStale: async (performer, message, agoMs) => {
        await store(performer).acquire({ message, version: '1.0.0' }); // no renewal on this backend: advancing afterward is enough
        box.ms += agoMs;
      },
      cleanup: () => shell.cleanup(),
    };
  },
};

// ---------------------------------------------------------------------------
// ReleaseStore contract
// ---------------------------------------------------------------------------

for (const backend of [clusterReleaseBackend, fileReleaseBackend]) {
  describe(`ReleaseStore contract: ${backend.name}`, () => {
    const t = backend.posixOnly ? it.if(hasPosixShell) : it;

    t('C-REL-01: first create returns previous null, second returns the first version', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        expect(await store.create(STACK_NAME, releaseOf('1.0.0', 100, format))).toEqual({ previous: null });
        expect(await store.create(STACK_NAME, releaseOf('1.1.0', 200, format))).toEqual({ previous: '1.0.0' });
      } finally {
        cleanup();
      }
    });

    t('C-REL-02: current returns the metadata of the last created release', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        expect(await store.current(STACK_NAME)).toBeNull();
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        await store.create(STACK_NAME, releaseOf('1.1.0', 200, format));
        expect(await store.current(STACK_NAME)).toEqual(metadata('1.1.0', 200, format));
      } finally {
        cleanup();
      }
    });

    t('C-REL-03: list is newest first by epoch; latestVersion agrees', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        await store.create(STACK_NAME, releaseOf('1.2.0', 300, format));
        await store.create(STACK_NAME, releaseOf('1.1.0', 200, format));
        expect((await store.list(STACK_NAME)).map((r) => r.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
        expect(await store.latestVersion(STACK_NAME)).toBe('1.2.0');
      } finally {
        cleanup();
      }
    });

    t('C-REL-04: readArtifact round-trips content, format and helm; diagnostics is []', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        const helm: HelmReleaseRecord[] = [
          {
            name: 'cache',
            role: 'accessory',
            namespace: 'dockflow-shop-production',
            chart: { kind: 'repo', repo: 'https://charts.example.com', chart: 'cache' },
            version: '1.2.3',
            values: { replicas: 2 },
            valuesSha256: 'b'.repeat(64),
            timeoutS: 300,
            chartSha256: null,
          },
        ];
        const header = format === 'k8s-manifests/1' ? '# dockflow-artifact: k8s-manifests/1\n' : '# dockflow-artifact: swarm-compose/1\n';
        const content = `${header}services:\n  web:\n    image: web:1.0.0\n`;
        const input = { ...releaseOf('1.0.0', 100, format), artifact: artifactOf(content, format, helm) };
        await store.create(STACK_NAME, input);
        expect(await store.readArtifact(STACK_NAME, '1.0.0')).toEqual(input.artifact);
      } finally {
        cleanup();
      }
    });

    t('C-REL-05: readCompose round-trips the tagged compose', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        const input = releaseOf('1.0.0', 100, format);
        await store.create(STACK_NAME, input);
        expect(await store.readCompose(STACK_NAME, '1.0.0')).toBe(input.compose);
        expect(await store.readCompose(STACK_NAME, '9.9.9')).toBeNull();
      } finally {
        cleanup();
      }
    });

    t('C-REL-06: setCurrent(null) clears current', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        await store.setCurrent(STACK_NAME, null);
        expect(await store.currentVersion(STACK_NAME)).toBeNull();
        expect(await store.current(STACK_NAME)).toBeNull();
      } finally {
        cleanup();
      }
    });

    t('C-REL-07: remove of a non-current release keeps current', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        await store.create(STACK_NAME, releaseOf('1.1.0', 200, format));
        await store.remove(STACK_NAME, '1.0.0');
        expect(await store.currentVersion(STACK_NAME)).toBe('1.1.0');
      } finally {
        cleanup();
      }
    });

    t('C-REL-08: remove(current, {restoreCurrentTo}) sets current to that version', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        await store.create(STACK_NAME, releaseOf('1.1.0', 200, format));
        await store.remove(STACK_NAME, '1.1.0', { restoreCurrentTo: '1.0.0' });
        expect(await store.currentVersion(STACK_NAME)).toBe('1.0.0');
      } finally {
        cleanup();
      }
    });

    t('C-REL-09: prune(2) with 4 releases, current the oldest: keeps current, returns removed metadata', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        for (const [version, epoch] of [
          ['1.0.0', 100],
          ['1.1.0', 200],
          ['1.2.0', 300],
          ['1.3.0', 400],
        ] as const) {
          await store.create(STACK_NAME, releaseOf(version, epoch, format));
        }
        await store.setCurrent(STACK_NAME, '1.0.0');
        const removed = await store.prune(STACK_NAME, 2);
        expect(removed.length).toBeGreaterThan(0);
        expect(removed.every((r) => r.version !== '1.0.0')).toBe(true); // current is never removed
        expect((await store.list(STACK_NAME)).some((r) => r.version === '1.0.0')).toBe(true);
      } finally {
        cleanup();
      }
    });

    t('C-REL-10: readArtifact of a missing release is DeployError ROLLBACK_FAILED', async () => {
      const { store, cleanup } = backend.open();
      try {
        let error: unknown;
        try {
          await store.readArtifact(STACK_NAME, '9.9.9');
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(DeployError);
        expect((error as DeployError).code).toBe(ErrorCode.ROLLBACK_FAILED);
      } finally {
        cleanup();
      }
    });

    t('C-REL-11: create twice for the same version replaces it, and it stays readable throughout', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        const second = releaseOf('1.0.0', 200, format);
        second.compose = 'services:\n  web:\n    image: web:1.0.0-rebuilt\n';
        expect(await store.create(STACK_NAME, second)).toEqual({ previous: '1.0.0' });
        expect(await store.readArtifact(STACK_NAME, '1.0.0')).toEqual(second.artifact);
        expect(await store.readCompose(STACK_NAME, '1.0.0')).toBe(second.compose);
        expect(await store.list(STACK_NAME)).toEqual([second.metadata]);
      } finally {
        cleanup();
      }
    });

    t('C-REL-12: readState/writeAccessoriesDigest round trip; a digest written by one instance is read by another', async () => {
      const { store, format, cleanup } = backend.open();
      try {
        await store.writeAccessoriesDigest(STACK_NAME, 'a'.repeat(64));
        expect(await store.readState(STACK_NAME)).toEqual({ current: null, accessoriesDigest: 'a'.repeat(64) });
        await store.create(STACK_NAME, releaseOf('1.0.0', 100, format));
        expect(await store.readState(STACK_NAME)).toEqual({ current: '1.0.0', accessoriesDigest: 'a'.repeat(64) });
        await store.writeAccessoriesDigest(STACK_NAME, null);
        expect(await store.readState(STACK_NAME)).toEqual({ current: '1.0.0', accessoriesDigest: null });
      } finally {
        cleanup();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// LockStore contract
// ---------------------------------------------------------------------------

for (const backend of [clusterLockBackend, fileLockBackend]) {
  describe(`LockStore contract: ${backend.name}`, () => {
    const t = backend.posixOnly ? it.if(hasPosixShell) : it;

    t('C-LOCK-01: acquire on a free lock returns LockData', async () => {
      const harness = backend.open();
      try {
        const result = await harness.open('alice').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toMatchObject({ performer: 'alice', version: '1.0.0', stack: STACK_NAME, message: 'Deploy 1.0.0' });
        }
      } finally {
        harness.cleanup();
      }
    });

    t('C-LOCK-02: acquire when held fails naming the performer and age', async () => {
      const harness = backend.open();
      try {
        await harness.holdStale('alice', 'Deploy', 5 * 60000);
        const result = await harness.open('bob').acquire();
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.message).toBe('Already locked by alice (5 min ago)');
      } finally {
        harness.cleanup();
      }
    });

    t('C-LOCK-03: a stale lock (clock advanced past the threshold) is acquired', async () => {
      const harness = backend.open();
      try {
        await harness.holdStale('alice', 'Deploy', 31 * 60000);
        const result = await harness.open('bob').acquire();
        expect(result.success).toBe(true);
      } finally {
        harness.cleanup();
      }
    });

    t('C-LOCK-04: force replaces a live lock', async () => {
      const harness = backend.open();
      try {
        await harness.open('alice').acquire();
        const result = await harness.open('bob').acquire({ force: true });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.performer).toBe('bob');
      } finally {
        harness.cleanup();
      }
    });

    t('C-LOCK-05: release twice is ok', async () => {
      const harness = backend.open();
      try {
        const lock = harness.open('alice');
        await lock.acquire();
        expect((await lock.release()).success).toBe(true);
        expect((await lock.release()).success).toBe(true);
      } finally {
        harness.cleanup();
      }
    });

    t('C-LOCK-06: status reports durationMinutes, isStale and data.message', async () => {
      const harness = backend.open();
      try {
        await harness.holdStale('alice', 'Deploy 1.0.0', 5 * 60000);
        const status = await harness.open('bob').status();
        expect(status.success).toBe(true);
        if (status.success) {
          expect(status.data).toMatchObject({ locked: true, isStale: false, durationMinutes: 5 });
          expect(status.data.data?.message).toBe('Deploy 1.0.0');
        }
      } finally {
        harness.cleanup();
      }
    });

    for (const order of ['bob-first', 'carol-first'] as const) {
      t(`C-LOCK-07: two acquirers racing a stale lock (${order}) -> exactly one wins`, async () => {
        const harness = backend.open();
        try {
          await harness.holdStale('alice', 'Deploy', 45 * 60000);
          const [firstName, secondName] = order === 'bob-first' ? ['bob', 'carol'] : ['carol', 'bob'];
          const settled = await Promise.allSettled([harness.open(firstName).acquire(), harness.open(secondName).acquire()]);
          const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { success: false as const, error: s.reason as Error }));
          const winners = results.filter((r) => r.success);
          expect(winners).toHaveLength(1);
          expect(results.filter((r) => !r.success)).toHaveLength(1);
        } finally {
          harness.cleanup();
        }
      });
    }
  });
}

// C-LOCK-08 (the Lease store's conditional release after a forced takeover) has no file-store
// equivalent to share a body with (DESIGN-CORE 6.7 lists it as Lease-only); it is asserted directly
// in stores/lock-store.test.ts (L8, L13).
