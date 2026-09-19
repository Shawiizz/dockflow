// ClusterReleaseStore (DESIGN-CORE 6.7, design-03 13, 22.6 RS*). Cluster mode over FakeCluster.

import { gunzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import type { HelmReleaseRecord, ReleaseInput, ReleaseMetadata, StackArtifact } from '../../../services/orchestrator/interfaces';
import { ApplyEngine } from '../../../services/orchestrator/kubernetes/apply/engine';
import {
  asBackup,
  asRelease,
  buildReleaseSecret,
  buildStateConfigMap,
  cleanForRecreate,
  ClusterReleaseStore,
  decodeReleaseArtifact,
  decodeReleaseMetadata,
  parseReleaseRows,
  readState,
  RELEASE_KEYS,
} from '../../../services/orchestrator/kubernetes/backends/release-store';
import { ANNOTATIONS, K8S_RELEASE_BACKUP_SUFFIX, LABELS, PARTS } from '../../../services/orchestrator/kubernetes/constants';
import { createSharedMemo, systemClock } from '../../../services/orchestrator/kubernetes/deps';
import { releaseSecretName } from '../../../services/orchestrator/kubernetes/naming';
import type { ConfigMap, Secret } from '../../../services/orchestrator/kubernetes/resources/core';
import { emitObject } from '../../../services/orchestrator/kubernetes/yaml';
import { DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { FakeCluster, type KubeObject } from '../fakes/fake-cluster';
import { FakeKubeExecutor } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const redactor = new Redactor([]);
const REF = { project: 'shop', env: 'production' };
const NS = 'dockflow-shop-production';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let harnesses: { kube: FakeKubeExecutor; cluster: FakeCluster }[] = [];
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
    cluster.assertNoProblems();
  }
});

function harness(): { kube: FakeKubeExecutor; cluster: FakeCluster } {
  const cluster = new FakeCluster();
  const kube = new FakeKubeExecutor({ redactor, cluster });
  harnesses.push({ kube, cluster });
  return { kube, cluster };
}

function storeOf(kube: FakeKubeExecutor): ClusterReleaseStore {
  const engine = new ApplyEngine({ kubectl: kube, clock: systemClock, distribution: kube.distribution, memo: createSharedMemo() });
  return new ClusterReleaseStore({ kubectl: kube, distribution: kube.distribution, engine }, REF);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function metadata(overrides: Partial<ReleaseMetadata> = {}): ReleaseMetadata {
  return {
    project_name: 'shop',
    version: '1.4.2',
    env: 'production',
    timestamp: '2026-09-17T10:00:00.000Z',
    epoch: 1789639200,
    performer: 'alice',
    branch: 'main',
    orchestrator: 'k3s',
    artifact_format: 'k8s-manifests/1',
    ...overrides,
  };
}

function artifact(overrides: Partial<StackArtifact> = {}): StackArtifact {
  return {
    format: 'k8s-manifests/1',
    role: 'app',
    content: '# dockflow-artifact: k8s-manifests/1\n# stack: dockflow-shop-production\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: dockflow-shop-production\n',
    helm: [],
    diagnostics: [],
    digest: 'deadbeef',
    ...overrides,
  };
}

function helmRecord(overrides: Partial<HelmReleaseRecord> = {}): HelmReleaseRecord {
  return {
    name: 'search',
    role: 'accessory',
    namespace: NS,
    chart: { kind: 'repo', repo: 'https://charts.example.com', chart: 'search' },
    version: '2.4.1',
    values: { replicaCount: 1 },
    valuesSha256: 'a'.repeat(64),
    timeoutS: 300,
    chartSha256: 'b'.repeat(64),
    ...overrides,
  };
}

function releaseOf(version: string, overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    version,
    compose: `services:\n  web:\n    image: web:${version}\n`,
    artifact: artifact(),
    metadata: metadata({ version }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure', () => {
  it('buildReleaseSecret: golden shape, labels, annotations, type, immutable, gzip round-trip', () => {
    const release = releaseOf('1.4.2');
    const { yaml, decodedBytes } = buildReleaseSecret(REF, release);
    expect(decodedBytes).toBeGreaterThan(0);
    expect(yaml).toContain('kind: Secret');
    expect(yaml).toContain(`name: ${releaseSecretName('1.4.2')}`);
    expect(yaml).toContain(`namespace: ${NS}`);
    expect(yaml).toContain('type: dockflow.shawiizz.dev/release.v1');
    expect(yaml).toContain('immutable: true');
    expect(yaml).toContain(`${LABELS.stack}: ${NS}`);
    expect(yaml).toContain(`${LABELS.part}: release`);
    expect(yaml).toContain(`${LABELS.releaseVersion}: 1.4.2`);
    expect(yaml).toContain(`${ANNOTATIONS.release}: 1.4.2`);
    expect(yaml).toContain(`${ANNOTATIONS.epoch}:`);
    for (const key of Object.values(RELEASE_KEYS)) expect(yaml).toContain(`${key}:`);

    // gzip round trip: decode the compose payload back to the original text
    const match = new RegExp(`${RELEASE_KEYS.compose}: (\\S+)`).exec(yaml);
    expect(match).not.toBeNull();
    const decoded = gunzipSync(Buffer.from(match![1], 'base64')).toString('utf8');
    expect(decoded).toBe(release.compose);
  });

  it('buildReleaseSecret: over the size limit throws before any mutation', () => {
    const huge = releaseOf('1.4.2', { compose: randomText(1024 * 1024) });
    let error: unknown;
    try {
      buildReleaseSecret(REF, huge);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeployError);
    expect((error as DeployError).message).toContain('after compression');
    expect((error as DeployError).message).toContain('1 MiB');
  });

  it('decodeReleaseMetadata: version/annotation mismatch and corrupted JSON both give null', () => {
    const { yaml } = buildReleaseSecret(REF, releaseOf('1.4.2'));
    const secret = parseYaml(yaml) as Secret;
    expect(decodeReleaseMetadata(secret)?.version).toBe('1.4.2');

    const mismatched: Secret = { ...secret, metadata: { ...secret.metadata, annotations: { ...secret.metadata.annotations, [ANNOTATIONS.release]: '9.9.9' } } };
    expect(decodeReleaseMetadata(mismatched)).toBeNull();

    const corrupted: Secret = { ...secret, data: { ...secret.data, [RELEASE_KEYS.metadata]: Buffer.from('not json').toString('base64') } };
    expect(decodeReleaseMetadata(corrupted)).toBeNull();
  });

  it('decodeReleaseArtifact: digest recomputed, format detected, helm preserved', () => {
    const helm = [helmRecord()];
    const release = releaseOf('1.4.2', { artifact: artifact({ helm }) });
    const { yaml } = buildReleaseSecret(REF, release);
    const secret = parseYaml(yaml) as Secret;
    const decoded = decodeReleaseArtifact(secret);
    expect(decoded.content).toBe(release.artifact.content);
    expect(decoded.format).toBe('k8s-manifests/1');
    expect(decoded.helm).toEqual(helm);
    expect(decoded.diagnostics).toEqual([]);
    expect(decoded.digest).not.toBe(release.artifact.digest); // recomputed, never trusted from storage
  });

  it('decodeReleaseArtifact: corrupted payload raises a ROLLBACK_FAILED DeployError', () => {
    const secret: Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'dockflow-release-1.4.2', annotations: { [ANNOTATIONS.release]: '1.4.2' } },
      data: { [RELEASE_KEYS.stack]: Buffer.from('not gzip').toString('base64') },
    };
    expect(() => decodeReleaseArtifact(secret)).toThrow(DeployError);
  });

  it('buildStateConfigMap / readState round trip, with and without keys', () => {
    const withCurrent = buildStateConfigMap(REF, { current: '1.4.2' });
    expect(withCurrent).toContain('current: 1.4.2');
    expect(withCurrent).toContain('schema:');

    const cm = parseYaml(buildStateConfigMap(REF, { current: '1.4.2', accessoriesDigest: 'abc123' })) as ConfigMap;
    expect(readState(cm)).toEqual({ current: '1.4.2', accessoriesDigest: 'abc123' });

    const empty = parseYaml(buildStateConfigMap(REF, {})) as ConfigMap;
    expect(readState(empty)).toEqual({ current: null, accessoriesDigest: null });
    expect(readState(undefined)).toEqual({ current: null, accessoriesDigest: null });
  });

  it('cleanForRecreate drops server-owned metadata only', () => {
    const secret: Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'dockflow-release-1.4.2',
        namespace: NS,
        uid: 'u1',
        resourceVersion: '10',
        creationTimestamp: '2026-01-01T00:00:00Z',
        generation: 1,
        labels: { a: 'b' },
      },
      data: { x: 'eQ==' },
    };
    const cleaned = cleanForRecreate(secret);
    expect(cleaned.metadata.uid).toBeUndefined();
    expect(cleaned.metadata.resourceVersion).toBeUndefined();
    expect(cleaned.metadata.creationTimestamp).toBeUndefined();
    expect(cleaned.metadata.generation).toBeUndefined();
    expect(cleaned.metadata.name).toBe('dockflow-release-1.4.2');
    expect(cleaned.metadata.labels).toEqual({ a: 'b' });
    expect(cleaned.data).toEqual({ x: 'eQ==' });
  });

  it('asBackup / asRelease change only the name suffix and P/part', () => {
    const secret: Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'dockflow-release-1.4.2', labels: { [LABELS.part]: PARTS.release, [LABELS.stack]: NS } },
    };
    const backup = asBackup(secret);
    expect(backup.metadata.name).toBe(`dockflow-release-1.4.2${K8S_RELEASE_BACKUP_SUFFIX}`);
    expect(backup.metadata.labels?.[LABELS.part]).toBe(PARTS.releaseBackup);
    expect(backup.metadata.labels?.[LABELS.stack]).toBe(NS);

    const restored = asRelease(backup);
    expect(restored.metadata.name).toBe('dockflow-release-1.4.2');
    expect(restored.metadata.labels?.[LABELS.part]).toBe(PARTS.release);
  });

  it('parseReleaseRows: one row per K48 line, reused by decodeReleaseMetadata', () => {
    const { yaml } = buildReleaseSecret(REF, releaseOf('1.4.2'));
    const secret = parseYaml(yaml) as Secret;
    const line = `${secret.metadata.name} 1.4.2 ${secret.data?.[RELEASE_KEYS.metadata]}`;
    const [row] = parseReleaseRows(`\n${line}\n\n`);
    expect(row.metadata.name).toBe(secret.metadata.name);
    expect(decodeReleaseMetadata(row)?.version).toBe('1.4.2');
  });
});

// ---------------------------------------------------------------------------
// Integration (cluster mode)
// ---------------------------------------------------------------------------

describe('create', () => {
  it('RS1: first create returns previous: null and sets current', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    const result = await store.create('shop-production', releaseOf('1.4.2'));
    expect(result).toEqual({ previous: null });
    expect(await store.currentVersion('shop-production')).toBe('1.4.2');
    const secret = await getSecret(kube, releaseSecretName('1.4.2'));
    expect(secret?.type).toBe('dockflow.shawiizz.dev/release.v1');
    expect(secret?.immutable).toBe(true);
  });

  it('RS2: create with an existing current returns it as previous', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.1'));
    const result = await store.create('shop-production', releaseOf('1.4.2'));
    expect(result).toEqual({ previous: '1.4.1' });
    expect(await store.currentVersion('shop-production')).toBe('1.4.2');
  });

  it('RS4: too large refuses before any create call', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    const huge = releaseOf('1.4.2', { compose: randomText(1024 * 1024) });
    await expect(store.create('shop-production', huge)).rejects.toBeInstanceOf(DeployError);
    expect(kube.calls).toHaveLength(0);
  });

  it('RS5: a failure writing the state rolls the new Secret back', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    cluster.rejectOn({ verb: 'apply', kind: 'ConfigMap', name: 'dockflow-state' }, 'Forbidden', undefined, { times: 1, dryRun: false });
    await expect(store.create('shop-production', releaseOf('1.4.2'))).rejects.toThrow();
    expect(await getSecret(kube, releaseSecretName('1.4.2'))).toBeUndefined();
  });

  it('RS13: the first-deploy state race retries once on AlreadyExists', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    cluster.rejectOn(
      { verb: 'apply', kind: 'ConfigMap', name: 'dockflow-state' },
      'Conflict',
      'Error from server (AlreadyExists): configmaps "dockflow-state" already exists',
      { times: 1, dryRun: false },
    );
    const result = await store.create('shop-production', releaseOf('1.4.2'));
    expect(result).toEqual({ previous: null });
    expect(await store.currentVersion('shop-production')).toBe('1.4.2');
  });

  it('a second AlreadyExists on the state write is thrown', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    cluster.rejectOn(
      { verb: 'apply', kind: 'ConfigMap', name: 'dockflow-state' },
      'Conflict',
      'Error from server (AlreadyExists): configmaps "dockflow-state" already exists',
      { times: 2, dryRun: false },
    );
    await expect(store.create('shop-production', releaseOf('1.4.2'))).rejects.toThrow();
  });
});

describe('same-version redeploy (13.4, K44)', () => {
  it('RS3: keeps a backup while replacing, and removes it on success', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2', { compose: 'v1\n' }));
    await store.create('shop-production', releaseOf('1.4.2', { compose: 'v2\n' }));
    expect(await store.currentVersion('shop-production')).toBe('1.4.2');
    expect(await store.readCompose('shop-production', '1.4.2')).toBe('v2\n');
    expect(await getSecret(kube, `${releaseSecretName('1.4.2')}${K8S_RELEASE_BACKUP_SUFFIX}`)).toBeUndefined();
    cluster.assertNoProblems();
  });

  it('RS3b: remove() with the in-process memo restores the previous content', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2', { compose: 'v1\n' }));
    await store.create('shop-production', releaseOf('1.4.2', { compose: 'v2\n' }));
    await store.remove('shop-production', '1.4.2', { restoreCurrentTo: '1.4.2' });
    expect(await store.readCompose('shop-production', '1.4.2')).toBe('v1\n');
    expect(await store.currentVersion('shop-production')).toBe('1.4.2');
  });

  it('RS3c/RS3e: a backup surviving without a live Secret is promoted back on the next touch, and warns', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2', { compose: 'v1\n' }));
    const live = await getSecret(kube, releaseSecretName('1.4.2'));
    expect(live).toBeDefined();
    // simulate a CLI killed between the delete of the live Secret and the create of the new one
    await kube.create(emitObject(asBackup(cleanForRecreate(live!))), { namespace: NS });
    await kube.delete([`secrets/${releaseSecretName('1.4.2')}`], { namespace: NS, wait: true, ignoreNotFound: true });
    expect(await getSecret(kube, releaseSecretName('1.4.2'))).toBeUndefined();

    const artifactRead = await store.readArtifact('shop-production', '1.4.2');
    expect(artifactRead.content).toContain('Namespace');
    expect(warnings.some((message) => message.includes('restored from an interrupted redeploy'))).toBe(true);
    expect(await getSecret(kube, releaseSecretName('1.4.2'))).toBeDefined();
    expect(await getSecret(kube, `${releaseSecretName('1.4.2')}${K8S_RELEASE_BACKUP_SUFFIX}`)).toBeUndefined();
    cluster.assertNoProblems();
  });

  it('RS3d: a backup next to a live Secret is dropped silently', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2'));
    const live = await getSecret(kube, releaseSecretName('1.4.2'));
    await kube.create(emitObject(asBackup(cleanForRecreate(live!))), { namespace: NS });

    await store.list('shop-production');
    expect(warnings.some((message) => message.includes('restored from an interrupted redeploy'))).toBe(false);
    expect(await getSecret(kube, `${releaseSecretName('1.4.2')}${K8S_RELEASE_BACKUP_SUFFIX}`)).toBeUndefined();
    cluster.assertNoProblems();
  });
});

describe('current / list / readArtifact / readCompose', () => {
  it('RS6: list is newest first, skips corrupted metadata with a warning, and never reads a payload', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.1', { metadata: metadata({ version: '1.4.1', epoch: 200 }) }));

    // seed a second, already-corrupted release Secret directly (Secrets are immutable in flight)
    const { yaml } = buildReleaseSecret(REF, releaseOf('1.4.0', { metadata: metadata({ version: '1.4.0', epoch: 100 }) }));
    const corrupted = parseYaml(yaml) as KubeObject;
    (corrupted.data as Record<string, string>)[RELEASE_KEYS.metadata] = Buffer.from('not json').toString('base64');
    cluster.seed(corrupted);

    const callsBeforeList = kube.calls.length;
    const list = await store.list('shop-production');
    expect(list.map((r) => r.version)).toEqual(['1.4.1']);
    expect(warnings.some((message) => message.includes('corrupted metadata'))).toBe(true);
    // no per-release payload read during list: only the namespace check, the backup selector and the go-template listing
    const duringList = kube.calls.slice(callsBeforeList);
    const payloadReads = duringList.filter((call) => call.call.args[0] === 'get' && call.call.args[1] === 'secrets' && call.call.args.includes(releaseSecretName('1.4.1')));
    expect(payloadReads).toHaveLength(0);
    cluster.assertNoProblems();
  });

  it('RS7: readArtifact of a missing release is ROLLBACK_FAILED', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2'));
    await expect(store.readArtifact('shop-production', '1.3.0')).rejects.toMatchObject({
      code: ErrorCode.ROLLBACK_FAILED,
      message: `Release 1.3.0 not found in namespace ${NS}`,
    });
  });

  it('readCompose / currentCompose round-trip the tagged compose', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2', { compose: 'services:\n  web:\n    image: web:1.4.2\n' }));
    expect(await store.readCompose('shop-production', '1.4.2')).toBe('services:\n  web:\n    image: web:1.4.2\n');
    expect(await store.currentCompose('shop-production')).toBe('services:\n  web:\n    image: web:1.4.2\n');
  });

  it('RS11: a missing namespace answers empty/null, never throws', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    expect(await store.list('shop-production')).toEqual([]);
    expect(await store.current('shop-production')).toBeNull();
    expect(await store.latestVersion('shop-production')).toBeNull();
    expect(await store.currentVersion('shop-production')).toBeNull();
  });

  it('RS12: a forbidden listing maps to OrchestratorUnavailableError', async () => {
    const { kube, cluster } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2'));
    cluster.rejectOn({ verb: 'get', kind: 'Secret' }, 'Forbidden', undefined, { dryRun: false });
    await expect(store.list('shop-production')).rejects.toBeInstanceOf(OrchestratorUnavailableError);
  });
});

describe('setCurrent / remove / prune', () => {
  it('RS9: remove(current) sets current to restoreCurrentTo before deleting', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.1'));
    await store.create('shop-production', releaseOf('1.4.2'));
    await store.remove('shop-production', '1.4.2', { restoreCurrentTo: '1.4.1' });
    expect(await store.currentVersion('shop-production')).toBe('1.4.1');
    expect(await getSecret(kube, releaseSecretName('1.4.2'))).toBeUndefined();
  });

  it('remove of a non-current release keeps current (C-REL-07)', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.1'));
    await store.create('shop-production', releaseOf('1.4.2'));
    await store.remove('shop-production', '1.4.1');
    expect(await store.currentVersion('shop-production')).toBe('1.4.2');
    expect(await getSecret(kube, releaseSecretName('1.4.1'))).toBeUndefined();
  });

  it('RS10: setCurrent(null) clears the current key without touching accessories-digest', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2'));
    await store.writeAccessoriesDigest('shop-production', 'abc123');
    await store.setCurrent('shop-production', null);
    expect(await store.currentVersion('shop-production')).toBeNull();
    expect((await store.readState('shop-production')).accessoriesDigest).toBe('abc123');
  });

  it('RS8 / C-REL-09: prune(keep) always keeps current, even when it falls outside the newest window', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    const epochs = [500, 400, 300, 200, 100]; // newest first
    for (let i = 0; i < epochs.length; i++) {
      await store.create('shop-production', releaseOf(`1.0.${i}`, { metadata: metadata({ version: `1.0.${i}`, epoch: epochs[i] }) }));
    }
    await store.setCurrent('shop-production', '1.0.4'); // the oldest
    const removed = await store.prune('shop-production', 3);
    expect(removed.map((r) => r.version)).toEqual(['1.0.3']); // the 2nd-oldest only
    const remaining = (await store.list('shop-production')).map((r) => r.version);
    expect(remaining.sort()).toEqual(['1.0.0', '1.0.1', '1.0.2', '1.0.4'].sort());
  });

  it('hookWorkingDir: a private path under /var/lib/dockflow, never /tmp', () => {
    const store = storeOf(new FakeKubeExecutor({ redactor, cluster: new FakeCluster() }));
    const dir = store.hookWorkingDir('shop-production');
    expect(dir).toBe('/var/lib/dockflow/hooks/shop-production');
    expect(dir.startsWith('/tmp')).toBe(false);
  });
});

describe('RoleStateStore (K69)', () => {
  it('C-REL-12: a digest written by one instance is read by another, isolated from the release-state key', async () => {
    const { kube } = harness();
    const writer = storeOf(kube);
    await writer.create('shop-production', releaseOf('1.4.2'));
    await writer.writeAccessoriesDigest('shop-production', 'digest-1');

    const reader = storeOf(kube);
    expect(await reader.readState('shop-production')).toEqual({ current: '1.4.2', accessoriesDigest: 'digest-1' });

    // the two field managers never clobber each other's key
    await writer.setCurrent('shop-production', null);
    expect(await reader.readState('shop-production')).toEqual({ current: null, accessoriesDigest: 'digest-1' });
  });

  it('writeAccessoriesDigest(null) clears the key', async () => {
    const { kube } = harness();
    const store = storeOf(kube);
    await store.create('shop-production', releaseOf('1.4.2'));
    await store.writeAccessoriesDigest('shop-production', 'digest-1');
    await store.writeAccessoriesDigest('shop-production', null);
    expect((await store.readState('shop-production')).accessoriesDigest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test-local helpers
// ---------------------------------------------------------------------------

async function getSecret(kube: FakeKubeExecutor, name: string): Promise<Secret | undefined> {
  const [secret] = await kube.getJson<Secret>(['secrets'], { namespace: NS, name, allowNotFound: true });
  return secret;
}

/** incompressible text (gzip would shrink a repeated character to nearly nothing) */
function randomText(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
